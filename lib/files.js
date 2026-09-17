'use strict';
// Files tab: browse a project's tree, read a file, download it, save an edit. Everything is pinned inside the
// project directory (realpath check, so a symlink can't lead out) and skips the usual noise directories.
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', '.git', '.next', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.expo', '.turbo', 'Pods', 'DerivedData', '.gradle', 'build', 'dist', 'target', '.dart_tool']);
const MAX_READ = 2 * 1024 * 1024;

// Resolve `rel` inside `root`; null if it escapes.
function safe(root, rel) {
  if (String(rel || '').split('/').includes('..')) return null;
  const clean = path.normalize('/' + String(rel || '')).replace(/^\/+/, '');
  const abs = path.join(root, clean);
  let real; try { real = fs.realpathSync(abs); } catch { real = path.resolve(abs); }
  const rootReal = fs.realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  return { abs, rel: clean };
}

// One directory level. `changed` = { relPath: statusLetter } from git status; directories get the count under them.
function list(root, rel, changed) {
  const t = safe(root, rel); if (!t) return { error: 'bad path' };
  let ents; try { ents = fs.readdirSync(t.abs, { withFileTypes: true }); } catch (e) { return { error: e.message }; }
  const prefix = t.rel ? t.rel + '/' : '';
  const out = [];
  for (const e of ents) {
    if (e.name === '.git' || e.name === '.DS_Store') continue;
    const relp = prefix + e.name;
    const isDir = e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(t.abs, e.name)).isDirectory(); } catch { return false; } })());
    if (isDir) {
      let n = 0; for (const k of Object.keys(changed)) if (k.startsWith(relp + '/')) n++;
      out.push({ name: e.name, type: 'dir', path: relp, changed: n, skip: SKIP.has(e.name) });
    } else {
      let size = 0, mtime = 0; try { const st = fs.statSync(path.join(t.abs, e.name)); size = st.size; mtime = st.mtimeMs; } catch {}
      out.push({ name: e.name, type: 'file', path: relp, size, mtime, status: changed[relp] || null });
    }
  }
  out.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name));
  return { path: t.rel, entries: out };
}

function isBinary(buf) { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; }

function read(root, rel) {
  const t = safe(root, rel); if (!t) return { error: 'bad path' };
  let st; try { st = fs.statSync(t.abs); } catch (e) { return { error: e.message }; }
  if (st.isDirectory()) return { error: 'is a directory' };
  const fd = fs.openSync(t.abs, 'r'); const len = Math.min(st.size, MAX_READ); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, 0); fs.closeSync(fd);
  const binary = isBinary(buf);
  return { path: t.rel, size: st.size, mtime: st.mtimeMs, binary, truncated: st.size > MAX_READ, text: binary ? null : buf.toString('utf8') };
}

// Save only if the file is still the version the editor loaded (mtime match) — Claude sessions edit the same tree.
function save(root, rel, text, mtime) {
  const t = safe(root, rel); if (!t) return { ok: false, error: 'bad path' };
  let st = null; try { st = fs.statSync(t.abs); } catch {}
  if (st && mtime && Math.abs(st.mtimeMs - mtime) > 1) return { ok: false, error: 'file changed on disk since you opened it — reload and redo your edit', conflict: true, mtime: st.mtimeMs };
  fs.writeFileSync(t.abs, text);
  return { ok: true, mtime: fs.statSync(t.abs).mtimeMs, size: Buffer.byteLength(text) };
}

function stream(root, rel, res) {
  const t = safe(root, rel); if (!t) { res.writeHead(400); return res.end('bad path'); }
  let st; try { st = fs.statSync(t.abs); } catch { res.writeHead(404); return res.end('missing'); }
  if (st.isDirectory()) { res.writeHead(400); return res.end('directory'); }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(t.abs))}`, 'cache-control': 'no-store' });
  fs.createReadStream(t.abs).pipe(res);
}

module.exports = { list, read, save, stream };
