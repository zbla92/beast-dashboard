'use strict';
const fs = require('fs');
const { fromToolUse } = require('./awaited');

const CHUNK = 1024 * 1024;
const RATE = 16 * 1024 * 1024;
const BURST = 32 * 1024 * 1024;
const SMALL = 256 * 1024;
const MAX_FILES = 64;
const MAX_TASKS = 64;
const MAX_TOOLS = 256;
const MAX_AWAITED = 64;
const MONITOR_GRACE = 60e3;
const NOTE = /^\s*<task-notification>/;
const TASK_ID = /<task-id>\s*([A-Za-z0-9_-]{1,100})\s*<\/task-id>/;
const STATUS = /<status>\s*([a-z_]{1,40})\s*<\/status>/;
const STOPPERS = new Set(['TaskStop', 'KillShell', 'KillBash']);
const ID = /^[A-Za-z0-9_-]{1,100}$/;

const files = new Map();
const bucket = { left: BURST, at: Date.now() };
function allowance(now) { bucket.left = Math.min(BURST, bucket.left + Math.max(0, now - bucket.at) / 1000 * RATE); bucket.at = now; return bucket.left; }
const trim = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const fresh = ino => ({ ino, offset: 0, tasks: new Map(), tools: new Map(), awaited: new Set(), expires: new Map() });
const cap = (m, n) => { while (m.size > n) m.delete(m.keys().next().value); };
const idOf = v => typeof v === 'string' && ID.test(v) ? v : null;
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';

function readRange(fp, start, len) {
  const fd = fs.openSync(fp, 'r');
  try { const buf = Buffer.alloc(len); const n = fs.readSync(fd, buf, 0, len, start); return n < len ? buf.subarray(0, n) : buf; } finally { fs.closeSync(fd); }
}

function end(a, id) { if (!id) return; a.tasks.delete(id); a.expires.delete(id); }

function noted(a, text) {
  if (typeof text !== 'string' || !NOTE.test(text)) return;
  const id = text.match(TASK_ID); const status = text.match(STATUS);
  if (id && status) end(a, id[1]);
}

function mark(a, id) {
  a.awaited.delete(id); a.awaited.add(id); cap(a.awaited, MAX_AWAITED);
  const t = a.tasks.get(id); if (t) t.awaited = true;
}

function startOf(tool, r) {
  if (!r || typeof r !== 'object') return null;
  const name = tool ? tool.name : null;
  const bg = idOf(r.backgroundTaskId);
  if (bg) return { id: bg, kind: !name || name === 'Bash' ? 'shell' : 'task' };
  const agent = idOf(r.agentId);
  if (agent && r.isAsync) return { id: agent, kind: 'agent', description: r.description };
  const task = idOf(r.taskId);
  if (task) return { id: task, kind: name === 'Monitor' ? 'monitor' : 'task', ttl: name === 'Monitor' && !r.persistent && Number(r.timeoutMs) > 0 ? Number(r.timeoutMs) : 0 };
  return null;
}

function result(a, b, r, ts) {
  if (!b || b.type !== 'tool_result' || b.is_error) return;
  const tool = a.tools.get(b.tool_use_id) || null;
  if (tool && STOPPERS.has(tool.name)) { end(a, idOf(r && (r.task_id || r.shell_id)) || tool.stop); return; }
  const s = startOf(tool, r); if (!s || a.tasks.has(s.id)) return;
  const startedAt = ts || Date.now();
  a.tasks.set(s.id, { id: s.id, kind: s.kind, description: trim(s.description || (tool && tool.description) || s.id, 100), startedAt, toolUseId: idOf(b.tool_use_id), awaited: a.awaited.has(s.id), progress: null, owed: false });
  if (s.ttl) a.expires.set(s.id, startedAt + s.ttl + MONITOR_GRACE);
  cap(a.tasks, MAX_TASKS);
}

function absorb(a, line) {
  if (!line.includes('task-notification') && !line.includes('toolUseResult') && !line.includes('"tool_use"')) return;
  const o = (() => { try { return JSON.parse(line); } catch { return null; } })();
  if (!o || typeof o !== 'object' || o.isSidechain === true) return;
  if (o.type === 'queue-operation') { if (o.operation === 'enqueue') noted(a, o.content); return; }
  if (o.type === 'attachment') { if (o.attachment && o.attachment.type === 'queued_command') noted(a, textOf(o.attachment.prompt)); return; }
  const content = o.message && o.message.content;
  if (o.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (!b || b.type !== 'tool_use' || !idOf(b.id)) continue;
      const input = b.input && typeof b.input === 'object' ? b.input : {};
      a.tools.set(b.id, { name: String(b.name || ''), description: trim(input.description || input.command, 100), stop: idOf(input.task_id) || idOf(input.shell_id) });
      cap(a.tools, MAX_TOOLS);
      for (const id of fromToolUse(b)) mark(a, id);
    }
    return;
  }
  if (o.type !== 'user') return;
  if (!Array.isArray(content)) { noted(a, content); return; }
  const ts = o.timestamp ? Date.parse(o.timestamp) || 0 : 0;
  for (const b of content) {
    if (b && b.type === 'text') noted(a, b.text);
    else result(a, b, o.toolUseResult, ts);
  }
}

function scan(fp, a, size, left) {
  while (a.offset < size && left.n > 0) {
    const buf = readRange(fp, a.offset, Math.min(CHUNK, size - a.offset));
    if (!buf.length) return false;
    left.n -= buf.length;
    const nl = buf.lastIndexOf(10);
    if (nl < 0) { if (a.offset + buf.length >= size) return false; a.offset += buf.length; continue; }
    for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) if (line) absorb(a, line);
    a.offset += nl + 1;
  }
  return a.offset < size;
}

function read(fp, since = 0, now = Date.now(), budget = null) {
  if (typeof fp !== 'string' || !fp.endsWith('.jsonl')) return null;
  const st = (() => { try { return fs.statSync(fp); } catch { return null; } })();
  if (!st || !st.isFile()) return null;
  const known = files.get(fp);
  const a = known && known.ino === st.ino && st.size >= known.offset ? known : fresh(st.ino);
  files.delete(fp); files.set(fp, a); cap(files, MAX_FILES);
  const metered = budget == null && st.size - a.offset > SMALL;
  const left = { n: budget != null ? budget : metered ? allowance(Date.now()) : SMALL };
  const before = left.n;
  const behind = (() => { try { return scan(fp, a, st.size, left); } catch { return null; } })();
  if (metered) bucket.left -= before - left.n;
  if (behind !== false) return null;
  const out = [];
  for (const t of a.tasks.values()) {
    const exp = a.expires.get(t.id);
    if (exp && now > exp) { end(a, t.id); continue; }
    if (t.startedAt >= (since || 0)) out.push({ ...t });
  }
  return out;
}

function forSession(r, read_ = read) {
  if (!r || !r.transcriptPath) return null;
  const tasks = read_(r.transcriptPath, r.bootAt || r.askedAt || 0);
  if (!tasks) return null;
  const level = Array.isArray(r.stopIds) && r.stopAt ? new Set(r.stopIds) : null;
  return level ? tasks.filter(t => (t.kind !== 'agent' && t.kind !== 'task') || level.has(t.id) || Number(t.startedAt) >= r.stopAt) : tasks;
}

function forget(fp) { files.delete(fp); }

module.exports = { read, forSession, forget };
