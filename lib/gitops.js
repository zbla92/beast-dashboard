'use strict';
const fs = require('fs');
const path = require('path');
const { run, inside } = require('./util');
const roots = require('./roots');

const MAX_FILES = 1000;
const MAX_PATH = 4096;
const MAX_MESSAGE = 64 * 1024;
const MAX_NAME = 255;
const MAX_BRANCHES = 300;
const MAX_LOG = 200;
const MAX_SKIP = 1e7;
const MAX_WALK = 20000;
const MAX_ERROR = 8000;
const LOCAL_MS = 60000;
const READ_MS = 8000;
const limits = { netMs: 300000, hookMs: 300000 };
const SCRUBBED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'];
const RENAME_RE = /(?:R\d*\0([^\0]*)\0([^\0]*)|[A-Z]\d*\0[^\0]*)\0/g;
const HEX_RE = /^[0-9a-f]{4,40}$/i;
const queues = new Map();

function init(opts = {}) { Object.assign(limits, opts); }

function envFor(dir, literal) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  for (const k of SCRUBBED) delete env[k];
  if (literal) env.GIT_LITERAL_PATHSPECS = '1';
  return env;
}
const git = (dir, args, { timeout = LOCAL_MS, literal = false } = {}) => run('git', ['-C', dir, ...args], { timeout, env: envFor(dir, literal) });

const bad = (error, status = 400) => Object.assign(new Error(error), { status });
const refuse = error => ({ ok: false, error });

function gitOutput(r) {
  const text = [r.stdout, r.stderr].map(s => (s || '').trim()).filter(Boolean).join('\n').split('\n').filter(l => !l.startsWith('hint:')).join('\n').trim();
  return text.length > MAX_ERROR ? '…' + text.slice(-MAX_ERROR) : text;
}
const fail = (r, what) => refuse(r.err && r.err.killed ? `${what} timed out` : gitOutput(r) || `${what} failed`);

function enqueue(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {}).finally(() => { if (queues.get(key) === tail) queues.delete(key); });
  queues.set(key, tail);
  return next;
}

function cleanRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > MAX_PATH || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const s = rel.endsWith('/') ? rel.slice(0, -1) : rel;
  return s.split('/').every(x => x && x !== '.' && x !== '..' && x.toLowerCase() !== '.git') ? s : null;
}

function lstatOf(abs) {
  try { return fs.lstatSync(abs); } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : false; }
}

function parentKind(dir, rel) {
  const segs = rel.split('/').slice(0, -1);
  for (const i of segs.keys()) {
    const st = lstatOf(path.join(dir, ...segs.slice(0, i + 1)));
    if (st === false) return 'link';
    if (st === null) return 'dir';
    if (st.isSymbolicLink()) return 'link';
    if (!st.isDirectory()) return 'file';
  }
  return 'dir';
}

function resolveRel(dir, rel) {
  const s = cleanRel(rel);
  if (s === null) return null;
  const abs = path.resolve(dir, s);
  if (abs === dir || !inside(abs, dir)) return null;
  return parentKind(dir, s) === 'link' ? null : s;
}

function safeFile(dir, rel) {
  try { return resolveRel(fs.realpathSync(dir), rel); } catch { return null; }
}

function fileList(dir, files) {
  if (!Array.isArray(files) || !files.length) throw bad('files must be a non-empty list');
  if (files.length > MAX_FILES) throw bad(`too many files (max ${MAX_FILES})`);
  return [...new Set(files.map(f => {
    const s = resolveRel(dir, f);
    if (s === null) throw bad(`bad path: ${String(f).slice(0, 200)}`);
    return s;
  }))];
}

function selection(dir, body) {
  if (body.all !== undefined && body.files !== undefined) throw bad('give files or all, not both');
  if (body.all === true) return null;
  if (body.all !== undefined) throw bad('all must be true');
  return fileList(dir, body.files);
}

async function stage(dir, body) {
  const files = selection(dir, body);
  const r = await git(dir, files ? ['add', '-A', '--', ...files] : ['add', '-A'], { literal: true });
  return r.ok ? { ok: true } : fail(r, 'git add');
}

async function withRenames(dir, files) {
  const r = await git(dir, ['diff', '--cached', '--name-status', '-M', '-z']);
  if (!r.ok) return files;
  const wanted = new Set(files);
  for (const m of r.stdout.matchAll(RENAME_RE)) {
    if (m[1] === undefined) continue;
    if (wanted.has(m[1]) || wanted.has(m[2])) { wanted.add(m[1]); wanted.add(m[2]); }
  }
  return [...wanted];
}

async function unstage(dir, body) {
  const files = selection(dir, body);
  const paths = files ? await withRenames(dir, files) : ['.'];
  const r = await git(dir, ['reset', '-q', '--', ...paths], { literal: true });
  return r.ok ? { ok: true } : fail(r, 'git reset');
}

function repoInside(abs) {
  const stack = [abs];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    const ents = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of ents) {
      if (e.name.toLowerCase() === '.git') return 'contains a nested repository';
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
      seen.add(path.join(cur, e.name));
      if (seen.size > MAX_WALK) return 'is too large to check';
    }
  }
  return null;
}

function untrackedProblem(dir, f, listed) {
  if (listed.some(x => x.endsWith('/'))) return `${f} contains a nested repository`;
  const st = lstatOf(path.join(dir, f));
  if (!st) return `${f} could not be read`;
  if (!st.isDirectory()) return null;
  try {
    const why = repoInside(path.join(dir, f));
    return why ? `${f} ${why}` : null;
  } catch { return `${f} could not be read`; }
}

function deleteListed(dir, f, listed) {
  const folders = new Set();
  for (const rel of listed) {
    const s = resolveRel(dir, rel);
    if (s === null) return `could not delete ${rel}: not inside the repository`;
    const abs = path.join(dir, s);
    const st = lstatOf(abs);
    if (!st) continue;
    if (st.isDirectory()) return `could not delete ${rel}: it is a folder`;
    try { fs.unlinkSync(abs); } catch (e) { return `could not delete ${rel}: ${e.code || e.message}`; }
    const segs = s.split('/');
    for (const n of segs.keys()) {
      const parent = segs.slice(0, n).join('/');
      if (parent === f || parent.startsWith(f + '/')) folders.add(parent);
    }
  }
  for (const d of [...folders].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(path.join(dir, d)); } catch {} }
  return null;
}

async function discard(dir, body) {
  const files = fileList(dir, body.files);
  if (body.untracked !== undefined && typeof body.untracked !== 'boolean') throw bad('untracked must be true or false');
  const [cached, others] = await Promise.all([
    git(dir, ['ls-files', '--cached', '-z', '--', ...files], { literal: true }),
    git(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...files], { literal: true }),
  ]);
  if (!cached.ok) return fail(cached, 'git ls-files');
  if (!others.ok) return fail(others, 'git ls-files');
  const index = cached.stdout.split('\0').filter(Boolean);
  const exact = new Set(index);
  const loose = others.stdout.split('\0').filter(Boolean);
  const tracked = [];
  const untracked = [];
  for (const f of files) {
    const under = x => x.startsWith(f + '/');
    if (parentKind(dir, f) !== 'dir') return refuse(`${f}: its folder has been replaced by a file, nothing was discarded`);
    if (exact.has(f)) {
      const st = lstatOf(path.join(dir, f));
      if (st && st.isDirectory()) return refuse(`${f} is a folder, nothing was discarded`);
      tracked.push(f);
    } else if (index.some(under)) {
      return refuse(`${f} is a folder with tracked files: discard its files one by one`);
    } else {
      const listed = loose.filter(x => x === f || under(x));
      if (!listed.length) return refuse(`${f}: nothing to discard (it is ignored, or has no unstaged change)`);
      untracked.push({ f, listed });
    }
  }
  if (untracked.length && body.untracked !== true) return refuse(`${untracked[0].f} is untracked: deleting it needs untracked:true`);
  for (const u of untracked) {
    const why = untrackedProblem(dir, u.f, u.listed);
    if (why) return refuse(why);
  }
  if (tracked.length) {
    const r = await git(dir, ['restore', '--worktree', '--', ...tracked], { literal: true });
    if (!r.ok) return fail(r, 'git restore');
  }
  for (const u of untracked) {
    const why = deleteListed(dir, u.f, u.listed);
    if (why) return refuse(why);
  }
  return { ok: true, restored: tracked.length, deleted: untracked.length };
}

async function oidOf(dir, ref) {
  const r = await git(dir, ['rev-parse', '--verify', '-q', '--end-of-options', ref + '^{commit}'], { timeout: READ_MS });
  return r.ok ? r.stdout.trim() : null;
}
async function currentBranch(dir) {
  const r = await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'], { timeout: READ_MS });
  return r.ok ? r.stdout.trim() : null;
}

async function pushedAlready(dir) {
  const up = await oidOf(dir, '@{u}');
  return !!up && (await git(dir, ['merge-base', '--is-ancestor', 'HEAD', up], { timeout: READ_MS })).ok;
}

async function commit(dir, body) {
  if (typeof body.message !== 'string' || !body.message.trim()) throw bad('the commit message is empty');
  if (body.message.includes('\0') || Buffer.byteLength(body.message) > MAX_MESSAGE) throw bad('the commit message is too long or has a NUL byte');
  if (body.amend !== undefined && typeof body.amend !== 'boolean') throw bad('amend must be true or false');
  if (body.amend) {
    if (await pushedAlready(dir)) return refuse('The last commit is already pushed: amending it would need a force push');
  } else {
    const staged = await git(dir, ['diff', '--cached', '--quiet']);
    if (staged.ok) return refuse('Nothing is staged');
    if (staged.code !== 1) return fail(staged, 'git diff');
  }
  const r = await git(dir, ['commit', ...(body.amend ? ['--amend'] : []), '-m', body.message], { timeout: limits.hookMs });
  if (!r.ok) return fail(r, 'git commit');
  const h = await git(dir, ['rev-parse', '--short', 'HEAD'], { timeout: READ_MS });
  return { ok: true, hash: h.stdout.trim(), out: gitOutput(r) };
}

async function push(dir) {
  if (!await currentBranch(dir)) return refuse('Not on a branch (detached HEAD): nothing to push');
  const upstream = await oidOf(dir, '@{u}');
  const r = await git(dir, upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], { timeout: limits.netMs });
  return r.ok ? { ok: true, out: gitOutput(r) } : fail(r, 'git push');
}

async function pull(dir) {
  const r = await git(dir, ['pull', '--ff-only', '--no-rebase', '--no-autostash'], { timeout: limits.netMs });
  return r.ok ? { ok: true, out: gitOutput(r) } : fail(r, 'git pull');
}

async function validBranch(dir, name) {
  if (typeof name !== 'string' || !name || name.length > MAX_NAME || name.startsWith('-') || name.includes('\0')) throw bad('bad branch name');
  const r = await git(dir, ['check-ref-format', '--branch', name], { timeout: READ_MS });
  if (!r.ok || r.stdout.trim() !== name) throw bad('bad branch name');
  return name;
}

async function heldElsewhere(dir, branch) {
  const r = await git(dir, ['worktree', 'list', '--porcelain'], { timeout: READ_MS });
  if (!r.ok) return null;
  const e = roots.parsePorcelain(r.stdout).find(x => {
    if (x.branch !== branch || x.prunable || x.bare) return false;
    try { return fs.realpathSync(x.path) !== dir; } catch { return false; }
  });
  return e ? e.path : null;
}

async function switchTo(dir, branch) {
  const held = await heldElsewhere(dir, branch);
  if (held) return refuse(`${branch} is checked out in another worktree: ${held}`);
  const r = await git(dir, ['switch', '--no-guess', '--end-of-options', branch]);
  return r.ok ? { ok: true, branch } : fail(r, 'git switch');
}

async function remoteParts(dir, name) {
  if (await oidOf(dir, `refs/remotes/${name}`)) {
    const list = await git(dir, ['remote'], { timeout: READ_MS });
    const remote = list.stdout.split('\n').filter(Boolean).filter(x => name.startsWith(x + '/')).sort((a, b) => b.length - a.length)[0];
    return { ref: name, short: remote ? name.slice(remote.length + 1) : name.replace(/^[^/]+\//, '') };
  }
  return await oidOf(dir, `refs/remotes/origin/${name}`) ? { ref: `origin/${name}`, short: name } : null;
}

async function checkout(dir, body) {
  const name = await validBranch(dir, body.branch);
  if (await currentBranch(dir) === name) return { ok: true, branch: name };
  if (await oidOf(dir, `refs/heads/${name}`)) return switchTo(dir, name);
  const remote = await remoteParts(dir, name);
  if (!remote) return refuse(`No branch named ${name}`);
  await validBranch(dir, remote.short);
  if (await currentBranch(dir) === remote.short) return { ok: true, branch: remote.short };
  if (await oidOf(dir, `refs/heads/${remote.short}`)) return switchTo(dir, remote.short);
  const r = await git(dir, ['switch', '-c', remote.short, '--track', remote.ref]);
  return r.ok ? { ok: true, branch: remote.short } : fail(r, 'git switch');
}

async function startPoint(dir, from) {
  await validBranch(dir, from);
  for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
    const oid = await oidOf(dir, prefix + from);
    if (oid) return oid;
  }
  return HEX_RE.test(from) ? oidOf(dir, from) : null;
}

async function branch(dir, body) {
  const name = await validBranch(dir, body.name);
  const hasFrom = body.from !== undefined && body.from !== null;
  const from = hasFrom ? await startPoint(dir, body.from) : null;
  if (hasFrom && !from) return refuse(`No branch, tag or commit named ${body.from}`);
  const r = await git(dir, ['switch', '-c', name, ...(from ? ['--end-of-options', from] : [])]);
  return r.ok ? { ok: true, branch: name } : fail(r, 'git switch');
}

const OPS = new Map(Object.entries({ stage, unstage, discard, commit, push, pull, checkout, branch }));

async function rootDir(id) {
  const p = await roots.rootOf(id);
  if (!p || !p.isGit) return null;
  try { return fs.realpathSync(p.path); } catch { return null; }
}

async function op(id, body) {
  const dir = await rootDir(id);
  if (!dir) return { status: 404, body: refuse('unknown root') };
  const handler = body && typeof body === 'object' && !Array.isArray(body) ? OPS.get(body.op) : null;
  if (!handler) return { status: 400, body: refuse('unknown op') };
  try {
    return { status: 200, body: await enqueue(dir, () => handler(dir, body)) };
  } catch (e) {
    if (e.status) return { status: e.status, body: refuse(e.message) };
    throw e;
  }
}

const REF_FORMAT = ['%(refname)', '%(HEAD)', '%(worktreepath)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)'].join('%1f');
function trackCounts(track) {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? +ahead[1] : 0, behind: behind ? +behind[1] : 0 };
}
async function refRows(dir, prefix) {
  const r = await git(dir, ['for-each-ref', '--sort=-committerdate', `--count=${MAX_BRANCHES + 1}`, `--format=${REF_FORMAT}`, prefix], { timeout: READ_MS });
  return r.ok ? r.stdout.split('\n').filter(Boolean).map(l => l.split('\x1f')) : null;
}

async function defaultBranch(dir, names) {
  const r = await git(dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { timeout: READ_MS });
  if (r.ok && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
  return ['main', 'master'].find(x => names.has(x)) || null;
}

async function branches(dir) {
  const [heads, remotes, current] = await Promise.all([refRows(dir, 'refs/heads'), refRows(dir, 'refs/remotes'), currentBranch(dir)]);
  if (!heads || !remotes) return { current, default: null, branches: [], truncated: false, error: 'could not list branches' };
  const local = heads.slice(0, MAX_BRANCHES).map(([ref, head, worktree, upstream, track, at]) => ({ name: ref.slice('refs/heads/'.length), remote: false, current: head === '*', worktree: worktree || null, upstream: upstream || null, ...trackCounts(track), at: +at * 1000 }));
  const localNames = new Set(local.map(b => b.name));
  const allRemote = remotes.slice(0, MAX_BRANCHES).map(([ref, , , , , at]) => ({ name: ref.slice('refs/remotes/'.length), at: +at * 1000 })).filter(b => !b.name.endsWith('/HEAD'));
  const remoteOnly = allRemote.filter(b => !localNames.has(b.name.replace(/^[^/]+\//, ''))).map(b => ({ name: b.name, remote: true, current: false, worktree: null, upstream: null, ahead: 0, behind: 0, at: b.at }));
  const names = new Set([...localNames, ...allRemote.map(b => b.name.replace(/^[^/]+\//, ''))]);
  return { current, default: await defaultBranch(dir, names), branches: [...local, ...remoteOnly], truncated: heads.length > MAX_BRANCHES || remotes.length > MAX_BRANCHES };
}

function clampInt(v, fallback, max) {
  const n = v === null || v === undefined || v === '' ? NaN : Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
}

async function unpushedSet(dir, count) {
  const upstream = await oidOf(dir, '@{u}');
  if (upstream) {
    const r = await git(dir, ['rev-list', `--max-count=${count}`, 'HEAD', '--not', upstream], { timeout: READ_MS });
    return new Set(r.ok ? r.stdout.split('\n').filter(Boolean) : []);
  }
  const remotes = await git(dir, ['remote'], { timeout: READ_MS });
  if (!remotes.stdout.trim()) return new Set();
  const r = await git(dir, ['rev-list', `--max-count=${count}`, 'HEAD', '--not', '--remotes'], { timeout: READ_MS });
  return new Set(r.ok ? r.stdout.split('\n').filter(Boolean) : []);
}

async function log(dir, opts = {}) {
  const skip = clampInt(opts.skip, 0, MAX_SKIP);
  const limit = Math.max(1, clampInt(opts.limit, 50, MAX_LOG));
  if (!await oidOf(dir, 'HEAD')) return { commits: [], more: false };
  const r = await git(dir, ['log', `--skip=${skip}`, `--max-count=${limit + 1}`, '--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%cr%x1f%ct%x1f%s', 'HEAD', '--'], { timeout: READ_MS });
  if (!r.ok) return { commits: [], more: false, error: gitOutput(r) || 'git log failed' };
  const rows = r.stdout.split('\n').filter(Boolean);
  const unpushed = await unpushedSet(dir, skip + limit + 1);
  const commits = rows.slice(0, limit).map(l => {
    const [hash, short, parents, author, email, rel, ct, ...subject] = l.split('\x1f');
    return { hash, short, subject: subject.join('\x1f'), author, email, rel, at: +ct * 1000, unpushed: unpushed.has(hash), parents: parents ? parents.split(' ') : [] };
  });
  return { commits, more: rows.length > limit };
}

module.exports = { init, op, rootDir, branches, log, cleanRel, safeFile };
