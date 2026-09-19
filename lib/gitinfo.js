'use strict';
const path = require('path');
const { run, mapLimit } = require('./util');

async function status(dir) {
  const r = await run('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'], { timeout: 12000 });
  if (!r.ok) return { error: (r.stderr || 'git status failed').trim().split('\n')[0] };
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0, untracked: 0, staged: 0, detached: false };
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) { out.branch = line.slice(14); if (out.branch === '(detached)') out.detached = true; }
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) { const m = line.match(/\+(\d+) -(\d+)/); if (m) { out.ahead = +m[1]; out.behind = +m[2]; } }
    else if (line.startsWith('1 ') || line.startsWith('2 ')) { out.dirty++; if (line[2] !== '.') out.staged++; }
    else if (line.startsWith('u ')) out.dirty++;
    else if (line.startsWith('? ')) out.untracked++;
  }
  if (out.detached) { const h = await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']); out.branch = 'HEAD@' + h.stdout.trim(); }
  const log = await run('git', ['-C', dir, 'log', '-1', '--format=%h%x1f%s%x1f%cr%x1f%an%x1f%ct'], { timeout: 5000 });
  if (log.ok && log.stdout.trim()) { const [hash, subject, rel, author, ts] = log.stdout.trim().split('\x1f'); out.last = { hash, subject, rel, author, ts: +ts * 1000 }; }
  const stash = await run('git', ['-C', dir, 'stash', 'list'], { timeout: 5000 });
  out.stashes = stash.ok ? stash.stdout.split('\n').filter(Boolean).length : 0;
  return out;
}

async function branches(dir) {
  const r = await run('git', ['-C', dir, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)|~|%(committerdate:relative)|~|%(committerdate:unix)|~|%(subject)|~|%(upstream:short)', 'refs/heads', 'refs/remotes'], { timeout: 8000 });
  const local = [], remote = [], heads = new Set();
  const rows = r.stdout.split('\n').filter(Boolean).map(l => l.split('|~|'));
  for (const [ref] of rows) if (ref.startsWith('refs/heads/')) heads.add(ref.slice(11));
  for (const [ref, rel, ts, subject, upstream] of rows) {
    if (ref.startsWith('refs/heads/')) local.push({ name: ref.slice(11), rel, ts: +ts * 1000, subject, upstream });
    else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice(13); if (name.endsWith('/HEAD')) continue;
      const short = name.replace(/^[^/]+\//, '');
      if (!heads.has(short)) remote.push({ name, short, rel, ts: +ts * 1000, subject });
    }
  }
  const cur = await run('git', ['-C', dir, 'branch', '--show-current']);
  return { current: cur.stdout.trim(), local, remote };
}

async function checkout(dir, branch) {
  const isLocal = (await run('git', ['-C', dir, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])).stdout.trim();
  let r;
  if (isLocal) r = await run('git', ['-C', dir, 'checkout', branch], { timeout: 60000 });
  else {
    const short = branch.replace(/^[^/]+\//, '');
    const remoteRef = branch.includes('/') ? branch : `origin/${branch}`;
    r = await run('git', ['-C', dir, 'checkout', '--track', '-b', short, remoteRef], { timeout: 60000 });
    if (!r.ok && !/already exists/.test(r.stderr)) r = await run('git', ['-C', dir, 'checkout', '-b', short], { timeout: 60000 });
  }
  return { ok: r.ok, out: (r.stdout + '\n' + r.stderr).trim() };
}

async function simple(dir, args, timeout = 60000) {
  const r = await run('git', ['-C', dir, ...args], { timeout });
  return { ok: r.ok, out: (r.stdout + '\n' + r.stderr).trim() };
}

// Working-tree overview for the Changes tab: what's staged, what's pending, what's new.
async function changes(dir) {
  const st = await run('git', ['-C', dir, 'status', '--porcelain=v2', '--branch', '-z'], { timeout: 12000 });
  if (!st.ok) return { error: (st.stderr || 'git status failed').trim().split('\n')[0] };
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
  const items = st.stdout.split('\0');
  for (let i = 0; i < items.length; i++) {
    const line = items[i]; if (!line) continue;
    if (line.startsWith('# branch.head ')) out.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) { const m = line.match(/\+(\d+) -(\d+)/); if (m) { out.ahead = +m[1]; out.behind = +m[2]; } }
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' '); const xy = parts[1]; const ren = line.startsWith('2 ');
      const file = parts.slice(ren ? 9 : 8).join(' ');
      const from = ren ? items[++i] : null;
      if (xy[0] !== '.') out.staged.push({ path: file, s: xy[0], from });
      if (xy[1] !== '.') out.unstaged.push({ path: file, s: xy[1] });
    }
    else if (line.startsWith('u ')) { const parts = line.split(' '); out.unstaged.push({ path: parts.slice(10).join(' '), s: 'U' }); }
    else if (line.startsWith('? ')) out.untracked.push({ path: line.slice(2), s: '?' });
  }
  const applyNums = (r, list) => { if (!r.ok) return; for (const l of r.stdout.split('\n')) { const [a, d, ...rest] = l.split('\t'); const f = rest.join('\t'); const it = list.find(x => x.path === f); if (it) { it.add = a === '-' ? null : +a; it.del = d === '-' ? null : +d; } } };
  applyNums(await run('git', ['-C', dir, 'diff', '--cached', '--numstat'], { timeout: 8000 }), out.staged);
  applyNums(await run('git', ['-C', dir, 'diff', '--numstat'], { timeout: 8000 }), out.unstaged);
  const log = await run('git', ['-C', dir, 'log', '-1', '--format=%h%x1f%s%x1f%cr%x1f%an'], { timeout: 5000 });
  if (log.ok && log.stdout.trim()) { const [hash, subject, rel, author] = log.stdout.trim().split('\x1f'); out.last = { hash, subject, rel, author }; }
  // who am I (for the "me" mark) + the last 20 commits; the first `ahead` of them are unpushed
  out.me = (await run('git', ['-C', dir, 'config', 'user.email'], { timeout: 3000 })).stdout.trim();
  const cl = await run('git', ['-C', dir, 'log', '-20', '--format=%h%x1f%an%x1f%ae%x1f%cr%x1f%s'], { timeout: 5000 });
  out.commits = cl.ok ? cl.stdout.split('\n').filter(Boolean).map((l, i) => {
    const [hash, author, email, rel, subject] = l.split('\x1f');
    return { hash, author, email, rel, subject, unpushed: out.upstream ? i < out.ahead : false };
  }) : [];
  return out;
}

const MAX_DIFF = 400 * 1024;
// kind: staged | unstaged | untracked. --no-index exits 1 whenever there IS a diff, so trust stdout.
async function fileDiff(dir, file, kind) {
  const r = kind === 'untracked'
    ? await run('git', ['-C', dir, 'diff', '--no-color', '--no-index', '--', '/dev/null', file], { timeout: 10000 })
    : await run('git', ['-C', dir, 'diff', '--no-color', ...(kind === 'staged' ? ['--cached'] : []), '--', file], { timeout: 10000 });
  const text = r.stdout || '';
  if (!text && !r.ok && r.stderr) return { error: r.stderr.trim().split('\n')[0] };
  return { text: text.length > MAX_DIFF ? text.slice(0, MAX_DIFF) + '\n… (truncated)' : text };
}

// One commit expanded: message + files with +/- (numstat) and status letters (name-status).
async function showCommit(dir, hash) {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return { error: 'bad hash' };
  const head = await run('git', ['-C', dir, 'show', '-s', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%cr%x1f%ci%x1f%s%x1f%b', hash], { timeout: 8000 });
  if (!head.ok) return { error: (head.stderr || 'git show failed').trim().split('\n')[0] };
  const [full, short, author, email, rel, date, subject, body] = head.stdout.split('\x1f');
  const num = await run('git', ['-C', dir, 'show', '--numstat', '--format=', '-M', hash], { timeout: 10000 });
  const ns = await run('git', ['-C', dir, 'show', '--name-status', '--format=', '-M', hash], { timeout: 10000 });
  const status = {}; for (const l of ns.stdout.split('\n')) { if (!l) continue; const [st, ...rest] = l.split('\t'); status[rest[rest.length - 1]] = { s: st[0], from: st[0] === 'R' || st[0] === 'C' ? rest[0] : null }; }
  const files = num.stdout.split('\n').filter(Boolean).map(l => { const [a, d, ...rest] = l.split('\t'); let f = rest.join('\t'); let from = null;
    const m = f.match(/^(.*)\{(.*) => (.*)\}(.*)$/); if (m) { from = m[1] + m[2] + m[4]; f = m[1] + m[3] + m[4]; } else if (f.includes(' => ')) { [from, f] = f.split(' => '); }
    return { path: f, from: from || status[f]?.from || null, s: status[f]?.s || 'M', add: a === '-' ? null : +a, del: d === '-' ? null : +d }; });
  return { hash: full, short, author, email, rel, date, subject, body: (body || '').trim(), files };
}
async function commitFileDiff(dir, hash, file) {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return { error: 'bad hash' };
  const r = await run('git', ['-C', dir, 'show', '--no-color', '-M', '--format=', hash, '--', file], { timeout: 10000 });
  const text = r.stdout || ''; if (!text && !r.ok && r.stderr) return { error: r.stderr.trim().split('\n')[0] };
  return { text: text.length > MAX_DIFF ? text.slice(0, MAX_DIFF) + '\n… (truncated)' : text };
}
// Diff of a working-tree file against HEAD (staged + unstaged together) — what the Files tab shows for a changed file.
async function headDiff(dir, file, untracked) {
  if (untracked) return fileDiff(dir, file, 'untracked');
  const r = await run('git', ['-C', dir, 'diff', '--no-color', 'HEAD', '--', file], { timeout: 10000 });
  const text = r.stdout || ''; if (!text && !r.ok && r.stderr) return { error: r.stderr.trim().split('\n')[0] };
  return { text: text.length > MAX_DIFF ? text.slice(0, MAX_DIFF) + '\n… (truncated)' : text };
}
// Paths with any change (index or working tree), for marking the file tree. Map path -> status letter.
async function changedPaths(dir) {
  const r = await run('git', ['-C', dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: 12000 });
  const map = {}; if (!r.ok) return map;
  const items = r.stdout.split('\0');
  for (let i = 0; i < items.length; i++) { const l = items[i]; if (l.length < 4) continue; const xy = l.slice(0, 2); let p = l.slice(3); if (xy[0] === 'R' || xy[0] === 'C') { i++; } map[p] = xy === '??' ? '?' : (xy[1] !== ' ' ? xy[1] : xy[0]); }
  return map;
}

// Dashboard git actions beyond fetch/pull: stage everything, unstage, commit with a message, push (sets upstream).
async function stageAll(dir) { return simple(dir, ['add', '-A']); }
async function unstageAll(dir) { return simple(dir, ['reset', '-q']); }
async function commit(dir, message) {
  const msg = String(message || '').trim(); if (!msg) return { ok: false, out: 'empty commit message' };
  return simple(dir, ['commit', '-m', msg], 60000);
}
async function push(dir) {
  const up = await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeout: 5000 });
  return simple(dir, up.ok ? ['push'] : ['push', '-u', 'origin', 'HEAD'], 180000);
}

// Throw away Claude's change to one file: tracked -> checkout from HEAD (unstaging first), untracked -> delete.
async function revertFile(dir, file) {
  if (!file || file.includes('..') || path.isAbsolute(file)) return { ok: false, out: 'bad path' };
  const st = await run('git', ['-C', dir, 'status', '--porcelain', '--', file], { timeout: 8000 });
  const line = st.stdout.split('\n').find(Boolean); if (!line) return { ok: true, out: 'no change to revert' };
  if (line.startsWith('??')) { try { require('fs').unlinkSync(path.join(dir, file)); return { ok: true, out: 'deleted untracked ' + file }; } catch (e) { return { ok: false, out: e.message }; } }
  await run('git', ['-C', dir, 'reset', '-q', '--', file], { timeout: 8000 });
  return simple(dir, ['checkout', '--', file]);
}

async function statusAll(projects) {
  const gits = projects.filter(p => p.isGit);
  const res = await mapLimit(gits, 6, p => status(p.path).catch(e => ({ error: String(e) })));
  const map = {};
  gits.forEach((p, i) => { map[p.id] = res[i]; });
  return map;
}

module.exports = { status, statusAll, branches, checkout, simple, changes, fileDiff, commit, commit: showCommit, commitFileDiff, headDiff, changedPaths, stageAll, unstageAll, commitMsg: commit, push, revertFile };
