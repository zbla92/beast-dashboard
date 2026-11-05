'use strict';
const fs = require('fs');
const path = require('path');
const { run, mapLimit } = require('./util');

const TOOLS = '(Edit|Write|MultiEdit|NotebookEdit)';
const GREP = `"name":"${TOOLS}","input":\\{("replace_all":(true|false),)?"(file_path|notebook_path)":"([^"\\\\]|\\\\.)*"`;
const RE = new RegExp(`"name":"${TOOLS}","input":\\{(?:"replace_all":(?:true|false),)?"(?:file_path|notebook_path)":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
const CWD_GREP = '"cwd":"([^"\\\\]|\\\\.)*"';
const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/g;
const INLINE = 256 * 1024;
const MAX_FILES = 3000;
const INDEX_DAYS = 14;
const INDEX_EVERY = 60 * 1000;
const PER_PATH = 5;

let cfg = { entries: () => [], live: () => null, label: () => null, grep: '/usr/bin/grep' };
const cache = new Map();
let index = { at: 0, map: new Map(), building: null };

function init(opts = {}) { cfg = { ...cfg, ...opts }; cache.clear(); index = { at: 0, map: new Map(), building: null }; }

function decode(raw) { try { return JSON.parse('"' + raw + '"'); } catch { return null; } }

function lastNewline(file, size) {
  if (!size) return 0;
  const fd = fs.openSync(file, 'r');
  try {
    const step = 64 * 1024; const buf = Buffer.alloc(step);
    for (let end = size; end > 0; end -= step) {
      const start = Math.max(0, end - step); const n = fs.readSync(fd, buf, 0, end - start, start);
      const i = buf.subarray(0, n).lastIndexOf(10);
      if (i >= 0) return start + i + 1;
    }
    return 0;
  } finally { fs.closeSync(fd); }
}

function addHit(hits, p, tool, off) {
  const h = hits.get(p);
  if (h) { h.count++; if (off >= h.off) { h.off = off; h.tool = tool; } }
  else hits.set(p, { tool, count: 1, off });
}

function addCwd(cwds, raw) { const p = decode(raw); if (p) cwds.set(p, (cwds.get(p) || 0) + 1); }

function scanText(text, base, hits, cwds) {
  RE.lastIndex = 0; let m;
  while ((m = RE.exec(text))) { const p = decode(m[2]); if (p) addHit(hits, p, m[1], base + m.index); }
  for (const c of text.matchAll(CWD_RE)) addCwd(cwds, c[1]);
}

function readRange(file, from, to) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(to - from); const n = fs.readSync(fd, buf, 0, to - from, from); return buf.subarray(0, n).toString('utf8'); }
  finally { fs.closeSync(fd); }
}

async function grepCwds(file, from, to, cwds) {
  const r = await run(cfg.grep, ['-oabE', '--', CWD_GREP, file], { timeout: 60000, env: { ...process.env, LC_ALL: 'C' } });
  if (!r.ok) return;
  for (const line of r.stdout.split('\n')) {
    const c = line.indexOf(':'); if (c < 0) continue;
    const off = +line.slice(0, c); if (!(off >= from && off < to)) continue;
    const m = line.slice(c + 1).match(/^"cwd":"(.*)"$/);
    if (m) addCwd(cwds, m[1]);
  }
}

async function grepRange(file, from, to, hits) {
  const r = await run(cfg.grep, ['-oabE', '--', GREP, file], { timeout: 60000, env: { ...process.env, LC_ALL: 'C' } });
  if (!r.ok && r.code !== 1) throw new Error('grep failed: ' + (r.stderr || r.code));
  for (const line of r.stdout.split('\n')) {
    const c = line.indexOf(':'); if (c < 0) continue;
    const off = +line.slice(0, c); if (!(off >= from && off < to)) continue;
    RE.lastIndex = 0; const m = RE.exec(line.slice(c + 1));
    if (m) { const p = decode(m[2]); if (p) addHit(hits, p, m[1], off); }
  }
}

async function scanFile(file) {
  let st; try { st = fs.statSync(file); } catch { cache.delete(file); return null; }
  let c = cache.get(file);
  if (c && c.ino === st.ino && c.size === st.size && c.mtime === st.mtimeMs) { cache.delete(file); cache.set(file, c); return c; }
  if (!c || c.ino !== st.ino || st.size < c.size) c = { ino: st.ino, size: 0, mtime: 0, offset: 0, hits: new Map(), cwds: new Map() };
  const end = lastNewline(file, st.size);
  if (end > c.offset) {
    const hits = new Map([...c.hits].map(([k, v]) => [k, { ...v }]));
    const cwds = new Map(c.cwds);
    if (end - c.offset <= INLINE) scanText(readRange(file, c.offset, end), c.offset, hits, cwds);
    else { await grepRange(file, c.offset, end, hits); await grepCwds(file, c.offset, end, cwds); }
    c = { ino: st.ino, size: st.size, mtime: st.mtimeMs, offset: end, hits, cwds };
  } else c = { ...c, size: st.size, mtime: st.mtimeMs };
  cache.delete(file); cache.set(file, c);
  while (cache.size > MAX_FILES) cache.delete(cache.keys().next().value);
  return c;
}

function subagentFiles(transcript) {
  const dir = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); } catch { return []; }
}

async function scan(transcript) {
  if (typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return [];
  const files = [{ f: transcript, by: 'main' }, ...subagentFiles(transcript).map(f => ({ f, by: 'agent' }))];
  const res = await mapLimit(files, 4, x => scanFile(x.f).catch(() => null));
  const out = new Map();
  files.forEach((x, i) => {
    const c = res[i]; if (!c) return;
    for (const [p, h] of c.hits) {
      const o = out.get(p);
      if (!o) { out.set(p, { path: p, tool: h.tool, by: x.by, count: h.count, at: c.mtime, seq: h.off }); continue; }
      o.count += h.count;
      if (o.by !== x.by) o.by = 'both';
      if (c.mtime > o.at || c.mtime === o.at && h.off > o.seq) { o.at = c.mtime; o.seq = h.off; o.tool = h.tool; }
    }
  });
  return [...out.values()].sort((a, b) => b.at - a.at || b.seq - a.seq);
}

async function cwdsOf(transcript) {
  if (typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return [];
  const res = await mapLimit([transcript, ...subagentFiles(transcript)], 4, f => scanFile(f).catch(() => null));
  const out = new Map();
  for (const c of res) if (c) for (const [p, n] of c.cwds) out.set(p, (out.get(p) || 0) + n);
  return [...out].map(([dir, count]) => ({ dir, count }));
}

async function buildIndex() {
  const since = Date.now() - INDEX_DAYS * 864e5;
  const items = (cfg.entries() || []).filter(e => e && e.file && (e.lastAt || 0) >= since);
  const map = new Map();
  const scanned = await mapLimit(items, 3, e => scan(e.file).catch(() => []));
  items.forEach((e, i) => {
    const who = { sessionId: e.id, transcript: e.file, account: e.account || null, label: cfg.label(e.id) || e.title || e.firstPrompt || null, live: cfg.live(e.id) || null };
    for (const h of scanned[i]) {
      let arr = map.get(h.path); if (!arr) map.set(h.path, arr = []);
      arr.push({ ...who, at: Math.max(e.lastAt || 0, h.at || 0), count: h.count, by: h.by });
    }
  });
  for (const arr of map.values()) { arr.sort((a, b) => b.at - a.at); if (arr.length > PER_PATH) arr.length = PER_PATH; }
  index = { at: Date.now(), map, building: null };
  return map;
}

function refreshIndex(force) {
  if (index.building) return index.building;
  if (!force && index.at && Date.now() - index.at < INDEX_EVERY) return Promise.resolve(index.map);
  index.building = buildIndex().catch(e => { index.building = null; throw e; });
  return index.building;
}

function byPath(absPath) {
  if (!index.at || Date.now() - index.at >= INDEX_EVERY) refreshIndex(false).catch(() => {});
  const live = cfg.live;
  return (index.map.get(absPath) || []).map(x => ({ ...x, live: live(x.sessionId) || null }));
}

function indexReady() { return index.at > 0; }

module.exports = { init, scan, cwdsOf, scanFile, byPath, refreshIndex, indexReady, subagentFiles, GREP };
