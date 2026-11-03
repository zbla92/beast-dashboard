'use strict';
// Read the tail of a Claude Code transcript (<config>/projects/<cwd>/<session>.jsonl) as a list of turns for the
// dashboard: your prompts, Claude's text, and the tool calls in between (collapsed to one line each).
const fs = require('fs');
const crypto = require('crypto');
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
const blockText = b => b && b.type === 'text' && typeof b.text === 'string' ? b.text : '';
function splitShell(content) {
  if (!Array.isArray(content)) return { shells: [], text: textOf(content) };
  const shells = []; let i = 0;
  while (i + 1 < content.length && blockText(content[i]).startsWith('<bash-input>') && /^<bash-(stdout|stderr)>/.test(blockText(content[i + 1]))) {
    const out = blockText(content[i + 1]);
    shells.push({ cmd: tag(blockText(content[i]), 'bash-input'), out: (tag(out, 'bash-stdout') + '\n' + tag(out, 'bash-stderr')).trim() }); i += 2;
  }
  return { shells, text: textOf(content.slice(i)) };
}
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
  if (/^<local-command-caveat>|^<local-command-stdout>/.test(t)) return { kind: 'skip' };
  if (t.startsWith('<command-name>') || (t.startsWith('<command-message>') && t.includes('<command-name>'))) { const c = tag(t, 'command-name'); const a = tag(t, 'command-args'); return c ? { kind: 'prompt', text: (c + (a ? ' ' + a : '')).trim() } : { kind: 'skip' }; }
  t = t.replace(/<\/?pasted_content[^>]*>/g, '').trim();
  if (!t) return { kind: 'skip' };
  if (origin && origin !== 'human') return { kind: 'event', text: t.replace(/\s+/g, ' ').slice(0, 300), status: origin };   // some other synthetic input
  if (t.startsWith('<') && !origin) return { kind: 'skip' };                                                                  // unknown wrapper, older versions
  return { kind: 'prompt', text: t };
}

// Returns { turns, total, size, mtime, pending } with the LAST `n` turns.
// role: 'user' (you typed it), 'assistant', 'event' (a background agent finished, you interrupted, context compacted…),
// 'shell' (`!cmd`). An assistant turn is everything Claude did for one prompt, IN ORDER:
//   steps: [{ k: 'text', text } | { k: 'tool', id, name, what, done, error, …summary }], dur (ms, from turn_duration)
// Tool steps carry only a short summary; the full input/output of one call comes from tool() when it's opened, so
// the chat can poll this cheaply.
const base = p => String(p || '').split('/').pop();
const lines1 = s => (String(s || '').match(/\n/g) || []).length + (s ? 1 : 0);
function patchStats(sp) { let add = 0, del = 0; for (const hk of Array.isArray(sp) ? sp : []) for (const l of hk.lines || []) { if (l[0] === '+') add++; else if (l[0] === '-') del++; } return { add, del }; }
function toolSummary(b) {
  const inp = b.input || {}; const t = { k: 'tool', id: b.id, name: b.name, what: describeTool(b.name, inp), done: false };
  switch (b.name) {
    case 'Bash': case 'PowerShell': t.desc = trim(inp.description || '', 120); t.cmd = trim(inp.command, 240); if (inp.run_in_background) t.bg = true; break;
    case 'Read': t.file = inp.file_path; break;
    case 'Edit': t.file = inp.file_path; t.add = lines1(inp.new_string); t.del = lines1(inp.old_string); break;
    case 'MultiEdit': t.file = inp.file_path; break;
    case 'Write': t.file = inp.file_path; t.add = lines1(inp.content); break;
    case 'NotebookEdit': t.file = inp.notebook_path; break;
    case 'Grep': case 'Glob': t.pattern = trim(inp.pattern, 120); t.path = inp.path || ''; break;
    case 'Agent': case 'Task': t.desc = trim(inp.description || '', 120); t.sub = inp.subagent_type || ''; if (inp.run_in_background) t.bg = true; break;
    case 'WebSearch': t.query = trim(inp.query, 200); break;
    case 'WebFetch': t.url = trim(inp.url, 300); break;
    case 'AskUserQuestion': t.qs = (inp.questions || []).map(q => trim(q.question, 200)); t.qFull = (inp.questions || []).map(q => q.question); break;
    case 'TodoWrite': t.todos = (inp.todos || []).slice(0, 30).map(x => ({ c: trim(x.content || x.activeForm, 140), s: x.status })); break;
  }
  return t;
}
// fold a tool_result (+ the record's toolUseResult) into its tool step
function toolDone(t, b, tur) {
  t.done = true; t.error = !!b.is_error;
  if (!tur || typeof tur !== 'object') return;
  if (tur.patched) { t.add = tur.add; t.del = tur.del; }
  if (tur.type === 'create') t.created = true;
  if (tur.file && tur.file.numLines) t.lines = tur.file.numLines;
  if (tur.type === 'image') t.image = true;
  if (t.name === 'Bash' && tur.interrupted) t.error = true;
  if (t.name === 'AskUserQuestion' && tur.answers) t.answers = (t.qFull || []).map(q => trim(tur.answers[q] || '', 200));
  if ((t.name === 'Agent' || t.name === 'Task') && tur.isAsync) t.bg = true;
  if (typeof tur.numFiles === 'number') t.count = tur.numFiles; else if (typeof tur.numLines === 'number' && t.name === 'Grep') t.count = tur.numLines;
}

function readTail(file, max = TAIL) {
  let st; try { st = fs.statSync(file); } catch (e) { return null; }
  const len = Math.min(st.size, max); const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n'); if (st.size > max) lines.shift();   // first line is a fragment
  return { st, lines };
}

const MAX_WIN = 48 * 1024 * 1024;
const windowFor = n => Math.min(MAX_WIN, TAIL * 2 ** Math.max(0, Math.ceil(Math.log2(n / 40))));
const CACHE = new Map();
const CACHE_MAX = 8;
const NL = 10;

function slimResult(tur) {
  if (!tur || typeof tur !== 'object') return null;
  const r = {};
  if (Array.isArray(tur.structuredPatch) && tur.structuredPatch.length) Object.assign(r, patchStats(tur.structuredPatch), { patched: true });
  for (const k of ['type', 'interrupted', 'isAsync', 'numFiles', 'numLines']) if (tur[k] !== undefined) r[k] = tur[k];
  if (tur.file && tur.file.numLines) r.file = { numLines: tur.file.numLines };
  if (tur.answers) r.answers = tur.answers;
  return r;
}
function slim(o) {
  const link = { uuid: o.uuid, parentUuid: o.parentUuid, type: o.type, subtype: o.subtype };
  if (o.type === 'assistant') return o;
  if (o.type === 'system') return o.subtype === 'turn_duration' || o.subtype === 'compact_boundary' ? o : link;
  if (o.type === 'attachment') {
    const a = o.attachment; if (!a || a.type !== 'queued_command') return link;
    return { ...link, timestamp: o.timestamp, attachment: { type: a.type, origin: a.origin, commandMode: a.commandMode, prompt: Array.isArray(a.prompt) ? a.prompt.filter(b => b && b.type === 'text') : a.prompt } };
  }
  if (o.type !== 'user') return link;
  const c = o.message && o.message.content;
  if (Array.isArray(c) && c.length && c.every(b => b.type === 'tool_result')) {
    return { ...link, timestamp: o.timestamp, results: c.map(b => ({ id: b.tool_use_id, is_error: !!b.is_error })), tur: c.length === 1 ? slimResult(o.toolUseResult) : null };
  }
  return { ...link, timestamp: o.timestamp, origin: o.origin, isMeta: o.isMeta, isCompactSummary: o.isCompactSummary, message: { content: c } };
}

function records(file, win) {
  let st; try { st = fs.statSync(file); } catch (e) { return null; }
  const key = file + '|' + win; let c = CACHE.get(file + '|' + win);
  if (c && (c.ino !== st.ino || st.size < c.end || st.size - c.start > 2 * win)) c = null;
  if (!c) { const start = Math.max(0, st.size - win); c = { ino: st.ino, start, end: start, rest: Buffer.alloc(0), recs: [], fragment: start > 0 }; }
  CACHE.delete(key); CACHE.set(key, c); if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  if (st.size > c.end) {
    const len = st.size - c.end; const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, c.end); } finally { fs.closeSync(fd); }
    c.end = st.size;
    const all = c.rest.length ? Buffer.concat([c.rest, buf]) : buf; const cut = all.lastIndexOf(NL);
    c.rest = Buffer.from(cut < 0 ? all : all.subarray(cut + 1));
    if (cut >= 0) {
      const lines = all.subarray(0, cut).toString('utf8').split('\n');
      if (c.fragment) { lines.shift(); c.fragment = false; }
      for (const line of lines) {
        if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
        if (!o || o.isSidechain) continue;                             // subagent traffic
        c.recs.push(slim(o));
      }
    }
  }
  return { st, recs: c.recs, more: c.start > 0 };
}

const isToolResult = o => o.type === 'user' && Array.isArray(o.results);
const isPrompt = o => o.type === 'user' && !isToolResult(o) && !o.isMeta && !o.isCompactSummary && classifyUser(o, splitShell(o.message && o.message.content).text).kind === 'prompt';
function deadBranches(recs) {
  const by = new Map(), kids = new Map(), at = new Map(); let last = null;
  for (const o of recs) {
    if (!o.uuid) continue; by.set(o.uuid, o); at.set(o.uuid, at.size); last = o;
    if (o.parentUuid) { if (!kids.has(o.parentUuid)) kids.set(o.parentUuid, []); kids.get(o.parentUuid).push(o.uuid); }
  }
  const alive = new Set();
  for (let o = last; o && !alive.has(o.uuid); o = o.parentUuid ? by.get(o.parentUuid) : null) alive.add(o.uuid);
  const subtree = root => { const out = new Set(), stack = [root]; while (stack.length) { const u = stack.pop(); if (out.has(u)) continue; out.add(u); for (const k of kids.get(u) || []) stack.push(k); } return out; };
  const dead = new Set();
  for (const u of alive) {
    const ks = kids.get(u) || []; const live = ks.find(k => alive.has(k)); if (!live) continue;
    for (const k of ks) {
      if (alive.has(k) || !isPrompt(by.get(k))) continue;
      const branch = subtree(k);
      let end = -1; for (const x of branch) end = Math.max(end, at.get(x));
      if (end < at.get(live)) for (const x of branch) dead.add(x);
    }
  }
  return dead;
}

const hash = s => crypto.createHash('sha1').update(s).digest('base64url').slice(0, 12);
function tail(file, n = 40) {
  // A fresh session: SessionStart already gave us the path, but Claude Code writes the file only with the first
  // message -> an empty conversation (the chat opens and you can type the first prompt there), not an error.
  const rr = records(file, windowFor(n)); if (!rr) return { total: 0, turns: [], size: 0, mtime: 0, pending: null, empty: true, sig: 'empty' }; const { st, recs } = rr;
  const dead = deadBranches(recs);
  const turns = []; let cur = null; const byId = new Map(); let startAt = null, openA = null;
  const push = t => { turns.push(t); cur = null; };
  const userTurn = (o, k, ts, extra) => {
    if (k.kind === 'skip') return;
    if (k.kind === 'event') {
      if (k.status === 'interrupted') { if (openA && ts) openA.stopped = Math.max(0, ts - (startAt || openA.ts || ts)); openA = null; }
      else if (!openA) startAt = ts;
      push({ role: 'event', id: o.uuid, ts, text: trim(k.text, 400), status: k.status }); return;
    }
    if (k.kind === 'shell') { push({ role: 'shell', id: o.uuid, ts, text: trim(k.text, 400), out: '' }); return; }
    if (k.kind === 'shell-out') { const last = turns[turns.length - 1]; if (last && last.role === 'shell') last.out = trim(k.text, 2000); return; }
    const last = turns[turns.length - 1];
    if (extra && last && last.role === 'user' && last.text === trim(k.text, 4000)) return;
    if (!openA) startAt = ts;
    push({ role: 'user', id: o.uuid, ts, text: trim(k.text, 4000), ...extra });
  };
  for (const o of recs) {
    if (o.uuid && dead.has(o.uuid)) continue;
    const ts = o.timestamp ? Date.parse(o.timestamp) : null;
    if (o.type === 'system') {
      if (o.subtype === 'turn_duration') { const last = turns[turns.length - 1]; const a = openA || (last && last.role === 'assistant' ? last : null); if (a && o.durationMs) a.dur = +o.durationMs; openA = null; }
      else if (o.subtype === 'compact_boundary') push({ role: 'event', id: o.uuid, ts, text: 'context compacted' + (o.compactMetadata?.trigger === 'auto' ? ' (auto)' : ''), status: 'compacted' });
      continue;
    }
    if (o.type === 'attachment' && o.attachment) {
      const a = o.attachment; const human = (a.origin && a.origin.kind === 'human') || (!a.origin && a.commandMode === 'prompt');
      const sp = splitShell(Array.isArray(a.prompt) ? a.prompt : String(a.prompt || ''));
      sp.shells.forEach((x, i) => { push({ role: 'shell', id: o.uuid + '#s' + i, ts, text: trim(x.cmd, 400), out: trim(x.out, 2000) }); });
      if (!sp.shells.length || sp.text.trim()) userTurn(o, classifyUser({ origin: a.origin || (human ? { kind: 'human' } : null) }, sp.text), ts, human ? { queued: true } : undefined);
      continue;
    }
    if (o.type === 'user') {
      if (o.isMeta || o.isCompactSummary) continue;              // the compaction summary itself: the boundary event stands for it
      // tool results come back as user messages: fold them into their tool step
      if (isToolResult(o)) { for (const b of o.results) { const t = byId.get(b.id); if (t) toolDone(t, b, o.tur); } continue; }
      const sp = splitShell(o.message.content);
      sp.shells.forEach((x, i) => { push({ role: 'shell', id: o.uuid + '#s' + i, ts, text: trim(x.cmd, 400), out: trim(x.out, 2000) }); });
      if (!sp.shells.length || sp.text.trim()) userTurn(o, classifyUser(o, sp.text), ts);
    } else if (o.type === 'assistant') {
      const blocks = Array.isArray(o.message && o.message.content) ? o.message.content : [];
      if (!blocks.some(b => (b.type === 'text' && b.text && b.text.trim()) || b.type === 'tool_use')) continue;   // thinking only (stored without text)
      // everything Claude does for one prompt (streamed lines, tool rounds) is one turn, in order
      const last = turns[turns.length - 1];
      if (!cur && last && last.role === 'assistant') cur = last;
      if (!cur) { cur = { role: 'assistant', id: o.uuid, ts, steps: [] }; turns.push(cur); }
      if (!cur.dur && !cur.stopped) openA = cur;
      for (const b of blocks) {
        if (b.type === 'text' && b.text && b.text.trim()) {
          const prev = cur.steps[cur.steps.length - 1];
          if (prev && prev.k === 'text') { if (prev.text.length < 12000) prev.text = trim(prev.text + '\n\n' + b.text, 12000); } else cur.steps.push({ k: 'text', text: trim(b.text, 12000) });
        } else if (b.type === 'tool_use' && !byId.has(b.id)) { const t = toolSummary(b); byId.set(b.id, t); cur.steps.push(t); }
      }
    }
  }
  // a tool call still waiting for its result at the end of the transcript = Claude is executing it right now (an
  // independent "working" signal for the chat, next to hooks and the pane). Only while the file is fresh, so a call
  // that never got its result (crash, killed session) doesn't spin forever.
  const lastT = turns[turns.length - 1];
  const running = lastT && lastT.role === 'assistant' ? lastT.steps.filter(x => x.k === 'tool' && !x.done) : [];
  const fresh = Date.now() - st.mtimeMs < 30 * 60e3;
  if (!fresh) for (const x of running) x.stale = true;
  for (const t of turns) if (t !== lastT && t.steps) for (const x of t.steps) if (x.k === 'tool' && !x.done) x.stale = true;   // never got its result (crash, resume)
  for (const t of turns) for (const x of t.steps || []) delete x.qFull;
  const pending = running.length && fresh ? running[running.length - 1].what || running[running.length - 1].name : null;
  const open = lastT && (lastT.role === 'user' || (lastT.role === 'assistant' && !lastT.dur && !lastT.stopped));
  const since = open && fresh ? startAt : null;
  const shown = turns.slice(-n);
  for (const t of shown) t.h = hash(JSON.stringify(t));
  const sig = hash(shown.map(t => t.h).join(',') + '|' + turns.length + '|' + (pending || '') + '|' + rr.more + '|' + since);
  return { total: turns.length, turns: shown, size: st.size, mtime: st.mtimeMs, pending, since, more: rr.more, sig };
}
// text of an assistant turn (handoff, notifications): its text steps joined
const turnText = t => (t.steps || []).filter(x => x.k === 'text').map(x => x.text).join('\n\n');

// Everything about ONE tool call, for when it's opened in the chat: full command + output, the diff, an agent's
// prompt + answer, or the raw input/result for anything else.
function headTail(s, n) { s = String(s || ''); if (s.length <= n) return s; const k = Math.floor(n / 2); return s.slice(0, k) + `\n\n… ${s.length - n} characters left out …\n\n` + s.slice(-k); }
function tool(file, id) {
  const rt = readTail(file, 32 * 1024 * 1024);   // only on a click: look further back than the chat window (screenshots bloat files)
  if (!rt) return { error: 'no transcript' };
  let use = null, res = null, tur = null;
  for (const line of rt.lines) {
    if (!line.includes(id)) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    for (const b of (o.message && Array.isArray(o.message.content) ? o.message.content : [])) {
      if (b.type === 'tool_use' && b.id === id) use = b;
      if (b.type === 'tool_result' && b.tool_use_id === id) { res = b; tur = o.message.content.length === 1 ? o.toolUseResult : null; }
    }
  }
  if (!use) return { error: 'tool call not found' };
  const inp = use.input || {}; const out = { id, name: use.name, done: !!res, error: !!(res && res.is_error) };
  const resText = res ? textOf(res.content) : '';
  switch (use.name) {
    case 'Bash': case 'PowerShell':
      out.cmd = trim(inp.command, 6000); out.desc = inp.description || '';
      { const so = tur && typeof tur === 'object' ? [tur.stdout, tur.stderr].filter(Boolean).join('\n').trim() : ''; out.out = headTail(so || resText, 12000); } break;   // background / timed-out: the message is only in the result text
    case 'Edit': case 'Write': case 'MultiEdit': {
      out.file = inp.file_path; const sp = tur && Array.isArray(tur.structuredPatch) ? tur.structuredPatch : null;
      if (sp && sp.length) { let n = 0; out.hunks = []; for (const hk of sp) { if (n >= 600) break; const ls = (hk.lines || []).slice(0, 600 - n); n += ls.length; out.hunks.push({ o: hk.oldStart, n: hk.newStart, lines: ls.map(l => l.length > 400 ? l.slice(0, 400) + '…' : l) }); } out.more = sp.reduce((a, hk) => a + (hk.lines || []).length, 0) > n; }
      else if (use.name === 'Write') out.hunks = [{ o: 0, n: 1, lines: String(inp.content || '').split('\n').slice(0, 600).map(l => '+' + l) }];
      else if (use.name === 'Edit') out.hunks = [{ o: 0, n: 0, lines: [...String(inp.old_string || '').split('\n').map(l => '-' + l), ...String(inp.new_string || '').split('\n').map(l => '+' + l)].slice(0, 600) }];
      if (res && res.is_error) out.out = trim(resText, 2000);
      break; }
    case 'Agent': case 'Task':
      out.desc = inp.description || ''; out.sub = inp.subagent_type || ''; out.prompt = trim(inp.prompt, 8000);
      out.out = tur && tur.isAsync ? 'Running in the background — its answer arrives later as a "finished" line in the chat.' : trim(resText, 20000); break;
    case 'AskUserQuestion':
      out.qa = (inp.questions || []).map(q => ({ q: q.question, a: tur && tur.answers ? tur.answers[q.question] || '' : '', opts: (q.options || []).map(x => x.label) })); break;
    default:
      out.input = trim(JSON.stringify(inp, null, 2), 6000); out.out = headTail(resText, 12000);
      if (res && Array.isArray(res.content) && res.content.some(b => b.type === 'image')) out.image = true;
  }
  return out;
}

module.exports = { tail, tool, turnText, classifyUser, splitShell };
