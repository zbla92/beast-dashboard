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
  // specific ids first: they would otherwise be caught by the looser prefixes below (haiku 5.5 is the ≤100K-prompt tier)
  ['claude-opus-5-5', { in: 4, out: 20, cr: 0.2, cw5: 5, cw1: 8 }],
  ['claude-sonnet-5-5', { in: 2, out: 10, cr: 0.2, cw5: 2.5, cw1: 4 }],
  ['claude-haiku-5-5', { in: 0.1, out: 0.5, cr: 0.01, cw5: 0.125, cw1: 0.2 }],
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
function price(model) { const m = String(model || ''); for (const [p, v] of PRICE) if (m.startsWith(p)) return v; return PRICE[0][1]; }   // unknown model: the claude-opus-5-5 row
function costOf(u, model) {
  const p = price(model); const cc = u.cache_creation || {};
  const cw1 = cc.ephemeral_1h_input_tokens || 0; const cw5 = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - cw1);
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cr + cw5 * p.cw5 + cw1 * p.cw1) / 1e6;
}

// cache: { v: 2, files: { [path]: { offset, lastReq, account, sessionId, sub, model, in, out, cr, cw, cost, requests, first, last,
//   days: { [day]: cost }, models: { [modelId]: cost }, dayModels: { [day]: { [modelId]: cost } } } } }
// sub = a subagent transcript (<session>/subagents/agent-*.jsonl); sessionId is then the PARENT session's id.
const CACHE_V = 2;
let cache = null; let scanning = false; let dirty = false;
function load() { if (!cache) { const c = readJson(CACHE, null); cache = c && c.v === CACHE_V && c.files ? c : { v: CACHE_V, files: {} }; } return cache; }
function persist() { if (!dirty) return; dirty = false; try { writeJson(CACHE, cache); } catch (e) { console.error('usage cache save', e); } }
const dayOf = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function listTranscripts() {
  const out = []; const cutoff = Date.now() - LOOKBACK;
  for (const [account, root] of Object.entries(ACCOUNTS)) {
    let dirs; try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name); let files; try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const f of files) {
        const fp = path.join(dir, f.name);
        if (f.isDirectory()) {   // <session-id>/subagents/agent-*.jsonl -> attributed to the parent session
          const sd = path.join(fp, 'subagents'); let subs; try { subs = fs.readdirSync(sd); } catch { continue; }
          for (const sf of subs) {
            if (!sf.startsWith('agent-') || !sf.endsWith('.jsonl')) continue;
            const sp = path.join(sd, sf); let st; try { st = fs.statSync(sp); } catch { continue; }
            if (st.mtimeMs < cutoff) continue;
            out.push({ fp: sp, account, sessionId: f.name, sub: true, size: st.size, mtime: st.mtimeMs });
          }
          continue;
        }
        if (!f.name.endsWith('.jsonl')) continue;
        let st; try { st = fs.statSync(fp); } catch { continue; }
        if (st.mtimeMs < cutoff) continue;
        out.push({ fp, account, sessionId: f.name.slice(0, -6), sub: false, size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  return out;
}

const ctxOfLine = o => {
  if (o.type === 'system') { const n = o.compactMetadata?.postTokens; return Number.isFinite(n) ? n : null; }
  const u = o.message.usage; return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
};
function tailCtx(fp) {
  let fd; try {
    fd = fs.openSync(fp, 'r'); const size = fs.fstatSync(fd).size; const n = Math.min(size, 1 << 20);
    const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, size - n);
    const lines = b.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= (n < size ? 1 : 0); i--) {
      const l = lines[i]; if (!l.includes('"subtype":"compact_boundary"') && !(l.includes('"type":"assistant"') && l.includes('"usage"'))) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type === 'system' && o.subtype === 'compact_boundary') return ctxOfLine(o);
      if (o.type === 'assistant' && o.message?.usage && !o.isSidechain && ctxOfLine(o)) return ctxOfLine(o);
    }
    return null;
  } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}
const WINDOWS = new Map();
const COMPACT_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const COMPACT_BUFFER = 33000;
const SETTINGS = new Map();
function parseCompactWindow(v) {
  const r = String(v ?? '').trim(); const suffix = r.slice(-1).toLowerCase();
  const scale = suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : null;
  const n = scale ? parseFloat(r) * scale : parseInt(r, 10);
  if (Number.isNaN(n) || n < 1) return null;
  return Math.round(Math.min(1e6, Math.max(1e5, n)));
}
function accountSettings(account, now = Date.now()) {
  const key = account === 'company' ? 'company' : 'personal'; const hit = SETTINGS.get(key);
  if (hit && now - hit.at < 30e3) return hit.value;
  const value = readJson(path.join(path.dirname(ACCOUNTS[key]), 'settings.json'), null) || {};
  SETTINGS.set(key, { at: now, value });
  return value;
}
const bareModel = m => String(m || '').replace(/\[.*$/, '');
function modelCompactWindow(s, model) {
  const want = bareModel(model); if (!want) return undefined;
  const hit = Object.entries(s.modelSettings || {}).find(([k]) => bareModel(k) === want || k === family(want));
  return hit ? hit[1]?.autoCompactWindow : undefined;
}
const flagOn = v => !!v && v !== '0' && v !== 'false';
function ctxLimits(modelWindow, account, model) {
  const s = accountSettings(account); const envOf = k => s.env?.[k] ?? process.env[k];
  const set = parseCompactWindow(envOf(COMPACT_ENV)) ?? parseCompactWindow(modelCompactWindow(s, model)) ?? parseCompactWindow(s.autoCompactWindow);
  const window = set ? Math.min(set, modelWindow) : modelWindow;
  const off = s.autoCompactEnabled === false || flagOn(envOf('DISABLE_AUTO_COMPACT')) || flagOn(envOf('DISABLE_COMPACT'));
  return { window, modelWindow, compactAt: off ? null : Math.max(0, window - COMPACT_BUFFER) };
}
const HOUR = 3600e3;
const FIVE_MIN = 300e3;
const CACHE_STATES = new Set(['idle', 'needs-you']);
const reachedApi = (u, model) => model !== '<synthetic>' && !!(u.input_tokens || u.output_tokens || u.cache_read_input_tokens || u.cache_creation_input_tokens);
const cacheTtlOf = u => { const c = u.cache_creation; return !c ? null : c.ephemeral_1h_input_tokens > 0 ? HOUR : c.ephemeral_5m_input_tokens > 0 ? FIVE_MIN : null; };
function switchedFamily(next, last) {
  const a = family(next), b = family(last);
  return a !== 'other' && b !== 'other' && a !== b;
}
function cacheOf(cl, now = Date.now()) {
  const u = cl.usage;
  if (!u || !u.cacheAt || u.pending || !CACHE_STATES.has(cl.state)) return null;
  if (u.compactAt > u.cacheAt || (cl.mode === 'chat' && switchedFamily(cl.model, u.cacheModel))) return { cold: true };
  const left = u.cacheAt + (u.cacheTtl || HOUR) - now;
  if (left <= 0) return { cold: true };
  return u.cacheTtl ? { cold: false, min: Math.ceil(left / 60e3) } : null;
}
function agentTypeOf(fp, r) {
  if (r.agentType) return r.agentType;
  const t = readJson(fp.replace(/\.jsonl$/, '.meta.json'), null)?.agentType;
  if (!t) return 'general-purpose';
  r.agentType = String(t); dirty = true;
  return r.agentType;
}
function learnWindow(model, n) { if (model && Number.isFinite(n) && n > 0) WINDOWS.set(String(model).replace(/\[.*$/, ''), n); }
function ctxWindow(model) {
  const m = String(model || '').replace(/\[.*$/, '');
  if (WINDOWS.has(m)) return WINDOWS.get(m);
  if (/\[1m\]/i.test(String(model || '')) || /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(m)) return 1e6;
  return 2e5;
}
async function scanFile(t) {
  const c = load(); const rec = c.files[t.fp] || (c.files[t.fp] = { offset: 0, lastReq: null, account: t.account, sessionId: t.sessionId, sub: !!t.sub, model: null, in: 0, out: 0, cr: 0, cw: 0, cost: 0, requests: 0, first: null, last: null, days: {}, models: {}, dayModels: {} });
  if (t.size < rec.offset) { Object.assign(rec, { offset: 0, lastReq: null, in: 0, out: 0, cr: 0, cw: 0, cost: 0, requests: 0, days: {}, models: {}, dayModels: {}, cacheAt: null, cacheTtl: null, cacheModel: null, compactAt: null }); } // truncated / rewritten
  if (t.size === rec.offset) return;
  const stream = fs.createReadStream(t.fp, { start: rec.offset, encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let consumed = rec.offset; let lastLen = 0; let lastBroken = false;
  for await (const line of rl) {
    const len = Buffer.byteLength(line, 'utf8') + 1; lastLen = len; lastBroken = false;
    if (!rec.sub && line.includes('"subtype":"compact_boundary"') && !line.includes('"type":"assistant"')) {
      let o; try { o = JSON.parse(line); } catch { lastBroken = true; consumed += len; continue; }
      if (o.type === 'system' && o.subtype === 'compact_boundary') { rec.ctx = ctxOfLine(o); rec.compactAt = Date.parse(o.timestamp) || rec.compactAt; }
    } else if (line.includes('"type":"assistant"') && line.includes('"usage"')) {
      let o; try { o = JSON.parse(line); } catch { lastBroken = true; consumed += len; continue; }
      const u = o.message?.usage; const req = o.requestId || o.message?.id;
      if (u && !rec.sub && !o.isSidechain && ctxOfLine(o)) rec.ctx = ctxOfLine(o);
      if (u && req && req !== rec.lastReq) {
        rec.lastReq = req; rec.requests++;
        const model = o.message.model || rec.model; rec.model = model;
        rec.in += u.input_tokens || 0; rec.out += u.output_tokens || 0; rec.cr += u.cache_read_input_tokens || 0; rec.cw += u.cache_creation_input_tokens || 0;
        const cost = costOf(u, model); rec.cost += cost;
        const ts = o.timestamp ? Date.parse(o.timestamp) : Date.now(); const day = dayOf(ts);
        if (!o.isSidechain && reachedApi(u, model)) { rec.cacheAt = ts; rec.cacheModel = model; rec.cacheTtl = cacheTtlOf(u) || rec.cacheTtl; }
        rec.days[day] = (rec.days[day] || 0) + cost;
        const mid = model || 'unknown'; rec.models[mid] = (rec.models[mid] || 0) + cost; const dm = rec.dayModels[day] || (rec.dayModels[day] = {}); dm[mid] = (dm[mid] || 0) + cost;
        if (!rec.first) rec.first = ts; rec.last = ts;
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

function cacheFields(fp, r) {
  const size = (() => { try { return fs.statSync(fp).size; } catch { return r.offset; } })();
  return { cacheAt: r.cacheAt || r.last, cacheTtl: r.cacheTtl || null, cacheModel: r.cacheModel || null, compactAt: r.compactAt || null, pending: size !== r.offset };
}
// One session = its main transcript + all its subagents (same sessionId), so the cost shown on a card is the whole bill.
function bySession(sessionId) {
  if (!sessionId) return null;
  let out = null; let main = null;
  for (const [fp, r] of Object.entries(load().files)) {
    if (r.sessionId !== sessionId) continue;
    if (!r.sub && (!main || (r.last || 0) > (main[1].last || 0))) main = [fp, r];
    if (!out) out = { cost: 0, in: 0, out: 0, cr: 0, cw: 0, requests: 0, model: null, first: null, last: null, ctx: null };
    out.cost += r.cost; out.in += r.in; out.out += r.out; out.cr += r.cr; out.cw += r.cw; out.requests += r.requests;
    if (!r.sub) out.model = r.model; else if (!out.model) out.model = r.model;
    if (r.first && (!out.first || r.first < out.first)) out.first = r.first;
    if (r.last && (!out.last || r.last > out.last)) out.last = r.last;
  }
  if (main) { if (main[1].ctx === undefined) { main[1].ctx = tailCtx(main[0]); dirty = true; } out.ctx = main[1].ctx; Object.assign(out, cacheFields(main[0], main[1])); }
  return out;
}
// For lib/recap.js: one record per MAIN transcript (it reads the file at the key), with the day costs of that
// session's subagents folded in. Subagent files themselves are not listed (they are not conversations).
function files() {
  const all = load().files; const subDays = {};
  for (const r of Object.values(all)) if (r.sub) { const d = subDays[r.sessionId] || (subDays[r.sessionId] = {}); for (const [k, v] of Object.entries(r.days || {})) d[k] = (d[k] || 0) + v; }
  const out = {};
  for (const [fp, r] of Object.entries(all)) {
    if (r.sub) continue; const sd = subDays[r.sessionId];
    if (!sd) { out[fp] = r; continue; }
    const days = { ...r.days }; for (const [k, v] of Object.entries(sd)) days[k] = (days[k] || 0) + v;
    out[fp] = { ...r, days, cost: r.cost + Object.values(sd).reduce((a, b) => a + b, 0) };
  }
  return out;
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

// Cost per model family per day, main threads vs subagents. Reports what the cache
// holds (the scan looks back LOOKBACK = 7 days); older days in a longer range are simply empty.
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'other'];
function family(model) { const m = String(model || '').toLowerCase(); if (m.includes('opus')) return 'opus'; if (m.includes('sonnet')) return 'sonnet'; if (m.includes('haiku')) return 'haiku'; if (m.includes('fable') || m.includes('mythos')) return 'fable'; return 'other'; }
const zeroFam = () => ({ opus: 0, sonnet: 0, haiku: 0, fable: 0, other: 0 });
function models(days = 7) {
  const n = Math.max(1, Math.min(30, Math.floor(+days) || 7)); const now = Date.now();
  const list = []; const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) { const d = new Date(d0); d.setDate(d.getDate() - i); list.push({ day: dayOf(d.getTime()), byFamily: zeroFam(), main: 0, sub: 0 }); }
  const idx = new Map(list.map((d, i) => [d.day, i]));
  const totals = { byFamily: zeroFam(), main: 0, sub: 0 }; const agents = new Map();
  for (const [fp, r] of Object.entries(load().files)) {
    const type = r.sub ? agentTypeOf(fp, r) : null;
    for (const [day, ms] of Object.entries(r.dayModels || {})) {
      const i = idx.get(day); if (i == null) continue; const d = list[i];
      for (const [mid, cost] of Object.entries(ms)) {
        const f = family(mid); d.byFamily[f] += cost; totals.byFamily[f] += cost;
        if (r.sub) {
          d.sub += cost; totals.sub += cost;
          const k = type + '|' + f; const a = agents.get(k) || { type, family: f, cost: 0 }; a.cost += cost; agents.set(k, a);
        } else { d.main += cost; totals.main += cost; }
      }
    }
  }
  return { days: list, totals, agents: [...agents.values()].sort((x, y) => y.cost - x.cost) };
}

module.exports = { scan, bySession, ctxWindow, learnWindow, parseCompactWindow, ctxLimits, cacheOf, summary, models, costOf, price, family, files };
