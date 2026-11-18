'use strict';
// Claude Code sessions: what each one is doing right now.
//
// Two sources, merged:
//   1. Hooks. bin/claude-hook.sh (wired into ~/.claude/settings.json and ~/.claude-company/settings.json)
//      POSTs every hook event to /api/hook with the tmux session name in a header. That gives exact
//      transitions: prompt submitted -> working, tool call -> working (+ which tool), Stop -> needs you,
//      PermissionRequest / Notification(permission_prompt) -> permission, StopFailure -> error.
//   2. The pane. `tmux capture-pane` of the last lines of every claude-* session, every tick. Used for
//      the "peek" on the cards, for the unsent draft in the prompt box, and as a fallback state when
//      hooks are missing (sessions started before the hooks existed, or a lost event): Claude Code's
//      status line says "esc to interrupt" while it works, and the prompt box "❯" shows when it waits.
//
// Records are keyed by tmux session name (that is the dashboard's identity for a session) and persisted
// to state/claude-sessions.json so they survive a dashboard restart — and so that after a reboot the
// dashboard knows which sessions existed (cwd, account, Claude session id) and can restore them.
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, STATE, titleFromPrompt } = require('./util');
const { describeTool } = require('./tooldesc');
const { isApi } = require('./providers');
const { fromNotification } = require('./donepush');

const FILE = path.join(STATE, 'claude-sessions.json');
const GONE_TTL = 3 * 86400e3;   // forget sessions that vanished more than 3 days ago
let store = null;
let saveTimer = null;
const listeners = [];           // (event, rec, prev) => void   — push notifications hang off this

// BD_MIRROR=<live state dir> (test copies only — a design preview): hooks post to the live dashboard, so follow its
// session store read-only (re-read on change, never written) instead of keeping a stale copy.
const MIRROR = process.env.BD_TEST === '1' && process.env.BD_MIRROR ? path.join(process.env.BD_MIRROR, 'claude-sessions.json') : null;
if (MIRROR) { let seen = 0; setInterval(() => { try { const t = fs.statSync(MIRROR).mtimeMs; if (t !== seen) { seen = t; store = readJson(MIRROR, store || {}); } } catch {} }, 1000).unref(); }
function load() { if (!store) store = readJson(MIRROR || FILE, {}); return store; }
function save() { if (MIRROR) return; if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; try { writeJson(FILE, store); } catch (e) { console.error('claude store save failed', e); } }, 500); }
function onChange(fn) { listeners.push(fn); }

const STATES = ['working', 'background', 'permission', 'needs-you', 'error', 'limit', 'idle', 'ended', 'unknown'];
const NEEDS_YOU = new Set(['needs-you', 'permission', 'error', 'limit']);
const trim = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

let bgLogged = false;
const isActiveTask = t => { const st = t.status ?? t.state; return st == null || st === 'running'; };
const bgTaskOf = t => ({ status: trim(t.status ?? t.state ?? 'running', 20), id: trim(t.id ?? t.task_id ?? t.taskId, 80), type: trim(t.type ?? t.task_type ?? t.taskType ?? t.kind, 40), description: trim(t.description ?? t.summary ?? t.prompt ?? t.name ?? t.command, 100) });
// a background task that is a shell command (type local_bash / bash / shell, or a bash task id 'b…') rather than an agent
function isShellTask(t) {
  if (!t || typeof t !== 'object') return false;
  const ty = String(t.type ?? t.task_type ?? t.taskType ?? t.kind ?? '');
  if (ty) return /bash|shell/i.test(ty);
  return /^b[a-z0-9]{6,}$/.test(String(t.id ?? t.task_id ?? t.taskId ?? ''));
}

// Files Claude edited (Edit / Write / NotebookEdit / MultiEdit): newest first, one entry per path, capped.
function touch(r, tool, input, ts) {
  if (!['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(tool)) return;
  const p = input && (input.file_path || input.notebook_path); if (!p) return;
  r.touched = (r.touched || []).filter(t => t.path !== p); r.touched.unshift({ path: p, tool, at: ts }); if (r.touched.length > 150) r.touched.length = 150;
}
function setLabel(name, label) { const s = load(); const r = s[name] || rec(name); r.label = String(label || '').trim().slice(0, 60) || null; save(); return { ok: true, label: r.label }; }
function rec(tmux) {
  const s = load();
  if (!s[tmux]) s[tmux] = { tmux, account: null, sessionId: null, cwd: null, transcriptPath: null, state: 'unknown', since: Date.now(), firstSeen: Date.now(), lastEvent: null, lastEventAt: 0, lastTool: null, lastPrompt: null, lastMessage: null, title: null, model: null, gone: null };
  return s[tmux];
}
function setTranscript(r, t) {
  const past = (r.pastTranscripts || []).filter(x => x !== t && x !== r.transcriptPath);
  r.pastTranscripts = (r.transcriptPath && r.transcriptPath !== t ? [r.transcriptPath, ...past] : past).slice(0, 20);
  r.transcriptPath = t || null;
}
function transcriptsOf(name) { const r = load()[name]; if (!r) return []; return [...new Set([r.transcriptPath, ...(r.pastTranscripts || [])].filter(Boolean))]; }
function runnerOf(o) {
  if (!o || typeof o !== 'object') return null;
  const str = v => typeof v === 'string' && v ? v.slice(0, 200) : null;
  const abs = v => typeof v === 'string' && path.isAbsolute(v) && v.length <= 4096 ? v : null;
  return { permissionMode: str(o.permissionMode), model: str(o.model), effort: str(o.effort), addDirs: Array.isArray(o.addDirs) ? o.addDirs.filter(d => typeof d === 'string' && path.isAbsolute(d)).slice(0, 40) : [], exitAfterResult: o.exitAfterResult === true, ...(str(o.provider) ? { provider: str(o.provider) } : {}), ...(abs(o.accesses) ? { accesses: abs(o.accesses) } : {}), ...(abs(o.settings) ? { settings: abs(o.settings) } : {}) };
}
function setRunner(name, runner) { const r = load()[name]; if (!r) return null; r.runner = runnerOf(runner); save(); return r.runner; }
function markChat(name, f) {
  const r = rec(name);
  setTranscript(r, f.transcriptPath);
  Object.assign(r, { mode: 'chat', cwd: f.cwd, account: f.account, sessionId: f.sessionId, forkFrom: /^[0-9a-f-]{36}$/.test(f.forkFrom || '') ? f.forkFrom : null, gone: null });
  if (f.firstPrompt) r.firstPrompt = titleFromPrompt(String(f.firstPrompt)).slice(0, 200);
  if (f.specialist !== undefined) r.specialist = typeof f.specialist === 'string' && f.specialist ? f.specialist : null;
  if (f.runner !== undefined) r.runner = runnerOf(f.runner);
  if (r.state === 'unknown' || r.state === 'ended') setState(r, 'idle');
  save();
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
function conversationOf(r) {
  if (!r) return null;
  const t = r.mode === 'chat' && r.transcriptPath ? path.basename(r.transcriptPath, '.jsonl') : null;
  if (!t || !UUID.test(t) || t === r.sessionId) return r.sessionId || null;
  const now = mtime(r.transcriptPath), was = UUID.test(r.sessionId || '') ? mtime(path.join(path.dirname(r.transcriptPath), r.sessionId + '.jsonl')) : 0;
  return now && now >= was ? t : r.sessionId || null;
}
function followChat(name, sessionId) {
  const r = load()[name];
  if (!r || r.mode !== 'chat' || !UUID.test(sessionId || '') || r.sessionId === sessionId) return false;
  r.sessionId = sessionId; r.forkFrom = null;
  if (r.transcriptPath && path.basename(r.transcriptPath) !== sessionId + '.jsonl') setTranscript(r, path.join(path.dirname(r.transcriptPath), sessionId + '.jsonl'));
  save();
  return true;
}
let liveOf = () => null;
function setLive(fn) { liveOf = fn; }
let projectOf = () => null;
function setProjects(fn) { projectOf = fn; }
function projectsOf(r) {
  if (!r) return [];
  const n = new Map();
  for (const t of r.touched || []) { const id = projectOf(t.path); if (id) n.set(id, (n.get(id) || 0) + 1); }
  const ranked = [...n.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  return [...new Set([projectOf(r.cwd), ...ranked].filter(Boolean))].slice(0, 8);
}
function setState(r, state, at) { if (r.state !== state) { r.state = state; r.since = at || Date.now(); } }

// ---- hooks ----
const keepKnown = (known, told) => !!known && known !== told && path.basename(known) === path.basename(told) && !fs.existsSync(told) && fs.existsSync(known);

function onHook(headers, body) {
  const tmux = (headers['x-tmux-session'] || '').trim();
  if (!tmux || !/^[A-Za-z0-9_.-]+$/.test(tmux)) return { ok: false, error: 'no tmux session' };
  if (body.agent_id) return { ok: true, ignored: 'subagent' };          // subagents fire the same hooks; only the main thread counts
  const ev = body.hook_event_name; if (!ev) return { ok: false, error: 'no event' };
  const ts = +headers['x-ts'] || Date.now();
  const r = rec(tmux); const prev = { ...r };
  const account = headers['x-claude-account']; if (account === 'company' || account === 'personal') r.account = account;
  if (body.session_id && r.mode !== 'chat') r.sessionId = body.session_id;
  if (body.cwd && r.mode !== 'chat') r.cwd = body.cwd;
  if (body.transcript_path && !keepKnown(r.transcriptPath, body.transcript_path)) setTranscript(r, body.transcript_path);
  if (r.gone) r.gone = null;
  // Async hooks can land out of order (Stop then the next UserPromptSubmit a few ms apart): an older
  // event must not roll the state back. Everything else above (ids, paths) is harmless either way.
  const stale = ts < r.lastEventAt;
  if (!stale) { r.lastEvent = ev; r.lastEventAt = ts; }
  if (!stale) switch (ev) {
    case 'SessionStart':
      if (body.model) r.model = body.model;
      if (body.session_title) r.title = body.session_title;
      if (body.source !== 'compact') { setState(r, 'idle', ts); r.lastMessage = null; r.lastTool = null; r.bgTasks = []; r.bgShells = []; }
      if (body.source === 'startup' || body.source === 'clear') { r.lastPrompt = null; r.title = body.session_title || null; r.touched = []; }
      break;
    case 'UserPromptSubmit': setState(r, 'working', ts); if (r.mode === 'chat' && !r.firstPrompt && body.prompt) r.firstPrompt = titleFromPrompt(String(body.prompt)).slice(0, 200) || null; r.lastPrompt = trim(body.prompt, 200); r.promptAt = ts; if (!fromNotification(body.prompt)) { r.askedAt = ts; r.shellsAtAsk = r.bgShells || []; } r.lastTool = null; break;
    case 'PreToolUse': setState(r, 'working', ts); r.lastTool = describeTool(body.tool_name, body.tool_input); r.toolAt = ts; touch(r, body.tool_name, body.tool_input, ts); break;
    case 'PermissionRequest': setState(r, 'permission', ts); r.lastTool = describeTool(body.tool_name, body.tool_input); break;
    case 'Notification':
      if (body.notification_type === 'permission_prompt') setState(r, 'permission', ts);
      else if (body.notification_type === 'idle_prompt' && (r.state === 'working' || r.state === 'background')) setState(r, 'needs-you', ts);
      break;
    case 'Stop': {
      // background_tasks also lists background SHELLS — a dev server started with run_in_background runs forever and
      // would keep the session "waiting on background agents" for good. Only agents / other tasks mean Claude still waits.
      const tasks = Array.isArray(body.background_tasks) ? body.background_tasks : [];
      if (tasks.length && !bgLogged) { bgLogged = true; console.log('stop hook background_tasks sample:', JSON.stringify(tasks).slice(0, 600)); }
      const agents = tasks.filter(t => !isShellTask(t) && isActiveTask(t));
      const waiting = agents.length || (body.session_crons || []).length;
      r.bgTasks = agents.slice(0, 10).map(bgTaskOf);
      r.bgShells = tasks.filter(t => isShellTask(t) && isActiveTask(t)).map(t => bgTaskOf(t).id).filter(Boolean).slice(0, 20);
      setState(r, waiting ? 'background' : 'needs-you', ts);
      if (body.last_assistant_message) r.lastMessage = trim(body.last_assistant_message, 400);
      r.stopAt = ts; break; }
    case 'StopFailure':
      r.bgTasks = [];
      if (r.mode === 'chat' && (body.error === 'rate_limit' || LIMIT_LINE.test(String(body.last_assistant_message || '')))) { setState(r, 'limit', ts); r.lastMessage = trim(body.last_assistant_message || 'usage limit reached', 300); }
      else { setState(r, 'error', ts); r.lastMessage = trim(body.error || body.message || 'API error', 300); }
      break;
    case 'SessionEnd': if (r.mode !== 'chat' && body.reason !== 'clear' && body.reason !== 'resume') setState(r, 'ended', ts); break;
    default: break;
  }
  save();
  if (r.state !== prev.state) for (const fn of listeners) { try { fn(ev, r, prev); } catch (e) { console.error('claude listener', e); } }
  return { ok: true };
}

const LIMIT_LINE = /^(?:\s*[⎿⏺]\s*|(?=\S))(?:You've |You have |Claude(?: AI)? |API Error: [^\n]{0,120}?)?(?:hit your (?:\w+ )?limit|usage limit reached|reached your (?:\w+ )?limit|out of (?:usage|extra usage))[^\n]{0,160}/i;
// The hook's model keeps the alias suffix ("claude-opus-5[1m]"); the transcript has the bare id of what actually
// answered last. Same base -> keep the hook's richer name, otherwise the user switched with /model -> transcript wins.
function modelOf(r) {
  if (!r) return null; const hook = r.model || null, live = r.liveModel || null;
  if (!live) return hook; if (!hook) return live;
  return hook.replace(/\[.*\]$/, '') === live ? hook : live;
}
function info(name) {
  const s = load(); const r = s[name];
  let state = r ? r.state : 'unknown'; let since = r ? r.since : null;
  const chat = r?.mode === 'chat'; const L = chat ? liveOf(name) : null; let ask = null;
  if (chat) {
    if (L && !L.stale) {
      const q = L.pending && L.pending[0];
      if (q) { state = 'permission'; since = q.at; ask = { rid: q.rid, kind: q.kind, tool: q.tool, what: q.what, questions: q.questions, at: q.at }; }
      else if (L.state === 'working') { if (state !== 'working' && state !== 'background') { state = 'working'; since = (L.turn && L.turn.startedAt) || L.since; } }
      else if (state === 'working' || state === 'permission' || state === 'unknown') { state = r.lastPrompt ? 'needs-you' : 'idle'; since = L.since; }
    }
  }
  return {
    state, since, needsYou: NEEDS_YOU.has(state),
    account: r?.account || null, sessionId: r?.sessionId || null, title: r?.title || null, model: modelOf(r), effort: r?.effort || null,
    bgTasks: r?.bgTasks || [], lastTool: r?.lastTool || null, lastPrompt: r?.lastPrompt || null, lastMessage: r?.lastMessage || null, lastEventAt: r?.lastEventAt || 0,
    hooked: !!(r && r.lastEventAt),
    label: r?.label || null, firstPrompt: r?.firstPrompt || null, projects: projectsOf(r), touched: (r?.touched || []).length, cwd: r?.cwd || null, transcriptPath: r?.transcriptPath || null,
    limitText: (state === 'limit' ? r?.lastMessage : null) || null, version: r?.version || null, specialist: r?.specialist || null,
    ...(chat ? { mode: 'chat', ...(isApi(r?.runner?.provider) ? { apiProvider: r.runner.provider } : {}), ask, live: L ? { state: L.state, stale: !!L.stale, error: L.error || null, version: L.version || null, rate: L.rate || null } : null } : {}),
  };
}

// The dashboard user opened the terminal: whatever Claude had to say has been seen.
function seen(name) { const s = load(); const r = s[name]; if (r && (r.state === 'needs-you' || r.state === 'error')) { setState(r, 'idle'); save(); } return { ok: true }; }

// ---- titles from the transcript (Claude Code writes {"type":"ai-title"} lines) ----
const titleChecked = new Map();
function refreshTitles() {
  const s = load(); const now = Date.now();
  for (const r of Object.values(s)) {
    if (!r.transcriptPath || r.gone) continue;
    const last = titleChecked.get(r.tmux) || 0; if (now - last < 20000) continue; titleChecked.set(r.tmux, now);
    try {
      const st = fs.statSync(r.transcriptPath); const len = Math.min(st.size, 256 * 1024);
      const fd = fs.openSync(r.transcriptPath, 'r'); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
      const txt = buf.toString('utf8');
      try { const m = [...txt.matchAll(/"version":"(\d+\.\d+\.\d+)"/g)].pop(); if (m && m[1] !== r.version) { r.version = m[1]; save(); } } catch {}
      // the model actually answering (follows a /model switch, unlike the SessionStart hook) + the effort level
      try { const m = [...txt.matchAll(/"model":"(claude-[^"]+)"/g)].pop(); if (m && m[1] !== r.liveModel) { r.liveModel = m[1]; save(); } } catch {}
      try { const m = [...txt.matchAll(/"effort":"([a-z]+)"/g)].pop(); if (m && m[1] !== r.effort) { r.effort = m[1]; save(); } } catch {}
      let i = txt.lastIndexOf('"type":"ai-title"'); let j = txt.lastIndexOf('"type":"custom-title"');
      const at = Math.max(i, j); if (at < 0) continue;
      const line = txt.slice(txt.lastIndexOf('\n', at) + 1, txt.indexOf('\n', at) < 0 ? undefined : txt.indexOf('\n', at));
      const o = JSON.parse(line); const t = o.customTitle || o.aiTitle; if (t && t !== r.title) { r.title = t; save(); }
    } catch {}
      }
}

// ---- lifecycle vs. tmux ----
// Called every tick with the live tmux session names: mark vanished claude sessions as gone (restorable),
// forget very old ones, drop the peek of anything that is no longer there.
function reconcile(liveNames) {
  const s = load(); const live = new Set(liveNames); const now = Date.now(); let dirty = false;
  for (const [name, r] of Object.entries(s)) {
    if (live.has(name)) { if (r.gone) { r.gone = null; dirty = true; } continue; }
    if (!r.gone) { r.gone = now; dirty = true; }
    else if (now - r.gone > GONE_TTL) { delete s[name]; dirty = true; }
  }
  if (dirty) save();
}
function forget(name) { const s = load(); if (s[name]) { delete s[name]; save(); } return { ok: true }; }
// Sessions that existed but whose tmux session is gone (reboot, tmux kill): candidates for "Restore".
function forgetGone(sessionId, except) { const s = load(); let n = 0; for (const [name, r] of Object.entries(s)) if (r.gone && r.sessionId === sessionId && name !== except) { delete s[name]; n++; } if (n) save(); return n; }
function restorable() { return Object.values(load()).filter(r => r.gone && r.cwd && r.state !== 'ended' && !r.specialist && (r.mode === 'chat' || String(r.tmux).startsWith('claude-'))).map(r => ({ tmux: r.tmux, account: r.account, cwd: r.cwd, sessionId: r.sessionId, title: r.title, gone: r.gone, lastPrompt: r.lastPrompt })); }
function get(name) { return load()[name] || null; }
function all() { return load(); }


module.exports = { transcriptsOf, markChat, setRunner, conversationOf, followChat, setLive, setProjects, setLabel, onHook, onChange, refreshTitles, info, seen, reconcile, forget, forgetGone, restorable, get, all, describeTool, STATES };
