'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || require('os').homedir();
const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'state');
for (const d of ['logs', 'cmds', 'exit']) fs.mkdirSync(path.join(STATE, d), { recursive: true });

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 15000, maxBuffer: 16 * 1024 * 1024, cwd: opts.cwd, env: cmd === 'git' ? { ...(opts.env || process.env), GIT_OPTIONAL_LOCKS: '0' } : opts.env || process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', c => { if (over) return; size += c.length; if (size > max) { over = true; chunks.length = 0; reject(Object.assign(new Error('request body too large'), { status: 413 })); return; } chunks.push(c); });
    req.on('error', e => { if (!over) { over = true; reject(e); } });
    req.on('end', () => { if (over) return; const s = Buffer.concat(chunks).toString('utf8'); try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); } });
  });
}

const CORRUPT = [];
function readJson(file, fallback, quarantine = inside(file, STATE + '/')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  try { return JSON.parse(text); } catch (e) {
    if (!quarantine) return fallback;
    const savedAs = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, savedAs); } catch {}
    const where = /position \d+/.exec(e.message); const error = 'not valid JSON' + (where ? ' at ' + where[0] : '');
    CORRUPT.push({ file, savedAs, error, at: Date.now() });
    console.error(`!!! ${file} is ${error}; moved it to ${savedAs} and continued with defaults`);
    return fallback;
  }
}
function corrupted() { return CORRUPT; }
function wasCorrupt(file) {
  if (CORRUPT.some(c => c.file === file)) return true;
  try { return fs.readdirSync(path.dirname(file)).some(n => n.startsWith(path.basename(file) + '.corrupt-')); } catch { return false; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function slugify(rel) { return rel.split('/').filter(Boolean).map(x => x.replace(/[^a-zA-Z0-9_-]+/g, '-')).join('--'); }
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
const tdir = d => String(d).replace(/#/g, '##');
function inside(child, parent) { return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', cwd: opts.cwd, env: opts.env || process.env });
  child.unref();
  return child;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

function titleFromPrompt(text) {
  const plain = text.replace(/(^|\s)\S*\/\.pasted\/\S+/g, ' ').replace(/📎/gu, '').replace(/\s+/g, ' ').trim();
  if (plain) return plain;
  const names = [...text.matchAll(/\/\.pasted\/(?:\S*\/)?([^\s/]+)/g)].map(m => m[1]);
  return names.length ? '📎 ' + names.join(' ') : '';
}

module.exports = { titleFromPrompt, run, readBody, readJson, writeJson, corrupted, wasCorrupt, exists, readText, slugify, shq, tdir, inside, sleep, spawnDetached, mapLimit, HOME, ROOT, STATE };
