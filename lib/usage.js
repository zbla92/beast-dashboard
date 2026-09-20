'use strict';
// Token usage + API-equivalent cost per Claude session, per account and per day, from the transcripts
// Claude Code writes under <config>/projects/<cwd-slug>/<session-id>.jsonl.
//
// Every assistant line carries message.usage; a streamed response is written as several lines that all
// repeat the same usage, so a request is counted once (first line of each requestId). Files are read
// incrementally: we remember the byte offset per file and only parse what was appended since.
//
// Cost is the public API list price. On a Max/Pro subscription nothing is billed per token — the number
// is "what this would cost on the API", which is still the honest measure of how much work a session did.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { readJson, writeJson, STATE, HOME } = require('./util');

const CACHE = path.join(STATE, 'usage-cache.json');
const LOOKBACK = 7 * 86400e3;          // a week of history is enough (recap + cost); older transcripts are not scanned at all
const ACCOUNTS = { personal: path.join(HOME, '.claude', 'projects'), company: path.join(HOME, '.claude-company', 'projects') };

// $ per million tokens: input, output, cache read, cache write (5 min), cache write (1 h). Prefix match.
const PRICE = [
  ['claude-fable-5-1', { in: 10, out: 50, cr: 0.25, cw5: 12.5, cw1: 20 }],
  ['claude-mythos-5-1', { in: 10, out: 50, cr: 0.25, cw5: 12.5, cw1: 20 }],
  ['claude-fable-5', { in: 10, out: 50, cr: 1, cw5: 12.5, cw1: 20 }],
  ['claude-mythos-5', { in: 10, out: 50, cr: 1, cw5: 12.5, cw1: 20 }],
  ['claude-opus-5', { in: 5, out: 25, cr: 0.5, cw5: 6.25, cw1: 10 }],
  ['claude-opus-4', { in: 5, out: 25, cr: 0.5, cw5: 6.25, cw1: 10 }],
  ['claude-sonnet-5', { in: 2, out: 10, cr: 0.2, cw5: 2.5, cw1: 4 }],
  ['claude-sonnet-4', { in: 3, out: 15, cr: 0.3, cw5: 3.75, cw1: 6 }],
  ['claude-haiku-4', { in: 1, out: 5, cr: 0.1, cw5: 1.25, cw1: 2 }],
];
function price(model) { const m = String(model || ''); for (const [p, v] of PRICE) if (m.startsWith(p)) return v; return PRICE[4][1]; }
function costOf(u, model) {
  const p = price(model); const cc = u.cache_creation || {};
  const cw1 = cc.ephemeral_1h_input_tokens || 0; const cw5 = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - cw1);
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cr + cw5 * p.cw5 + cw1 * p.cw1) / 1e6;
}

// cache: { files: { [path]: { offset, lastReq, account, sessionId, model, in, out, cr, cw, cost, requests, first, last, days: { [day]: cost } } } }
let cache = null; let scanning = false; let dirty = false;
function load() { if (!cache) cache = readJson(CACHE, { files: {} }); return cache; }
function persist() { if (!dirty) return; dirty = false; try { writeJson(CACHE, cache); } catch (e) { console.error('usage cache save', e); } }
const dayOf = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function listTranscripts() {
  const out = []; const cutoff = Date.now() - LOOKBACK;
  for (const [account, root] of Object.entries(ACCOUNTS)) {
    let dirs; try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name); let files; try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(dir, f); let st; try { st = fs.statSync(fp); } catch { continue; }
        if (st.mtimeMs < cutoff) continue;
        out.push({ fp, account, sessionId: f.slice(0, -6), size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  return out;
}

async function scanFile(t) {
  const c = load(); const rec = c.files[t.fp] || (c.files[t.fp] = { offset: 0, lastReq: null, account: t.account, sessionId: t.sessionId, model: null, in: 0, out: 0, cr: 0, cw: 0, cost: 0, requests: 0, first: null, last: null, days: {} });
  if (t.size < rec.offset) { Object.assign(rec, { offset: 0, lastReq: null, in: 0, out: 0, cr: 0, cw: 0, cost: 0, requests: 0, days: {} }); } // truncated / rewritten
  if (t.size === rec.offset) return;
  const stream = fs.createReadStream(t.fp, { start: rec.offset, encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let consumed = rec.offset; let lastLen = 0; let lastBroken = false;
  for await (const line of rl) {
    const len = Buffer.byteLength(line, 'utf8') + 1; lastLen = len; lastBroken = false;
    if (line.includes('"type":"assistant"') && line.includes('"usage"')) {
      let o; try { o = JSON.parse(line); } catch { lastBroken = true; consumed += len; continue; }
      const u = o.message?.usage; const req = o.requestId || o.message?.id;
      if (u && req && req !== rec.lastReq) {
        rec.lastReq = req; rec.requests++;
        const model = o.message.model || rec.model; rec.model = model;
        rec.in += u.input_tokens || 0; rec.out += u.output_tokens || 0; rec.cr += u.cache_read_input_tokens || 0; rec.cw += u.cache_creation_input_tokens || 0;
        const cost = costOf(u, model); rec.cost += cost;
        const ts = o.timestamp ? Date.parse(o.timestamp) : Date.now(); const day = dayOf(ts);
        rec.days[day] = (rec.days[day] || 0) + cost; if (!rec.first) rec.first = ts; rec.last = ts;
      }
    }
    consumed += len;
  }
  // Advance by what the stream actually read (the file may have grown while we were reading). A last line without
  // "\n" is still delivered by readline; if it did not parse it was half-written -> step back so it is re-read
  // once Claude Code finishes it.
  let end = rec.offset + stream.bytesRead;
  if (lastBroken && lastLen > 1) {
    let tail = '\n'; try { const fd = fs.openSync(t.fp, 'r'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, end - 1); fs.closeSync(fd); tail = b.toString(); } catch {}
    if (tail !== '\n') end -= (lastLen - 1);
  }
  rec.offset = Math.max(0, end); dirty = true;
}

// Full pass over changed files. Cheap when nothing changed (one stat per transcript).
async function scan() {
  if (scanning) return; scanning = true;
  try {
    const c = load(); const files = listTranscripts(); const seen = new Set();
    for (const t of files) { seen.add(t.fp); const rec = c.files[t.fp]; if (rec && rec.offset === t.size) continue; await scanFile(t); }
    for (const fp of Object.keys(c.files)) if (!seen.has(fp)) { delete c.files[fp]; dirty = true; }   // aged out of the lookback window
    persist();
  } catch (e) { console.error('usage scan failed', e); } finally { scanning = false; }
}

function bySession(sessionId) {
  if (!sessionId) return null;
  for (const r of Object.values(load().files)) if (r.sessionId === sessionId) return { cost: r.cost, in: r.in, out: r.out, cr: r.cr, cw: r.cw, requests: r.requests, model: r.model, first: r.first, last: r.last };
  return null;
}
// Totals: today / yesterday / 7 days per account, plus per-day series for a small chart.
function summary() {
  const c = load(); const now = Date.now(); const today = dayOf(now); const yday = dayOf(now - 86400e3);
  const days = []; for (let i = 13; i >= 0; i--) days.push(dayOf(now - i * 86400e3));
  const per = { personal: { today: 0, yesterday: 0, week: 0, series: days.map(() => 0) }, company: { today: 0, yesterday: 0, week: 0, series: days.map(() => 0) } };
  const week = new Set(days.slice(-7));
  for (const r of Object.values(c.files)) {
    const a = per[r.account]; if (!a) continue;
    for (const [d, cost] of Object.entries(r.days || {})) {
      if (d === today) a.today += cost; if (d === yday) a.yesterday += cost; if (week.has(d)) a.week += cost;
      const i = days.indexOf(d); if (i >= 0) a.series[i] += cost;
    }
  }
  return { days, ...per, total: { today: per.personal.today + per.company.today, yesterday: per.personal.yesterday + per.company.yesterday, week: per.personal.week + per.company.week } };
}

module.exports = { scan, bySession, summary, costOf, price, files: () => load().files };
