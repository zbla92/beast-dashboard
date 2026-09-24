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
const { run, readJson, writeJson, STATE } = require('./util');

const FILE = path.join(STATE, 'claude-sessions.json');
const GONE_TTL = 3 * 86400e3;   // forget sessions that vanished more than 3 days ago
let store = null;
let saveTimer = null;
const listeners = [];           // (event, rec, prev) => void   — push notifications hang off this

function load() { if (!store) store = readJson(FILE, {}); return store; }
function save() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; try { writeJson(FILE, store); } catch (e) { console.error('claude store save failed', e); } }, 500); }
function onChange(fn) { listeners.push(fn); }

const STATES = ['working', 'background', 'permission', 'needs-you', 'error', 'limit', 'idle', 'ended', 'unknown'];
const NEEDS_YOU = new Set(['needs-you', 'permission', 'error', 'limit']);
const trim = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// One line describing a tool call, for the card ("Bash: npm test", "Edit app.js").
function describeTool(name, input) {
  input = input || {};
  const base = p => String(p || '').split('/').pop();
  switch (name) {
    case 'Bash': case 'PowerShell': return trim(input.description || input.command, 90);
    case 'Edit': case 'Write': case 'Read': case 'NotebookEdit': return `${name} ${base(input.file_path || input.notebook_path)}`;
    case 'Grep': return `Grep ${trim(input.pattern, 40)}`;
    case 'Glob': return `Glob ${trim(input.pattern, 40)}`;
    case 'Agent': return `Agent: ${trim(input.description || input.prompt, 70)}`;
    case 'WebFetch': try { return 'Fetch ' + new URL(input.url).host; } catch { return 'WebFetch'; }
    case 'WebSearch': return `Search ${trim(input.query, 60)}`;
    case 'Skill': return `Skill ${input.skill || ''}`;
    default: return name || '?';
  }
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
function setState(r, state, at) { if (r.state !== state) { r.state = state; r.since = at || Date.now(); } }

// ---- hooks ----
function onHook(headers, body) {
  const tmux = (headers['x-tmux-session'] || '').trim();
  if (!tmux || !/^[A-Za-z0-9_.-]+$/.test(tmux)) return { ok: false, error: 'no tmux session' };
  if (body.agent_id) return { ok: true, ignored: 'subagent' };          // subagents fire the same hooks; only the main thread counts
  const ev = body.hook_event_name; if (!ev) return { ok: false, error: 'no event' };
  const ts = +headers['x-ts'] || Date.now();
  const r = rec(tmux); const prev = { ...r };
  const account = headers['x-claude-account']; if (account === 'company' || account === 'personal') r.account = account;
  if (body.session_id) r.sessionId = body.session_id;
  if (body.cwd) r.cwd = body.cwd;
  if (body.transcript_path) r.transcriptPath = body.transcript_path;
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
    case 'UserPromptSubmit': setState(r, 'working', ts); r.lastPrompt = trim(body.prompt, 200); r.promptAt = ts; r.lastTool = null; break;
    case 'PreToolUse': setState(r, 'working', ts); r.lastTool = describeTool(body.tool_name, body.tool_input); r.toolAt = ts; touch(r, body.tool_name, body.tool_input, ts); break;
    case 'PermissionRequest': setState(r, 'permission', ts); r.lastTool = describeTool(body.tool_name, body.tool_input); break;
    case 'Notification':
      if (body.notification_type === 'permission_prompt') setState(r, 'permission', ts);
      else if (body.notification_type === 'idle_prompt' && (r.state === 'working' || r.state === 'background')) setState(r, 'needs-you', ts);
      break;
    case 'Stop':
      setState(r, (body.background_tasks || []).length || (body.session_crons || []).length ? 'background' : 'needs-you', ts);
      if (body.last_assistant_message) r.lastMessage = trim(body.last_assistant_message, 400);
      r.stopAt = ts; break;
    case 'StopFailure': setState(r, 'error', ts); r.lastMessage = trim(body.error || body.message || 'API error', 300); break;
    case 'SessionEnd': if (body.reason !== 'clear' && body.reason !== 'resume') setState(r, 'ended', ts); break;
    default: break;
  }
  save();
  if (r.state !== prev.state) for (const fn of listeners) { try { fn(ev, r, prev); } catch (e) { console.error('claude listener', e); } }
  return { ok: true };
}

// ---- pane peek + fallback state ----
const peeks = new Map();   // tmux -> { lines: [], draft: '', paneState, at }
async function refreshPeeks(names) {
  await Promise.all(names.map(async name => {
    const r = await run('tmux', ['capture-pane', '-p', '-J', '-t', '=' + name + ':', '-S', '-40'], { timeout: 2000 });
    if (!r.ok) { peeks.delete(name); return; }
    const raw = r.stdout.split('\n').map(l => l.replace(/\s+$/, ''));
    while (raw.length && !raw[raw.length - 1]) raw.pop();
    const text = raw.join('\n');
    let paneState = 'unknown', draft = '', limitText = null;
    // claude.ai usage limit: "You've hit your limit · resets 3pm" / "usage limit reached … resets at" — a distinct state, with the reset time
    const lim = text.match(/(?:hit your (?:usage )?limit|usage limit reached|reached your (?:usage )?limit|out of (?:usage|extra usage))[^\n]{0,160}/i);
    if (lim) { paneState = 'limit'; limitText = lim[0].replace(/\s+/g, ' ').trim(); const rs = text.match(/resets?\s+(?:at\s+|in\s+)?([^\n·]{2,40})/i); if (rs && !/reset/i.test(limitText)) limitText += ' · resets ' + rs[1].trim(); }
    else if (/esc to interrupt/.test(text)) paneState = 'working';
    else if (/Do you want to (proceed|make this edit|create|run)|Yes, and don't ask again|\(y\/n\)|Allow once|Esc to cancel/.test(text)) paneState = 'permission';
    else {
      // prompt box: "❯ " (possibly with an unsent draft after it); older builds use "> "
      for (let i = raw.length - 1; i >= Math.max(0, raw.length - 8); i--) {
        const m = raw[i].match(/^[❯>] ?(.*)$/);
        if (m) { paneState = 'idle'; draft = m[1].trim(); break; }
      }
    }
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
    peeks.set(name, { lines: shown, draft, paneState, limitText, bg, bgSince: bg ? (bg.startedAt || (prev && prev.bg ? prev.bgSince : now)) : null, at: now, since: prev && prev.paneState === paneState ? prev.since : now });
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
  // no hook history yet (session predates the hooks): the pane's last output change is when it went quiet
  if (!r && p && p.paneState !== 'working' && activity) p = { ...p, since: Math.min(p.since, activity) };
  if (p) {
    if (p.paneState === 'limit') { state = 'limit'; since = r?.state === 'limit' ? r.since : p.since; }
    else if (p.paneState === 'working' && state !== 'working' && state !== 'background') { state = 'working'; since = r?.promptAt && r.promptAt > p.since - 5000 ? r.promptAt : p.since; }
    else if (p.paneState === 'permission') { state = 'permission'; since = r?.state === 'permission' ? r.since : p.since; }
    else if (p.bg && p.paneState !== 'working') { state = 'background'; since = p.bgSince; }
    else if (p.paneState === 'idle' && (state === 'working' || state === 'unknown' || state === 'background')) {
      // pane shows the prompt but hooks think we're still working: Stop event lost / never wired -> treat as finished
      state = r && r.lastPrompt ? 'needs-you' : 'idle'; since = r?.lastEventAt ? Math.min(r.lastEventAt, p.since) : p.since;
    }
  }
  return {
    state, since, needsYou: NEEDS_YOU.has(state),
    account: r?.account || null, sessionId: r?.sessionId || null, title: r?.title || null, model: modelOf(r), effort: r?.effort || null,
    lastTool: r?.lastTool || null, lastPrompt: r?.lastPrompt || null, lastMessage: r?.lastMessage || null, lastEventAt: r?.lastEventAt || 0,
    bg: p?.bg || null, peek: p ? p.lines : [], draft: p ? p.draft : '', hooked: !!(r && r.lastEventAt),
    label: r?.label || null, touched: (r?.touched || []).length, cwd: r?.cwd || null, transcriptPath: r?.transcriptPath || null,
    limitText: p?.limitText || (state === 'limit' ? r?.lastMessage : null) || null, version: r?.version || null,
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
function restorable() { return Object.values(load()).filter(r => r.gone && r.cwd && r.state !== 'ended').map(r => ({ tmux: r.tmux, account: r.account, cwd: r.cwd, sessionId: r.sessionId, title: r.title, gone: r.gone, lastPrompt: r.lastPrompt })); }
function get(name) { return load()[name] || null; }
function all() { return load(); }

// ---- typing into a session ----
async function send(name, text, enter = true) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return { ok: false, error: 'bad session' };
  const has = await run('tmux', ['has-session', '-t', '=' + name]); if (!has.ok) return { ok: false, error: 'no such session' };
  if (text) { const r = await run('tmux', ['send-keys', '-t', '=' + name + ':', '-l', '--', text]); if (!r.ok) return { ok: false, error: r.stderr.trim() }; }
  if (enter) { await new Promise(res => setTimeout(res, text ? 120 : 0)); await run('tmux', ['send-keys', '-t', '=' + name + ':', 'Enter']); }
  return { ok: true };
}
// Special keys for the quick-reply bar: Escape (interrupt), C-c, Up/Down, y/n.
async function key(name, k) {
  const allowed = { esc: 'Escape', enter: 'Enter', 'c-c': 'C-c', up: 'Up', down: 'Down', tab: 'Tab', 's-tab': 'BTab' };
  if (!allowed[k]) return { ok: false, error: 'bad key' };
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return { ok: false, error: 'bad session' };
  const r = await run('tmux', ['send-keys', '-t', '=' + name + ':', allowed[k]]);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
}

module.exports = { setLabel, onHook, onChange, refreshPeeks, refreshTitles, info, seen, reconcile, forget, restorable, get, all, send, key, describeTool, STATES };
