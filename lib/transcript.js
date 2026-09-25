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

// What a `type:"user"` record really is. Claude Code writes much more than your prompts as user records: background
// agent / command completions (origin.kind "task-notification", <task-notification> payload), "[Request interrupted
// by user]", `!` shell commands and their output, slash commands, pasted-content wrappers, system reminders.
// Only origin.kind "human" (or, in older versions without origin, plain text) is something you typed.
//   -> { kind: 'prompt' | 'event' | 'shell' | 'shell-out' | 'skip', text, status }
const tag = (t, name) => { const m = t.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>')); return m ? m[1].trim() : ''; };
function classifyUser(o, raw) {
  let t = String(raw || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const origin = o.origin && o.origin.kind;
  if (origin === 'task-notification' || t.startsWith('<task-notification>')) {
    const status = tag(t, 'status'); const summary = tag(t, 'summary') || tag(t, 'description') || 'background task finished';
    return { kind: 'event', text: summary.replace(/\s+/g, ' '), status: status || null };
  }
  if (/^\[Request interrupted by user/.test(t)) return { kind: 'event', text: 'interrupted', status: 'interrupted' };
  if (t.startsWith('<bash-input>')) return { kind: 'shell', text: tag(t, 'bash-input') };
  if (t.startsWith('<bash-stdout>') || t.startsWith('<bash-stderr>')) return { kind: 'shell-out', text: (tag(t, 'bash-stdout') + '\n' + tag(t, 'bash-stderr')).trim() };
  if (/^<local-command-caveat>|^<local-command-stdout>|^<command-message>/.test(t)) return { kind: 'skip' };
  if (t.startsWith('<command-name>')) { const c = tag(t, 'command-name'); const a = tag(t, 'command-args'); return c ? { kind: 'prompt', text: (c + (a ? ' ' + a : '')).trim() } : { kind: 'skip' }; }
  t = t.replace(/<\/?pasted_content[^>]*>/g, '').trim();
  if (!t) return { kind: 'skip' };
  if (origin && origin !== 'human') return { kind: 'event', text: t.replace(/\s+/g, ' ').slice(0, 300), status: origin };   // some other synthetic input
  if (t.startsWith('<') && !origin) return { kind: 'skip' };                                                                  // unknown wrapper, older versions
  return { kind: 'prompt', text: t };
}

// Returns { turns: [{ role, ts, text, tools: [{ name, what }], id }], total } with the LAST `n` turns.
// role: 'user' (you typed it), 'assistant', 'event' (a background agent finished, you interrupted, …), 'shell' (`!cmd`).
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
      const k = classifyUser(o, textOf(c));
      if (k.kind === 'skip') continue;
      if (k.kind === 'event') { push({ role: 'event', ts, text: trim(k.text, 400), status: k.status, tools: [] }); continue; }
      if (k.kind === 'shell') { push({ role: 'shell', ts, text: trim(k.text, 400), out: '', tools: [] }); continue; }
      if (k.kind === 'shell-out') { const last = turns[turns.length - 1]; if (last && last.role === 'shell') last.out = trim(k.text, 2000); continue; }
      push({ role: 'user', ts, text: trim(k.text, 4000), tools: [] });
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
  // a tool call still waiting for its result at the end of the transcript = Claude is executing it right now (an
  // independent "working" signal for the chat, next to hooks and the pane). Only while the file is fresh, so a call
  // that never got its result (crash, killed session) doesn't spin forever.
  const last = merged[merged.length - 1];
  const running = last && last.role === 'assistant' ? last.tools.filter(x => !x.done) : [];
  const pending = running.length && Date.now() - st.mtimeMs < 30 * 60e3 ? running[running.length - 1].what || running[running.length - 1].name : null;
  return { total: merged.length, turns: merged.slice(-n), size: st.size, mtime: st.mtimeMs, pending };
}

module.exports = { tail, classifyUser };
