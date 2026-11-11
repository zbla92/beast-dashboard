'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SpecialistError } = require('./specialists');

const DIR = '.secrets', FILE = 'accesses.json';
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const RESERVED = ['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'TERM', 'LANG', 'TMPDIR', 'TZ'];
const PREFIXES = ['LC_', 'LD_', 'DYLD_', 'XDG_', 'NODE_', 'NPM_', 'GIT_', 'SSH_', 'TMUX', 'CLAUDE', 'ANTHROPIC', 'BD_', 'BEAST_'];
const FILE_MAX = 1024 * 1024, VALUE_MAX = 65536, NOTE_MAX = 200, COUNT_MAX = 50;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const fail = (status, message) => { throw new SpecialistError(status, message); };
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };

function nameError(name) {
  if (typeof name !== 'string' || !NAME.test(name)) return 'name must be 2-64 characters: capital letters, digits and _, starting with a letter';
  if (RESERVED.includes(name) || PREFIXES.some(p => name.startsWith(p))) return `${name} is reserved for the system`;
  return null;
}

function valueError(value) {
  if (typeof value !== 'string') return 'value must be a string';
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > VALUE_MAX) return `value must be 1-${VALUE_MAX} bytes`;
  if (value.includes('\0')) return 'value must not contain NUL';
  return null;
}

function noteOf(note) {
  if (note === undefined || note === null) return '';
  if (typeof note !== 'string') fail(400, 'note must be a string');
  const v = note.trim();
  if (CONTROL.test(v)) fail(400, 'note must be one line without control characters');
  if (v.length > NOTE_MAX) fail(400, `note must be at most ${NOTE_MAX} characters`);
  return v;
}

const dirOf = profile => path.join(profile, DIR);
const fileOf = profile => path.join(profile, DIR, FILE);

function privateStat(st, label, isDir) {
  if (st.isSymbolicLink()) fail(409, `${label} is a symlink`);
  if (isDir ? !st.isDirectory() : !st.isFile()) fail(409, `${label} is not a ${isDir ? 'folder' : 'regular file'}`);
  if (st.uid !== process.getuid()) fail(409, `${label} is not owned by you`);
  if (st.mode & 0o077) fail(409, `${label} can be read by other users (mode ${(st.mode & 0o777).toString(8)}); it must be ${isDir ? '0700' : '0600'}`);
}

function secretsDir(profile, create) {
  const dir = dirOf(profile);
  if (!lstat(dir)) {
    if (!create) return null;
    fs.mkdirSync(dir, { mode: 0o700 });
  }
  privateStat(lstat(dir), `${DIR}/`, true);
  return dir;
}

function parse(text) {
  const data = (() => { try { return JSON.parse(text); } catch { return undefined; } })();
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(409, `${DIR}/${FILE} is not a JSON object`);
  const names = Object.keys(data);
  if (names.length > COUNT_MAX) fail(409, `${DIR}/${FILE} has more than ${COUNT_MAX} accesses`);
  for (const name of names) {
    const e = data[name];
    const bad = nameError(name) || (!e || typeof e !== 'object' || Array.isArray(e) ? 'entry must be an object' : valueError(e.value) || (typeof e.note !== 'string' || CONTROL.test(e.note) || e.note.length > NOTE_MAX ? 'bad note' : !ISO.test(e.updatedAt || '') ? 'bad updatedAt' : null));
    if (bad) fail(409, `${DIR}/${FILE} is invalid at "${NAME.test(name) ? name : '?'}": ${bad}`);
  }
  return data;
}

function read(profile) {
  if (!secretsDir(profile, false)) return {};
  const file = fileOf(profile), label = `${DIR}/${FILE}`;
  const st = lstat(file);
  if (!st) return {};
  privateStat(st, label, false);
  if (st.size > FILE_MAX) fail(409, `${label} is larger than ${FILE_MAX} bytes`);
  const fd = (() => { try { return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { return fail(409, `${label} could not be opened (${e.code || 'error'})`); } })();
  try {
    const now = fs.fstatSync(fd);
    if (now.ino !== st.ino || now.dev !== st.dev) fail(409, `${label} changed while it was read; try again`);
    privateStat(now, label, false);
    return parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

function write(profile, data) {
  const dir = secretsDir(profile, true);
  const text = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(text, 'utf8') > FILE_MAX) fail(413, `the accesses would be larger than ${FILE_MAX} bytes`);
  const file = fileOf(profile);
  const st = lstat(file);
  if (st) privateStat(st, `${DIR}/${FILE}`, false);
  const tmp = path.join(dir, `.${FILE}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const accessOf = (name, e) => ({ name, note: e.note, bytes: Buffer.byteLength(e.value, 'utf8'), updatedAt: e.updatedAt });
const byName = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function list(profile) {
  const data = read(profile);
  return Object.keys(data).sort(byName).map(name => accessOf(name, data[name]));
}

function set(profile, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'body must be a JSON object');
  const bad = Object.keys(body).filter(k => !['name', 'value', 'note'].includes(k));
  if (bad.length) fail(400, `unknown field ${bad.map(k => `"${k}"`).join(', ')}`);
  const nameErr = nameError(body.name);
  if (nameErr) fail(400, nameErr);
  const valueErr = valueError(body.value);
  if (valueErr) fail(400, valueErr);
  const note = noteOf(body.note);
  const data = read(profile);
  if (!Object.hasOwn(data, body.name) && Object.keys(data).length >= COUNT_MAX) fail(409, `a specialist can have at most ${COUNT_MAX} accesses`);
  const entry = { value: body.value, note, updatedAt: new Date().toISOString() };
  write(profile, { ...data, [body.name]: entry });
  return accessOf(body.name, entry);
}

function remove(profile, name) {
  const bad = nameError(name);
  if (bad) fail(400, bad);
  const data = read(profile);
  if (!Object.hasOwn(data, name)) fail(404, `no access ${name}`);
  write(profile, Object.fromEntries(Object.entries(data).filter(([k]) => k !== name)));
  return name;
}

function forRun(profile) {
  const data = read(profile);
  const names = Object.keys(data).sort(byName);
  if (!names.length) return { env: {}, prompt: null };
  const listed = names.map(n => data[n].note ? `${n} (${data[n].note})` : n).join(', ');
  return { env: Object.fromEntries(names.map(n => [n, data[n].value])), prompt: `Accesses, as environment variables: ${listed}; use them by name, never print them` };
}

module.exports = { list, set, remove, read, forRun };
