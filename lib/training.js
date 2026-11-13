'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { SpecialistError } = require('./specialists');
const accesses = require('./accesses');
const providers = require('./providers');
const { transcriptText } = require('./specialist-runs');

const TRAINABLE = ['CLAUDE.md', 'style.md', 'knowledge', 'examples'];
const GITIGNORE = '/*\n!/CLAUDE.md\n!/style.md\n!/knowledge/\n!/examples/\n/.secrets/\n/.bd/\n/.trainers/\n';
const DIFF_MAX = 512 * 1024, GIT_TIMEOUT = 30000, GIT_OUT_MAX = 64 * 1024 * 1024;
const INSTRUCTIONS_MAX = 256 * 1024;
const SHA = /^[0-9a-f]{7,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCES = ['start', 'trainer', 'upload', 'profile', 'outside', 'undo', 'chat', 'preamble'];
const OUTSIDE = 'Changes made outside training';
const BOT_BUSY = 'the bot is busy';
const MESSAGE_MAX = 1024 * 1024;
const GUARDED = ['specialist.json', 'CLAUDE.local.md', '.claude', '.mcp.json', '.gitignore', '.git/config', '.git/hooks', '.git/info'];
const GUARD_MAX = 8 * 1024 * 1024, GUARD_ENTRIES = 5000, GUARD_FILE = 'trainer-guard.json', GUARD_FILE_MAX = 16 * 1024 * 1024;
const CONTROL = /[\x00-\x1f\x7f]/g;
const fail = (status, message) => { throw new SpecialistError(status, message); };
const delay = ms => new Promise(r => setTimeout(r, ms));
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };
const oneLine = (s, max) => String(s || '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isMd = f => f.endsWith('.md');
const isRepo = dir => { const st = lstat(path.join(dir, '.git')); return !!st && st.isDirectory() && !st.isSymbolicLink(); };
const busyLive = L => !!(L && !L.stale && (L.turn || (L.pending && L.pending.length) || (L.inbox && L.inbox.length)));
const chatBusy = L => busyLive(L) || !!(L && !L.stale && L.state === 'working');
const NEUTRAL = { chat: 'Learned', undo: 'Undo', profile: 'Edited', preamble: 'Updated' };
const neutralSubject = (source, paths) => oneLine(`${NEUTRAL[source] || 'Changed'}: ${pathList(paths)}`, 200);
const pathList = paths => `${paths.slice(0, 8).join(', ')}${paths.length > 8 ? ` and ${paths.length - 8} more` : ''}`;

function gitFail(dir, what, r) {
  const masked = (() => { try { return accesses.mask(accesses.values(dir), String(r.err || '')); } catch { return ''; } })();
  const why = r.signal ? 'it took too long' : oneLine(masked.trim().split('\n').pop(), 300) || `exit ${r.code}`;
  return new SpecialistError(500, `git ${what} failed: ${why}`);
}

function clearStaleLock(dir) {
  const lock = path.join(dir, '.git', 'index.lock'), st = lstat(lock);
  if (st && st.isFile() && Date.now() - st.mtimeMs > GIT_TIMEOUT) { try { fs.rmSync(lock, { force: true }); } catch {} }
}

function git(dir, args, { max = GIT_OUT_MAX, init = false } = {}) {
  if (!init) clearStaleLock(dir);
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', ...(init ? {} : { GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: dir }) };
  const argv = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=beast-dash', '-c', 'user.email=beast-dash@localhost', '-c', 'gc.auto=0', '-C', dir, ...args];
  return new Promise(resolve => {
    const p = spawn('git', argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], st = { bytes: 0, truncated: false, err: '' };
    const timer = setTimeout(() => p.kill('SIGKILL'), GIT_TIMEOUT);
    p.stdout.on('data', d => {
      const part = d.subarray(0, Math.max(0, max - st.bytes));
      if (part.length < d.length) st.truncated = true;
      if (part.length) { out.push(part); st.bytes += part.length; }
    });
    p.stderr.on('data', d => { if (st.err.length < 4000) st.err += d; });
    p.on('error', e => { clearTimeout(timer); resolve({ code: -1, signal: null, out: Buffer.alloc(0), err: e.message, truncated: false }); });
    p.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: signal ? -1 : code, signal, out: Buffer.concat(out), err: st.err, truncated: st.truncated }); });
  });
}

async function gitOk(dir, args, opts) {
  const r = await git(dir, args, opts);
  if (r.code !== 0) throw gitFail(dir, args[0], r);
  return r;
}

function checkTrainable(dir) {
  for (const f of TRAINABLE) {
    const st = lstat(path.join(dir, f));
    if (st && (st.isSymbolicLink() || !(isMd(f) ? st.isFile() : st.isDirectory()))) fail(409, `${f} must be a ${isMd(f) ? 'regular file' : 'real folder'}, not a symlink`);
  }
  const g = lstat(path.join(dir, '.git'));
  if (g && (g.isSymbolicLink() || !g.isDirectory())) fail(409, '.git in the profile is not a plain folder');
}

function parseLog(out) {
  return out.toString('utf8').split('\x1e').filter(Boolean).map(rec => {
    const [id, parents, ct, body, rest = ''] = rec.split('\x1f');
    const parts = rest.replace(/^\0?\n?/, '').split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ path: parts[i + 1], change: parts[i][0] === 'A' ? 'added' : parts[i][0] === 'D' ? 'deleted' : 'modified' });
    const paras = String(body || '').trim().split(/\n\s*\n/);
    const trailers = paras.length > 1 ? paras[paras.length - 1] : '';
    const src = /^Bd-Source: ([a-z]+)$/m.exec(trailers);
    const undo = /^Bd-Undo: ([0-9a-f]{40})$/m.exec(trailers);
    const root = !String(parents || '').trim();
    return {
      id, short: id.slice(0, 7), message: oneLine(paras[0].split('\n')[0], 200), source: src && SOURCES.includes(src[1]) ? src[1] : root ? 'start' : 'outside',
      at: (+ct || 0) * 1000, undoOf: undo ? undo[1] : null, undone: false, files, root, merge: String(parents || '').trim().split(/\s+/).length > 1,
    };
  });
}

async function readLog(dir) {
  if (!isRepo(dir)) return [];
  const r = await git(dir, ['log', '--no-renames', '--name-status', '-z', '--no-color', '--format=%x1e%H%x1f%P%x1f%ct%x1f%B%x1f']);
  if (r.code !== 0) {
    if (/does not have any commits|bad default revision|unknown revision/.test(r.err)) return [];
    throw gitFail(dir, 'log', r);
  }
  const log = parseLog(r.out);
  const undone = new Map();
  for (const c of log) {
    const by = log.filter(u => u.undoOf === c.id && u.at >= 0);
    undone.set(c.id, by.some(u => !undone.get(u.id)));
  }
  return log.map(c => ({ ...c, undone: !!undone.get(c.id) }));
}

const commitOut = ({ root, merge, ...c }) => c;

function findCommit(log, sha) {
  const hits = log.filter(c => c.id.startsWith(sha));
  if (hits.length > 1) fail(400, `${sha} matches more than one commit`);
  return hits[0] || null;
}

function summaryLine(text) {
  const all = typeof text === 'string' ? [...text.matchAll(/^[\s*_>#-]*Summary:[*_]*[ \t]*(.+?)[\s*_]*$/gim)] : [];
  return all.length ? oneLine(all[all.length - 1][1], 120) || null : null;
}

function guardEntry(abs) {
  const st = lstat(abs);
  if (!st) return null;
  if (st.isSymbolicLink()) return { kind: 'link', target: (() => { try { return fs.readlinkSync(abs); } catch { return ''; } })() };
  if (st.isDirectory()) return { kind: 'dir', mode: st.mode & 0o777 };
  if (!st.isFile()) return { kind: 'other' };
  return { kind: 'file', mode: st.mode & 0o777, size: st.size, data: null, hash: null };
}

function guardWalk(dir, rel, out, budget) {
  if (out.size >= GUARD_ENTRIES) return;
  const abs = path.join(dir, rel);
  const e = guardEntry(abs);
  if (!e) return;
  if (e.kind === 'file') {
    const data = (() => { try { return fs.readFileSync(abs); } catch { return null; } })();
    e.hash = data ? crypto.createHash('sha256').update(data).digest('hex') : null;
    if (data && budget.left >= data.length) { e.data = data; budget.left -= data.length; }
  }
  out.set(rel, e);
  if (e.kind !== 'dir') return;
  const names = (() => { try { return fs.readdirSync(abs).sort(); } catch { return []; } })();
  for (const n of names) guardWalk(dir, path.join(rel, n), out, budget);
}

function takeGuard(dir) {
  const out = new Map(), budget = { left: GUARD_MAX };
  for (const rel of GUARDED) guardWalk(dir, rel, out, budget);
  return out;
}

const guardedRel = rel => typeof rel === 'string' && GUARDED.some(g => rel === g || rel.startsWith(g + path.sep)) && !rel.split(path.sep).includes('..');

function validGuardEntry(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.kind === 'dir') return Number.isInteger(e.mode);
  if (e.kind === 'file') return Number.isInteger(e.mode) && (e.data === null || typeof e.data === 'string');
  if (e.kind === 'link') return typeof e.target === 'string';
  return e.kind === 'other';
}

function guardText(guard) {
  return JSON.stringify([...guard].filter(([, e]) => e).map(([rel, e]) => [rel, { ...e, data: e.data ? e.data.toString('base64') : null }]));
}

function guardFrom(text) {
  const data = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (!Array.isArray(data)) return null;
  const out = new Map();
  for (const item of data) {
    if (!Array.isArray(item) || !guardedRel(item[0]) || !validGuardEntry(item[1])) return null;
    out.set(item[0], { ...item[1], data: typeof item[1].data === 'string' ? Buffer.from(item[1].data, 'base64') : null });
  }
  return out;
}

function importsShut(dir, rel) {
  const st = lstat(path.join(dir, rel));
  if (!st || !st.isFile()) return false;
  try { return !!providers.shutImport(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return false; }
}

const sameEntry = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind === 'file' ? a.hash === b.hash && a.mode === b.mode : a.kind === 'link' ? a.target === b.target : a.kind === 'dir' ? a.mode === b.mode : true);

function restoreGuard(dir, before) {
  if (!before) return [];
  const now = takeGuard(dir);
  const changed = [...new Set([...before.keys(), ...now.keys()])].filter(k => !sameEntry(before.get(k), now.get(k))).sort();
  if (!changed.length) return [];
  const unfixed = [];
  for (const rel of [...changed].sort((a, b) => b.length - a.length)) {
    if (before.has(rel)) continue;
    try { fs.rmSync(path.join(dir, rel), { recursive: true, force: true }); } catch { unfixed.push(rel); }
  }
  for (const rel of changed.filter(k => before.has(k)).sort((a, b) => a.length - b.length)) {
    const e = before.get(rel), abs = path.join(dir, rel);
    try {
      const cur = lstat(abs);
      if (e.kind === 'dir') {
        if (cur && !(cur.isDirectory() && !cur.isSymbolicLink())) fs.rmSync(abs, { recursive: true, force: true });
        if (!lstat(abs)) fs.mkdirSync(abs);
        fs.chmodSync(abs, e.mode);
      } else if (e.kind === 'file' && e.data) {
        if (cur && (cur.isDirectory() || cur.isSymbolicLink())) fs.rmSync(abs, { recursive: true, force: true });
        const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.bd-${crypto.randomBytes(4).toString('hex')}`);
        fs.writeFileSync(tmp, e.data, { flag: 'wx', mode: e.mode });
        fs.chmodSync(tmp, e.mode);
        fs.renameSync(tmp, abs);
      } else if (e.kind === 'link') {
        fs.rmSync(abs, { recursive: true, force: true });
        fs.symlinkSync(e.target, abs);
      } else unfixed.push(rel);
    } catch { unfixed.push(rel); }
  }
  return changed.map(rel => unfixed.includes(rel) ? `${rel} (could not be put back)` : rel);
}

function createTraining({ store, headless, tmuxHas, claudeGet = () => null, goneMs = 300, skills = null }) {
  const turns = new Map();
  const watched = new Map();
  const queues = new Map();

  function serial(name, fn) {
    const job = (queues.get(name) || Promise.resolve()).then(fn);
    const tail = job.then(() => {}, () => {});
    queues.set(name, tail);
    tail.then(() => { if (queues.get(name) === tail) queues.delete(name); });
    return job;
  }

  function profile(name) {
    const p = store.get(name);
    checkTrainable(p.dir);
    return p;
  }

  const guardFile = dir => path.join(dir, store.DASH_DIR, GUARD_FILE);

  function saveGuard(dir, guard) {
    store.dashDir(dir, true);
    store.writeAtomic(guardFile(dir), guardText(guard));
  }

  function loadGuard(dir) {
    try { return store.dashDir(dir, false) ? guardFrom(store.readFileIn(path.join(dir, store.DASH_DIR), GUARD_FILE, GUARD_FILE_MAX)) : null; } catch { return null; }
  }

  function dropGuard(dir) {
    try { fs.rmSync(guardFile(dir), { force: true }); } catch {}
  }

  function rebase(name) {
    const t = turns.get(name);
    if (!t || !t.guard) return;
    const dir = store.profileDir(name);
    const fresh = takeGuard(dir).get('specialist.json');
    if (fresh) t.guard.set('specialist.json', fresh); else t.guard.delete('specialist.json');
    try { saveGuard(dir, t.guard); } catch {}
  }

  function withSkill(p) {
    return skills ? { ...p, skill: skills.sync(p) } : p;
  }

  function touch(name) {
    store.touch(name);
    rebase(name);
    if (skills) { try { skills.sync(store.get(name)); } catch (e) { console.error(`specialist skill ${name}: ${e.message}`); } }
  }

  async function busyNow(name) {
    const t = turns.get(name);
    if (t) return BOT_BUSY;
    const th = store.getThread(name);
    return th && chatBusy(await snapshotOf(th.tmux)) ? BOT_BUSY : null;
  }

  async function stage(p, only) {
    store.writeAtomic(path.join(p.dir, '.gitignore'), GITIGNORE);
    await gitOk(p.dir, ['add', '-A', ...(only ? ['--', ...only] : [])]);
  }

  async function staged(dir, only, filter) {
    const r = await gitOk(dir, ['diff', '--cached', '--no-renames', '--name-only', '-z', ...(filter ? [`--diff-filter=${filter}`] : []), ...(only ? ['--', ...only] : [])]);
    return r.out.toString('utf8').split('\0').filter(Boolean);
  }

  async function holdImports(p, restore, only) {
    const bad = (await staged(p.dir, only, 'AM')).filter(f => importsShut(p.dir, f));
    if (!bad.length) return [];
    const head = (await git(p.dir, ['rev-parse', '-q', '--verify', 'HEAD'])).code === 0;
    for (const f of bad) {
      const known = head && (await git(p.dir, ['cat-file', '-e', `HEAD:${f}`])).code === 0;
      if (known) await gitOk(p.dir, restore ? ['checkout', '-q', 'HEAD', '--', f] : ['reset', '-q', 'HEAD', '--', f]);
      else {
        await gitOk(p.dir, ['rm', '-q', '--cached', '-f', '--', f]);
        if (restore) fs.rmSync(path.join(p.dir, f), { force: true });
      }
    }
    return bad;
  }

  async function holdSecrets(p, only) {
    const why = accesses.commitGuard(p.dir);
    const head = (await git(p.dir, ['rev-parse', '-q', '--verify', 'HEAD'])).code === 0;
    for (const f of await staged(p.dir, only, 'd')) {
      const reason = await why(f, async () => { const r = await git(p.dir, ['cat-file', 'blob', `:${f}`]); return r.code === 0 && !r.truncated ? r.out : null; });
      if (!reason) continue;
      const known = head && (await git(p.dir, ['cat-file', '-e', `HEAD:${f}`])).code === 0;
      await gitOk(p.dir, known ? ['reset', '-q', 'HEAD', '--', f] : ['rm', '-q', '--cached', '-f', '--', f]);
      console.error(`specialist ${p.name}: left out of the commit: ${reason}`);
    }
  }

  async function ensureRepo(p) {
    checkTrainable(p.dir);
    if (isRepo(p.dir)) return false;
    await gitOk(p.dir, ['init', '-q', '-b', 'main', '--template=', p.dir], { init: true });
    await stage(p);
    await holdImports(p, false);
    await holdSecrets(p);
    await gitOk(p.dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'Starting point', '-m', 'Bd-Source: start']);
    touch(p.name);
    return true;
  }

  async function clearIndex(dir) {
    const head = (await git(dir, ['rev-parse', '-q', '--verify', 'HEAD'])).code === 0;
    await gitOk(dir, head ? ['reset', '-q'] : ['read-tree', '--empty']);
  }

  async function commitIn(p, source, subject, { undoOf = null, only = null } = {}) {
    checkTrainable(p.dir);
    if (!isRepo(p.dir)) return { sha: null, held: [] };
    if (only) await clearIndex(p.dir);
    await stage(p, only);
    const held = await holdImports(p, source === 'chat', only);
    await holdSecrets(p, only);
    const diff = await git(p.dir, ['diff', '--cached', '--quiet']);
    if (diff.code === 0) return { sha: null, held };
    if (diff.code !== 1) throw gitFail(p.dir, 'diff', diff);
    const paths = await staged(p.dir, null, null);
    const wanted = typeof subject === 'function' ? subject(paths) : subject;
    const known = accesses.values(p.dir);
    const message = (accesses.knownIn(known, wanted) ? neutralSubject(source, paths) : oneLine(wanted, 200)) || 'Training';
    await gitOk(p.dir, ['commit', '-q', '--no-verify', '-m', message, '-m', `Bd-Source: ${source}${undoOf ? `\nBd-Undo: ${undoOf}` : ''}`]);
    touch(p.name);
    return { sha: (await gitOk(p.dir, ['rev-parse', 'HEAD'])).out.toString('utf8').trim(), held };
  }

  const commitOutside = p => commitIn(p, 'outside', OUTSIDE);

  function writePreamble(p) {
    if (providers.isApi(p.provider)) return false;
    const file = path.join(p.dir, store.INSTRUCTIONS_FILE), st = lstat(file);
    if (st && (st.isSymbolicLink() || !st.isFile())) return false;
    const text = st ? fs.readFileSync(file, 'utf8') : '';
    const next = store.placePreamble(text);
    if (next === text) return false;
    store.writeAtomic(file, next);
    return true;
  }

  async function prepare(p) {
    if (await busyNow(p.name)) return;
    checkTrainable(p.dir);
    if (!isRepo(p.dir)) { writePreamble(p); await ensureRepo(p); return; }
    await commitOutside(p);
    if (writePreamble(p)) await commitIn(p, 'preamble', 'Updated the bot preamble', { only: [store.INSTRUCTIONS_FILE] });
  }

  const beforeLaunch = name => serial(name, async () => prepare(store.get(name)));

  const created = name => serial(name, async () => { await ensureRepo(store.get(name)); });

  async function commitObject(dir, sha) {
    if (!sha) return null;
    const c = (await readLog(dir)).find(x => x.id === sha);
    return c ? commitOut(c) : null;
  }

  async function snapshotOf(tmux) {
    return (await tmuxHas(tmux)) ? headless.status(tmux) : null;
  }

  function checkKeys(b, keys) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'body must be a JSON object');
    const bad = Object.keys(b).filter(k => !keys.includes(k));
    if (bad.length) fail(400, `unknown field ${bad.map(k => `"${k}"`).join(', ')}`);
  }

  function followThread(name, tmux, sessionId) {
    if (!UUID.test(sessionId || '')) return;
    try {
      const t = store.getThread(name);
      if (!t || t.tmux !== tmux || t.sessionId === sessionId) return;
      const transcriptPath = t.transcriptPath ? path.join(path.dirname(t.transcriptPath), sessionId + '.jsonl') : null;
      store.setThread(name, { ...t, sessionId, transcriptPath });
    } catch {}
  }

  function unwatch(tmux) {
    const w = watched.get(tmux);
    if (!w) return;
    watched.delete(tmux);
    w.unsub();
  }

  function markChat(name, tmux) {
    if (turns.has(name)) return;
    try {
      const p = store.get(name);
      if (providers.isApi(p.provider)) return;
      const guard = takeGuard(p.dir);
      saveGuard(p.dir, guard);
      turns.set(name, { tmux, kind: 'chat', guard, followedUp: false });
    } catch (e) { console.error(`bot ${name}: the turn could not be marked: ${e.message}`); }
  }

  function onEvent(tmux, w, o) {
    if (watched.get(tmux) !== w) return;
    if (o.ev === 'snapshot') {
      followThread(w.name, tmux, o.sessionId);
      if (o.state === 'working' || o.turn) markChat(w.name, tmux);
      return;
    }
    if (o.ev === 'state' && o.state === 'working') { markChat(w.name, tmux); return; }
    if (o.ev === 'result') {
      const c = claudeGet(tmux);
      if (c) followThread(w.name, tmux, c.sessionId);
      serial(w.name, () => finishChat(w.name, tmux, o)).catch(() => {});
      return;
    }
    if (o.ev !== 'gone') return;
    if (o.forgotten) setTimeout(() => { if (watched.get(tmux) === w) w.unsub = headless.subscribe(tmux, x => onEvent(tmux, w, x)); }, 0);
    else checkGone(w.name, tmux, w);
  }

  function watch(name, tmux) {
    const old = watched.get(tmux);
    if (old && old.name === name) return;
    if (old) unwatch(tmux);
    const w = { name, unsub: () => {} };
    watched.set(tmux, w);
    w.unsub = headless.subscribe(tmux, o => onEvent(tmux, w, o));
  }

  async function checkGone(name, tmux, w) {
    for (let i = 0; i < 10; i++) {
      await delay(goneMs);
      if (watched.get(tmux) !== w) return;
      if (!(await tmuxHas(tmux))) {
        unwatch(tmux);
        await serial(name, () => finishChat(name, tmux, { subtype: 'gone' })).catch(() => {});
        return;
      }
    }
  }

  async function deliver(tmux, text) {
    const up = await headless.waitForRunner(tmux);
    if (!up.up && !up.starting) return { ok: false, error: 'the bot did not start' };
    const first = await headless.send(tmux, text, MESSAGE_MAX);
    if (first.ok || !/not reachable/.test(first.error || '')) return first;
    await delay(1000);
    return headless.send(tmux, text, MESSAGE_MAX);
  }

  function instructionsBytes(dir) {
    const st = lstat(path.join(dir, store.INSTRUCTIONS_FILE));
    return st && st.isFile() ? st.size : 0;
  }

  async function finishChat(name, tmux, o) {
    const turn = turns.get(name);
    if (!turn || turn.tmux !== tmux || turn.kind !== 'chat') return;
    const p = (() => { try { return store.get(name); } catch { return null; } })();
    if (!p) { turns.delete(name); return; }
    const cut = o.subtype === 'gone' || o.subtype === 'restarted';
    if (!cut && !turn.followedUp && instructionsBytes(p.dir) > INSTRUCTIONS_MAX) {
      turn.followedUp = true;
      const s = await deliver(tmux, `CLAUDE.md is ${Math.ceil(instructionsBytes(p.dir) / 1024)} KiB, the limit is 256 KiB: move details into knowledge/`).catch(e => ({ ok: false, error: e.message }));
      if (s.ok) return;
    }
    try {
      const broken = restoreGuard(p.dir, turn.guard);
      if (broken.length) console.error(`bot ${name}: the chat changed files it may not change, and they were put back: ${pathList(broken)}`);
      writePreamble(p);
      const th = (() => { try { return store.getThread(name); } catch { return null; } })();
      const text = cut ? null : typeof o.text === 'string' && o.text.trim() ? o.text : transcriptText(th && th.transcriptPath);
      const r = await commitIn(p, 'chat', paths => summaryLine(text) || `Learned: ${pathList(paths)}`);
      if (r.held.length) console.error(`bot ${name}: the chat imported from .secrets, .bd or .git, and those files were put back: ${pathList(r.held)}`);
    } catch (e) {
      console.error(`bot ${name}: the turn was not saved in the history: ${e.message}`);
    } finally {
      if (turns.get(name) === turn) turns.delete(name);
      dropGuard(p.dir);
    }
    if (!cut && chatBusy(headless.live(tmux))) markChat(name, tmux);
  }

  async function chatTurn(tmux, text) {
    const name = store.threadOfTmux(tmux);
    if (!name) return { ok: false, error: 'not a bot chat' };
    try {
      return await serial(name, async () => {
        const p = store.get(name);
        if (providers.isApi(p.provider)) return headless.send(tmux, text);
        const running = turns.get(name);
        if (running) return running.tmux === tmux ? headless.send(tmux, text) : { ok: false, error: BOT_BUSY };
        watch(name, tmux);
        if (chatBusy(await headless.status(tmux))) markChat(name, tmux);
        if (!turns.has(name)) {
          await ensureRepo(p);
          await commitOutside(p);
        }
        if (turns.has(name)) return turns.get(name).tmux === tmux ? headless.send(tmux, text) : { ok: false, error: BOT_BUSY };
        const guard = takeGuard(p.dir);
        saveGuard(p.dir, guard);
        const turn = { tmux, kind: 'chat', guard, followedUp: false };
        turns.set(name, turn);
        const s = await headless.send(tmux, text).catch(e => ({ ok: false, error: e.message }));
        if (!s.ok && turns.get(name) === turn) { turns.delete(name); dropGuard(p.dir); }
        return s;
      });
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function watchChat(name, tmux) {
    watch(name, tmux);
    const L = headless.live(tmux);
    if (L && !L.stale && (L.state === 'working' || L.turn)) markChat(name, tmux);
  }

  async function history(name, { limit = 50, before = null } = {}) {
    const p = profile(name);
    if (before !== null && !SHA.test(before)) fail(400, 'before must be a sha of 7-40 hex characters');
    const log = await readLog(p.dir);
    const start = before === null ? 0 : (() => { const c = findCommit(log, before); if (!c) fail(404, `no commit ${before} in this profile's history`); return log.indexOf(c) + 1; })();
    const commits = log.slice(start, start + limit);
    return { commits: commits.map(commitOut), more: start + limit < log.length };
  }

  async function commit(name, sha) {
    if (typeof sha !== 'string' || !SHA.test(sha)) fail(400, 'sha must be 7-40 hex characters');
    const p = profile(name);
    const c = findCommit(await readLog(p.dir), sha);
    if (!c) fail(404, `no commit ${sha} in this profile's history`);
    const r = await git(p.dir, ['show', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--format=', '--patch', c.id], { max: DIFF_MAX });
    if (r.code !== 0) throw gitFail(p.dir, 'show', r);
    return { commit: commitOut(c), diff: r.out.toString('utf8').replace(/^\n+/, ''), truncated: r.truncated };
  }

  async function undo(name, body) {
    checkKeys(body, ['commit']);
    if (typeof body.commit !== 'string' || !SHA.test(body.commit)) fail(400, 'commit must be a sha of 7-40 hex characters');
    return serial(name, async () => {
      const p = profile(name);
      const busy = await busyNow(name);
      if (busy) fail(409, busy);
      await ensureRepo(p);
      await commitOutside(p);
      const c = findCommit(await readLog(p.dir), body.commit);
      if (!c) fail(404, `no commit ${body.commit} in this profile's history`);
      if (c.source === 'start' || c.root) fail(400, "the starting point can't be undone");
      if (c.source === 'preamble') fail(400, 'the preamble is managed by the dashboard');
      if (c.merge) fail(400, "a merge can't be undone here");
      const r = await git(p.dir, ['revert', '--no-commit', '--no-edit', c.id]);
      const abort = async () => { const a = await git(p.dir, ['revert', '--abort']); if (a.code !== 0) await git(p.dir, ['reset', '-q', '--hard', 'HEAD']); };
      if (r.code !== 0) { await abort(); fail(409, 'later changes touch the same lines; undo those first'); }
      const { sha } = await (async () => { try { return await commitIn(p, 'undo', `Undo: ${c.message}`, { undoOf: c.id }); } catch (e) { await abort(); throw e; } })();
      if (!sha) { await abort(); fail(409, 'that change is already undone'); }
      return { commit: await commitObject(p.dir, sha) };
    });
  }

  async function update(name, patch) {
    return serial(name, async () => {
      const dir = store.profileDir(name);
      const instructions = !!patch && typeof patch === 'object' && !Array.isArray(patch) && patch.instructions !== undefined;
      const busy = instructions ? await busyNow(name) : null;
      if (busy) fail(409, busy);
      const tracked = instructions && isRepo(dir);
      if (tracked) {
        const before = store.get(name);
        if (patch.ifUpdatedAt !== undefined && patch.ifUpdatedAt !== before.updatedAt) fail(409, 'the profile changed since it was loaded; reload it');
        checkTrainable(dir);
        await commitOutside(before);
      }
      const p = store.update(name, tracked && patch.ifUpdatedAt !== undefined ? { ...patch, ifUpdatedAt: store.get(name).updatedAt } : patch);
      rebase(name);
      if (tracked) await commitIn(p, 'profile', 'Edited instructions');
      return withSkill(store.get(name));
    });
  }

  function accessList(name) {
    const p = store.get(name);
    return { accesses: accesses.list(p.dir), usedByRuns: p.provider === 'claude' };
  }

  async function setAccess(name, body) {
    return serial(name, async () => {
      const access = accesses.set(store.get(name).dir, body);
      return { access };
    });
  }

  async function removeAccess(name, key) {
    return serial(name, async () => {
      const removed = accesses.remove(store.get(name).dir, key);
      return { name: removed };
    });
  }

  async function recoverChat(p) {
    const th = store.getThread(p.name);
    const snap = th ? await snapshotOf(th.tmux) : null;
    if (snap) watch(p.name, th.tmux);
    if (!snap || !(snap.state === 'working' || snap.turn) || providers.isApi(p.provider)) return false;
    const guard = loadGuard(p.dir) || takeGuard(p.dir);
    saveGuard(p.dir, guard);
    turns.set(p.name, { tmux: th.tmux, kind: 'chat', guard, followedUp: false });
    return true;
  }

  async function recover(p) {
    if (await recoverChat(p)) return;
    if (!isRepo(p.dir)) { try { await ensureRepo(p); } catch (e) { console.error(`bot ${p.name}: the history could not be started: ${e.message}`); } }
    const saved = loadGuard(p.dir);
    if (saved) { restoreGuard(p.dir, saved); dropGuard(p.dir); }
    if (isRepo(p.dir)) { try { await commitOutside(p); } catch {} }
  }

  async function boot() {
    for (const p of store.list()) {
      if (p.error) continue;
      await serial(p.name, () => recover(p)).catch(() => {});
    }
  }

  return { chatTurn, watchChat, beforeLaunch, prepare, created, busy: busyNow, history, commit, undo, update, accessList, setAccess, removeAccess, boot, serial };
}

module.exports = { createTraining, summaryLine };
