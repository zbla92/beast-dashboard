'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run } = require('./util');

const ID_RE = /^[\w.-]+(~[0-9a-f]{8})?$/;
const WT_TTL = 10 * 1000;
const LOC_TTL = 60 * 1000;
const WT_KEEP = 5 * 60 * 1000;

let cfg = { projects: () => [] };
const wtCache = new Map();
const locCache = new Map();
let repoIndex = { at: 0, key: '', map: new Map() };

function init(opts = {}) { cfg = { ...cfg, ...opts }; wtCache.clear(); locCache.clear(); repoIndex = { at: 0, key: '', map: new Map() }; }

const realp = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const hashOf = p => crypto.createHash('sha1').update(realp(p)).digest('hex').slice(0, 8);

function parsePorcelain(text) {
  const out = []; let cur = null;
  for (const line of text.split('\n')) {
    if (!line) { if (cur) out.push(cur); cur = null; continue; }
    const sp = line.indexOf(' '); const k = sp < 0 ? line : line.slice(0, sp); const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'worktree') { if (cur) out.push(cur); cur = { path: v, head: '', branch: null, detached: false, bare: false, prunable: false }; }
    else if (!cur) continue;
    else if (k === 'HEAD') cur.head = v;
    else if (k === 'branch') cur.branch = v.replace(/^refs\/heads\//, '');
    else if (k === 'detached') cur.detached = true;
    else if (k === 'bare') cur.bare = true;
    else if (k === 'prunable') cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

function wtMtime(repo) {
  try { const d = path.join(repo, '.git', 'worktrees'); const names = fs.readdirSync(d); return [fs.statSync(d).mtimeMs, ...names.map(n => { try { return fs.statSync(path.join(d, n, 'HEAD')).mtimeMs; } catch { return 0; } })].join(','); } catch { return null; }
}

function hasLinked(repo) {
  try { return fs.readdirSync(path.join(repo, '.git', 'worktrees')).length > 0; } catch { return !fs.existsSync(path.join(repo, '.git')) || !fs.statSync(path.join(repo, '.git')).isDirectory(); }
}

async function worktreesOf(p) {
  if (!p || !p.isGit) return [];
  const c = wtCache.get(p.id);
  const mt = wtMtime(p.path);
  if (c && (Date.now() - c.at < WT_TTL || mt && c.mt === mt && Date.now() - c.at < WT_KEEP)) return c.list.filter(w => fs.existsSync(w.path));
  if (!hasLinked(p.path)) { wtCache.set(p.id, { at: Date.now(), mt, list: [] }); return []; }
  const r = await run('git', ['-C', p.path, 'worktree', 'list', '--porcelain'], { timeout: 5000 });
  const main = realp(p.path);
  const list = r.ok ? parsePorcelain(r.stdout).filter(e => !e.bare && !e.prunable && realp(e.path) !== main && fs.existsSync(e.path))
    .map(e => ({ id: p.id + '~' + hashOf(e.path), path: e.path, branch: e.branch, detached: e.detached, head: e.head })) : [];
  wtCache.set(p.id, { at: Date.now(), mt, list });
  if (wtCache.size > 200) wtCache.delete(wtCache.keys().next().value);
  return list;
}

function wtRoot(p, w) {
  return { id: w.id, project: p.id, name: p.name, path: w.path, worktree: true, repoPath: p.path, branch: w.branch, detached: w.detached,
    isGit: true, parent: null, rel: '', org: p.org, set: p.set || p.id };
}

async function rootOf(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const [pid, h] = id.split('~');
  const p = cfg.projects().find(x => x.id === pid);
  if (!p) return null;
  if (!h) return p;
  const w = (await worktreesOf(p)).find(x => x.id === id);
  return w ? wtRoot(p, w) : null;
}

function gitDirFile(dir) {
  try {
    const m = fs.readFileSync(path.join(dir, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m);
    return m ? path.resolve(dir, m[1].trim()) : null;
  } catch { return null; }
}
function mainRepoOf(gitdir) {
  let common = gitdir;
  try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()); } catch {}
  return path.basename(common) === '.git' ? path.dirname(common) : null;
}

function projectsByRepo() {
  const ps = cfg.projects().filter(p => p.isGit);
  const key = ps.map(p => p.id).join('|');
  if (key === repoIndex.key && Date.now() - repoIndex.at < LOC_TTL) return repoIndex.map;
  const map = new Map(); for (const p of ps) map.set(realp(p.path), p);
  repoIndex = { at: Date.now(), key, map };
  return map;
}

function checkoutOf(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    let st = null; try { st = fs.statSync(path.join(d, '.git')); } catch {}
    if (st && st.isDirectory()) return { root: d, main: d, worktree: false };
    if (st && st.isFile()) {
      const gd = gitDirFile(d);
      if (gd && /[\\/]worktrees[\\/][^\\/]+$/.test(gd)) { const main = mainRepoOf(gd); if (main) return { root: d, main, worktree: true }; }
      return { root: d, main: d, worktree: false };
    }
    if (d === path.dirname(d)) return null;
  }
}

function locate(absPath) {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return null;
  const abs = path.normalize(absPath);
  const dir = path.dirname(abs);
  let c = locCache.get(dir);
  if (!c || Date.now() - c.at > LOC_TTL) {
    let val = null;
    const ck = checkoutOf(realp(dir));
    if (ck) {
      const p = projectsByRepo().get(realp(ck.main));
      if (p) val = { rootId: ck.worktree ? p.id + '~' + hashOf(ck.root) : p.id, root: ck.root, project: p.id, worktree: ck.worktree };
    }
    c = { at: Date.now(), val }; locCache.set(dir, c);
    if (locCache.size > 5000) locCache.delete(locCache.keys().next().value);
  }
  if (!c.val) return null;
  const real = path.join(realp(dir), path.basename(abs));
  return { ...c.val, rel: path.relative(c.val.root, real) };
}

module.exports = { init, rootOf, wtRoot, locate, checkoutOf, worktreesOf, hashOf, parsePorcelain, ID_RE };
