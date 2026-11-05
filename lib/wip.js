'use strict';
const fs = require('fs');
const path = require('path');
const { run, mapLimit } = require('./util');
const rootsMod = require('./roots');
const editsMod = require('./edits');

const STALE_MS = 3 * 864e5;
const BIG_LINES = 1500;
const MAX_FILES = 500;
const MAX_STAT = 300;
const MAX_EDITORS = 4;
const BUMP_MS = 2000;
const SECRET_RE = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore|jks)|[^/]*(secret|credential)s?[^/]*)$/i;
const OPS = [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']];

let cfg = { projects: () => [], sessions: () => [], onChange: () => {}, roots: rootsMod, edits: editsMod, now: () => Date.now() };
let cache = new Map();
let list = [];
let liveMap = new Map();
let sweptAt = 0;
let busy = null;
let out = null;
const bumps = new Map();
const memo = new Map();

function init(opts = {}) {
  cfg = { ...cfg, ...opts };
  cache = new Map(); list = []; liveMap = new Map(); sweptAt = 0; busy = null; out = null;
  memo.clear();
  for (const t of bumps.values()) clearTimeout(t);
  bumps.clear();
}

function mainRoot(p) { return { id: p.id, project: p.id, name: p.name, path: p.path, worktree: false, repoPath: p.path, branch: null, detached: false, org: p.org || null, set: p.set || p.id }; }

async function allRoots() {
  const res = [];
  for (const p of cfg.projects()) {
    if (!p.isGit) continue;
    res.push(mainRoot(p));
    for (const w of await cfg.roots.worktreesOf(p)) res.push(cfg.roots.wtRoot(p, w));
  }
  return res;
}

function gitDirs(dir) {
  let git = path.join(dir, '.git');
  try {
    if (!fs.statSync(git).isDirectory()) {
      const m = fs.readFileSync(git, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      git = path.resolve(dir, m[1].trim());
    }
  } catch { return null; }
  let common = git;
  try { common = path.resolve(git, fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim()); } catch {}
  return { git, common };
}

function opOf(dirs) {
  if (!dirs) return null;
  for (const [f, op] of OPS) if (fs.existsSync(path.join(dirs.git, f))) return op;
  return null;
}

function stashCount(dirs) {
  if (!dirs) return 0;
  try { return fs.readFileSync(path.join(dirs.common, 'logs', 'refs', 'stash'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

function hasRemote(dirs) {
  if (!dirs) return false;
  try { return /^\[remote "/m.test(fs.readFileSync(path.join(dirs.common, 'config'), 'utf8')); } catch { return false; }
}

function parseStatus(stdout) {
  const st = { oid: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [], staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  const items = stdout.split('\0');
  for (let i = 0; i < items.length; i++) {
    const line = items[i]; if (!line) continue;
    if (line.startsWith('# branch.oid ')) st.oid = line.slice(13);
    else if (line.startsWith('# branch.head ')) st.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) { const m = line.match(/\+(\d+) -(\d+)/); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const ren = line[0] === '2'; const parts = line.split(' '); const x = parts[1][0]; const y = parts[1][1];
      const rel = parts.slice(ren ? 9 : 8).join(' '); const from = ren ? items[++i] : null;
      if (x !== '.') st.staged++;
      if (y !== '.') st.unstaged++;
      st.files.push({ rel, x, y, status: x !== '.' ? x : y, from });
    } else if (line.startsWith('u ')) {
      const parts = line.split(' '); st.conflicts++;
      st.files.push({ rel: parts.slice(10).join(' '), x: parts[1][0], y: parts[1][1], status: 'U', from: null });
    } else if (line.startsWith('? ')) { st.untracked++; st.files.push({ rel: line.slice(2), x: '?', y: '?', status: '?', from: null }); }
  }
  return st;
}

function parseNumstat(stdout) {
  const m = new Map(); const t = stdout.split('\0');
  for (let i = 0; i < t.length; i++) {
    if (!t[i]) continue;
    const [a, d, p] = t[i].split('\t');
    let rel = p;
    if (p === '') { i++; rel = t[++i]; }
    if (rel == null) continue;
    m.set(rel, a === '-' ? { add: null, del: null, binary: true } : { add: +a, del: +d, binary: false });
  }
  return m;
}

async function readRoot(root, opts = {}) {
  const now = cfg.now();
  const st0 = await run('git', ['-C', root.path, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], { timeout: 12000 });
  if (!st0.ok) return { ...root, error: (st0.stderr || 'git status failed').trim().split('\n')[0], at: now };
  const st = parseStatus(st0.stdout);
  const dirs = gitDirs(root.path);
  const detached = st.branch === '(detached)';
  const branch = detached ? 'HEAD@' + String(st.oid || '').slice(0, 7) : st.branch;
  const prev = memo.get(root.id) || {};
  const mt = st.files.slice(0, MAX_STAT).map(f => { try { return fs.statSync(path.join(root.path, f.rel)).mtimeMs; } catch { return null; } });
  const key = st0.stdout + '\0' + mt.join(',');
  if (prev.key === key && prev.nums) { for (const f of st.files) { const n = prev.nums.get(f.rel); if (n) Object.assign(f, n); } }
  else if (st.staged + st.unstaged + st.conflicts > 0) {
    const args = st.oid && st.oid !== '(initial)' ? ['diff', '--numstat', '-z', 'HEAD'] : ['diff', '--numstat', '-z', '--cached'];
    const ns = await run('git', ['-C', root.path, ...args], { timeout: 8000 });
    if (ns.ok) { const m = parseNumstat(ns.stdout); prev.nums = m; prev.key = key; for (const f of st.files) { const n = m.get(f.rel); if (n) Object.assign(f, n); } }
    else prev.key = null;
  } else { prev.nums = new Map(); prev.key = key; }
  let add = 0, del = 0, oldest = 0, newest = 0;
  st.files.forEach((f, i) => {
    add += f.add || 0; del += f.del || 0;
    if (i >= MAX_STAT) return;
    f.mtime = mt[i];
    if (f.mtime) { if (!oldest || f.mtime < oldest) oldest = f.mtime; if (f.mtime > newest) newest = f.mtime; }
  });
  const pending = st.files.length;
  const remote = hasRemote(dirs);
  const flags = [];
  if (st.files.some(f => SECRET_RE.test(f.rel))) flags.push('env');
  if (add + del > BIG_LINES) flags.push('big');
  if (pending && oldest && now - oldest > STALE_MS) flags.push('stale');
  if (st.behind > 0) flags.push('behind');
  if (detached) flags.push('detached');
  if (st.conflicts > 0) flags.push('conflict');
  if (!st.upstream && !detached && remote) flags.push('no-upstream');
  let last = null;
  if (opts.last && st.oid && st.oid !== '(initial)' && prev.lastOid === st.oid) last = prev.last;
  else if (opts.last && st.oid && st.oid !== '(initial)') {
    const log = await run('git', ['-C', root.path, 'log', '-1', '--format=%h%x1f%s%x1f%cr%x1f%an%x1f%ct'], { timeout: 5000 });
    if (log.ok && log.stdout.trim()) { const [hash, subject, rel, author, ts] = log.stdout.trim().split('\x1f'); last = { hash, subject, rel, author, ts: +ts * 1000 }; prev.lastOid = st.oid; prev.last = last; }
  }
  if (last && last.ts) last = { ...last, rel: relTime(now - last.ts) };
  memo.set(root.id, prev);
  return {
    ...root, branch, detached, upstream: st.upstream, ahead: st.ahead, behind: st.behind,
    staged: st.staged, unstaged: st.unstaged, untracked: st.untracked, conflicts: st.conflicts, add, del,
    stashes: stashCount(dirs), op: opOf(dirs), oldest: oldest || null, newest: newest || null, flags,
    remote, last, files: st.files, at: now,
  };
}

function relTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  for (const [n, u] of units) if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v === 1 ? '' : 's'} ago`; }
  return '0 seconds ago';
}

function editorsOf(r) {
  if (!r.files || !r.files.length) return [];
  const by = new Map();
  for (const f of r.files.slice(0, MAX_FILES)) {
    for (const e of cfg.edits.byPath(path.join(r.path, f.rel))) {
      const o = by.get(e.sessionId);
      if (o) { o.files++; if (e.at > o.at) o.at = e.at; }
      else by.set(e.sessionId, { sessionId: e.sessionId, label: e.label || null, live: e.live || null, files: 1, at: e.at });
    }
  }
  return [...by.values()].sort((a, b) => b.at - a.at).slice(0, MAX_EDITORS);
}

function rootOfDir(dir) { return dir ? cfg.roots.locate(path.join(dir, '_')) : null; }

async function computeLive() {
  const m = new Map();
  const add = (id, tmux) => { if (!id || !tmux) return; let s = m.get(id); if (!s) m.set(id, s = new Set()); s.add(tmux); };
  for (const s of cfg.sessions()) {
    if (!s || s.gone || s.state === 'ended' || !s.tmux) continue;
    const c = rootOfDir(s.cwd); if (c) add(c.rootId, s.tmux);
    if (!s.transcriptPath) continue;
    for (const e of await cfg.edits.scan(s.transcriptPath).catch(() => [])) { const l = cfg.roots.locate(e.path); if (l) add(l.rootId, s.tmux); }
  }
  liveMap = new Map([...m].map(([k, v]) => [k, [...v].sort()]));
}

const isPending = r => !r.error && (r.staged + r.unstaged + r.untracked + r.conflicts > 0 || r.ahead > 0 || !!r.op);

function groupsOf(rs) {
  const by = new Map();
  for (const r of rs) {
    if (!r.worktree || !r.branch || r.detached) continue;
    let g = by.get(r.branch); if (!g) by.set(r.branch, g = []);
    g.push(r);
  }
  return [...by].filter(([, g]) => new Set(g.map(r => r.project)).size >= 2).map(([branch, g]) => ({ branch, roots: g.map(r => r.id).sort() })).sort((a, b) => a.branch.localeCompare(b.branch));
}

const ORDER = (a, b) => String(a.org || '').localeCompare(String(b.org || '')) || String(a.set).localeCompare(String(b.set)) || String(a.name).localeCompare(String(b.name)) || (a.worktree - b.worktree) || String(a.branch || '').localeCompare(String(b.branch || '')) || a.id.localeCompare(b.id);

function publicRoot(r) {
  const { files, remote, last, error, ...rest } = r;
  return { ...rest, live: liveMap.get(r.id) || [], editors: editorsOf(r) };
}

function build() {
  const all = list.map(r => cache.get(r.id)).filter(Boolean);
  const groups = groupsOf(all);
  const inGroup = new Set();
  const active = new Set(all.filter(r => isPending(r) || liveMap.has(r.id)).map(r => r.id));
  for (const g of groups) if (g.roots.some(id => active.has(id))) for (const id of g.roots) inGroup.add(id);
  const shown = all.filter(r => !r.error && (active.has(r.id) || inGroup.has(r.id))).sort(ORDER);
  const ids = new Set(shown.map(r => r.id));
  out = { at: sweptAt, roots: shown.map(publicRoot), groups: groups.filter(g => g.roots.some(id => ids.has(id))) };
  return out;
}

async function sweep() {
  if (busy) return busy;
  busy = (async () => {
    const rs = await allRoots();
    const res = await mapLimit(rs, 6, r => readRoot(r, { last: !r.worktree }).catch(e => ({ ...r, error: String(e.message || e), at: cfg.now() })));
    const fresh = new Map(res.map(r => { const c = cache.get(r.id); return [r.id, c && c.at > r.at ? c : r]; }));
    list = rs; cache = fresh;
    await computeLive().catch(() => {});
    sweptAt = cfg.now();
    build();
  })().finally(() => { busy = null; });
  return busy;
}

async function refreshOne(id) {
  const root = await cfg.roots.rootOf(id);
  if (!root || !root.isGit) return null;
  const base = root.worktree ? root : mainRoot(root);
  const r = await readRoot(base, { last: !base.worktree }).catch(e => ({ ...base, error: String(e.message || e), at: cfg.now() }));
  cache.set(id, r);
  if (!list.some(x => x.id === id)) list = [...list, base];
  await computeLive().catch(() => {});
  build();
  return r;
}

function bump(id, ms = BUMP_MS) {
  if (!id) return;
  clearTimeout(bumps.get(id));
  bumps.set(id, setTimeout(() => { bumps.delete(id); refreshOne(id).then(() => cfg.onChange()).catch(() => {}); }, ms));
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
function onHook(body) {
  if (!body || body.hook_event_name !== 'PostToolUse') return;
  const t = body.tool_name; const inp = body.tool_input || {};
  if (EDIT_TOOLS.has(t)) { const l = cfg.roots.locate(String(inp.file_path || inp.notebook_path || '')); if (l) bump(l.rootId); }
  else if (t === 'Bash') { const l = rootOfDir(body.cwd); if (l) bump(l.rootId); }
}

function worktreeGitDir(repo, name) {
  const meta = path.join(repo, '.git', 'worktrees', name);
  try { return path.dirname(path.resolve(meta, fs.readFileSync(path.join(meta, 'gitdir'), 'utf8').trim())); } catch { return null; }
}

function state() { return out || { at: 0, roots: [], groups: [] }; }

function gitStatusOf(id) {
  const r = cache.get(id); if (!r) return null;
  if (r.error) return { error: r.error };
  return { branch: r.branch, upstream: r.upstream, ahead: r.ahead, behind: r.behind, dirty: r.files ? r.files.filter(f => f.status !== '?').length : r.staged + r.unstaged + r.conflicts, untracked: r.untracked, staged: r.staged, detached: r.detached, last: r.last, stashes: r.stashes };
}

function gitStatus() {
  const m = {};
  for (const r of list) if (!r.worktree) { const g = gitStatusOf(r.id); if (g) m[r.id] = g; }
  return m;
}

async function detail(id) {
  const root = await cfg.roots.rootOf(id);
  if (!root || !root.isGit) return null;
  const base = root.worktree ? root : mainRoot(root);
  const r = await readRoot(base, { last: true });
  if (r.error) return { root: publicRoot(r), error: r.error };
  cache.set(id, r);
  const files = r.files.slice(0, MAX_FILES).map(f => ({ ...f, editors: cfg.edits.byPath(path.join(r.path, f.rel)).map(e => ({ sessionId: e.sessionId, label: e.label, live: e.live, at: e.at, by: e.by })) }));
  const [log, unp, stl] = await Promise.all([
    run('git', ['-C', r.path, 'log', '-50', '--format=%h%x1f%an%x1f%ae%x1f%cr%x1f%s%x1f%ct'], { timeout: 5000 }),
    !r.upstream && r.remote ? run('git', ['-C', r.path, 'log', 'HEAD', '--not', '--remotes', '-50', '--format=%h'], { timeout: 5000 }) : Promise.resolve(null),
    run('git', ['-C', r.path, 'stash', 'list', '--format=%gd%x1f%s%x1f%ct'], { timeout: 5000 }),
  ]);
  const local = unp && unp.ok ? new Set(unp.stdout.split('\n').filter(Boolean)) : null;
  const all = log.ok ? log.stdout.split('\n').filter(Boolean).map((l, i) => {
    const [hash, author, email, rel, subject, ct] = l.split('\x1f');
    return { hash, author, email, rel, subject, at: +ct * 1000, unpushed: r.upstream ? i < r.ahead : local ? local.has(hash) : false };
  }) : [];
  const since = cfg.now() - 864e5;
  const commits = { unpushed: all.filter(c => c.unpushed), recent: all.filter(c => !c.unpushed && c.at >= since).slice(0, 30) };
  const stashes = stl.ok ? stl.stdout.split('\n').filter(Boolean).map(l => { const [ref, msg, ct] = l.split('\x1f'); return { ref, msg, at: +ct * 1000 }; }) : [];
  const p = cfg.projects().find(x => x.id === r.project);
  const wts = p ? [mainRoot(p), ...(await cfg.roots.worktreesOf(p)).map(w => cfg.roots.wtRoot(p, w))] : [];
  const worktrees = wts.map(w => { const c = cache.get(w.id); return { id: w.id, branch: c ? c.branch : w.branch, path: w.path, worktree: w.worktree, dirty: c && !c.error ? c.staged + c.unstaged + c.untracked + c.conflicts : null, live: liveMap.get(w.id) || [] }; });
  build();
  return { root: publicRoot(r), files, truncated: r.files.length > MAX_FILES, commits, stashes, worktrees };
}

function containerOf(dir) {
  if (!dir) return null;
  let best = null;
  for (const p of cfg.projects()) if ((dir === p.path || dir.startsWith(p.path + path.sep)) && (!best || p.path.length > best.path.length)) best = p;
  return best;
}

function setOfRoot(id) {
  const c = cache.get(id); if (c) return c.set;
  const p = cfg.projects().find(x => x.id === String(id).split('~')[0]);
  return p ? p.set || p.id : null;
}

function rootsOfSet(setId) {
  const ids = new Set();
  for (const p of cfg.projects()) if (p.isGit && (p.set || p.id) === setId) ids.add(p.id);
  for (const r of list) if (r.set === setId) ids.add(r.id);
  return [...ids];
}

async function workspace({ session = null, sessionId = null, live = null, cwd = null, transcripts = [], guess = [] }) {
  const edited = {}; const outside = new Map(); const roots = new Set();
  const c = rootOfDir(cwd); if (c) roots.add(c.rootId);
  for (const t of transcripts) {
    for (const e of await cfg.edits.scan(t).catch(() => [])) {
      const l = cfg.roots.locate(e.path);
      if (!l) { const o = outside.get(e.path); if (o) o.count += e.count; else outside.set(e.path, { path: e.path, tool: e.tool, count: e.count }); continue; }
      roots.add(l.rootId);
      const arr = edited[l.rootId] || (edited[l.rootId] = []);
      const o = arr.find(x => x.rel === l.rel);
      const at = e.at || 0;
      if (o) { o.count += e.count; if (o.by !== e.by) o.by = 'both'; if (at > o.at || at === o.at && e.seq > o.seq) { o.at = at; o.seq = e.seq; o.tool = e.tool; } }
      else arr.push({ rel: l.rel, tool: e.tool, count: e.count, by: e.by, seq: e.seq, at });
    }
  }
  const dirs = new Map();
  for (const t of transcripts) {
    for (const { dir, count } of await cfg.edits.cwdsOf(t).catch(() => [])) {
      const l = rootOfDir(dir);
      if (l) { roots.add(l.rootId); dirs.set(l.rootId, (dirs.get(l.rootId) || 0) + count); }
    }
  }
  const worked = [...dirs].sort((x, y) => y[1] - x[1]).map(x => x[0]);
  const order = Object.values(edited).flat().sort((x, y) => x.at - y.at || x.seq - y.seq);
  order.forEach((x, i) => { x.seq = i + 1; delete x.at; });
  const sets = new Set([...roots].map(setOfRoot).filter(Boolean));
  const box = containerOf(cwd); if (box) sets.add(box.set || box.id);
  if (!sets.size) for (const id of guess) { const p = cfg.projects().find(x => x.id === id); if (p) { sets.add(p.set || p.id); break; } }
  return { session, sessionId, live, sets: [...sets].sort(), roots: [...roots].sort(), worked, edited, outside: [...outside.values()].slice(0, 100) };
}

async function brief({ set = null, root = null }) {
  const ids = root ? [root] : set ? rootsOfSet(set) : [];
  const lines = [];
  const head = set ? `Work in progress — ${set}` : `Work in progress — ${root}`;
  lines.push(head);
  let clean = 0;
  for (const id of ids) {
    const r = cache.get(id);
    if (!r) continue;
    if (r.error) { lines.push(`\n## ${r.name}${r.worktree ? ' (worktree)' : ''}: ${r.error}`); continue; }
    if (!isPending(r) && !r.stashes) { clean++; continue; }
    const bits = [`branch ${r.branch || '?'}`];
    if (r.upstream) bits.push(`↑${r.ahead} ↓${r.behind} vs ${r.upstream}`); else if (!r.detached) bits.push('no upstream');
    if (r.op) bits.push(`${r.op} in progress`);
    lines.push(`\n## ${r.name}${r.worktree ? ' (worktree)' : ''} — ${r.path}`);
    lines.push(bits.join(' · '));
    if (r.files.length) {
      lines.push(`pending: ${r.staged} staged, ${r.unstaged} unstaged, ${r.untracked} untracked${r.conflicts ? `, ${r.conflicts} conflicts` : ''} (+${r.add} −${r.del})`);
      for (const f of r.files.slice(0, 25)) lines.push(`  ${(f.x === '?' ? '??' : f.x + f.y).replace(/\./g, ' ')} ${f.rel}`);
      if (r.files.length > 25) lines.push(`  … ${r.files.length - 25} more`);
    }
    if (r.ahead > 0 && r.upstream) {
      const lg = await run('git', ['-C', r.path, 'log', '@{u}..HEAD', '-10', '--format=%h %s'], { timeout: 5000 });
      if (lg.ok && lg.stdout.trim()) lines.push('unpushed:', ...lg.stdout.trim().split('\n').map(l => '  ' + l));
    }
    if (r.stashes) lines.push(`stashes: ${r.stashes}`);
    const wts = r.worktree ? [] : list.filter(w => w.worktree && w.project === r.project);
    if (wts.length) lines.push(`worktrees: ${wts.map(w => `${w.branch || '?'} (${w.path})`).join(', ')}`);
  }
  if (clean) lines.push(`\n${clean} other repo${clean === 1 ? '' : 's'} clean`);
  let text = lines.join('\n');
  if (Buffer.byteLength(text) > 3072) { text = Buffer.from(text).subarray(0, 3000).toString('utf8').replace(/�*$/, '') + '\n… (truncated)'; }
  return text;
}

function rootFor(absPath) { const l = cfg.roots.locate(absPath); return l ? l.rootId : null; }

module.exports = { init, sweep, refreshOne, bump, onHook, state, gitStatus, gitStatusOf, detail, workspace, brief, rootsOfSet, rootFor, worktreeGitDir, parseStatus, parseNumstat, readRoot, SECRET_RE };
