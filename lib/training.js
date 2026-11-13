'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { SpecialistError } = require('./specialists');
const accesses = require('./accesses');
const providers = require('./providers');
const { finalOf, transcriptText } = require('./specialist-runs');

const TRAINABLE = ['CLAUDE.md', 'style.md', 'knowledge', 'examples'];
const GITIGNORE = '/*\n!/CLAUDE.md\n!/style.md\n!/knowledge/\n!/examples/\n';
const FILES_DIR = 'knowledge/files';
const EXTENSIONS = new Set(['md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'eml', 'log', 'sql', 'ini', 'conf', 'sh', 'js', 'ts', 'py', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp']);
const UPLOAD_MAX = 20 * 1024 * 1024, UPLOAD_FILES = 500, UPLOAD_BYTES = 200 * 1024 * 1024, FILE_NAME_MAX = 100;
const UPLOAD_TMP = /^\.upload-.*\.tmp$/;
const EXCLUDE = '/knowledge/files/.upload-*.tmp\n';
const SEND_MAX = 100000, SEND_FILES = 50, MESSAGE_MAX = 1024 * 1024;
const ANSWER_MAX = 200 * 1024, NOTE_MAX = 10000, PENDING_MAX = 50, FEEDBACK_FILE_MAX = 64 * 1024 * 1024, FEEDBACK_KEEP = 500;
const DIFF_MAX = 512 * 1024, GIT_TIMEOUT = 30000, GIT_OUT_MAX = 64 * 1024 * 1024;
const INSTRUCTIONS_MAX = 256 * 1024;
const SHA = /^[0-9a-f]{7,40}$/, FULL_SHA = /^[0-9a-f]{40}$/;
const FEEDBACK_ID = /^fb-[0-9a-z]{1,12}-[0-9a-f]{4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._@+/-]+$/;
const SOURCES = ['start', 'trainer', 'upload', 'profile', 'outside', 'undo'];
const FEEDBACK_STATES = ['pending', 'sent', 'applied', 'failed'];
const OUTSIDE = 'Changes made outside training';
const GUARDED = ['specialist.json', '.claude', '.mcp.json', '.git/config', '.git/hooks', '.git/info'];
const GUARD_MAX = 8 * 1024 * 1024, GUARD_ENTRIES = 5000, GUARD_FILE = 'trainer-guard.json', GUARD_FILE_MAX = 16 * 1024 * 1024;
const TRAINERS_DIR = '.trainers', SETTINGS_FILE = 'settings.json', CONTEXT_FILE = 'context.md';
const CONTROL = /[\x00-\x1f\x7f]/g;
const fail = (status, message) => { throw new SpecialistError(status, message); };
const delay = ms => new Promise(r => setTimeout(r, ms));
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
const oneLine = (s, max) => String(s || '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isMd = f => f.endsWith('.md');
const isRepo = dir => { const st = lstat(path.join(dir, '.git')); return !!st && st.isDirectory() && !st.isSymbolicLink(); };
const busyLive = L => !!(L && !L.stale && (L.turn || (L.pending && L.pending.length) || (L.inbox && L.inbox.length)));

const TRAINER_INSTRUCTIONS = `# Trainer

You shape a specialist: a profile the owner asks to do tasks for them. The specialist is described in \`${CONTEXT_FILE}\` in this folder; read it at the start of every turn. You are not that specialist: don't do its tasks, change its profile so it does them well.

## What you may change

Only these paths in the profile folder named in \`${CONTEXT_FILE}\`:

- \`CLAUDE.md\`: what the specialist does, its rules and how it works. It is the entry point: keep it short, well under 256 KiB, and say in it which file in \`knowledge/\` to read for what.
- \`style.md\`: voice and wording.
- \`knowledge/\`: facts, procedures and reference material, one topic per file. Files the owner uploads land in \`knowledge/files/\`.
- \`examples/\`: real samples of good answers, one per file.

Everything else in the profile is read only (\`specialist.json\`, \`.claude/\`, \`.mcp.json\`, \`.bd/\` with past answers in \`.bd/runs/\`, \`.git/\`, \`.gitignore\`) and \`.secrets/\` is off limits. Every change you make is saved in the profile's history, where the owner can look at it and undo it.

## How you work

- Ask the owner when what they want is unclear, one question at a time.
- Write what the owner tells you into the right file: behaviour and rules go to \`CLAUDE.md\`, voice and wording to \`style.md\`, facts and procedures to \`knowledge/\`, real samples to \`examples/\`.
- Work uploaded files in by summarising them or importing them, not by copying them into \`CLAUDE.md\`.
- An \`openai\` or \`xai\` specialist (see \`${CONTEXT_FILE}\`) only ever sees \`CLAUDE.md\` and the files it imports with \`@knowledge/…\` lines, as text and at most 1 MiB in total: import what it must know, and turn PDFs and images into text files first.
- Never write a credential (a password, token, key or connection string) into any file. When the owner pastes one, tell them to add it under Accesses and refer to it in the profile by its variable name.
- Keep one line \`When to use: <…>\` near the top of \`CLAUDE.md\` that says, in under 300 characters, which work an agent should hand to or load this specialist for. Change it when the specialist's scope changes.
- Feedback shows an answer the specialist gave and the version the owner wanted: change the profile so future answers come out like the better version, and change only what the feedback is about.

## Every reply

After a turn that changed files, say in plain words what changed and end the reply with one line:

Summary: <what changed, under 80 chars>
`;

function gitFail(what, r) {
  const why = r.signal ? 'it took too long' : oneLine(String(r.err || '').trim().split('\n').pop(), 300) || `exit ${r.code}`;
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
  if (r.code !== 0) throw gitFail(args[0], r);
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
    throw gitFail('log', r);
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

function cleanName(raw) {
  if (typeof raw !== 'string' || !raw.trim()) fail(400, 'filename is required');
  if (raw.length > 1000) fail(400, 'filename is too long');
  const base = raw.split(/[\\/]/).pop().normalize('NFC');
  const name = base.replace(/[^\p{L}\p{Nd} ._()-]/gu, '-').replace(/-{2,}/g, '-').replace(/ {2,}/g, ' ').trim();
  if (!name || name.startsWith('.') || name.startsWith('-')) fail(400, 'the file name must not be empty or start with . or -');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (!ext) fail(400, 'the file name needs an extension, like .pdf or .md');
  if (!EXTENSIONS.has(ext.toLowerCase())) fail(415, `.${ext.toLowerCase().slice(0, 20)} files can't be used for training: save it as PDF or text`);
  return { stem: name.slice(0, dot).trim(), ext };
}

const fitName = (stem, ext, n) => {
  const suffix = n > 1 ? `-${n}` : '';
  return `${stem.slice(0, FILE_NAME_MAX - ext.length - 1 - suffix.length).trim()}${suffix}.${ext}`;
};

function walkFiles(dir, depth = 0) {
  const out = { files: 0, bytes: 0 };
  const entries = (() => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } })();
  for (const e of entries) {
    if (UPLOAD_TMP.test(e.name) && depth === 0) continue;
    const st = lstat(path.join(dir, e.name));
    if (!st || st.isSymbolicLink()) continue;
    if (st.isFile()) { out.files++; out.bytes += st.size; continue; }
    if (st.isDirectory() && depth < 16) { const sub = walkFiles(path.join(dir, e.name), depth + 1); out.files += sub.files; out.bytes += sub.bytes; }
  }
  return out;
}

function quoted(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').map(l => l ? `> ${l}` : '>').join('\n');
}

function feedbackMessage(p, f) {
  const parts = [`Feedback on an answer from ${p.title}${f.runId ? ` (run ${f.runId})` : ''}:`];
  if (f.original) parts.push(`The answer it gave:\n${quoted(f.original)}`);
  if (f.better) parts.push(`A better version:\n${quoted(f.better)}`);
  if (f.note) parts.push(`Note from the owner: ${f.note}`);
  parts.push('Change the profile so future answers come out like the better version. Change only what this feedback is about.');
  return parts.join('\n\n');
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

function createTraining({ store, headless, tmuxHas, claudeGet = () => null, now = Date.now, goneMs = 300, skills = null }) {
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

  const trainerAccount = p => providers.isApi(p.provider) ? 'personal' : p.account;
  const trainerDir = p => path.join(path.dirname(p.dir), TRAINERS_DIR, p.name);

  function plainFolder(dir, label, create) {
    const st = lstat(dir);
    if (!st) {
      if (!create) return null;
      fs.mkdirSync(dir, { mode: 0o700 });
      return dir;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) fail(409, `${label} is not a plain folder`);
    return dir;
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
    if (turns.has(name)) return true;
    const rec = store.getTrainer(name);
    return !!rec && busyLive(await snapshotOf(rec.tmux));
  }

  async function stage(p, only) {
    store.writeAtomic(path.join(p.dir, '.gitignore'), GITIGNORE);
    store.writeAtomic(path.join(plainFolder(path.join(p.dir, '.git', 'info'), '.git/info', true), 'exclude'), EXCLUDE);
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

  async function commitIn(p, source, subject, { undoOf = null, only = null } = {}) {
    checkTrainable(p.dir);
    if (!isRepo(p.dir)) return { sha: null, held: [] };
    await stage(p, only);
    const held = await holdImports(p, source === 'trainer', only);
    await holdSecrets(p, only);
    const scope = only ? ['--', ...only] : [];
    const diff = await git(p.dir, ['diff', '--cached', '--quiet', ...scope]);
    if (diff.code === 0) return { sha: null, held };
    if (diff.code !== 1) throw gitFail('diff', diff);
    const paths = typeof subject === 'function' ? await staged(p.dir, only, null) : null;
    const message = oneLine(typeof subject === 'function' ? subject(paths) : subject, 200) || 'Training';
    await gitOk(p.dir, ['commit', '-q', '--no-verify', '-m', message, '-m', `Bd-Source: ${source}${undoOf ? `\nBd-Undo: ${undoOf}` : ''}`, ...scope]);
    touch(p.name);
    return { sha: (await gitOk(p.dir, ['rev-parse', 'HEAD'])).out.toString('utf8').trim(), held };
  }

  const commitOutside = p => commitIn(p, 'outside', OUTSIDE);

  async function commitObject(dir, sha) {
    if (!sha) return null;
    const c = (await readLog(dir)).find(x => x.id === sha);
    return c ? commitOut(c) : null;
  }

  function contextText(p) {
    const list = (() => { try { return accesses.list(p.dir); } catch { return null; } })();
    const api = providers.isApi(p.provider);
    const lines = [
      '# The specialist you train', '',
      `- Name: ${p.name}`, `- Title: ${p.title}`, `- Description: ${p.description || '(none)'}`, `- Provider: ${p.provider}`,
      `- Model: ${p.model || 'default'}`, `- Mode: ${p.mode}`, `- Use: ${p.use}`, `- Profile folder: ${p.dir}`, '',
      '## Accesses', '',
      api ? `A ${p.provider} specialist gets no accesses: it only sees CLAUDE.md and its imports.` : 'Its runs get these as environment variables. You never see the values: refer to them by name.',
      '',
      ...(list === null ? ['The accesses could not be read.'] : list.length ? list.map(a => `- ${a.name}${a.note ? `: ${a.note}` : ''}`) : ['None yet.']),
    ];
    return lines.join('\n') + '\n';
  }

  function rulePath(abs) {
    if (!SAFE_PATH.test(abs)) fail(409, `the folder ${abs} has characters the trainer's permission rules can't express`);
    return '/' + abs;
  }

  function settingsText(p, dir) {
    const P = rulePath(p.dir), T = rulePath(dir);
    const read = ['Read', 'Glob', 'Grep'].flatMap(t => [`${t}(${P}/**)`, `${t}(${T}/**)`]);
    const write = ['Edit', 'Write'].flatMap(t => [`${t}(${P}/CLAUDE.md)`, `${t}(${P}/style.md)`, `${t}(${P}/knowledge/**)`, `${t}(${P}/examples/**)`]);
    const secrets = ['Read', 'Edit', 'Write', 'Glob', 'Grep'].flatMap(t => [`${t}(${P}/.secrets)`, `${t}(${P}/.secrets/**)`]);
    const locked = ['Edit', 'Write'].flatMap(t => [`${t}(${P}/specialist.json)`, `${t}(${P}/.claude/**)`, `${t}(${P}/.mcp.json)`, `${t}(${P}/.bd/**)`, `${t}(${P}/.git/**)`, `${t}(${P}/.gitignore)`, `${t}(${T}/**)`]);
    return JSON.stringify({ permissions: { allow: [...read, ...write], deny: [...secrets, ...locked], defaultMode: 'dontAsk', disableBypassPermissionsMode: 'disable' } }, null, 2) + '\n';
  }

  function trainerFiles(p, dir) {
    return { 'CLAUDE.md': TRAINER_INSTRUCTIONS, [CONTEXT_FILE]: contextText(p), [SETTINGS_FILE]: settingsText(p, dir) };
  }

  function trainerFolder(p, create) {
    const base = plainFolder(path.join(path.dirname(p.dir), TRAINERS_DIR), TRAINERS_DIR, create);
    return base && plainFolder(trainerDir(p), `${TRAINERS_DIR}/${p.name}`, create);
  }

  function writeTrainerFiles(p, dir) {
    const files = trainerFiles(p, dir);
    const fixed = [];
    for (const [f, text] of Object.entries(files)) {
      const abs = path.join(dir, f), st = lstat(abs);
      const same = st && st.isFile() && !st.isSymbolicLink() && (() => { try { return fs.readFileSync(abs, 'utf8') === text; } catch { return false; } })();
      if (same) continue;
      if (st && st.isDirectory() && !st.isSymbolicLink()) fs.rmSync(abs, { recursive: true, force: true });
      store.writeAtomic(abs, text);
      fixed.push(f);
    }
    return fixed;
  }

  function refreshContext(name) {
    try {
      const p = store.get(name);
      const dir = trainerFolder(p, false);
      if (dir && lstat(path.join(dir, CONTEXT_FILE))) store.writeAtomic(path.join(dir, CONTEXT_FILE), contextText(p));
    } catch {}
  }

  function feedbackPath(dir) { return path.join(dir, store.DASH_DIR, 'feedback.jsonl'); }

  function validFeedback(f) {
    return !!f && typeof f === 'object' && typeof f.id === 'string' && FEEDBACK_ID.test(f.id) && FEEDBACK_STATES.includes(f.state) && Number.isFinite(f.createdAt);
  }

  function readFeedback(dir) {
    if (!store.dashDir(dir, false)) return [];
    const text = store.readFileIn(path.join(dir, store.DASH_DIR), 'feedback.jsonl', FEEDBACK_FILE_MAX);
    if (text === null) return [];
    return text.split('\n').map(l => { try { return l.trim() ? JSON.parse(l) : null; } catch { return null; } }).filter(validFeedback);
  }

  function writeFeedback(dir, list) {
    const rows = list.map(f => ({ f, line: JSON.stringify(f) + '\n', open: f.state === 'pending' || f.state === 'sent' }));
    const room = { n: FEEDBACK_KEEP, bytes: FEEDBACK_FILE_MAX - rows.filter(r => r.open).reduce((n, r) => n + Buffer.byteLength(r.line), 0) };
    const kept = new Set();
    const stamp = f => Math.max(f.createdAt || 0, f.sentAt || 0, f.appliedAt || 0);
    for (const r of rows.filter(x => !x.open).sort((a, b) => stamp(b.f) - stamp(a.f))) {
      const bytes = Buffer.byteLength(r.line);
      if (room.n < 1 || bytes > room.bytes) break;
      kept.add(r);
      room.n--;
      room.bytes -= bytes;
    }
    store.dashDir(dir, true);
    store.writeAtomic(feedbackPath(dir), rows.filter(r => r.open || kept.has(r)).map(r => r.line).join(''));
  }

  function patchFeedback(dir, id, patch) {
    const list = readFeedback(dir);
    const next = list.map(f => f.id === id ? { ...f, ...patch } : f);
    writeFeedback(dir, next);
    return next.find(f => f.id === id) || null;
  }

  async function snapshotOf(tmux) {
    return (await tmuxHas(tmux)) ? headless.status(tmux) : null;
  }

  function stateOf(name, snap) {
    if (snap && snap.pending && snap.pending.length) return 'waiting';
    if (turns.has(name) || (snap && (snap.state === 'working' || snap.turn))) return 'working';
    return snap ? 'idle' : null;
  }

  async function trainerObject(p) {
    const rec = store.getTrainer(p.name);
    if (!rec) return null;
    const live = await tmuxHas(rec.tmux);
    const snap = live ? await headless.status(rec.tmux) : null;
    return { ...rec, live, state: live ? stateOf(p.name, snap) || (turns.has(p.name) ? 'working' : null) : null };
  }

  async function summary(p) {
    if (p.error) return null;
    const rec = (() => { try { return store.getTrainer(p.name); } catch { return null; } })();
    const pendingFeedback = (() => { try { return readFeedback(p.dir).filter(f => f.state === 'pending').length; } catch { return 0; } })();
    if (!rec && !pendingFeedback) return null;
    const live = !!rec && (await tmuxHas(rec.tmux));
    const snap = live ? await headless.status(rec.tmux) : null;
    return { live, state: live ? stateOf(p.name, snap) : null, pendingFeedback };
  }

  function follow(name, tmux, sessionId) {
    if (!UUID.test(sessionId || '')) return;
    try {
      const rec = store.getTrainer(name);
      if (!rec || rec.tmux !== tmux || rec.sessionId === sessionId) return;
      const transcriptPath = rec.transcriptPath ? path.join(path.dirname(rec.transcriptPath), sessionId + '.jsonl') : null;
      store.setTrainer(name, { ...rec, sessionId, transcriptPath });
    } catch {}
  }

  function unwatch(tmux) {
    const w = watched.get(tmux);
    if (!w) return;
    watched.delete(tmux);
    w.unsub();
  }

  function onEvent(tmux, w, o) {
    if (watched.get(tmux) !== w) return;
    if (o.ev === 'snapshot') { follow(w.name, tmux, o.sessionId); return; }
    if (o.ev === 'result') { serial(w.name, () => finishTurn(w.name, tmux, o)).catch(() => {}); return; }
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
        await serial(name, () => finishTurn(name, tmux, { subtype: 'gone' })).catch(() => {});
        return;
      }
    }
  }

  async function deliver(tmux, text) {
    const up = await headless.waitForRunner(tmux);
    if (!up.up && !up.starting) return { ok: false, error: 'the trainer did not start' };
    const first = await headless.send(tmux, text, MESSAGE_MAX);
    if (first.ok || !/not reachable/.test(first.error || '')) return first;
    await delay(1000);
    return headless.send(tmux, text, MESSAGE_MAX);
  }

  function instructionsBytes(dir) {
    const st = lstat(path.join(dir, store.INSTRUCTIONS_FILE));
    return st && st.isFile() ? st.size : 0;
  }

  async function finishTurn(name, tmux, o) {
    const turn = turns.get(name);
    if (turn && turn.tmux !== tmux) return;
    const p = (() => { try { return store.get(name); } catch { return null; } })();
    if (!p) { turns.delete(name); return; }
    const rec = (() => { try { return store.getTrainer(name); } catch { return null; } })();
    const gone = o.subtype === 'gone', restarted = o.subtype === 'restarted';
    if (!turn && (gone || !rec || rec.tmux !== tmux)) return;
    if (turn && !gone && !restarted && !turn.followedUp && instructionsBytes(p.dir) > INSTRUCTIONS_MAX) {
      turn.followedUp = true;
      const s = await deliver(tmux, `CLAUDE.md is ${Math.ceil(instructionsBytes(p.dir) / 1024)} KiB, the limit is 256 KiB: move details into knowledge/`).catch(e => ({ ok: false, error: e.message }));
      if (s.ok) return;
    }
    const errors = [], saved = { sha: null };
    try {
      const broken = turn ? restoreGuard(p.dir, turn.guard) : [];
      const text = gone || restarted ? null : typeof o.text === 'string' && o.text.trim() ? o.text : transcriptText(rec && rec.transcriptPath);
      const held = await (async () => {
        try {
          const r = await commitIn(p, 'trainer', paths => summaryLine(text) || `Training: ${paths.slice(0, 8).join(', ')}${paths.length > 8 ? ` and ${paths.length - 8} more` : ''}`);
          saved.sha = r.sha;
          return r.held;
        } catch (e) { errors.push(`the changes were not saved in the history: ${e.message}`); return []; }
      })();
      const dir = (() => { try { return trainerFolder(p, false); } catch { return null; } })();
      const fixed = dir ? writeTrainerFiles(p, dir).map(f => `${TRAINERS_DIR}/${p.name}/${f}`) : [];
      if (broken.length || fixed.length) errors.push(`the trainer changed files it may not change, and they were put back: ${[...broken, ...fixed].slice(0, 8).join(', ')}`);
      if (held.length) errors.push(`the trainer imported from .secrets, .bd or .git, and those files were put back: ${held.slice(0, 8).join(', ')}`);
    } catch (e) {
      errors.push(`the turn could not be finished: ${e.message}`);
    } finally {
      if (turns.get(name) === turn) turns.delete(name);
      if (turn) dropGuard(p.dir);
    }
    if (turn && turn.feedbackId) {
      const f = gone ? { state: 'error', error: 'the trainer went away' } : restarted ? { state: 'error', error: 'the turn was restarted' } : finalOf(o);
      const ok = f.state === 'done' && !errors.length;
      const error = ok ? null : [f.state === 'stopped' ? 'the turn was stopped' : f.error, ...errors].filter(Boolean).join('; ') || 'the turn failed';
      try { patchFeedback(p.dir, turn.feedbackId, { state: ok ? 'applied' : 'failed', appliedAt: ok ? now() : null, commit: saved.sha, error: error && error.slice(0, 2000) }); } catch {}
    }
    await pump(name);
  }

  async function startTrainer(p, fresh) {
    const account = trainerAccount(p);
    const tmux = store.trainerName(p.name, account);
    const rec = store.getTrainer(p.name);
    const same = !!rec && rec.tmux === tmux;
    const isLive = await tmuxHas(tmux);
    if (isLive) {
      const c = claudeGet(tmux);
      if (!c || c.specialist !== p.name || !c.runner || c.runner.trainer !== true) fail(409, `the session ${tmux} is not this specialist's trainer`);
      if (busyLive(await headless.status(tmux))) fail(409, 'trainer is busy');
      if (same && !fresh) { watch(p.name, tmux); return tmux; }
    }
    const dir = trainerFolder(p, true);
    writeTrainerFiles(p, dir);
    const found = !fresh && same && rec.sessionId ? headless.locateTranscript(dir, account, rec.sessionId) : null;
    const runner = { trainer: true, settings: path.join(dir, SETTINGS_FILE), addDirs: [p.dir] };
    const base = { specialist: p.name, runner, replace: isLive, firstPrompt: `Train ${p.title}` };
    const r = await headless.launch(tmux, dir, account, found ? { ...base, start: 'resume', sessionId: rec.sessionId, transcriptPath: found.file } : { ...base, start: 'new' });
    if (!r.ok || r.existed) fail(500, r.ok ? `the session ${tmux} already exists` : `the trainer could not start: ${r.error || 'tmux failed'}`);
    store.setTrainer(p.name, { account, sessionId: r.sessionId, transcriptPath: r.transcriptPath || null, startedAt: found ? rec.startedAt : now(), turns: found ? rec.turns : 0, lastTurnAt: found ? rec.lastTurnAt : null });
    watch(p.name, tmux);
    return tmux;
  }

  async function beginTurn(p, tmux, message, feedbackId) {
    const guard = takeGuard(p.dir);
    saveGuard(p.dir, guard);
    turns.set(p.name, { tmux, feedbackId, guard, followedUp: false });
    const s = await deliver(tmux, message).catch(e => ({ ok: false, error: e.message }));
    if (!s.ok) {
      turns.delete(p.name);
      dropGuard(p.dir);
      fail(500, `the message did not reach the trainer: ${s.error || 'send failed'}`);
    }
    const rec = store.getTrainer(p.name);
    if (rec) store.setTrainer(p.name, { ...rec, turns: rec.turns + 1, lastTurnAt: now() });
  }

  async function pump(name) {
    if (turns.has(name)) return;
    const p = (() => { try { return profile(name); } catch { return null; } })();
    if (!p) return;
    const next = readFeedback(p.dir).find(f => f.state === 'pending');
    if (!next) return;
    try {
      if (await busyNow(name)) return;
      await ensureRepo(p);
      await commitOutside(p);
      const tmux = await startTrainer(p, false);
      patchFeedback(p.dir, next.id, { state: 'sent', sentAt: now(), error: null });
      await beginTurn(p, tmux, feedbackMessage(p, next), next.id);
    } catch (e) {
      if (e instanceof SpecialistError && e.message === 'trainer is busy') return;
      patchFeedback(p.dir, next.id, { state: 'failed', error: oneLine(e.message, 2000) || 'the feedback could not be sent' });
    }
  }

  function checkKeys(b, keys) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'body must be a JSON object');
    const bad = Object.keys(b).filter(k => !keys.includes(k));
    if (bad.length) fail(400, `unknown field ${bad.map(k => `"${k}"`).join(', ')}`);
  }

  function filesFolder(p, create) {
    const k = plainFolder(path.join(p.dir, 'knowledge'), 'knowledge/', create);
    const f = k && plainFolder(path.join(p.dir, FILES_DIR), `${FILES_DIR}/`, create);
    if (!f) return null;
    const rf = real(f), rp = real(p.dir);
    if (!rf || !rp || !rf.startsWith(rp + path.sep)) fail(409, `${FILES_DIR}/ is outside the profile`);
    return f;
  }

  function checkFiles(p, files) {
    if (files === undefined) return [];
    if (!Array.isArray(files) || files.length > SEND_FILES) fail(400, `files must be a list of at most ${SEND_FILES} paths`);
    const dir = files.length ? filesFolder(p, false) : null;
    return [...new Set(files.map(f => {
      const bad = () => fail(400, `not a file in ${FILES_DIR}/: ${typeof f === 'string' ? oneLine(f, 200) : typeof f}`);
      if (typeof f !== 'string' || f.length > 1000 || /[\x00-\x1f\x7f\\]/.test(f) || !f.startsWith(FILES_DIR + '/') || path.posix.normalize(f) !== f || f.split('/').some(s => !s || s === '.' || s === '..')) bad();
      const abs = path.join(p.dir, f), st = lstat(abs), parent = real(path.dirname(abs));
      if (!dir || !st || !st.isFile() || !parent || (parent !== real(dir) && !parent.startsWith(real(dir) + path.sep))) bad();
      return f;
    }))];
  }

  async function send(name, body) {
    checkKeys(body, ['text', 'files', 'fresh']);
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > SEND_MAX) fail(400, `text must be 1-${SEND_MAX} characters`);
    if (body.fresh !== undefined && typeof body.fresh !== 'boolean') fail(400, 'fresh must be true or false');
    return serial(name, async () => {
      const p = profile(name);
      const files = checkFiles(p, body.files);
      if (await busyNow(name)) fail(409, 'trainer is busy');
      await ensureRepo(p);
      await commitOutside(p);
      const tmux = await startTrainer(p, body.fresh === true);
      await beginTurn(p, tmux, files.length ? `${body.text}\n\nFiles the owner added:\n${files.map(f => '- ' + f).join('\n')}` : body.text, null);
      return { trainer: await trainerObject(p) };
    });
  }

  async function chatSend(tmux, text) {
    const name = store.trainerOfTmux(tmux);
    try {
      const p = store.get(name);
      const rec = store.getTrainer(name);
      if (!rec || rec.tmux !== tmux || store.trainerName(name, trainerAccount(p)) !== tmux) return { ok: false, error: "this is not the specialist's current trainer: send from its Train tab" };
      await send(name, { text });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function overview(name) {
    const p = profile(name);
    const log = await readLog(p.dir);
    const folder = filesFolder(p, false);
    const used = folder ? walkFiles(folder) : { files: 0, bytes: 0 };
    return {
      trainer: await trainerObject(p),
      history: { ready: isRepo(p.dir), head: log.length ? log[0].id : null, commits: log.slice(0, 20).map(commitOut) },
      feedback: readFeedback(p.dir).reverse().slice(0, 20),
      accesses: accesses.list(p.dir),
      uploads: { ...used, maxFiles: UPLOAD_FILES, maxBytes: UPLOAD_BYTES },
    };
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
    if (r.code !== 0) throw gitFail('show', r);
    return { commit: commitOut(c), diff: r.out.toString('utf8').replace(/^\n+/, ''), truncated: r.truncated };
  }

  async function undo(name, body) {
    checkKeys(body, ['commit']);
    if (typeof body.commit !== 'string' || !SHA.test(body.commit)) fail(400, 'commit must be a sha of 7-40 hex characters');
    return serial(name, async () => {
      const p = profile(name);
      if (await busyNow(name)) fail(409, 'trainer is busy');
      await ensureRepo(p);
      await commitOutside(p);
      const c = findCommit(await readLog(p.dir), body.commit);
      if (!c) fail(404, `no commit ${body.commit} in this profile's history`);
      if (c.source === 'start' || c.root) fail(400, "the starting point can't be undone");
      if (c.merge) fail(400, "a merge can't be undone here");
      const r = await git(p.dir, ['revert', '--no-commit', '--no-edit', c.id]);
      const abort = async () => { const a = await git(p.dir, ['revert', '--abort']); if (a.code !== 0) await git(p.dir, ['reset', '-q', '--hard', 'HEAD']); };
      if (r.code !== 0) { await abort(); fail(409, 'later changes touch the same lines; undo those first'); }
      const { sha } = await (async () => { try { return await commitIn(p, 'undo', `Undo: ${c.message}`, { undoOf: c.id }); } catch (e) { await abort(); throw e; } })();
      if (!sha) { await abort(); fail(409, 'that change is already undone'); }
      return { commit: await commitObject(p.dir, sha) };
    });
  }

  function receive(req, file) {
    return new Promise((resolve, reject) => {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      const out = fs.createWriteStream(file, { fd });
      const st = { bytes: 0, over: false };
      const stop = err => {
        if (st.over) return;
        st.over = true;
        req.removeListener('data', onData);
        req.resume();
        out.destroy();
        reject(err);
      };
      const onData = chunk => {
        st.bytes += chunk.length;
        if (st.bytes > UPLOAD_MAX) return stop(new SpecialistError(413, 'a file can be at most 20 MiB'));
        if (!out.write(chunk)) req.pause();
      };
      out.on('drain', () => { if (!st.over) req.resume(); });
      out.on('error', e => stop(e));
      out.on('finish', () => { if (!st.over) resolve(st.bytes); });
      req.on('data', onData);
      req.on('end', () => { if (!st.over) out.end(); });
      req.on('close', () => { if (!req.complete) stop(new SpecialistError(400, 'the upload was interrupted')); });
      req.on('error', () => stop(new SpecialistError(400, 'the upload was interrupted')));
    });
  }

  async function upload(name, req, url, res) {
    const closeAfter = () => { if (!req.complete && !res.headersSent) res.setHeader('connection', 'close'); };
    try {
      const { stem, ext } = cleanName(url.searchParams.get('filename'));
      if (+(req.headers['content-length'] || 0) > UPLOAD_MAX) fail(413, 'a file can be at most 20 MiB');
      const dir = await serial(name, async () => {
        const p = profile(name);
        await ensureRepo(p);
        if (!(await busyNow(name))) await commitOutside(p);
        const f = filesFolder(p, true);
        const used = walkFiles(f);
        if (used.files >= UPLOAD_FILES) fail(413, `${FILES_DIR}/ already holds ${UPLOAD_FILES} files`);
        if (used.bytes >= UPLOAD_BYTES) fail(413, `${FILES_DIR}/ already holds 200 MiB`);
        return f;
      });
      const tmp = path.join(dir, `.upload-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
      try {
        const bytes = await receive(req, tmp);
        const shut = providers.shutImport(fs.readFileSync(tmp, 'utf8'));
        if (shut) fail(400, `the file imports from .secrets, .bd or .git: ${oneLine(shut, 200)}`);
        return await serial(name, async () => {
          const p = profile(name);
          const f = filesFolder(p, false);
          if (f !== dir) fail(409, `${FILES_DIR}/ changed during the upload`);
          const used = walkFiles(f);
          if (used.files + 1 > UPLOAD_FILES) fail(413, `${FILES_DIR}/ can hold at most ${UPLOAD_FILES} files`);
          if (used.bytes + bytes > UPLOAD_BYTES) fail(413, `${FILES_DIR}/ can hold at most 200 MiB`);
          const file = (() => {
            for (let n = 1; n < 1000; n++) {
              const candidate = fitName(stem, ext, n);
              try { fs.linkSync(tmp, path.join(f, candidate)); return candidate; } catch (e) { if (e.code !== 'EEXIST') throw e; }
            }
            return fail(409, 'no free file name');
          })();
          const { sha } = await commitIn(p, 'upload', `Added ${file}`, { only: [`${FILES_DIR}/${file}`] });
          return { file: { path: `${FILES_DIR}/${file}`, bytes }, commit: await commitObject(p.dir, sha) };
        });
      } finally { fs.rmSync(tmp, { force: true }); }
    } catch (e) { closeAfter(); throw e; }
  }

  function textField(v, key, max) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') fail(400, `${key} must be a string or null`);
    if (v.length > max) fail(413, `${key} is longer than ${max} characters`);
    return v.trim() ? v : null;
  }

  async function addFeedback(name, body) {
    checkKeys(body, ['runId', 'original', 'better', 'note']);
    const runId = body.runId === undefined || body.runId === null ? null : body.runId;
    if (runId !== null) {
      const id = typeof runId === 'string' ? store.parseRunId(runId) : null;
      if (!id || id.name !== name) fail(400, 'runId must be a run of this specialist');
    }
    const original = textField(body.original, 'original', ANSWER_MAX), better = textField(body.better, 'better', ANSWER_MAX), note = textField(body.note, 'note', NOTE_MAX);
    if (!better && !note) fail(400, 'better or note is required');
    return serial(name, async () => {
      const p = profile(name);
      const run = runId ? store.getRun(runId) : null;
      if (runId && !run) fail(404, `no run "${runId}"`);
      const list = readFeedback(p.dir);
      if (list.filter(f => f.state === 'pending').length >= PENDING_MAX) fail(429, `${PENDING_MAX} feedback records are already waiting for the trainer`);
      const at = now();
      const f = { id: `fb-${at.toString(36)}-${crypto.randomBytes(2).toString('hex')}`, runId, original: original || (run && run.text ? run.text.slice(0, ANSWER_MAX) : null), better, note, state: 'pending', createdAt: at, sentAt: null, appliedAt: null, commit: null, error: null };
      await ensureRepo(p);
      writeFeedback(p.dir, [...list, f]);
      await pump(name);
      return { feedback: readFeedback(p.dir).find(x => x.id === f.id) || f, trainer: await trainerObject(p) };
    });
  }

  async function retry(name, id) {
    if (typeof id !== 'string' || !FEEDBACK_ID.test(id)) fail(404, `no feedback ${oneLine(id, 40)}`);
    return serial(name, async () => {
      const p = profile(name);
      const list = readFeedback(p.dir);
      const f = list.find(x => x.id === id);
      if (!f) fail(404, `no feedback ${id}`);
      if (f.state !== 'failed') fail(409, 'only failed feedback can be sent again');
      if (list.filter(x => x.state === 'pending').length >= PENDING_MAX) fail(429, `${PENDING_MAX} feedback records are already waiting for the trainer`);
      patchFeedback(p.dir, id, { state: 'pending', sentAt: null, appliedAt: null, commit: null, error: null });
      await pump(name);
      return { feedback: readFeedback(p.dir).find(x => x.id === id) };
    });
  }

  function feedback(name, { limit = 50, ids = null } = {}) {
    const p = profile(name);
    const list = readFeedback(p.dir).reverse();
    if (ids === null) return { feedback: list.slice(0, limit) };
    const want = ids.split(',').map(s => s.trim()).filter(Boolean);
    if (want.length > 50) fail(400, 'ids can name at most 50 records');
    return { feedback: list.filter(f => want.includes(f.id)) };
  }

  async function update(name, patch) {
    return serial(name, async () => {
      const dir = store.profileDir(name);
      const instructions = !!patch && typeof patch === 'object' && !Array.isArray(patch) && patch.instructions !== undefined;
      if (instructions && (await busyNow(name))) fail(409, 'trainer is busy');
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
      refreshContext(name);
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
      refreshContext(name);
      return { access };
    });
  }

  async function removeAccess(name, key) {
    return serial(name, async () => {
      const removed = accesses.remove(store.get(name).dir, key);
      refreshContext(name);
      return { name: removed };
    });
  }

  async function recover(p) {
    const rec = store.getTrainer(p.name);
    const live = !!rec && (await tmuxHas(rec.tmux));
    const snap = live ? await headless.status(rec.tmux) : null;
    const saved = loadGuard(p.dir);
    if (live) watch(p.name, rec.tmux);
    if (snap && (snap.state === 'working' || snap.turn)) {
      const sent = readFeedback(p.dir).filter(f => f.state === 'sent');
      const guard = saved || takeGuard(p.dir);
      if (!saved) saveGuard(p.dir, guard);
      turns.set(p.name, { tmux: rec.tmux, feedbackId: sent.length ? sent[sent.length - 1].id : null, guard, followedUp: false });
      return;
    }
    if (saved) { restoreGuard(p.dir, saved); dropGuard(p.dir); }
    if (isRepo(p.dir)) { try { await commitOutside(p); } catch {} }
    if (!rec) return;
    const sent = readFeedback(p.dir).filter(f => f.state === 'sent');
    if (!live) {
      for (const f of sent) patchFeedback(p.dir, f.id, { state: 'failed', error: 'the trainer went away' });
      return;
    }
    for (const f of sent) patchFeedback(p.dir, f.id, { state: 'failed', error: 'the turn ended while the dashboard was not running' });
    await pump(p.name);
  }

  async function boot() {
    for (const p of store.list()) {
      if (p.error) continue;
      await serial(p.name, () => recover(p)).catch(() => {});
    }
  }

  return { overview, send, chatSend, history, commit, undo, upload, addFeedback, retry, feedback, update, accessList, setAccess, removeAccess, summary, boot, serial };
}

module.exports = { createTraining, cleanName, summaryLine, feedbackMessage };
