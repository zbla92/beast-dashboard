'use strict';
// Git worktrees per repo. Never fetches, pulls or pushes: local git only.
// `sessions` = snapshot.sessions (tmux sessions with cwd + claude).
const path = require('path');
const fs = require('fs');
const { run, inside, mapLimit } = require('./util');
const { parsePorcelain } = require('./roots');

const DIFF_CAP = 600 * 1024;
const SUMMARY_TTL = 60 * 1000;
const LIST_TTL = 10 * 1000;
const ACTIVE_MS = 30 * 60 * 1000;

const git = (cwd, args, timeout = 15000) => run('git', args, { cwd, timeout });
const msg = (r) => (r.stdout + '\n' + r.stderr).trim();

// ---- parsing ----
async function entries(repoPath) {
  const r = await git(repoPath, ['worktree', 'list', '--porcelain']);
  return r.ok ? parsePorcelain(r.stdout) : null;
}

async function refExists(repo, ref) { return (await git(repo, ['rev-parse', '--verify', '-q', ref + '^{commit}'], 5000)).ok; }
// base = origin/HEAD's target if set, else main, else master (else the main checkout's branch). `ref` is what we compare against.
async function findBase(repo, mainBranch) {
  const sym = await git(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], 5000);
  const cands = [];
  if (sym.ok && sym.stdout.trim()) cands.push(sym.stdout.trim().replace(/^origin\//, ''));
  cands.push('main', 'master');
  if (mainBranch) cands.push(mainBranch);
  for (const c of cands) {
    if (await refExists(repo, 'refs/heads/' + c)) return { base: c, ref: c };
    if (await refExists(repo, 'refs/remotes/origin/' + c)) return { base: c, ref: 'origin/' + c };
  }
  return { base: null, ref: null };
}

async function dirtyOf(dir) {
  const r = await git(dir, ['status', '--porcelain=v1', '--untracked-files=normal'], 12000);
  if (!r.ok) return { dirty: 0, untracked: 0 };
  let dirty = 0, untracked = 0;
  for (const l of r.stdout.split('\n')) { if (!l) continue; if (l.startsWith('??')) untracked++; else dirty++; }
  return { dirty, untracked };
}

function sessionsIn(wtPath, sessions) {
  const ss = (sessions || []).filter(s => s && s.cwd && inside(s.cwd, wtPath));
  return ss;
}

// A worktree whose index / HEAD / root dir changed in the last 30 min is probably being worked in (e.g. by an Agent-tool agent
// running inside a parent Claude process whose cwd is the main repo, so no session cwd matches).
function gitDirOf(wtPath) {
  try {
    const g = path.join(wtPath, '.git');
    const st = fs.statSync(g);
    if (st.isDirectory()) return g;
    const m = fs.readFileSync(g, 'utf8').match(/^gitdir:\s*(.+)$/m);
    return m ? path.resolve(wtPath, m[1].trim()) : null;
  } catch { return null; }
}
function newestChange(wtPath) {
  let best = 0;
  const gd = gitDirOf(wtPath);
  for (const f of [wtPath, gd && path.join(gd, 'index'), gd && path.join(gd, 'HEAD')]) {
    if (!f) continue;
    try { best = Math.max(best, fs.statSync(f).mtimeMs); } catch {}
  }
  return best;
}
const isActive = (wtPath) => { const t = newestChange(wtPath); return t > 0 && Date.now() - t < ACTIVE_MS; };
// a Claude session inside the repo that is working / has background agents may own any worktree under .claude/worktrees/
function agentBusy(repo, wtPath, sessions) {
  if (!inside(wtPath, path.join(repo, '.claude', 'worktrees'))) return false;
  return (sessions || []).some(s => s && s.cwd && s.claude && inside(s.cwd, repo) && ['working', 'background'].includes(s.claude.state));
}

// ---- list ----
async function describe(repo, e, baseRef, sessions) {
  const ss = sessionsIn(e.path, sessions);
  const w = { path: e.path, name: path.basename(e.path), branch: e.branch, head: e.head.slice(0, 8), detached: e.detached, locked: e.locked, prunable: e.prunable,
    dirty: 0, untracked: 0, ahead: 0, behind: 0, merged: false, last: null, diffstat: { files: 0, ins: 0, del: 0 },
    sessions: ss.map(s => s.name).sort(), claude: ss.some(s => s.claude),
    active: false, agentBusy: agentBusy(repo, e.path, sessions) };
  if (!e.prunable) w.active = isActive(e.path);
  const tip = e.branch ? 'refs/heads/' + e.branch : e.head;
  if (!e.prunable) Object.assign(w, await dirtyOf(e.path));
  const lg = await git(repo, ['log', '-1', '--format=%ct%x1f%s', tip], 5000);
  if (lg.ok && lg.stdout.trim()) { const [ts, subject] = lg.stdout.trim().split('\x1f'); w.last = { subject: subject || '', ts: +ts * 1000 }; }
  if (baseRef && tip) {
    const lr = await git(repo, ['rev-list', '--left-right', '--count', `${baseRef}...${tip}`], 8000);
    if (lr.ok) { const [b, a] = lr.stdout.trim().split(/\s+/).map(Number); w.behind = b || 0; w.ahead = a || 0; }
    w.merged = (await git(repo, ['merge-base', '--is-ancestor', tip, baseRef], 8000)).ok;
    const ns = await git(repo, ['diff', '--numstat', `${baseRef}...${tip}`], 12000);
    if (ns.ok) for (const l of ns.stdout.split('\n')) { const m = l.match(/^(\d+|-)\t(\d+|-)\t/); if (m) { w.diffstat.files++; w.diffstat.ins += +m[1] || 0; w.diffstat.del += +m[2] || 0; } }
  }
  return w;
}

const listCache = new Map();   // repoPath -> { at, val }
async function list(repoPath, sessions) {
  const c = listCache.get(repoPath);
  if (c && Date.now() - c.at < LIST_TTL) return c.val;
  const val = await listFresh(repoPath, sessions);
  listCache.set(repoPath, { at: Date.now(), val });
  if (listCache.size > 50) listCache.delete(listCache.keys().next().value);
  return val;
}
async function listFresh(repoPath, sessions) {
  const es = await entries(repoPath);
  if (!es || !es.length) return { base: null, main: null, worktrees: [] };
  const mainE = es[0];
  const { base, ref } = await findBase(repoPath, mainE.branch);
  const mainDirty = await dirtyOf(mainE.path);
  const main = { path: mainE.path, branch: mainE.branch, dirty: mainDirty.dirty + mainDirty.untracked };
  const extra = es.slice(1).filter(e => !e.bare).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const worktrees = await mapLimit(extra, 4, e => describe(repoPath, e, ref, sessions));
  return { base, main, worktrees };
}

// ---- summary (cheap, cached 60 s) ----
let sumCache = { at: 0, val: null, busy: null };
async function summaryOne(p, sessions) {
  const es = await entries(p.path);
  if (!es || es.length < 2) return null;
  const extra = es.slice(1).filter(e => !e.bare);
  if (!extra.length) return null;
  const { ref } = await findBase(p.path, es[0].branch);
  let dirty = 0, stale = 0;
  for (const e of extra) {
    const hasSession = sessionsIn(e.path, sessions).length > 0;
    let d = { dirty: 0, untracked: 0 };
    if (!e.prunable) d = await dirtyOf(e.path);
    const isDirty = d.dirty + d.untracked > 0;
    if (isDirty) dirty++;
    const live = !e.prunable && (isActive(e.path) || agentBusy(p.path, e.path, sessions));
    let merged = false;
    if (ref && !e.prunable) merged = (await git(p.path, ['merge-base', '--is-ancestor', e.branch ? 'refs/heads/' + e.branch : e.head, ref], 8000)).ok;
    if (e.prunable || (!hasSession && !isDirty && !live && merged)) stale++;
  }
  return { count: extra.length, dirty, stale };
}
async function summary(projects, sessions) {
  if (sumCache.val && Date.now() - sumCache.at < SUMMARY_TTL) return sumCache.val;
  if (sumCache.busy) return sumCache.busy;
  sumCache.busy = (async () => {
    const out = {};
    const repos = (projects || []).filter(p => p && p.isGit && p.path);
    await mapLimit(repos, 4, async p => { try { const s = await summaryOne(p, sessions); if (s) out[p.id] = s; } catch {} });
    sumCache = { at: Date.now(), val: out, busy: null };
    return out;
  })();
  try { return await sumCache.busy; } finally { sumCache.busy = null; }
}
const bust = () => { sumCache.at = 0; sumCache.val = null; listCache.clear(); };

// ---- actions ----
// The path must be exactly an entry of `git worktree list --porcelain` for this repo.
async function resolve(repoPath, wtPath) {
  const es = await entries(repoPath);
  if (!es) return { error: 'not a git repository' };
  const e = es.find(x => x.path === wtPath);
  if (!wtPath || !e) return { error: 'unknown worktree path' };
  return { e, es, main: es[0], isMain: e === es[0] };
}

async function diff(repoPath, wtPath) {
  const r = await resolve(repoPath, wtPath); if (r.error) return r;
  const { base, ref } = await findBase(repoPath, r.main.branch);
  const parts = []; let failed = false;
  if (ref && (r.e.branch || r.e.head) && !r.isMain) {
    const d = await git(repoPath, ['diff', `${ref}...${r.e.branch ? 'refs/heads/' + r.e.branch : r.e.head}`], 30000);
    if (d.ok && d.stdout) parts.push(d.stdout); else if (!d.ok) failed = true;
  }
  if (!r.e.prunable) {
    const d = await git(wtPath, ['diff', 'HEAD'], 30000);
    if (!d.ok) failed = true;
    if (d.ok && d.stdout) parts.push((parts.length ? '\n# --- uncommitted changes in the worktree ---\n' : '') + d.stdout);
  }
  let text = parts.join('\n'); const truncated = failed || text.length > DIFF_CAP;
  if (truncated) text = text.slice(0, DIFF_CAP);
  return { text, truncated, base, ...(failed ? { error: 'git diff failed or exceeded the output limit: the diff is incomplete' } : {}) };
}

async function merge(repoPath, wtPath) {
  const r = await resolve(repoPath, wtPath); if (r.error) return r;
  if (r.isMain) return { error: 'that is the main checkout' };
  if (r.e.detached || !r.e.branch) return { error: 'the worktree is on a detached HEAD: nothing to merge by branch' };
  if (r.e.prunable) return { error: 'the worktree folder is missing: prune it instead' };
  const { base } = await findBase(repoPath, r.main.branch);
  if (!base) return { error: 'no base branch found (main / master)' };
  if (r.main.branch !== base) return { error: `the main checkout is on "${r.main.branch || 'a detached HEAD'}", not on ${base}: switch it first` };
  if (r.e.branch === base) return { error: 'the worktree is on the base branch itself' };
  const md = await git(repoPath, ['status', '--porcelain', '--untracked-files=no']);
  if (md.stdout.trim()) return { error: 'the main checkout has uncommitted changes: commit or stash them first' };
  const wd = await dirtyOf(wtPath);
  if (wd.dirty) return { error: `the worktree has ${wd.dirty} uncommitted change${wd.dirty > 1 ? 's' : ''}: commit them first or they would not be merged` };
  const m = await git(repoPath, ['merge', '--no-edit', '-m', `Merge branch '${r.e.branch}'`, 'refs/heads/' + r.e.branch], 60000);
  if (m.ok) { bust(); return { ok: true, out: msg(m) }; }
  const un = await git(repoPath, ['diff', '--name-only', '--diff-filter=U']);
  const conflicts = un.stdout.split('\n').filter(Boolean);
  const inMerge = (await git(repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], 5000)).ok;
  if (inMerge) await git(repoPath, ['merge', '--abort'], 20000);
  bust();
  if (conflicts.length) return { error: `merge conflicts in ${conflicts.length} file${conflicts.length > 1 ? 's' : ''}; the merge was aborted, nothing changed`, conflicts };
  return { error: (m.stderr || m.stdout || 'merge failed').trim().split('\n').slice(0, 4).join('\n') };
}

async function remove(repoPath, wtPath, opts = {}, sessions) {
  const r = await resolve(repoPath, wtPath); if (r.error) return r;
  if (r.isMain) return { error: 'refusing to remove the main checkout' };
  const ss = sessionsIn(wtPath, sessions);
  if (ss.length) return { error: `a session is running in this worktree: ${ss.map(s => s.name).join(', ')}. Stop it first` };
  if (r.e.locked) return { error: 'the worktree is locked (git worktree unlock first)' };
  if (!opts.force && !r.e.prunable && isActive(wtPath)) return { error: `files in this worktree changed in the last ${ACTIVE_MS / 60000} minutes: maybe an agent is working in it. Tick "force" to remove it anyway` };
  if (!opts.force && agentBusy(repoPath, wtPath, sessions)) return { error: 'a Claude session in this repo is working / has background agents and this worktree may belong to it. Tick "force" to remove it anyway' };
  const d = r.e.prunable ? { dirty: 0, untracked: 0 } : await dirtyOf(wtPath);
  if ((d.dirty + d.untracked) && !opts.force) return { error: `the worktree has uncommitted changes (${d.dirty} modified, ${d.untracked} untracked): tick "force" to discard them` };
  const args = ['worktree', 'remove']; if (opts.force) args.push('--force'); args.push(wtPath);
  const x = await git(repoPath, args, 60000);
  if (!x.ok) return { error: (x.stderr || x.stdout || 'git worktree remove failed').trim().split('\n').slice(0, 4).join('\n') };
  let out = msg(x);
  if (opts.deleteBranch && r.e.branch && r.e.branch !== r.main.branch) {
    const b = await git(repoPath, ['branch', opts.force ? '-D' : '-d', r.e.branch], 15000);
    out = (out + '\n' + (b.ok ? msg(b) : `branch ${r.e.branch} kept: ${(b.stderr || b.stdout).trim().split('\n')[0]}`)).trim();
  }
  bust();
  return { ok: true, out };
}

async function prune(repoPath) {
  const x = await git(repoPath, ['worktree', 'prune', '-v'], 30000);
  bust();
  return x.ok ? { ok: true, out: msg(x) || 'nothing to prune' } : { error: (x.stderr || 'git worktree prune failed').trim() };
}

const WT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const validName = n => typeof n === 'string' && WT_NAME.test(n) && !n.includes('..') && !n.endsWith('.') && !n.endsWith('.lock');
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

async function create(repoPath, raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!validName(name)) return { error: 'bad worktree name: letters, digits, . _ - only, up to 40 characters' };
  const branch = 'worktree-' + name;
  const es = await entries(repoPath);
  if (!es || !es.length) return { error: 'not a git repository' };
  const dir = path.join(real(repoPath), '.claude', 'worktrees', name);
  const have = es.find(e => real(e.path) === dir);
  if (have) return { ok: true, path: have.path, branch: have.branch, existed: true };
  if (fs.existsSync(dir)) return { error: `${dir} exists but is not a git worktree` };
  const args = ['worktree', 'add'];
  if (await refExists(repoPath, 'refs/heads/' + branch)) args.push(dir, branch);
  else {
    args.push('-b', branch, dir);
    const sym = await git(repoPath, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], 5000);
    if (sym.ok && sym.stdout.trim() && await refExists(repoPath, sym.stdout.trim())) args.push(sym.stdout.trim());
  }
  const r = await git(repoPath, args, 60000);
  bust();
  if (!r.ok) return { error: (r.stderr || r.stdout || 'git worktree add failed').trim().split('\n').slice(0, 4).join('\n') };
  return { ok: true, path: dir, branch, existed: false };
}

module.exports = { summary, list, diff, merge, remove, prune, create, validName };
