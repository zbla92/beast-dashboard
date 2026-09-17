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
    execFile(cmd, args, { timeout: opts.timeout || 15000, maxBuffer: 16 * 1024 * 1024, cwd: opts.cwd, env: opts.env || process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function slugify(rel) { return rel.split('/').filter(Boolean).map(x => x.replace(/[^a-zA-Z0-9_-]+/g, '-')).join('--'); }
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
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

module.exports = { run, readJson, writeJson, exists, readText, slugify, shq, inside, sleep, spawnDetached, mapLimit, HOME, ROOT, STATE };
