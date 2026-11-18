'use strict';
// Subagents of a Claude session, from <transcript>/subagents/agent-*.jsonl + .meta.json.
// The list reads each file incrementally (byte offset + accumulators, keyed by path and invalidated on shrink), so a
// poll every few seconds costs one stat per agent. The detail view reads only the head (prompt) and the tail (steps, result).
const fs = require('fs');
const path = require('path');
const { describeTool } = require('./claude');
const usage = require('./usage');

const RUNNING_MS = 10 * 60e3;
const CHUNK = 2 * 1024 * 1024;
const LOOKBACK = 7 * 86400e3;        // same as usage.js: older subagent files are not listed
const BUDGET = 8 * 1024 * 1024;       // bytes parsed synchronously per forSession() call; the rest continues on the next call (partial: true)
const trim = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n') : '';

const ACC = new Map();   // file path -> accumulator
function fresh() { return { offset: 0, lastReq: null, first: null, last: null, tools: new Set(), tin: 0, tout: 0, tcr: 0, tcw: 0, cost: 0, models: {}, reqs: {}, endTurn: false, hasMsg: false }; }

function readRange(fp, start, len) {
  const fd = fs.openSync(fp, 'r');
  try { const buf = Buffer.alloc(len); const n = fs.readSync(fd, buf, 0, len, start); return n < len ? buf.subarray(0, n) : buf; } finally { fs.closeSync(fd); }
}

function absorb(a, line) {
  let o; try { o = JSON.parse(line); } catch { return; }
  const ts = o.timestamp ? Date.parse(o.timestamp) : null;
  if (ts) { if (!a.first) a.first = ts; a.last = ts; }
  const m = o.message || {};
  if (o.type === 'assistant') {
    a.hasMsg = true; a.endTurn = m.stop_reason === 'end_turn';
    for (const b of Array.isArray(m.content) ? m.content : []) if (b && b.type === 'tool_use' && b.id) a.tools.add(b.id);
    const u = m.usage; const req = o.requestId || m.id;
    if (u && req && req !== a.lastReq) {
      a.lastReq = req; a.tin += u.input_tokens || 0; a.tout += u.output_tokens || 0; a.tcr += u.cache_read_input_tokens || 0; a.tcw += u.cache_creation_input_tokens || 0;
      const c = usage.costOf(u, m.model); a.cost += c; const k = m.model || 'unknown'; a.models[k] = (a.models[k] || 0) + c; a.reqs[k] = (a.reqs[k] || 0) + 1;
    }
  } else if (o.type === 'user') { a.hasMsg = true; a.endTurn = false; }
}

function scanAgent(fp, st, budget) {
  let a = ACC.get(fp);
  if (!a || st.size < a.offset) { a = fresh(); ACC.set(fp, a); }
  while (a.offset < st.size && budget.left > 0) {
    const buf = readRange(fp, a.offset, Math.min(CHUNK, st.size - a.offset));
    if (!buf.length) break;
    budget.left -= buf.length;
    const nl = buf.lastIndexOf(10);
    if (nl < 0) { if (a.offset + buf.length >= st.size) break; /* a single line bigger than the chunk: skip past it */ a.offset += buf.length; continue; }
    for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) if (line) absorb(a, line);
    a.offset += nl + 1;
  }
  return a;
}

const subDir = tp => String(tp || '').endsWith('.jsonl') ? tp.slice(0, -6) + '/subagents' : null;
const readMeta = fp => { try { return JSON.parse(fs.readFileSync(fp.replace(/\.jsonl$/, '.meta.json'), 'utf8')) || {}; } catch { return {}; } };
const topModel = reqs => Object.entries(reqs).sort((x, y) => y[1] - x[1])[0]?.[0] || null;   // most requests, not most cost

function forSession(transcriptPath) {
  const dir = subDir(transcriptPath);
  const sessionId = transcriptPath ? path.basename(transcriptPath, '.jsonl') : null;
  const out = { sessionId, agents: [] };
  let names; try { names = fs.readdirSync(dir); } catch { return out; }
  const live = new Set(); const budget = { left: BUDGET }; const cutoff = Date.now() - LOOKBACK;
  for (const f of names) {
    const m = f.match(/^agent-([a-z0-9]+)\.jsonl$/); if (!m) continue;
    const fp = path.join(dir, f); let st; try { st = fs.statSync(fp); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    live.add(fp);
    let a; try { a = scanAgent(fp, st, budget); } catch { continue; }
    if (a.offset < st.size) out.partial = true;
    const meta = readMeta(fp); const modelId = topModel(a.reqs);
    const fam = usage.family(modelId || meta.model);
    const type = meta.agentType || 'general-purpose';
    const flag = fam === 'opus' && type === 'Explore' ? 'Explore on Opus — a smaller model is usually enough' : fam === 'opus' && type === 'general-purpose' ? 'general-purpose on Opus' : null;
    out.agents.push({
      agentId: m[1], type, description: meta.description || '', model: meta.model || null, modelId, background: meta.requestShape === 'background',
      startedAt: a.first || st.birthtimeMs || st.mtimeMs, lastAt: a.last || st.mtimeMs,
      running: a.hasMsg ? !a.endTurn && Date.now() - st.mtimeMs < RUNNING_MS : Date.now() - st.mtimeMs < RUNNING_MS,
      done: !!(a.hasMsg && a.endTurn),
      tools: a.tools.size, tokens: { in: a.tin, out: a.tout, cr: a.tcr, cw: a.tcw }, cost: a.cost, flag,
    });
  }
  for (const k of [...ACC.keys()]) if (k.startsWith(dir + '/') && !live.has(k)) ACC.delete(k);
  out.agents.sort((x, y) => x.startedAt - y.startedAt);
  return out;
}

function agentDetail(transcriptPath, agentId) {
  const dir = subDir(transcriptPath);
  if (!dir || !/^[a-z0-9]+$/.test(String(agentId))) return { error: 'no such agent' };
  const fp = path.join(dir, `agent-${agentId}.jsonl`); let st; try { st = fs.statSync(fp); } catch { return { error: 'no such agent' }; }
  const meta = readMeta(fp);
  // prompt: the first user line, within the first 512 KB
  let prompt = '';
  try {
    const head = readRange(fp, 0, Math.min(st.size, 512 * 1024)).toString('utf8').split('\n');
    for (const line of head) {
      if (!line.includes('"type":"user"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'user') { prompt = textOf(o.message && o.message.content); break; }
    }
  } catch {}
  // steps + result: the tail (3 MB)
  const steps = []; let result = '';
  try {
    const len = Math.min(st.size, 3 * 1024 * 1024); const lines = readRange(fp, st.size - len, len).toString('utf8').split('\n'); if (st.size > len) lines.shift();
    for (const line of lines) {
      if (!line.includes('"type":"assistant"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant') continue;
      for (const b of Array.isArray(o.message && o.message.content) ? o.message.content : []) {
        if (b.type === 'text' && b.text && b.text.trim()) steps.push({ k: 'text', text: trim(b.text, 2000) });
        else if (b.type === 'tool_use') steps.push({ k: 'tool', name: b.name, summary: trim(describeTool(b.name, b.input || {}), 200) });
      }
    }
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i].k === 'text') { result = steps[i].text; break; }
    // the stored step text is cut at 2000; take the full last text for the result
    const lastText = [...lines].reverse().find(l => l.includes('"type":"assistant"') && l.includes('"type":"text"'));
    if (lastText) { try { const o = JSON.parse(lastText); const t = textOf(o.message && o.message.content); if (t.trim()) result = t; } catch {} }
  } catch {}
  return { agentId, type: meta.agentType || 'general-purpose', description: meta.description || '', prompt: trim(prompt, 8000), result: trim(result, 8000), steps: steps.slice(-60) };
}

module.exports = { forSession, agentDetail };
