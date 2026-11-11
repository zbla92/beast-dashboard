'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const STAMP_SEGMENT = /(^|-)\d{6}-\d{4}(-|$)/;
const RESERVED_NAMES = new Set(['run']);
const PROVIDERS = ['claude'];
const LATER_PROVIDERS = ['api', 'codex', 'grok'];
const MODEL = /^(opus|sonnet|haiku|fable)(\[1m\])?$|^claude-[a-z0-9][a-z0-9.-]{0,62}(\[1m\])?$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ACCOUNTS = ['personal', 'company'];
const MODES = ['run', 'thread'];
const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'auto', 'manual', 'dontAsk', 'plan'];
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const CONTROL = /[\x00-\x1f\x7f]/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TMUX = /^[A-Za-z0-9_.-]+$/;
const RUN_ID = /^claude-spec-([a-z0-9][a-z0-9-]{0,31}?)(?:-(\d{6}-\d{4})(?:-([2-9]|[1-9]\d))?)?(-company)?(?:_([1-9]\d{0,8}))?$/;
const RUN_STATES = ['starting', 'working', 'waiting', 'done', 'error', 'stopped'];
const FINAL_STATES = ['done', 'error', 'stopped'];

const LIMITS = { title: 60, description: 300, icon: 16, instructionsBytes: 256 * 1024, metaBytes: 64 * 1024, task: 100000, text: 200 * 1024, error: 2000, clip: 200, runFileBytes: 1024 * 1024 };
const META_FILE = 'specialist.json';
const INSTRUCTIONS_FILE = 'CLAUDE.md';
const DASH_DIR = '.bd';
const ARCHIVE_DIR = '_archive';
const EDITABLE = ['title', 'description', 'icon', 'color', 'provider', 'model', 'effort', 'account', 'mode', 'permissionMode'];
const META_KEYS = ['name', ...EDITABLE, 'createdAt', 'updatedAt'];

class SpecialistError extends Error {
  constructor(status, message) { super(message); this.name = 'SpecialistError'; this.status = status; }
}
const fail = (status, message) => { throw new SpecialistError(status, message); };

function root(env = process.env) {
  return env.BD_SPECIALISTS_DIR ? path.resolve(env.BD_SPECIALISTS_DIR) : path.join(env.HOME || os.homedir(), '.beast', 'specialists');
}

function nameError(name) {
  if (typeof name !== 'string' || !NAME.test(name)) return 'name must be 1-32 characters: lowercase letters, digits and -, starting with a letter or digit';
  if (name.endsWith('-')) return 'name must not end with -';
  if (name.endsWith('-company')) return 'name must not end with -company';
  if (STAMP_SEGMENT.test(name)) return 'name must not contain a date stamp like 251111-0930';
  if (RESERVED_NAMES.has(name)) return `"${name}" is reserved`;
  return null;
}
const isName = name => nameError(name) === null;

function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function real(p) { try { return fs.realpathSync(p); } catch { return null; } }

function realRoot(create) {
  const r = root();
  if (create) fs.mkdirSync(r, { recursive: true, mode: 0o700 });
  return real(r);
}

function plainDir(dir, label) {
  const st = lstat(dir);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isDirectory()) fail(409, `${label} is not a plain folder`);
  return dir;
}

function profileDir(name) {
  const err = nameError(name);
  if (err) fail(400, err);
  const base = realRoot(false);
  const dir = base && plainDir(path.join(base, name), `specialist "${name}"`);
  if (!dir || !lstat(path.join(dir, META_FILE))) fail(404, `no specialist "${name}"`);
  return dir;
}

function readFileIn(dir, file, max) {
  const p = path.join(dir, file);
  const st = lstat(p);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile()) fail(409, `${file} is not a plain file`);
  if (st.size > max) fail(413, `${file} is larger than ${max} bytes`);
  return fs.readFileSync(p, 'utf8');
}

function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function oneLine(value, key, min, max) {
  if (typeof value !== 'string') fail(400, `${key} must be a string`);
  const v = value.trim();
  if (CONTROL.test(v)) fail(400, `${key} must be one line without control characters`);
  if (v.length < min || v.length > max) fail(400, min ? `${key} must be ${min}-${max} characters` : `${key} must be at most ${max} characters`);
  return v;
}
const oneOf = (value, key, list) => list.includes(value) ? value : fail(400, `${key} must be one of ${list.join(', ')}`);

const CHECK = {
  title: v => oneLine(v, 'title', 1, LIMITS.title),
  description: v => oneLine(v, 'description', 0, LIMITS.description),
  icon: v => oneLine(v, 'icon', 1, LIMITS.icon),
  color: v => v === null ? null : typeof v === 'string' && COLOR.test(v) ? v.toLowerCase() : fail(400, 'color must be null, #rgb or #rrggbb'),
  provider: v => LATER_PROVIDERS.includes(v) ? fail(400, `provider "${v}" is not available yet`) : oneOf(v, 'provider', PROVIDERS),
  model: v => v === null || v === 'default' ? null : typeof v === 'string' && MODEL.test(v) ? v : fail(400, 'model must be null, default, opus, sonnet, haiku, fable (optionally with [1m]) or a claude-… model id'),
  effort: v => v === null ? null : oneOf(v, 'effort', EFFORTS),
  account: v => oneOf(v, 'account', ACCOUNTS),
  mode: v => oneOf(v, 'mode', MODES),
  permissionMode: v => oneOf(v, 'permissionMode', PERMISSION_MODES),
};

function defaults(name) {
  return { title: name, description: '', icon: '◆', color: null, provider: 'claude', model: null, effort: null, account: 'personal', mode: 'run', permissionMode: 'bypassPermissions' };
}

function normalize(raw, name) {
  const meta = { name, ...defaults(name) };
  for (const key of EDITABLE) if (raw[key] !== undefined) meta[key] = CHECK[key](raw[key]);
  meta.createdAt = typeof raw.createdAt === 'string' && ISO.test(raw.createdAt) ? raw.createdAt : null;
  meta.updatedAt = typeof raw.updatedAt === 'string' && ISO.test(raw.updatedAt) ? raw.updatedAt : null;
  return meta;
}

function extraKeys(raw) {
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !META_KEYS.includes(k)));
}

function serialize(meta, extra) {
  return JSON.stringify({ ...extra, ...Object.fromEntries(META_KEYS.map(k => [k, meta[k]])) }, null, 2) + '\n';
}

function readRaw(dir) {
  const text = readFileIn(dir, META_FILE, LIMITS.metaBytes);
  if (text === null) fail(404, `${META_FILE} is missing`);
  const raw = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(409, `${META_FILE} is not a JSON object`);
  return raw;
}

function readMeta(dir, name) {
  const raw = readRaw(dir);
  try { return normalize(raw, name); } catch (e) {
    if (e instanceof SpecialistError) fail(409, `${META_FILE} is invalid: ${e.message}`);
    throw e;
  }
}

function listNames(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort(); } catch { return []; }
}

function filesOf(dir) {
  const isFile = f => { const st = lstat(path.join(dir, f)); return !!st && st.isFile(); };
  const skills = listNames(path.join(dir, '.claude', 'skills'));
  const agents = (() => { try { return fs.readdirSync(path.join(dir, '.claude', 'agents')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort(); } catch { return []; } })();
  return { instructions: isFile(INSTRUCTIONS_FILE), settings: isFile(path.join('.claude', 'settings.json')), mcp: isFile('.mcp.json'), skills, agents };
}

function get(name) {
  const dir = profileDir(name);
  return { ...readMeta(dir, name), dir, files: filesOf(dir) };
}

function list() {
  const base = realRoot(false);
  if (!base) return [];
  const out = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isName(entry.name) || !lstat(path.join(base, entry.name, META_FILE))) continue;
    try { out.push(get(entry.name)); } catch (e) {
      if (!(e instanceof SpecialistError)) throw e;
      out.push({ name: entry.name, dir: path.join(base, entry.name), error: e.message });
    }
  }
  return out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function checkInstructions(text) {
  if (typeof text !== 'string') fail(400, 'instructions must be a string');
  if (Buffer.byteLength(text, 'utf8') > LIMITS.instructionsBytes) fail(413, `instructions are larger than ${LIMITS.instructionsBytes} bytes`);
  return text;
}

function checkKeys(obj, allowed, what) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(400, `${what} must be a JSON object`);
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue;
    fail(400, META_KEYS.includes(k) ? `${k} cannot be changed` : `unknown field "${k}"`);
  }
}

const nowIso = () => new Date().toISOString();

const WRITER_INSTRUCTIONS = `# Writer

You draft messages the owner sends under their own name: replies, emails, chat messages, short posts.

## How you work

- The task is the whole brief: who the message is for, what it must say, and the message being answered, if any. Files listed with the task are context: read them.
- Write in the owner's voice, as the style guide below describes and the files in \`examples/\` show. Before drafting, look through \`examples/\` and follow the ones closest to this task (same kind of message, audience and language).
- Write in the language of the message being answered, or the one the task asks for.
- Never ask questions back. If something is missing, make the most reasonable choice and leave a short placeholder in [brackets] where the owner has to fill something in.
- Never invent facts, promises, dates, prices or names that are not in the task, the style guide or the examples.

## What you return

Only the message text, ready to paste: no preface, no explanation, no quotes around it and no alternatives unless the task asks for them. For an email, the first line is \`Subject: …\`.

## Style guide

@style.md

## Examples

\`examples/\` holds messages the owner really sent, one per file, named \`<kind>-<short-topic>.md\`. A file may start with the request and the first draft above a \`---\` line; the text below it is what was sent. Newer and closer matches win over older ones.
`;

const WRITER_STYLE = `# Style guide

How the owner writes. The writer follows this on every draft; keep it short and concrete.

## Voice

- Tone:
- Length:
- Greeting and sign-off:

## Always

## Never

## Per audience
`;

const TEMPLATES = {
  blank: {
    title: 'Blank',
    description: 'An empty profile: you write its instructions.',
    meta: {},
    instructions: meta => `# ${meta.title}\n\n${meta.description || 'What this specialist does, what it gets with a task and what it returns.'}\n`,
    files: {},
    dirs: [],
  },
  writer: {
    title: 'Writer',
    description: "Drafts messages in the owner's voice from a style guide and examples; returns only the message.",
    meta: { icon: '✎', description: "Drafts messages in the owner's voice; returns only the message text.", permissionMode: 'dontAsk' },
    instructions: () => WRITER_INSTRUCTIONS,
    files: { 'style.md': WRITER_STYLE },
    dirs: ['examples'],
  },
};

function templates() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({ id, title: t.title, description: t.description, meta: { ...t.meta } }));
}

function create(input, template = 'blank') {
  checkKeys(input, ['name', 'instructions', ...EDITABLE], 'specialist');
  const err = nameError(input.name);
  if (err) fail(400, err);
  const tpl = Object.hasOwn(TEMPLATES, template) ? TEMPLATES[template] : fail(400, `template must be one of ${Object.keys(TEMPLATES).join(', ')}`);
  const name = input.name;
  const fields = Object.fromEntries(EDITABLE.filter(k => input[k] !== undefined).map(k => [k, input[k]]));
  const at = nowIso();
  const meta = { ...normalize({ ...tpl.meta, ...fields }, name), createdAt: at, updatedAt: at };
  const instructions = checkInstructions(input.instructions !== undefined ? input.instructions : tpl.instructions(meta));
  const base = realRoot(true);
  const dir = path.join(base, name);
  if (lstat(dir)) fail(409, `"${name}" already exists`);
  const stage = fs.mkdtempSync(path.join(base, `.new-${name}-`));
  try {
    for (const d of tpl.dirs) fs.mkdirSync(path.join(stage, d), { recursive: true });
    for (const [file, text] of Object.entries(tpl.files)) { fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true }); writeAtomic(path.join(stage, file), text); }
    writeAtomic(path.join(stage, INSTRUCTIONS_FILE), instructions);
    writeAtomic(path.join(stage, META_FILE), serialize(meta, {}));
    if (lstat(dir)) fail(409, `"${name}" already exists`);
    fs.renameSync(stage, dir);
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') fail(409, `"${name}" already exists`);
    throw e;
  }
  return get(name);
}

function update(name, patch) {
  checkKeys(patch, ['instructions', 'ifUpdatedAt', ...EDITABLE], 'patch');
  const dir = profileDir(name);
  const raw = readRaw(dir);
  if (patch.ifUpdatedAt !== undefined && patch.ifUpdatedAt !== raw.updatedAt) fail(409, 'the profile changed since it was loaded; reload it');
  const fields = Object.fromEntries(EDITABLE.filter(k => patch[k] !== undefined).map(k => [k, patch[k]]));
  for (const [k, v] of Object.entries(fields)) CHECK[k](v);
  const meta = (() => {
    try { return normalize({ ...raw, ...fields }, name); } catch (e) {
      if (e instanceof SpecialistError) fail(409, `${META_FILE} is invalid: ${e.message}`);
      throw e;
    }
  })();
  if (patch.instructions !== undefined) {
    const text = checkInstructions(patch.instructions);
    const st = lstat(path.join(dir, INSTRUCTIONS_FILE));
    if (st && (st.isSymbolicLink() || !st.isFile())) fail(409, `${INSTRUCTIONS_FILE} is not a plain file`);
    writeAtomic(path.join(dir, INSTRUCTIONS_FILE), text);
  }
  writeAtomic(path.join(dir, META_FILE), serialize({ ...meta, createdAt: meta.createdAt || nowIso(), updatedAt: nowIso() }, extraKeys(raw)));
  return get(name);
}

function readInstructions(name) {
  const text = readFileIn(profileDir(name), INSTRUCTIONS_FILE, LIMITS.instructionsBytes);
  return text === null ? '' : text;
}

function stampOf(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function archive(name, date = new Date()) {
  const dir = profileDir(name);
  const archiveRoot = path.join(path.dirname(dir), ARCHIVE_DIR);
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  plainDir(archiveRoot, ARCHIVE_DIR);
  const base = `${name}-${stampOf(date)}`;
  const folder = [base, ...Array.from({ length: 98 }, (_, i) => `${base}-${i + 2}`)].find(f => !lstat(path.join(archiveRoot, f)));
  if (!folder) fail(409, 'no free archive folder name');
  fs.renameSync(dir, path.join(archiveRoot, folder));
  return { name, archivedAs: `${ARCHIVE_DIR}/${folder}`, dir: path.join(archiveRoot, folder) };
}

function accountSuffix(account) { return account === 'company' ? '-company' : ''; }

function runName(name, account, date = new Date(), n = 1) {
  const err = nameError(name);
  if (err) fail(400, err);
  if (!Number.isInteger(n) || n < 1 || n > 99) fail(400, 'run number must be 1-99');
  const p = v => String(v).padStart(2, '0');
  const stamp = `${String(date.getFullYear()).slice(2)}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `claude-spec-${name}-${stamp}${n > 1 ? '-' + n : ''}${accountSuffix(account)}`;
}

function threadName(name, account) {
  const err = nameError(name);
  if (err) fail(400, err);
  return `claude-spec-${name}${accountSuffix(account)}`;
}

function threadRunId(name, account, seq) {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999999999) fail(400, 'thread turn must be a positive integer');
  return `${threadName(name, account)}_${seq}`;
}

function parseRunId(runId) {
  const m = typeof runId === 'string' ? RUN_ID.exec(runId) : null;
  if (!m || !isName(m[1]) || !m[2] === !m[5]) return null;
  return { name: m[1], mode: m[2] ? 'run' : 'thread', account: m[4] ? 'company' : 'personal', tmux: m[5] ? runId.slice(0, runId.lastIndexOf('_')) : runId };
}

function specialistOfTmux(tmux) {
  if (typeof tmux !== 'string') return null;
  const run = parseRunId(tmux);
  if (run && run.mode === 'run') return run.name;
  const t = /^claude-spec-([a-z0-9][a-z0-9-]{0,31}?)(-company)?$/.exec(tmux);
  return t && isName(t[1]) ? t[1] : null;
}

function dashDir(dir, create) {
  const d = path.join(dir, DASH_DIR), runs = path.join(d, 'runs');
  for (const [p, label] of [[d, DASH_DIR], [runs, `${DASH_DIR}/runs`]]) {
    if (plainDir(p, label)) continue;
    if (!create) return null;
    fs.mkdirSync(p, { mode: 0o700 });
  }
  return d;
}

const clip = (s, n) => typeof s === 'string' && s.length > n ? s.slice(0, n) : s;
const optString = (v, key, max) => v === null || v === undefined ? null : typeof v === 'string' ? clip(v, max) : fail(400, `${key} must be a string or null`);
const optTime = (v, key) => v === null || v === undefined ? null : Number.isFinite(v) && v > 0 ? Math.round(v) : fail(400, `${key} must be a time in ms or null`);

function checkRun(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) fail(400, 'run must be a JSON object');
  const id = parseRunId(rec.runId);
  if (!id) fail(400, 'bad runId');
  if (rec.specialist !== id.name) fail(400, 'specialist does not match the runId');
  if (rec.mode !== undefined && rec.mode !== id.mode) fail(400, 'mode does not match the runId');
  if (rec.account !== undefined && rec.account !== id.account) fail(400, 'account does not match the runId');
  if (rec.tmux !== undefined && rec.tmux !== id.tmux) fail(400, 'tmux does not match the runId');
  if (rec.sessionId != null && !UUID.test(rec.sessionId)) fail(400, 'sessionId must be a UUID or null');
  if (!TMUX.test(id.tmux)) fail(400, 'bad tmux name');
  const task = rec.task === undefined ? '' : typeof rec.task === 'string' ? rec.task : fail(400, 'task must be a string');
  if (task.length > LIMITS.task) fail(400, `task is longer than ${LIMITS.task} characters`);
  const text = optString(rec.text, 'text', LIMITS.text);
  return {
    runId: rec.runId,
    specialist: id.name,
    mode: id.mode,
    tmux: id.tmux,
    account: id.account,
    sessionId: rec.sessionId || null,
    cwd: optString(rec.cwd, 'cwd', 4096),
    transcriptPath: optString(rec.transcriptPath, 'transcriptPath', 4096),
    state: oneOf(rec.state, 'state', RUN_STATES),
    task,
    text,
    truncated: typeof rec.text === 'string' && rec.text.length > LIMITS.text ? true : rec.truncated === true && text !== null,
    error: optString(rec.error, 'error', LIMITS.error),
    startedAt: optTime(rec.startedAt, 'startedAt') || Date.now(),
    endedAt: optTime(rec.endedAt, 'endedAt'),
    turns: rec.turns === undefined ? 1 : Number.isInteger(rec.turns) && rec.turns >= 1 ? rec.turns : fail(400, 'turns must be a positive integer'),
  };
}

function runFile(dir, runId) { return path.join(dir, DASH_DIR, 'runs', runId + '.json'); }

function saveRun(rec) {
  const run = checkRun(rec);
  const dir = profileDir(run.specialist);
  dashDir(dir, true);
  writeAtomic(runFile(dir, run.runId), JSON.stringify(run, null, 2) + '\n');
  return run;
}

function readRunFile(file) {
  const st = lstat(file);
  if (!st || !st.isFile() || st.size > LIMITS.runFileBytes) return null;
  try { return checkRun(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

function getRun(runId) {
  const id = parseRunId(runId);
  if (!id) return null;
  const dir = (() => { try { return profileDir(id.name); } catch { return null; } })();
  if (!dir || !dashDir(dir, false)) return null;
  const run = readRunFile(runFile(dir, runId));
  return run && run.runId === runId ? run : null;
}

function patchRun(runId, patch) {
  const run = getRun(runId);
  if (!run) fail(404, `no run "${runId}"`);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'patch must be a JSON object');
  return saveRun({ ...run, ...patch, runId: run.runId, specialist: run.specialist });
}

function summary(run) {
  const { text, ...rest } = run;
  return { ...rest, task: clip(run.task, LIMITS.clip), preview: text === null ? null : clip(text, LIMITS.clip) };
}

const runCache = new Map();

function cachedSummary(file, name) {
  const st = lstat(file);
  if (!st || !st.isFile()) { runCache.delete(file); return null; }
  const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  const hit = runCache.get(file);
  if (hit && hit.key === key) return hit.run;
  const r = readRunFile(file);
  const run = r && r.specialist === name && path.basename(file) === r.runId + '.json' ? summary(r) : null;
  runCache.set(file, { key, run });
  return run;
}

function listRuns(name, { limit = 50 } = {}) {
  const dir = profileDir(name);
  if (!dashDir(dir, false)) return [];
  const runsDir = path.join(dir, DASH_DIR, 'runs');
  const files = (() => { try { return fs.readdirSync(runsDir).filter(f => f.endsWith('.json')); } catch { return []; } })();
  const seen = new Set(files.map(f => path.join(runsDir, f)));
  for (const f of runCache.keys()) if (path.dirname(f) === runsDir && !seen.has(f)) runCache.delete(f);
  const runs = [...seen].map(f => cachedSummary(f, name)).filter(Boolean);
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  return runs.sort((a, b) => b.startedAt - a.startedAt || (a.runId < b.runId ? 1 : -1)).slice(0, max);
}

function getThread(name) {
  const dir = profileDir(name);
  if (!dashDir(dir, false)) return null;
  const text = readFileIn(path.join(dir, DASH_DIR), 'thread.json', LIMITS.metaBytes);
  if (text === null) return null;
  try { return checkThread(name, JSON.parse(text)); } catch { return null; }
}

function checkThread(name, rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) fail(400, 'thread must be a JSON object');
  const account = oneOf(rec.account, 'account', ACCOUNTS);
  if (rec.sessionId != null && !UUID.test(rec.sessionId)) fail(400, 'sessionId must be a UUID or null');
  return {
    specialist: name,
    tmux: threadName(name, account),
    account,
    sessionId: rec.sessionId || null,
    cwd: optString(rec.cwd, 'cwd', 4096),
    transcriptPath: optString(rec.transcriptPath, 'transcriptPath', 4096),
    seq: Number.isInteger(rec.seq) && rec.seq >= 0 ? rec.seq : fail(400, 'seq must be a non-negative integer'),
    startedAt: optTime(rec.startedAt, 'startedAt') || Date.now(),
  };
}

function setThread(name, rec) {
  const dir = profileDir(name);
  const thread = checkThread(name, rec);
  writeAtomic(path.join(dashDir(dir, true), 'thread.json'), JSON.stringify(thread, null, 2) + '\n');
  return thread;
}

const isFinal = state => FINAL_STATES.includes(state);

module.exports = {
  SpecialistError, root, nameError, isName, list, get, create, update, archive, readInstructions, templates,
  runName, threadName, threadRunId, parseRunId, specialistOfTmux, saveRun, getRun, patchRun, listRuns, getThread, setThread, isFinal,
  LIMITS, EFFORTS, ACCOUNTS, MODES, PERMISSION_MODES, PROVIDERS, RUN_STATES, FINAL_STATES, EDITABLE,
};
