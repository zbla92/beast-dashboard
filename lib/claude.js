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
const { run, readJson, writeJson, STATE, titleFromPrompt } = require('./util');
const { describeTool } = require('./tooldesc');

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

const HOOK_TRUST = 10 * 60e3;   // hook says working and its last event is younger than this -> believe it over the pane
const STATES = ['working', 'background', 'permission', 'needs-you', 'error', 'limit', 'idle', 'ended', 'unknown'];
const NEEDS_YOU = new Set(['needs-you', 'permission', 'error', 'limit']);
const trim = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

let bgLogged = false;
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
function markChat(name, f) {
  const r = rec(name);
  setTranscript(r, f.transcriptPath);
  Object.assign(r, { mode: 'chat', cwd: f.cwd, account: f.account, sessionId: f.sessionId, forkFrom: /^[0-9a-f-]{36}$/.test(f.forkFrom || '') ? f.forkFrom : null, gone: null });
  if (f.firstPrompt) r.firstPrompt = titleFromPrompt(String(f.firstPrompt)).slice(0, 200);
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
function clearChat(name) { const s = load(); const old = s[name]; if (old?.mode !== 'chat') return; delete s[name]; const r = rec(name); r.pastTranscripts = [old.transcriptPath, ...(old.pastTranscripts || [])].filter(Boolean).slice(0, 20); save(); }
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
      if (body.source !== 'compact') { setState(r, 'idle', ts); r.lastMessage = null; r.lastTool = null; }
      if (body.source === 'startup' || body.source === 'clear') { r.lastPrompt = null; r.title = body.session_title || null; r.touched = []; }
      break;
    case 'UserPromptSubmit': setState(r, 'working', ts); if (r.mode === 'chat' && !r.firstPrompt && body.prompt) r.firstPrompt = titleFromPrompt(String(body.prompt)).slice(0, 200) || null; r.lastPrompt = trim(body.prompt, 200); r.promptAt = ts; r.lastTool = null; break;
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
      const waiting = tasks.filter(t => !isShellTask(t)).length || (body.session_crons || []).length;
      setState(r, waiting ? 'background' : 'needs-you', ts);
      if (body.last_assistant_message) r.lastMessage = trim(body.last_assistant_message, 400);
      r.stopAt = ts; break; }
    case 'StopFailure': setState(r, 'error', ts); r.lastMessage = trim(body.error || body.message || 'API error', 300); break;
    case 'SessionEnd': if (r.mode !== 'chat' && body.reason !== 'clear' && body.reason !== 'resume') setState(r, 'ended', ts); break;
    default: break;
  }
  save();
  if (r.state !== prev.state) for (const fn of listeners) { try { fn(ev, r, prev); } catch (e) { console.error('claude listener', e); } }
  return { ok: true };
}

// ---- pane peek + fallback state ----
// Claude Code's live status line: a spinner glyph + a verb with an ellipsis ("✻ Cooking… (2m · ↓ 3k tokens · esc to
// interrupt)"). In a narrow pane (phone-sized window) the "esc to interrupt" part gets cut or wrapped away, so the
// glyph + "…" is the signal. The finished line has no ellipsis ("✻ Cooked for 13m 32s · done 7:05 AM").
const SPIN = /^\s*[✻✽✶✳✢✺✹✸*·⏺]\s+[A-Z][\w'-]*…/;
function spinLine(raw) { for (let i = raw.length - 1, n = 0; i >= 0 && n < 14; i--, n++) if (SPIN.test(raw[i])) { let l = raw[i].trim(); if (raw[i + 1] && /^\s{2,}\S/.test(raw[i + 1]) && !/[│─❯]/.test(raw[i + 1])) l += ' ' + raw[i + 1].trim(); return l.replace(/\s*·?\s*esc to interrupt\)?/, ')').replace(/\(\)$/, '').replace(/\s+/g, ' ').trim(); } return null; }
function spinning(raw) { return !!spinLine(raw); }
const MENU_CUR = /^(\s+)[❯›]\s+(\S.*)$/;
function parseMenu(raw) {
  let c = -1;
  for (let i = raw.length - 1; i >= Math.max(0, raw.length - 30); i--) if (MENU_CUR.test(raw[i])) { c = i; break; }
  if (c < 0) return null;
  const col = raw[c].length - raw[c].match(MENU_CUR)[2].length;
  const lead = l => l.length - l.trimStart().length;
  const inBlock = i => i === c || (raw[i] && /\S/.test(raw[i]) && lead(raw[i]) >= col);
  let a = c, b = c;
  while (a > 0 && inBlock(a - 1)) a--;
  while (b < raw.length - 1 && inBlock(b + 1)) b++;
  const options = []; let cur = -1;
  for (let i = a; i <= b; i++) {
    if (i === c) { cur = options.length; options.push(raw[i].slice(col).trim()); }
    else if (lead(raw[i]) === col) options.push(raw[i].trim());
  }
  if (options.length < 2) return null;
  const text = [];
  for (let i = a - 1; i >= 0 && text.length < 16; i--) { if (/^\s*[─━]{8,}/.test(raw[i])) break; text.unshift(raw[i].trim()); }
  while (text.length && !text[0]) text.shift();
  while (text.length && !text[text.length - 1]) text.pop();
  return { text: text.filter((l, i) => l || text[i - 1]), options, cur };
}
const RULE = /^\s*[─━]{8,}/;
const LIMIT_LINE = /^(?:\s*[⎿⏺]\s*|(?=\S))(?:You've |You have |Claude(?: AI)? |API Error: [^\n]{0,120}?)?(?:hit your (?:\w+ )?limit|usage limit reached|reached your (?:\w+ )?limit|out of (?:usage|extra usage))[^\n]{0,160}/i;
const PERMISSION = /Do you want to (proceed|make this edit|create|run)|Yes, and don't ask again|\(y\/n\)|Allow once|Esc to cancel|Enter to confirm/;
function paneStateOf(raw) {
  let lastRule = -1; for (let i = raw.length - 1; i >= 0; i--) if (RULE.test(raw[i])) { lastRule = i; break; }
  let prompt = -1; for (let i = raw.length - 1; i >= Math.max(0, raw.length - 25); i--) if (/^[❯>] ?/.test(raw[i])) { prompt = i; break; }
  const boxTop = prompt > 0 && RULE.test(raw[prompt - 1]) ? prompt - 1 : lastRule;
  const nearChrome = boxTop < 0 ? raw.slice(-8) : raw.slice(Math.max(0, boxTop - 6));
  const dialog = lastRule < 0 ? raw.slice(-15) : raw.slice(lastRule + 1);
  const text = raw.join('\n');
  let paneState = 'unknown', draft = '', limitText = null;
  const lim = nearChrome.map(l => l.match(LIMIT_LINE)).find(Boolean);
  if (lim) { paneState = 'limit'; limitText = lim[0].replace(/^\s*[⎿⏺]?\s*/, '').replace(/\s+/g, ' ').trim(); const rs = nearChrome.join('\n').match(/resets?\s+(?:at\s+|in\s+)?([^\n·]{2,40})/i); if (rs && !/reset/i.test(limitText)) limitText += ' · resets ' + rs[1].trim(); }
  else if (/esc to interrupt/.test(text) || spinning(raw)) paneState = 'working';
  else if (PERMISSION.test(dialog.join('\n'))) paneState = 'permission';
  else {
    for (let i = raw.length - 1; i >= Math.max(0, raw.length - 8); i--) {
      const m = raw[i].match(/^[❯>] ?(.*)$/);
      if (m) { paneState = 'idle'; draft = m[1].trim(); break; }
    }
  }
  return { paneState, draft, limitText };
}
const paneLines = out => { const raw = out.split('\n').map(l => l.replace(/\s+$/, '')); while (raw.length && !raw[raw.length - 1]) raw.pop(); return raw; };
const capturePane = name => run('tmux', ['capture-pane', '-p', '-J', '-t', '=' + name + ':', '-S', '-40'], { timeout: 2000 });
const peeks = new Map();   // tmux -> { lines: [], draft: '', paneState, at }
async function refreshPeeks(names) {
  await Promise.all(names.map(async name => {
    const r = await capturePane(name);
    if (!r.ok) { peeks.delete(name); return; }
    const raw = paneLines(r.stdout);
    const { paneState, draft, limitText } = paneStateOf(raw);
    // background work the main thread is waiting on (subagents, background shells): the prompt box is back,
    // but the session isn't done. Claude Code shows it as "✻ Waiting for 1 background agent to finish" above
    // the prompt and, in the footer, one "◯ <name>  <what it's doing>  26m 28s · ↓ 394k tokens" row per running agent.
    let bg = null;
    if (paneState === 'idle' || paneState === 'unknown') {
      // (the footer's "· 2 shells" alone doesn't count: a dev server left running in the background would hide a "needs you")
      // only Claude Code's own chrome counts, never the conversation text (a reply that *quotes* "Waiting for 1 background
      // agent" must not flag the session): the spinner line right above the prompt box, and the footer below it
      let pi = -1; for (let i = raw.length - 1; i >= Math.max(0, raw.length - 25); i--) if (/^[❯>] ?/.test(raw[i])) { pi = i; break; }
      const above = pi < 0 ? [] : raw.slice(Math.max(0, pi - 4), pi), footer = pi < 0 ? [] : raw.slice(pi + 1);
      const agents = [];
      for (const l of footer) { const m = l.match(/^\s*◯\s+(\S+)\s+(.*?)\s{2,}((?:\d+[hms]\s*)+)(?:·|$)/); if (m) agents.push({ name: m[1], doing: m[2].trim(), age: m[3].trim() }); }
      let w = null; for (const l of above) { const m = l.match(/^\s*\S\s+Waiting for (\d+) background (agents?|tasks?|shells?)/i); if (m) w = m; }
      const n = Math.max(agents.length, w ? +w[1] : 0);
      // "26m 28s" -> when the oldest running agent started (so the card's timer survives a dashboard restart)
      const secs = a => (a.match(/(\d+)([hms])/g) || []).reduce((t, x) => t + parseInt(x) * { h: 3600, m: 60, s: 1 }[x.slice(-1)], 0);
      const oldest = agents.reduce((mx, a) => Math.max(mx, secs(a.age)), 0);
      if (n) bg = { n, kind: w ? w[2].replace(/s$/, '') : 'agent', agents, startedAt: oldest ? Date.now() - oldest * 1000 : null };
    }
    // the card shows the last meaningful lines: skip the box drawing + status line noise
    const shown = raw.filter(l => l && !/^[─│┌┐└┘├┤┬┴┼\s]+$/.test(l) && !/^\s*⏵⏵ bypass permissions|^\s*⧉ |^\s*\? for shortcut|^\s*Tip: /.test(l)).slice(-12);
    const prev = peeks.get(name); const now = Date.now();
    peeks.set(name, { lines: shown, draft, paneState, limitText, bg, menu: paneState === 'permission' ? parseMenu(raw) : null, status: paneState === 'working' ? spinLine(raw) : null, bgSince: bg ? (bg.startedAt || (prev && prev.bg ? prev.bgSince : now)) : null, at: now, since: prev && prev.paneState === paneState ? prev.since : now });
    // the limit is only visible in the pane: raise it as a state transition so listeners (push) see it once
    const r0 = load()[name];
    if (paneState === 'limit' && r0 && r0.state !== 'limit') { const prev0 = { ...r0 }; setState(r0, 'limit', now); r0.lastMessage = limitText; save(); for (const fn of listeners) { try { fn('pane', r0, prev0); } catch {} } }
    else if (paneState !== 'limit' && paneState !== 'unknown' && r0 && r0.state === 'limit') { setState(r0, paneState === 'working' ? 'working' : 'idle', now); save(); }
  }));
}

// The hook's model keeps the alias suffix ("claude-opus-5[1m]"); the transcript has the bare id of what actually
// answered last. Same base -> keep the hook's richer name, otherwise the user switched with /model -> transcript wins.
function modelOf(r) {
  if (!r) return null; const hook = r.model || null, live = r.liveModel || null;
  if (!live) return hook; if (!hook) return live;
  return hook.replace(/\[.*\]$/, '') === live ? hook : live;
}
// Merge hooks + pane into what the UI shows.
function info(name, activity) {
  const s = load(); const r = s[name]; let p = peeks.get(name);
  let state = r ? r.state : 'unknown'; let since = r ? r.since : null;
  const chat = r?.mode === 'chat'; const L = chat ? liveOf(name) : null; let ask = null;
  if (chat) {
    if (p) p = { ...p, paneState: null, bg: null, menu: null, limitText: null, status: null, draft: '' };
    if (L && !L.stale) {
      const q = L.pending && L.pending[0];
      if (q) { state = 'permission'; since = q.at; ask = { rid: q.rid, kind: q.kind, tool: q.tool, what: q.what, questions: q.questions, at: q.at }; }
      else if (L.state === 'working') { if (state !== 'working' && state !== 'background') { state = 'working'; since = (L.turn && L.turn.startedAt) || L.since; } }
      else if (state === 'working' || state === 'permission' || state === 'unknown') { state = r.lastPrompt ? 'needs-you' : 'idle'; since = L.since; }
    }
  }
  // no hook history yet (session predates the hooks): the pane's last output change is when it went quiet
  if (!r && p && p.paneState !== 'working' && activity) p = { ...p, since: Math.min(p.since, activity) };
  if (p) {
    if (p.paneState === 'limit') { state = 'limit'; since = r?.state === 'limit' ? r.since : p.since; }
    else if (p.paneState === 'working' && state !== 'working' && state !== 'background') { state = 'working'; since = r?.promptAt && r.promptAt > p.since - 5000 ? r.promptAt : p.since; }
    else if (p.paneState === 'permission') { state = 'permission'; since = r?.state === 'permission' ? r.since : p.since; }
    else if (p.bg && p.paneState !== 'working') { state = 'background'; since = p.bgSince; }
    else if (p.paneState === 'idle' && (state === 'unknown' || ((state === 'working' || state === 'background') && Date.now() - (r?.lastEventAt || 0) > HOOK_TRUST))) {
      // pane shows the prompt but hooks think we're still working: Stop event lost / never wired -> treat as finished.
      // Only when the hooks have been quiet for a while — Claude shows the ❯ box while it works too, and a narrow
      // pane can hide the working status line, so fresh hook events win.
      state = r && r.lastPrompt ? 'needs-you' : 'idle'; since = r?.lastEventAt || p.since;
    }
  }
  return {
    state, since, needsYou: NEEDS_YOU.has(state),
    account: r?.account || null, sessionId: r?.sessionId || null, title: r?.title || null, model: modelOf(r), effort: r?.effort || null,
    lastTool: r?.lastTool || null, lastPrompt: r?.lastPrompt || null, lastMessage: r?.lastMessage || null, lastEventAt: r?.lastEventAt || 0,
    bg: p?.bg || null, menu: p && p.paneState === 'permission' ? p.menu || null : null, status: state === 'working' ? (p?.status || null) : null, peek: p ? p.lines : [], draft: p ? p.draft : '', hooked: !!(r && r.lastEventAt),
    label: r?.label || null, firstPrompt: r?.firstPrompt || null, projects: projectsOf(r), touched: (r?.touched || []).length, cwd: r?.cwd || null, transcriptPath: r?.transcriptPath || null,
    limitText: p?.limitText || (state === 'limit' ? r?.lastMessage : null) || null, version: r?.version || null,
    ...(chat ? { mode: 'chat', ask, live: L ? { state: L.state, stale: !!L.stale, error: L.error || null, version: L.version || null, rate: L.rate || null } : null } : {}),
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
    peeks.delete(name);
  }
  if (dirty) save();
}
function forget(name) { const s = load(); if (s[name]) { delete s[name]; save(); } return { ok: true }; }
// Sessions that existed but whose tmux session is gone (reboot, tmux kill): candidates for "Restore".
function forgetGone(sessionId, except) { const s = load(); let n = 0; for (const [name, r] of Object.entries(s)) if (r.gone && r.sessionId === sessionId && name !== except) { delete s[name]; n++; } if (n) save(); return n; }
function restorable() { return Object.values(load()).filter(r => r.gone && r.cwd && r.state !== 'ended' && (r.mode === 'chat' || String(r.tmux).startsWith('claude-'))).map(r => ({ tmux: r.tmux, account: r.account, cwd: r.cwd, sessionId: r.sessionId, title: r.title, gone: r.gone, lastPrompt: r.lastPrompt })); }
function get(name) { return load()[name] || null; }
function all() { return load(); }

// ---- typing into a session ----
const NOT_RUNNING = { ok: false, notRunning: true, error: 'Claude is not running in this session' };
async function claudeRunning(name) { return (await run('tmux', ['display-message', '-p', '-t', '=' + name + ':', '#{pane_current_command}'])).stdout.trim() === 'claude'; }
const PASTE_FROM = 1000;
async function pasteText(name, text) {
  const buf = 'beast-send-' + name, file = path.join(STATE, buf + '.txt');
  fs.writeFileSync(file, text, { mode: 0o600 });
  try {
    const l = await run('tmux', ['load-buffer', '-b', buf, file]); if (!l.ok) return l;
    return await run('tmux', ['paste-buffer', '-p', '-d', '-b', buf, '-t', '=' + name + ':']);
  } finally { fs.rmSync(file, { force: true }); }
}
async function send(name, text, enter = true) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return { ok: false, error: 'bad session' };
  const has = await run('tmux', ['has-session', '-t', '=' + name]); if (!has.ok) return { ok: false, error: 'no such session' };
  if (!(await claudeRunning(name))) return NOT_RUNNING;
  if (text) { const r = text.length > PASTE_FROM ? await pasteText(name, text) : await run('tmux', ['send-keys', '-t', '=' + name + ':', '-l', '--', text]); if (!r.ok) return { ok: false, error: r.stderr.trim() || 'tmux failed' }; }
  if (enter) { await new Promise(res => setTimeout(res, text ? 120 : 0)); await run('tmux', ['send-keys', '-t', '=' + name + ':', 'Enter']); }
  return { ok: true };
}
// Special keys for the quick-reply bar: Escape (interrupt), C-c, Up/Down, y/n.
async function key(name, k) {
  const allowed = { esc: 'Escape', enter: 'Enter', 'c-c': 'C-c', up: 'Up', down: 'Down', tab: 'Tab', 's-tab': 'BTab' };
  if (!allowed[k]) return { ok: false, error: 'bad key' };
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return { ok: false, error: 'bad session' };
  if (!(await claudeRunning(name))) return NOT_RUNNING;
  const r = await run('tmux', ['send-keys', '-t', '=' + name + ':', allowed[k]]);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
}

async function choose(name, index, label) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return { ok: false, error: 'bad session' };
  if (!Number.isInteger(index) || index < 0 || index > 20 || typeof label !== 'string') return { ok: false, error: 'bad option' };
  if (!(await claudeRunning(name))) return NOT_RUNNING;
  const target = '=' + name + ':';
  const look = async () => { const r = await capturePane(name); return r.ok ? parseMenu(paneLines(r.stdout)) : null; };
  const changed = { ok: false, error: 'the question on screen changed — look again' };
  let mn = await look();
  if (!mn || mn.options[index] !== label) return changed;
  for (let tries = 0; mn.cur !== index && tries < 3; tries++) {
    const k = mn.cur < index ? 'Down' : 'Up';
    for (let i = Math.abs(index - mn.cur); i > 0; i--) { await run('tmux', ['send-keys', '-t', target, k]); await new Promise(res => setTimeout(res, 60)); }
    await new Promise(res => setTimeout(res, 200));
    mn = await look();
    if (!mn || mn.options[index] !== label) return changed;
  }
  if (mn.cur !== index) return { ok: false, error: 'could not move to that option — use the terminal' };
  const r = await run('tmux', ['send-keys', '-t', target, 'Enter']);
  const p = peeks.get(name); if (p) p.menu = null;
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
}

const STALE_QUESTION = { ok: false, status: 409, error: 'that question is no longer on screen — open the app' };
async function answer(name, since, choice) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return { ok: false, status: 400, error: 'bad session' };
  if (choice !== 'allow' && choice !== 'deny') return { ok: false, status: 400, error: 'bad choice' };
  const cur = info(name);
  if (!cur || cur.state !== 'permission' || (since != null && cur.since !== since)) return STALE_QUESTION;
  const r = await capturePane(name); const mn = r.ok ? parseMenu(paneLines(r.stdout)) : null;
  if (!mn) return STALE_QUESTION;
  if (choice === 'deny') return key(name, 'esc');
  const i = mn.options.findIndex(o => /^(\d+\.\s*)?yes\b/i.test(o));
  if (i < 0) return STALE_QUESTION;
  const res = await choose(name, i, mn.options[i]);
  return res.ok ? res : { ...res, status: 409 };
}

module.exports = { transcriptsOf, markChat, conversationOf, followChat, clearChat, setLive, setProjects, parseMenu, paneStateOf, choose, answer, setLabel, onHook, onChange, refreshPeeks, refreshTitles, info, seen, reconcile, forget, forgetGone, restorable, get, all, send, key, describeTool, STATES };
