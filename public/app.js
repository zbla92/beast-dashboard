/* Beast Dash — frontend (vanilla JS, no deps) */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'style') el.style.cssText = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtB = n => { if (n == null) return '–'; const u = ['B', 'K', 'M', 'G', 'T']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i >= 3 ? n.toFixed(1) : Math.round(n)) + u[i]; };
const fmtRate = n => fmtB(n) + '/s';
const ago = ts => { if (!ts) return ''; const s = Math.max(0, (Date.now() - ts) / 1000); if (s < 60) return Math.round(s) + 's'; if (s < 3600) return Math.round(s / 60) + 'm'; if (s < 86400) return (s / 3600).toFixed(s < 36000 ? 1 : 0) + 'h'; return Math.round(s / 86400) + 'd'; };
const fmtUp = s => { const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + hh + 'h ' + m + 'm'; };
// Orgs are just the top-level folders under devRoot, so their names differ per machine: hash the name
// onto a fixed palette instead of hardcoding a map. Same folder always gets the same colour.
const ORG_COLORS = 6;
const orgColor = o => { if (!o) return 'var(--org-default)'; let n = 0; for (let i = 0; i < o.length; i++) n = (n * 31 + o.charCodeAt(i)) >>> 0; return `var(--org-${n % ORG_COLORS + 1})`; };
// Project avatar: an app-icon tile in the org's colour with the tech glyph (RN, React, Next, Py, iOS, JS …) and the
// org initial in the corner. Same tile everywhere a project shows up (cards, sidebar, terminal bar, drawers).
const REACT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/></svg>';
function techGlyph(p) {
  if (!p) return { t: '$', cls: 'g-sh' };
  const f = p.framework, pr = p.primary, st = p.stack;
  if (f === 'expo' || f === 'react-native') return { t: 'RN', cls: 'g-rn' };
  if (f === 'ios' || st === 'swift') return { t: 'iOS', cls: 'g-ios' };
  if (f === 'next') return { t: 'N', cls: 'g-next' };
  if (f === 'nuxt') return { t: 'Nu', cls: 'g-vue' };
  if (f === 'angular') return { t: 'A', cls: 'g-ng' };
  if (f === 'vite' || pr === 'frontend') return { svg: REACT_SVG, cls: 'g-react' };
  if (f === 'flask' || f === 'django' || f === 'fastapi' || st === 'python') return { t: 'Py', cls: 'g-py' };
  if (f === 'nest' || f === 'fastify' || f === 'express' || pr === 'backend' || pr === 'node') return { t: 'JS', cls: 'g-node' };
  if (pr === 'infra' || st === 'docker') return { t: 'Ops', cls: 'g-ops' };
  if (pr === 'lib') return { t: 'Lib', cls: 'g-lib' };
  if (pr === 'monorepo') return { t: 'Mo', cls: 'g-lib' };
  return { t: (p.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?', cls: 'g-lib' };
}
// Every project gets its own muted hue (stable hash of its name) so twenty repos of one client don't all look alike;
// the org still shows as the initial in the corner.
function projColor(p) { if (!p) return null; let x = 0; for (const c of p.name) x = (x * 31 + c.charCodeAt(0)) >>> 0; const hues = [210, 25, 150, 275, 45, 190, 330, 95, 240, 10, 170, 300]; return `hsl(${hues[x % hues.length]} 40% 66%)`; }
// pid: project id (or null for plain shells). size: css class 'sm' | '' | 'lg'
function avatar(pid, size = '') {
  const p = pid && byId()[pid]; const g = techGlyph(p); const org = p ? p.org : null;
  const el = h('span', { class: 'av ' + size + ' ' + g.cls + (org ? ' org-' + org : ' org-none'), style: `--org:${projColor(p) || orgColor(org)};--oc:${orgColor(org)}`, title: p ? [p.name, p.framework || p.primary, p.org].filter(Boolean).join(' · ') : 'shell' });
  if (g.svg) { const w = h('span', { class: 'g' }); w.innerHTML = g.svg; el.append(w); } else el.append(h('span', { class: 'g' }, g.t));
  if (org) el.append(h('i', { class: 'oi' }, org[0].toUpperCase()));
  return el;
}

// ---------- state ----------
const S = { projects: [], runtime: { sessions: [], external: [], containers: [], recent: [], exposures: [], otherPorts: [] }, settings: {}, host: {}, stats: null, hist: { cpu: [], mem: [], gpu: [], net: [], t: [] } };
const UI = { view: localStorage.getItem('bd.view') || 'home', q: '', filter: 'all', drawer: null, tab: 'overview', logTarget: null, showTunnels: false, menuOpen: false, follow: true, logSrc: null, collapsed: JSON.parse(localStorage.getItem('bd.collapsed') || '{}') };

// ---------- api ----------
async function api(path, body) {
  const r = await fetch('/api/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.out || r.statusText);
  return j;
}
function toast(msg, kind = '') { const t = h('div', { class: 'toast ' + kind }, msg); $('#toasts').append(t); setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(() => t.remove(), 300); }, kind === 'err' ? 7000 : 3500); }
async function act(label, p) { try { const r = await p; toast(label + (r?.out ? '\n' + r.out.split('\n').slice(-3).join('\n') : ''), 'ok'); return r; } catch (e) { toast(label + ' failed: ' + e.message, 'err'); throw e; } }

// ---------- derived ----------
const byId = () => Object.fromEntries(S.projects.map(p => [p.id, p]));
function runtimeFor(id) {
  const rt = S.runtime;
  return { sessions: rt.sessions.filter(s => s.project === id), external: rt.external.filter(e => e.project === id), containers: rt.containers.filter(c => c.project === id) };
}
function isLive(id) { const r = runtimeFor(id); return r.sessions.length || r.external.length || r.containers.some(c => c.state === 'running'); }
function gitOf(p) { if (p.git) return p.git; if (p.parent) { const par = byId()[p.parent]; return par?.git || null; } return null; }
function publicHost() { return S.host.publicHost || location.hostname; }
function portUrl(port) { return `http://${publicHost()}:${port}`; }
function vscodeUrl(path) { const s = S.settings; return `vscode://vscode-remote/ssh-remote+${s.sshUser ? s.sshUser + '@' : ''}${s.sshHost || S.host.hostname}${path}?windowId=_blank`; } // windowId=_blank => always a NEW VS Code window
// ttyd runs with --base-path /term. Over HTTPS (tailscale serve routes /term to it) the terminal is SAME-ORIGIN, which
// is what makes clipboard, paste-image and the mobile keyboard fit work without workarounds; plain HTTP goes to :7681.
function termUrl(session) { return (location.protocol === 'https:' ? '' : `http://${publicHost()}:${S.host.terminalPort || 7681}`) + `/term/?arg=${encodeURIComponent(session)}`; }
// ---------- terminals panel (embedded ttyd, one iframe per opened session, kept alive for instant switching) ----------
// Line icons (SF-Symbols-ish, 1.8 stroke, currentColor) instead of emoji — one look on Mac, iPhone and Linux.
const ICONS = {
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.2A8 8 0 1 1 21 12z"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  bellOff: '<path d="M6 16V11a6 6 0 0 1 9.3-5M18 11v5l1.5 2H7"/><path d="M10 20a2 2 0 0 0 4 0M4 4l16 16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  ext: '<path d="M7 17 17 7M9 7h8v8"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 7A8 8 0 1 0 17.7 7"/>',
  clip: '<path d="m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.3 3.3 0 0 1 4.7 4.7L10.5 18a1.7 1.7 0 0 1-2.4-2.4L16 7.7"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
};
function ico(name, size = 15) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  e.setAttribute('viewBox', '0 0 24 24'); e.setAttribute('width', size); e.setAttribute('height', size); e.setAttribute('fill', 'none'); e.setAttribute('stroke', 'currentColor'); e.setAttribute('stroke-width', '1.8'); e.setAttribute('stroke-linecap', 'round'); e.setAttribute('stroke-linejoin', 'round'); e.setAttribute('class', 'ico ico-' + name); e.setAttribute('aria-hidden', 'true');
  e.innerHTML = ICONS[name] || ''; return e;
}
// Terminal / Chat is ONE global switch for this device (Mac, phone …): every Claude session shows the same way.
const TERM = { open: false, active: null, frames: new Map(), lastUsed: new Map(), showList: false, listKey: '', mode: localStorage.getItem('bd.mode') === 'chat' ? 'chat' : 'term', chatEv: {}, chatN: 40 };
const chatMode = name => TERM.mode === 'chat' && !!claudeOf(name);
// Focus: hide the session list in the terminal panel (screen sharing) — per device, remembered
TERM.focus = localStorage.getItem('bd.focus') === '1';
function setFocus(on) { TERM.focus = on; localStorage.setItem('bd.focus', on ? '1' : '0'); document.body.classList.toggle('focus', on); renderTermPanel(true); }
function setMode(mode) { TERM.mode = mode; localStorage.setItem('bd.mode', mode); renderTermPanel(true); renderChatPane(true); if (mode === 'term') { const f = TERM.frames.get(TERM.active); if (f) setTimeout(() => f.focus(), 50); } }
// Chat mode for the active session: the conversation view in place of the tmux iframe (same tmux session underneath)
async function renderChatPane(force) {
  const pane = $('#term-chat'); if (!pane) return; const name = TERM.active; const on = TERM.open && name && chatMode(name);
  pane.classList.toggle('hidden', !on); const f = name && TERM.frames.get(name); if (f) f.classList.toggle('on', !on && f.classList.contains('on'));
  if (!on) return;
  if (pane.dataset.name !== name) { pane.innerHTML = ''; pane.append(h('div', { class: 'dim', style: 'padding:20px' }, 'loading…')); pane.dataset.name = name; TERM.chatEv.key = ''; }
  if (TERM.chatEv.busy) return; TERM.chatEv.busy = true;
  let t; try { t = await api(`transcript/${encodeURIComponent(name)}?n=${TERM.chatN}`); } catch (e) { TERM.chatEv.busy = false; pane.replaceChildren(h('div', { class: 'dim', style: 'padding:20px' }, e.message, ' — this session has no transcript yet; use the terminal.')); return; }
  TERM.chatEv.busy = false;
  if (TERM.active !== name) return;
  const cl = claudeOf(name) || {}; const key = [name, t.size, t.total, cl.state, cl.lastTool, TERM.chatN, (PENDING[name] || []).length].join(':');
  if (!force && TERM.chatEv.key === key) return;
  TERM.chatEv.key = key;
  renderConversation(pane, name, t, { n: TERM.chatN, more: () => { TERM.chatN = Math.min(200, TERM.chatN * 2); renderChatPane(true); }, refresh: () => renderChatPane(false) });
}
// Poll while a conversation is on screen (panel chat or session drawer): the transcript grows while Claude writes
// text, and no hook fires for that — 2 s is fast enough to feel live and cheap (a tail read of one file).
setInterval(() => {
  if (document.hidden) return;
  if (TERM.open && TERM.active && chatMode(TERM.active)) renderChatPane(false);
  if (UI.drawer && String(UI.drawer).startsWith('session:') && SESS.tab === 'transcript') renderSessionDrawer(false);
}, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderChatPane(false); if (UI.drawer && String(UI.drawer).startsWith('session:')) renderSessionDrawer(false); } });
const FRAME_IDLE_MS = 10 * 60e3;   // hidden iframes are dropped after this: each one is a tmux client fighting over the pane size
function openTerm(session) {
  if (!TERM.open) pushLayer('term');
  TERM.open = true; TERM.showList = false; ensureFrame(session); TERM.active = session; TERM.lastUsed.set(session, Date.now());
  const cl = claudeOf(session); if (cl && (cl.state === 'needs-you' || cl.state === 'error')) api('claude-seen', { session }).catch(() => {});
  renderTermPanel(true); renderChatPane(true);
  const f = TERM.frames.get(session); if (f && !chatMode(session)) setTimeout(() => f.focus(), 50);   // focus ONLY here, never on a state tick
}
function openTermTab(session) { window.open(termUrl(session), '_blank'); }
function closeTermPanel(pop = true) { if (!TERM.open) return; TERM.open = false; renderTermPanel(); if (pop) popLayer(); }
function termOrder() { return [...new Set([...termSessions().all.map(x => x.name), ...TERM.frames.keys()])]; }
function switchTerm(dir) { const o = termOrder(); if (!o.length) return; const i = Math.max(0, o.indexOf(TERM.active)); openTerm(o[(i + dir + o.length) % o.length]); }
// ---------- mobile keyboard vs. terminal panel ----------
// iOS: the software keyboard shrinks only the VISUAL viewport. The panel is `position: fixed; inset: 0` (100dvh), so it
// keeps its full height and the iframe's bottom (prompt line + key bar) ends up UNDER the keyboard; the iframe never
// gets a `resize`, ttyd never re-fits, tmux/Claude keep drawing for the old size ("tmux won't adapt when the keyboard
// opens"). The iframe is cross-origin (:7681) and can't read our visualViewport, so the panel is sized HERE from it —
// the iframe then gets a plain `resize` and ttyd + the touch layer re-fit. Only on touch devices; on the Mac VV == window.
const VV = window.visualViewport, TOUCH = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
function fitTermPanel() {
  fitLayer($('#termpanel'), TERM.open); fitLayer($('#drawer'), !!UI.drawer);
}
function fitLayer(el, open) {
  if (!el) return;
  if (!open || !VV || !TOUCH) { el.style.height = ''; el.style.top = ''; el.style.bottom = ''; return; }
  const hgt = Math.round(VV.height), top = Math.round(VV.offsetTop);
  if (!(hgt > 0)) return;
  if (el.style.height !== hgt + 'px') el.style.height = hgt + 'px';
  if (el.style.top !== top + 'px') el.style.top = top + 'px';
  el.style.bottom = 'auto';
}
// The keyboard slides for ~300ms; VV events come late/once, so follow it frame by frame for a while (same trick as the layer).
let vvUntil = 0, vvTicking = false;
function trackVV(ms) {
  vvUntil = Math.max(vvUntil, Date.now() + ms);
  if (vvTicking) return; vvTicking = true;
  (function tick() { fitTermPanel(); if (Date.now() < vvUntil) requestAnimationFrame(tick); else vvTicking = false; })();
}
if (VV && TOUCH) {
  VV.addEventListener('resize', () => trackVV(400)); VV.addEventListener('scroll', () => trackVV(200));
  document.addEventListener('focusin', () => trackVV(700), true); document.addEventListener('focusout', () => trackVV(700), true);
  window.addEventListener('orientationchange', () => trackVV(900));
}
// messages from the terminal layer (term/mobile.html): keyboard shortcuts inside the terminal reach us here
window.addEventListener('message', e => {
  const d = e.data; if (!d || !d.bd) return;
  if (d.bd === 'fit') trackVV(700);
  else if (d.bd === 'switch') switchTerm(d.dir || 1);
  else if (d.bd === 'dashboard') closeTermPanel();
  else if (d.bd === 'palette') openPalette();
  else if (d.bd === 'jump') { const o = termOrder(); if (o[d.n - 1]) openTerm(o[d.n - 1]); }
});
function ensureFrame(session) {
  if (TERM.frames.has(session)) return TERM.frames.get(session);
  const f = h('iframe', { class: 'termframe', src: termUrl(session), title: session, allow: 'clipboard-read; clipboard-write' });
  TERM.frames.set(session, f); TERM.lastUsed.set(session, Date.now()); return f;
}
function dropFrame(session) { const f = TERM.frames.get(session); if (f) f.remove(); TERM.frames.delete(session); TERM.lastUsed.delete(session); if (TERM.active === session) TERM.active = [...TERM.frames.keys()].pop() || null; renderTermPanel(true); }
// hidden iframes that nobody looked at for a while go away (the session keeps running; reopening is one click)
function gcFrames() { const now = Date.now(); for (const k of [...TERM.frames.keys()]) if (k !== TERM.active && now - (TERM.lastUsed.get(k) || 0) > FRAME_IDLE_MS) dropFrame(k); }
// '+ shell' → tmux session sh-N on the server (survives reload; 'shell' = ttyd's plain non-tmux bash, kept only for old tabs)
async function newShell() { try { const r = await api('shell', {}); openTerm(r.name); } catch (e) { toast('shell failed: ' + e.message, 'err'); } }
function claudeOf(name) { const s = S.runtime.sessions.find(x => x.name === name); return s && s.claude || null; }
const isClaudeSession = s => s.name.startsWith('claude-') || s.current === 'claude' || !!s.claude;
// Claude first, and within Claude: the ones that need you, then the ones working, then idle.
const STATE_RANK = { permission: 0, error: 1, 'needs-you': 2, working: 3, background: 4, idle: 5, unknown: 6, ended: 7 };
function termSessions() {
  const P = byId(); const out = { claude: [], dev: [], other: [], all: [] };
  for (const s of S.runtime.sessions) {
    const pr = P[s.project]; const item = { name: s.name, pid: s.project, project: pr?.name || s.cwd?.split('/').pop() || '?', org: pr?.org || '', group: pr?.group, cpu: s.cpu, mem: s.mem, started: s.startedAt, cwd: s.cwd, current: s.current, attached: s.attached, ports: (s.ports || []).filter(p => !p.ephemeral), managed: s.managed, claude: s.claude || null };
    if (isClaudeSession(s)) out.claude.push({ ...item, account: s.claude?.account || (s.name.endsWith('-company') ? 'company' : 'personal') });
    else if (s.managed) out.dev.push({ ...item, label: s.label });
    else out.other.push(item);
  }
  // NO sorting by state: the user switches between these all day and relies on each one keeping its position.
  // Order = tmux's own (alphabetical by session name), which is stable for the life of a session.
  out.all = [...out.claude, ...out.dev, ...out.other];
  return out;
}
const STATE_LABEL = { working: 'working', background: 'waiting on background task', permission: 'needs permission', 'needs-you': 'done · needs you', error: 'error', limit: 'usage limit', idle: 'idle', unknown: 'no signal yet', ended: 'claude exited' };
const STATE_ICON = { working: '●', background: '◐', permission: '⚠', 'needs-you': '✓', error: '✗', limit: '⏳', idle: '○', unknown: '·', ended: '■' };
function stateBadge(cl) {
  if (!cl) return null; const st = cl.state || 'unknown';
  return h('span', { class: 'cst ' + st, title: (STATE_LABEL[st] || st) + (cl.since ? ' since ' + new Date(cl.since).toLocaleTimeString() : '') }, h('i', null, STATE_ICON[st] || '·'), ' ', STATE_LABEL[st] || st, cl.since && st !== 'unknown' ? h('b', null, ' ' + ago(cl.since)) : null);
}
// which Claude on a project this is: the base one (by account), a numbered extra instance, or a git worktree
function instOf(it) {
  const cl = it.claude || {}; const wt = cl.worktree || (it.name.match(/-wt-([^-]+)/) ? { name: it.name.match(/-wt-([^-]+)/)[1] } : null);
  const n = it.name.match(/^claude-.*-(\d+)(-company)?$/);
  return { wt, n: n ? +n[1] : null, branch: cl.branch || null, label: wt ? '⎇ ' + wt.name : n ? '#' + n[1] : '#1' };
}
// Claude sessions grouped per project, in tmux order (the first session of a project fixes the group's position)
function claudeGroups(list) {
  const groups = []; const by = new Map();
  for (const it of list) { const key = it.pid || it.name; let g = by.get(key); if (!g) { g = { key, pid: it.pid, project: it.project, org: it.org, items: [] }; by.set(key, g); groups.push(g); } g.items.push(it); }
  return groups;
}
const GROUP_SEL = JSON.parse(localStorage.getItem('bd.gsel') || '{}');
function selectTab(key, name) { GROUP_SEL[key] = name; localStorage.setItem('bd.gsel', JSON.stringify(GROUP_SEL)); renderTermStrip(); }
// "+" on a card / group: another instance or a worktree on that project (same menu as the ✦ Claude ▾ button)
function plusClaude(ev, pid) { ev.stopPropagation(); const p = pid && byId()[pid]; if (!p) return toast('no project for this session', 'err'); claudeMenu(ev, p); }
// branch / worktree tag: a worktree gets its own colour and the path on hover
function whereTag(cl) {
  if (!cl) return null;
  if (cl.worktree) return h('span', { class: 'ag-tag wt', title: `git worktree · ${home(cl.worktree.path)}` + (cl.branch ? ` · branch ${cl.branch}` : '') }, '⎇ ', cl.worktree.name, cl.branch && cl.branch !== cl.worktree.name ? h('i', null, ' · ' + cl.branch) : null);
  if (cl.branch) return h('span', { class: 'ag-tag br', title: 'branch ' + cl.branch }, '⎇ ', cl.branch);
  return null;
}
const nice = n => n.startsWith('claude-') ? '✦ ' + n.replace(/^claude-/, '').replace(/-company$/, ' (company)') : n.startsWith('bd_') ? '▶ ' + n.replace(/^bd_/, '').replace('__', ' · ') : n === 'shell' ? 'bash' : n.startsWith('sh-') ? '$ ' + n : n;
function renderTermPanel(force) {
  const el = $('#termpanel'); const live = S.runtime.sessions.length; $('#term-count').textContent = live;
  el.classList.toggle('hidden', !TERM.open); document.body.classList.toggle('term-open', TERM.open);
  if (!TERM.open) { fitTermPanel(); return; }
  trackVV(300);
  el.classList.toggle('showlist', TERM.showList); el.classList.toggle('focus', TERM.focus);
  if (!$('#term-list')) {
    el.append(h('aside', { class: 'termside' }, h('div', { class: 'termside-head' }, h('button', { class: 'btn sm ghost back', title: 'back to dashboard — all sessions keep running (Esc)', onclick: closeTermPanel }, ico('back'), 'Dashboard'), h('span', { class: 'sp' }), h('button', { class: 'btn sm', title: 'new bash shell in the dev folder', onclick: newShell }, ico('plus', 13), 'Shell'), h('button', { class: 'btn sm ghost icon desk', title: 'focus mode — hide the session list (for screen sharing)', onclick: () => setFocus(true) }, ico('sidebar', 15))), h('div', { id: 'term-list' })),
      h('section', { class: 'termmain' }, h('div', { class: 'termbar', id: 'term-bar' }), h('div', { class: 'termframes', id: 'term-frames' }, h('div', { class: 'chatpane hidden', id: 'term-chat' }))));
  }
  const S3 = termSessions(); const known = new Set(S.runtime.sessions.map(s => s.name));
  const extra = [...TERM.frames.keys()].filter(k => !known.has(k));
  // The list and the bar are rebuilt only when something they show actually changed. Rebuilding them on every
  // 3-second state tick blurred the terminal iframe (the focus bug) and made the sidebar flicker.
  const key = JSON.stringify([TERM.active, TERM.showList, TERM.mode, TERM.focus, S3.all.map(x => [x.name, x.claude?.state, x.claude?.title, x.claude?.draft, x.claude?.model, x.claude?.effort, x.claude?.branch, x.claude?.worktree?.name, x.claude?.version, (S.settings.muted || []).includes(x.name), Math.floor((x.cpu || 0) / 10), x.ports.map(p => p.port)]), extra, [...TERM.frames.keys()], S.runtime.sessions.filter(s => s.name === TERM.active).map(s => s.project + (gitOf(byId()[s.project] || {})?.dirty || 0))]);
  const frames = $('#term-frames'); const chatOn = TERM.active && chatMode(TERM.active);
  for (const [k, f] of TERM.frames) { if (!f.isConnected) frames.append(f); f.classList.toggle('on', k === TERM.active && !chatOn); }
  $('#term-chat').classList.toggle('hidden', !chatOn);
  if (!force && key === TERM.listKey) return;
  TERM.listKey = key;
  const list = $('#term-list'); list.innerHTML = '';
  let idx = 0;
  // Sidebar card: avatar · name + account · state pill + model · branch / title. Three clear lines, actions on hover.
  const item = (it, kind, sub) => {
    const isActive = TERM.active === it.name; const opened = TERM.frames.has(it.name); const cl = it.claude; const i = kind === 'claude' ? instOf(it) : null;
    const where = i && (i.wt ? h('span', { class: 'grp wt', title: i.wt.path ? 'git worktree · ' + home(i.wt.path) : 'git worktree' }, '⎇ ' + i.wt.name + (i.branch && i.branch !== i.wt.name ? ' · ' + i.branch : '')) : i.branch ? h('span', { class: 'grp', title: 'branch' }, '⎇ ' + i.branch) : null);
    const name = kind === 'claude' ? (sub ? h('span', { class: 'inst' }, i.label) : (cl?.label || it.project)) : kind === 'dev' ? it.project : it.name.startsWith('sh-') ? it.name : it.name;
    const tag = kind === 'claude' ? h('span', { class: 'badge tag acc ' + it.account }, it.account) : kind === 'dev' ? h('span', { class: 'grp' }, it.label) : it.name.startsWith('sh-') ? h('span', { class: 'grp' }, 'bash') : null;
    const line2 = cl ? [h('span', { class: 'cst mini ' + cl.state }, STATE_ICON[cl.state] || '·', ' ', STATE_LABEL[cl.state] || cl.state), cl.model ? h('span', { class: 'mdl' }, modelName(cl.model)) : null, !sub && i && i.n ? h('span', { class: 'grp' }, '#' + i.n) : null]
      : [h('span', { class: 'grp' }, [it.group, it.org].filter(Boolean).join(' · ') || home(it.cwd)), h('span', { class: 'grp' }, `${ago(it.started)} · ${it.cpu.toFixed(0)}% · ${fmtB(it.mem)}`)];
    const line3 = cl ? [where, cl.title ? h('span', { class: 'ttl', title: cl.title }, cl.title) : cl.lastPrompt ? h('span', { class: 'ttl dim', title: cl.lastPrompt }, '❯ ' + cl.lastPrompt) : null] : null;
    return h('div', { class: 'titem ' + kind + (sub ? ' sub' : '') + (isActive ? ' on' : '') + (opened ? ' opened' : '') + (cl ? ' st-' + cl.state : ''), style: `--org:${orgColor(it.org)}`, onclick: () => openTerm(it.name), title: it.name },
      kind === 'claude' && !sub ? avatar(it.pid) : h('span', { class: 'dot' }),
      h('div', { class: 'tt' },
        h('div', { class: 'tn' }, h('span', { class: 'nm' }, name), tag),
        h('div', { class: 'ts' }, ...line2.filter(Boolean)),
        line3 && line3.some(Boolean) ? h('div', { class: 't3' }, ...line3.filter(Boolean)) : null),
      h('div', { class: 'tacts' },
        kind === 'claude' && !sub && it.pid ? h('button', { class: 'x plus', title: 'another Claude on this project', onclick: ev => plusClaude(ev, it.pid) }, ico('plus', 15)) : null,
        h('button', { class: 'x', title: 'open in new tab', onclick: ev => { ev.stopPropagation(); openTermTab(it.name); } }, ico('ext', 15))));
  };
  const section = (title, arr, kind) => arr.length ? [h('div', { class: 'tsec' }, title, h('span', { class: 'n' }, arr.length)), ...arr.map(it => item(it, kind))] : [];
  // Claude: one row per session; a project with several Claudes gets a header row and its sessions indented under it (tabs)
  const claudeRows = [];
  for (const g of claudeGroups(S3.claude)) {
    if (g.items.length === 1) { claudeRows.push(item(g.items[0], 'claude')); continue; }
    claudeRows.push(h('div', { class: 'tgrp', style: `--org:${orgColor(g.org)}` }, avatar(g.pid, 'sm'), h('span', { class: 'tgn' }, g.project), h('span', { class: 'n' }, g.items.length), h('span', { class: 'sp' }), g.pid ? h('button', { class: 'x plus', title: 'another Claude on this project', onclick: ev => plusClaude(ev, g.pid) }, ico('plus', 13)) : null));
    for (const it of g.items) claudeRows.push(item(it, 'claude', true));
  }
  list.append(...(S3.claude.length ? [h('div', { class: 'tsec' }, 'Claude instances', h('span', { class: 'n' }, S3.claude.length)), ...claudeRows] : []), ...section('Dev servers', S3.dev, 'dev'), ...section('Other tmux', S3.other, 'other'));
  // opened frames whose session vanished (or plain shells)
  if (extra.length) list.append(h('div', { class: 'tsec' }, 'Open tabs', h('span', { class: 'n' }, extra.length)), ...extra.map(k => h('div', { class: 'titem other' + (TERM.active === k ? ' on' : ''), onclick: () => { TERM.active = k; renderTermPanel(true); } }, h('span', { class: 'dot', style: k === 'shell' ? 'background:var(--accent);box-shadow:0 0 8px var(--accent)' : 'background:var(--dim);box-shadow:none' }), h('div', { class: 'tt' }, h('div', { class: 'tn' }, k === 'shell' ? 'bash · ' + home(S.host.devRoot || '~') : k), h('div', { class: 'ts' }, k === 'shell' ? 'plain shell' : 'session ended')), h('button', { class: 'x', title: 'close tab', onclick: ev => { ev.stopPropagation(); dropFrame(k); } }, ico('x', 13)))));
  if (!S.runtime.sessions.length && !TERM.frames.size) list.append(h('div', { class: 'note', style: 'padding:12px' }, 'No tmux sessions. Start a Claude session from a project card (✦ Claude ▾) or a dev server (▶), or open a shell.'));
  const bar = $('#term-bar'); bar.innerHTML = '';
  const barAdd = (...xs) => bar.append(...xs.filter(x => x != null && x !== false)); // Element.append() would render a literal "null" for sessions without a project
  const act = S.runtime.sessions.find(s => s.name === TERM.active); const cl = act && act.claude;
  // mobile: ☰ + native <select> session picker (sidebar is an overlay there)
  const allNames = [...new Set([...S3.all.map(x => x.name), ...TERM.frames.keys()])];
  bar.append(h('button', { class: 'btn sm mob', title: 'sessions', onclick: () => { TERM.showList = !TERM.showList; renderTermPanel(true); } }, '☰'),
    h('select', { class: 'mob tsel', onchange: e => openTerm(e.target.value) }, allNames.map(n => h('option', { value: n, selected: n === TERM.active }, (claudeOf(n) ? (STATE_ICON[claudeOf(n).state] || '') + ' ' : '') + nice(n)))));
  const actProj = act && byId()[act.project]; const actGit = actProj && gitOf(actProj);
  const actDirty = actGit && !actGit.error ? actGit.dirty + actGit.untracked : 0;
  // one switch for every session on this device — not per session
  const chatSw = cl && cl.hooked ? h('span', { class: 'seg', title: 'Terminal or Chat view — applies to all Claude sessions on this device' }, h('button', { class: 'segb' + (TERM.mode !== 'chat' ? ' on' : ''), onclick: () => setMode('term') }, ico('terminal', 14), h('span', { class: 'desk' }, 'Terminal')), h('button', { class: 'segb' + (TERM.mode === 'chat' ? ' on' : ''), onclick: () => setMode('chat') }, ico('chat', 14), h('span', { class: 'desk' }, 'Chat'))) : null;
  const actName = act ? (cl?.label || (act.project && byId()[act.project]?.name) || TERM.active) : TERM.active;
  if (TERM.active) barAdd(TERM.focus ? h('button', { class: 'btn sm ghost icon desk', title: 'show the session list', onclick: () => setFocus(false) }, ico('sidebar', 15)) : null, act ? avatar(act.project, 'sm') : null, h('span', { class: 'tname desk', title: TERM.active }, actName, instOf(act || { name: TERM.active }).n ? h('span', { class: 'grp' }, ' #' + instOf(act).n) : null), chatSw, cl ? stateBadge(cl) : null, modelChip(cl), cl ? whereTag(cl) : null, cl && cl.title ? h('span', { class: 'dim desk ttitle', title: cl.title }, cl.title) : act ? h('span', { class: 'dim mono desk', style: 'font-size:11.5px' }, act.cwd) : h('span', { class: 'dim desk' }, TERM.active === 'shell' ? home(S.host.devRoot || '~') : 'session ended'), h('span', { class: 'sp' }),
    actProj ? h('button', { class: 'btn sm projbtn', title: 'project details — changes, files, logs, branches, docker', onclick: () => openDrawer(actProj.id, actDirty ? 'changes' : 'overview') }, ico('folder', 14), h('span', { class: 'desk' }, 'Project'), actDirty ? h('span', { class: 'pill warn' }, '± ' + actDirty) : null) : null,
    act ? h('button', { class: 'btn sm desk', title: 'copy the ssh command that attaches to this tmux session', onclick: () => navigator.clipboard.writeText(attachCmd(TERM.active)).then(() => toast('copied')) }, ico('copy', 13), 'ssh') : null,
    h('button', { class: 'btn sm desk', title: 'open in new browser tab', onclick: () => openTermTab(TERM.active) }, ico('ext', 13), 'Tab'),
    h('button', { class: 'btn sm ghost desk', title: 'close this VIEW only — the session keeps running in tmux', onclick: () => dropFrame(TERM.active) }, ico('x', 13), 'Close view'),
    cl && cl.state === 'limit' && act ? h('button', { class: 'btn sm primary', title: 'start the other account in this folder with a summary of where this one stopped', onclick: () => handoff({ name: TERM.active, account: cl.account, project: act.project }) }, '⇄ Hand off') : null,
    cl && cl.version && S.claude?.installed && cl.version !== S.claude.installed ? h('button', { class: 'btn sm dirtybtn desk', title: `running Claude Code ${cl.version}, ${S.claude.installed} is installed — restart this session (same conversation, --resume)`, onclick: () => restartSession({ name: TERM.active, project: act?.project }) }, ico('refresh', 13), S.claude.installed) : null,
    cl && cl.hooked ? h('button', { class: 'btn sm ghost desk', title: (S.settings.muted || []).includes(TERM.active) ? 'muted — click to get notifications again' : 'mute notifications from this session', onclick: () => api('claude-mute', { session: TERM.active, muted: !(S.settings.muted || []).includes(TERM.active) }).then(r => toast(r.muted.includes(TERM.active) ? 'muted' : 'unmuted')) }, ico((S.settings.muted || []).includes(TERM.active) ? 'bellOff' : 'bell', 14)) : null,
    act ? h('button', { class: 'btn sm danger', title: 'KILL this tmux session — the process is stopped (Ctrl-C, then kill)', onclick: () => killSession(TERM.active) }, ico('power', 13), 'Kill') : null,
    h('button', { class: 'btn sm ghost mob', title: 'back to dashboard (sessions keep running)', onclick: closeTermPanel }, ico('back', 15)));
  else barAdd(h('span', { class: 'dim' }, 'Pick a session.'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost mob', onclick: closeTermPanel }, ico('back', 15)));
}
// remember what gets started per project (dev commands, compose, Claude account) -> "▶▶ Start all" brings it all up next time
function noteBundle(p, entry) { const b = (S.settings.projects?.[p.id]?.bundle || []).filter(x => !(x.kind === entry.kind && x.name === entry.name)); b.push(entry); api('project', { id: p.id, bundle: b.slice(-8) }).catch(() => {}); }
async function startBundle(p) {
  const b = S.settings.projects?.[p.id]?.bundle || []; if (!b.length) return;
  for (const e of b) { try { if (e.kind === 'cmd') { if (!runtimeFor(p.id).sessions.some(s => s.label === e.name)) await act(`${p.name}: ${e.name}`, api('run', { id: p.id, name: e.name })); } else if (e.kind === 'claude') await startClaude(p, e.name, {}, true); } catch {} }
}
async function startClaude(p, account, opts = {}, quiet) {
  if (!quiet) noteBundle(p, { kind: 'claude', name: account });
  try { const r = await api('claude', { id: p.id, account, ...opts }); toast(r.existed ? `Attaching to ${r.name}` : `Started ${r.name} (${account})`, 'ok'); openTerm(r.name); }
  catch (e) { toast('Claude session failed: ' + e.message, 'err'); }
}
function claudeMenu(ev, p) {
  const r = runtimeFor(p.id); const live = new Set(r.sessions.map(s => s.name));
  const base = p.dirName.replace(/[^A-Za-z0-9_.-]+/g, '-'); const per = `claude-${base}`, co = `claude-${base}-company`;
  const mine = r.sessions.filter(s => isClaudeSession(s));
  const wt = account => { const name = prompt('Worktree / branch name for the new Claude session (e.g. feat-login):'); if (name) startClaude(p, account, { worktree: name.trim() }); };
  openMenu(ev, [
    { header: 'Claude Code session (tmux, --dangerously-skip-permissions)' },
    { label: 'Personal', sub: live.has(per) ? `${per} · running → attach` : `${per} · gmail account`, icon: live.has(per) ? '●' : '✦', cur: live.has(per), onclick: () => startClaude(p, 'personal') },
    { label: 'Company', sub: live.has(co) ? `${co} · running → attach` : `${co} · company account`, icon: live.has(co) ? '●' : '✦', cur: live.has(co), onclick: () => startClaude(p, 'company') },
    ...mine.filter(s => s.name !== per && s.name !== co).map(s => ({ label: nice(s.name).replace(/^✦ /, ''), sub: (s.claude && (STATE_LABEL[s.claude.state] + (s.claude.title ? ' · ' + s.claude.title : ''))) || 'running → attach', icon: '●', cur: true, onclick: () => openTerm(s.name) })),
    'sep',
    { label: 'Personal — resume last', sub: 'claude --continue', icon: '↺', disabled: live.has(per), onclick: () => startClaude(p, 'personal', { resume: true }) },
    { label: 'Company — resume last', sub: 'claude --continue', icon: '↺', disabled: live.has(co), onclick: () => startClaude(p, 'company', { resume: true }) },
    'sep',
    { header: 'More Claudes on this project' },
    { label: 'Another personal instance', sub: `${per}-2 · same working tree`, icon: '＋', onclick: () => startClaude(p, 'personal', { fresh: true }) },
    { label: 'Another company instance', sub: `${co.replace(/-company$/, '')}-2-company · same working tree`, icon: '＋', onclick: () => startClaude(p, 'company', { fresh: true }) },
    p.isGit ? { label: 'Personal in a git worktree…', sub: 'claude --worktree <name> · separate branch + directory', icon: '⎇', onclick: () => wt('personal') } : null,
    p.isGit ? { label: 'Company in a git worktree…', sub: 'claude --worktree <name> · separate branch + directory', icon: '⎇', onclick: () => wt('company') } : null,
    'sep',
    { label: 'Copy ssh command', sub: attachCmd(per), icon: '⎘', onclick: () => navigator.clipboard.writeText(attachCmd(per)).then(() => toast('copied — paste in a terminal on your laptop')) },
  ].filter(Boolean));
}
function exposedPort(port) { return S.runtime.exposures.find(e => e.port === port); }
function reachable(p) { return !p.loopback || !!exposedPort(p.port); }

// ---------- header ----------
function renderHeader() {
  const mac = (S.host.tailscale?.peers || []).find(p => p.os === 'macOS'); const macTxt = mac ? ` · mac ${mac.online ? '● online' : '○ offline'}` : '';
  $('#hostline').textContent = `${S.host.hostname || ''} · ${S.host.tsIp || publicHost()}${macTxt}`; $('#hostline').title = `${S.host.tsName || ''} · ${S.projects.filter(p => !p.hidden).length} projects · dev root ${S.host.devRoot}`;
  const orgs = [...new Set(S.projects.map(p => p.org))];
  const liveCount = S.projects.filter(p => isLive(p.id)).length;
  const chips = [['all', 'All', S.projects.filter(p => !p.hidden).length, null], ['running', 'Running', liveCount, 'var(--green)'], ...orgs.map(o => [o, o, S.projects.filter(p => p.org === o && !p.hidden).length, orgColor(o)])];
  const f = $('#filters'); f.innerHTML = '';
  for (const [key, label, n, color] of chips) f.append(h('button', { class: 'chip' + (UI.filter === key ? ' on' : ''), onclick: () => { UI.filter = key; render(); } }, color ? h('span', { class: 'dot', style: `background:${color}` }) : null, label, h('span', { class: 'n' }, n)));
  $('#tunnel-count').textContent = S.runtime.exposures.length;
  $('#proj-count').textContent = S.projects.filter(p => !p.hidden).length;
  { const open = (S.claude?.tasks || []).filter(t => t.status !== 'done').length; const tc = $('#task-count'); if (tc) { tc.textContent = open; tc.classList.toggle('hot', open > 0); } }
  const need = S.runtime.sessions.filter(s => s.claude && s.claude.needsYou).length; const nb = $('#need-count'); if (nb) { nb.textContent = need; nb.classList.toggle('hidden', !need); }
  document.title = (need ? `(${need}) ` : '') + 'Beast Dash';
}

// ---------- stats ----------
const spark = {};
function sparkline(canvas, data, color, max = 100, fill = true) {
  const dpr = window.devicePixelRatio || 1; const W = canvas.clientWidth, H = canvas.clientHeight; if (!W) return;
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const n = Math.max(data.length, 2); const step = W / (180 - 1);
  const x = i => W - (data.length - 1 - i) * step; const y = v => H - 2 - Math.min(1, (v || 0) / max) * (H - 6);
  ctx.beginPath(); data.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  if (fill && data.length > 1) { ctx.lineTo(x(data.length - 1), H); ctx.lineTo(x(0), H); ctx.closePath(); const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, color.replace(')', ',.35)').replace('rgb', 'rgba')); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fill(); }
}
const usd = v => v == null ? '–' : v < 10 ? '$' + v.toFixed(2) : '$' + v.toFixed(0);
// "claude-opus-5[1m]" -> "Opus 5 · 1M", "claude-fable-5-1" -> "Fable 5.1", "claude-haiku-4-5-20251001" -> "Haiku 4.5"
function modelName(id) {
  if (!id) return null; const m = String(id).match(/^(?:claude-)?([a-z]+)(?:-(\d+)(?:-(\d+))?)?(?:-\d{8})?(?:\[(\w+)\])?/i); if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1); const ver = m[2] ? ' ' + m[2] + (m[3] ? '.' + m[3] : '') : '';
  return name + ver + (m[4] ? ' · ' + m[4].toUpperCase() : '');
}
const modelChip = cl => cl && cl.model ? h('span', { class: 'badge tag model', title: `model: ${cl.model}${cl.effort ? ' · effort ' + cl.effort : ''}` }, '◈ ', modelName(cl.model), cl.effort && cl.effort !== 'high' ? h('i', null, ' · ' + cl.effort) : null) : null;
// plan limits (5 h session / 7 d / Fable) per account, as Claude Code's /usage shows them
const inStr = ts => { const s = Math.max(0, (ts - Date.now()) / 1000); const mm = Math.round(s / 60), hh = Math.round(s / 3600); if (s < 60) return '<1m'; if (mm < 60) return mm + 'm'; if (hh < 24) return Math.floor(mm / 60) + 'h ' + (mm % 60) + 'm'; return Math.floor(hh / 24) + 'd ' + (hh % 24) + 'h'; };
const resetStr = ts => { if (!ts) return ''; const d = new Date(ts); const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return (ts - Date.now() < 86400e3 && d.getDate() === new Date().getDate() ? hm : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm) + ' (in ' + inStr(ts) + ')'; };
const limCls = w => !w || w.pct == null ? '' : w.pct >= 90 || w.severity === 'critical' ? 'hot' : w.pct >= 70 || (w.severity && w.severity !== 'normal') ? 'warn' : '';
function limitRow(label, w, title) {
  if (!w) return null; const c = limCls(w);
  return h('div', { class: 'limrow ' + c, title: (title || label) + (w.resetsAt ? ' · resets ' + resetStr(w.resetsAt) : '') }, h('span', { class: 'll' }, label), h('span', { class: 'lb' }, h('b', { style: `width:${Math.min(100, w.pct || 0)}%` })), h('span', { class: 'lp mono' }, (w.pct ?? '–') + '%'), h('span', { class: 'lr mono' }, w.resetsAt ? inStr(w.resetsAt) : ''));
}
// one column of the "Claude usage limits" card: big 5 h number + reset, then the week / Fable / extra rows
function limitCol(account, L) {
  const badge = h('span', { class: 'badge tag acc ' + account, title: (L.plan || '') + (L.tier ? ' · ' + L.tier : '') + (L.fetchedAt ? ' · fetched ' + ago(L.fetchedAt) + ' ago' : '') + (L.error ? ' · last fetch failed: ' + L.error : '') }, account, L.plan ? ' · ' + L.plan : '');
  if (L.error && !L.session) return h('div', { class: 'limcol' }, h('div', { class: 'k' }, badge), h('div', { class: 'v' }, '–'), h('div', { class: 's' }, L.error));
  const se = L.session; const all = [se, L.weekly, ...(L.scoped || [])].map(limCls); const cls = all.includes('hot') ? 'hot' : all.includes('warn') ? 'warn' : '';
  return h('div', { class: 'limcol ' + cls },
    h('div', { class: 'k' }, badge, se && se.resetsAt ? h('span', { class: 'mono dim', style: 'text-transform:none;letter-spacing:0;font-weight:500' }, 'resets ' + resetStr(se.resetsAt)) : null),
    h('div', { class: 'v' }, se ? se.pct + '' : '–', h('small', null, se ? '% of 5h session' : (L.error || 'no session window'))),
    h('div', { class: 'lim' }, limitRow('week', L.weekly, '7-day window, all models'), ...(L.scoped || []).map(w => limitRow(w.name, w, `7-day window, ${w.name} only`)),
      L.extra?.enabled ? h('div', { class: 'limrow' }, h('span', { class: 'll' }, 'extra'), h('span', { class: 'lb' }, h('b', { style: `width:${Math.min(100, L.extra.pct || 0)}%` })), h('span', { class: 'lp mono wide' }, `${usd(L.extra.used || 0)} / ${usd(L.extra.limit)}`)) : null));
}
function limitsTile(LM) {
  const cols = ['personal', 'company'].filter(a => LM[a]); if (!cols.length) return null;
  return h('div', { class: 'tile w3', 'data-k': 'limits' }, h('div', { class: 'k' }, h('span', null, 'Claude usage limits'), h('span', { class: 'dim', style: 'font-size:10.5px;text-transform:none;letter-spacing:0', title: 'the same windows /usage shows inside Claude Code: 5-hour session, 7-day all models, 7-day per model, extra-usage credits' }, '/usage')),
    h('div', { class: 'limcols' }, cols.map(a => limitCol(a, LM[a]))));
}
// donut: used share of a whole, percent in the middle (disk)
function ring(pct, size = 58, stroke = 7) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r; const color = pct > 90 ? 'var(--red)' : pct > 75 ? 'var(--amber)' : 'var(--accent)';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'ring'); svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  const circ = (cls, dash, col) => { const e = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); e.setAttribute('cx', size / 2); e.setAttribute('cy', size / 2); e.setAttribute('r', r); e.setAttribute('fill', 'none'); e.setAttribute('stroke', col); e.setAttribute('stroke-width', stroke); if (dash != null) { e.setAttribute('stroke-dasharray', `${dash} ${c}`); e.setAttribute('stroke-linecap', 'round'); e.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`); } e.setAttribute('class', cls); return e; };
  svg.append(circ('bg', null, 'rgba(255,255,255,.08)'), circ('fg', c * Math.min(100, Math.max(0, pct)) / 100, color));
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'text'); t.setAttribute('x', size / 2); t.setAttribute('y', size / 2); t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central'); t.setAttribute('class', 'rt'); t.textContent = pct.toFixed(0) + '%'; svg.append(t);
  return svg;
}
// temperature chip: hue slides cyan -> green -> yellow -> red as it climbs (35 °C and below is cool, 95 °C is red)
function tempChip(t, what) {
  if (t == null || !(t > 0)) return null; const hue = Math.round(195 * (1 - Math.min(1, Math.max(0, (t - 35) / 60))));
  return h('span', { class: 'temp', style: `color:hsl(${hue} 45% 68%);background:hsl(${hue} 45% 68% / .12);border-color:hsl(${hue} 45% 68% / .3)`, title: (what || 'temperature') + ` ${t.toFixed(1)} °C` }, t.toFixed(0) + '°');
}
function renderStats() {
  const s = S.stats; const el = $('#stats'); if (!s) return;
  const tiles = [];
  const tile = (key, k, v, unit, sub, cls, extra) => h('div', { class: 'tile ' + (cls || ''), 'data-k': key }, h('div', { class: 'k' }, h('span', null, k), extra?.right), h('div', { class: 'v' }, v, h('small', null, unit)), h('div', { class: 's' }, sub), extra?.body, h('canvas'));
  const cpuCls = s.cpu.pct > 85 ? 'hot' : s.cpu.pct > 60 ? 'warn' : '';
  tiles.push(tile('cpu', 'CPU', s.cpu.pct.toFixed(0), '%', `${s.cpu.count} cores · load ${s.load.map(x => x.toFixed(2)).join(' ')}`, cpuCls, { right: tempChip(s.cpu.temp, 'CPU (Tctl)'), body: h('div', { class: 'cores' }, s.cpu.cores.map(c => h('i', null, h('b', { style: `width:${c}%;background:${c > 85 ? 'var(--red)' : c > 50 ? 'var(--amber)' : 'var(--accent)'}` })))) }));
  const memPct = s.mem.used / s.mem.total * 100;
  tiles.push(tile('mem', 'Memory', fmtB(s.mem.used), '/ ' + fmtB(s.mem.total), `${memPct.toFixed(0)}% used · cache ${fmtB(s.mem.cached)}${s.mem.swapUsed > 50e6 ? ' · swap ' + fmtB(s.mem.swapUsed) : ''}`, memPct > 90 ? 'hot' : memPct > 75 ? 'warn' : ''));
  if (s.gpu) tiles.push(tile('gpu', 'GPU', s.gpu.util, '%', `${s.gpu.name.replace('NVIDIA GeForce ', '')} · ${fmtB(s.gpu.memUsed)}/${fmtB(s.gpu.memTotal)}${s.gpu.power ? ' · ' + s.gpu.power.toFixed(0) + 'W' : ''}`, s.gpu.util > 85 ? 'warn' : '', { right: tempChip(s.gpu.temp, 'GPU') }));
  tiles.push(tile('net', 'Network', fmtRate(s.net.rxRate), '↓', `↑ ${fmtRate(s.net.txRate)} · ${Object.keys(s.net.ifaces).filter(i => i !== 'tailscale0').join(', ')} + tailscale0`, '', { right: tempChip(s.temps?.nic, 'ethernet controller') }));
  const d = s.disks?.[0]; if (d) { const pct = d.used / d.size * 100; tiles.push(tile('disk', 'Disk ' + d.mount, fmtB(d.used), '/ ' + fmtB(d.size), `${fmtB(d.avail)} free · ${d.fs}`, pct > 90 ? 'hot' : pct > 75 ? 'warn' : '', { right: tempChip(s.temps?.nvme, 'hottest NVMe drive'), body: ring(pct) })); }
  const u = S.claude?.usage;
  if (u) tiles.push(tile('claude', 'Claude today', usd(u.total.today), 'API-equiv.', `personal ${usd(u.personal.today)} · company ${usd(u.company.today)} · yesterday ${usd(u.total.yesterday)} · 7d ${usd(u.total.week)}`, '', { right: h('span', { class: 'dim', style: 'font-size:10.5px', title: 'What these tokens would cost at API list price. On a subscription nothing is billed per token; this measures how much work the sessions did.' }, 'est.') }));
  const lt = limitsTile(S.claude?.limits || {}); if (lt) tiles.push(lt);
  tiles.push(tile('up', 'Uptime', fmtUp(s.uptime), '', `${S.runtime.sessions.length} sessions · ${S.runtime.external.length} procs · ${S.runtime.containers.filter(c => c.state === 'running').length}/${S.runtime.containers.length} containers`));
  el.replaceChildren(...tiles);
  drawSparks();
}
function drawSparks() {
  const H = S.hist; const u = S.claude?.usage;
  const map = { cpu: [H.cpu, 'rgb(126,166,224)', 100], mem: [H.mem, 'rgb(169,147,201)', 100], gpu: [H.gpu, 'rgb(127,191,149)', 100], net: [H.net.map(x => x[0] + x[1]), 'rgb(207,160,106)', Math.max(1e5, ...H.net.map(x => x[0] + x[1]))] };
  if (u) { const series = u.days.map((_, i) => u.personal.series[i] + u.company.series[i]); map.claude = [series, 'rgb(142,142,147)', Math.max(1, ...series)]; }
  for (const [k, [data, color, max]] of Object.entries(map)) { const c = $(`.tile[data-k="${k}"] canvas`); if (c) sparkline(c, data, color, max); }
}

// ---------- agents (home page: every Claude session as a card, needs-you first) ----------
function killSession(name, label) {
  if (!confirm(`Kill session "${label || name}"?\n\nThis STOPS the process (tmux session is destroyed). To just leave the terminal open, use ← Dashboard / Close view instead.`)) return;
  act('Kill ' + (label || name), api('stop', { session: name })).then(() => dropFrame(name));
}
const home = c => (c || '').replace(/^\/home\/[^/]+\//, '~/');
// The command that attaches to a tmux session from another machine (needs the ssh alias from Settings).
const attachCmd = name => `ssh ${S.settings?.sshHost || S.host?.hostname || 'server'} -t tmux attach -t ${name}`;
// health from the server probe: ok (2xx-4xx) · warn (5xx / no answer) · down (nothing accepts the connection) · tcp (up, not HTTP)
function healthOf(port) { return (S.health || {})[port] || null; }
function healthTitle(hh) { if (!hh) return ''; return hh.state === 'ok' ? `HTTP ${hh.status} · ${hh.ms} ms` : hh.state === 'warn' ? (hh.status ? `HTTP ${hh.status}` : hh.note || 'no answer') : hh.state === 'tcp' ? `accepts connections (not HTTP) · ${hh.ms} ms` : 'DOWN — nothing answers on this port'; }
function portChip(p, extraTitle) { const hh = healthOf(p.port); return h('a', { href: portUrl(p.port), target: '_blank', title: (reachable(p) ? 'open ' + portUrl(p.port) : 'loopback only — not exposed') + (hh ? '\n' + healthTitle(hh) : '') + (extraTitle || ''), class: (reachable(p) ? '' : 'lo') + (hh ? ' h-' + hh.state : ''), onclick: ev => ev.stopPropagation() }, hh ? h('i', { class: 'hd' }) : null, ':' + p.port); }
const portLinksOf = ports => ports?.length ? h('span', { class: 'ports' }, ports.map(p => portChip(p))) : null;
// A compact, uniform card: who (name · #n / worktree · account), where (branch · model · cost), and ONE status line —
// what the session is doing, or a one-line recap of why it needs you. The whole card opens the terminal;
// prompting, kill, mute, handoff and restart live in the terminal bar.
const oneLine = (t, n = 160) => { t = String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]+/g, '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function agentCard(it) {
  const cl = it.claude || { state: 'unknown' }; const st = cl.state || 'unknown'; const i = instOf(it);
  let line;   // [class, icon, text]
  if (st === 'working') line = ['work', h('span', { class: 'spin' }), cl.lastTool ? cl.lastTool : 'thinking…'];
  else if (st === 'background') line = ['work', '◐', 'waiting on a background task'];
  else if (st === 'permission') line = ['need', '⚠', 'Needs you — wants to run: ' + (cl.lastTool || '?')];
  else if (st === 'limit') line = ['need', '⏳', 'Usage limit — ' + oneLine(cl.limitText || (it.account + ' account'))];
  else if (st === 'error') line = ['err', '✗', 'Error — ' + oneLine(cl.lastMessage || 'open the terminal')];
  else if (st === 'needs-you') line = ['need', '✓', 'Needs you — ' + oneLine(cl.lastMessage || 'finished')];
  else if (st === 'ended') line = ['dim', '■', 'claude exited'];
  else line = ['dim', '○', cl.lastMessage ? oneLine(cl.lastMessage) : cl.lastPrompt ? '❯ ' + oneLine(cl.lastPrompt) : 'idle'];
  return h('div', { class: 'agent st-' + st, style: `--org:${orgColor(it.org)}`, 'data-name': it.name, title: it.name + ' — open terminal', onclick: () => openTerm(it.name) },
    h('div', { class: 'ag-rail' }),
    h('div', { class: 'ag-head' },
      avatar(it.pid),
      h('div', { class: 'ag-id' },
        h('div', { class: 'ag-name' }, h('span', { class: 'nm' }, cl.label || (it.name.startsWith('sh-') ? it.name : it.project)), i.n ? h('span', { class: 'ag-tag' }, '#' + i.n) : null, i.wt ? h('span', { class: 'ag-tag wt', title: i.wt.path ? 'git worktree · ' + home(i.wt.path) : 'git worktree' }, '⎇ ' + i.wt.name) : null, h('span', { class: 'badge tag acc ' + it.account }, it.account)),
        h('div', { class: 'ag-sub mono', title: [i.wt ? 'worktree ' + i.wt.name : null, i.branch ? 'branch ' + i.branch : null, cl.model, cl.usage ? usd(cl.usage.cost) + ' API-equivalent' : null].filter(Boolean).join(' · ') }, [i.branch && !i.wt ? '⎇ ' + i.branch : i.wt && i.branch && i.branch !== i.wt.name ? '⎇ ' + i.branch : null, cl.model ? modelName(cl.model) : null, cl.usage ? usd(cl.usage.cost) : null, ago(it.started)].filter(Boolean).join(' · '))),
      stateBadge(cl)),
    h('div', { class: 'ag-line ' + line[0], title: typeof line[2] === 'string' ? line[2] : '' }, h('span', { class: 'ic' }, line[1]), h('span', { class: 'tx' }, line[2])));
}
// One project, several Claudes: a tab per session (fixed tmux order) above the selected session's card.
// Tabs never move; the other tabs' state shows as a coloured dot so you notice a "needs you" behind the active one.
function agentGroup(g) {
  if (g.items.length === 1) return agentCard(g.items[0]);
  const sel = g.items.find(x => x.name === GROUP_SEL[g.key]) || g.items[0];
  const tab = it => { const cl = it.claude || {}; const i = instOf(it); const st = cl.state || 'unknown';
    return h('button', { class: 'agtab st-' + st + (it.name === sel.name ? ' on' : ''), title: `${it.name} · ${STATE_LABEL[st] || st}` + (i.branch ? ' · ' + i.branch : '') + (cl.title ? '\n' + cl.title : ''), onclick: ev => { ev.stopPropagation(); selectTab(g.key, it.name); } },
      h('i', { class: 'dot' }), i.label, h('span', { class: 'badge tag acc ' + it.account }, it.account), cl.needsYou ? h('b', { class: 'need' }, STATE_ICON[st]) : null); };
  return h('div', { class: 'agroup st-' + (sel.claude?.state || 'unknown'), style: `--org:${orgColor(g.org)}` },
    h('div', { class: 'agtabs' }, h('span', { class: 'agproj', title: g.items.length + ' Claude sessions on ' + g.project }, avatar(g.pid, 'sm'), g.project), g.items.map(tab)),
    agentCard(sel));
}
function restartSession(it) {
  if (!confirm(`Restart Claude in ${it.name}?\n\nIt sends /exit, waits, then relaunches with --resume on the same conversation (picks up the installed update). Takes ~10 s.`)) return;
  act('Restart ' + it.project, api('claude-restart', { session: it.name }));
}
function handoff(it) {
  const to = it.account === 'company' ? 'personal' : 'company';
  if (!confirm(`Start a ${to} session in the same folder with a handoff summary (recent prompts, last reply, files edited)?\n\nThis session stays as it is.`)) return;
  act('Hand off ' + it.project, api('handoff', { session: it.name })).then(r => { if (r && r.name) setTimeout(() => openTerm(r.name), 1500); });
}
function renameSession(it, cl) {
  const v = prompt('Label for this card (empty = back to the project name). Only the label changes; the card keeps its position.', cl.label || '');
  if (v === null) return; api('claude-label', { session: it.name, label: v }).then(r => toast(r.label ? 'renamed to ' + r.label : 'label removed', 'ok')).catch(e => toast(e.message, 'err'));
}
function renderTermStrip() {
  const el = $('#termstrip'); if (!el) return;
  const S3 = termSessions();
  el.innerHTML = '';
  const need = S3.claude.filter(x => x.claude?.needsYou).length, working = S3.claude.filter(x => x.claude && (x.claude.state === 'working' || x.claude.state === 'background')).length;
  el.append(h('div', { class: 'tshead' },
    h('span', { class: 'tstitle' }, '✦ Agents', h('span', { class: 'n' }, S3.claude.length)),
    S3.claude.length ? h('span', { class: 'inbox' }, need ? h('span', { class: 'ib need' }, `${need} need${need === 1 ? 's' : ''} you`) : null, working ? h('span', { class: 'ib work' }, `${working} working`) : null, !need && !working ? h('span', { class: 'ib idle' }, 'all idle') : null) : null,
    h('span', { class: 'sp' }),
    h('span', { class: 'hint dim', title: 'order never changes: alphabetical by tmux session name' }, 'fixed order'),
    S.runtime.sessions.length ? h('button', { class: 'btn sm ghost', title: 'full-screen terminal view  (t)', onclick: () => { if (!TERM.open) pushLayer('term'); TERM.open = true; if (!TERM.active) { const c = S3.claude[0] || S.runtime.sessions[0]; if (c) ensureFrame(c.name), TERM.active = c.name; } renderTermPanel(true); } }, ico('full', 13), 'Terminals') : null,
    h('button', { class: 'btn sm', title: 'new bash shell in the dev folder  (s)', onclick: newShell }, ico('plus', 13), 'Shell')));
  const ss = scheduledStrip(); if (ss) el.append(ss);
  if (!S3.claude.length) { el.append(h('div', { class: 'tsempty' }, 'No Claude sessions. Open ', h('a', { href: '#', onclick: ev => { ev.preventDefault(); setView('projects'); } }, 'Projects'), ' and press ✦ Claude ▾ on a card, or ⌘K.')); return; }
  el.append(h('div', { class: 'agents' }, claudeGroups(S3.claude).map(agentGroup)));
}

// ---------- running (home page): dev servers, processes, containers, shells — one table with controls ----------
const RUN = { filter: localStorage.getItem('bd.runFilter') || 'all', stopped: false };
function renderRunning() {
  const el = $('#running'); el.innerHTML = ''; const P = byId(); const S3 = termSessions();
  const rows = [];
  const pname = id => P[id]?.name || null;
  for (const s of S3.dev) rows.push({ kind: 'dev', org: P[s.pid]?.org, id: s.pid, name: s.project, what: s.label, cmd: S.runtime.sessions.find(x => x.name === s.name)?.cmd || '', ports: s.ports, cpu: s.cpu, mem: s.mem, since: s.started, session: s.name,
    actions: [['⌨', 'terminal', () => openTerm(s.name)], ['☰', 'logs', () => openDrawer(s.pid, 'logs', s.name)], ['↻', 'restart', () => act('Restart ' + s.label, api('restart', { session: s.name }))], ['■', 'stop', () => act('Stop ' + s.label, api('stop', { session: s.name })), 'danger']] });
  for (const e of S.runtime.external) rows.push({ kind: 'proc', org: P[e.project]?.org, id: e.project, name: pname(e.project) || e.comm, what: e.label, cmd: e.cmd, ports: e.ports.filter(p => !p.ephemeral), cpu: e.cpu, mem: e.mem, since: e.startedAt, pid: e.pid, title: (e.unit ? 'systemd user unit ' + e.unit : 'started outside beast-dash') + ' (pid ' + e.pid + ')pture',
    actions: [...(e.project && (e.unit || e.tty || e.outFile) ? [['☰', 'logs' + (e.unit ? ' (journal · ' + e.unit + ')' : e.tty ? ' (tmux pane)' : ' (file)'), () => openDrawer(e.project, 'logs', 'ext:' + e.pid)]] : []), ...(e.unit ? [['↻', 'restart ' + e.unit, () => confirm(`Restart ${e.unit}?`) && act('Restart ' + e.unit, api('unit', { unit: e.unit, action: 'restart' }))]] : []), ['■', 'kill pid ' + e.pid, () => confirm(`Kill pid ${e.pid} (${e.comm})? It was started outside the dashboard.`) && act('Kill ' + e.pid, api('kill', { pid: e.pid })), 'danger']] });
  for (const c of S.runtime.containers) {
    if (c.state !== 'running' && !RUN.stopped) continue;
    const ports = [...new Map(c.ports.filter(p => p.host).map(p => [p.host, { port: p.host, addr: p.hostIp, loopback: p.hostIp === '127.0.0.1' || p.hostIp === '::1' }])).values()];
    rows.push({ kind: 'docker', org: P[c.project]?.org, id: c.project, name: c.project ? pname(c.project) : c.name, what: c.service || c.name, cmd: c.image + ' · ' + c.status, ports, cpu: null, mem: null, since: null, dead: c.state !== 'running',
      actions: c.state === 'running' ? [['☰', 'logs', () => openDrawer(c.project, 'logs', 'docker:' + c.id)], ['↻', 'restart', () => act('restart ' + c.name, api('docker', { id: c.id, action: 'restart' }))], ['■', 'stop', () => act('stop ' + c.name, api('docker', { id: c.id, action: 'stop' })), 'danger']] : [['▶', 'start', () => act('start ' + c.name, api('docker', { id: c.id, action: 'start' })), 'primary'], ['✕', 'remove', () => confirm('Remove container ' + c.name + '?') && act('rm ' + c.name, api('docker', { id: c.id, action: 'rm' })), 'danger']] });
  }
  for (const s of S3.other) rows.push({ kind: 'shell', org: P[s.pid]?.org, id: s.pid, name: s.name.startsWith('sh-') ? '$ ' + s.name : s.name, what: s.current || 'bash', cmd: home(s.cwd), ports: s.ports, cpu: s.cpu, mem: s.mem, since: s.started, session: s.name,
    actions: [['⌨', 'terminal', () => openTerm(s.name)], ['⊘', 'kill session', () => killSession(s.name), 'danger']] });
  const counts = { all: rows.length, dev: rows.filter(r => r.kind === 'dev').length, proc: rows.filter(r => r.kind === 'proc').length, docker: rows.filter(r => r.kind === 'docker').length, shell: rows.filter(r => r.kind === 'shell').length };
  const KIND = { dev: ['▶', 'dev server'], proc: ['⚙', 'process'], docker: ['🐳', 'container'], shell: ['$', 'shell'] };
  const shown = rows.filter(r => RUN.filter === 'all' || r.kind === RUN.filter).sort((a, b) => String(a.org || 'zz').localeCompare(String(b.org || 'zz')) || String(a.name).localeCompare(String(b.name)));
  const chip = (k, l) => h('button', { class: 'chip' + (RUN.filter === k ? ' on' : ''), onclick: () => { RUN.filter = k; localStorage.setItem('bd.runFilter', k); renderRunning(); } }, l, h('span', { class: 'n' }, counts[k]));
  el.append(h('div', { class: 'tshead' },
    h('span', { class: 'tstitle run' }, '▶ Running', h('span', { class: 'n' }, counts.all)),
    h('span', { class: 'chips sm' }, chip('all', 'All'), chip('dev', 'Dev servers'), chip('proc', 'Processes'), chip('docker', 'Containers'), chip('shell', 'Shells')),
    h('span', { class: 'sp' }),
    h('label', { class: 'dim', style: 'font-size:12px;display:inline-flex;gap:6px;align-items:center;cursor:pointer' }, h('input', { type: 'checkbox', checked: RUN.stopped, onchange: e => { RUN.stopped = e.target.checked; renderRunning(); } }), 'stopped containers'),
    counts.dev ? h('button', { class: 'btn sm danger', title: 'stop every dev server started from the dashboard', onclick: async () => { if (!confirm('Stop all ' + counts.dev + ' dev servers?')) return; for (const r of rows.filter(r => r.kind === 'dev')) await act('Stop ' + r.what, api('stop', { session: r.session })); } }, '■ Stop all dev') : null));
  if (!shown.length) { el.append(h('div', { class: 'tsempty' }, rows.length ? 'Nothing of this kind.' : 'Nothing running. Start a dev server from ', h('a', { href: '#', onclick: ev => { ev.preventDefault(); setView('projects'); } }, 'Projects'), ' (▶) or open a shell.')); return; }
  const tbl = h('table', { class: 'runtbl' },
    h('thead', null, h('tr', null, h('th', { class: 'ck' }), h('th', null, 'Project'), h('th', null, 'What'), h('th', { class: 'ccmd' }, 'Command'), h('th', null, 'Ports'), h('th', { class: 'num' }, 'CPU'), h('th', { class: 'num' }, 'Mem'), h('th', { class: 'num' }, 'Up'), h('th', { class: 'cact' }))),
    h('tbody', null, shown.map(r => h('tr', { class: 'rr ' + r.kind + (r.dead ? ' dead' : ''), style: `--org:${orgColor(r.org)}`, title: r.title || (r.id ? 'open project details' : ''), onclick: ev => { if (ev.target.closest('a,button')) return; if (r.id) openDrawer(r.id, r.kind === 'docker' ? 'docker' : 'logs', r.session || null); } },
      h('td', { class: 'ck' }, h('span', { class: 'kd ' + r.kind, title: KIND[r.kind][1] }, KIND[r.kind][0])),
      h('td', { class: 'cname' }, h('span', { class: 'sw' }), h('b', null, r.name), r.org ? h('span', { class: 'org' }, r.org) : null),
      h('td', { class: 'cwhat' }, h('span', { class: 'what ' + r.kind }, r.what)),
      h('td', { class: 'ccmd mono', title: r.cmd }, r.cmd),
      h('td', { class: 'cports' }, portLinksOf(r.ports)),
      h('td', { class: 'num mono' }, r.cpu == null ? '' : r.cpu.toFixed(0) + '%'),
      h('td', { class: 'num mono' }, r.mem == null ? '' : fmtB(r.mem)),
      h('td', { class: 'num mono' }, r.since ? ago(r.since) : ''),
      h('td', { class: 'cact' }, r.actions.map(([l, t, f, cls]) => h('button', { class: 'btn sm ' + (cls || 'ghost'), title: t, onclick: ev => { ev.stopPropagation(); f(); } }, l)))))));
  el.append(h('div', { class: 'runwrap' }, tbl));
}

// ---------- tunnels ----------
// Panel skeleton is built once; only the rows re-render on state ticks so the manual-port input never loses focus/value.
function renderTunnels() {
  const el = $('#tunnels'); el.classList.toggle('hidden', !UI.showTunnels); if (!UI.showTunnels) return;
  if (!$('#tun-rows')) {
    const inp = h('input', { id: 'tun-port', placeholder: 'port', type: 'number', min: 1, max: 65535 });
    const doExpose = async () => { const v = +inp.value; if (!v) return; try { const r = await api('expose', { port: v }); toast(r.note || `exposed ${v}`, 'ok'); inp.value = ''; } catch (e) { toast('expose failed: ' + e.message, 'err'); } };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') doExpose(); });
    el.append(
      h('h3', null, '⇄ Exposed ports (socat → ', h('span', { class: 'mono', id: 'tun-ip' }, S.host.tsIp || '?'), ')', h('span', { class: 'sp' }),
        h('label', { class: 'sw-row', style: 'margin:0;font-size:12px;color:var(--muted)' }, h('input', { type: 'checkbox', id: 'tun-auto', checked: S.settings.autoExpose, onchange: e => api('settings', { autoExpose: e.target.checked }).then(() => toast('autoExpose ' + (e.target.checked ? 'on' : 'off'))) }), 'auto-expose loopback ports'),
        h('button', { class: 'btn sm', onclick: () => act('Rebuild tunnels', api('expose-rebuild', {})) }, '↻ Rebuild all'),
        h('button', { class: 'btn sm ghost', onclick: () => { UI.showTunnels = false; renderTunnels(); } }, '✕')),
      h('div', { class: 'row', style: 'border-top:0;padding-top:0' }, h('span', null, 'Expose manually:'), inp, h('button', { class: 'btn sm', onclick: doExpose }, 'expose'), h('span', { class: 'note', style: 'margin:0' }, 'Manual ports are pinned: they stay forwarded until you remove them, even if nothing listens yet.')),
      h('div', { id: 'tun-rows' }),
      h('div', { class: 'note', id: 'tun-other' }),
      h('div', { class: 'note' }, 'Links use ' + (S.host.publicHost || '') + ':PORT. For localhost:PORT on your laptop see README (mac/).'));
  }
  $('#tun-ip').textContent = S.host.tsIp || '?'; $('#tun-auto').checked = !!S.settings.autoExpose;
  const ex = S.runtime.exposures; const manual = new Set((S.runtime.manual || []).map(m => m.port));
  const rows = $('#tun-rows'); rows.innerHTML = '';
  if (!ex.length && !manual.size) rows.append(h('div', { class: 'note' }, 'No forwards active. Loopback-only ports of running projects get exposed automatically (if enabled) so your laptop can reach them at ' + (S.host.tsIp || 'the tailscale IP') + ':PORT.'));
  const shown = new Set();
  for (const e of ex) { shown.add(e.port); rows.append(h('div', { class: 'row' }, h('a', { href: portUrl(e.port), target: '_blank' }, `${e.bind}:${e.port}`), h('span', { class: 'arrow' }, '→'), h('span', null, e.target || '127.0.0.1:' + e.port), manual.has(e.port) ? h('span', { class: 'badge tag' }, 'manual') : h('span', { class: 'badge tag' }, 'auto'), h('span', { style: 'flex:1' }), h('span', { class: 'dim' }, 'pid ' + e.pid), h('button', { class: 'btn sm danger', onclick: () => act('Remove ' + e.port, api('unexpose', { pid: e.pid, port: manual.has(e.port) ? e.port : null })) }, 'remove'))); }
  for (const m of (S.runtime.manual || [])) if (!shown.has(m.port)) rows.append(h('div', { class: 'row' }, h('span', { class: 'dim' }, `${S.host.tsIp}:${m.port}`), h('span', { class: 'arrow' }, '→'), h('span', { class: 'dim' }, `${m.addr}:${m.port}`), h('span', { class: 'badge tag' }, 'manual · pending'), h('span', { style: 'flex:1' }), h('span', { class: 'dim' }, 'already reachable directly, or starting…'), h('button', { class: 'btn sm danger', onclick: () => act('Remove ' + m.port, api('unexpose', { port: m.port })) }, 'remove')));
  $('#tun-other').textContent = S.runtime.otherPorts.length ? 'Other listening ports: ' + S.runtime.otherPorts.map(p => `${p.addr}:${p.port}${p.proc ? ' (' + p.proc + ')' : ''}`).join(', ') : '';
}
function renderBanner() {
  const el = $('#banner'); if (!el) return; const lr = S.host.lastResume; const ts = S.host.tailscale;
  const parts = [];
  if (lr && Date.now() - lr < 6 * 3600e3 && localStorage.getItem('bd.dismissResume') !== String(lr)) parts.push(h('div', { class: 'ban' }, h('b', null, '⏰ The server woke up ' + ago(lr) + ' ago.'), ' Sessions, containers and forwards on the server are still here. On your laptop: reconnect VS Code (Reload Window) / restart your tunnel if you use one.', h('span', { style: 'flex:1' }), h('button', { class: 'btn sm', onclick: () => act('Recover', api('recover', {})) }, '↻ Recover forwards'), h('button', { class: 'btn sm ghost', onclick: () => { localStorage.setItem('bd.dismissResume', String(lr)); renderBanner(); } }, '✕')));
  if (ts && ts.online === false) parts.push(h('div', { class: 'ban err' }, h('b', null, '⚠ Tailscale is offline on the server'), ' (' + (ts.backend || '') + '). ' + (ts.health || []).join(' ')));
  // dev servers started from the dashboard that died with a non-zero exit in the last 15 minutes
  for (const c of (S.crashes || [])) { const p = byId()[c.project]; parts.push(h('div', { class: 'ban err' }, h('b', null, `▶ ${p ? p.name : c.project} · ${c.name.split('__')[1] || c.name} exited ${c.exitCode}`), h('span', { class: 'dim mono', style: 'font-size:11.5px' }, ` ${ago(c.endedAt)} ago · ${c.cmd || ''}`), h('span', { style: 'flex:1' }),
    p ? h('button', { class: 'btn sm', onclick: () => openDrawer(p.id, 'logs', c.name) }, '☰ Logs') : null, p ? h('button', { class: 'btn sm primary', onclick: () => act('Restart ' + c.name, api('restart', { session: c.name })) }, '↻ Restart') : null,
    h('button', { class: 'btn sm ghost', title: 'dismiss', onclick: () => api('dismiss-crash', { key: c.name + c.endedAt }) }, '✕'))); }
  // Claude sessions that existed but whose tmux session is gone (reboot / tmux kill): bring them back with --resume
  const rs = (S.claude?.restorable || []);
  if (rs.length) parts.push(h('div', { class: 'ban restore' },
    h('b', null, `✦ ${rs.length} Claude session${rs.length > 1 ? 's' : ''} from before the restart`), h('span', { class: 'dim' }, ' — same folder, same conversation (claude --resume):'),
    h('span', { class: 'rlist' }, rs.map(r => h('span', { class: 'rchip', title: (r.title || '') + '\n' + r.cwd + '\ngone ' + ago(r.gone) + ' ago' },
      h('button', { class: 'btn sm', onclick: () => act('Restore ' + r.tmux, api('claude-restore', { tmux: r.tmux })).then(() => openTerm(r.tmux)) }, '↺ ', r.tmux.replace(/^claude-/, ''), r.account === 'company' ? h('span', { class: 'badge tag acc company' }, 'company') : null),
      h('button', { class: 'x', title: 'forget this one', onclick: () => api('claude-forget', { tmux: r.tmux }) }, '✕')))),
    h('span', { style: 'flex:1' }),
    h('button', { class: 'btn sm primary', onclick: () => act('Restore all', api('claude-restore', {})) }, '↺ Restore all'),
    h('button', { class: 'btn sm ghost', title: 'forget all', onclick: () => { if (confirm('Forget these sessions? (they stay in claude --resume history, just not here)')) for (const r of rs) api('claude-forget', { tmux: r.tmux }); } }, '✕')));
  el.replaceChildren(...parts); el.classList.toggle('hidden', !parts.length);
}

// ---------- cards ----------
function matches(p) {
  if (p.hidden && UI.filter !== 'hidden') return false;
  if (UI.filter === 'running' && !isLive(p.id)) return false;
  if (UI.filter !== 'all' && UI.filter !== 'running' && UI.filter !== 'hidden' && p.org !== UI.filter) return false;
  if (!UI.q) return true;
  const q = UI.q.toLowerCase(); const g = gitOf(p); const r = runtimeFor(p.id);
  const hay = [p.name, p.rel, p.framework, p.primary, ...p.tags, g?.branch, ...r.sessions.flatMap(s => s.ports.map(x => x.port)), ...r.external.flatMap(s => s.ports.map(x => x.port)), ...r.containers.map(c => c.name)].join(' ').toLowerCase();
  return hay.includes(q);
}
function badges(p) {
  const b = [h('span', { class: 'badge ' + p.primary }, p.primary)];
  if (p.framework) b.push(h('span', { class: 'badge fw' }, p.framework));
  for (const t of p.tags.filter(t => t !== 'compose' && t !== 'dockerfile')) b.push(h('span', { class: 'badge tag' }, t));
  if (p.tags.includes('compose')) b.push(h('span', { class: 'badge tag' }, 'compose'));
  return b;
}
function gitRow(p) {
  const g = gitOf(p); if (!g) return h('div', { class: 'gitrow' }, h('span', { class: 'dim' }, p.parent ? 'sub-project' : 'no git'));
  if (g.error) return h('div', { class: 'gitrow' }, h('span', { style: 'color:var(--red)' }, g.error));
  const target = p.isGit ? p : byId()[p.parent];
  return h('div', { class: 'gitrow' },
    h('button', { class: 'branch', title: 'switch branch', onclick: ev => branchMenu(ev, target) }, h('span', { class: 'ico' }, '⎇'), h('span', { class: 'b' }, g.branch), h('span', { class: 'caret' }, '▾')),
    g.dirty + g.untracked ? h('span', { class: 'dirty', title: `${g.dirty} modified, ${g.untracked} untracked` }, '● ' + (g.dirty + g.untracked)) : null,
    g.ahead ? h('span', { class: 'ab', title: 'ahead' }, '↑' + g.ahead) : null, g.behind ? h('span', { class: 'ab behind', title: 'behind' }, '↓' + g.behind) : null,
    g.stashes ? h('span', { class: 'stash', title: 'stashes' }, '⧉ ' + g.stashes) : null,
    g.last ? h('span', { class: 'last', title: g.last.subject }, h('b', null, g.last.hash), ' ', g.last.subject, ' · ', g.last.rel) : null);
}
function portLinks(ports) { return h('span', { class: 'ports' }, ports.filter(p => !p.ephemeral).map(p => portChip(p, reachable(p) ? '' : '\nbound to ' + p.addr + ' only — click ⇄ to expose'))); }
function runRows(p) {
  const r = runtimeFor(p.id); const rows = [];
  for (const s of r.sessions) rows.push(h('div', { class: 'run' + (s.name.startsWith('claude-') ? ' claude' : '') }, h('span', { class: 'dot' }), h('span', { class: 'lbl' }, s.name.startsWith('claude-') ? (s.name.endsWith('-company') ? 'Claude · company' : 'Claude · personal') : s.label), h('span', { class: 'cmd', title: s.cmd || s.current }, s.cmd || s.current), portLinks(s.ports), h('span', { class: 'res' }, `${s.cpu.toFixed(0)}% · ${fmtB(s.mem)} · ${ago(s.startedAt)}`),
    h('span', { class: 'acts' }, h('button', { class: 'btn sm', title: 'open live terminal (tmux attach in browser)', onclick: () => openTerm(s.name) }, '⌨'), h('button', { class: 'btn sm', title: 'logs', onclick: () => openDrawer(p.id, 'logs', s.name) }, '☰'), s.managed ? h('button', { class: 'btn sm', title: 'restart', onclick: () => act('Restart ' + s.label, api('restart', { session: s.name })) }, '↻') : null, h('button', { class: 'btn sm danger', title: 'stop (Ctrl-C, then kill)', onclick: () => act('Stop ' + s.label, api('stop', { session: s.name })) }, '■'))));
  for (const e of r.external) rows.push(h('div', { class: 'run ext', title: 'started outside beast-dash (pid ' + e.pid + ') — no log capture; attach via ssh' }, h('span', { class: 'dot' }), h('span', { class: 'lbl' }, e.label || e.comm), h('span', { class: 'cmd', title: e.cmd }, e.cmd), portLinks(e.ports), h('span', { class: 'res' }, `${e.cpu.toFixed(0)}% · ${fmtB(e.mem)}`),
    h('span', { class: 'acts' }, h('button', { class: 'btn sm danger', title: 'kill', onclick: () => confirm(`Kill pid ${e.pid} (${e.comm})? It was started outside the dashboard.`) && act('Kill ' + e.pid, api('kill', { pid: e.pid })) }, '■'))));
  for (const c of r.containers) rows.push(h('div', { class: 'run docker' + (c.state === 'running' ? '' : ' dead') }, h('span', { class: 'dot' }), h('span', { class: 'lbl' }, c.service || c.name), h('span', { class: 'cmd' }, c.image + ' · ' + c.status), c.state === 'running' ? portLinks([...new Map(c.ports.filter(x => x.host).map(x => [x.host, { port: x.host, addr: x.hostIp, loopback: x.hostIp === '127.0.0.1' || x.hostIp === '::1' }])).values()]) : null,
    h('span', { class: 'acts' }, h('button', { class: 'btn sm', title: 'logs', onclick: () => openDrawer(p.id, 'logs', 'docker:' + c.id) }, '☰'), c.state === 'running' ? h('button', { class: 'btn sm danger', title: 'stop', onclick: () => act('Stop ' + c.name, api('docker', { id: c.id, action: 'stop' })) }, '■') : h('button', { class: 'btn sm', title: 'start', onclick: () => act('Start ' + c.name, api('docker', { id: c.id, action: 'start' })) }, '▶'))));
  return rows.length ? h('div', { class: 'runs' }, rows) : null;
}
function primaryCmd(p) { return p.commands.find(c => c.primary) || p.commands.find(c => c.kind === 'serve') || p.commands.find(c => c.kind === 'compose' && /up/.test(c.name)) || null; }
function card(p) {
  const live = isLive(p.id); const pc = primaryCmd(p); const r = runtimeFor(p.id);
  const running = new Set(r.sessions.map(s => s.label));
  const g = gitOf(p); const target = p.isGit ? p : byId()[p.parent];
  const claudes = r.sessions.filter(s => isClaudeSession(s)); const devs = r.sessions.filter(s => !isClaudeSession(s)); const conts = r.containers.filter(c => c.state === 'running');
  // what is live, as small chips: Claude sessions (click -> terminal), dev servers with their port, containers
  const liveRow = claudes.length || devs.length || conts.length || r.external.length ? h('div', { class: 'live-row' },
    ...claudes.map(s => h('button', { class: 'lchip cl st-' + (s.claude?.state || 'unknown'), title: `${s.name} · ${STATE_LABEL[s.claude?.state] || ''}${s.claude?.title ? ' — ' + s.claude.title : ''}`, onclick: () => openTerm(s.name) }, h('i', { class: 'd' }), 'Claude', h('span', { class: 'badge tag acc ' + (s.claude?.account || (s.name.endsWith('-company') ? 'company' : 'personal')) }, s.claude?.account || (s.name.endsWith('-company') ? 'company' : 'personal')))),
    ...devs.map(s => h('button', { class: 'lchip dev', title: (s.cmd || s.current || '') + ' · logs', onclick: () => openDrawer(p.id, 'logs', s.name) }, h('i', { class: 'd' }), s.label, ...(s.ports || []).filter(x => !x.ephemeral).slice(0, 2).map(x => portChip(x)))),
    ...r.external.map(e => h('span', { class: 'lchip ext', title: e.cmd }, h('i', { class: 'd' }), e.label || e.comm, ...(e.ports || []).filter(x => !x.ephemeral).slice(0, 2).map(x => portChip(x)))),
    conts.length ? h('button', { class: 'lchip dock', title: conts.map(c => c.service || c.name).join(', '), onclick: () => openDrawer(p.id, 'docker') }, h('i', { class: 'd' }), `${conts.length} container${conts.length > 1 ? 's' : ''}`) : null) : null;
  const gitLine = !g ? null : g.error ? h('div', { class: 'gitrow' }, h('span', { style: 'color:var(--red)' }, g.error)) : h('div', { class: 'gitrow' },
    h('button', { class: 'branch', title: 'switch branch', onclick: ev => branchMenu(ev, target) }, h('span', { class: 'ico' }, '⎇'), h('span', { class: 'b' }, g.branch), h('span', { class: 'caret' }, '▾')),
    g.dirty + g.untracked ? h('button', { class: 'dirty', title: `${g.dirty} modified, ${g.untracked} untracked — open changes`, onclick: () => openDrawer(p.id, 'changes') }, '● ' + (g.dirty + g.untracked)) : null,
    g.ahead ? h('span', { class: 'ab', title: 'ahead of upstream' }, '↑' + g.ahead) : null, g.behind ? h('span', { class: 'ab behind', title: 'behind upstream — pull' }, '↓' + g.behind) : null,
    g.last ? h('span', { class: 'last', title: g.last.subject }, g.last.subject, h('i', null, ' · ' + g.last.rel)) : null);
  const startBtn = pc ? h('div', { class: 'split' },
    h('button', { class: 'btn sm', disabled: running.has(pc.name), title: pc.cmd, onclick: () => { noteBundle(p, { kind: 'cmd', name: pc.name }); act(`${p.name}: ${pc.name}`, api('run', { id: p.id, name: pc.name })); } }, '▶ ', pc.name),
    h('button', { class: 'btn sm', title: 'all commands', onclick: ev => cmdMenu(ev, p) }, h('span', { class: 'caret' }, '▾'))) : (p.commands.length ? h('button', { class: 'btn sm', onclick: ev => cmdMenu(ev, p) }, '▶ Run ', h('span', { class: 'caret' }, '▾')) : null);
  return h('div', { class: 'card' + (live ? ' live' : '') + (p.parent ? ' sub' : ''), style: `--org:${orgColor(p.org)};--pc:${projColor(p)}`, 'data-id': p.id },
    h('div', { class: 'head' }, avatar(p.id, 'lg'),
      h('div', { class: 'hd' },
        h('div', { class: 'name', onclick: () => openDrawer(p.id, 'overview') }, p.parent ? h('span', { class: 'crumb' }, p.parentName) : null, h('span', { class: 'nm' }, p.name)),
        h('div', { class: 'kind' }, h('span', { class: 'badge ' + p.primary }, p.primary), p.framework ? h('span', { class: 'fw' }, p.framework) : null, p.pm ? h('span', { class: 'fw dim' }, p.pm) : null)),
      h('button', { class: 'btn sm icon ghost', title: 'more', onclick: ev => moreMenu(ev, p) }, '⋯')),
    gitLine, liveRow,
    h('div', { class: 'actions' },
      h('button', { class: 'btn sm claude' + (claudes.length ? ' on' : ''), title: 'Claude Code session (personal / company)', onclick: ev => claudeMenu(ev, p) }, ico('chat', 14), 'Claude', h('span', { class: 'caret' }, '▾')),
      startBtn, h('span', { class: 'sp' }),
      h('button', { class: 'btn sm open', title: 'project details — changes, files, logs, branches, docker', onclick: () => openDrawer(p.id, 'overview') }, 'Open', ico('back', 13))));
}
function vscIcon() { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = '<path fill="#3ea7f2" d="M17.6 2.2 9.4 9.7 4.7 6.1 3 7l4.2 5L3 17l1.7.9 4.7-3.6 8.2 7.5L21 20V4zM17.4 7.4v9.2L11.6 12z"/>'; return s; }
const KIND_RANK = { backend: 0, infra: 1, monorepo: 2, frontend: 3, mobile: 4, lib: 5, node: 6, repo: 7 };
const kindRank = p => KIND_RANK[p.primary] ?? 8;
function sortProjects(a, b) { return (b.pinned - a.pinned) || (kindRank(a) - kindRank(b)) || a.name.localeCompare(b.name); }
function gridFor(ps) {
  const grid = h('div', { class: 'grid' });
  const roots = ps.filter(p => !p.parent || !ps.find(x => x.id === p.parent)).sort(sortProjects);
  for (const p of roots) { grid.append(card(p)); for (const sub of ps.filter(x => x.parent === p.id).sort(sortProjects)) grid.append(card(sub)); }
  return grid;
}
function renderMain() {
  const main = $('#main'); main.innerHTML = '';
  const shown = S.projects.filter(matches);
  if (!shown.length) { main.append(h('div', { class: 'empty-main' }, S.projects.length ? 'No projects match.' : 'Scanning…')); return; }
  const orgs = [...new Set(shown.map(p => p.org))];
  for (const org of orgs) {
    const ps = shown.filter(p => p.org === org);
    const live = ps.filter(p => isLive(p.id)).length; const collapsed = UI.collapsed[org] && !UI.q && UI.filter === 'all';
    const section = h('section', { class: 'group', style: `--org:${orgColor(org)}` });
    section.append(h('div', { class: 'ghead' }, h('h2', null, h('span', { class: 'sw' }), org), h('span', { class: 'meta' }, `${ps.length} projects${live ? ` · ${live} live` : ''}`), h('span', { class: 'sp' }), h('a', { class: 'btn sm ghost vsc', href: vscodeUrl(S.host.devRoot + '/' + org), title: 'open org folder in VS Code' }, vscIcon(), ' folder'), h('button', { class: 'btn sm ghost', onclick: () => { UI.collapsed[org] = !UI.collapsed[org]; localStorage.setItem('bd.collapsed', JSON.stringify(UI.collapsed)); render(); } }, collapsed ? '▸ expand' : '▾ collapse')));
    if (!collapsed) {
      const groups = [...new Set(ps.map(p => p.group))].sort((a, b) => (a === null) - (b === null) || String(a).localeCompare(String(b)));
      if (groups.length === 1 && groups[0] === null) section.append(gridFor(ps));
      else for (const g of groups) {
        const gps = ps.filter(p => p.group === g); const glive = gps.filter(p => isLive(p.id)).length;
        const key = org + '/' + g; const gcol = UI.collapsed[key] && !UI.q && UI.filter === 'all';
        section.append(h('div', { class: 'product' + (glive ? ' live' : '') },
          h('div', { class: 'phead' }, h('span', { class: 'pname' }, g === null ? 'misc' : g), h('span', { class: 'pmeta' }, `${gps.length}${glive ? ` · ${glive} live` : ''}`), h('span', { class: 'pline' }),
            g !== null ? h('a', { class: 'btn sm ghost vsc', href: vscodeUrl(S.host.devRoot + '/' + org + '/' + g), title: 'open product folder in VS Code' }, vscIcon()) : null,
            h('button', { class: 'btn sm ghost', onclick: () => { UI.collapsed[key] = !UI.collapsed[key]; localStorage.setItem('bd.collapsed', JSON.stringify(UI.collapsed)); render(); } }, gcol ? '▸' : '▾')),
          gcol ? null : gridFor(gps)));
      }
    }
    main.append(section);
  }
}

// ---------- menus ----------
function openMenu(ev, items) {
  const m = $('#menu'); m.innerHTML = ''; m.classList.remove('hidden'); UI.menuOpen = true;
  for (const it of items) {
    if (it === 'sep') { m.append(h('div', { class: 'sep' })); continue; }
    if (it.header) { m.append(h('div', { class: 'mh' }, it.header)); continue; }
    if (it.el) { m.append(it.el); continue; }
    m.append(h('div', { class: 'mi' + (it.cur ? ' cur' : '') + (it.disabled ? ' dis' : '') + (it.danger ? ' danger' : ''), title: it.title, onclick: () => { closeMenu(); it.onclick?.(); } }, h('span', { class: 'ico' }, it.icon || ''), h('span', { class: 'k' }, it.label), it.sub ? h('span', { class: 'c' }, it.sub) : null));
  }
  const r = ev.currentTarget.getBoundingClientRect(); m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 12) + 'px'; m.style.top = (r.bottom + 6 + m.offsetHeight > innerHeight ? r.top - m.offsetHeight - 6 : r.bottom + 6) + 'px';
  setTimeout(() => document.addEventListener('mousedown', onDocDown, { once: true }), 0);
}
function onDocDown(e) { if (!$('#menu').contains(e.target)) closeMenu(); else setTimeout(() => document.addEventListener('mousedown', onDocDown, { once: true }), 0); }
function closeMenu() { $('#menu').classList.add('hidden'); UI.menuOpen = false; render(); }
const KIND_ICON = { serve: '▶', build: '⚒', check: '✓', install: '⇩', compose: '🐳', task: '·', custom: '★' };
function cmdMenu(ev, p) {
  const running = new Set(runtimeFor(p.id).sessions.map(s => s.label));
  const groups = [['custom', 'Custom'], ['serve', 'Serve'], ['compose', 'Docker compose'], ['build', 'Build'], ['install', 'Install'], ['check', 'Checks'], ['task', 'Other']];
  const items = [];
  for (const [k, label] of groups) { const cs = p.commands.filter(c => (c.custom ? 'custom' : c.kind) === k); if (!cs.length) continue; items.push({ header: label }); for (const c of cs) items.push({ label: c.name, sub: c.cmd, icon: KIND_ICON[k], cur: running.has(c.name), disabled: running.has(c.name), title: c.cmd, onclick: () => { noteBundle(p, { kind: 'cmd', name: c.name }); act(`${p.name}: ${c.name}`, api('run', { id: p.id, name: c.name })); } }); }
  items.push('sep', { label: 'Custom command…', icon: '＋', onclick: () => { openDrawer(p.id, 'overview'); setTimeout(() => $('#newcmd')?.focus(), 300); } });
  openMenu(ev, items);
}
async function branchMenu(ev, p) {
  const anchor = ev.currentTarget;
  openMenu(ev, [{ header: 'Loading branches…' }]);
  let br; try { br = await api(`git/${p.id}/branches`); } catch (e) { toast(e.message, 'err'); return; }
  const filter = h('input', { class: 'f', placeholder: 'filter / new branch name…', autofocus: true });
  const build = q => {
    const items = [{ el: filter }];
    const L = br.local.filter(b => !q || b.name.toLowerCase().includes(q)); const R = br.remote.filter(b => !q || b.name.toLowerCase().includes(q));
    if (L.length) items.push({ header: 'Local' }); for (const b of L.slice(0, 30)) items.push({ label: b.name, sub: `${b.rel} · ${b.subject}`, icon: b.name === br.current ? '●' : '', cur: b.name === br.current, onclick: () => checkout(p, b.name) });
    if (R.length) items.push({ header: 'Remote (creates tracking branch)' }); for (const b of R.slice(0, 30)) items.push({ label: b.short, sub: `${b.rel} · ${b.subject}`, icon: '☁', onclick: () => checkout(p, b.name) });
    if (q && !L.some(b => b.name === q)) items.push('sep', { label: `Create branch "${q}"`, icon: '＋', onclick: () => checkout(p, q) });
    items.push('sep', { label: 'Fetch all', icon: '⇣', onclick: () => act(`${p.name}: fetch`, api('git', { id: p.id, action: 'fetch' })) }, { label: 'Pull (rebase, autostash)', icon: '↓', onclick: () => act(`${p.name}: pull`, api('git', { id: p.id, action: 'pull' })) }, { label: 'Stash changes', icon: '⧉', onclick: () => act(`${p.name}: stash`, api('git', { id: p.id, action: 'stash' })) }, { label: 'Pop stash', icon: '⧉', onclick: () => act(`${p.name}: stash pop`, api('git', { id: p.id, action: 'stash-pop' })) });
    return items;
  };
  const fake = { currentTarget: anchor };
  const rerender = () => { const q = filter.value.trim().toLowerCase(); const m = $('#menu'); const scroll = m.scrollTop; openMenu(fake, build(q)); m.scrollTop = scroll; filter.focus(); };
  filter.addEventListener('input', rerender); filter.addEventListener('keydown', e => { if (e.key === 'Enter') { const q = filter.value.trim(); if (q) { closeMenu(); checkout(p, q); } } });
  openMenu(fake, build('')); filter.focus();
}
async function checkout(p, branch) { const g = gitOf(p); if (g && g.dirty && !confirm(`${p.name} has ${g.dirty} uncommitted changes. Checkout "${branch}" anyway? (git will refuse if they conflict)`)) return; await act(`${p.name}: checkout ${branch}`, api('git', { id: p.id, action: 'checkout', branch })); }
function moreMenu(ev, p) {
  const g = gitOf(p);
  openMenu(ev, [
    { label: 'Details / logs', icon: '☰', onclick: () => openDrawer(p.id, 'overview') },
    { label: 'New task for this project', sub: 'prompt-style, hand it to Claude later', icon: '☑', onclick: () => taskModal(null, p.id) },
    { label: 'Open in VS Code', icon: '⌨', onclick: () => location.href = vscodeUrl(p.path) },
    { label: 'Copy path', icon: '⎘', sub: p.path, onclick: () => navigator.clipboard.writeText(p.path).then(() => toast('copied')) },
    { label: 'Copy ssh + cd', icon: '⎘', sub: `ssh ${S.settings.sshHost} -t "cd ${p.path}; exec bash -l"`, onclick: () => navigator.clipboard.writeText(`ssh ${S.settings.sshHost} -t "cd '${p.path}'; exec bash -l"`).then(() => toast('copied')) },
    p.remoteRepo ? { label: 'Open on GitHub', icon: '↗', sub: p.remoteRepo, onclick: () => window.open('https://github.com/' + p.remoteRepo, '_blank') } : null,
    'sep',
    g && !g.error ? { label: 'Fetch', icon: '⇣', onclick: () => act(`${p.name}: fetch`, api('git', { id: p.isGit ? p.id : p.parent, action: 'fetch' })) } : null,
    g && g.dirty ? { label: 'Discard changes (checkout -- .)', icon: '⚠', danger: true, onclick: () => confirm(`Discard ALL uncommitted tracked changes in ${p.name}?`) && act(`${p.name}: discard`, api('git', { id: p.isGit ? p.id : p.parent, action: 'discard' })) } : null,
    'sep',
    { label: p.pinned ? 'Unpin' : 'Pin to top', icon: '📌', onclick: () => api('project', { id: p.id, pin: !p.pinned }) },
    { label: p.hidden ? 'Unhide' : 'Hide project', icon: '◌', onclick: () => api('project', { id: p.id, hidden: !p.hidden }).then(() => toast(p.hidden ? 'unhidden' : 'hidden — see filter "hidden" via settings')) },
  ].filter(Boolean));
}

// ---------- session drawer: the conversation of one Claude session + the files it edited (same #drawer element) ----------
const SESS = { name: null, tab: 'transcript', n: 40 };
function openSession(name, tab = 'transcript') {
  const was = UI.drawer; UI.drawer = 'session:' + name; SESS.name = name; SESS.tab = tab; UI.tab = tab;
  $('#drawer').classList.add('open'); $('#scrim').classList.remove('hidden'); renderSessionDrawer(); if (!was) pushLayer('drawer'); trackVV(300);
}
async function renderSessionDrawer(full = true) {
  const d = $('#drawer'); const name = SESS.name; const s = S.runtime.sessions.find(x => x.name === name); const cl = s?.claude || {};
  if (!full) { // poll: only the conversation body, only if the transcript changed
    const body = d.querySelector('.db.sess'); if (!body || SESS.tab !== 'transcript' || SESS.busy) return; SESS.busy = true;
    let t; try { t = await api(`transcript/${encodeURIComponent(name)}?n=${SESS.n}`); } catch { SESS.busy = false; return; } SESS.busy = false;
    if (SESS.name !== name) return;
    const key = [name, t.size, t.total, cl.state, cl.lastTool, SESS.n, (PENDING[name] || []).length].join(':'); if (SESS.key === key) return; SESS.key = key;
    renderConversation(body, name, t, { n: SESS.n, more: () => { SESS.n = Math.min(200, SESS.n * 2); renderSessionDrawer(); }, refresh: () => renderSessionDrawer(false) });
    return;
  }
  const P = byId(); const pr = s && P[s.project];
  const title = cl.label || (pr ? pr.name : name);
  const head = h('div', { class: 'dh' }, h('div', { class: 'row1' }, h('h2', null, avatar(s && s.project, 'sm'), title, cl.title ? h('span', { class: 'dim', style: 'font-size:13px;font-weight:500' }, cl.title) : null, stateBadge(cl)),
      h('button', { class: 'btn sm', onclick: () => { closeDrawer(); openTerm(name); } }, '⌨ Terminal'), h('button', { class: 'btn ghost close', onclick: closeDrawer }, '✕ Esc')),
    h('div', { class: 'path' }, name, ' · ', cl.cwd || s?.cwd || '', cl.usage ? ` · ${usd(cl.usage.cost)} · ${cl.usage.requests} requests` : ''),
    h('div', { class: 'tabs' }, [['transcript', 'Conversation'], ['touched', `Files edited${cl.touched ? ' (' + cl.touched + ')' : ''}`]].map(([k, l]) => h('div', { class: 'tab' + (SESS.tab === k ? ' on' : ''), onclick: () => { SESS.tab = k; renderSessionDrawer(); } }, l))));
  const body = h('div', { class: 'db sess' }); d.replaceChildren(head, body);
  body.append(h('div', { class: 'dim', style: 'padding:20px' }, 'loading…'));
  let t; try { t = await api(`transcript/${encodeURIComponent(name)}?n=${SESS.n}`); } catch (e) { body.replaceChildren(h('div', { class: 'dim', style: 'padding:20px' }, e.message)); return; }
  if (SESS.name !== name) return;
  body.innerHTML = '';
  if (SESS.tab === 'touched') {
    const list = t.touched || []; if (!list.length) { body.append(h('div', { class: 'dim' }, 'No files edited by Claude in this session yet (counted from Edit / Write tool calls since the hooks were installed).')); return; }
    const root = pr ? pr.path : (t.cwd || ''); const rel = f => root && f.startsWith(root + '/') ? f.slice(root.length + 1) : f;
    body.append(h('div', { class: 'dim', style: 'margin-bottom:8px;font-size:12px' }, 'Newest first. Click a file to see its current diff in the project Files tab.'));
    for (const f of list) { const r = rel(f.path); const inside = pr && f.path.startsWith(pr.path + '/');
      body.append(h('div', { class: 'chfile', title: f.path, onclick: () => { if (!inside) { toast('outside the project folder: ' + f.path); return; } FILES.sel = r; FILES.mode = 'auto'; closeDrawer(); openDrawer(pr.id, 'files'); } },
        h('span', { class: 'chst s' + (f.tool === 'Write' ? 'A' : 'M') }, f.tool === 'Write' ? 'W' : 'E'), fileIcon(f.path), h('span', { class: 'chpath' }, r), h('span', { class: 'dim mono', style: 'font-size:11px' }, ago(f.at) + ' ago'), h('span', { class: 'caret' }, '▸'))); }
    return;
  }
  SESS.key = [name, t.size, t.total, cl.state, cl.lastTool, SESS.n, (PENDING[name] || []).length].join(':');
  renderConversation(body, name, t, { n: SESS.n, more: () => { SESS.n = Math.min(200, SESS.n * 2); renderSessionDrawer(); }, refresh: () => renderSessionDrawer(false) });
}
// The conversation itself: turns, tool calls, and a reply box that grows with the text and stays above the keyboard.
// `t` is the /api/transcript payload. Draft text in the reply box survives re-renders.
const PENDING = {};   // name -> [{ text, ts }] messages sent from here that the transcript hasn't shown yet
function renderConversation(box, name, t, o) {
  const prevDraft = box.querySelector('.creply')?.value || '';
  const prevScroll = box.querySelector('.cscroll'); const atBottom = !prevScroll || prevScroll.scrollHeight - prevScroll.scrollTop - prevScroll.clientHeight < 60; const prevTop = prevScroll ? prevScroll.scrollTop : 0;
  const hadFocus = document.activeElement && document.activeElement.classList.contains('creply');
  // drop local echoes once the transcript has them (or after a minute)
  const lastUser = [...t.turns].reverse().find(x => x.role === 'user');
  PENDING[name] = (PENDING[name] || []).filter(pm => Date.now() - pm.ts < 60000 && !(lastUser && lastUser.text.trim() === pm.text.trim() && (lastUser.ts || 0) >= pm.ts - 5000));
  box.innerHTML = '';
  const bar = h('div', { class: 'logbar cbar' }, h('span', { class: 'dim' }, `${t.turns.length} of ${t.total} turns`), h('span', { style: 'flex:1' }),
    t.total > t.turns.length ? h('button', { class: 'btn sm', onclick: o.more }, '↑ older') : null,
    h('button', { class: 'btn sm', onclick: o.refresh }, '↻'));
  const conv = h('div', { class: 'conv' });
  for (const turn of t.turns) {
    conv.append(h('div', { class: 'turn ' + turn.role }, h('div', { class: 'who' }, turn.role === 'user' ? '❯ you' : '✦ claude', turn.ts ? h('span', { class: 'dim mono' }, ' ' + new Date(turn.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null),
      turn.text ? h('div', { class: 'ttext', html: mdLite(turn.text) }) : null, toolsBlock(turn)));
  }
  // review card: Claude finished and edited files -> approve / ask for changes / look at or revert each file
  const s0 = S.runtime.sessions.find(x => x.name === name); const pr0 = s0 && byId()[s0.project]; const cl0 = s0?.claude || {};
  if ((cl0.state === 'needs-you' || cl0.state === 'idle') && (t.touched || []).length && pr0) {
    const root = pr0.path; const files = t.touched.filter(f => f.path.startsWith(root + '/')).slice(0, 12);
    if (files.length) conv.append(h('div', { class: 'review' }, h('div', { class: 'who' }, '± review changes', h('span', { class: 'dim mono' }, ` ${files.length} file${files.length === 1 ? '' : 's'} edited this session`)),
      h('div', { class: 'rfiles' }, files.map(f => { const rel = f.path.slice(root.length + 1); return h('div', { class: 'rf' }, fileIcon(rel), h('span', { class: 'chpath' }, rel),
        h('button', { class: 'btn sm ghost', title: 'diff', onclick: () => { FILES.sel = rel; FILES.mode = 'diff'; closeDrawer(); closeTermPanel(); openDrawer(pr0.id, 'files'); } }, '± diff'),
        h('button', { class: 'btn sm ghost danger', title: 'throw this file\'s changes away (git checkout / delete if new)', onclick: () => { if (confirm('Revert ' + rel + '?')) act('revert ' + rel, api('git', { id: pr0.isGit ? pr0.id : pr0.parent, action: 'revert-file', file: rel })); } }, '↶')); })),
      h('div', { class: 'racts' }, h('button', { class: 'btn sm primary', onclick: () => sendText('Looks good — continue.') }, '✓ Approve'), h('button', { class: 'btn sm', onclick: () => { ta.value = 'Please change: '; ta.focus(); grow(); } }, '✎ Request changes'), pr0.isGit ? h('button', { class: 'btn sm ghost', onclick: () => { closeDrawer(); closeTermPanel(); openDrawer(pr0.id, 'changes'); } }, 'commit…') : null)));
  }
  for (const pm of PENDING[name] || []) conv.append(h('div', { class: 'turn user pending' }, h('div', { class: 'who' }, '❯ you', h('span', { class: 'dim mono' }, ' sending…')), h('div', { class: 'ttext' }, pm.text)));
  const cl = claudeOf(name) || {};
  if (cl.state === 'working' || cl.state === 'background') conv.append(h('div', { class: 'turn assistant live' }, h('div', { class: 'who' }, '✦ claude', h('span', { class: 'dim mono' }, ' working…')), h('div', { class: 'ag-now' }, h('span', { class: 'spin' }), h('span', { class: 'mono' }, cl.lastTool || 'thinking…'))));
  const scroller = h('div', { class: 'cscroll' }, bar, conv);
  // reply box: textarea that grows to 6 lines; Enter sends, Shift+Enter = newline; Esc button interrupts Claude
  const ta = h('textarea', { class: 'creply', rows: 1, placeholder: cl.state === 'permission' ? 'y / n, or type…' : 'Message Claude…', title: 'Enter sends · Shift+Enter = new line', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: true });
  ta.value = prevDraft;
  const grow = () => { ta.style.height = '44px'; if (ta.value) ta.style.height = Math.min(Math.max(44, ta.scrollHeight), 6 * 24 + 20) + 'px'; };
  const sendText = async (v) => { (PENDING[name] = PENDING[name] || []).push({ text: v, ts: Date.now() }); conv.append(h('div', { class: 'turn user pending' }, h('div', { class: 'who' }, '❯ you', h('span', { class: 'dim mono' }, ' sending…')), h('div', { class: 'ttext' }, v))); scroller.scrollTop = scroller.scrollHeight; try { await api('send', { session: name, text: v }); } catch (e) { toast(e.message, 'err'); } setTimeout(o.refresh, 700); setTimeout(o.refresh, 2500); };
  const send = async () => { const v = ta.value.trim(); if (!v) return; ta.value = ''; grow();
    (PENDING[name] = PENDING[name] || []).push({ text: v, ts: Date.now() });
    conv.append(h('div', { class: 'turn user pending' }, h('div', { class: 'who' }, '❯ you', h('span', { class: 'dim mono' }, ' sending…')), h('div', { class: 'ttext' }, v))); scroller.scrollTop = scroller.scrollHeight;
    try { await api('send', { session: name, text: v }); } catch (e) { toast(e.message, 'err'); PENDING[name] = PENDING[name].filter(x => x.text !== v); ta.value = v; grow(); }
    setTimeout(o.refresh, 700); setTimeout(o.refresh, 2500); };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); } });
  const sendBtn = h('button', { class: 'btn primary csend', title: 'send (Enter)', onclick: send }, ico('send', 16));
  // 📎 attach: any file (photo / screenshot downscaled, everything else as-is) -> <devRoot>/.pasted -> its path goes into the message (Claude reads it)
  const fileIn = h('input', { type: 'file', style: 'display:none' });
  fileIn.addEventListener('change', async () => { const f = fileIn.files[0]; fileIn.value = ''; if (!f) return; try { const p = await uploadFile(f); ta.value = (ta.value ? ta.value.replace(/\s*$/, ' ') : '') + p + ' '; grow(); ta.focus(); toast('attached — describe what to do with it and send', 'ok'); } catch (e) { toast('upload failed: ' + e.message, 'err'); } });
  const attach = h('button', { class: 'btn sm ghost qk', title: 'attach a file — photo, screenshot, CSV, PDF, anything up to 100 MB', onclick: () => fileIn.click() }, ico('clip', 15));
  // 🎤 hold to talk (Web Speech API; Safari + Chrome): release sends
  const mic = voiceButton(ta, grow);
  const clock = h('button', { class: 'btn sm ghost qk', title: 'schedule this message for later (or a chain of messages)', onclick: () => scheduleDialog(name, ta.value) }, ico('clock', 15));
  const jobs = (S.claude?.schedule || []).filter(j => j.session === name && j.state !== 'done' && j.state !== 'failed');
  const keys = h('div', { class: 'ckeys' }, attach, mic, clock, fileIn,
    jobs.length ? h('span', { class: 'sjobs' }, jobs.map(j => h('span', { class: 'sjob', title: j.prompts.join('\n\n') }, ico('clock', 12), ' ', new Date(j.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), j.prompts.length > 1 ? ` ×${j.prompts.length}` : '', j.state === 'running' || j.state === 'sent' ? ' · ' + j.state : '', h('button', { class: 'x', title: 'remove', onclick: () => api('schedule-remove', { id: j.id }) }, ico('x', 11))))) : null,
    cl.state === 'working' || cl.state === 'background' ? h('button', { class: 'btn sm ghost qk', title: 'interrupt Claude (Escape)', onclick: () => api('key', { session: name, key: 'esc' }).then(() => toast('Esc sent')) }, 'Esc') : null,
    cl.state === 'permission' ? ['y', 'n'].map(k => h('button', { class: 'btn sm qk ' + (k === 'y' ? 'yes' : 'no'), onclick: () => api('send', { session: name, text: k, enter: false }) }, k)) : null,
    h('button', { class: 'btn sm ghost qk', title: 'send Ctrl-C', onclick: () => { if (confirm('Send Ctrl-C?')) api('key', { session: name, key: 'c-c' }); } }, '^C'));
  box.append(scroller, h('div', { class: 'cbox2' }, keys, h('div', { class: 'crow' }, ta, sendBtn)));
  grow(); scroller.scrollTop = atBottom ? scroller.scrollHeight : prevTop;
  if (hadFocus) ta.focus({ preventScroll: true });
  setTimeout(() => { if (atBottom) scroller.scrollTop = scroller.scrollHeight; }, 0);
}
const trim1 = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;
// tool calls of one turn, with Edit/Write diffs and Bash commands inline
function toolsBlock(turn) {
  if (!turn.tools.length) return null;
  return h('details', { class: 'ttools' }, h('summary', null, `${turn.tools.length} tool call${turn.tools.length === 1 ? '' : 's'}`, ' · ', trim1(turn.tools.map(x => x.name).filter((v, i, a) => a.indexOf(v) === i).join(', '), 60)),
    h('div', { class: 'tlist' }, turn.tools.map(x => h('div', { class: 'tli' + (x.error ? ' err' : '') },
      h('div', { class: 'tl' }, h('span', { class: 'tn mono' }, x.name), h('span', { class: 'tw' }, x.what), x.result ? h('span', { class: 'tr dim', title: x.result }, '→ ' + x.result) : null),
      x.cmd ? h('pre', { class: 'mcode small' }, '$ ' + x.cmd) : null,
      x.diff ? h('div', { class: 'tdiff' }, x.diff.old ? h('pre', { class: 'del' }, x.diff.old) : null, x.diff.new ? h('pre', { class: 'add' }, x.diff.new) : null) : null))));
}
const UPLOAD_MAX_MB = 100;   // same as the server
// images: downscaled to 1568px on the long edge (what Claude uses anyway); anything else raw, keeping its name. Returns the server path.
async function uploadFile(file, keep = false) {
  if (file.size > UPLOAD_MAX_MB * 1e6) throw new Error(`${file.name} is ${(file.size / 1e6).toFixed(0)} MB — max ${UPLOAD_MAX_MB} MB`);
  if (/^image\/(png|jpeg|webp)$/.test(file.type)) return uploadImage(file, keep);
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  const r = await fetch(`/api/paste-image?ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(file.name)}${keep ? '&keep=1' : ''}`, { method: 'POST', body: file }); const j = await r.json(); if (!j.ok) throw new Error(j.error || 'upload failed'); return j.path;
}
async function uploadImage(file, keep = false) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const max = 1568; const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src);
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.88));
  const r = await fetch('/api/paste-image?ext=jpg' + (keep ? '&keep=1' : ''), { method: 'POST', body: blob }); const j = await r.json(); if (!j.ok) throw new Error(j.error || 'upload failed'); return j.path;
}
function voiceButton(ta, grow) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  // Hold to talk. Pointer capture keeps the recording alive while the finger drifts off the button; releasing
  // only fills the textarea (never sends) so the transcript can be fixed before it goes out.
  const b = h('button', { class: 'btn sm ghost qk mic', title: 'hold to talk — release to fill the message (you send it)' }, ico('mic', 16), h('span', { class: 'mlbl' }, 'hold'));
  let rec = null, base = '', final = '', active = false;
  const start = ev => { ev.preventDefault(); if (active) return; active = true; try { b.setPointerCapture(ev.pointerId); } catch {} base = ta.value ? ta.value.replace(/\s*$/, ' ') : ''; final = ''; b.classList.add('rec'); document.body.classList.add('recording');
    rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = true;
    rec.onresult = e => { let interim = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) final += r[0].transcript + ' '; else interim += r[0].transcript; } ta.value = base + final + interim; grow(); };
    rec.onerror = e => { toast('voice: ' + e.error, 'err'); stop(null, false); };
    try { rec.start(); } catch (e) { toast('voice unavailable', 'err'); active = false; b.classList.remove('rec'); } };
  const stop = ev => { if (ev) ev.preventDefault(); if (!active) return; active = false; b.classList.remove('rec'); document.body.classList.remove('recording'); try { rec && rec.stop(); } catch {}
    // the last final result lands a moment after stop(): settle, then leave the text in the box for review — no auto-send
    setTimeout(() => { ta.value = (base + final).trim() ? base + final : ta.value; grow(); ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); if (ta.value.trim()) toast('check the text, then send', 'ok'); }, 400); };
  b.addEventListener('pointerdown', start); b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop); b.addEventListener('lostpointercapture', () => { if (active) stop(null); });
  b.addEventListener('contextmenu', ev => ev.preventDefault());
  return b;
}
// Schedule a prompt (or a chain) for a session: modal with quick time chips + a date/time picker + one textarea per message.
function scheduleDialog(name, draft) {
  const m = $('#modal'); m.classList.remove('hidden');
  const sess = S.runtime.sessions.find(x => x.name === name); const cl = sess?.claude || {};
  const pad = n => String(n).padStart(2, '0'); const local = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  let at = Date.now() + 30 * 60e3;
  const when = h('input', { class: 'txt', type: 'datetime-local', value: local(new Date(at)) });
  const inStr = () => { const d = at - Date.now(); return d < 0 ? 'now' : d < 3600e3 ? 'in ' + Math.round(d / 60e3) + ' min' : d < 86400e3 ? 'in ' + (d / 3600e3).toFixed(1).replace('.0', '') + ' h' : 'in ' + Math.round(d / 86400e3) + ' d'; };
  const rel = h('span', { class: 'dim', style: 'font-size:12px' }, inStr());
  const setAt = v => { at = v; when.value = local(new Date(at)); rel.textContent = inStr(); for (const c of chips.children) c.classList.toggle('on', +c.dataset.at === Math.round(at / 60e3)); };
  when.addEventListener('input', () => { const t = Date.parse(when.value); if (t) { at = t; rel.textContent = inStr(); for (const c of chips.children) c.classList.remove('on'); } });
  const tonight = new Date(); tonight.setHours(23, 0, 0, 0); if (tonight.getTime() < Date.now()) tonight.setDate(tonight.getDate() + 1);
  const morning = new Date(); morning.setDate(morning.getDate() + 1); morning.setHours(9, 0, 0, 0);
  const presets = [['+15 min', 15 * 60e3], ['+30 min', 30 * 60e3], ['+1 h', 3600e3], ['+2 h', 7200e3], ['+4 h', 4 * 3600e3], ['23:00', tonight.getTime() - Date.now()], ['tomorrow 09:00', morning.getTime() - Date.now()]];
  const chips = h('div', { class: 'chips' }, presets.map(([l, d]) => { const t = Date.now() + d; return h('button', { class: 'chip', 'data-at': Math.round(t / 60e3), onclick: () => setAt(t) }, l); }));
  const msgs = h('div', { class: 'smsgs' });
  const addMsg = text => { const ta = h('textarea', { class: 'creply', rows: 3, placeholder: msgs.children.length ? 'next message — sent once Claude finishes the previous one' : 'message for Claude…' }); ta.value = text || '';
    const w = h('div', { class: 'smsg' }, h('div', { class: 'smsg-n' }, h('span', { class: 'n' }, String(msgs.children.length + 1)), msgs.children.length ? h('button', { class: 'x', title: 'remove this message', onclick: () => { w.remove(); renum(); } }, ico('x', 13)) : null), ta); msgs.append(w); ta.addEventListener('keydown', ev => ev.stopPropagation()); return ta; };
  const renum = () => { [...msgs.children].forEach((w, i) => { w.querySelector('.n').textContent = String(i + 1); }); };
  const first = addMsg(draft);
  const box = h('div', { class: 'box settings sched' },
    h('div', { class: 'sh' }, h('h3', null, 'Schedule a message'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', onclick: () => m.classList.add('hidden') }, ico('x', 15))),
    h('div', { class: 'sbody' },
      h('div', { class: 'sto' }, avatar(sess?.project, 'sm'), h('b', null, cl.label || (sess?.project && byId()[sess.project]?.name) || name), h('span', { class: 'badge tag acc ' + (cl.account || '') }, cl.account || ''), cl.state ? h('span', { class: 'cst mini ' + cl.state }, STATE_ICON[cl.state], ' ', STATE_LABEL[cl.state]) : null),
      h('div', { class: 'sg' }, h('div', { class: 'sg-t' }, 'When'), chips, h('div', { class: 'swhen' }, when, rel)),
      h('div', { class: 'sg' }, h('div', { class: 'sg-t' }, 'Message'), msgs, h('button', { class: 'btn sm ghost', onclick: () => addMsg('').focus() }, ico('plus', 13), 'Add a follow-up message'), h('div', { class: 'hint' }, 'Follow-ups go out one by one, each after Claude finishes the previous one. If the session is busy at the time, the message waits for it to become idle.'))),
    h('div', { class: 'foot' }, h('button', { class: 'btn ghost', onclick: () => m.classList.add('hidden') }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => { const prompts = [...msgs.querySelectorAll('textarea')].map(t => t.value.trim()).filter(Boolean); if (!prompts.length) { first.focus(); return; }
        if (at < Date.now() - 60e3) { toast('that time is in the past', 'err'); return; }
        await act('Scheduled ' + new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), api('schedule', { session: name, at, prompts })); m.classList.add('hidden'); }, }, ico('clock', 15), 'Schedule')));
  m.replaceChildren(box); m.onclick = e => { if (e.target === m) m.classList.add('hidden'); };
  setAt(at); setTimeout(() => first.focus(), 50);
}
// Pending scheduled messages (home, under the agents header): who, when, what, cancel.
function scheduledStrip() {
  const jobs = (S.claude?.schedule || []).filter(j => j.state !== 'done' && j.state !== 'failed').sort((a, b) => a.at - b.at);
  if (!jobs.length) return null;
  return h('div', { class: 'sched' }, h('div', { class: 'sched-h' }, ico('clock', 14), 'Scheduled', h('span', { class: 'n' }, jobs.length)),
    h('div', { class: 'sched-l' }, jobs.map(j => { const sess = S.runtime.sessions.find(x => x.name === j.session); const cl = sess?.claude || {}; const d = j.at - Date.now();
      const whenTxt = j.state === 'running' || j.state === 'sent' ? `sending ${j.idx}/${j.prompts.length}` : d < 0 ? 'waiting for the session to go idle' : (d < 86400e3 ? new Date(j.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date(j.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })) + ' · in ' + inStr(j.at);
      return h('div', { class: 'sjrow' + (sess ? '' : ' gone'), title: j.prompts.join('\n\n') },
        avatar(sess?.project, 'sm'), h('div', { class: 'sj-who' }, h('b', null, cl.label || (sess?.project && byId()[sess.project]?.name) || j.session.replace(/^claude-/, '')), h('span', { class: 'sj-when' }, whenTxt)),
        h('div', { class: 'sj-txt' }, j.prompts[0], j.prompts.length > 1 ? h('span', { class: 'grp' }, ` +${j.prompts.length - 1} more`) : null),
        h('button', { class: 'x', title: 'cancel', onclick: ev => { ev.stopPropagation(); if (confirm('Cancel this scheduled message?')) api('schedule-remove', { id: j.id }); } }, ico('x', 14))); })));
}
// tiny markdown: code fences, inline code, bold, bullets, line breaks — enough for Claude's replies
function mdLite(t) {
  const parts = t.split(/(```[\s\S]*?```)/g);
  return parts.map(p => {
    if (p.startsWith('```')) { const m = p.match(/^```(\w+)?\n?([\s\S]*?)```$/); const lang = m && m[1] ? (LANG[m[1]] || m[1]) : null; const code = m ? m[2] : p.slice(3, -3); return `<pre class="mcode hljs">${hlLines(code.replace(/\n$/, ''), lang).join('\n')}</pre>`; }
    let x = esc(p);
    // pipe tables: header row + separator row + body rows
    x = x.replace(/(?:^|\n)((?:\|[^\n]*\|\s*\n)+)/g, (m, block) => { const rows = block.trim().split('\n').map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())); if (rows.length < 2 || !rows[1].every(c => /^:?-{2,}:?$/.test(c))) return m; const head = rows[0], body = rows.slice(2); return '\n<table class="mtbl"><thead><tr>' + head.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' + body.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>\n'; });
    x = x.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/^(#{1,4}) (.+)$/gm, '<b class="mh">$2</b>').replace(/^[-*] (.+)$/gm, '<span class="mli">• $1</span>').replace(/^(\d+)\. (.+)$/gm, '<span class="mli"><span class="mnum">$1.</span> $2</span>');
    return x.replace(/\n(?=<table)/g, '').replace(/(<\/table>)\n/g, '$1').replace(/\n/g, '<br>');
  }).join('');
}

// A past conversation from search (no live session): read-only view + "Resume here" (claude --resume in that folder)
async function openTranscriptFile(hh) {
  const was = UI.drawer; UI.drawer = 'session:file'; SESS.name = null; SESS.tab = 'transcript';
  $('#drawer').classList.add('open'); $('#scrim').classList.remove('hidden'); if (!was) pushLayer('drawer');
  const d = $('#drawer'); const title = hh.title || (hh.cwd || '').split('/').pop() || hh.sessionId.slice(0, 8);
  const head = h('div', { class: 'dh' }, h('div', { class: 'row1' }, h('h2', null, h('span', { class: 'sicon' }, '✦'), title, h('span', { class: 'badge tag acc ' + hh.account }, hh.account), h('span', { class: 'dim', style: 'font-size:12px;font-weight:500' }, 'past conversation · ' + ago(hh.mtime) + ' ago')),
      h('button', { class: 'btn sm primary', title: 'start a new tmux session in that folder with claude --resume on this conversation', onclick: () => act('Resume ' + title, api('claude-resume', { sessionId: hh.sessionId, cwd: hh.cwd, account: hh.account })).then(r => { closeDrawer(); if (r?.name) setTimeout(() => openTerm(r.name), 1200); }) }, '↺ Resume here'),
      h('button', { class: 'btn ghost close', onclick: closeDrawer }, '✕ Esc')),
    h('div', { class: 'path' }, hh.cwd || '', ' · ', hh.sessionId));
  const body = h('div', { class: 'db sess' }); d.replaceChildren(head, body); body.append(h('div', { class: 'dim', style: 'padding:20px' }, 'loading…'));
  let t; try { t = await api(`transcript?file=${encodeURIComponent(hh.file)}&n=60`); } catch (e) { body.replaceChildren(h('div', { class: 'dim', style: 'padding:20px' }, e.message)); return; }
  body.innerHTML = ''; const scroller = h('div', { class: 'cscroll' }); body.append(scroller);
  const conv = h('div', { class: 'conv' });
  for (const turn of t.turns) conv.append(h('div', { class: 'turn ' + turn.role }, h('div', { class: 'who' }, turn.role === 'user' ? '❯ you' : '✦ claude', turn.ts ? h('span', { class: 'dim mono' }, ' ' + new Date(turn.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) : null), turn.text ? h('div', { class: 'ttext', html: mdLite(turn.text) }) : null, toolsBlock(turn)));
  scroller.append(h('div', { class: 'dim', style: 'margin-bottom:8px' }, `${t.turns.length} of ${t.total} turns · read-only (no live session)`), conv);
  setTimeout(() => { scroller.scrollTop = scroller.scrollHeight; }, 0);
}

// ---------- drawer ----------
// A layer (drawer, terminal panel, palette) pushes a history entry, so the phone's back gesture / browser Back closes
// the layer instead of leaving the dashboard. Closing from the UI pops that entry again so history stays clean.
const LAYERS = { depth: 0, closing: false };
function pushLayer(name) { LAYERS.depth++; history.pushState({ bd: name, depth: LAYERS.depth }, ''); }
function popLayer() { if (LAYERS.depth > 0 && !LAYERS.closing) { LAYERS.closing = true; history.back(); setTimeout(() => { LAYERS.closing = false; }, 400); } }
window.addEventListener('popstate', () => {
  if (LAYERS.closing) { LAYERS.closing = false; LAYERS.depth = Math.max(0, LAYERS.depth - 1); return; }   // our own popLayer()
  LAYERS.depth = Math.max(0, LAYERS.depth - 1);
  if (PAL.open) closePalette(false); else if (UI.drawer) closeDrawer(false); else if (TERM.open) closeTermPanel(false);
});
function openDrawer(id, tab = 'overview', logTarget = null) { const was = UI.drawer; UI.drawer = id; UI.tab = tab; UI.logTarget = logTarget; $('#drawer').classList.add('open'); $('#scrim').classList.remove('hidden'); renderDrawer(true); if (!was) pushLayer('drawer'); }
function closeDrawer(pop = true) { if (!UI.drawer) return; UI.drawer = null; fitTermPanel(); $('#drawer').classList.remove('open'); $('#scrim').classList.add('hidden'); stopLog(); FILES.editing = false; if (pop) popLayer(); }
let drawerKey = '';
function renderDrawer(force) {
  if (String(UI.drawer).startsWith('session:')) { // live: re-read when that session got a new hook event (Claude replied / you typed)
    const cl = S.runtime.sessions.find(x => x.name === SESS.name)?.claude; const ev = cl ? cl.lastEventAt + ':' + cl.state : '';
    if (force) renderSessionDrawer(); else if (ev && ev !== SESS.lastEv) { SESS.lastEv = ev; renderSessionDrawer(false); }
    return; }
  const d = $('#drawer'); const p = byId()[UI.drawer]; if (!p) return;
  const r = runtimeFor(p.id); const g = gitOf(p);
  const key = [p.id, UI.tab, UI.logTarget, r.sessions.map(s => s.name).join(), r.containers.map(c => c.id + c.state).join(), UI.tab === 'logs' ? '' : JSON.stringify(g), p.commands.length].join('|');
  if (!force && key === drawerKey) return; // only re-render when something relevant changed
  if (!force && UI.tab === 'files' && FILES.editing) return; // never yank an editor with unsaved text
  drawerKey = key;
  const dirtyN = g && !g.error ? g.dirty + g.untracked : 0;
  const tabs = [['overview', 'Overview'], ['changes', `Changes${dirtyN ? ' (' + dirtyN + ')' : ''}`], ['files', 'Files'], ['logs', 'Logs'], ['branches', 'Branches'], ['docker', `Docker${r.containers.length ? ' (' + r.containers.length + ')' : ''}`], ['recent', 'History']];
  const head = h('div', { class: 'dh' }, h('div', { class: 'row1' }, h('h2', null, h('span', { style: `width:10px;height:10px;border-radius:3px;background:${orgColor(p.org)}` }), p.parentName ? p.parentName + ' › ' : '', p.name, ...badges(p)), h('a', { class: 'btn vsc', href: vscodeUrl(p.path) }, vscIcon(), ' VS Code'), h('button', { class: 'btn ghost close', onclick: closeDrawer }, '✕ Esc')),
    h('div', { class: 'path' }, p.path, p.remoteRepo ? ' · ' + p.remoteRepo : ''),
    h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('div', { class: 'tab' + (UI.tab === k ? ' on' : ''), onclick: () => { UI.tab = k; renderDrawer(true); } }, l))));
  const body = h('div', { class: 'db' });
  d.replaceChildren(head, body);
  if (UI.tab !== 'logs') stopLog();
  ({ overview: tabOverview, changes: tabChanges, files: tabFiles, logs: tabLogs, branches: tabBranches, docker: tabDocker, recent: tabRecent })[UI.tab](body, p, r, g);
}
function tabOverview(el, p, r, g) {
  el.append(h('h4', null, 'Info'), h('div', { class: 'kv' }, h('div', { class: 'k' }, 'Path'), h('div', { class: 'v' }, p.path), h('div', { class: 'k' }, 'Stack'), h('div', { class: 'v' }, [p.stack, p.framework, p.pm].filter(Boolean).join(' · ')), h('div', { class: 'k' }, 'Remote'), h('div', { class: 'v' }, p.remote || (p.parent ? 'inherits from ' + p.parentName : '–')), g && !g.error ? [h('div', { class: 'k' }, 'Git'), h('div', { class: 'v' }, `${g.branch}${g.upstream ? ' → ' + g.upstream : ''} · ${g.dirty} modified · ${g.untracked} untracked · ↑${g.ahead} ↓${g.behind}`)] : null, g?.last ? [h('div', { class: 'k' }, 'Last commit'), h('div', { class: 'v' }, `${g.last.hash} ${g.last.subject} — ${g.last.author}, ${g.last.rel}`)] : null, p.composeFiles.length ? [h('div', { class: 'k' }, 'Compose'), h('div', { class: 'v' }, p.composeFiles.join(', '))] : null, h('div', { class: 'k' }, 'Terminal'), h('div', { class: 'v' }, h('code', null, `ssh ${S.settings.sshHost} -t "cd '${p.path}'; exec bash -l"`), ' ', h('button', { class: 'btn sm', onclick: () => navigator.clipboard.writeText(`ssh ${S.settings.sshHost} -t "cd '${p.path}'; exec bash -l"`).then(() => toast('copied')) }, 'copy'))));
  const running = Object.fromEntries(r.sessions.map(s => [s.label, s]));
  el.append(h('h4', null, 'Commands'));
  const list = h('div', { class: 'cmdlist' });
  for (const c of p.commands) { const s = running[c.name]; list.append(h('div', { class: 'cmdrow' + (s ? ' running' : '') }, h('span', { class: 'kind' }, c.custom ? 'custom' : c.kind), h('span', { class: 'k' }, c.name), h('span', { class: 'c', title: c.cmd }, c.cmd), s ? h('span', { class: 'res mono', style: 'font-size:11px;color:var(--muted)' }, `${ago(s.startedAt)} · ${s.cpu.toFixed(0)}% · ${fmtB(s.mem)}`) : null, s ? h('button', { class: 'btn sm', onclick: () => { UI.tab = 'logs'; UI.logTarget = s.name; renderDrawer(true); } }, 'logs') : null, s ? h('button', { class: 'btn sm danger', onclick: () => act('Stop ' + c.name, api('stop', { session: s.name })) }, '■ stop') : h('button', { class: 'btn sm primary', onclick: () => act(`${p.name}: ${c.name}`, api('run', { id: p.id, name: c.name })) }, '▶ run'), c.custom ? h('button', { class: 'btn sm ghost', title: 'remove custom command', onclick: () => saveCustom(p, (p.commands.filter(x => x.custom && x.name !== c.name)).map(({ name, cmd }) => ({ name, cmd }))) }, '✕') : null)); }
  el.append(list);
  const nm = h('input', { class: 'txt', id: 'newcmd', placeholder: 'name (e.g. "api dev")', style: 'max-width:200px' }); const cm = h('input', { class: 'txt', placeholder: 'shell command, runs in project dir with your bashrc (nvm etc.)' });
  el.append(h('h4', null, 'Add custom command'), h('div', { style: 'display:flex;gap:8px' }, nm, cm, h('button', { class: 'btn', onclick: () => { if (!nm.value || !cm.value) return; saveCustom(p, [...p.commands.filter(x => x.custom).map(({ name, cmd }) => ({ name, cmd })), { name: nm.value, cmd: cm.value }]); } }, 'Add')));
  el.append(h('h4', null, 'Rename / label'), h('div', { style: 'display:flex;gap:8px' }, (() => { const i = h('input', { class: 'txt', value: p.name, style: 'max-width:300px' }); return [i, h('button', { class: 'btn', onclick: () => api('project', { id: p.id, label: i.value }).then(() => toast('saved')) }, 'Save')]; })()));
  if (p.hasReadme || p.hasClaude) { const pre = h('pre', { class: 'logbox', style: 'height:auto;max-height:40vh' }, 'loading…'); el.append(h('h4', null, p.hasClaude ? 'CLAUDE.md' : 'README.md'), pre); api(`file/${p.id}/${p.hasClaude ? 'CLAUDE.md' : 'README.md'}`).then(j => pre.textContent = j.text).catch(() => pre.textContent = ''); }
}
async function saveCustom(p, commands) { await act('Commands saved', api('project', { id: p.id, commands })); renderDrawer(true); }

// logs
function stopLog() { if (UI.logSrc) { UI.logSrc.close(); UI.logSrc = null; } }
function tabLogs(el, p, r) {
  const opts = [...r.sessions.map(s => ({ v: s.name, l: `▶ ${s.label} (live)` })), ...r.external.map(e => ({ v: 'ext:' + e.pid, l: `● ${e.label || e.comm}${e.unit ? ' · ' + e.unit : ''} (live, outside)` })), ...r.containers.map(c => ({ v: 'docker:' + c.id, l: `🐳 ${c.name} ${c.state === 'running' ? '(live)' : '(' + c.state + ')'}` })), ...S.runtime.recent.filter(x => x.project === p.id).slice(0, 15).map(x => ({ v: x.name, l: `○ ${x.name.split('__')[1]} — exited ${x.exitCode ?? '?'} ${ago(x.endedAt)} ago` }))];
  if (!opts.length) { el.append(h('div', { class: 'dim' }, 'No sessions or containers for this project yet. Start something with ▶.')); return; }
  if (!UI.logTarget || !opts.find(o => o.v === UI.logTarget)) UI.logTarget = opts[0].v;
  const sel = h('select', { onchange: e => { UI.logTarget = e.target.value; renderDrawer(true); } }, opts.map(o => h('option', { value: o.v, selected: o.v === UI.logTarget }, o.l)));
  const follow = h('label', { style: 'font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center' }, h('input', { type: 'checkbox', checked: UI.follow, onchange: e => UI.follow = e.target.checked }), 'follow');
  const box = h('div', { class: 'logbox' });
  const sess = r.sessions.find(s => s.name === UI.logTarget);
  // filter box: hides non-matching lines, highlights matches; errors are always tinted; ⚠ jumps to the last error
  const filt = h('input', { class: 'txt lfilt', placeholder: 'filter… (regex ok)', autocomplete: 'off' }); const cnt = h('span', { class: 'dim mono', style: 'font-size:11px' });
  let filterRe = null; const applyFilter = () => { const q = filt.value.trim(); try { filterRe = q ? new RegExp(q, 'i') : null; filt.classList.remove('bad'); } catch { filterRe = null; filt.classList.add('bad'); } let n = 0; for (const d of box.children) { const hit = !filterRe || filterRe.test(d.textContent); d.classList.toggle('hidden', !hit); if (hit && filterRe) n++; } cnt.textContent = filterRe ? `${n} match${n === 1 ? '' : 'es'}` : ''; };
  filt.addEventListener('input', applyFilter); filt.addEventListener('keydown', ev => ev.stopPropagation());
  box._filter = () => filterRe;
  const jumpErr = () => { const errs = [...box.querySelectorAll('.lerr:not(.hidden)')]; const last = errs[errs.length - 1]; if (!last) { toast('no errors in the log'); return; } UI.follow = false; follow.querySelector('input').checked = false; last.scrollIntoView({ block: 'center' }); last.classList.add('flash'); setTimeout(() => last.classList.remove('flash'), 1200); };
  el.append(h('div', { class: 'logbar' }, sel, follow, filt, cnt, h('button', { class: 'btn sm', title: 'jump to the last error line', onclick: jumpErr }, '⚠ last error'), h('span', { style: 'flex:1' }), sess ? h('button', { class: 'btn sm primary', onclick: () => openTerm(sess.name) }, '⌨ Terminal') : null, sess ? h('button', { class: 'btn sm', onclick: () => navigator.clipboard.writeText(`ssh ${S.settings.sshHost} -t tmux attach -t ${sess.name}`).then(() => toast('copied — paste in terminal to attach to tmux')) }, '⎘ tmux attach') : null, sess ? h('button', { class: 'btn sm', onclick: () => act('Restart', api('restart', { session: sess.name })) }, '↻ restart') : null, sess ? h('button', { class: 'btn sm danger', onclick: () => act('Stop', api('stop', { session: sess.name })) }, '■ stop') : null, h('button', { class: 'btn sm ghost', onclick: () => box.innerHTML = '' }, 'clear')), box);
  stopLog();
  const url = UI.logTarget.startsWith('docker:') ? `/api/docker/logs/${UI.logTarget.slice(7)}` : UI.logTarget.startsWith('ext:') ? `/api/extlogs/${UI.logTarget.slice(4)}` : `/api/logs/${encodeURIComponent(UI.logTarget)}/stream`;
  const src = new EventSource(url); UI.logSrc = src;
  let carry = '';
  src.addEventListener('log', e => { const text = carry + JSON.parse(e.data); const lines = text.split('\n'); carry = lines.pop(); appendLog(box, lines); if (carry) { /* partial line rendered on next chunk */ } });
  src.addEventListener('end', () => appendLog(box, ['\x1b[2m[stream ended]\x1b[0m']));
  box.addEventListener('scroll', () => { UI.follow = box.scrollHeight - box.scrollTop - box.clientHeight < 40; follow.querySelector('input').checked = UI.follow; });
}
const ERR_RE = /\b(error|exception|traceback|fatal|panic|unhandled|ECONNREFUSED|EADDRINUSE|failed|failure)\b/i;
function appendLog(box, lines) {
  const frag = document.createDocumentFragment(); const re = box._filter ? box._filter() : null;
  for (let ln of lines) { if (ln.includes('\r')) ln = ln.split('\r').filter(Boolean).pop() || ''; const d = document.createElement('div'); d.innerHTML = ansi(ln) || '&nbsp;'; if (ERR_RE.test(ln)) d.className = 'lerr'; if (re && !re.test(d.textContent)) d.classList.add('hidden'); frag.append(d); }
  box.append(frag);
  while (box.childElementCount > 4000) box.firstElementChild.remove();
  if (UI.follow) box.scrollTop = box.scrollHeight;
}
const ANSI16 = ['#4b5563', '#f87171', '#4ade80', '#fbbf24', '#60a5fa', '#c084fc', '#22d3ee', '#e5e7eb', '#9ca3af', '#fca5a5', '#86efac', '#fde68a', '#93c5fd', '#d8b4fe', '#67e8f9', '#ffffff'];
function ansi(s) {
  s = s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[\d;?]*[A-Za-ln-z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');
  let out = '', open = 0; const st = { fg: null, bg: null, b: false, d: false, i: false, u: false };
  const flush = () => { while (open) { out += '</span>'; open--; } const cls = [st.b && 'ansi-b', st.d && 'ansi-d', st.i && 'ansi-i', st.u && 'ansi-u'].filter(Boolean).join(' '); const sty = (st.fg ? `color:${st.fg};` : '') + (st.bg ? `background:${st.bg};` : ''); if (cls || sty) { out += `<span class="${cls}" style="${sty}">`; open++; } };
  const c256 = n => n < 16 ? ANSI16[n] : n < 232 ? (() => { n -= 16; const r = Math.floor(n / 36), g = Math.floor(n % 36 / 6), b = n % 6; return `rgb(${[r, g, b].map(x => x ? x * 40 + 55 : 0).join(',')})`; })() : `rgb(${[0, 0, 0].map(() => (n - 232) * 10 + 8).join(',')})`;
  const parts = s.split(/(\x1b\[[\d;]*m)/);
  for (const part of parts) {
    const m = part.match(/^\x1b\[([\d;]*)m$/);
    if (!m) { out += esc(part); continue; }
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) { const c = codes[i]; if (c === 0) Object.assign(st, { fg: null, bg: null, b: false, d: false, i: false, u: false }); else if (c === 1) st.b = true; else if (c === 2) st.d = true; else if (c === 3) st.i = true; else if (c === 4) st.u = true; else if (c === 22) { st.b = false; st.d = false; } else if (c === 23) st.i = false; else if (c === 24) st.u = false; else if (c >= 30 && c <= 37) st.fg = ANSI16[c - 30]; else if (c >= 90 && c <= 97) st.fg = ANSI16[c - 90 + 8]; else if (c === 39) st.fg = null; else if (c >= 40 && c <= 47) st.bg = ANSI16[c - 40]; else if (c >= 100 && c <= 107) st.bg = ANSI16[c - 100 + 8]; else if (c === 49) st.bg = null; else if (c === 38 || c === 48) { const isFg = c === 38; if (codes[i + 1] === 5) { st[isFg ? 'fg' : 'bg'] = c256(codes[i + 2]); i += 2; } else if (codes[i + 1] === 2) { st[isFg ? 'fg' : 'bg'] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; } } }
    flush();
  }
  while (open) { out += '</span>'; open--; }
  return out;
}

// changes: branch + staged / pending / untracked, each file expandable into a colored diff
function renderDiff(text) {
  if (!text) return '<span class="dim">(empty diff — binary file or mode change)</span>';
  return text.split('\n').map(l => {
    const e = esc(l) || '&nbsp;';
    if (l.startsWith('+++') || l.startsWith('---')) return `<div class="dl file">${e}</div>`;
    if (l.startsWith('@@')) return `<div class="dl hunk">${e}</div>`;
    if (l.startsWith('+')) return `<div class="dl add">${e}</div>`;
    if (l.startsWith('-')) return `<div class="dl del">${e}</div>`;
    if (/^(diff |index |new file|deleted|rename|similarity|Binary)/.test(l)) return `<div class="dl meta">${e}</div>`;
    return `<div class="dl">${e}</div>`;
  }).join('');
}
async function tabChanges(el, p) {
  const target = p.isGit ? p : byId()[p.parent];
  if (!target) { el.append(h('div', { class: 'dim' }, 'Not a git repo.')); return; }
  const box = h('div', null, h('div', { class: 'dim' }, 'loading…')); el.append(box);
  let d; try { d = await api(`git/${target.id}/changes`); } catch (e) { box.textContent = e.message; return; }
  if (d.error) { box.textContent = d.error; return; }
  const total = d.staged.length + d.unstaged.length + d.untracked.length;
  // status na prvi pogled: sta NIJE commitano, sta NIJE pushano
  const pills = [];
  if (total) pills.push(h('span', { class: 'chpill warn' }, `● ${total} uncommitted`));
  if (!d.upstream) pills.push(h('span', { class: 'chpill mute' }, 'local only — no remote'));
  else if (d.ahead) pills.push(h('span', { class: 'chpill hot', title: `${d.ahead} commits exist only here — run git push` }, `⬆ ${d.ahead} NOT PUSHED`));
  else pills.push(h('span', { class: 'chpill ok' }, total ? '✓ commits pushed' : '✓ committed & pushed'));
  if (d.behind) pills.push(h('span', { class: 'chpill mute' }, `⬇ ${d.behind} behind`));
  box.replaceChildren(h('div', { class: 'chhead' },
    h('span', { class: 'branch', style: 'cursor:default' }, h('span', { class: 'ico' }, '⎇'), h('span', { class: 'b' }, d.branch || '?')),
    d.upstream ? h('span', { class: 'dim mono', style: 'font-size:11.5px' }, '→ ' + d.upstream) : null,
    ...pills,
    h('span', { class: 'sp' }),
    h('button', { class: 'btn sm', onclick: () => renderDrawer(true) }, '↻ refresh')));
  if (!total) box.append(h('div', { class: 'chclean' }, '✓ Working tree clean — nothing staged, nothing pending.'));
  // commit + push from here, so a session's leftover changes don't need a terminal
  if (total || d.ahead) {
    const msg = h('input', { class: 'txt cmsg', placeholder: total ? 'commit message… (Enter = commit' + (d.upstream ? ', ⇧Enter = commit & push' : '') + ')' : 'nothing to commit', disabled: !total, autocomplete: 'off' });
    const gitDo = async (action, label, extra) => { try { await act(`${target.name}: ${label}`, api('git', { id: target.id, action, ...extra })); } catch {} renderDrawer(true); };
    const doCommit = async (thenPush) => { const m = msg.value.trim(); if (!m) { msg.focus(); return; } if (d.staged.length === 0 && confirm('Nothing is staged. Stage ALL changes (git add -A) and commit?') === false) return; if (d.staged.length === 0) await act('stage all', api('git', { id: target.id, action: 'stage-all' })); await act('commit', api('git', { id: target.id, action: 'commit', message: m })); if (thenPush) await act('push', api('git', { id: target.id, action: 'push' })); renderDrawer(true); };
    msg.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); doCommit(ev.shiftKey); } });
    box.append(h('div', { class: 'cbox' }, msg,
      total ? h('button', { class: 'btn sm', title: 'git add -A', onclick: () => gitDo('stage-all', 'stage all') }, '＋ Stage all') : null,
      d.staged.length ? h('button', { class: 'btn sm ghost', title: 'git reset', onclick: () => gitDo('unstage-all', 'unstage all') }, '－ Unstage') : null,
      total ? h('button', { class: 'btn sm primary', title: 'commit staged (stages everything first if nothing is staged)', onclick: () => doCommit(false) }, '✓ Commit') : null,
      total ? h('button', { class: 'btn sm primary', title: 'commit, then git push', onclick: () => doCommit(true) }, '✓ Commit & push') : null,
      d.ahead || !d.upstream ? h('button', { class: 'btn sm' + (d.ahead ? ' hotbtn' : ''), title: d.upstream ? 'git push' : 'git push -u origin HEAD', onclick: () => gitDo('push', 'push') }, `⬆ Push${d.ahead ? ' ' + d.ahead : ''}`) : null));
  }
  const frow = (f, kind) => {
    const caret = h('span', { class: 'caret' }, '▸');
    const row = h('div', { class: 'chfile' },
      h('span', { class: 'chst s' + (f.s || 'Q') }, f.s || '?'), fileIcon(f.path),
      h('span', { class: 'chpath' }, f.from ? f.from + ' → ' + f.path : f.path),
      f.add != null ? h('span', { class: 'chnum add' }, '+' + f.add) : null,
      f.del != null ? h('span', { class: 'chnum del' }, '−' + f.del) : null,
      p.isGit ? h('button', { class: 'btn sm ghost', title: 'open in Files tab (content, download, edit)', onclick: ev => { ev.stopPropagation(); FILES.sel = f.path; FILES.mode = 'content'; openDrawer(UI.drawer, 'files'); } }, '▤') : null, caret);
    const dv = h('div', { class: 'chdiff hidden' });
    let open = false, loaded = false;
    row.onclick = async ev => { if (ev.target.closest('button')) return;
      open = !open; dv.classList.toggle('hidden', !open); caret.textContent = open ? '▾' : '▸';
      if (open && !loaded) {
        loaded = true; dv.textContent = 'loading…';
        try { const r = await api(`git/${target.id}/diff?file=${encodeURIComponent(f.path)}&kind=${kind}`); dv.innerHTML = r.error ? esc(r.error) : renderDiff(r.text); }
        catch (e) { dv.textContent = e.message; }
      }
    };
    return h('div', { class: 'chitem' }, row, dv);
  };
  const sec = (title, arr, kind, cls) => arr.length ? [h('h4', { class: 'chsec ' + cls }, title, ' ', h('span', { class: 'n' }, arr.length)), ...arr.map(f => frow(f, kind))] : [];
  box.append(
    ...sec('Staged — goes into the next commit', d.staged, 'staged', 'ok'),
    ...sec('Modified — not staged yet', d.unstaged, 'unstaged', 'warn'),
    ...sec('Untracked — new files', d.untracked, 'untracked', 'new'));
  // commits: the first `ahead` exist only locally; "me" = my email from the git config
  if (d.commits?.length) {
    const me = (d.me || '').toLowerCase();
    box.append(h('h4', { class: 'chsec' }, 'Commits on ', d.branch || '?', ' ', h('span', { class: 'n' }, d.commits.length)));
    const rows = [];
    d.commits.forEach((c, i) => {
      if (d.upstream && d.ahead && i === d.ahead) rows.push(h('div', { class: 'cdiv' }, h('span', { class: 'l' }), `pushed to ${d.upstream}`, h('span', { class: 'l' })));
      const mine = me && (c.email || '').toLowerCase() === me;
      const caret = h('span', { class: 'caret' }, '▸'); const det = h('div', { class: 'cdet hidden' }); let open = false, loaded = false;
      const row = h('div', { class: 'cmt' + (c.unpushed ? ' unp' : '') + (mine ? ' mine' : ''), title: `${c.subject}\n${c.author} <${c.email}> · ${c.rel}${c.unpushed ? '\nNOT PUSHED' : ''}\nclick to see the files`,
        onclick: async ev => { if (ev.target.closest('.chash')) return; open = !open; det.classList.toggle('hidden', !open); caret.textContent = open ? '▾' : '▸'; if (open && !loaded) { loaded = true; det.textContent = 'loading…'; try { renderCommit(det, target, await api(`git/${target.id}/commit/${c.hash}`)); } catch (e) { det.textContent = e.message; } } } },
        caret,
        h('span', { class: 'cdot', title: c.unpushed ? 'not pushed' : 'pushed' }),
        h('b', { class: 'chash mono', title: 'copy hash', onclick: () => navigator.clipboard?.writeText(c.hash).then(() => toast('copied ' + c.hash)) }, c.hash),
        h('span', { class: 'csub' }, c.subject),
        mine ? h('span', { class: 'cme' }, 'me') : h('span', { class: 'cwho' }, c.author),
        h('span', { class: 'cwhen mono' }, c.rel));
      rows.push(h('div', { class: 'citem' }, row, det));
    });
    box.append(h('div', { class: 'cmts' }, rows));
  }
}

// one expanded commit: message body + files, each file expandable into its diff in that commit
function renderCommit(el, target, c) {
  el.innerHTML = '';
  if (c.error) { el.textContent = c.error; return; }
  const add = c.files.reduce((a, f) => a + (f.add || 0), 0), del = c.files.reduce((a, f) => a + (f.del || 0), 0);
  el.append(h('div', { class: 'cmeta' }, h('span', { class: 'mono' }, c.hash.slice(0, 12)), ' · ', c.author, ' · ', h('span', { title: c.date }, c.rel), ' · ', h('span', { class: 'chnum add' }, '+' + add), ' ', h('span', { class: 'chnum del' }, '−' + del), ' · ', `${c.files.length} file${c.files.length === 1 ? '' : 's'}`, h('span', { class: 'sp' }),
    h('button', { class: 'btn sm ghost', title: 'copy full hash', onclick: ev => { ev.stopPropagation(); navigator.clipboard?.writeText(c.hash).then(() => toast('copied')); } }, '⎘ hash')));
  if (c.body) el.append(h('pre', { class: 'cbody' }, c.body));
  for (const f of c.files) {
    const caret = h('span', { class: 'caret' }, '▸');
    const row = h('div', { class: 'chfile' }, h('span', { class: 'chst s' + (f.s || 'M') }, f.s || 'M'), fileIcon(f.path), h('span', { class: 'chpath' }, f.from ? f.from + ' → ' + f.path : f.path), f.add != null ? h('span', { class: 'chnum add' }, '+' + f.add) : null, f.del != null ? h('span', { class: 'chnum del' }, '−' + f.del) : null,
      byId()[UI.drawer]?.isGit ? h('button', { class: 'btn sm ghost', title: 'open in Files tab', onclick: ev => { ev.stopPropagation(); FILES.sel = f.path; FILES.mode = 'content'; openDrawer(UI.drawer, 'files'); } }, '▤') : null, caret);
    const dv = h('div', { class: 'chdiff hidden' }); let open = false, loaded = false;
    row.onclick = async ev => { if (ev.target.closest('button')) return; open = !open; dv.classList.toggle('hidden', !open); caret.textContent = open ? '▾' : '▸';
      if (open && !loaded) { loaded = true; dv.textContent = 'loading…'; try { const r = await api(`git/${target.id}/commit/${c.hash}?file=${encodeURIComponent(f.path)}`); dv.innerHTML = r.error ? esc(r.error) : renderDiffHl(r.text, langOf(f.path)); dv.classList.add('hljs'); } catch (e) { dv.textContent = e.message; } } };
    el.append(h('div', { class: 'chitem' }, row, dv));
  }
}

// ---------- syntax colors (highlight.js from cdnjs; falls back to plain text when offline) + file-type icons ----------
const LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', mdx: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', env: 'bash', sql: 'sql', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cs: 'csharp', dart: 'dart', graphql: 'graphql', gql: 'graphql', dockerfile: 'dockerfile', makefile: 'makefile', diff: 'diff', txt: 'plaintext', lock: 'yaml', prisma: 'graphql', tf: 'ini' };
function langOf(name) { const n = String(name || '').toLowerCase(); const base = n.split('/').pop(); if (base === 'dockerfile') return 'dockerfile'; if (base === 'makefile') return 'makefile'; if (base.startsWith('.env')) return 'bash'; const ext = base.includes('.') ? base.split('.').pop() : ''; return LANG[ext] || null; }
// icon: [label, color class]; a compact VS Code-style badge instead of a font icon set
const ICON = { js: ['JS', 'i-js'], mjs: ['JS', 'i-js'], cjs: ['JS', 'i-js'], jsx: ['⚛', 'i-react'], ts: ['TS', 'i-ts'], tsx: ['⚛', 'i-ts'], json: ['{}', 'i-json'], md: ['M↓', 'i-md'], mdx: ['M↓', 'i-md'], css: ['#', 'i-css'], scss: ['#', 'i-scss'], less: ['#', 'i-css'], html: ['<>', 'i-html'], htm: ['<>', 'i-html'], xml: ['<>', 'i-html'], svg: ['◇', 'i-svg'], vue: ['V', 'i-vue'], py: ['Py', 'i-py'], sh: ['$', 'i-sh'], bash: ['$', 'i-sh'], zsh: ['$', 'i-sh'], yml: ['Y', 'i-yml'], yaml: ['Y', 'i-yml'], toml: ['T', 'i-yml'], ini: ['≡', 'i-yml'], env: ['⚙', 'i-env'], sql: ['DB', 'i-sql'], go: ['Go', 'i-go'], rs: ['Rs', 'i-rs'], java: ['J', 'i-java'], kt: ['Kt', 'i-kt'], swift: ['Sw', 'i-swift'], rb: ['Rb', 'i-rb'], php: ['φ', 'i-php'], dart: ['Da', 'i-dart'], png: ['🖼', 'i-img'], jpg: ['🖼', 'i-img'], jpeg: ['🖼', 'i-img'], gif: ['🖼', 'i-img'], webp: ['🖼', 'i-img'], ico: ['🖼', 'i-img'], pdf: ['📄', 'i-doc'], lock: ['🔒', 'i-lock'], txt: ['≡', 'i-txt'], log: ['≡', 'i-txt'], csv: ['⊞', 'i-csv'], zip: ['⧉', 'i-lock'], gz: ['⧉', 'i-lock'], tgz: ['⧉', 'i-lock'], prisma: ['▲', 'i-ts'], graphql: ['◈', 'i-gql'], gql: ['◈', 'i-gql'], tf: ['∞', 'i-tf'], mp4: ['▶', 'i-img'], mp3: ['♪', 'i-img'], woff: ['A', 'i-txt'], woff2: ['A', 'i-txt'], ttf: ['A', 'i-txt'] };
function fileIcon(name) {
  const base = String(name || '').toLowerCase();
  let ic = null;
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) ic = ['🐳', 'i-docker']; else if (base === 'makefile') ic = ['M', 'i-sh']; else if (base.startsWith('.env')) ic = ['⚙', 'i-env']; else if (base === 'package.json') ic = ['npm', 'i-npm']; else if (base === '.gitignore' || base === '.gitattributes') ic = ['git', 'i-git']; else if (base === 'claude.md' || base === 'agents.md') ic = ['✦', 'i-claude']; else if (base === 'license' || base === 'license.md') ic = ['©', 'i-txt'];
  else { const ext = base.includes('.') ? base.split('.').pop() : ''; ic = ICON[ext] || ['·', 'i-txt']; }
  return h('span', { class: 'fi ' + ic[1] }, ic[0]);
}
// Highlight a whole text and return one HTML string per line. hljs spans can cross lines (block comments, template
// strings), so open spans are closed at each line end and reopened on the next line.
function hlLines(text, lang) {
  const H = window.hljs;
  if (!H || !lang || !H.getLanguage(lang) || text.length > 600000) return text.split('\n').map(esc);
  let html; try { html = H.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { return text.split('\n').map(esc); }
  const out = []; const open = []; let cur = '';
  const re = /<span class="([^"]*)">|<\/span>|\n|[^<\n]+|</g; let m;
  while ((m = re.exec(html))) {
    const t = m[0];
    if (t === '\n') { out.push(cur + '</span>'.repeat(open.length)); cur = open.map(c => `<span class="${c}">`).join(''); }
    else if (t === '</span>') { open.pop(); cur += t; }
    else if (t.startsWith('<span')) { open.push(m[1]); cur += t; }
    else cur += t;
  }
  out.push(cur + '</span>'.repeat(open.length));
  return out;
}
// one line (diff bodies): no cross-line context, but colors on every +/- line
function hlOne(line, lang) { const H = window.hljs; if (!H || !lang || !H.getLanguage(lang)) return esc(line); try { return H.highlight(line, { language: lang, ignoreIllegals: true }).value; } catch { return esc(line); } }
function renderDiffHl(text, lang) {
  if (!text) return '<span class="dim">(empty diff — binary file or mode change)</span>';
  return text.split('\n').map(l => {
    if (l.startsWith('+++') || l.startsWith('---')) return `<div class="dl file">${esc(l)}</div>`;
    if (l.startsWith('@@')) return `<div class="dl hunk">${esc(l)}</div>`;
    if (/^(diff |index |new file|deleted|rename|similarity|Binary)/.test(l)) return `<div class="dl meta">${esc(l)}</div>`;
    const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''; const sign = cls ? l[0] : ' ';
    const body = l ? (cls || l.startsWith(' ') ? l.slice(1) : l) : '';
    return `<div class="dl ${cls}"><span class="dsign">${sign}</span>${hlOne(body, lang) || '&nbsp;'}</div>`;
  }).join('');
}

// ---------- Files tab: tree on the left (changed files marked), preview on the right (diff vs HEAD, content, download, edit) ----------
const FILES = { open: new Set(JSON.parse(localStorage.getItem('bd.fopen') || '[]')), sel: null, mode: 'auto', editing: false, wide: localStorage.getItem('bd.fwide') === '1' };
const STATUS_TITLE = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '?': 'untracked', U: 'conflict' };
function tabFiles(el, p) {
  el.classList.add('files-tab');
  const tree = h('div', { class: 'ftree' }); const prev = h('div', { class: 'fprev' }, h('div', { class: 'dim', style: 'padding:20px' }, 'Pick a file. Changed files are marked; the preview shows their diff against HEAD.'));
  el.append(h('div', { class: 'fwrap' + (FILES.wide ? ' wide' : '') }, tree, prev));
  const gitTarget = p.isGit ? p : byId()[p.parent];
  const loadDir = async (rel, box, depth) => {
    box.innerHTML = ''; let d; try { d = await api(`tree/${p.id}?path=${encodeURIComponent(rel)}`); } catch (e) { box.append(h('div', { class: 'dim' }, e.message)); return; }
    if (d.error) { box.append(h('div', { class: 'dim' }, d.error)); return; }
    for (const e of d.entries) {
      if (e.type === 'dir') {
        const kids = h('div', { class: 'fkids' }); const isOpen = FILES.open.has(e.path);
        const row = h('div', { class: 'frow dir' + (e.changed ? ' has' : '') + (e.skip ? ' skip' : ''), style: `padding-left:${8 + depth * 14}px`, title: e.skip ? 'build / dependency folder' : e.path },
          h('span', { class: 'fcaret' }, isOpen ? '▾' : '▸'), h('span', { class: 'fico' }, isOpen ? '📂' : '📁'), h('span', { class: 'fname' }, e.name), e.changed ? h('span', { class: 'fchg', title: e.changed + ' changed files inside' }, e.changed) : null);
        row.onclick = () => { const now = !FILES.open.has(e.path); if (now) FILES.open.add(e.path); else FILES.open.delete(e.path); localStorage.setItem('bd.fopen', JSON.stringify([...FILES.open].slice(-200))); row.querySelector('.fcaret').textContent = now ? '▾' : '▸'; row.querySelector('.fico').textContent = now ? '📂' : '📁'; kids.classList.toggle('hidden', !now); if (now && !kids.childElementCount) loadDir(e.path, kids, depth + 1); };
        if (!isOpen) kids.classList.add('hidden'); else loadDir(e.path, kids, depth + 1);
        box.append(row, kids);
      } else {
        const row = h('div', { class: 'frow file' + (e.status ? ' has st' + (e.status === '?' ? 'Q' : e.status) : '') + (FILES.sel === e.path ? ' on' : ''), style: `padding-left:${8 + depth * 14}px`, title: e.path + ' · ' + fmtB(e.size) + (e.status ? ' · ' + (STATUS_TITLE[e.status] || e.status) : ''), 'data-path': e.path },
          h('span', { class: 'fcaret' }), h('span', { class: 'fico' }, fileIcon(e.name)), h('span', { class: 'fname' }, e.name), e.status ? h('span', { class: 'chst s' + (e.status === '?' ? 'Q' : e.status), title: STATUS_TITLE[e.status] || e.status }, e.status) : null, h('span', { class: 'fsize mono' }, fmtB(e.size)));
        row.onclick = () => { if (FILES.editing && !confirm('Discard unsaved edits?')) return; FILES.editing = false; if (FILES.sel !== e.path) FILES.mode = 'auto'; FILES.sel = e.path; for (const x of tree.querySelectorAll('.frow.file.on')) x.classList.remove('on'); row.classList.add('on'); showFile(e); };
        box.append(row);
      }
    }
  };
  const showFile = async (e) => {
    prev.innerHTML = ''; prev.append(h('div', { class: 'dim', style: 'padding:20px' }, 'loading…'));
    const status = e.status; const wantDiff = status && status !== '?' && status !== 'A' ? (FILES.mode === 'auto' || FILES.mode === 'diff') : FILES.mode === 'diff' && status === '?';
    let content = null, diff = null;
    try { content = await api(`read/${p.id}?path=${encodeURIComponent(e.path)}`); } catch (err) { content = { error: err.message }; }
    if (status && gitTarget) { try { const sub = (p.isGit ? '' : p.rel.slice(gitTarget.rel.length + 1) + '/'); diff = await api(`git/${gitTarget.id}/headdiff?file=${encodeURIComponent(sub + e.path)}&untracked=${status === '?' ? 1 : 0}`); } catch (err) { diff = { error: err.message }; } }
    render();
    function render() {
      prev.innerHTML = '';
      const showDiff = wantDiff && diff && !diff.error && diff.text;
      const bar = h('div', { class: 'fbar' },
        fileIcon(e.name), h('span', { class: 'fpath mono', title: e.path }, e.path),
        status ? h('span', { class: 'chst s' + (status === '?' ? 'Q' : status), title: STATUS_TITLE[status] || status }, status) : null,
        h('span', { class: 'dim mono', style: 'font-size:11px' }, fmtB(content.size || e.size)),
        h('span', { class: 'sp' }),
        status ? h('button', { class: 'btn sm' + (showDiff ? ' primary' : ''), onclick: () => { FILES.mode = 'diff'; showFile(e); } }, '± diff') : null,
        h('button', { class: 'btn sm' + (!showDiff && !FILES.editing ? ' primary' : ''), onclick: () => { FILES.mode = 'content'; FILES.editing = false; showFile(e); } }, '▤ content'),
        !content.error && !content.binary && !content.truncated ? h('button', { class: 'btn sm' + (FILES.editing ? ' primary' : ''), title: 'edit in place (simple text editor)', onclick: () => { FILES.mode = 'content'; FILES.editing = true; render(); } }, '✎ edit') : null,
        h('a', { class: 'btn sm', href: `/api/download/${p.id}?path=${encodeURIComponent(e.path)}`, download: e.name, title: 'download this file' }, '⇩ download'),
        h('button', { class: 'btn sm ghost', title: FILES.wide ? 'show tree' : 'hide tree', onclick: () => { FILES.wide = !FILES.wide; localStorage.setItem('bd.fwide', FILES.wide ? '1' : '0'); el.querySelector('.fwrap').classList.toggle('wide', FILES.wide); } }, FILES.wide ? '⇤' : '⇥'));
      prev.append(bar);
      if (FILES.editing && content && !content.error && !content.binary) {
        const ta = h('textarea', { class: 'fedit', spellcheck: false }); ta.value = content.text;
        ta.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Tab') { ev.preventDefault(); const s0 = ta.selectionStart; ta.setRangeText('  ', s0, ta.selectionEnd, 'end'); } if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') { ev.preventDefault(); saveBtn.click(); } });
        const saveBtn = h('button', { class: 'btn sm primary', onclick: async () => { try { const r = await api('savefile', { id: p.id, path: e.path, text: ta.value, mtime: content.mtime }); content.mtime = r.mtime; content.size = r.size; content.text = ta.value; FILES.editing = false; toast('saved ' + e.name, 'ok'); showFile(e); } catch (err) { toast('save failed: ' + err.message, 'err'); } } }, '💾 Save (⌘S)');
        prev.append(h('div', { class: 'fedbar' }, h('span', { class: 'dim' }, 'Editing in place. Save refuses if the file changed on disk meanwhile (a Claude session may be working here).'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost', onclick: () => { FILES.editing = false; render(); } }, 'Cancel'), saveBtn), ta);
        setTimeout(() => { ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0; }, 0);
        return;
      }
      if (showDiff) { prev.append(h('div', { class: 'chdiff fdiff hljs', html: renderDiffHl(diff.text, langOf(e.name)) })); return; }
      if (content.error) { prev.append(h('div', { class: 'dim', style: 'padding:20px' }, content.error)); return; }
      if (content.binary) { prev.append(h('div', { class: 'dim', style: 'padding:20px' }, 'binary file — use download')); return; }
      if (status && diff && diff.error) prev.append(h('div', { class: 'dim', style: 'padding:6px 12px' }, 'diff: ' + diff.error));
      const lines = hlLines(content.text, langOf(e.name));
      prev.append(h('pre', { class: 'fcode hljs' }, lines.map((l, i) => h('div', { class: 'ln' }, h('span', { class: 'n' }, i + 1), h('span', { class: 't', html: l || ' ' }))), content.truncated ? h('div', { class: 'dim' }, '… truncated (2 MB shown) — download for the whole file') : null));
    }
  };
  loadDir('', tree, 0).then(() => { if (FILES.sel) { const row = tree.querySelector(`.frow.file[data-path="${CSS.escape(FILES.sel)}"]`); if (row) row.click(); else { const parts = FILES.sel.split('/'); if (parts.length > 1) { for (let i = 1; i < parts.length; i++) FILES.open.add(parts.slice(0, i).join('/')); loadDir('', tree, 0).then(() => setTimeout(() => { const r2 = tree.querySelector(`.frow.file[data-path="${CSS.escape(FILES.sel)}"]`); if (r2) r2.click(); }, 400)); } } } });
}

async function tabBranches(el, p) {
  const target = p.isGit ? p : byId()[p.parent]; if (!target) { el.append(h('div', { class: 'dim' }, 'Not a git repo.')); return; }
  el.append(h('div', { class: 'logbar' }, h('button', { class: 'btn sm', onclick: () => act('fetch', api('git', { id: target.id, action: 'fetch' })).then(() => renderDrawer(true)) }, '⇣ Fetch all'), h('button', { class: 'btn sm', onclick: () => act('pull', api('git', { id: target.id, action: 'pull' })) }, '↓ Pull'), h('button', { class: 'btn sm', onclick: () => act('stash', api('git', { id: target.id, action: 'stash' })) }, '⧉ Stash'), h('button', { class: 'btn sm', onclick: () => act('stash pop', api('git', { id: target.id, action: 'stash-pop' })) }, '⧉ Pop')));
  const box = h('div', null, 'loading…'); el.append(box);
  const br = await api(`git/${target.id}/branches`);
  const row = (b, remote) => h('div', { class: 'br' + (b.name === br.current ? ' cur' : ''), onclick: () => checkout(target, b.name) }, h('span', { class: 'n' }, remote ? '☁ ' + b.short : (b.name === br.current ? '● ' : '○ ') + b.name), h('span', { class: 's' }, b.subject), h('span', { class: 't' }, b.rel));
  box.replaceChildren(h('h4', null, `Local (${br.local.length})`), h('div', { class: 'brlist' }, br.local.map(b => row(b, false))), h('h4', null, `Remote only (${br.remote.length})`), h('div', { class: 'brlist' }, br.remote.map(b => row(b, true))));
}
function tabDocker(el, p, r) {
  const compose = p.commands.filter(c => c.kind === 'compose');
  if (compose.length) el.append(h('div', { class: 'logbar' }, compose.map(c => h('button', { class: 'btn sm', title: c.cmd, onclick: () => act(c.name, api('run', { id: p.id, name: c.name })) }, '🐳 ' + c.name))));
  if (!r.containers.length) { el.append(h('div', { class: 'dim' }, 'No containers attributed to this project (attribution is by compose working dir).')); return; }
  for (const c of r.containers) el.append(h('div', { class: 'ctr ' + c.state }, h('span', { class: 'st' }), h('span', { class: 'nm' }, c.name), h('span', { class: 'im' }, `${c.image} · ${c.status}`), h('span', { class: 'p' }, c.ports.filter(x => x.host).map(x => `${x.hostIp === '0.0.0.0' ? '' : x.hostIp + ':'}${x.host}→${x.container}`).join(' ')),
    h('button', { class: 'btn sm', onclick: () => { UI.tab = 'logs'; UI.logTarget = 'docker:' + c.id; renderDrawer(true); } }, 'logs'),
    c.state === 'running' ? [h('button', { class: 'btn sm', onclick: () => act('restart ' + c.name, api('docker', { id: c.id, action: 'restart' })) }, '↻'), h('button', { class: 'btn sm danger', onclick: () => act('stop ' + c.name, api('docker', { id: c.id, action: 'stop' })) }, '■')] : [h('button', { class: 'btn sm primary', onclick: () => act('start ' + c.name, api('docker', { id: c.id, action: 'start' })) }, '▶'), h('button', { class: 'btn sm danger', onclick: () => confirm('Remove container ' + c.name + '?') && act('rm ' + c.name, api('docker', { id: c.id, action: 'rm' })) }, '🗑')]));
}
function tabRecent(el, p) {
  const rec = S.runtime.recent.filter(x => x.project === p.id);
  if (!rec.length) { el.append(h('div', { class: 'dim' }, 'No finished runs yet.')); return; }
  el.append(h('div', { class: 'recent' }, rec.map(x => h('div', { class: 'r' }, h('span', { class: x.exitCode === 0 ? 'ok' : 'bad' }, x.exitCode === 0 ? '✓' : '✗ ' + (x.exitCode ?? '?')), h('span', { style: 'min-width:120px;color:var(--text)' }, x.name), h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, x.cmd), h('span', null, `${ago(x.startedAt)} ago · ran ${Math.round((x.endedAt - x.startedAt) / 1000)}s`), h('button', { class: 'btn sm', onclick: () => { UI.tab = 'logs'; UI.logTarget = x.name; renderDrawer(true); } }, 'log'), h('button', { class: 'btn sm', onclick: () => act('re-run ' + x.name, api('run', { id: p.id, name: x.name, cmd: x.cmd })) }, '▶')))));
}

// ---------- settings ----------
function settingsModal() {
  const s = S.settings; const m = $('#modal'); m.classList.remove('hidden');
  // iOS-style grouped settings: a titled group of rows, label + hint on the left, the control on the right
  const sect = (title, ...rows) => h('section', { class: 'sg' }, h('div', { class: 'sg-t' }, title), h('div', { class: 'sg-b' }, ...rows.filter(Boolean)));
  const row = (label, hint, ctl, cls = '') => h('div', { class: 'sr ' + cls }, h('div', { class: 'sr-l' }, h('div', { class: 'sr-k' }, label), hint ? h('div', { class: 'sr-h' }, hint) : null), h('div', { class: 'sr-c' }, ctl));
  const sw = (checked, attrs = {}) => h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked, ...attrs }), h('i'));
  const txt = (k, extra = {}) => { const i = h('input', { class: 'txt', value: s[k] ?? '', ...extra }); i.dataset.k = k; return i; };
  const auto = h('input', { type: 'checkbox', checked: s.autoExpose });
  const hidden = Object.entries(s.projects || {}).filter(([, v]) => v.hidden).map(([k]) => k);
  const n = s.notify || {};
  const ncb = (k, l, hint) => row(l, hint, sw(n[k] !== false && (k !== 'digest' || n.digest), { 'data-n': k }));
  const qf = h('input', { class: 'txt sm', type: 'time', value: n.quietFrom || '', 'data-q': 'quietFrom' }); const qt = h('input', { class: 'txt sm', type: 'time', value: n.quietTo || '', 'data-q': 'quietTo' });
  const box = h('div', { class: 'box settings' },
    h('div', { class: 'sh' }, h('h3', null, 'Settings'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: () => m.classList.add('hidden') }, ico('x', 15))),
    h('div', { class: 'sbody' },
      sect('Tools',
        row('Tunnels', `${S.runtime.exposures.length} loopback ports forwarded onto ${S.host.tsIp || 'the tailscale IP'} (socat) so your laptop reaches them without ssh -L`, h('button', { class: 'btn sm', onclick: () => { m.classList.add('hidden'); UI.showTunnels = true; renderTunnels(); window.scrollTo(0, 0); } }, 'Open')),
        row('Auto-expose', 'forward every loopback-bound project port automatically', h('label', { class: 'sw' }, auto, h('i'))),
        row('Projects', `rescan ${home(S.host.devRoot || '~')} for new folders`, h('button', { class: 'btn sm', onclick: () => act('Rescan', api('rescan', {})) }, 'Rescan')),
        row('State backup', 'nightly tar of sessions, labels, push subscriptions, settings, schedule — 14 kept', h('a', { href: '/api/backup', class: 'btn sm' }, 'Download'))),
      sect('Notifications',
        ncb('done', 'Session finished'), ncb('permission', 'Needs permission'), ncb('error', 'Session error'), ncb('limit', 'Usage limit hit'), ncb('crash', 'Dev server died'), ncb('digest', 'Monday weekly digest'),
        row('Quiet hours', 'no push between these times', h('span', { class: 'qh' }, qf, h('span', { class: 'dim' }, '–'), qt)),
        row('Sound', 'ding on this device when a session needs you', sw(SOUND.on, { onchange: e => { SOUND.on = e.target.checked; localStorage.setItem('bd.sound', SOUND.on ? '1' : '0'); if (SOUND.on) ding('done'); } })),
        row('Push', PUSH.supported ? `${S.host.pushSubs || 0} device(s) subscribed · ` + (PUSH.sub ? 'enabled here' : 'not enabled on this device') : 'needs HTTPS (service worker) — open via https://' + (S.host.tsName || '<magicdns-name>'),
          PUSH.supported ? h('span', { class: 'qh' }, PUSH.sub ? h('button', { class: 'btn sm', onclick: () => disablePush().then(() => m.classList.add('hidden')) }, 'Disable') : h('button', { class: 'btn sm primary', onclick: () => enablePush().then(() => m.classList.add('hidden')) }, 'Enable'), h('button', { class: 'btn sm ghost', onclick: () => api('push-test', {}).then(r => toast(`test sent to ${r.sent || 0} device(s)`)) }, 'Test')) : null),
        (s.muted || []).length ? row('Muted sessions', s.muted.join(', '), h('span', { class: 'dim', style: 'font-size:11.5px' }, 'bell in the terminal bar')) : null),
      sect('Sessions',
        row('Auto-restore after reboot', 'claude --resume in the same folders as soon as the dashboard starts', sw(!!s.autoRestore, { id: 'set-autorestore' }))),
      sect('Connection',
        row('SSH host alias', 'as in ~/.ssh/config on your laptop · used for VS Code links and copied ssh commands', txt('sshHost', { placeholder: 'myserver' })),
        row('SSH user', 'empty if the alias sets it', txt('sshUser')),
        row('Public host for port links', `empty = ${S.host.tsIp || 'tailscale IP'}${S.host.tsName ? ' · "' + S.host.tsName + '" if MagicDNS works' : ''}`, txt('publicHost', { placeholder: S.host.tsIp || '' })),
        row('Dev root', 'folder scanned for projects', txt('devRoot')),
        row('Scan depth', '', txt('scanDepth', { type: 'number', class: 'txt sm' }))),
      hidden.length ? sect('Hidden projects', ...hidden.map(id => row(id, '', h('button', { class: 'btn sm', onclick: () => api('project', { id, hidden: false }).then(() => { m.classList.add('hidden'); toast('unhidden'); }) }, 'Unhide')))) : null),
    h('div', { class: 'foot' }, h('button', { class: 'btn ghost', onclick: () => m.classList.add('hidden') }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => { const patch = { autoExpose: auto.checked, autoRestore: !!box.querySelector('#set-autorestore')?.checked, notify: { ...(s.notify || {}) } }; for (const i of box.querySelectorAll('input[data-n]')) patch.notify[i.dataset.n] = i.checked; for (const i of box.querySelectorAll('input[data-q]')) patch.notify[i.dataset.q] = i.value; for (const i of box.querySelectorAll('input[data-k]')) patch[i.dataset.k] = i.type === 'number' ? +i.value : i.value.trim(); await act('Settings saved', api('settings', patch)); m.classList.add('hidden'); } }, 'Save')));
  m.replaceChildren(box);
  m.onclick = e => { if (e.target === m) m.classList.add('hidden'); };
}

// ---------- tasks: personal backlog, prompt-style, linked to projects; "Run" hands one to Claude ----------
const TASKS_UI = { showDone: false };
function renderTasks() {
  const el = $('#tasks'); if (!el) return; el.innerHTML = '';
  const all = S.claude?.tasks || []; const open = all.filter(t => t.status !== 'done'); const done = all.filter(t => t.status === 'done');
  el.append(h('div', { class: 'tshead' }, h('span', { class: 'tstitle' }, 'Tasks', h('span', { class: 'n' }, open.length)), h('span', { class: 'sp' }),
    h('button', { class: 'btn sm ghost', onclick: () => { TASKS_UI.showDone = !TASKS_UI.showDone; renderTasks(); } }, TASKS_UI.showDone ? 'hide done' : `done (${done.length})`),
    h('button', { class: 'btn sm primary', onclick: () => taskModal(null) }, ico('plus', 14), 'New task')));
  if (!open.length && !TASKS_UI.showDone) el.append(h('div', { class: 'tsempty' }, 'No open tasks. Write yourself one — as detailed as a prompt, with screenshots — and hand it to Claude when you are ready.'));
  const groups = [['doing', 'In progress'], ['todo', 'To do']];
  for (const [st, label] of groups) { const ts = open.filter(t => t.status === st); if (!ts.length) continue; el.append(h('div', { class: 'tksec' }, label, h('span', { class: 'n' }, ts.length)), h('div', { class: 'tklist' }, ts.map(taskCard))); }
  if (TASKS_UI.showDone && done.length) el.append(h('div', { class: 'tksec' }, 'Done', h('span', { class: 'n' }, done.length)), h('div', { class: 'tklist done' }, done.sort((a, b) => b.doneAt - a.doneAt).map(taskCard)));
}
function taskCard(t) {
  const p = t.project && byId()[t.project]; const live = p ? S.runtime.sessions.filter(s => s.claude && s.project === p.id) : [];
  const lastRun = t.runs[t.runs.length - 1]; const runSess = lastRun && S.runtime.sessions.find(s => s.name === lastRun.session);
  const imgs = t.files.filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f)); const others = t.files.filter(f => !imgs.includes(f));
  return h('div', { class: 'tk st-' + t.status, 'data-id': t.id },
    h('div', { class: 'tk-head' }, avatar(p ? p.id : null), h('div', { class: 'tk-hd' }, h('div', { class: 'tk-title', onclick: () => taskModal(t) }, t.title), h('div', { class: 'tk-sub' }, p ? p.name : h('span', { class: 'dim' }, 'no project'), ' · ', ago(t.createdAt) + ' ago', lastRun ? [' · ', h('span', { class: 'tk-run' + (runSess ? ' on' : '') }, 'sent to ', runSess ? h('a', { href: '#', onclick: ev => { ev.preventDefault(); openTerm(lastRun.session); } }, lastRun.session.replace(/^claude-/, '')) : lastRun.session.replace(/^claude-/, ''), ' ', ago(lastRun.at) + ' ago')] : null)),
      h('div', { class: 'tk-acts' },
        t.status !== 'done' ? h('button', { class: 'btn sm primary', title: 'hand this task to Claude on ' + (p ? p.name : 'its project'), onclick: ev => runTaskMenu(ev, t) }, '▶ Run', h('span', { class: 'caret' }, '▾')) : null,
        t.status !== 'done' ? h('button', { class: 'btn sm', title: 'mark done', onclick: () => api('task-update', { id: t.id, status: 'done' }).then(() => toast('done ✓', 'ok')) }, '✓ Done') : h('button', { class: 'btn sm', title: 'reopen', onclick: () => api('task-update', { id: t.id, status: 'todo' }) }, '↺ Reopen'),
        h('button', { class: 'btn sm icon ghost', title: 'edit', onclick: () => taskModal(t) }, '✎'),
        h('button', { class: 'btn sm icon ghost', title: 'delete', onclick: () => { if (confirm('Delete this task?')) api('task-remove', { id: t.id }); } }, ico('x', 13)))),
    t.body ? h('div', { class: 'tk-body', onclick: () => taskModal(t) }, t.body) : null,
    imgs.length || others.length ? h('div', { class: 'tk-files' }, imgs.map(f => h('a', { href: '/api/file?p=' + encodeURIComponent(f), target: '_blank', title: f.split('/').pop() }, h('img', { src: '/api/file?p=' + encodeURIComponent(f), loading: 'lazy' }))), others.map(f => h('a', { class: 'tk-file', href: '/api/file?p=' + encodeURIComponent(f), target: '_blank', title: f }, ico('clip', 12), f.split('/').pop()))) : null);
}
function runTaskMenu(ev, t) {
  const p = t.project && byId()[t.project]; if (!p) { toast('pick a project for this task first', 'err'); return taskModal(t); }
  const live = S.runtime.sessions.filter(s => s.claude && s.project === p.id);
  const go = (account, session) => act('Task → ' + p.name, api('task-run', { id: t.id, account, session })).then(r => { if (r && r.session) setTimeout(() => openTerm(r.session), 1200); });
  openMenu(ev, [
    { header: 'Send the task as a prompt to…' },
    ...live.map(s => ({ label: (s.claude.label || p.name) + (instOf(s).n ? ' #' + instOf(s).n : ''), sub: `${s.name} · ${STATE_LABEL[s.claude.state] || ''}${s.claude.state === 'working' ? ' — queued until it is idle' : ''}`, icon: '●', cur: true, onclick: () => go(s.claude.account, s.name) })),
    live.length ? 'sep' : null,
    { label: 'New personal session', sub: 'starts claude in ' + home(p.path), icon: '＋', onclick: () => go('personal') },
    { label: 'New company session', sub: 'starts claude (company account)', icon: '＋', onclick: () => go('company') },
  ].filter(Boolean));
}
// New / edit task: project picker, title, prompt-style body (paste or drop screenshots straight in), attachments kept forever
function taskModal(t, projectId) {
  const m = $('#modal'); m.classList.remove('hidden');
  const files = [...(t?.files || [])];
  const projs = S.projects.filter(p => !p.hidden).sort((a, b) => (a.org + a.name).localeCompare(b.org + b.name));
  const sel = h('select', { class: 'txt' }, h('option', { value: '' }, '— no project —'), projs.map(p => h('option', { value: p.id, selected: p.id === (t?.project || projectId) }, `${p.org} / ${p.name}`)));
  const title = h('input', { class: 'txt', placeholder: 'What needs to happen (one line)', value: t?.title || '' });
  const body = h('textarea', { class: 'creply tkbody', rows: 10, placeholder: 'Write it like a prompt: context, what to change, where, how to verify, what not to touch. Paste screenshots here (Cmd+V) or drop files.' }); body.value = t?.body || '';
  const flist = h('div', { class: 'tk-files edit' });
  const drawFiles = () => { flist.replaceChildren(...files.map((f, i) => h('span', { class: 'tk-file' }, /\.(png|jpe?g|gif|webp)$/i.test(f) ? h('img', { src: '/api/file?p=' + encodeURIComponent(f) }) : ico('clip', 12), f.split('/').pop(), h('button', { class: 'x', title: 'remove', onclick: () => { files.splice(i, 1); drawFiles(); } }, ico('x', 11))))); };
  const upload = async f => { try { toast('uploading ' + f.name + '…'); const pth = await uploadFile(f, true); files.push(pth); drawFiles(); } catch (e) { toast(e.message, 'err'); } };
  const fileIn = h('input', { type: 'file', multiple: true, style: 'display:none', onchange: () => { for (const f of fileIn.files) upload(f); fileIn.value = ''; } });
  body.addEventListener('paste', ev => { const fs = [...(ev.clipboardData?.files || [])]; if (fs.length) { ev.preventDefault(); fs.forEach(upload); } });
  body.addEventListener('dragover', ev => ev.preventDefault()); body.addEventListener('drop', ev => { ev.preventDefault(); [...(ev.dataTransfer?.files || [])].forEach(upload); });
  for (const i of [title, body]) i.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) saveBtn.click(); });
  drawFiles();
  const saveBtn = h('button', { class: 'btn primary', onclick: async () => { if (!title.value.trim()) { title.focus(); return; } const data = { title: title.value, body: body.value, project: sel.value, files }; await act(t ? 'Task updated' : 'Task added', t ? api('task-update', { id: t.id, ...data }) : api('task', data)); m.classList.add('hidden'); if (UI.view !== 'tasks') setView('tasks'); } }, t ? 'Save' : 'Add task');
  const box = h('div', { class: 'box settings task' },
    h('div', { class: 'sh' }, h('h3', null, t ? 'Edit task' : 'New task'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', onclick: () => m.classList.add('hidden') }, ico('x', 15))),
    h('div', { class: 'sbody' },
      h('div', { class: 'sg' }, h('div', { class: 'sg-t' }, 'Project'), sel),
      h('div', { class: 'sg' }, h('div', { class: 'sg-t' }, 'Title'), title),
      h('div', { class: 'sg' }, h('div', { class: 'sg-t' }, 'Details — this is what Claude gets'), body,
        h('div', { class: 'tk-attach' }, h('button', { class: 'btn sm ghost', onclick: () => fileIn.click() }, ico('clip', 14), 'Attach files'), fileIn, h('span', { class: 'hint', style: 'margin:0' }, 'screenshots, CSVs, anything — kept until you delete the task')), flist)),
    h('div', { class: 'foot' }, h('span', { class: 'hint', style: 'margin:0 auto 0 0' }, '⌘↵ to save'), h('button', { class: 'btn ghost', onclick: () => m.classList.add('hidden') }, 'Cancel'), saveBtn));
  m.replaceChildren(box); m.onclick = e => { if (e.target === m) m.classList.add('hidden'); };
  setTimeout(() => (t ? body : title).focus(), 50);
}
// ---------- views: home (stats · agents · running) / projects (cards + search) ----------
function setView(v, keepQuery) {
  UI.view = v; localStorage.setItem('bd.view', v);
  $('#view-home').classList.toggle('hidden', v !== 'home'); $('#view-projects').classList.toggle('hidden', v !== 'projects'); $('#view-tasks').classList.toggle('hidden', v !== 'tasks');
  for (const b of document.querySelectorAll('#nav .navb')) b.classList.toggle('on', b.dataset.view === v);
  if (v === 'home' && !keepQuery) { $('#search').value = ''; UI.q = ''; }
  render();
}
function render() {
  if (UI.menuOpen) return; // don't yank menus from under the cursor
  $('#view-home').classList.toggle('hidden', UI.view !== 'home'); $('#view-projects').classList.toggle('hidden', UI.view !== 'projects'); $('#view-tasks').classList.toggle('hidden', UI.view !== 'tasks');
  for (const b of document.querySelectorAll('#nav .navb')) b.classList.toggle('on', b.dataset.view === UI.view);
  renderHeader(); renderBanner(); renderTunnels(); 
  if (UI.view === 'home') { renderStats(); renderTermStrip(); renderRunning(); } else if (UI.view === 'tasks') renderTasks(); else renderMain();
  if (UI.drawer) renderDrawer(false);
  if (TERM.open) { renderTermPanel(); renderChatPane(false); } else $('#term-count').textContent = S.runtime.sessions.length;
  gcFrames();
  if (PAL.open) renderPalette();
}

// ---------- events ----------
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', e => { const d = JSON.parse(e.data); Object.assign(S, { projects: d.projects, runtime: d.runtime, settings: d.settings, host: d.host, claude: d.claude || S.claude, health: d.health || S.health || {}, crashes: d.crashes || [] }); render(); firstState(); });
  es.addEventListener('history', e => { S.hist = JSON.parse(e.data); drawSparks(); });
  es.addEventListener('stats', e => { S.stats = JSON.parse(e.data); const H = S.hist; const push = (a, v) => { a.push(v); if (a.length > 180) a.shift(); }; push(H.cpu, S.stats.cpu.pct); push(H.mem, S.stats.mem.used / S.stats.mem.total * 100); push(H.gpu, S.stats.gpu?.util || 0); push(H.net, [S.stats.net.rxRate, S.stats.net.txRate]); if (!UI.menuOpen && UI.view === 'home') renderStats(); });
  es.addEventListener('ding', e => { const d = JSON.parse(e.data); if (SOUND.on) ding(d.state); });
  es.onerror = () => { $('#hostline').textContent = 'reconnecting…'; };
  UI.es = es;
}
// Coming back to the foreground (phone unlock, tab switch): fetch the state right away instead of waiting for the
// next event, and rebuild the stream if the browser dropped it while we were away.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  api('state').then(d => { Object.assign(S, { projects: d.projects, runtime: d.runtime, settings: d.settings, host: d.host, claude: d.claude, health: d.health || {}, crashes: d.crashes || [] }); if (d.stats) S.stats = d.stats; render(); }).catch(() => {});
  if (UI.es && UI.es.readyState === 2) { try { UI.es.close(); } catch {} connect(); }
});
// short sound on the Mac when a session needs you (per-device setting; browsers only play after you interacted with the page)
const SOUND = { on: localStorage.getItem('bd.sound') === '1' };
function ding(state) {
  try { const ctx = ding.ctx || (ding.ctx = new (window.AudioContext || window.webkitAudioContext)()); const t = ctx.currentTime;
    const notes = state === 'permission' ? [660, 660] : state === 'error' || state === 'limit' ? [440, 330] : [523, 784];
    notes.forEach((f, i) => { const o = ctx.createOscillator(); const g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t + i * 0.16); g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.16 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.15); o.connect(g).connect(ctx.destination); o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.16); });
  } catch {}
}
$('#search').addEventListener('input', e => { UI.q = e.target.value.trim(); if (UI.q && UI.view !== 'projects') setView('projects', true); else renderMain(); });
for (const b of document.querySelectorAll('#nav .navb')) b.onclick = () => setView(b.dataset.view);
$('#btn-shell').onclick = () => { if (TERM.open) return closeTermPanel(); pushLayer('term'); TERM.open = true; if (!TERM.active) { const c = S.runtime.sessions.find(x => x.name.startsWith('claude-')) || S.runtime.sessions[0]; if (c) { ensureFrame(c.name); TERM.active = c.name; } } renderTermPanel(); };
$('#btn-settings').onclick = settingsModal;
$('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', e => {
  const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'SELECT');
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); PAL.open ? closePalette() : openPalette(); return; }
  if (PAL.open) return;   // the palette handles its own keys
  if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'Escape') { if (!$('#modal').classList.contains('hidden')) $('#modal').classList.add('hidden'); else if (UI.menuOpen) closeMenu(); else if (UI.drawer) closeDrawer(); else if (TERM.open) closeTermPanel(); else if (UI.q) { $('#search').value = ''; UI.q = ''; renderMain(); } else if (UI.view === 'projects' || UI.view === 'tasks') setView('home'); } // drawer before term: the Changes drawer can sit on top of the terminal
  // dashboard-level shortcuts (not while typing): t = terminals, n = next session that needs you, s = new shell
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 't') { e.preventDefault(); $('#btn-shell').click(); }
  if (e.key === 'p') { e.preventDefault(); setView('projects'); }
  if (e.key === 'h') { e.preventDefault(); setView('home'); }
  if (e.key === 'n') { e.preventDefault(); const c = termSessions().claude.find(x => x.claude?.needsYou) || termSessions().claude[0]; if (c) openTerm(c.name); }
  if (e.key === 's' && !TERM.open) { e.preventDefault(); newShell(); }
  if (/^[1-9]$/.test(e.key) && TERM.open) { const o = termOrder(); if (o[+e.key - 1]) openTerm(o[+e.key - 1]); }
});
window.addEventListener('resize', drawSparks);

// ---------- command palette (Cmd/Ctrl+K): jump to any session or project, run the common actions ----------
const PAL = { open: false, q: '', idx: 0 };
function paletteItems() {
  const q = PAL.q.toLowerCase().trim(); const items = [];
  const S3 = termSessions();
  for (const it of S3.claude) items.push({ kind: 'claude', label: it.project + (it.name.match(/-wt-([^-]+)/) ? ' ⎇ ' + it.name.match(/-wt-([^-]+)/)[1] : '') + (it.name.match(/^claude-.*-(\d+)(-company)?$/) ? ' #' + it.name.match(/-(\d+)(-company)?$/)[1] : ''), sub: (it.claude ? (STATE_LABEL[it.claude.state] || '') + (it.claude.title ? ' · ' + it.claude.title : '') : '') || it.name, tag: it.account, icon: STATE_ICON[it.claude?.state] || '✦', cls: 'st-' + (it.claude?.state || 'unknown'), hay: [it.project, it.name, it.claude?.title, it.claude?.lastPrompt, it.account].join(' '), run: () => openTerm(it.name), rank: 1 });
  for (const it of S3.dev) items.push({ kind: 'dev', label: it.project + ' · ' + it.label, sub: it.ports.map(p => ':' + p.port).join(' ') || it.name, icon: '▶', hay: [it.project, it.label, it.name].join(' '), run: () => openTerm(it.name), rank: 10 });
  for (const it of S3.other) items.push({ kind: 'other', label: it.name, sub: it.cwd, icon: '⌨', hay: it.name + ' ' + it.cwd, run: () => openTerm(it.name), rank: 11 });
  for (const p of S.projects.filter(p => !p.hidden)) items.push({ kind: 'project', label: p.name, sub: [p.org, p.group, p.framework].filter(Boolean).join(' · '), icon: '▤', hay: [p.name, p.rel, p.org, p.framework].join(' '), run: () => openDrawer(p.id, 'overview'), rank: 20, more: [{ l: '✦', t: 'Claude (personal)', f: () => startClaude(p, 'personal') }, { l: '✦c', t: 'Claude (company)', f: () => startClaude(p, 'company') }, { l: '±', t: 'changes', f: () => openDrawer(p.id, 'changes') }] });
  items.push({ kind: 'action', label: 'New shell', sub: 'bash in the dev folder (tmux sh-N)', icon: '$', hay: 'shell bash terminal new', run: newShell, rank: 30 },
    { kind: 'action', label: 'Terminals panel', sub: 'full-screen terminal view', icon: '⛶', hay: 'terminals panel', run: () => $('#btn-shell').click(), rank: 31 },
    { kind: 'action', label: 'Tunnels', sub: 'exposed ports', icon: '⇄', hay: 'tunnels ports expose socat', run: () => { UI.showTunnels = true; renderTunnels(); }, rank: 32 },
    { kind: 'action', label: 'Tasks', sub: `${(S.claude?.tasks || []).filter(t => t.status !== 'done').length} open`, icon: '☑', hay: 'tasks todo backlog', run: () => setView('tasks'), rank: 30 },
    { kind: 'action', label: 'New task', sub: 'write yourself a prompt-style task', icon: '＋', hay: 'new task add todo', run: () => taskModal(null), rank: 30 },
    { kind: 'action', label: 'Settings', sub: '', icon: '⚙', hay: 'settings config push notifications', run: settingsModal, rank: 33 },
    { kind: 'action', label: 'Rescan projects', sub: '', icon: '↻', hay: 'rescan projects', run: () => act('Rescan', api('rescan', {})), rank: 34 },
    { kind: 'action', label: 'Search conversations', sub: 'type ? followed by words — every session, both accounts', icon: '🔍', hay: 'search conversations transcripts find', run: () => setTimeout(() => openPalette('search'), 0), rank: 27 },
    { kind: 'action', label: 'Projects', sub: 'all projects, filters, search  (p)', icon: '▤', hay: 'projects view page', run: () => setView('projects'), rank: 29 },
    { kind: 'action', label: 'Home', sub: 'stats · agents · running  (h)', icon: '⌂', hay: 'home dashboard', run: () => setView('home'), rank: 28 });
  if ((S.claude?.restorable || []).length) items.push({ kind: 'action', label: 'Restore Claude sessions', sub: `${S.claude.restorable.length} from before the restart`, icon: '↺', hay: 'restore claude sessions resume', run: () => act('Restore all', api('claude-restore', {})), rank: 0 });
  const score = it => { if (!q) return 0; const hay = it.hay.toLowerCase(); if (hay.includes(q)) return 1; const w = q.split(/\s+/); return w.every(x => hay.includes(x)) ? 2 : (fuzzy(it.label.toLowerCase(), q) ? 3 : 0); };
  return items.map((it, i) => ({ ...it, s: score(it), i })).filter(it => !q || it.s).sort((a, b) => (q ? a.s - b.s : 0) || a.rank - b.rank || a.i - b.i).slice(0, 40);
}
function fuzzy(hay, q) { let i = 0; for (const c of hay) if (c === q[i]) i++; return i === q.length; }
function openPalette(mode) { if (!PAL.open) pushLayer('palette'); PAL.open = true; PAL.q = mode === 'search' ? '? ' : ''; PAL.idx = 0; $('#palette').classList.remove('hidden'); renderPalette(); setTimeout(() => { const i = $('#pal-in'); if (i) { i.value = PAL.q; i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }
// "? words" in the palette = search every conversation (both accounts) for those words
let searchTimer = null, searchRes = null, searchQ = '';
function paletteSearch(q) {
  if (q === searchQ) return; searchQ = q; clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => { try { searchRes = await api('search?q=' + encodeURIComponent(q)); } catch (e) { searchRes = { hits: [], error: e.message }; } if (PAL.open) renderPalette(); }, 250);
}
function searchItems() {
  const q = PAL.q.slice(1).trim(); if (q.length < 2) return [{ kind: 'hint', label: 'Search conversations', sub: 'type at least 2 characters — searches every session of both accounts', icon: '🔍', run: () => {} }];
  paletteSearch(q); if (!searchRes || searchRes.q !== q) return [{ kind: 'hint', label: 'searching…', sub: '', icon: '🔍', run: () => {} }];
  if (searchRes.error) return [{ kind: 'hint', label: searchRes.error, sub: '', icon: '⚠', run: () => {} }];
  if (!searchRes.hits.length) return [{ kind: 'hint', label: 'no matches for "' + q + '"', sub: '', icon: '🔍', run: () => {} }];
  const liveBySid = {}; for (const x of S.runtime.sessions) if (x.claude?.sessionId) liveBySid[x.claude.sessionId] = x.name;
  return searchRes.hits.map(hh => ({ kind: 'hit', label: (hh.title || (hh.cwd || '').split('/').pop() || hh.sessionId.slice(0, 8)), sub: (hh.role === 'user' ? '❯ ' : '✦ ') + hh.snippet, tag: hh.account, icon: liveBySid[hh.sessionId] ? '●' : '○', extra: (hh.cwd || '').replace(/^\/home\/[^/]+\//, '~/') + ' · ' + ago(hh.ts || hh.mtime) + ' ago', run: () => { const live = liveBySid[hh.sessionId]; if (live) openSession(live, 'transcript'); else openTranscriptFile(hh); } }));
}
function closePalette(pop = true) { if (!PAL.open) return; PAL.open = false; $('#palette').classList.add('hidden'); if (pop) popLayer(); }
function renderPalette() {
  const m = $('#palette'); if (!m.querySelector('#pal-in')) {
    const inp = h('input', { id: 'pal-in', placeholder: 'Jump to a session or project… (↑↓ Enter · Esc)', autocomplete: 'off' });
    inp.addEventListener('input', () => { PAL.q = inp.value; PAL.idx = 0; renderPalette(); });
    inp.addEventListener('keydown', e => {
      const items = PAL.q.startsWith('?') ? searchItems() : paletteItems();
      if (e.key === 'ArrowDown') { e.preventDefault(); PAL.idx = Math.min(items.length - 1, PAL.idx + 1); renderPalette(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); PAL.idx = Math.max(0, PAL.idx - 1); renderPalette(); }
      else if (e.key === 'Enter') { e.preventDefault(); const it = items[PAL.idx]; if (it) { closePalette(); it.run(); } }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    });
    m.append(h('div', { class: 'pal', onclick: ev => ev.stopPropagation() }, inp, h('div', { id: 'pal-list' })));
    m.onclick = () => closePalette();
  }
  const list = $('#pal-list'); list.innerHTML = ''; const items = PAL.q.startsWith('?') ? searchItems() : paletteItems();
  if (!items.length) { list.append(h('div', { class: 'pi dim' }, 'nothing matches')); return; }
  items.forEach((it, i) => list.append(h('div', { class: 'pi ' + it.kind + (i === PAL.idx ? ' on' : '') + (it.cls ? ' ' + it.cls : ''), onmousemove: () => { if (PAL.idx !== i) { PAL.idx = i; renderPalette(); } }, onclick: () => { closePalette(); it.run(); } },
    h('span', { class: 'ico' }, it.icon), h('span', { class: 'k' }, it.label, it.tag ? h('span', { class: 'badge tag acc ' + it.tag }, it.tag) : null), h('span', { class: 'c' + (it.kind === 'hit' ? ' wrap' : '') }, it.sub || '', it.extra ? h('span', { class: 'dim', style: 'display:block;font-size:11px' }, it.extra) : null),
    it.more ? h('span', { class: 'more' }, it.more.map(mm => h('button', { class: 'btn sm ghost', title: mm.t, onclick: ev => { ev.stopPropagation(); closePalette(); mm.f(); } }, mm.l))) : null)));
  const on = list.querySelector('.pi.on'); if (on) on.scrollIntoView({ block: 'nearest' });
}

// ---------- push notifications (needs HTTPS: service workers only register on a secure origin) ----------
const PUSH = { supported: 'serviceWorker' in navigator && 'PushManager' in window && (location.protocol === 'https:' || location.hostname === 'localhost'), sub: null };
async function pushStatus() { if (!PUSH.supported) return null; try { const reg = await navigator.serviceWorker.getRegistration('/'); PUSH.sub = reg ? await reg.pushManager.getSubscription() : null; return PUSH.sub; } catch { return null; } }
async function enablePush() {
  if (!PUSH.supported) { toast('Push needs HTTPS — see README (tailscale serve).', 'err'); return; }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const perm = await Notification.requestPermission(); if (perm !== 'granted') { toast('notifications blocked in the browser', 'err'); return; }
    const { key } = await api('push/key');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)) });
    await api('push-subscribe', { subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 80) });
    PUSH.sub = sub; toast('push enabled on this device', 'ok');
  } catch (e) { toast('push failed: ' + e.message, 'err'); }
}
async function disablePush() { const sub = await pushStatus(); if (sub) { await api('push-unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); PUSH.sub = null; toast('push disabled on this device'); } }

// ---------- first state: ?term=<session> (push notification click) opens that terminal ----------
let firstDone = false;
function firstState() {
  if (firstDone) return; firstDone = true;
  const q = new URLSearchParams(location.search); const t = q.get('term'); const sess = q.get('session');
  if (t) { history.replaceState(null, '', location.pathname); if (q.get('mode') === 'chat') { TERM.mode = 'chat'; localStorage.setItem('bd.mode', 'chat'); } openTerm(t); }
  else if (sess) { history.replaceState(null, '', location.pathname); openSession(sess, q.get('tab') || 'transcript'); }
  else if (['projects', 'home', 'tasks'].includes(q.get('view'))) { history.replaceState(null, '', location.pathname); setView(q.get('view')); }
  else if (q.get('newtask')) { history.replaceState(null, '', location.pathname); setView('tasks'); taskModal(null, q.get('newtask') === '1' ? null : q.get('newtask')); }
  else if (q.get('settings')) { history.replaceState(null, '', location.pathname); settingsModal(); }
  else if (q.get('schedule')) { history.replaceState(null, '', location.pathname); scheduleDialog(q.get('schedule'), ''); }
  pushStatus();
}
connect();
$('#btn-palette').onclick = () => openPalette();
