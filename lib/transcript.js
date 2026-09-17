'use strict';
// Read the tail of a Claude Code transcript (<config>/projects/<cwd>/<session>.jsonl) as a list of turns for the
// dashboard: your prompts, Claude's text, and the tool calls in between (collapsed to one line each).
const fs = require('fs');
const { describeTool } = require('./claude');

const TAIL = 3 * 1024 * 1024;   // read at most the last 3 MB — enough for dozens of turns even with big tool results
const trim = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
}

// Returns { turns: [{ role, ts, text, tools: [{ name, what }], id }], total } with the LAST `n` turns.
function tail(file, n = 40) {
  let st; try { st = fs.statSync(file); } catch (e) { return { error: 'no transcript' }; }
  const len = Math.min(st.size, TAIL); const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
  let lines = buf.toString('utf8').split('\n'); if (st.size > TAIL) lines.shift();   // first line is a fragment
  const turns = []; let cur = null; const seenReq = new Set();
  const push = t => { turns.push(t); cur = null; };
  for (const line of lines) {
    if (!line || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;                                   // subagent traffic
    const ts = o.timestamp ? Date.parse(o.timestamp) : null; const m = o.message || {};
    if (o.type === 'user') {
      if (o.isMeta) continue;
      const c = m.content;
      // tool results come back as user messages: fold them into the current assistant turn as "done"
      if (Array.isArray(c) && c.length && c.every(b => b.type === 'tool_result')) {
        if (cur) for (const b of c) { const t = cur.tools.find(x => x.id === b.tool_use_id); if (t) { t.done = true; t.error = !!b.is_error; const r = textOf(b.content); if (r) t.result = trim(r.replace(/\s+/g, ' '), 160); } }
        continue;
      }
      let text = textOf(c).replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/g, '').replace(/<command-name>[\s\S]*$/g, '').trim();
      if (!text || text.startsWith('<') && text.includes('system-reminder')) continue;
      if (/^<command-message>|^<local-command-stdout>/.test(text)) continue;
      push({ role: 'user', ts, text: trim(text, 4000), tools: [] });
    } else if (o.type === 'assistant') {
      const req = o.requestId || m.id;
      const blocks = Array.isArray(m.content) ? m.content : [];
      // streamed responses are written in several lines per request: merge into one turn
      if (!cur || cur.role !== 'assistant' || (req && cur.req && cur.req !== req && turns[turns.length - 1] !== cur)) { cur = { role: 'assistant', ts, text: '', tools: [], req, model: m.model }; turns.push(cur); }
      for (const b of blocks) {
        if (b.type === 'text' && b.text) cur.text += (cur.text ? '\n' : '') + b.text;
        else if (b.type === 'tool_use') { if (!cur.tools.some(t => t.id === b.id)) { const tl = { id: b.id, name: b.name, what: describeTool(b.name, b.input), done: false };
          const inp = b.input || {};
          if (b.name === 'Edit' && typeof inp.old_string === 'string') tl.diff = { old: trim(inp.old_string, 1200), new: trim(inp.new_string || '', 1200), file: inp.file_path };
          else if (b.name === 'Write' && typeof inp.content === 'string') tl.diff = { old: '', new: trim(inp.content, 1200), file: inp.file_path };
          else if (b.name === 'Bash' && inp.command) tl.cmd = trim(inp.command, 400);
          cur.tools.push(tl); } }
      }
      cur.text = trim(cur.text, 6000);
    }
  }
  // consecutive assistant turns with no user turn between them (one prompt, many tool rounds) collapse into one
  const merged = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (t.role === 'assistant' && last && last.role === 'assistant') { last.text += (t.text ? (last.text ? '\n\n' : '') + t.text : ''); last.tools.push(...t.tools); last.ts = t.ts || last.ts; }
    else merged.push({ ...t, tools: [...t.tools] });
  }
  for (const t of merged) delete t.req;
  return { total: merged.length, turns: merged.slice(-n), size: st.size };
}

module.exports = { tail };
