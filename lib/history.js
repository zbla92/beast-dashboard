'use strict';
const fs = require('fs');
const path = require('path');
const { run, STATE, readJson, writeJson, mapLimit, titleFromPrompt } = require('./util');
const { ROOTS } = require('./search');
const { classifyUser, splitShell } = require('./transcript');

const HEAD = 256 * 1024, TAIL = 512 * 1024, EVERY = 60e3, MAX_DIRS = 40, MAX_PROJECTS = 8, MAX_TEXT = 200, MAX_PARSE = 400000;
const GREP = '"(file_path|notebook_path|cwd)":"[^"]*"|"type":"user","message":\\{"role":"user","content":"';

let cfg = { roots: ROOTS, file: path.join(STATE, 'history.json'), labelsFile: path.join(STATE, 'history-labels.json'), projects: () => [], live: () => null, every: EVERY };
let db = null, labels = null, building = null, builtAt = 0;

function init(opts = {}) { cfg = { ...cfg, ...opts }; db = null; labels = null; building = null; builtAt = 0; }

const oneLine = s => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + '…' : s; };
const tsOf = o => { const t = o && o.timestamp ? Date.parse(o.timestamp) : NaN; return Number.isFinite(t) ? t : null; };

function readWindow(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(len); const n = fs.readSync(fd, buf, 0, len, start); return buf.subarray(0, n).toString('utf8'); }
  finally { fs.closeSync(fd); }
}

function promptOf(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain || o.isCompactSummary) return null;
  const c = o.message && o.message.content;
  const raw = typeof c === 'string' ? c : Array.isArray(c) && !c.some(b => b.type === 'tool_result') ? splitShell(c).text : '';
  if (!raw) return null;
  const k = classifyUser(o, raw);
  return k.kind === 'prompt' && k.text && !/^\/[\w:-]+$/.test(k.text.trim()) ? k.text : null;
}

function lines(text, cutHead, cutTail) {
  const ls = text.split('\n');
  if (cutHead) ls.shift();
  if (cutTail) ls.pop();
  return ls;
}

async function readTranscript(file, size, account) {
  const out = { id: path.basename(file, '.jsonl'), account, cwd: null, title: null, firstPrompt: null, lastPrompt: null, startedAt: null, lastAt: null, prompts: 0 };
  const head = readWindow(file, 0, Math.min(size, HEAD));
  for (const l of lines(head, false, size > HEAD)) {
    if (!l) continue;
    if (l.length > MAX_PARSE) { if (!out.cwd) { const m = l.match(/"cwd":"([^"]+)"/); if (m) out.cwd = m[1]; } continue; }
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!out.cwd && typeof o.cwd === 'string') out.cwd = o.cwd;
    if (out.startedAt == null) out.startedAt = tsOf(o);
    if (!out.firstPrompt) { const p = promptOf(o); if (p) out.firstPrompt = oneLine(titleFromPrompt(p) || p); }
    if (out.cwd && out.firstPrompt && out.startedAt != null) break;
  }
  const tStart = Math.max(0, size - TAIL);
  const tail = tStart === 0 ? head.length === size ? head : readWindow(file, 0, size) : readWindow(file, tStart, size - tStart);
  let ai = null, custom = null, lastPrompt = null, lastUser = null, firstTail = null;
  for (const l of lines(tail, tStart > 0, false)) {
    if (!l) continue;
    if (l.length > MAX_PARSE) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const t = tsOf(o); if (t != null) out.lastAt = t;
    if (o.type === 'ai-title' && o.aiTitle) ai = o.aiTitle;
    else if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
    else if (o.type === 'last-prompt' && typeof o.lastPrompt === 'string') lastPrompt = o.lastPrompt;
    else { const p = promptOf(o); if (p) { lastUser = p; if (!firstTail) firstTail = p; } }
  }
  out.title = custom || ai ? oneLine(custom || ai) : null;
  if (!out.firstPrompt && firstTail) out.firstPrompt = oneLine(titleFromPrompt(firstTail) || firstTail);
  out.lastPrompt = oneLine(titleFromPrompt(lastUser || lastPrompt || '')) || null;
  const dirs = new Map();
  const g = await run('grep', ['-a', '-o', '-E', GREP, file], { timeout: 30000 });
  const partial = !g.ok && g.code !== 1;
  for (const m of g.stdout.split('\n')) {
    if (!m) continue;
    if (m.startsWith('"type":"user"')) { out.prompts++; continue; }
    const v = m.slice(m.indexOf(':"') + 2, -1); if (!v.startsWith('/')) continue;
    const d = m.startsWith('"cwd"') ? v : path.dirname(v);
    dirs.set(d, (dirs.get(d) || 0) + 1);
  }
  if (!out.cwd && dirs.size) out.cwd = [...dirs.keys()][0];
  if (out.lastAt == null) { try { out.lastAt = fs.statSync(file).mtimeMs; } catch {} }
  if (out.startedAt == null) out.startedAt = out.lastAt;
  return { entry: out, partial, dirs: [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DIRS) };
}

function projectFor(p, projects) {
  if (!p) return null;
  let best = null;
  for (const pr of projects) if (pr.path && (p === pr.path || p.startsWith(pr.path + '/')) && (!best || pr.path.length > best.path.length)) best = pr;
  return best ? best.id : null;
}

function mapProjects(rec, projects) {
  const e = rec.entry; const score = new Map();
  e.project = projectFor(e.cwd, projects);
  for (const [d, n] of rec.dirs || []) { const id = projectFor(d, projects); if (id) score.set(id, (score.get(id) || 0) + n); }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  e.projects = [...new Set([e.project, ...ranked].filter(Boolean))].slice(0, MAX_PROJECTS);
}

function listFiles() {
  const out = [];
  for (const [account, root] of Object.entries(cfg.roots)) {
    let dirs; try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let files; try { files = fs.readdirSync(path.join(root, d.name), { withFileTypes: true }); } catch { continue; }
      for (const f of files) if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ file: path.join(root, d.name, f.name), account });
    }
  }
  return out;
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

function load() {
  if (!db) {
    db = readJson(cfg.file, { v: 1, files: {} });
    if (!db || db.v !== 1 || !isObj(db.files)) db = { v: 1, files: {} };
    for (const [f, r] of Object.entries(db.files)) if (!isObj(r) || !isObj(r.entry) || typeof r.size !== 'number' || typeof r.mtime !== 'number') delete db.files[f];
  }
  if (!labels) {
    const raw = readJson(cfg.labelsFile, {}); labels = {};
    if (isObj(raw)) for (const [id, l] of Object.entries(raw)) if (typeof l === 'string' && l && l.length <= 60) labels[id] = l;
  }
}

function refresh(force) {
  load();
  if (building) return building;
  if (!force && builtAt && Date.now() - builtAt < cfg.every) return Promise.resolve(db);
  building = (async () => {
    const projects = cfg.projects() || [];
    const seen = new Set(); const todo = [];
    for (const { file, account } of listFiles()) {
      let st; try { st = fs.statSync(file); } catch { continue; }
      seen.add(file);
      const old = db.files[file];
      const mtime = Math.trunc(st.mtimeMs);
      if (old && old.size === st.size && old.mtime === mtime) continue;
      todo.push({ file, account, size: st.size, mtime });
    }
    let changed = todo.length > 0;
    await mapLimit(todo, 4, async t => {
      try { const r = await readTranscript(t.file, t.size, t.account); db.files[t.file] = { size: r.partial ? -1 : t.size, mtime: t.mtime, dirs: r.dirs, entry: r.entry }; }
      catch (e) { console.error('history read failed', t.file, e.message); }
    });
    for (const f of Object.keys(db.files)) if (!seen.has(f)) { delete db.files[f]; changed = true; }
    for (const rec of Object.values(db.files)) mapProjects(rec, projects);
    if (changed) { try { writeJson(cfg.file, db); } catch (e) { console.error('history save failed', e.message); } }
    builtAt = Date.now();
    return db;
  })().finally(() => { building = null; });
  return building;
}

async function query(opts = {}) {
  await refresh(false);
  const words = String(opts.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Math.min(300, Math.max(1, parseInt(opts.limit, 10) || 100));
  const names = new Map((cfg.projects() || []).map(p => [p.id, [p.name, p.dirName, p.org].filter(Boolean).join(' ')]));
  const items = [];
  for (const [file, rec] of Object.entries(db.files)) {
    const e = rec.entry;
    if (!e.firstPrompt && !e.title) continue;
    if (opts.account && e.account !== opts.account) continue;
    if (opts.project && !(e.projects || []).includes(opts.project)) continue;
    const label = labels[e.id] || null;
    if (words.length) {
      const hay = [label, e.title, e.firstPrompt, e.lastPrompt, e.cwd, ...(e.projects || []).map(id => names.get(id) || id)].filter(Boolean).join(' ').toLowerCase();
      if (!words.every(w => hay.includes(w))) continue;
    }
    items.push({ ...e, file, label, live: cfg.live(e.id) || null });
  }
  items.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return { items: items.slice(0, limit), total: items.length };
}

function entries() { load(); if (!builtAt || Date.now() - builtAt > cfg.every) refresh(false).catch(() => {}); return Object.entries(db.files).map(([file, r]) => ({ ...r.entry, file })); }

async function latestFor(cwd, account) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  await refresh(true);
  const want = path.resolve(cwd); let best = null;
  for (const rec of Object.values(db.files)) {
    const e = rec.entry;
    if (e.account !== account || !e.cwd || (!e.firstPrompt && !e.title) || path.resolve(e.cwd) !== want) continue;
    if (!best || (e.lastAt || 0) > (best.lastAt || 0)) best = e;
  }
  return best ? { ...best, label: labels[best.id] || null, live: cfg.live(best.id) || null } : null;
}

function labelOf(id) { load(); return labels[id] || null; }
function setLabel(id, label) {
  if (!/^[0-9a-f-]{36}$/.test(String(id || ''))) return { ok: false, error: 'bad session id' };
  load();
  const l = String(label || '').trim().slice(0, 60);
  if (l) labels[id] = l; else delete labels[id];
  try { writeJson(cfg.labelsFile, labels); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, label: l || null };
}

module.exports = { init, refresh, query, latestFor, entries, labelOf, setLabel, projectFor };
