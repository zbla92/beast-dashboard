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
const ORG_CSS = /^(#[0-9a-f]{3,8}|var\(--[\w-]+\))$/i;
const orgColor = o => { if (!o) return 'var(--org-default)'; const c = S.settings?.orgColors?.[o]; if (typeof c === 'string' && ORG_CSS.test(c)) return c; let n = 0; for (let i = 0; i < o.length; i++) n = (n * 31 + o.charCodeAt(i)) >>> 0; return `var(--org-${n % ORG_COLORS + 1})`; };
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
  const glyph = () => { if (!g.svg) return h('span', { class: 'g' }, g.t); const w = h('span', { class: 'g' }); w.innerHTML = g.svg; return w; };
  const src = p && (p.icon || (p.tech && p.tech !== 'other' ? `/icons/tech-${p.tech}.svg` : null));
  if (src) { el.classList.add(p.icon ? 'pic' : 'tech'); el.append(h('img', { class: 'gi', src, alt: '', draggable: 'false', onerror: e => { el.classList.remove('pic', 'tech'); e.target.replaceWith(glyph()); } })); }
  else el.append(glyph());
  if (org) el.append(h('i', { class: 'oi' }, org[0].toUpperCase()));
  return el;
}

// ---------- state ----------
const S = { projects: [], runtime: { sessions: [], external: [], containers: [], recent: [], exposures: [], otherPorts: [] }, settings: {}, host: {}, stats: null, hist: { cpu: [], mem: [], gpu: [], net: [], t: [] } };
const UI = { view: localStorage.getItem('bd.view') || 'home', q: '', filter: 'all', drawer: null, tab: 'overview', logTarget: null, showTunnels: false, menuOpen: false, follow: true, logSrc: null, collapsed: JSON.parse(localStorage.getItem('bd.collapsed') || '{}') };

// ---------- api ----------
async function api(path, body) {
  const r = await fetch('/api/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : (AbortSignal.timeout ? { signal: AbortSignal.timeout(30000) } : {}));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || j.out || r.statusText), { status: r.status });
  return j;
}
function toast(msg, kind = '') { const t = h('div', { class: 'toast ' + kind }, msg); $('#toasts').append(t); setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(() => t.remove(), 300); }, kind === 'err' ? 7000 : 3500); }
async function act(label, p) { try { const r = await p; toast(label + (r?.out ? '\n' + r.out.split('\n').slice(-3).join('\n') : ''), 'ok'); return r; } catch (e) { toast(label + ' failed: ' + e.message, 'err'); throw e; } }

// ---------- feature modules (public/f-*.js, ) ----------
// Each f-<name>.js registers FEAT.<name> = { hooks }. app.js calls a hook on every feature that has it, in load order;
// an exception in one feature is logged and skipped, so a broken feature never takes the dashboard down.
const FEAT = {};
function feat(hook, ...a) {
  const out = [];
  for (const [name, f] of Object.entries(FEAT)) {
    if (!f || typeof f[hook] !== 'function') continue;
    try { const r = f[hook](...a); if (r != null && r !== false) out.push(...(Array.isArray(r) ? r : [r])); } catch (e) { console.error('feature', name, hook, e); }
  }
  return out.filter(x => x != null && x !== false);
}

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
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  ext: '<path d="M7 17 17 7M9 7h8v8"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 7A8 8 0 1 0 17.7 7"/>',
  clip: '<path d="m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.3 3.3 0 0 1 4.7 4.7L10.5 18a1.7 1.7 0 0 1-2.4-2.4L16 7.7"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  sched: '<circle cx="12" cy="12" r="7.5"/><path d="M12 8.5V12l2.2 1.4"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  compact: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
  log: '<path d="M8 6h12M8 12h12M8 18h8M4 6h.01M4 12h.01M4 18h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.6"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  play: '<path d="M7 4.8v14.4a1 1 0 0 0 1.5.9l11.3-7.2a1 1 0 0 0 0-1.8L8.5 3.9A1 1 0 0 0 7 4.8z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9a6 6 0 0 1-6 6H6"/>',
  sparkle: '<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z"/><path d="M19 16.5c.2 1.3.9 2 2.2 2.2-1.3.2-2 .9-2.2 2.2-.2-1.3-.9-2-2.2-2.2 1.3-.2 2-.9 2.2-2.2z"/>',
  hourglass: '<path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9"/>',
  pin: '<path d="M9 4h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 15v6"/>',
  alert: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 13.5l5-5 5 5M5 4h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>',
  checkSquare: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m8 12.3 2.8 2.8L16.5 9.4"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  swap: '<path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.3 9.6 4.5 4.5 0 0 0 7 18.5z"/>',
  home: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19z"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="3"/><path d="M11 18.5h2"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  fileText: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  zap: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  layers: '<path d="m12 4 9 4.5-9 4.5-9-4.5z"/><path d="m3 12.5 9 4.5 9-4.5M3 16.5l9 4.5 9-4.5"/>',
  folderOpen: '<path d="M3 18V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1.5"/><path d="M3 18l2.6-6.4A1.5 1.5 0 0 1 7 10.6h13.3a1 1 0 0 1 .9 1.4L18.6 18.7a1.5 1.5 0 0 1-1.4.9H4.5A1.5 1.5 0 0 1 3 18z"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="3"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14.2h8"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  prompt: '<path d="m5 7 5 5-5 5M12 18h7"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
  flame: '<path d="M12 21a6.5 6.5 0 0 0 6.5-6.5c0-3.6-2.3-5.8-4-8.5-.4 2-1.4 3.3-2.8 4C11.7 7 10.3 4.8 8 3.2 8.4 7 5.5 9.6 5.5 14.5A6.5 6.5 0 0 0 12 21z"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M8.6 14.8A6 6 0 1 1 15.4 14.8c-.8.6-1.4 1.6-1.4 2.6v.6h-4v-.6c0-1-.6-2-1.4-2.6z"/>',
  hammer: '<path d="m14.5 5.5 4 4M3.5 20.5l9.5-9.5M11 7.5l3-3a2.2 2.2 0 0 1 3 0l3.5 3.5-3 3-1.5-1.5-3 3-3-3z"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  diamond: '<path d="M12 3 21 12l-9 9-9-9z"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  brain: '<path d="M12 5.5a3 3 0 0 0-5.6-1.5A3 3 0 0 0 4 8a3 3 0 0 0-1 5 3.5 3.5 0 0 0 3 5.2A3 3 0 0 0 12 19.5z"/><path d="M12 5.5a3 3 0 0 1 5.6-1.5A3 3 0 0 1 20 8a3 3 0 0 1 1 5 3.5 3.5 0 0 1-3 5.2 3 3 0 0 1-6 1.3z"/><path d="M12 5.5v14M8 9.5c1 0 2 .7 2 2M16 9.5c-1 0-2 .7-2 2M8.5 15c.9-.4 1.6-.4 2.5 0M15.5 15c-.9-.4-1.6-.4-2.5 0"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  minus: '<path d="M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5s1.2-6.1 3.6-8.5z"/>',
};
function ico(name, size = 15) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  e.setAttribute('viewBox', '0 0 24 24'); e.setAttribute('width', size); e.setAttribute('height', size); e.setAttribute('fill', 'none'); e.setAttribute('stroke', 'currentColor'); e.setAttribute('stroke-width', '1.75'); e.setAttribute('stroke-linecap', 'round'); e.setAttribute('stroke-linejoin', 'round'); e.setAttribute('class', 'ico ico-' + name); e.setAttribute('aria-hidden', 'true');
  e.innerHTML = ICONS[name] || ''; return e;
}
const GLYPH = {
  '⚙': 'gear', '🐳': 'box', '▶': 'play', '■': 'stop', '⌨': 'keyboard', '☰': 'menu', '≡': 'menu', '↻': 'refresh', '↺': 'undo', '⎇': 'branch',
  '✦': 'sparkle', '⏳': 'hourglass', '📌': 'pin', '⚠': 'alert', '✕': 'x', '✗': 'x', '✓': 'check', '✎': 'pencil', '⬇': 'download', '⇩': 'download',
  '⇣': 'download', '↓': 'arrowDown', '↑': 'arrowUp', '⬆': 'upload', '→': 'arrowRight', '🔍': 'search', '⌕': 'search', '☑': 'checkSquare', '▤': 'grid', '⎘': 'copy',
  '⧉': 'layers', '↗': 'ext', '☾': 'moon', '⇄': 'swap', '⊘': 'ban', '☁': 'cloud', '⋯': 'dots', '◇': 'diamond', '◆': 'zap', '◈': 'chip',
  '⌂': 'home', '⛶': 'full', '📱': 'phone', '🖼': 'image', '◱': 'file', '📂': 'folderOpen', '📁': 'folder', '❯': 'prompt', '$': 'prompt', '★': 'star',
  '🔥': 'flame', '💡': 'bulb', '⚒': 'hammer', '⏰': 'clock', '−': 'minus', 'ⓘ': 'info', '+': 'plus',
};
const gico = (g, size = 15) => { const k = typeof g === 'string' ? GLYPH[g.trim()] || (ICONS[g] ? g : null) : null; return k ? ico(k, size) : g; };
function gl(label, size = 14) {
  if (typeof label !== 'string') return [label];
  const m = label.match(/^(\S+)(\s+)(.*)$/s), k = m && GLYPH[m[1]];
  if (k) return m[3] ? [ico(k, size), h('span', {}, m[3])] : [ico(k, size), m[2]];
  return GLYPH[label.trim()] ? [ico(GLYPH[label.trim()], size)] : [label];
}
// Terminal / Chat is ONE global switch for this device (Mac, phone …): every Claude session shows the same way.
const IS_PHONE = matchMedia('(max-width: 900px)').matches;
const TERM = { open: false, active: null, frames: new Map(), lastUsed: new Map(), showList: false, listKey: '', mode: localStorage.getItem('bd.mode') ? (localStorage.getItem('bd.mode') === 'chat' ? 'chat' : 'term') : (IS_PHONE ? 'chat' : 'term'), view: {}, forceTerm: new Set(), chatEv: {}, chatN: 40 };
let CLAUDE_UPGRADING = false;   // mise upgrade claude in flight (see updateClaude)
const isChatSess = name => (claudeOf(name) || {}).mode === 'chat';
const chatMode = name => { const cl = claudeOf(name); if (!cl) return false; return cl.mode === 'chat' ? TERM.view[name] !== 'term' : !TERM.forceTerm.has(name) && TERM.mode === 'chat'; };
// Focus: hide the session list in the terminal panel (screen sharing) — per device, remembered
TERM.focus = localStorage.getItem('bd.focus') === '1' && !IS_PHONE;   // focus mode is a desktop thing; on the phone the list must always be reachable
function setFocus(on) { TERM.focus = on; localStorage.setItem('bd.focus', on ? '1' : '0'); document.body.classList.toggle('focus', on); renderTermPanel(true); }
function setMode(mode) { if (TERM.active && isChatSess(TERM.active)) TERM.view[TERM.active] = mode; else { TERM.forceTerm.delete(TERM.active); TERM.mode = mode; localStorage.setItem('bd.mode', mode); } renderTermPanel(true); renderChatPane(true); if (mode === 'term') { const f = TERM.frames.get(TERM.active); if (f) setTimeout(() => f.focus(), 50); } }
// Chat mode for the active session: the conversation view in place of the tmux iframe (same tmux session underneath)
async function renderChatPane(force) {
  const pane = $('#term-chat'); if (!pane) return; const name = TERM.active; const on = TERM.open && name && chatMode(name);
  liveStream(liveWanted());
  pane.classList.toggle('hidden', !on); const f = name && TERM.frames.get(name); if (f) f.classList.toggle('on', !on && f.classList.contains('on'));
  if (!on) return;
  if (pane.dataset.name !== name) { pane.innerHTML = ''; pane.append(h('div', { class: 'dim', style: 'padding:20px' }, 'loading…')); pane.dataset.name = name; TERM.chatEv.key = ''; }
  if (TERM.chatEv.inflight && !force) return;
  const req = TERM.chatEv.req = (TERM.chatEv.req || 0) + 1; TERM.chatEv.inflight = req;
  const t = await transcriptOf(name, TERM.chatN);
  if (TERM.chatEv.inflight === req) TERM.chatEv.inflight = 0;
  if (req !== TERM.chatEv.req || TERM.active !== name) return;
  chatOffline(pane, !t); if (!t) return;
  if (document.body.classList.contains('recording')) return;   // never rebuild the reply box under a running recording; the next poll catches up
  const cl = claudeOf(name) || {}; const key = [name, t.sig, t.total, cl.state, cl.lastTool, TERM.chatN, (PENDING[name] || []).length, queuedKey(name), (cl.status || '').split(' (')[0], t.pending || '', menuKey(cl.menu), liveKey(name), cl.ask ? cl.ask.rid : ''].join(':');
  if (!force && TERM.chatEv.key === key) { const st = pane.querySelector('.ag-status'); if (st && cl.status) st.textContent = cl.status; return; }   // same turn: just tick Claude's status line
  TERM.chatEv.key = key;
  renderConversation(pane, name, t, { n: TERM.chatN, more: () => { TERM.chatN = Math.min(200, TERM.chatN * 2); renderChatPane(true); }, refresh: () => renderChatPane(false) });
}
const HL = { name: null, es: null, snap: null, timer: 0, seen: new Set() };
function liveWanted() {
  if (document.hidden) return null;
  const n = TERM.active; if (TERM.open && n && chatMode(n) && isChatSess(n)) return n;
  const d = UI.drawer === 'session:' + SESS.name && SESS.tab === 'transcript' ? SESS.name : null;
  return d && isChatSess(d) ? d : null;
}
const liveRender = force => { renderChatPane(force); if (HL.name && UI.drawer === 'session:' + HL.name && SESS.name === HL.name) renderSessionDrawer(false); };
function liveStream(name) {
  if (HL.name === name) return;
  if (HL.es) HL.es.close();
  clearTimeout(HL.timer);
  Object.assign(HL, { name, es: null, snap: null, timer: 0, seen: new Set() });
  if (!name) return;
  const es = HL.es = new EventSource('/api/hl-live/' + encodeURIComponent(name));
  const on = (ev, fn) => es.addEventListener(ev, e => { if (HL.es !== es) return; let o; try { o = JSON.parse(e.data); } catch { return; } fn(o); });
  const turn = () => { if (!HL.snap) HL.snap = { state: 'working', pending: [] }; if (!HL.snap.turn) HL.snap.turn = { startedAt: (HL.snap.state === 'working' && HL.snap.since) || Date.now(), text: '', tools: [] }; return HL.snap.turn; };
  const saw = list => { for (const m of list) HL.seen.add(m.id); };
  on('snapshot', o => { HL.snap = { ...o, pending: o.pending || [], inbox: o.inbox || [] }; saw(HL.snap.inbox); liveRender(true); });
  on('inbox', o => { if (!HL.snap) HL.snap = { pending: [] }; const gone = (HL.snap.inbox || []).some(m => !o.inbox.some(x => x.id === m.id)); HL.snap.inbox = o.inbox || []; saw(HL.snap.inbox); liveRender(false); if (gone) setTimeout(() => liveRender(false), 900); });
  on('gone', () => { if (HL.snap) HL.snap.stale = true; });
  on('delta', o => { const t = turn(); if (t.text.length < 200 * 1024) t.text += o.text; paintLive(); });
  on('block', () => { const t = HL.snap && HL.snap.turn; if (t && t.text) t.text += '\n\n'; });
  on('tool', o => { turn().tools.push({ id: o.id, name: o.name, what: o.what, done: false, at: o.at || Date.now() }); paintLive(); });
  on('tool-done', o => { const x = HL.snap && HL.snap.turn && HL.snap.turn.tools.find(y => y.id === o.id); if (x) { x.done = true; x.error = !!o.error; } paintLive(); });
  on('pending', o => { if (!HL.snap) HL.snap = { pending: [] }; HL.snap.pending = [...HL.snap.pending.filter(x => x.rid !== o.req.rid), o.req]; liveRender(false); });
  on('resolved', o => { if (HL.snap) HL.snap.pending = HL.snap.pending.filter(x => x.rid !== o.rid); liveRender(false); });
  on('state', o => { if (!HL.snap) HL.snap = { pending: [] }; HL.snap.state = o.state; HL.snap.since = o.since; if (o.state !== 'working') { HL.snap.pending = []; HL.snap.turn = null; } liveRender(false); });
  on('result', () => { if (HL.snap) HL.snap.turn = null; liveRender(false); });
  es.addEventListener('error', () => { if (HL.es === es && es.readyState === EventSource.CLOSED) setTimeout(() => { if (HL.es === es && !document.hidden) { HL.name = null; liveStream(name); } }, 2000); });
}
const liveOf = name => HL.name === name && HL.snap ? HL.snap : null;
const turnAt = lv => !lv ? 0 : lv.state === 'working' && lv.since ? lv.since : lv.turn ? lv.turn.startedAt : 0;
const waitingIn = lv => turnAt(lv) ? (lv.inbox || []).filter(m => m.at > turnAt(lv) + 1500) : [];
function liveKey(name) { const l = liveOf(name); return l ? [l.state, l.turn ? 1 : 0, l.pending.map(x => x.rid).join(','), l.error || '', (l.inbox || []).map(x => x.id).join(',')].join('/') : ''; }
function paintLive() {
  if (HL.timer) return;
  HL.timer = setTimeout(() => {
    HL.timer = 0; const els = [...document.querySelectorAll('[data-chat] .turn.live')].filter(el => el.closest('[data-chat]').dataset.chat === HL.name && el.querySelector('.ltext'));
    if (els.length) for (const el of els) fillLive(el, HL.snap && HL.snap.turn); else liveRender(false);
  }, 80);
}
function fillLive(el, turn) {
  const tx = el.querySelector('.ltext'), tl = el.querySelector('.ltools'), now = el.querySelector('.ag-now .mono');
  const text = turn ? turn.text : '', tools = turn ? turn.tools : [];
  if (tx._t !== text) { tx._t = text; tx.innerHTML = text ? mdLite(text) : ''; tx.classList.toggle('hidden', !text); }
  const tk = tools.map(t => t.id + (t.done ? (t.error ? 'x' : 'd') : '')).join(',');
  if (tl._k !== tk) {
    tl._k = tk; const shown = tools.slice(-6);
    tl.replaceChildren(...(tools.length > shown.length ? [h('div', { class: 'ltool dim' }, `+${tools.length - shown.length} earlier`)] : []),
      ...shown.map(t => h('div', { class: 'ltool' + (t.done ? ' done' : '') + (t.error ? ' bad' : '') }, t.done ? h('span', { class: 'ic' }, ico(t.error ? 'x' : 'check', 12)) : h('span', { class: 'spin' }), h('span', { class: 'mono' }, t.what || t.name))));
  }
  if (now) {
    const running = tools.filter(t => !t.done); const cur = running[running.length - 1];
    const label = cur ? (cur.what || cur.name) + (running.length > 1 ? `  +${running.length - 1} more` : '') : text ? 'writing…' : 'thinking…';
    if (now.textContent !== label) now.textContent = label;
    let tm = now.parentElement.querySelector('.ag-t'); if (!tm) now.parentElement.append(tm = h('span', { class: 'dim mono ag-t' }));
    if (cur && cur.at) { if (tm.dataset.since !== String(cur.at)) { tm.dataset.since = cur.at; tm.classList.add('wtimer'); tm.textContent = elapsedTxt(cur.at); } }
    else if (tm.dataset.since || tm.textContent) { delete tm.dataset.since; tm.classList.remove('wtimer'); tm.textContent = ''; }
    now.parentElement.classList.remove('hidden');
  }
  const sc = el.closest('.cscroll'); if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight;
}
const ASKC = { rid: null, el: null };
function askCard(name, req, done) {
  if (ASKC.rid === req.rid && ASKC.el) return ASKC.el;
  let sending = false, card;
  const reply = async (decision, answers, message) => {
    if (sending) return; sending = true; card.classList.add('busy');
    try { await api('hl-answer', { session: name, rid: req.rid, decision, answers, message }); } catch (e) { toast(e.message, 'err'); sending = false; card.classList.remove('busy'); return; }
    done();
  };
  if (req.kind !== 'question') {
    card = h('div', { class: 'turn assistant cmenu ask' }, h('div', { class: 'who' }, '⚠ Claude wants to use ' + (req.tool || 'a tool')), h('div', { class: 'cmenu-q mono' }, req.what || req.tool || ''),
      h('div', { class: 'askrow' }, h('button', { class: 'btn sm primary', onclick: () => reply('allow') }, 'Allow'), h('button', { class: 'btn sm', onclick: () => reply('deny', null, 'The user denied this.') }, 'Deny')));
  } else {
    const qs = req.questions || []; const picked = qs.map(() => new Set()); const other = qs.map(() => '');
    const instant = qs.length === 1 && !qs[0].multiSelect;
    const answersOf = () => Object.fromEntries(qs.map((q, i) => [q.question, [...picked[i], other[i].trim()].filter(Boolean).join(', ')]));
    const ready = () => qs.every((q, i) => picked[i].size || other[i].trim());
    const submit = instant ? null : h('button', { class: 'btn sm primary', disabled: true, onclick: () => { if (ready()) reply('allow', answersOf()); } }, 'Send answers');
    const sync = () => { if (submit) submit.disabled = !ready(); };
    const blocks = qs.map((q, i) => {
      const btns = (q.options || []).map(o => {
        const b = h('button', { class: 'btn sm cmenu-opt askopt', title: o.description || '', onclick: () => {
          if (instant) { picked[i] = new Set([o.label]); return reply('allow', answersOf()); }
          if (picked[i].has(o.label)) picked[i].delete(o.label); else { if (!q.multiSelect) picked[i].clear(); picked[i].add(o.label); }
          for (const x of btns) x.classList.toggle('cur', picked[i].has(x._label)); sync();
        } }, h('b', null, o.label), o.description ? h('span', { class: 'dim' }, o.description) : null);
        b._label = o.label; return b;
      });
      const inp = h('input', { class: 'txt askother', placeholder: 'Other…', oninput: e => { other[i] = e.target.value; sync(); }, onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter' && ready()) reply('allow', answersOf()); } });
      return h('div', { class: 'askq' }, h('div', { class: 'cmenu-q' }, q.header ? h('span', { class: 'ag-tag' }, q.header) : null, ' ', q.question, q.multiSelect ? h('span', { class: 'dim' }, '  (pick any)') : null), h('div', { class: 'cmenu-opts' }, btns), inp);
    });
    card = h('div', { class: 'turn assistant cmenu ask' }, h('div', { class: 'who' }, gl('⚠ Claude is asking')), ...blocks,
      h('div', { class: 'askrow' }, submit, h('button', { class: 'btn sm ghost', onclick: () => reply('deny', null, 'The user dismissed the question without answering.') }, 'Skip')));
  }
  Object.assign(ASKC, { rid: req.rid, el: card });
  return card;
}
// Poll while a conversation is on screen (panel chat or session drawer): the transcript grows while Claude writes
// text, and no hook fires for that — 2 s is fast enough to feel live and cheap (a tail read of one file).
setInterval(() => {
  if (document.hidden) return;
  if (TERM.open && TERM.active && chatMode(TERM.active)) renderChatPane(false);
  if (UI.drawer && String(UI.drawer).startsWith('session:') && SESS.tab === 'transcript') renderSessionDrawer(false);
}, 2000);
document.addEventListener('visibilitychange', () => { if (document.hidden) liveStream(null); if (!document.hidden) { renderChatPane(false); if (UI.drawer && String(UI.drawer).startsWith('session:')) renderSessionDrawer(false); } });
const FRAME_IDLE_MS = 10 * 60e3;   // hidden iframes are dropped after this: each one is a tmux client fighting over the pane size
function openTerm(session) {
  if (!TERM.open) pushLayer('term');
  if (TERM.active) TERM.lastUsed.set(TERM.active, Date.now());
  TERM.open = true; TERM.showList = false; ensureFrame(session); TERM.active = session; TERM.lastUsed.set(session, Date.now());
  const cl = claudeOf(session); if (cl && (cl.state === 'needs-you' || cl.state === 'error')) api('claude-seen', { session }).catch(() => {});
  renderTermPanel(true); renderChatPane(true); renderRail();
  const f = TERM.frames.get(session); if (f && !chatMode(session)) setTimeout(() => f.focus(), 50);   // focus ONLY here, never on a state tick
}
function openTermTab(session) { window.open(termUrl(session), '_blank'); }
// phone bugs are invisible from the desk: ship JS errors (with what was open) to the server journal, a few per minute at most
let clientLogN = 0; setInterval(() => { clientLogN = 0; }, 60000);
function clientLog(msg) {
  if (clientLogN++ > 5) return;
  const where = `view=${UI.view} term=${TERM.open} list=${TERM.showList} mode=${TERM.mode} active=${TERM.active} drawer=${UI.drawer} modal=${!$('#modal').classList.contains('hidden')} vv=${window.visualViewport ? Math.round(window.visualViewport.height) + '/' + Math.round(window.visualViewport.offsetTop) : '-'} standalone=${!!navigator.standalone}`;
  try { navigator.sendBeacon ? navigator.sendBeacon('/api/clientlog', new Blob([JSON.stringify({ ua: navigator.userAgent, msg, where })], { type: 'application/json' })) : fetch('/api/clientlog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ua: navigator.userAgent, msg, where }) }); } catch {}
}
window.addEventListener('error', e => clientLog(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => clientLog('rejection: ' + (e.reason && (e.reason.stack || e.reason.message || e.reason))));
// the files on the server changed: reload now unless the user is typing (then a banner offers it)
function newBuild() { reloadPending = true; maybeReload(); }
let reloadPending = false;
function contextUrl() { const u = new URL(location.href); if (TERM.open && TERM.active) u.search = '?term=' + encodeURIComponent(TERM.active) + (TERM.mode === 'chat' ? '&mode=chat' : ''); else if (UI.view !== 'home') u.search = '?view=' + UI.view; else u.search = ''; return u.href; }
function maybeReload() {
  if (safeToReload()) { try { sessionStorage.setItem('bd.updated', '1'); } catch {} location.replace(contextUrl()); return; }
  if (!$('#newbuild')) document.body.append(h('button', { id: 'newbuild', class: 'btn primary', onclick: () => location.replace(contextUrl()) }, ico('refresh', 14), 'Dashboard updated — reload'));
}
function closeTermPanel(pop = true) { if (!TERM.open) return; if (TERM.active) TERM.lastUsed.set(TERM.active, Date.now()); TERM.open = false; renderTermPanel(); renderRail(); if (pop) popLayer(); if (TOUCH) requestAnimationFrame(() => window.scrollTo(0, TERM.pageY || 0)); }
// iOS: with the keyboard up, a touch-scroll on anything that is not itself scrollable moves the whole page under the
// fixed panel (the "content behind" scroll). Only the chat list, the session list and textareas may scroll.
document.addEventListener('touchmove', e => {
  if (!TERM.open) return;
  const ok = e.target.closest && e.target.closest('.cscroll, #term-list, .termside, .rail-list, textarea, .tsel, .chpath, .modal .box, .drawer, .sbody, .logbox, .peek-b, .recov-text');
  if (!ok) e.preventDefault();
}, { passive: false });
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
// "+ Terminal": pick a project, account (personal/company) and fresh/resume-last → Claude session in that project;
// or skip the project and start a plain bash shell. Choices are remembered.
const NT = { acct: localStorage.getItem('bd.nt.acct') || 'personal', kind: localStorage.getItem('bd.nt.kind') === 'chat' ? 'chat' : 'term', resume: localStorage.getItem('bd.nt.resume') === '1', q: '', org: 'all' };
function newTerminalModal() {
  const m = $('#modal'); m.classList.remove('hidden');
  const close = () => { m.classList.add('hidden'); document.removeEventListener('keydown', esc, true); };
  const esc = e => { if (e.key === 'Escape' && !m.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  NT.q = ''; const list = h('div', { class: 'ntlist' }); const opts = h('div', { class: 'ntopts' });
  const seg = (items, cur, set) => h('span', { class: 'seg' }, items.map(([v, l]) => h('button', { class: 'segb' + (cur === v ? ' on' : ''), onclick: () => { set(v); renderOpts(); renderList(); } }, l)));
  const renderOpts = () => opts.replaceChildren(
    h('span', { class: 'ntl' }, 'Type'), seg([['term', 'Terminal'], ['chat', 'Chat']], NT.kind, v => { NT.kind = v; localStorage.setItem('bd.nt.kind', v); }),
    h('span', { class: 'ntl' }, 'Account'), seg([['personal', acct('personal')], ['company', acct('company')]], NT.acct, v => { NT.acct = v; localStorage.setItem('bd.nt.acct', v); }),
    ...(NT.kind === 'chat' ? [h('span', { class: 'ntl' }, 'Session'), h('span', { class: 'dim', style: 'font-size:12px' }, 'new conversation · headless claude -p')] : [h('span', { class: 'ntl' }, 'Session'), seg([[false, 'New'], [true, 'Resume last']], NT.resume, v => { NT.resume = v; localStorage.setItem('bd.nt.resume', v ? '1' : '0'); })]));
  const baseName = p => 'claude-' + p.dirName.replace(/[^A-Za-z0-9_.-]+/g, '-') + (NT.acct === 'company' ? '-company' : '');
  const runningOn = p => S.runtime.sessions.filter(x => x.project === p.id && isClaudeSession(x) && (x.name.endsWith('-company') ? 'company' : 'personal') === NT.acct);
  const go = p => { close(); if (NT.kind === 'chat') return startClaude(p, NT.acct, { mode: 'chat' }); startClaude(p, NT.acct, NT.resume ? { resume: true } : S.runtime.sessions.some(x => x.name === baseName(p)) ? { fresh: true } : {}); };
  const shown = () => { const q = NT.q.trim().toLowerCase(); return S.projects.filter(p => !p.hidden && (NT.org === 'all' || p.org === NT.org) && (!q || [p.name, p.org, p.dirName, p.group].join(' ').toLowerCase().includes(q))); };
  const renderList = () => {
    const r = shown(); const live = new Set(S.runtime.sessions.map(x => x.name));
    const onRow = p => {
      const resume = NT.resume && NT.kind === 'term';
      const on = runningOn(p); if (!on.length) return resume ? h('span', { class: 'dim', style: 'font-size:11.5px' }, gl('↺ --continue')) : null;
      if (resume && live.has(baseName(p))) return h('span', { class: 'badge tag acc ' + NT.acct }, 'running → attach');
      return h('span', { class: 'ntrun' }, h('span', { class: 'badge tag acc ' + NT.acct }, `${on.length} running · ＋ new`), h('button', { class: 'btn sm ghost', title: 'open the running one instead: ' + on.map(x => x.name).join(', '), onclick: ev => { ev.stopPropagation(); close(); openTerm(on[0].name); } }, 'open'));
    };
    list.replaceChildren(...(r.length ? r.map(p => h('div', { class: 'ntrow', onclick: () => go(p) }, avatar(p.id, 'sm'), h('div', { class: 'ntn' }, h('div', { class: 'ntt' }, p.name), h('div', { class: 'nts' }, [p.org, p.group].filter(Boolean).join(' · '))), FEAT.worktrees?.pickerChip?.(p), onRow(p))) : [h('div', { class: 'tsempty' }, 'No project matches.')]));
  };
  const orgs = [...new Set(S.projects.filter(p => !p.hidden).map(p => p.org).filter(Boolean))];
  const orgChips = h('span', { class: 'chips sm' }, ['all', ...orgs].map(o => h('button', { class: 'chip' + (NT.org === o ? ' on' : ''), onclick: () => { NT.org = o; orgChips.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.o === o)); renderList(); }, 'data-o': o }, o === 'all' ? 'All' : o)));
  const inp = h('input', { class: 'txt', placeholder: 'Search projects…  (Enter = first match)', oninput: e => { NT.q = e.target.value; renderList(); }, onkeydown: e => { if (e.key === 'Enter') { const r = shown()[0]; if (r) go(r); } } });
  const box = h('div', { class: 'box ntbox' },
    h('div', { class: 'sh' }, h('h3', null, '＋ New session'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: close }, ico('x', 15))),
    h('button', { class: 'btn ntshell', onclick: () => { close(); newShell(); } }, ico('plus', 13), h('b', null, 'No project — just start a shell'), h('span', { class: 'dim' }, 'plain bash in the dev folder')),
    opts, inp, orgs.length > 1 ? orgChips : null, list);
  m.replaceChildren(box); m.onclick = e => { if (e.target === m) close(); };
  renderOpts(); renderList(); if (!IS_PHONE) setTimeout(() => inp.focus(), 0);
}
const isNewChat = name => /^claude-chat-\d{6}-\d{4}/.test(name || '');
const chatTitle = cl => (cl && (cl.label || cl.title || (cl.firstPrompt && (cl.firstPrompt.length > 40 ? cl.firstPrompt.slice(0, 39) + '…' : cl.firstPrompt)))) || 'New chat';
const sessTitle = s => isNewChat(s.name) ? chatTitle(s.claude) : (s.claude?.label || (s.project && byId()[s.project]?.name) || s.name);
const newSessionModal = (tab, text, opts) => FEAT.session ? FEAT.session.open(tab, text, opts) : newTerminalModal();
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
  out.claude = orgOrder(out.claude);
  out.all = [...out.claude, ...out.dev, ...out.other];
  return out;
}
function orgGroups(list) {
  const orgs = [...new Set(list.map(x => x.org || ''))].sort((a, b) => (!a - !b) || a.localeCompare(b));
  return orgs.map(org => ({ org, items: list.filter(x => (x.org || '') === org) }));
}
const orgOrder = list => orgGroups(list).flatMap(og => claudeGroups(og.items).flatMap(g => g.items));
const STATE_LABEL = { working: 'working', background: 'background agents running', permission: 'needs permission', 'needs-you': 'done · needs you', error: 'error', limit: 'usage limit', idle: 'idle', unknown: 'no signal yet', ended: 'claude exited' };
const STATE_ICON = { working: '●', background: '◐', permission: '⚠', 'needs-you': '✓', error: '✗', limit: '⏳', idle: '○', unknown: '·', ended: '■' };
const STATE_SHORT = { working: 'working', background: 'background', permission: 'permission', 'needs-you': 'needs you', error: 'error', limit: 'limit', idle: 'idle', unknown: '—', ended: 'exited' };
function stateBadge(cl, compact = false) {
  if (!cl) return null; const st = cl.state || 'unknown';
  if (compact) return h('span', { class: 'cst ' + st, title: (STATE_LABEL[st] || st) }, h('i', null, STATE_ICON[st] || '·'), cl.since && st !== 'unknown' ? h('b', null, ' ' + ago(cl.since)) : null);
  return h('span', { class: 'cst ' + st, title: (STATE_LABEL[st] || st) + (cl.since ? ' since ' + new Date(cl.since).toLocaleTimeString() : '') }, h('i', null, STATE_ICON[st] || '·'), ' ', STATE_SHORT[st] || st, cl.since && st !== 'unknown' ? h('b', null, ' ' + ago(cl.since)) : null);
}
// which Claude on a project this is: the base one (by account), a numbered extra instance, or a git worktree
function instOf(it) {
  const cl = it.claude || {};
  if (isNewChat(it.name)) return { wt: null, n: null, branch: cl.branch || null, label: chatTitle(cl) };
  const wt = cl.worktree || (it.name.match(/-wt-([^-]+)/) ? { name: it.name.match(/-wt-([^-]+)/)[1] } : null);
  const n = it.name.match(/^claude-.*-(\d+)(-company)?$/);
  return { wt, n: n ? +n[1] : null, branch: cl.branch || null, label: wt ? '⎇ ' + wt.name : n ? '#' + n[1] : '#1' };
}
// Claude sessions grouped per project, in tmux order (the first session of a project fixes the group's position)
function claudeGroups(list) {
  const groups = []; const by = new Map();
  for (const it of list) { const key = it.pid || it.name; let g = by.get(key); if (!g) { g = { key, pid: it.pid, project: it.project, org: it.org, items: [] }; by.set(key, g); groups.push(g); } g.items.push(it); }
  const rank = it => { const i = instOf(it); return (i.wt ? 1000 : 0) + (i.n || 1); };
  for (const g of groups) g.items.sort((a, b) => rank(a) - rank(b));
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
const nice = n => n.startsWith('claude-') ? '✦ ' + n.replace(/^claude-/, '').replace(/-company$/, ' (' + acctL('company') + ')') : n.startsWith('bd_') ? '▶ ' + n.replace(/^bd_/, '').replace('__', ' · ') : n === 'shell' ? 'bash' : n.startsWith('sh-') ? '$ ' + n : n;
function renderTermPanel(force) {
  const el = $('#termpanel'); const live = S.runtime.sessions.length; $('#term-count').textContent = live;
  if (TERM.open && !document.body.classList.contains('term-open')) TERM.pageY = window.scrollY;   // body goes position:fixed -> remember where the page was
  el.classList.toggle('hidden', !TERM.open); document.body.classList.toggle('term-open', TERM.open);
  if (!TERM.open) { fitTermPanel(); return; }
  trackVV(300);
  el.classList.toggle('showlist', TERM.showList); el.classList.toggle('focus', TERM.focus); document.body.classList.toggle('focus', !!TERM.focus);
  if (!$('#term-list')) {
    el.append(h('aside', { class: 'termside' }, h('div', { class: 'termside-head' }, h('button', { class: 'btn sm ghost back', title: 'back to dashboard — all sessions keep running (Esc)', onclick: closeTermPanel }, ico('back'), 'Dashboard'), h('span', { class: 'sp' }), h('button', { class: 'btn sm', title: 'new session — new chat (the project is guessed) or resume a past conversation  (s)', onclick: () => newSessionModal() }, ico('plus', 13), 'Session'), h('button', { class: 'btn sm ghost icon desk', title: 'focus mode — hide the session list (for screen sharing)', onclick: () => setFocus(true) }, ico('sidebar', 15))), h('div', { id: 'term-list' })),
      h('section', { class: 'termmain' }, h('div', { class: 'termbar', id: 'term-bar' }), h('div', { class: 'termframes', id: 'term-frames' }, h('div', { class: 'chatpane hidden', id: 'term-chat' }))));
  }
  const S3 = termSessions(); const known = new Set(S.runtime.sessions.map(s => s.name));
  const extra = [...TERM.frames.keys()].filter(k => !known.has(k));
  // The list and the bar are rebuilt only when something they show actually changed. Rebuilding them on every
  // 3-second state tick blurred the terminal iframe (the focus bug) and made the sidebar flicker.
  const key = JSON.stringify([TERM.active, TERM.showList, TERM.mode, TERM.view[TERM.active] || '', TERM.forceTerm.has(TERM.active), TERM.focus, S3.all.map(x => [x.name, x.claude?.mode, x.claude?.state, x.claude?.title, x.claude?.label, x.claude?.firstPrompt, (x.claude?.projects || []).join(), x.claude?.draft, x.claude?.model, x.claude?.effort, x.claude?.branch, x.claude?.worktree?.name, x.claude?.version, (S.settings.muted || []).includes(x.name), Math.floor((x.cpu || 0) / 10), x.ports.map(p => p.port)]), S.claude?.installed, S.claude?.update?.version, CLAUDE_UPGRADING, extra, [...TERM.frames.keys()], S.runtime.sessions.filter(s => s.name === TERM.active).map(s => s.project + (gitOf(byId()[s.project] || {})?.dirty || 0) + '|' + (s.claude?.ctx ? Math.round(s.claude.ctx.used / 1000) + '/' + s.claude.ctx.window : '')), feat('termBarKey', TERM.active)]);
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
    const name = kind === 'claude' ? (sub ? h('span', { class: 'inst' }, i.label) : isNewChat(it.name) ? chatTitle(cl) : (cl?.label || it.project)) : kind === 'dev' ? it.project : it.name.startsWith('sh-') ? it.name : it.name;
    const tag = kind === 'claude' ? (multiAcct() ? h('span', { class: 'badge tag acc ' + it.account }, acct(it.account)) : null) : kind === 'dev' ? h('span', { class: 'grp' }, it.label) : it.name.startsWith('sh-') ? h('span', { class: 'grp' }, 'bash') : null;
    const line2 = cl ? [h('span', { class: 'cst mini ' + cl.state }, STATE_ICON[cl.state] || '·', ' ', STATE_LABEL[cl.state] || cl.state), cl.model ? h('span', { class: 'mdl' }, modelName(cl.model)) : null, !sub && i && i.n ? h('span', { class: 'grp' }, '#' + i.n) : null]
      : [h('span', { class: 'grp' }, [it.group, it.org].filter(Boolean).join(' · ') || home(it.cwd)), h('span', { class: 'grp' }, `${ago(it.started)} · ${it.cpu.toFixed(0)}% · ${fmtB(it.mem)}`)];
    const others = cl && isNewChat(it.name) ? (cl.projects || []).filter(x => x !== it.pid).slice(0, 2).map(x => h('span', { class: 'grp pchip' }, byId()[x]?.name || x)) : [];
    const line3 = cl ? [where, ...others, isNewChat(it.name) && !sub ? (it.pid ? null : h('span', { class: 'grp' }, home(it.cwd))) : cl.title ? h('span', { class: 'ttl', title: cl.title }, cl.title) : cl.lastPrompt ? h('span', { class: 'ttl dim', title: cl.lastPrompt }, '❯ ' + cl.lastPrompt) : null] : null;
    return h('div', { class: 'titem ' + kind + (sub ? ' sub' : '') + (isActive ? ' on' : '') + (opened ? ' opened' : '') + (cl ? ' st-' + cl.state : ''), style: `--org:${orgColor(it.org)}`, onclick: () => openTerm(it.name), title: it.name },
      kind === 'claude' && !sub ? avatar(it.pid) : h('span', { class: 'dot' }),
      h('div', { class: 'tt' },
        h('div', { class: 'tn' }, h('span', { class: 'nm' }, name), tag),
        h('div', { class: 'ts' }, ...line2.filter(Boolean)),
        line3 && line3.some(Boolean) ? h('div', { class: 't3' }, ...line3.filter(Boolean)) : null),
      h('div', { class: 'tacts' },
        kind === 'claude' && !sub && it.pid ? h('button', { class: 'x plus', title: 'another Claude on this project', onclick: ev => plusClaude(ev, it.pid) }, ico('plus', 15)) : null,
        cl ? h('button', { class: 'x', title: 'rename this session', onclick: ev => { ev.stopPropagation(); renameDialog(it.name); } }, ico('pencil', 14)) : null,
        h('button', { class: 'x', title: 'open in new tab', onclick: ev => { ev.stopPropagation(); openTermTab(it.name); } }, ico('ext', 15))));
  };
  const section = (title, arr, kind) => arr.length ? [h('div', { class: 'tsec' }, title, h('span', { class: 'n' }, arr.length)), ...arr.map(it => item(it, kind))] : [];
  // Claude: one row per session; a project with several Claudes gets a header row and its sessions indented under it (tabs)
  const claudeRows = [];
  for (const og of orgGroups(S3.claude)) {
    const rows = [];
    for (const g of claudeGroups(og.items)) {
      if (g.items.length === 1) { rows.push(item(g.items[0], 'claude')); continue; }
      rows.push(h('div', { class: 'tgrp', style: `--org:${orgColor(g.org)}` }, avatar(g.pid, 'sm'), h('span', { class: 'tgn' }, g.project), h('span', { class: 'n' }, g.items.length), h('span', { class: 'sp' }), g.pid ? h('button', { class: 'x plus', title: 'another Claude on this project', onclick: ev => plusClaude(ev, g.pid) }, ico('plus', 13)) : null));
      for (const it of g.items) rows.push(item(it, 'claude', true));
    }
    if (og.items.length < 2 || !og.org) { claudeRows.push(...rows); continue; }
    claudeRows.push(h('div', { class: 'torg', style: `--org:${orgColor(og.org)}` }, h('div', { class: 'torg-h' }, h('i', null), og.org, h('span', { class: 'n' }, og.items.length)), ...rows));
  }
  list.append(...(S3.claude.length ? [h('div', { class: 'tsec' }, 'Claude instances', h('span', { class: 'n' }, S3.claude.length)), ...claudeRows] : []), ...section('Dev servers', S3.dev, 'dev'), ...section('Other tmux', S3.other, 'other'));
  // opened frames whose session vanished (or plain shells)
  if (extra.length) list.append(h('div', { class: 'tsec' }, 'Open tabs', h('span', { class: 'n' }, extra.length)), ...extra.map(k => h('div', { class: 'titem other' + (TERM.active === k ? ' on' : ''), onclick: () => { TERM.active = k; renderTermPanel(true); } }, h('span', { class: 'dot', style: k === 'shell' ? 'background:var(--accent);box-shadow:0 0 8px var(--accent)' : 'background:var(--dim);box-shadow:none' }), h('div', { class: 'tt' }, h('div', { class: 'tn' }, k === 'shell' ? 'bash · ' + home(S.host.devRoot || '~') : k), h('div', { class: 'ts' }, k === 'shell' ? 'plain shell' : 'session ended')), h('button', { class: 'x', title: 'close tab', onclick: ev => { ev.stopPropagation(); dropFrame(k); } }, ico('x', 13)))));
  if (!S.runtime.sessions.length && !TERM.frames.size) list.append(h('div', { class: 'note', style: 'padding:12px' }, 'No tmux sessions. Start a Claude session from a project card (✦ Claude ▾) or a dev server (▶), or open a shell.'));
  const bar = $('#term-bar'); bar.innerHTML = '';
  const barAdd = (...xs) => bar.append(...xs.filter(x => x != null && x !== false)); // Element.append() would render a literal "null" for sessions without a project
  const act = S.runtime.sessions.find(s => s.name === TERM.active); const cl = act && act.claude;
  const actAcc = act && (cl || isClaudeSession(act)) ? (cl?.account || (act.name.endsWith('-company') ? 'company' : 'personal')) : null;
  const accTag = () => actAcc ? h('span', { class: 'tacc ' + actAcc, title: 'Claude Code account: ' + acct(actAcc) }, acct(actAcc)) : null;
  // mobile: ☰ + native <select> session picker (sidebar is an overlay there)
  const allNames = [...new Set([...S3.all.map(x => x.name), ...TERM.frames.keys()])];
  const mobName = act ? sessTitle(act) : (TERM.active || 'Sessions');
  barAdd(h('button', { class: 'btn sm mob icon', title: 'sessions', onclick: () => { TERM.showList = !TERM.showList; renderTermPanel(true); } }, ico('sidebar', 17)),
    h('button', { class: 'mob msess', title: 'switch session', onclick: () => { TERM.showList = true; renderTermPanel(true); } }, act ? avatar(act.project, 'sm') : null, h('span', { class: 'nm' }, mobName), accTag(), instOf(act || { name: TERM.active || '' }).n ? h('span', { class: 'grp' }, '#' + instOf(act).n) : null, h('span', { class: 'caret' }, '▾')), cl && IS_PHONE ? stateBadge(cl, true) : null);
  const actProj = act && byId()[act.project]; const actGit = actProj && gitOf(actProj);
  const actDirty = actGit && !actGit.error ? actGit.dirty + actGit.untracked : 0;
  // one switch for every session on this device — not per session
  const chatOnNow = TERM.active && chatMode(TERM.active);
  const chatSw = cl && (cl.hooked || cl.mode === 'chat') ? h('span', { class: 'seg', title: cl.mode === 'chat' ? 'Chat session — Terminal shows the runner log' : 'Terminal or Chat view — applies to all Claude sessions on this device' }, h('button', { class: 'segb' + (!chatOnNow ? ' on' : ''), onclick: () => setMode('term') }, ico('terminal', 14), h('span', { class: 'desk' }, cl.mode === 'chat' ? 'Log' : 'Terminal')), h('button', { class: 'segb' + (chatOnNow ? ' on' : ''), onclick: () => setMode('chat') }, ico('chat', 14), h('span', { class: 'desk' }, 'Chat'))) : null;
  const actName = act ? sessTitle(act) : TERM.active;
  const isChatS = cl && cl.mode === 'chat'; const logOn = isChatS && TERM.view[TERM.active] === 'term';
  const muted = (S.settings.muted || []).includes(TERM.active);
  const sub = cl && cl.title && cl.title !== actName ? h('span', { class: 'dim desk ttitle', title: cl.title }, cl.title) : !cl && act ? h('span', { class: 'dim mono desk ttitle', style: 'font-size:11.5px' }, home(act.cwd)) : null;
  if (TERM.active) barAdd(h('button', { class: 'btn sm ghost icon desk', title: 'back to the dashboard — every session keeps running  (Esc)', onclick: closeTermPanel }, ico('back', 15)),
    h('button', { class: 'btn sm ghost icon desk' + (TERM.focus ? ' on' : ''), title: TERM.focus ? 'show the rail again' : 'focus mode — hide the rail with every session (screen sharing)', onclick: () => setFocus(!TERM.focus) }, ico('sidebar', 15)),
    h('span', { class: 'tid desk' }, act ? avatar(act.project, 'sm') : null,
      h('span', { class: 'tname' + (cl ? ' can-rename' : ''), title: cl ? 'click to rename · ' + TERM.active : TERM.active, onclick: cl ? () => renameDialog(TERM.active) : null }, actName, instOf(act || { name: TERM.active }).n ? h('span', { class: 'grp' }, ' #' + instOf(act).n) : null),
      IS_PHONE ? null : accTag()),
    isChatS ? null : chatSw, cl && !IS_PHONE ? stateBadge(cl) : null, modelChip(cl), cl ? whereTag(cl) : null, sub,
    h('span', { class: 'sp' }),
    logOn ? h('button', { class: 'btn sm', title: 'you are looking at the runner log — back to the conversation', onclick: () => setMode('chat') }, ico('chat', 13), 'Back to chat') : null,
    cl && cl.state === 'limit' && act ? h('button', { class: 'btn sm primary', title: 'start the other account in this folder with a summary of where this one stopped', onclick: () => handoff({ name: TERM.active, account: cl.account, project: act.project }) }, gl('⇄ Hand off')) : null,
    cl && S.claude?.update ? h('button', { class: 'btn sm dirtybtn desk', disabled: CLAUDE_UPGRADING, title: CLAUDE_UPGRADING ? 'mise upgrade claude is running…' : `Claude Code ${S.claude.update.version} is out — install it (mise upgrade claude), then restart this session (same conversation, --resume)`, onclick: () => updateClaude({ name: TERM.active, project: act?.project }) }, ico('refresh', 13), CLAUDE_UPGRADING ? 'installing…' : S.claude.update.version) :
    cl && cl.version && S.claude?.installed && cl.version !== S.claude.installed ? h('button', { class: 'btn sm dirtybtn desk', title: `running Claude Code ${cl.version}, ${S.claude.installed} is installed — restart this session (same conversation, --resume)`, onclick: () => restartSession({ name: TERM.active, project: act?.project }) }, ico('refresh', 13), S.claude.installed) : null,
    !isChatS && cl && cl.hooked && cl.sessionId ? h('button', { class: 'btn sm', title: 'continue this conversation as a chat — same tmux session, same conversation (only when Claude is idle)', onclick: () => switchSession(TERM.active, 'chat') }, ico('chat', 13), h('span', { class: 'desk' }, 'Continue in chat')) : null,
    ...feat('termBar', TERM.active),
    actProj ? h('button', { class: 'btn sm ghost projbtn', title: 'project details — changes, files, logs, branches, docker', onclick: () => openDrawer(actProj.id, actDirty ? 'changes' : 'overview') }, ico('folder', 14), h('span', { class: 'desk' }, 'Project'), actDirty ? h('span', { class: 'pill warn' }, '± ' + actDirty) : null) : null,
    ...(cl ? feat('chatBar', TERM.active) : []),
    cl ? ctxMeter(TERM.active, cl) : null,
    muted ? h('button', { class: 'btn sm ghost icon desk tmuted', title: 'notifications muted — click to unmute', onclick: () => api('claude-mute', { session: TERM.active, muted: false }).then(() => toast('unmuted')).catch(e => toast(e.message, 'err')) }, ico('bellOff', 15)) : null,
    h('button', { class: 'btn sm tmore', title: 'session options — new chat, compact, rename, move, kill…', onclick: ev => sessMenu(ev, TERM.active) }, ico('sliders', 15), h('span', { class: 'desk' }, 'Options'), ico('chevronDown', 13)),
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
  if (!quiet && !opts.mode) noteBundle(p, { kind: 'claude', name: account });
  try { const r = await api('claude', { id: p.id, account, ...opts }); toast(r.existed ? `Attaching to ${r.name}` : `Started ${r.name} (${account}${opts.mode === 'chat' ? ', chat' : ''})`, 'ok'); openTerm(r.name); }
  catch (e) { toast('Claude session failed: ' + e.message, 'err'); }
}
function claudeMenu(ev, p) {
  const r = runtimeFor(p.id); const live = new Set(r.sessions.map(s => s.name));
  const base = p.dirName.replace(/[^A-Za-z0-9_.-]+/g, '-'); const per = `claude-${base}`, co = `claude-${base}-company`;
  const mine = r.sessions.filter(s => isClaudeSession(s));
  const wt = account => { const name = prompt('Worktree / branch name for the new Claude session (e.g. feat-login):'); if (name) startClaude(p, account, { worktree: name.trim() }); };
  openMenu(ev, [
    { header: 'Claude Code session (tmux, --dangerously-skip-permissions)' },
    { label: acct('personal'), sub: live.has(per) ? `${per} · running → attach` : `${per} · ~/.claude`, icon: live.has(per) ? '●' : '✦', cur: live.has(per), onclick: () => startClaude(p, 'personal') },
    { label: acct('company'), sub: live.has(co) ? `${co} · running → attach` : `${co} · ~/.claude-company`, icon: live.has(co) ? '●' : '✦', cur: live.has(co), onclick: () => startClaude(p, 'company') },
    ...mine.filter(s => s.name !== per && s.name !== co).map(s => ({ label: nice(s.name).replace(/^✦ /, ''), sub: (s.claude && (STATE_LABEL[s.claude.state] + (s.claude.title ? ' · ' + s.claude.title : ''))) || 'running → attach', icon: '●', cur: true, onclick: () => openTerm(s.name) })),
    'sep',
    { header: 'Chat session (headless claude -p · beta)' },
    { label: acct('personal') + ' chat', sub: 'new conversation · chat view', icon: '◇', onclick: () => startClaude(p, 'personal', { mode: 'chat' }) },
    { label: acct('company') + ' chat', sub: 'new conversation · chat view', icon: '◇', onclick: () => startClaude(p, 'company', { mode: 'chat' }) },
    'sep',
    { label: acct('personal') + ' — resume last', sub: 'claude --continue', icon: '↺', disabled: live.has(per), onclick: () => startClaude(p, 'personal', { resume: true }) },
    { label: acct('company') + ' — resume last', sub: 'claude --continue', icon: '↺', disabled: live.has(co), onclick: () => startClaude(p, 'company', { resume: true }) },
    'sep',
    { header: 'More Claudes on this project' },
    { label: `Another ${acctL('personal')} instance`, sub: `${per}-2 · same working tree`, icon: '＋', onclick: () => startClaude(p, 'personal', { fresh: true }) },
    { label: `Another ${acctL('company')} instance`, sub: `${co.replace(/-company$/, '')}-2-company · same working tree`, icon: '＋', onclick: () => startClaude(p, 'company', { fresh: true }) },
    p.isGit ? { label: acct('personal') + ' in a git worktree…', sub: 'claude --worktree <name> · separate branch + directory', icon: '⎇', onclick: () => wt('personal') } : null,
    p.isGit ? { label: acct('company') + ' in a git worktree…', sub: 'claude --worktree <name> · separate branch + directory', icon: '⎇', onclick: () => wt('company') } : null,
    'sep',
    { label: 'Copy ssh command', sub: attachCmd(per), icon: '⎘', onclick: () => navigator.clipboard.writeText(attachCmd(per)).then(() => toast('copied — paste in a terminal on your laptop')) },
  ].filter(Boolean));
}
function exposedPort(port) { return S.runtime.exposures.find(e => e.port === port); }
function reachable(p) { return !p.loopback || !!exposedPort(p.port); }

// ---------- header ----------
function renderHeader() {
  const mac = (S.host.tailscale?.peers || []).find(p => p.os === 'macOS'); const macTxt = mac ? ` · mac ${mac.online ? '● online' : '○ offline'}` : '';
  $('#hostline').textContent = `${S.host.hostname || ''}${mac ? (mac.online ? ' · mac online' : ' · mac offline') : ''}`; $('#hostline').title = `${S.host.tsName || ''} · ${S.host.tsIp || publicHost()}${macTxt} · ${S.projects.filter(p => !p.hidden).length} projects · dev root ${S.host.devRoot}`;
  renderLiveDot();
  const orgs = [...new Set(S.projects.map(p => p.org))];
  const liveCount = S.projects.filter(p => isLive(p.id)).length;
  const chips = [['all', 'All', S.projects.filter(p => !p.hidden).length, null], ['running', 'Running', liveCount, 'var(--green)'], ...orgs.map(o => [o, o, S.projects.filter(p => p.org === o && !p.hidden).length, orgColor(o)])];
  const f = $('#filters'); f.innerHTML = '';
  for (const [key, label, n, color] of chips) f.append(h('button', { class: 'chip' + (UI.filter === key ? ' on' : ''), onclick: () => { UI.filter = key; render(); } }, color ? h('span', { class: 'dot', style: `background:${color}` }) : null, label, h('span', { class: 'n' }, n)));
  $('#tunnel-count').textContent = S.runtime.exposures.length;
  $('#proj-count').textContent = S.projects.filter(p => !p.hidden).length;
  { const open = (S.claude?.tasks || []).filter(t => t.status !== 'done').length; const tc = $('#task-count'); if (tc) { tc.textContent = open; tc.classList.toggle('hot', open > 0); } }
  const need = S.runtime.sessions.filter(s => s.claude && s.claude.needsYou).length; const nb = $('#need-count'); if (nb) { nb.textContent = need; nb.classList.toggle('hidden', !need); }
  // phone tab bar badges
  const tbn = (id, n) => { const e = $(id); if (e) { e.textContent = n > 99 ? '99+' : n; e.classList.toggle('hidden', !n); } };
  tbn('#tb-need', need); tbn('#tb-sess', S.runtime.sessions.length); tbn('#tb-tasks', (S.claude?.tasks || []).filter(t => t.status !== 'done').length);
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
const modelChip = cl => cl && cl.model ? h('span', { class: 'badge tag model', title: `model: ${cl.model}${cl.effort ? ' · effort ' + cl.effort : ''}` }, gl('◈ '), modelName(cl.model), cl.effort && cl.effort !== 'high' ? h('i', null, ' · ' + cl.effort) : null) : null;
// plan limits (5 h session / 7 d / Fable) per account, as Claude Code's /usage shows them
const inStr = ts => { const s = Math.max(0, (ts - Date.now()) / 1000); const mm = Math.round(s / 60); if (s < 60) return '<1m'; if (mm < 60) return mm + 'm'; if (mm < 1440) return Math.floor(mm / 60) + 'h ' + (mm % 60) + 'm'; return Math.floor(mm / 1440) + 'd ' + Math.floor(mm % 1440 / 60) + 'h'; };
const whenStr = ts => { const d = new Date(ts); const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return Math.abs(ts - Date.now()) < 86400e3 && d.getDate() === new Date().getDate() ? hm : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm; };
const resetStr = ts => ts ? whenStr(ts) + ' (in ' + inStr(ts) + ')' : '';
const RESET_NOTE = 'next window starts with your next message';
const limCls = w => !w || w.pct == null || w.reset ? '' : w.pct >= 90 || w.severity === 'critical' ? 'hot' : w.pct >= 70 || (w.severity && w.severity !== 'normal') ? 'warn' : '';
function limitRow(label, w, title, big) {
  if (!w) return null; const c = limCls(w);
  return h('div', { class: 'limrow ' + c + (big ? ' big' : ''), title: (title || label) + (w.resetsAt ? ' · resets ' + resetStr(w.resetsAt) : w.reset ? ' · reset at ' + whenStr(w.resetAt) + ' · ' + RESET_NOTE : '') }, h('span', { class: 'll' }, label), h('span', { class: 'lb' }, h('b', { style: `width:${Math.min(100, w.pct || 0)}%` })), h('span', { class: 'lp mono' }, (w.pct ?? '–') + '%'), h('span', { class: 'lr mono' }, w.resetsAt ? inStr(w.resetsAt) : w.reset ? 'reset' : ''),
    w.resetsAt || w.reset ? h('span', { class: 'lrs' }, w.resetsAt ? [ico('refresh', 11), ' ' + whenStr(w.resetsAt)] : 'reset at ' + whenStr(w.resetAt)) : null);
}
// one column of the "Claude usage limits" card: 5 h reset in the header, then the 5 h (big %) / week / Fable / extra rows
function limitCol(account, L) {
  const badge = h('span', { class: 'badge tag acc ' + account, title: (L.plan || '') + (L.tier ? ' · ' + L.tier : '') + (L.fetchedAt ? ' · fetched ' + ago(L.fetchedAt) + ' ago' : '') + (L.error ? ' · last fetch failed: ' + L.error : '') }, acct(account), L.plan ? ' · ' + L.plan : '');
  if (L.error && !L.session) return h('div', { class: 'limcol' }, h('div', { class: 'k' }, badge), h('div', { class: 'v' }, '–'), h('div', { class: 's' }, L.error));
  const se = L.session; const all = [se, L.weekly, ...(L.scoped || [])].map(limCls); const cls = all.includes('hot') ? 'hot' : all.includes('warn') ? 'warn' : '';
  const seReset = se?.resetsAt ? 'resets ' + whenStr(se.resetsAt) : se?.reset ? `reset at ${whenStr(se.resetAt)} · ${RESET_NOTE}` : null;
  return h('div', { class: 'limcol ' + cls + (L.stale ? ' stale' : '') },
    h('div', { class: 'k' }, badge, seReset ? h('span', { class: 'mono dim', style: 'text-transform:none;letter-spacing:0;font-weight:500' }, seReset) : null),
    se ? null : h('div', { class: 's' }, 'no 5h session window'),
    L.stale && L.fetchedAt ? h('div', { class: 'limstale' }, `as of ${whenStr(L.fetchedAt)}` + (L.error ? ' · ' + L.error : ' · not refreshed since')) : null,
    h('div', { class: 'lim' }, limitRow('5h', se, '5-hour session', true), limitRow('week', L.weekly, '7-day window, all models'), ...(L.scoped || []).map(w => limitRow(w.name, w, `7-day window, ${w.name} only`)),
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
// battery: where the power comes from (chip) and what that means in time (line under the number)
// draining = unplugged, or plugged into a charger too weak to keep up: that's when low charge matters
const batDrain = b => !b.ac || b.status === 'Discharging';
const batSrc = b => b.status === 'Charging' ? '⚡ charging' : b.ac && b.status === 'Discharging' ? '⚡ AC, draining' : b.ac ? '⚡ on AC' : 'on battery';
function batChip(b) { return h('span', { class: 'bchip ' + (batDrain(b) ? 'dis' : 'ac'), title: `${b.name} · ${b.status}${b.ac ? ' · plugged in' : ' · unplugged'}` }, batSrc(b)); }
function batLine(b) {
  const tail = [b.watts ? b.watts + ' W' : null, b.health ? 'health ' + b.health + '%' : null, b.cycles ? b.cycles + ' cycles' : null].filter(Boolean);
  const head = b.status === 'Discharging' ? (b.minsLeft ? fmtDur(b.minsLeft * 60000) + ' left' : 'on battery') : b.status === 'Charging' ? (b.minsLeft ? 'full in ' + fmtDur(b.minsLeft * 60000) : 'charging') : b.status === 'Not charging' ? 'plugged in, holding' : b.status === 'Full' ? 'full' : b.ac ? 'plugged in' : 'on battery';
  return [head, ...tail].join(' · ');
}
// 24 h history behind the CPU / GPU / Memory / Disk / Battery tiles: usage + temperatures, one point a minute (server keeps it)
const HIST24 = { data: [], at: 0 };
async function sysModal(kind) {
  const m = $('#modal'); m.classList.remove('hidden');
  if (Date.now() - HIST24.at > 30000) { try { HIST24.data = await api('temps'); HIST24.at = Date.now(); } catch {} }
  const s = S.stats; const d = HIST24.data;
  const series = {   // [label, column, colour, unit, min, max, shaded-while column]
    cpu: [['CPU usage', 4, 'rgb(76,201,222)', '%', 0, 100], ['CPU temp', 1, 'rgb(255,159,90)', '°C', 20, 95]],
    gpu: [['GPU usage', 5, 'rgb(91,211,156)', '%', 0, 100], ['GPU temp', 2, 'rgb(255,159,90)', '°C', 20, 95]],
    mem: [['Memory used', 6, 'rgb(157,140,255)', '%', 0, 100]],
    disk: [['NVMe temp', 3, 'rgb(255,159,90)', '°C', 20, 90]],
    bat: [['Battery charge', 7, 'rgb(91,211,156)', '%', 0, 100, 8]],
  }[kind];
  const titles = { cpu: 'CPU', gpu: 'GPU', mem: 'Memory', disk: 'Disk', bat: 'Battery' };
  const b = s.battery || {};
  const stat = (k, v) => h('div', { class: 'sst' }, h('div', { class: 'k' }, k), h('div', { class: 'v mono' }, v));
  const now = kind === 'cpu' ? [stat('now', s.cpu.pct.toFixed(0) + '%'), stat('temp', s.cpu.temp ? s.cpu.temp.toFixed(0) + '°' : '–'), stat('load', s.load.map(x => x.toFixed(2)).join(' ')), stat('cores', s.cpu.count)]
    : kind === 'gpu' ? [stat('now', (s.gpu?.util ?? 0) + '%'), stat('temp', (s.gpu?.temp ?? '–') + '°'), stat('power', s.gpu?.power ? s.gpu.power.toFixed(0) + ' W' : '–'), stat('vram', s.gpu ? fmtB(s.gpu.memUsed) + ' / ' + fmtB(s.gpu.memTotal) : '–')]
    : kind === 'mem' ? [stat('used', fmtB(s.mem.used)), stat('cache', fmtB(s.mem.cached)), stat('free', fmtB(s.mem.total - s.mem.used - s.mem.cached)), stat('swap', fmtB(s.mem.swapUsed || 0))]
    : kind === 'bat' ? [stat('now', (b.pct ?? '–') + '%'), stat('power', b.ac ? 'AC' + (b.status === 'Charging' ? ', charging' : '') : 'battery'), stat(b.status === 'Charging' ? 'full in' : 'left', b.minsLeft ? fmtDur(b.minsLeft * 60000) : '–'), stat('health', b.health ? b.health + '%' + (b.cycles ? ' · ' + b.cycles + ' cyc' : '') : '–')]
    : [stat('used', fmtB(s.disks?.[0]?.used)), stat('free', fmtB(s.disks?.[0]?.avail)), stat('temp', s.temps?.nvme ? s.temps.nvme.toFixed(0) + '°' : '–')];
  const charts = series.map(([label, col, colour, unit, lo, hi, band]) => { const vals = d.map(x => x[col]).filter(v => v != null); const mx = vals.length ? Math.max(...vals) : null, avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    return h('div', { class: 'schart' }, h('div', { class: 'sch-h' }, h('span', { class: 'sch-l' }, h('i', { style: 'background:' + colour }), label), h('span', { class: 'sp' }), h('span', { class: 'dim mono' }, mx != null ? `max ${mx.toFixed(0)}${unit} · avg ${avg.toFixed(0)}${unit}` : 'collecting…')), h('canvas', { 'data-col': col, 'data-colour': colour, 'data-lo': lo, 'data-hi': hi, 'data-band': band })); });
  const box = h('div', { class: 'box settings sys' }, h('div', { class: 'sh' }, h('h3', null, titles[kind] + ' · last 24 h'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', onclick: () => m.classList.add('hidden') }, ico('x', 15))),
    h('div', { class: 'sbody' }, h('div', { class: 'sstats' }, now), charts, kind === 'cpu' ? h('div', { class: 'cores big' }, s.cpu.cores.map(c => h('i', { title: c.toFixed(0) + '%' }, h('b', { style: `width:${c}%` })))) : null, h('div', { class: 'hint' }, `${d.length} samples · one a minute · ${kind === 'bat' ? 'shaded: plugged in · ' : ''}history starts when the dashboard started collecting`)));
  m.replaceChildren(box); m.onclick = e => { if (e.target === m) m.classList.add('hidden'); };
  requestAnimationFrame(() => { for (const c of box.querySelectorAll('canvas')) drawHist(c, d); });
}
function drawHist(c, d) {
  const col = +c.dataset.col, colour = c.dataset.colour, lo = +c.dataset.lo, hi = +c.dataset.hi;
  const dpr = window.devicePixelRatio || 1; const W = c.clientWidth, H = c.clientHeight; if (!W) return; c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const t1 = Date.now(), t0 = t1 - 24 * 3600e3; const x = t => (t - t0) / (t1 - t0) * W; const y = v => H - 4 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * (H - 10);
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1; ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono'); ctx.fillStyle = 'rgba(255,255,255,.3)';
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(W, y(v)); ctx.stroke(); ctx.fillText(v.toFixed(0), 2, y(v) - 2); }
  for (let hh = 0; hh <= 24; hh += 6) { const t = t1 - hh * 3600e3; ctx.beginPath(); ctx.moveTo(x(t), 0); ctx.lineTo(x(t), H); ctx.stroke(); if (hh) ctx.fillText('-' + hh + 'h', x(t) + 3, H - 2); }
  if (d.length < 2) return;
  if (c.dataset.band) { const bc = +c.dataset.band; ctx.fillStyle = colour.replace('rgb', 'rgba').replace(')', ',.08)');   // a gap of 5+ min (server down) isn't shaded
    for (let i = 0; i < d.length - 1; i++) if (d[i][bc] === 1 && d[i + 1][0] - d[i][0] < 5 * 60e3) ctx.fillRect(x(d[i][0]), 0, x(d[i + 1][0]) - x(d[i][0]) + .5, H); }
  ctx.beginPath(); let started = false, sx = null, lx = null;   // sx/lx: where the last drawn run starts / ends
  for (const p of d) { if (p[col] == null) { started = false; continue; } const px = x(p[0]), py = y(p[col]); if (!started) { ctx.moveTo(px, py); started = true; sx = px; } else ctx.lineTo(px, py); lx = px; }
  if (sx == null) return;
  ctx.strokeStyle = colour; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(lx, H); ctx.lineTo(sx, H); ctx.closePath(); ctx.fillStyle = colour.replace('rgb', 'rgba').replace(')', ',.12)'); ctx.fill();
}
function renderStats() {
  const s = S.stats; const el = $('#stats'); if (!s) return;
  const tiles = [];
  const DETAIL = { cpu: 'cpu', gpu: 'gpu', mem: 'mem', disk: 'disk', bat: 'bat' };
  const tile = (key, k, v, unit, sub, cls, extra) => h('div', { class: 'tile ' + (cls || '') + (DETAIL[key] ? ' clickable' : ''), 'data-k': key, title: DETAIL[key] ? 'click: 24 h history' : null, onclick: DETAIL[key] ? () => sysModal(DETAIL[key]) : null }, h('div', { class: 'k' }, h('span', null, k), extra?.right), h('div', { class: 'v' }, v, h('small', null, unit)), h('div', { class: 's' }, sub), extra?.body, h('canvas'));
  const cpuCls = s.cpu.pct > 85 ? 'hot' : s.cpu.pct > 60 ? 'warn' : '';
  tiles.push(tile('cpu', 'CPU', s.cpu.pct.toFixed(0), '%', `${s.cpu.count} cores · load ${s.load.map(x => x.toFixed(2)).join(' ')}`, cpuCls, { right: tempChip(s.cpu.temp, 'CPU (Tctl)'), body: h('div', { class: 'cores' }, s.cpu.cores.map(c => h('i', null, h('b', { style: `width:${c}%;background:${c > 85 ? 'var(--red)' : c > 50 ? 'var(--amber)' : 'var(--cyan)'}` })))) }));
  const memPct = s.mem.used / s.mem.total * 100;
  tiles.push(tile('mem', 'Memory', fmtB(s.mem.used), '/ ' + fmtB(s.mem.total), `${memPct.toFixed(0)}% used · cache ${fmtB(s.mem.cached)}${s.mem.swapUsed > 50e6 ? ' · swap ' + fmtB(s.mem.swapUsed) : ''}`, memPct > 90 ? 'hot' : memPct > 75 ? 'warn' : ''));
  if (s.gpu) tiles.push(tile('gpu', 'GPU', s.gpu.util, '%', `${s.gpu.name.replace('NVIDIA GeForce ', '')} · ${fmtB(s.gpu.memUsed)}/${fmtB(s.gpu.memTotal)}${s.gpu.power ? ' · ' + s.gpu.power.toFixed(0) + 'W' : ''}`, s.gpu.util > 85 ? 'warn' : '', { right: tempChip(s.gpu.temp, 'GPU') }));
  tiles.push(tile('net', 'Network', fmtRate(s.net.rxRate), '↓', `↑ ${fmtRate(s.net.txRate)} · ${Object.keys(s.net.ifaces).filter(i => i !== 'tailscale0').join(', ')} + tailscale0`, '', { right: tempChip(s.temps?.nic, 'ethernet controller') }));
  const d = s.disks?.[0]; if (d) { const pct = d.used / d.size * 100; tiles.push(tile('disk', 'Disk ' + d.mount, fmtB(d.used), '/ ' + fmtB(d.size), `${fmtB(d.avail)} free · ${d.fs}`, pct > 90 ? 'hot' : pct > 75 ? 'warn' : '', { right: tempChip(s.temps?.nvme, 'hottest NVMe drive'), body: ring(pct) })); }
  const b = s.battery;   // only on a machine with one; low only counts while draining
  if (b) { const cls = !batDrain(b) ? '' : b.pct <= 10 ? 'hot' : b.pct <= 25 ? 'warn' : ''; tiles.push(tile('bat', 'Battery', b.pct, '%', batLine(b), cls, { right: batChip(b), body: h('div', { class: 'batbar' }, h('b', { style: `width:${b.pct}%` })) })); }
  const u = S.claude?.usage;
  if (u) tiles.push(tile('claude', 'Claude today', usd(u.total.today), 'API-equiv.', `${acctL('personal')} ${usd(u.personal.today)} · ${acctL('company')} ${usd(u.company.today)} · yesterday ${usd(u.total.yesterday)} · 7d ${usd(u.total.week)}`, '', { right: h('span', { class: 'dim', style: 'font-size:10.5px', title: 'What these tokens would cost at API list price. On a subscription nothing is billed per token; this measures how much work the sessions did.' }, 'est.') }));
  const lt = limitsTile(S.claude?.limits || {}); if (lt) tiles.push(lt);
  const hs = $('#hogs'); if (hs) { const hg = hogsTile(s); hs.replaceChildren(...(hg ? [hg] : [])); }   // own section: on the phone it sits above the agents
  tiles.push(tile('up', 'Uptime', fmtUp(s.uptime), '', `${S.runtime.sessions.length} sessions · ${S.runtime.external.length} procs · ${S.runtime.containers.filter(c => c.state === 'running').length}/${S.runtime.containers.length} containers`));
  el.replaceChildren(...tiles);
  el.classList.toggle('n7', tiles.filter(t => !['claude', 'limits'].includes(t.dataset.k)).length > 6);   // GPU + battery: one machine tile more than a row holds
  drawSparks();
}
// rail footer (desktop): the machine at a glance on every view, click for the 24 h history. Built once, then only
// the numbers change (a rebuilt button would swallow a click that spans a stats tick).
function renderRailFoot() {
  const s = S.stats; const rf = $('#rail-foot'); if (!s || !rf) return;
  const bt = s.battery;
  const rows = [['cpu', 'CPU', s.cpu.pct, s.cpu.temp], ['mem', 'RAM', s.mem.used / s.mem.total * 100, null], s.gpu ? ['gpu', 'GPU', s.gpu.util, s.gpu.temp] : null, bt ? ['bat', 'BAT', bt.pct, null] : null].filter(Boolean);
  if ([...rf.children].map(c => c.dataset.k).join() !== rows.map(r => r[0]).join()) rf.replaceChildren(...rows.map(([k, l]) => h('button', { class: 'rm', 'data-k': k, onclick: () => sysModal(k) }, h('span', { class: 'rk' }, l), h('i', null, h('b')), h('span', { class: 'rv' }))));
  rows.forEach(([k, l, v, t], i) => {
    const b = rf.children[i]; const bat = k === 'bat';   // battery: low is the bad end, and only while unplugged
    b.className = 'rm' + (bat ? (!batDrain(bt) ? ' ac' : v <= 10 ? ' hot' : v <= 25 ? ' warn' : '') : v > 85 ? ' hot' : v > 60 ? ' warn' : '');
    b.title = bat ? `Battery ${v}% · ${batLine(bt)} — click: 24 h history` : `${l} ${v.toFixed(0)}%${t ? ' · ' + t.toFixed(0) + ' °C' : ''} — click: 24 h history`;
    b.querySelector('b').style.width = Math.min(100, Math.max(2, v)) + '%'; b.querySelector('.rv').textContent = (bat && bt.ac ? '⚡' : '') + v.toFixed(0) + '%';
  });
}
// Heavy processes: only when something keeps a core busy or holds a lot of memory. One row per process — what it is
// (in words), its project, CPU as a share of the whole machine, memory, for how long, a tip when there's a known fix,
// and Stop / Kill for your own processes.
const fmtDur = ms => { const m = Math.round(ms / 60000); return m < 1 ? '<1 min' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); };
function hogsTile(s) {
  const list = s.hogs || []; if (!list.length) return null;
  const cores = s.cpu.count || 1; const hot = list.some(x => x.level === 'hot');
  const killP = (x, sig) => { if (!confirm(`${sig === 'KILL' ? 'Force-kill' : 'Stop'} ${x.name}?\n\npid ${x.pid} · ${x.cpu}% CPU · ${fmtB(x.rss)}\n${x.cmd.slice(0, 200)}`)) return; act((sig === 'KILL' ? 'kill ' : 'stop ') + x.name, api('proc-kill', { pid: x.pid, sig })); };
  const rows = list.map(x => {
    const share = Math.min(100, x.cpu / cores);
    return h('div', { class: 'hog ' + x.level, title: `pid ${x.pid}\n${x.cmd}${x.cwd ? '\n' + home(x.cwd) : ''}` },
      h('div', { class: 'hog-ic' }, gico(x.icon || '⚙', 17)),
      h('div', { class: 'hog-main' },
        h('div', { class: 'hog-name' }, h('b', null, x.name), x.container ? h('span', { class: 'badge tag' }, 'docker') : null, !x.mine ? h('span', { class: 'badge tag', title: 'owned by another user (root / system) — no Stop from here' }, 'system') : null),
        h('div', { class: 'hog-bars' },
          h('span', { class: 'hog-m mono', title: `${x.cpu}% of one core = ${share.toFixed(0)}% of the whole CPU (${cores} threads)` }, h('span', { class: 'lbl' }, 'CPU'), h('span', { class: 'bar' }, h('b', { style: `width:${Math.max(2, share)}%` })), h('span', { class: 'val' }, x.cpu + '%')),
          h('span', { class: 'hog-m mono', title: 'resident memory' }, h('span', { class: 'lbl' }, 'RAM'), h('span', { class: 'bar mem' }, h('b', { style: `width:${Math.max(2, Math.min(100, x.rss / s.mem.total * 100))}%` })), h('span', { class: 'val' }, fmtB(x.rss))),
          h('span', { class: 'hog-t mono dim' }, 'heavy ' + fmtDur(x.heavyFor) + ' · up ' + fmtDur(x.runningFor))),
        x.tip ? h('div', { class: 'hog-tip' }, gl('💡 '), x.tip) : null),
      x.mine ? h('div', { class: 'hog-act' }, h('button', { class: 'btn sm ghost', title: 'ask it to stop (SIGTERM)', onclick: ev => { ev.stopPropagation(); killP(x, 'TERM'); } }, 'Stop'), h('button', { class: 'btn sm ghost danger', title: 'force-kill (SIGKILL)', onclick: ev => { ev.stopPropagation(); killP(x, 'KILL'); } }, 'Kill')) : null);
  });
  return h('div', { class: 'tile wfull hogs' + (hot ? ' is-hot' : ''), 'data-k': 'hogs' },
    h('div', { class: 'k' }, h('span', null, hot ? [ico('flame', 13), ' '] : null, 'Heavy processes', h('span', { class: 'pill' }, list.length)), h('span', { class: 'dim', style: 'font-size:10.5px;text-transform:none;letter-spacing:0' }, 'keeping ≥1 core busy or holding ≥3 GB · 100% = one core')),
    h('div', { class: 'hog-list' }, rows));
}
function drawSparks() {
  const H = S.hist; const u = S.claude?.usage;
  const map = { cpu: [H.cpu, 'rgb(76,201,222)', 100], mem: [H.mem, 'rgb(157,140,255)', 100], gpu: [H.gpu, 'rgb(91,211,156)', 100], net: [H.net.map(x => x[0] + x[1]), 'rgb(143,165,255)', Math.max(1e5, ...H.net.map(x => x[0] + x[1]))] };
  if (u) { const series = u.days.map((_, i) => u.personal.series[i] + u.company.series[i]); map.claude = [series, 'rgb(255,107,149)', Math.max(1, ...series)]; }
  for (const [k, [data, color, max]] of Object.entries(map)) { const c = $(`.tile[data-k="${k}"] canvas`); if (c) sparkline(c, data, color, max); }
}

// ---------- agents (home page: every Claude session as a card, needs-you first) ----------
function confirmBox({ title, text, ok = 'OK', danger = false, icon = null, who = null }) {
  return new Promise(resolve => {
    const m = $('#modal'); let done = false;
    const finish = v => { if (done) return; done = true; m.classList.add('hidden'); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => {
      if (!box.isConnected || m.classList.contains('hidden')) { done = true; document.removeEventListener('keydown', onKey, true); resolve(false); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    const okBtn = h('button', { class: 'btn ' + (danger ? 'danger solid' : 'primary'), onclick: () => finish(true) }, icon ? ico(icon, 14) : null, ok);
    const box = h('div', { class: 'box settings confirm' + (danger ? ' danger' : '') },
      h('div', { class: 'cf-body' },
        icon ? h('span', { class: 'cf-ico' }, ico(icon, 20)) : null,
        h('div', { class: 'cf-txt' }, h('h3', null, title), who, ...[].concat(text || []).map(t => typeof t === 'string' ? h('p', null, t) : t))),
      h('div', { class: 'foot' }, h('span', { class: 'sp' }), h('button', { class: 'btn ghost', onclick: () => finish(false) }, 'Cancel'), okBtn));
    m.replaceChildren(box); m.classList.remove('hidden'); m.onclick = e => { if (e.target === m) finish(false); };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => okBtn.focus(), 30);
  });
}
const sessWho = name => { const s = S.runtime.sessions.find(x => x.name === name); const cl = s && s.claude; return h('div', { class: 'sto' }, s ? avatar(s.project, 'sm') : null, h('b', null, s ? sessTitle(s) : name), cl && cl.account ? h('span', { class: 'tacc ' + cl.account }, cl.account) : null); };
async function killSession(name, label) {
  const cl = claudeOf(name); const busy = cl && ['working', 'background', 'permission'].includes(cl.state);
  const ok = await confirmBox({ title: 'Kill this session?', who: sessWho(name), icon: 'power', ok: 'Kill session', danger: true,
    text: [busy ? 'Claude is in the middle of a turn — that work stops here.' : 'The process stops and the tmux session is closed.', cl ? 'The conversation stays in history; you can resume it from ＋ New session → Resume.' : 'To just hide it, use Close view instead.'] });
  if (!ok) return;
  act('Kill ' + (label || name), api('stop', { session: name })).then(() => dropFrame(name));
}
const fmtTok = n => n >= 1e6 ? (Math.round(n / 1e5) / 10).toString().replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
const ctxPct = c => c && c.window ? Math.min(100, Math.round(c.used / c.window * 100)) : null;
const ctxLvl = p => p == null ? '' : p >= 80 ? 'hot' : p >= 50 ? 'warn' : 'ok';
function ctxRing(pct, size = 18) {
  const ns = 'http://www.w3.org/2000/svg'; const e = document.createElementNS(ns, 'svg'); const r = 7; const C = 2 * Math.PI * r;
  e.setAttribute('viewBox', '0 0 18 18'); e.setAttribute('width', size); e.setAttribute('height', size); e.setAttribute('class', 'ring');
  e.innerHTML = `<circle cx="9" cy="9" r="${r}" class="rg-bg"/><circle cx="9" cy="9" r="${r}" class="rg-fg" stroke-dasharray="${(C * Math.max(pct, 2) / 100).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 9 9)"/>`;
  return e;
}
function ctxMeter(name, cl) {
  const c = cl && cl.ctx; if (!c || !c.used) return null; const p = ctxPct(c);
  return h('button', { class: 'ctxm ' + ctxLvl(p), title: `Context: ${c.used.toLocaleString()} of ${c.window.toLocaleString()} tokens (${p}%)\nClick for compact, clear or a new chat.`, onclick: ev => ctxMenu(ev, name) },
    ctxRing(p), h('b', null, fmtTok(c.used)), h('span', { class: 'of' }, '/ ' + fmtTok(c.window)));
}
const canCompact = cl => !!cl && ['idle', 'needs-you'].includes(cl.state) && (cl.mode === 'chat' || !cl.draft);
const notIdleWhy = cl => cl.draft && cl.mode !== 'chat' ? 'Clear the text typed in the terminal first' : 'Wait until Claude is idle';
function ctxMenu(ev, name) {
  const cl = claudeOf(name); if (!cl) return;
  const c = cl.ctx; const ok = canCompact(cl); const why = ok ? '' : notIdleWhy(cl).toLowerCase();
  openMenu(ev, [
    { header: c ? `Context · ${fmtTok(c.used)} of ${fmtTok(c.window)} · ${ctxPct(c)}%` : 'Context' },
    { label: 'Compact', sub: 'summarise, keep going here', icon: ico('compact', 15), disabled: !ok, title: why || 'Claude replaces the conversation so far with a summary and keeps going in this session; the full history stays in the transcript', onclick: () => compactSession(name) },
    cl.mode !== 'chat' ? { label: 'Clear', sub: 'empty context, same terminal', icon: ico('x', 15), disabled: !ok, title: why || 'starts over with an empty context in this terminal; the old conversation stays in its transcript', onclick: () => clearSession(name) } : null,
    { label: 'New chat here', sub: 'fresh context, this one keeps running', icon: ico('plus', 15), onclick: () => newChatHere(name) },
  ].filter(Boolean));
}
async function sendSlash(name, cmd, doing) {
  const cl = claudeOf(name); if (!cl) return;
  if (!canCompact(cl)) return toast(notIdleWhy(cl), 'err');
  try { await api('send', { session: name, text: cmd }); toast(doing, 'ok'); } catch (e) { toast(cmd + ' failed: ' + e.message, 'err'); }
}
const compactSession = name => sendSlash(name, '/compact', 'Compacting…');
const clearSession = name => sendSlash(name, '/clear', 'Context cleared');
function newChatHere(name) {
  if (!FEAT.session) return newTerminalModal();
  FEAT.session.open('new', '', { here: name });
}
const MODEL_OPTS = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable'], ['default', 'Default']];
const EFFORT_OPTS = ['low', 'medium', 'high', 'xhigh', 'max'].map(e => [e, e]);
const modelAlias = id => { const m = String(id || '').match(/opus|sonnet|haiku|fable/i); return m ? m[0].toLowerCase() : null; };
const canSwitchModel = cl => !!cl && (cl.mode === 'chat' || canCompact(cl));
const MODEL_SUB = { opus: 'deep work', sonnet: 'balanced, faster', haiku: 'quick and cheap', fable: 'frontier', default: 'account default' };
const effortBar = lvl => { const i = EFFORT_OPTS.findIndex(([v]) => v === lvl); return h('span', { class: 'ebar' }, EFFORT_OPTS.map((_, k) => h('i', { class: k <= i ? 'on' : '' }))); };
function modelPicker(name, cl) {
  const chat = cl.mode === 'chat'; const ok = canSwitchModel(cl);
  const why = cl.draft ? 'Clear the text typed in the terminal first' : 'Wait until Claude is idle, then change it';
  const set = async (body, what) => {
    try { await api('claude-model', { session: name, ...body }); toast(what, 'ok'); } catch (e) { toast('Change failed: ' + e.message, 'err'); }
  };
  const note = chat ? 'from the next message, the conversation stays' : 'typed into the terminal';
  const open = (ev, items) => { if (!ok) return toast(why, 'err'); openMenu(ev, items); };
  const curM = modelAlias(cl.model) || (cl.model ? null : 'default');
  const modelMenu = ev => open(ev, [{ header: 'Model · ' + note },
    ...MODEL_OPTS.map(([v, l]) => ({ label: l, sub: MODEL_SUB[v], icon: v === curM ? ico('check', 14) : '', cur: v === curM, onclick: () => v !== curM && set({ model: v }, 'model ' + l) }))]);
  const effortMenu = ev => open(ev, [{ header: 'Effort · ' + note },
    ...EFFORT_OPTS.map(([v]) => ({ el: h('div', { class: 'mi' + (v === cl.effort ? ' cur' : ''), onclick: () => { closeMenu(); if (v !== cl.effort) set({ effort: v }, 'effort ' + v); } },
      h('span', { class: 'ico' }, v === cl.effort ? ico('check', 14) : ''), h('span', { class: 'k' }, v), effortBar(v)) }))]);
  const tip = ok ? '' : ' — ' + why.toLowerCase();
  return h('span', { class: 'mpick' + (ok ? '' : ' off') },
    h('button', { class: 'mpill', title: 'model: ' + (cl.model || 'default') + tip, onclick: modelMenu }, ico('chip', 14), h('span', { class: 'ml' }, modelName(cl.model) || 'Default'), ico('chevronDown', 11)),
    h('button', { class: 'mpill epill', title: 'effort: ' + (cl.effort || 'unknown') + tip, onclick: effortMenu }, ico('brain', 14), h('span', { class: 'ml' }, cl.effort || 'effort'), cl.effort ? effortBar(cl.effort) : null, ico('chevronDown', 11)));
}
function sessMenu(ev, name) {
  const sess = S.runtime.sessions.find(s => s.name === name); const cl = sess && sess.claude; const chat = cl && cl.mode === 'chat';
  const idle = cl && ['idle', 'needs-you'].includes(cl.state); const logOn = chat && TERM.view[name] === 'term';
  const c = cl && cl.ctx; const muted = (S.settings.muted || []).includes(name);
  const mac = copyAttach(name);
  openMenu(ev, [
    cl ? { label: 'New chat here', sub: [sess.project && byId()[sess.project]?.name, acct(cl.account)].filter(Boolean).join(' · '), icon: ico('plus', 15), onclick: () => newChatHere(name) } : null,
    cl ? { label: 'Compact context', sub: c ? fmtTok(c.used) + ' · ' + ctxPct(c) + '%' : '', icon: ico('compact', 15), disabled: !canCompact(cl), title: idle ? 'summarise the conversation and continue with a smaller context' : 'only when Claude is idle', onclick: () => compactSession(name) } : null,
    cl ? { label: 'Rename…', icon: ico('pencil', 15), onclick: () => renameDialog(name) } : null,
    chat && FEAT.session?.move ? { label: 'Move to folder…', icon: ico('folder', 15), disabled: !idle, title: 'same conversation, Claude continues in another project or folder (only when idle)', onclick: () => FEAT.session.move(name) } : null,
    cl && cl.hooked ? { label: muted ? 'Unmute notifications' : 'Mute notifications', icon: ico(muted ? 'bell' : 'bellOff', 15), onclick: () => api('claude-mute', { session: name, muted: !muted }).then(r => toast(r.muted.includes(name) ? 'muted' : 'unmuted')).catch(e => toast(e.message, 'err')) } : null,
    ...feat('sessMenu', name, sess, cl),
    'sep',
    chat ? { label: logOn ? 'Back to chat' : 'Runner log', icon: ico(logOn ? 'chat' : 'log', 15), onclick: () => setMode(logOn ? 'chat' : 'term') } : null,
    sess && !IS_PHONE ? { label: 'Copy attach command', sub: mac, icon: ico('copy', 15), onclick: () => navigator.clipboard.writeText(mac).then(() => toast('copied')) } : null,
    IS_PHONE ? null : { label: 'Open in new tab', icon: ico('ext', 15), onclick: () => openTermTab(name) },
    { label: 'Close view', sub: 'keeps running', icon: ico('x', 15), onclick: () => dropFrame(name) },
    sess ? 'sep' : null,
    sess ? { label: 'Kill session', icon: ico('power', 15), danger: true, onclick: () => killSession(name) } : null,
  ].filter(Boolean).filter((x, i, a) => x !== 'sep' || (i > 0 && a[i - 1] !== 'sep' && i < a.length - 1)));
}
const home = c => (c || '').replace(/^\/home\/[^/]+\//, '~/');
// The command that attaches to a tmux session from another machine (needs the ssh alias from Settings).
// Display name of a Claude account id ('personal' | 'company') — Settings → Accounts.
const acct = a => (a && S.settings?.accountLabels?.[a]) || a || '';
const acctL = a => acct(a).toLowerCase();
const multiAcct = () => (S.host?.accounts?.length ?? 2) > 1;
const attachCmd = name => `ssh ${S.settings?.sshHost || S.host?.hostname || 'server'} -t tmux attach -t ${name}`;
const copyAttach = name => { const t = S.settings?.claudeAttach; const host = S.settings?.sshHost || S.host?.hostname || 'server'; if (t && name.startsWith('claude-')) return t.replace('{c}', name.endsWith('-company') ? '-c ' : '').replace('{name}', name.replace(/^claude-/, '').replace(/-company$/, '')); return S.settings?.attachVia === 'mosh' ? `mosh ${host} -- tmux attach -t ${name}` : attachCmd(name); };
// health from the server probe: ok (2xx-4xx) · warn (5xx / no answer) · down (nothing accepts the connection) · tcp (up, not HTTP)
function healthOf(port) { return (S.health || {})[port] || null; }
function healthTitle(hh) { if (!hh) return ''; return hh.state === 'ok' ? `HTTP ${hh.status} · ${hh.ms} ms` : hh.state === 'warn' ? (hh.status ? `HTTP ${hh.status}` : hh.note || 'no answer') : hh.state === 'tcp' ? `accepts connections (not HTTP) · ${hh.ms} ms` : 'DOWN — nothing answers on this port'; }
const AUTO_EXPOSE_WARN = 'Auto-expose forwards every loopback port your projects listen on to the Tailscale IP, so every device on your tailnet can reach it. Databases, caches, Docker loopback ports and Chrome debug ports are never auto-exposed. Turn it on?';
function exposeChip(ev, p) { ev.preventDefault(); if (!confirm(`Expose :${p.port} (${p.addr}) on the Tailscale IP? Every device on your tailnet can reach it until you remove it in Tunnels.`)) return; api('expose', { port: p.port }).then(r => toast(r.note || `exposed ${p.port}`, 'ok')).catch(e => toast('expose failed: ' + e.message, 'err')); }
function portChip(p, extraTitle) { const hh = healthOf(p.port); const ok = reachable(p); return h('a', { href: portUrl(p.port), target: '_blank', title: (ok ? 'open ' + portUrl(p.port) : 'loopback only — click to expose it on the tailnet') + (hh ? '\n' + healthTitle(hh) : '') + (extraTitle || ''), class: (ok ? '' : 'lo') + (hh ? ' h-' + hh.state : ''), onclick: ev => { ev.stopPropagation(); if (!ok) exposeChip(ev, p); } }, hh ? h('i', { class: 'hd' }) : null, ':' + p.port); }
const portLinksOf = ports => ports?.length ? h('span', { class: 'ports' }, ports.map(p => portChip(p))) : null;
// A compact, uniform card: who (name · #n / worktree · account), where (branch · model · cost), and ONE status line —
// what the session is doing, or a one-line recap of why it needs you. The whole card opens the terminal;
// prompting, kill, mute, handoff and restart live in the terminal bar.
const oneLine = (t, n = 160) => { t = String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]+/g, '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// "2 background agents — fork: Reading tests.py · 26m 28s" (what the pane's agent footer shows)
function bgText(bg) {
  if (!bg) return 'waiting on a background task';
  const head = bg.n + ' background ' + bg.kind + (bg.n > 1 ? 's' : '') + ' running';
  const a = bg.agents && bg.agents[0];
  return a ? head + ' — ' + a.name + (a.doing ? ': ' + a.doing : '') + ' · ' + a.age + (bg.agents.length > 1 ? ' +' + (bg.agents.length - 1) : '') : head;
}
// mise install (Omarchy): Claude Code only says "Run: mise upgrade claude" — do that, then restart this session (it = null: just install).
// One at a time: the download takes a while, and every extra click used to queue one more restart of the session.
async function updateClaude(it) {
  const v = S.claude?.update?.version; if (!v) return;
  if (CLAUDE_UPGRADING) { toast('mise upgrade claude is still running…'); return; }
  if (!confirm(`Update Claude Code to ${v}${it ? ` and restart ${it.name}` : ''}?\n\nRuns mise upgrade claude${it ? ', then /exit and a relaunch with --resume on the same conversation' : ''}. Other sessions get a restart button. Takes up to a minute.`)) return;
  CLAUDE_UPGRADING = true; renderTermPanel();
  toast('mise upgrade claude …');
  const r = await act('mise upgrade claude → ' + v, api('claude-upgrade', {})).catch(() => null);
  CLAUDE_UPGRADING = false; renderTermPanel();
  if (it && r?.ok) act('Restart ' + (it.project || it.name), api('claude-restart', { session: it.name }));
}
async function restartSession(it) {
  if (!await confirmBox({ title: 'Restart Claude?', who: sessWho(it.name), icon: 'refresh', ok: 'Restart', text: 'It sends /exit, waits, then relaunches with --resume on the same conversation (picks up the installed update). Takes ~10 s.' })) return;
  act('Restart ' + it.project, api('claude-restart', { session: it.name }));
}
async function restartIdleTerms(btn, names) {
  if (!confirm(`Restart Claude in ${names.length} idle terminal session${names.length > 1 ? 's' : ''}?\n\n${names.join('\n')}\n\nEach one gets /exit, then claude --resume on the same conversation, one after another (~10 s each).`)) return;
  btn.disabled = true; let ok = 0;
  for (const name of names) {
    const cl = claudeOf(name);
    if (!cl || !['idle', 'needs-you'].includes(cl.state) || cl.draft) continue;
    try { await api('claude-restart', { session: name, ifIdle: true }); ok++; } catch (e) { toast(`${name}: ${e.message === 'busy' ? 'busy, skipped' : e.message}`, 'err'); }
  }
  toast(`Restarted ${ok} of ${names.length}`, ok ? 'ok' : 'err');
}
async function switchSession(name, to) {
  try {
    await api('claude-switch', { session: name, to });
    if (to === 'term') TERM.forceTerm.add(name); else { TERM.forceTerm.delete(name); delete TERM.view[name]; }
    toast(to === 'term' ? 'Opening the conversation in the terminal (claude --resume)…' : 'Continuing in chat…', 'ok');
    setTimeout(() => { renderTermPanel(true); renderChatPane(true); }, 1500);
  } catch (e) { toast(e.message === 'busy' ? 'Busy — wait for the turn to end or Stop first' : 'Switch failed: ' + e.message, 'err'); }
}
async function handoff(it) {
  const to = it.account === 'company' ? 'personal' : 'company';
  if (!await confirmBox({ title: `Hand off to ${to}?`, who: sessWho(it.name), ok: 'Hand off', text: [`Starts a ${to} session in the same folder with a handoff summary (recent prompts, last reply, files edited).`, 'This session stays as it is.'] })) return;
  act('Hand off ' + it.project, api('handoff', { session: it.name })).then(r => { if (r && r.name) setTimeout(() => openTerm(r.name), 1500); });
}
function renderTermStrip() {
  const el = $('#termstrip'); if (!el) return;
  el.innerHTML = '';
  const ss = scheduledStrip(); if (ss) el.append(ss);
  const rs = $('#recap-sec'); if (rs) rs.replaceChildren(recapStrip()); else el.append(recapStrip());
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
    h('h2', { class: 'tstitle run' }, 'Running', h('span', { class: 'n' }, counts.all)),
    h('span', { class: 'chips sm' }, chip('all', 'All'), chip('dev', 'Dev servers'), chip('proc', 'Processes'), chip('docker', 'Containers'), chip('shell', 'Shells')),
    h('span', { class: 'sp' }),
    h('label', { class: 'dim', style: 'font-size:12px;display:inline-flex;gap:6px;align-items:center;cursor:pointer' }, h('input', { type: 'checkbox', checked: RUN.stopped, onchange: e => { RUN.stopped = e.target.checked; renderRunning(); } }), 'stopped containers'),
    counts.dev ? h('button', { class: 'btn sm danger', title: 'stop every dev server started from the dashboard', onclick: async () => { if (!confirm('Stop all ' + counts.dev + ' dev servers?')) return; for (const r of rows.filter(r => r.kind === 'dev')) await act('Stop ' + r.what, api('stop', { session: r.session })); } }, gl('■ Stop all dev')) : null));
  if (!shown.length) { el.append(h('div', { class: 'tsempty' }, rows.length ? 'Nothing of this kind.' : 'Nothing running. Start a dev server from ', h('a', { href: '#', onclick: ev => { ev.preventDefault(); setView('projects'); } }, 'Projects'), ' (▶) or open a shell.')); return; }
  const tbl = h('table', { class: 'runtbl' },
    h('thead', null, h('tr', null, h('th', { class: 'ck' }), h('th', { class: 'cname' }, 'Project'), h('th', { class: 'cwhat' }, 'What'), h('th', { class: 'ccmd' }, 'Command'), h('th', null, 'Ports'), h('th', { class: 'num' }, 'CPU'), h('th', { class: 'num' }, 'Mem'), h('th', { class: 'num' }, 'Up'), h('th', { class: 'cact' }))),
    h('tbody', null, shown.map(r => h('tr', { class: 'rr ' + r.kind + (r.dead ? ' dead' : ''), style: `--org:${orgColor(r.org)}`, title: r.title || (r.id ? 'open project details' : ''), onclick: ev => { if (ev.target.closest('a,button')) return; if (r.id) openDrawer(r.id, r.kind === 'docker' ? 'docker' : 'logs', r.session || null); } },
      h('td', { class: 'ck' }, h('span', { class: 'kd ' + r.kind, title: KIND[r.kind][1] }, gico(KIND[r.kind][0], 14))),
      h('td', { class: 'cname' }, h('span', { class: 'sw' }), h('b', null, r.name), r.org ? h('span', { class: 'org' }, r.org) : null),
      h('td', { class: 'cwhat' }, h('span', { class: 'what ' + r.kind }, r.what)),
      h('td', { class: 'ccmd mono', title: r.cmd }, r.cmd),
      h('td', { class: 'cports' }, portLinksOf(r.ports)),
      h('td', { class: 'num mono' }, r.cpu == null ? '' : r.cpu.toFixed(0) + '%'),
      h('td', { class: 'num mono' }, r.mem == null ? '' : fmtB(r.mem)),
      h('td', { class: 'num mono' }, r.since ? ago(r.since) : ''),
      h('td', { class: 'cact' }, r.actions.map(([l, t, f, cls]) => h('button', { class: 'btn sm ' + (cls || 'ghost'), title: t, onclick: ev => { ev.stopPropagation(); f(); } }, gl(l))))))));
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
      h('h3', null, gl('⇄ Exposed ports (socat → '), h('span', { class: 'mono', id: 'tun-ip' }, S.host.tsIp || '?'), ')', h('span', { class: 'sp' }),
        h('label', { class: 'sw-row', style: 'margin:0;font-size:12px;color:var(--muted)' }, h('input', { type: 'checkbox', id: 'tun-auto', checked: S.settings.autoExpose, onchange: e => { if (e.target.checked && !confirm(AUTO_EXPOSE_WARN)) { e.target.checked = false; return; } api('settings', { autoExpose: e.target.checked }).then(() => toast('autoExpose ' + (e.target.checked ? 'on' : 'off'))); } }), 'auto-expose loopback ports'),
        h('button', { class: 'btn sm', onclick: () => act('Rebuild tunnels', api('expose-rebuild', {})) }, gl('↻ Rebuild all')),
        h('button', { class: 'btn sm ghost', onclick: () => { UI.showTunnels = false; renderTunnels(); } }, gl('✕'))),
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
  for (const e of ex) { shown.add(e.port); rows.append(h('div', { class: 'row' }, h('a', { href: portUrl(e.port), target: '_blank' }, `${e.bind}:${e.port}`), h('span', { class: 'arrow' }, '→'), h('span', null, e.target || '127.0.0.1:' + e.port), manual.has(e.port) ? h('span', { class: 'badge tag' }, 'manual') : h('span', { class: 'badge tag' }, 'auto'), h('span', { style: 'flex:1' }), h('span', { class: 'dim' }, 'pid ' + e.pid), h('button', { class: 'btn sm danger', title: manual.has(e.port) ? 'stop forwarding' : 'stop forwarding and never auto-expose this port again', onclick: () => act('Remove ' + e.port, api('unexpose', { pid: e.pid, port: manual.has(e.port) ? e.port : null, deny: manual.has(e.port) ? null : e.port })) }, 'remove'))); }
  for (const m of (S.runtime.manual || [])) if (!shown.has(m.port)) rows.append(h('div', { class: 'row' }, h('span', { class: 'dim' }, `${S.host.tsIp}:${m.port}`), h('span', { class: 'arrow' }, '→'), h('span', { class: 'dim' }, `${m.addr}:${m.port}`), h('span', { class: 'badge tag' }, 'manual · pending'), h('span', { style: 'flex:1' }), h('span', { class: 'dim' }, 'already reachable directly, or starting…'), h('button', { class: 'btn sm danger', onclick: () => act('Remove ' + m.port, api('unexpose', { port: m.port })) }, 'remove')));
  const deny = S.settings.exposeDeny || []; if (deny.length) rows.append(h('div', { class: 'row' }, h('span', { class: 'dim' }, 'Never auto-exposed: ' + deny.join(', ')), h('span', { style: 'flex:1' }), h('button', { class: 'btn sm', onclick: () => act('Auto-expose allowed again', api('settings', { exposeDeny: [] })) }, 'clear')));
  $('#tun-other').textContent = S.runtime.otherPorts.length ? 'Other listening ports: ' + S.runtime.otherPorts.map(p => `${p.addr}:${p.port}${p.proc ? ' (' + p.proc + ')' : ''}`).join(', ') : '';
}
function renderBanner() {
  const el = $('#banner'); if (!el) return; const lr = S.host.lastResume; const ts = S.host.tailscale;
  const parts = [];
  if (lr && Date.now() - lr < 6 * 3600e3 && localStorage.getItem('bd.dismissResume') !== String(lr)) parts.push(h('div', { class: 'ban' }, h('b', null, ico('clock', 14), ' The server woke up ' + ago(lr) + ' ago.'), ' Sessions, containers and forwards on the server are still here. On your laptop: reconnect VS Code (Reload Window) / restart your tunnel if you use one.', h('span', { style: 'flex:1' }), h('button', { class: 'btn sm', onclick: () => act('Recover', api('recover', {})) }, gl('↻ Recover forwards')), h('button', { class: 'btn sm ghost', onclick: () => { localStorage.setItem('bd.dismissResume', String(lr)); renderBanner(); } }, gl('✕'))));
  for (const c of (S.host.stateErrors || [])) parts.push(h('div', { class: 'ban err' }, h('b', null, ico('alert', 14), ' ' + c.file.split('/').pop() + ' was not valid JSON'), ` — the dashboard started with defaults for it. The original is kept as ${c.savedAs}; fix it there and move it back, then restart beast-dash.`));
  const cv = S.host.claudeVer;
  if (cv && (cv.error || cv.pin)) {
    const recheck = h('button', { class: 'btn sm', disabled: cv.checking, onclick: () => act('Check Claude ' + cv.current, api('claude-version', { op: 'recheck' })) }, cv.checking ? 'checking…' : gl('↻ Check again'));
    const unpin = h('button', { class: 'btn sm', onclick: () => act('Unpin Claude', api('claude-version', { op: 'pin', version: null })) }, 'Unpin');
    if (cv.error) parts.push(h('div', { class: 'ban err' }, h('span', null, h('b', null, gl(`⚠ Claude Code ${cv.current} failed the start check`)),
      cv.using ? ` — chat sessions run on ${cv.using}. Terminal sessions use ${cv.current}. ` : ' — no earlier working version is kept, chat sessions may not start. ', h('span', { class: 'dim mono', style: 'font-size:11.5px' }, cv.error)),
      h('span', { style: 'flex:1' }), recheck, cv.pin ? unpin : h('button', { class: 'btn sm ghost', title: 'run chat sessions on this version even though the check failed', onclick: () => act('Use Claude ' + cv.current, api('claude-version', { op: 'pin', version: cv.current })) }, `Use ${cv.current} anyway`)));
    else parts.push(h('div', { class: 'ban' }, h('span', null, h('b', null, gl(`📌 Chat sessions are pinned to Claude Code ${cv.pin}`)), cv.current && cv.current !== cv.pin ? ` (installed: ${cv.current})` : ''), h('span', { style: 'flex:1' }), unpin));
  }
  const newVer = cv && !cv.error && !cv.checking && cv.current && cv.using === cv.current ? cv.current : null;
  const oldTerms = newVer ? S.runtime.sessions.filter(x => x.claude && x.claude.mode !== 'chat' && x.claude.sessionId && x.claude.version && x.claude.version !== newVer) : [];
  if (oldTerms.length && localStorage.getItem('bd.dismissOldTerms') !== newVer) {
    const idle = oldTerms.filter(x => ['idle', 'needs-you'].includes(x.claude.state) && !x.claude.draft);
    const roll = S.host.chatRoll;
    parts.push(h('div', { class: 'ban' }, h('span', null, h('b', null, gl(`✦ Claude Code ${newVer}`)), roll && roll.version === newVer && roll.done ? ` — ${roll.done} chat session${roll.done > 1 ? 's' : ''} moved over.` : '', ` ${oldTerms.length} terminal session${oldTerms.length > 1 ? 's' : ''} still run an older version${idle.length < oldTerms.length ? ` (${oldTerms.length - idle.length} busy or with a draft)` : ''}.`),
      h('span', { style: 'flex:1' }),
      idle.length ? h('button', { class: 'btn sm', title: idle.map(x => x.name).join('\n'), onclick: e => restartIdleTerms(e.currentTarget, idle.map(x => x.name)) }, gl(`↻ Restart ${idle.length} idle`)) : null,
      h('button', { class: 'btn sm ghost', title: 'dismiss until the next version', onclick: () => { localStorage.setItem('bd.dismissOldTerms', newVer); renderBanner(); } }, gl('✕'))));
  }
  if (ts && ts.online === false) parts.push(h('div', { class: 'ban err' }, h('b', null, gl('⚠ Tailscale is offline on the server')), ' (' + (ts.backend || '') + '). ' + (ts.health || []).join(' ')));
  // dev servers started from the dashboard that died with a non-zero exit in the last 15 minutes
  for (const c of (S.crashes || [])) { const p = byId()[c.project]; parts.push(h('div', { class: 'ban err' }, h('b', null, ico('play', 13), ` ${p ? p.name : c.project} · ${c.name.split('__')[1] || c.name} exited ${c.exitCode}`), h('span', { class: 'dim mono', style: 'font-size:11.5px' }, ` ${ago(c.endedAt)} ago · ${c.cmd || ''}`), h('span', { style: 'flex:1' }),
    p ? h('button', { class: 'btn sm', onclick: () => openDrawer(p.id, 'logs', c.name) }, gl('☰ Logs')) : null, p ? h('button', { class: 'btn sm primary', onclick: () => act('Restart ' + c.name, api('restart', { session: c.name })) }, gl('↻ Restart')) : null,
    h('button', { class: 'btn sm ghost', title: 'dismiss', onclick: () => api('dismiss-crash', { key: c.name + c.endedAt }) }, gl('✕')))); }
  // Claude sessions that existed but whose tmux session is gone (reboot / tmux kill): bring them back with --resume
  const rs = (S.claude?.restorable || []);
  if (rs.length) parts.push(h('div', { class: 'ban restore' },
    h('b', null, ico('sparkle', 14), ` ${rs.length} Claude session${rs.length > 1 ? 's' : ''} from before the restart`), h('span', { class: 'dim' }, ' — same folder, same conversation (claude --resume):'),
    h('span', { class: 'rlist' }, rs.map(r => h('span', { class: 'rchip', title: (r.title || '') + '\n' + r.cwd + '\ngone ' + ago(r.gone) + ' ago' },
      h('button', { class: 'btn sm', onclick: () => act('Restore ' + r.tmux, api('claude-restore', { tmux: r.tmux })).then(() => openTerm(r.tmux)) }, gl('↺ '), r.tmux.replace(/^claude-/, ''), r.account === 'company' ? h('span', { class: 'badge tag acc company' }, acct('company')) : null),
      h('button', { class: 'x', title: 'forget this one', onclick: () => api('claude-forget', { tmux: r.tmux }) }, gl('✕'))))),
    h('span', { style: 'flex:1' }),
    h('button', { class: 'btn sm primary', onclick: () => act('Restore all', api('claude-restore', {})) }, gl('↺ Restore all')),
    h('button', { class: 'btn sm ghost', title: 'forget all', onclick: () => { if (confirm('Forget these sessions? (they stay in claude --resume history, just not here)')) for (const r of rs) api('claude-forget', { tmux: r.tmux }); } }, gl('✕'))));
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
    h('button', { class: 'branch', title: 'switch branch', onclick: ev => branchMenu(ev, target) }, h('span', { class: 'ico' }, ico('branch', 13)), h('span', { class: 'b' }, g.branch), h('span', { class: 'caret' }, '▾')),
    g.dirty + g.untracked ? h('span', { class: 'dirty', title: `${g.dirty} modified, ${g.untracked} untracked` }, '● ' + (g.dirty + g.untracked)) : null,
    g.ahead ? h('span', { class: 'ab', title: 'ahead' }, '↑' + g.ahead) : null, g.behind ? h('span', { class: 'ab behind', title: 'behind' }, '↓' + g.behind) : null,
    g.stashes ? h('span', { class: 'stash', title: 'stashes' }, [ico('layers', 12), ' ' + g.stashes]) : null,
    g.last ? h('span', { class: 'last', title: g.last.subject }, h('b', null, g.last.hash), ' ', g.last.subject, ' · ', g.last.rel) : null);
}
function portLinks(ports) { return h('span', { class: 'ports' }, ports.filter(p => !p.ephemeral).map(p => portChip(p))); }
function runRows(p) {
  const r = runtimeFor(p.id); const rows = [];
  for (const s of r.sessions) rows.push(h('div', { class: 'run' + (s.name.startsWith('claude-') ? ' claude' : '') }, h('span', { class: 'dot' }), h('span', { class: 'lbl' }, s.name.startsWith('claude-') ? (s.name.endsWith('-company') ? 'Claude · company' : 'Claude · personal') : s.label), h('span', { class: 'cmd', title: s.cmd || s.current }, s.cmd || s.current), portLinks(s.ports), h('span', { class: 'res' }, `${s.cpu.toFixed(0)}% · ${fmtB(s.mem)} · ${ago(s.startedAt)}`),
    h('span', { class: 'acts' }, h('button', { class: 'btn sm', title: 'open live terminal (tmux attach in browser)', onclick: () => openTerm(s.name) }, gl('⌨')), h('button', { class: 'btn sm', title: 'logs', onclick: () => openDrawer(p.id, 'logs', s.name) }, gl('☰')), s.managed ? h('button', { class: 'btn sm', title: 'restart', onclick: () => act('Restart ' + s.label, api('restart', { session: s.name })) }, gl('↻')) : null, h('button', { class: 'btn sm danger', title: 'stop (Ctrl-C, then kill)', onclick: () => act('Stop ' + s.label, api('stop', { session: s.name })) }, gl('■')))));
  for (const e of r.external) rows.push(h('div', { class: 'run ext', title: 'started outside beast-dash (pid ' + e.pid + ') — no log capture; attach via ssh' }, h('span', { class: 'dot' }), h('span', { class: 'lbl' }, e.label || e.comm), h('span', { class: 'cmd', title: e.cmd }, e.cmd), portLinks(e.ports), h('span', { class: 'res' }, `${e.cpu.toFixed(0)}% · ${fmtB(e.mem)}`),
    h('span', { class: 'acts' }, h('button', { class: 'btn sm danger', title: 'kill', onclick: () => confirm(`Kill pid ${e.pid} (${e.comm})? It was started outside the dashboard.`) && act('Kill ' + e.pid, api('kill', { pid: e.pid })) }, gl('■')))));
  for (const c of r.containers) rows.push(h('div', { class: 'run docker' + (c.state === 'running' ? '' : ' dead') }, h('span', { class: 'dot' }), h('span', { class: 'lbl' }, c.service || c.name), h('span', { class: 'cmd' }, c.image + ' · ' + c.status), c.state === 'running' ? portLinks([...new Map(c.ports.filter(x => x.host).map(x => [x.host, { port: x.host, addr: x.hostIp, loopback: x.hostIp === '127.0.0.1' || x.hostIp === '::1' }])).values()]) : null,
    h('span', { class: 'acts' }, h('button', { class: 'btn sm', title: 'logs', onclick: () => openDrawer(p.id, 'logs', 'docker:' + c.id) }, gl('☰')), c.state === 'running' ? h('button', { class: 'btn sm danger', title: 'stop', onclick: () => act('Stop ' + c.name, api('docker', { id: c.id, action: 'stop' })) }, gl('■')) : h('button', { class: 'btn sm', title: 'start', onclick: () => act('Start ' + c.name, api('docker', { id: c.id, action: 'start' })) }, gl('▶')))));
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
    ...claudes.map(s => h('button', { class: 'lchip cl st-' + (s.claude?.state || 'unknown'), title: `${s.name} · ${STATE_LABEL[s.claude?.state] || ''}${s.claude?.title ? ' — ' + s.claude.title : ''}`, onclick: () => openTerm(s.name) }, h('i', { class: 'd' }), 'Claude', multiAcct() ? h('span', { class: 'badge tag acc ' + (s.claude?.account || (s.name.endsWith('-company') ? 'company' : 'personal')) }, acct(s.claude?.account || (s.name.endsWith('-company') ? 'company' : 'personal'))) : null)),
    ...devs.map(s => h('button', { class: 'lchip dev', title: (s.cmd || s.current || '') + ' · logs', onclick: () => openDrawer(p.id, 'logs', s.name) }, h('i', { class: 'd' }), s.label, ...(s.ports || []).filter(x => !x.ephemeral).slice(0, 2).map(x => portChip(x)))),
    ...r.external.map(e => h('span', { class: 'lchip ext', title: e.cmd }, h('i', { class: 'd' }), e.label || e.comm, ...(e.ports || []).filter(x => !x.ephemeral).slice(0, 2).map(x => portChip(x)))),
    conts.length ? h('button', { class: 'lchip dock', title: conts.map(c => c.service || c.name).join(', '), onclick: () => openDrawer(p.id, 'docker') }, h('i', { class: 'd' }), `${conts.length} container${conts.length > 1 ? 's' : ''}`) : null) : null;
  const gitLine = !g ? null : g.error ? h('div', { class: 'gitrow' }, h('span', { style: 'color:var(--red)' }, g.error)) : h('div', { class: 'gitrow' },
    h('button', { class: 'branch', title: 'switch branch', onclick: ev => branchMenu(ev, target) }, h('span', { class: 'ico' }, ico('branch', 13)), h('span', { class: 'b' }, g.branch), h('span', { class: 'caret' }, '▾')),
    g.dirty + g.untracked ? h('button', { class: 'dirty', title: `${g.dirty} modified, ${g.untracked} untracked — open changes`, onclick: () => openDrawer(p.id, 'changes') }, '● ' + (g.dirty + g.untracked)) : null,
    g.ahead ? h('span', { class: 'ab', title: 'ahead of upstream' }, '↑' + g.ahead) : null, g.behind ? h('span', { class: 'ab behind', title: 'behind upstream — pull' }, '↓' + g.behind) : null,
    g.last ? h('span', { class: 'last', title: g.last.subject }, g.last.subject, h('i', null, ' · ' + g.last.rel)) : null);
  const startBtn = pc ? h('div', { class: 'split' },
    h('button', { class: 'btn sm', disabled: running.has(pc.name), title: pc.cmd, onclick: () => { noteBundle(p, { kind: 'cmd', name: pc.name }); act(`${p.name}: ${pc.name}`, api('run', { id: p.id, name: pc.name })); } }, gl('▶ '), pc.name),
    h('button', { class: 'btn sm', title: 'all commands', onclick: ev => cmdMenu(ev, p) }, h('span', { class: 'caret' }, '▾'))) : (p.commands.length ? h('button', { class: 'btn sm', onclick: ev => cmdMenu(ev, p) }, gl('▶ Run '), h('span', { class: 'caret' }, '▾')) : null);
  return h('div', { class: 'card' + (live ? ' live' : '') + (p.parent ? ' sub' : ''), style: `--org:${orgColor(p.org)};--pc:${projColor(p)}`, 'data-id': p.id },
    h('div', { class: 'head' }, avatar(p.id, 'lg'),
      h('div', { class: 'hd' },
        h('div', { class: 'name', onclick: () => openDrawer(p.id, 'overview') }, p.parent ? h('span', { class: 'crumb' }, p.parentName) : null, h('span', { class: 'nm' }, p.name)),
        h('div', { class: 'kind' }, h('span', { class: 'badge ' + p.primary }, p.primary), p.framework ? h('span', { class: 'fw' }, p.framework) : null, p.pm ? h('span', { class: 'fw dim' }, p.pm) : null)),
      h('button', { class: 'btn sm icon ghost', title: 'more', onclick: ev => moreMenu(ev, p) }, ico('dots', 16))),
    gitLine, liveRow,
    (() => { const c = feat('cardChips', p); return c.length ? h('div', { class: 'feat-chips' }, c) : null; })(),
    h('div', { class: 'actions' },
      h('button', { class: 'btn sm claude' + (claudes.length ? ' on' : ''), title: `Claude Code session (${acctL('personal')} / ${acctL('company')})`, onclick: ev => claudeMenu(ev, p) }, ico('chat', 14), 'Claude', h('span', { class: 'caret' }, '▾')),
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
  main.append(...feat('projectsTop'));
  const orgs = [...new Set(shown.map(p => p.org))];
  for (const org of orgs) {
    const ps = shown.filter(p => p.org === org);
    const live = ps.filter(p => isLive(p.id)).length; const collapsed = UI.collapsed[org] && !UI.q && UI.filter === 'all';
    const section = h('section', { class: 'group', style: `--org:${orgColor(org)}` });
    section.append(h('div', { class: 'ghead' }, h('h2', null, h('span', { class: 'sw' }), ...feat('orgBadge', org, ps), org), h('span', { class: 'meta' }, `${ps.length} projects${live ? ` · ${live} live` : ''}`), h('span', { class: 'sp' }), ...feat('orgActions', org, ps), h('a', { class: 'btn sm ghost vsc', href: vscodeUrl(S.host.devRoot + '/' + org), title: 'open org folder in VS Code' }, vscIcon(), ' folder'), h('button', { class: 'btn sm ghost', onclick: () => { UI.collapsed[org] = !UI.collapsed[org]; localStorage.setItem('bd.collapsed', JSON.stringify(UI.collapsed)); render(); } }, collapsed ? '▸ expand' : '▾ collapse')));
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
  const anchor = ev.currentTarget;
  if (anchor && anchor === UI.menuShut && Date.now() - UI.menuShutAt < 700) { UI.menuShut = null; return; }
  UI.menuAnchor = anchor;
  const m = $('#menu'); m.innerHTML = ''; m.classList.remove('hidden'); UI.menuOpen = true;
  for (const it of items) {
    if (it === 'sep') { m.append(h('div', { class: 'sep' })); continue; }
    if (it.header) { m.append(h('div', { class: 'mh' }, it.header)); continue; }
    if (it.el) { m.append(it.el); continue; }
    m.append(h('div', { class: 'mi' + (it.cur ? ' cur' : '') + (it.disabled ? ' dis' : '') + (it.danger ? ' danger' : ''), title: it.title, onclick: () => { closeMenu(); it.onclick?.(); } }, h('span', { class: 'ico' }, gico(it.icon || '')), h('span', { class: 'k' }, it.label), it.sub ? h('span', { class: 'c' }, it.sub) : null));
  }
  const r = ev.currentTarget.getBoundingClientRect(), pad = 8;
  m.style.left = m.style.top = '0px'; m.style.maxWidth = Math.min(440, innerWidth - pad * 2) + 'px'; m.style.maxHeight = Math.min(innerHeight * .7, innerHeight - pad * 2) + 'px';
  const w = m.offsetWidth, mh = m.offsetHeight, x = r.left + w > innerWidth - pad ? r.right - w : r.left;
  m.style.left = Math.max(pad, Math.min(x, innerWidth - w - pad)) + 'px';
  const below = r.bottom + 6, above = r.top - mh - 6;
  m.style.top = Math.max(pad, below + mh > innerHeight - pad && above >= pad ? above : Math.min(below, innerHeight - mh - pad)) + 'px';
  setTimeout(() => document.addEventListener('mousedown', onDocDown, { once: true }), 0);
}
function onDocDown(e) { if (!$('#menu').contains(e.target)) { if (UI.menuAnchor && UI.menuAnchor.contains(e.target)) { UI.menuShut = UI.menuAnchor; UI.menuShutAt = Date.now(); } closeMenu(); } else setTimeout(() => document.addEventListener('mousedown', onDocDown, { once: true }), 0); }
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
    ...feat('projectMenu', p),
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
  const d = $('#drawer'); const name = SESS.name; if (!name) return; const s = S.runtime.sessions.find(x => x.name === name); const cl = s?.claude || {};
  liveStream(liveWanted());
  if (!full) { // poll: only the conversation body, only if the transcript changed
    const body = d.querySelector('.db.sess'); if (!body || SESS.tab !== 'transcript' || SESS.inflight) return;
    const req = SESS.req = (SESS.req || 0) + 1; SESS.inflight = req;
    const t = await transcriptOf(name, SESS.n);
    if (SESS.inflight === req) SESS.inflight = 0;
    if (req !== SESS.req || SESS.name !== name) return;
    chatOffline(body, !t); if (!t) return;
    if (document.body.classList.contains('recording')) return;   // same as the chat pane: not while recording
    const key = [name, t.sig, t.total, cl.state, cl.lastTool, SESS.n, (PENDING[name] || []).length, queuedKey(name), (cl.status || '').split(' (')[0], t.pending || '', menuKey(cl.menu), liveKey(name)].join(':'); if (SESS.key === key) { const st = body.querySelector('.ag-status'); if (st && cl.status) st.textContent = cl.status; return; } SESS.key = key;
    renderConversation(body, name, t, { n: SESS.n, more: () => { SESS.n = Math.min(200, SESS.n * 2); renderSessionDrawer(); }, refresh: () => renderSessionDrawer(false) });
    return;
  }
  const P = byId(); const pr = s && P[s.project];
  const title = cl.label || (pr ? pr.name : name);
  const head = h('div', { class: 'dh' }, h('div', { class: 'row1' }, h('h2', null, avatar(s && s.project, 'sm'), title, cl.title ? h('span', { class: 'dim', style: 'font-size:13px;font-weight:500' }, cl.title) : null, stateBadge(cl)),
      h('button', { class: 'btn sm', onclick: () => { closeDrawer(); openTerm(name); } }, gl('⌨ Terminal')), h('button', { class: 'btn ghost close', onclick: closeDrawer }, gl('✕ Esc'))),
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
  SESS.key = [name, t.sig, t.total, cl.state, cl.lastTool, SESS.n, (PENDING[name] || []).length, queuedKey(name), (cl.status || '').split(' (')[0], t.pending || '', menuKey(cl.menu)].join(':');
  renderConversation(body, name, t, { n: SESS.n, more: () => { SESS.n = Math.min(200, SESS.n * 2); renderSessionDrawer(); }, refresh: () => renderSessionDrawer(false) });
}
// The conversation itself: turns, tool calls, and a reply box that grows with the text and stays above the keyboard.
// `t` is the /api/transcript payload. Draft text in the reply box survives re-renders.
const queuedKey = name => (S.claude?.schedule || []).filter(j => j.session === name && j.whenFree && j.state === 'waiting').map(j => j.id).join(',');   // re-render the chat when its queue changes
const followUp = () => FEAT.queue ? FEAT.queue.followUp() : 'steer';
const PENDING = {};   // name -> [{ text, ts }] messages sent from here that the transcript hasn't shown yet
const menuKey = mn => mn ? mn.options.join('|') + '#' + mn.cur : '';
const menuLabel = l => l.replace(/^\d+\.\s+/, '');
function menuButtons(name, mn, done) {
  let busy = false;
  const btns = mn.options.map((l, i) => h('button', { class: 'btn sm cmenu-opt' + (i === mn.cur ? ' cur' : ''), onclick: async () => {
    if (busy) return; busy = true; for (const x of btns) x.disabled = true;
    try { await api('choose', { session: name, index: i, label: l }); toast(menuLabel(l), 'ok'); } catch (e) { toast(e.message, 'err'); }
    busy = false; for (const x of btns) x.disabled = false; if (done) done();
  } }, menuLabel(l)));
  return btns;
}
function menuCard(name, mn, done) {
  return h('div', { class: 'turn assistant cmenu' },
    h('div', { class: 'who' }, gl('⚠ Claude is asking')),
    mn.text.length ? h('div', { class: 'cmenu-q' }, mn.text.join('\n')) : null,
    h('div', { class: 'cmenu-opts' }, menuButtons(name, mn, done)),
    h('div', { class: 'cmenu-esc' }, h('button', { class: 'btn sm ghost', onclick: () => api('key', { session: name, key: 'esc' }).then(() => { toast('Esc sent'); if (done) done(); }) }, 'Esc — cancel')));
}
// Unsent text is kept per chat (localStorage, so it survives switching chats, closing the panel and reloads).
const draftKey = n => 'bd.draft.' + n;
const loadDraft = n => { try { return localStorage.getItem(draftKey(n)) || ''; } catch { return ''; } };
const saveDraft = (n, v) => { try { if (v && v.trim()) localStorage.setItem(draftKey(n), v); else localStorage.removeItem(draftKey(n)); } catch {} };
const NO_TRANSCRIPT = { total: 0, turns: [], size: 0, pending: null, empty: true };
async function transcriptOf(name, n) {
  try { return await api(`transcript/${encodeURIComponent(name)}?n=${n}`); } catch (e) { return e.status && e.status < 500 ? NO_TRANSCRIPT : null; }
}
function chatOffline(box, on) {
  const was = box.querySelector('.coff'); if (!on) { was?.remove(); return; } if (was) return;
  const bar = box.querySelector('.cbar');
  if (bar) bar.prepend(h('span', { class: 'coff' }, 'offline — retrying…')); else { box.innerHTML = ''; box.append(h('div', { class: 'dim coff', style: 'padding:20px' }, 'offline — retrying…')); }
}
const hhmm = ts => ts ? h('span', { class: 'dim mono' }, ' ' + new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null;
function convTurn(turn, name) {
    // not something you typed: a background agent finished, you interrupted, … -> one quiet line between the turns
    if (turn.role === 'event') return h('div', { class: 'tevent' + (turn.status === 'failed' || turn.status === 'killed' ? ' bad' : '') }, h('span', { class: 'ic' }, ico(turn.status === 'interrupted' ? 'stop' : turn.status === 'compacted' ? 'shrink' : turn.status === 'completed' ? 'check' : turn.status === 'failed' || turn.status === 'killed' ? 'x' : 'gear', 13)), h('span', { class: 'tx' }, turn.status === 'interrupted' ? 'interrupted' : turn.text), turn.ts ? h('span', { class: 'dim mono' }, new Date(turn.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null);
    if (turn.role === 'shell') return h('div', { class: 'turn user shell' }, h('div', { class: 'who' }, gl('❯ you · shell'), hhmm(turn.ts)), h('pre', { class: 'mcode small' }, '! ' + turn.text), turn.out ? h('details', { class: 'ttools' }, h('summary', null, 'output'), h('pre', { class: 'mcode small' }, turn.out)) : null);
    if (turn.role === 'assistant') return assistantTurn(turn, { session: name });
    return h('div', { class: 'turn ' + turn.role + (turn.queued ? ' midturn' : '') }, h('div', { class: 'who' }, gl('❯ you'), hhmm(turn.ts), turn.queued ? h('span', { class: 'steer', title: 'Sent while Claude was working — it read this mid-turn and kept going, so the answer may come later in the turn' }, ico('redo', 12), ' Steer') : null),
      turn.text ? h('div', { class: 'ttext', html: mdLite(turn.text) }) : null);
}
function syncChildren(parent, items) {
  items.forEach((el, i) => { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });
  while (parent.children.length > items.length) parent.lastElementChild.remove();
}
const elapsedTxt = since => durTxt(Math.max(0, Date.now() - since));
setInterval(() => { if (!document.hidden) for (const el of document.querySelectorAll('.wtimer[data-since]')) el.textContent = elapsedTxt(+el.dataset.since); }, 1000);
function renderConversation(box, name, t, o) {
  const same = box.dataset.chat === name && box.querySelector('.cscroll > .conv');
  // same chat re-rendering: the live box wins; another chat was shown here before: this chat's saved draft
  const prevDraft = same && box.querySelector('.creply') ? box.querySelector('.creply').value : loadDraft(name);
  box.dataset.chat = name;
  const prevScroll = box.querySelector('.cscroll'); const atBottom = !prevScroll || prevScroll.scrollHeight - prevScroll.scrollTop - prevScroll.clientHeight < 60; const prevTop = prevScroll ? prevScroll.scrollTop : 0;
  const hadFocus = document.activeElement && document.activeElement.classList.contains('creply');
  // drop local echoes once the transcript has them (or after a minute)
  const lastUser = [...t.turns].reverse().find(x => x.role === 'user');
  const lv0 = (claudeOf(name) || {}).mode === 'chat' ? liveOf(name) : null;
  PENDING[name] = (PENDING[name] || []).filter(pm => !(pm.id && HL.name === name && HL.seen.has(pm.id)) && Date.now() - pm.ts < (pm.id && lv0 ? 300000 : 60000) && !(lastUser && lastUser.text.trim() === pm.text.trim() && (lastUser.ts || 0) >= pm.ts - 5000) && !(lv0 && (lv0.inbox || []).some(m => m.text.trim() === pm.text.trim() && m.at >= pm.ts - 5000)));
  if (!same) box.innerHTML = '';
  const scroller = same ? box.querySelector('.cscroll') : h('div', { class: 'cscroll' });
  const conv = same ? scroller.querySelector('.conv') : h('div', { class: 'conv' });
  const bar = h('div', { class: 'logbar cbar' }, h('span', { class: 'dim' }, `${t.turns.length} of ${t.total}${t.more ? '+' : ''} turns`), h('span', { style: 'flex:1' }),
    t.total > t.turns.length || (t.more && o.n < 200) ? h('button', { class: 'btn sm', onclick: o.more }, '↑ older') : null, focusToggle(conv),
    ...feat('chatBar', name), h('button', { class: 'btn sm', onclick: o.refresh }, gl('↻')));
  const old = new Map(); for (const el of conv.children) if (el.dataset.h) old.set(el.dataset.h, el);
  const items = [];
  const lv = lv0;
  const inbox = lv && !lv.stale ? lv.inbox || [] : [];
  const starts = m => !turnAt(lv) || m.at <= turnAt(lv) + 1500;
  const shownTurns = lv && lv.turn ? t.turns.filter(x => !(x.role === 'assistant' && (x.ts || 0) >= lv.turn.startedAt - 3000)) : t.turns;
  for (const turn of shownTurns) { let el = turn.h && old.get(turn.h); if (!el) { el = convTurn(turn, name); if (turn.h) el.dataset.h = turn.h; } el._turn = turn; items.push(el); }
  if (!t.turns.length && !(PENDING[name] || []).length && !(claudeOf(name) || {}).menu) items.push(h('div', { class: 'dim', style: 'padding:24px 4px' }, 'New conversation — nothing said yet. Type your first message below.'));
  const cl = claudeOf(name) || {};
  // busy: hooks / pane say so, or the transcript ends in a tool call that hasn't returned yet (Claude is running it)
  const busy = lv ? lv.state === 'working' || !!lv.turn : cl.state === 'working' || cl.state === 'background' || !!t.pending; const justSent = (PENDING[name] || []).length > 0;
  const jobs = (S.claude?.schedule || []).filter(j => j.session === name && j.state !== 'done' && j.state !== 'failed');
  const compKey = [name, cl.state, menuKey(cl.menu), cl.model, cl.effort, canSwitchModel(cl), busy, justSent, jobs.map(j => j.id + j.state).join(','), followUp()].join('|');
  const keptComp = same && box.querySelector('.cbox2'); const C = keptComp && keptComp.dataset.k === compKey ? keptComp._c : composer(box, name, cl, conv, scroller, o, busy, justSent, jobs, prevDraft, compKey);
  const queued = (S.claude?.schedule || []).filter(j => j.session === name && j.whenFree && j.state === 'waiting');
  for (const m of inbox.filter(starts)) if (!(lastUser && lastUser.text.trim() === m.text.trim() && (lastUser.ts || 0) >= m.at - 5000)) items.push(h('div', { class: 'turn user pending' }, h('div', { class: 'who' }, gl('❯ you'), hhmm(m.at), h('span', { class: 'dim mono' }, ' · sent')), h('div', { class: 'ttext' }, m.text)));
  for (const pm of PENDING[name] || []) items.push(h('div', { class: 'turn user pending' }, h('div', { class: 'who' }, gl('❯ you'), h('span', { class: 'dim mono' }, ' sent')), h('div', { class: 'ttext' }, pm.text)));
  // Feedback right away: a "working" turn appears the moment you send (before the hooks confirm it), with a Stop that
  // interrupts Claude and puts your text back in the box. Esc in the box does the same.
  const since = (lv && ((lv.turn && lv.turn.startedAt) || (lv.state === 'working' && lv.since))) || t.since || (justSent ? PENDING[name][0].ts : null);
  let liveEl = null;
  if (busy || justSent) items.push(liveEl = h('div', { class: 'turn assistant live' }, h('div', { class: 'who' }, gl('✦ claude'), h('span', { class: 'dim mono' }, cl.state === 'background' ? ' waiting on background agents' : busy ? ' working' : ' starting'), since ? h('span', { class: 'dim mono' }, ' · ', h('span', { class: 'wtimer', 'data-since': since }, elapsedTxt(since))) : h('span', { class: 'dim mono' }, '…'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost stopb', title: cl.mode === 'chat' ? 'interrupt (Esc) — messages already sent stay with Claude and run next' : 'interrupt (Esc) — your message goes back into the box', onclick: C.stop }, gl('■ Stop'))), h('div', { class: 'ag-now' }, h('span', { class: 'spin' }), h('span', { class: 'mono' }, cl.state === 'background' ? bgText(cl.bg) : busy ? (cl.state === 'working' ? cl.lastTool || t.pending || 'thinking…' : t.pending || cl.lastTool || 'working…') : 'sending to Claude…')),
    cl.state === 'working' && cl.status ? h('div', { class: 'ag-status mono' }, cl.status) : null));   // Claude's own status line: "✻ Cooking… (2m 10s · ↓ 3.1k tokens)"
  if (liveEl && lv) { liveEl.insertBefore(h('div', { class: 'ltools' }), liveEl.children[1]); liveEl.insertBefore(h('div', { class: 'ttext ltext hidden' }), liveEl.children[2]); fillLive(liveEl, lv.turn); }
  if (lv && lv.error && !busy) items.push(h('div', { class: 'turn assistant' }, h('div', { class: 'who' }, gl('⚠ chat runner')), h('div', { class: 'mono dim' }, lv.error)));
  const ask = cl.mode === 'chat' ? (lv ? lv.pending[0] : cl.ask) : null;
  if (ask) items.push(askCard(name, ask, () => { for (const ms of [300, 1200]) setTimeout(o.refresh, ms); }));
  if (cl.menu) items.push(menuCard(name, cl.menu, () => { for (const ms of [500, 1500, 3000]) setTimeout(o.refresh, ms); }));
  syncChildren(conv, items);
  feat('conversation', name, conv, box);
  if (same) scroller.firstElementChild.replaceWith(bar);
  else { scroller.append(bar, conv); dropZone(box, scroller); }
  if (!keptComp) box.append(scroller, C.el);
  else if (keptComp !== C.el) keptComp.replaceWith(C.el);
  const stk = FEAT.queue ? FEAT.queue.stack(name, { waiting: inbox.filter(m => !starts(m)), jobs: queued, C, refresh: o.refresh }) : null, oldStk = box.querySelector(':scope > .qstack');
  if (stk) { if (oldStk) oldStk.replaceWith(stk); else C.el.before(stk); } else if (oldStk) oldStk.remove();
  box.classList.remove('cdrop');
  if (C.el !== keptComp) { C.grow(); if (hadFocus) C.ta.focus({ preventScroll: true }); }
  scroller.scrollTop = atBottom ? scroller.scrollHeight : prevTop;
  setTimeout(() => { if (atBottom) scroller.scrollTop = scroller.scrollHeight; }, 0);
}
const hasFiles = ev => [...(ev.dataTransfer?.types || [])].includes('Files');
function dropZone(box, el) {
  el.addEventListener('dragover', ev => { if (!hasFiles(ev)) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; box.classList.add('cdrop'); });
  el.addEventListener('dragleave', ev => { if (!box.contains(ev.relatedTarget)) box.classList.remove('cdrop'); });
  el.addEventListener('drop', ev => { if (!hasFiles(ev)) return; ev.preventDefault(); box.classList.remove('cdrop'); const c = box.querySelector('.cbox2'); if (c && c._c) c._c.attachFiles(ev.dataTransfer.files); });
}
function composer(box, name, cl, conv, scroller, o, busy, justSent, jobs, prevDraft, compKey) {
  const stop = async () => { const chat = cl.mode === 'chat', last = chat ? null : (PENDING[name] || []).slice(-1)[0]; const waiting = chat ? waitingIn(liveOf(name)).length : 0; try { await api('key', { session: name, key: 'esc' }); } catch {} if (!chat) PENDING[name] = []; if (last && !ta.value.trim()) { ta.value = last.text; grow(); } ta.focus(); toast(waiting ? `stopped — ${waiting} waiting message${waiting > 1 ? 's go' : ' goes'} to Claude next` : last ? 'stopped — your text is back in the box' : 'stopped'); setTimeout(o.refresh, 600); };
  // reply box: textarea that grows to 6 lines; Enter sends, Shift+Enter = newline; Esc button interrupts Claude
  const ta = h('textarea', { class: 'creply', rows: 1, placeholder: cl.menu ? 'pick an option above first' : cl.mode === 'chat' && cl.state === 'permission' ? 'answer above, or type a message…' : cl.state === 'permission' ? 'y / n, or type…' : 'Message Claude…', title: 'Enter sends · Shift+Enter = new line', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: true });
  ta.value = prevDraft;
  let syncAct = () => {};
  const grow = () => { ta.style.height = '0px'; ta.style.height = Math.min(Math.max(IS_PHONE ? 48 : 56, ta.scrollHeight), 10 * 24 + 12) + 'px'; saveDraft(name, ta.value); syncAct(); };   // every change goes through grow() -> the draft is saved
  const sendText = async (v) => { (PENDING[name] = PENDING[name] || []).push({ text: v, ts: Date.now() }); conv.append(h('div', { class: 'turn user pending' }, h('div', { class: 'who' }, gl('❯ you'), h('span', { class: 'dim mono' }, ' sending…')), h('div', { class: 'ttext' }, v))); scroller.scrollTop = scroller.scrollHeight; try { await api('send', { session: name, text: v }); } catch (e) { toast(e.message, 'err'); } setTimeout(o.refresh, 700); setTimeout(o.refresh, 2500); };
  const send = async () => { const v = ta.value.trim(); if (!v) return; if ((claudeOf(name) || {}).menu) { toast('Claude is asking something — pick an option above first', 'err'); return; } ta.value = ''; grow();
    const pm = { text: v, ts: Date.now() }; (PENDING[name] = PENDING[name] || []).push(pm);
    conv.append(h('div', { class: 'turn user pending' }, h('div', { class: 'who' }, gl('❯ you'), h('span', { class: 'dim mono' }, ' sending…')), h('div', { class: 'ttext' }, v))); scroller.scrollTop = scroller.scrollHeight;
    try { const r = await api('send', { session: name, text: v }); if (r && r.id) pm.id = r.id; } catch (e) { toast(e.message, 'err'); PENDING[name] = PENDING[name].filter(x => x !== pm); ta.value = v; grow(); }
    for (const ms of [400, 1200, 2500, 5000]) setTimeout(o.refresh, ms); };
  ta.addEventListener('input', grow);
  const busyNow = cl.state === 'working' || cl.state === 'background' || cl.state === 'permission';
  const queue = async () => { const v = ta.value.trim(); if (!v) { toast('type the message first'); ta.focus(); return; } ta.value = ''; grow();
    try { await api('schedule', { session: name, at: Date.now(), prompts: [v], whenFree: true }); toast('queued — goes out when Claude is free', 'ok'); } catch (e) { ta.value = v; grow(); toast(e.message, 'err'); } };
  const pick = cl.mode === 'chat' && (busy || busyNow) ? followUp() : null;
  const sj = jobs.filter(j => !(j.whenFree && j.state === 'waiting'));
  const first = pick === 'queue' ? queue : send, second = pick === 'queue' ? send : queue;
  ta.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); (pick && ev.altKey ? second : first)(); } else if (ev.key === 'Escape' && (busy || justSent)) { ev.preventDefault(); stop(); } });
  const sendBtn = h('button', { class: 'btn primary csend', title: pick === 'queue' ? 'queue it for after this turn (Enter)' : pick ? 'send now — Claude reads it at its next step (Enter)' : 'send (Enter)', onclick: first }, ico('send', 16));
  const stopBtn = busy || busyNow || justSent ? h('button', { class: 'btn csend cstop', title: 'stop Claude (Escape)', onclick: stop }, h('i', { class: 'cstop-sq' })) : null;
  syncAct = () => { if (!stopBtn) return; const empty = !ta.value.trim(); stopBtn.classList.toggle('hidden', !empty); sendBtn.classList.toggle('hidden', empty); };
  // 📎 attach: any file (photo / screenshot downscaled, everything else as-is) -> ~/dev/.pasted -> its path goes into the message (Claude reads it)
  const fileIn = h('input', { type: 'file', multiple: true, style: 'display:none' });
  const attachFiles = async files => { files = [...files].filter(Boolean); if (!files.length) return;
    for (const f of files) { if (files.length > 1 || f.size > 2e6) toast('uploading ' + (f.name || 'image') + '…'); try { const p = await uploadFile(f); ta.value = (ta.value ? ta.value.replace(/\s*$/, ' ') : '') + p + ' '; grow(); } catch (e) { toast('upload failed: ' + e.message, 'err'); } }
    ta.focus(); toast(files.length > 1 ? `${files.length} files attached — describe what to do with them and send` : 'attached — describe what to do with it and send', 'ok'); };
  fileIn.addEventListener('change', () => { const fs = [...fileIn.files]; fileIn.value = ''; attachFiles(fs); });
  ta.addEventListener('paste', ev => { const dt = ev.clipboardData; if (!dt) return; const txt = dt.getData('text/plain'); if (txt.length >= PASTE_AS_FILE) { ev.preventDefault(); attachFiles([new File([txt], `paste-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.txt`, { type: 'text/plain' })]); return; } if (txt) return; const fs = [...(dt.files || [])]; if (fs.length) { ev.preventDefault(); attachFiles(fs); } });
  const attach = h('button', { class: 'btn sm ghost qk', title: 'attach files — photo, screenshot, CSV, PDF, anything up to 100 MB (or drop / paste them here)', onclick: () => fileIn.click() }, ico('clip', 15));
  // 🎤 hold to talk (Web Speech API; Safari + Chrome): release sends
  const mic = voiceButton(ta, name);
  const clock = h('button', { class: 'btn sm ghost qk csched', title: 'schedule this message for later (or a chain of messages)', onclick: () => scheduleDialog(name, ta.value) }, ico('sched', 15));
  const keys = h('div', { class: 'ckeys' }, attach, mic, clock, fileIn, ...feat('composerKeys', name),
    sj.length ? h('span', { class: 'sjobs' }, sj.map(j => h('span', { class: 'sjob', title: j.prompts.join('\n\n') }, ico('clock', 12), ' ', j.whenFree ? 'when free' : new Date(j.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), j.prompts.length > 1 ? ` ×${j.prompts.length}` : '', j.state === 'running' || j.state === 'sent' ? ' · ' + j.state : '', h('button', { class: 'x', title: 'remove', onclick: () => api('schedule-remove', { id: j.id }) }, ico('x', 11))))) : null,
    cl.state === 'permission' && !cl.menu && cl.mode !== 'chat' ? ['y', 'n'].map(k => h('button', { class: 'btn sm qk ' + (k === 'y' ? 'yes' : 'no'), onclick: () => api('send', { session: name, text: k, enter: false }) }, k)) : null,
    cl.mode === 'chat' ? null : h('button', { class: 'btn sm ghost qk', title: 'send Ctrl-C', onclick: () => { if (confirm('Send Ctrl-C?')) api('key', { session: name, key: 'c-c' }); } }, '^C'));
  const el = h('div', { class: 'cbox2', 'data-k': compKey }, h('div', { class: 'cfield', onclick: ev => { if (ev.target === ev.currentTarget || ev.target.classList.contains('cfoot')) ta.focus(); } }, ta,
    h('div', { class: 'cfoot' }, keys, cl.state ? modelPicker(name, cl) : null, stopBtn, sendBtn)));
  syncAct();
  el._c = { el, ta, grow, stop, attachFiles };
  dropZone(box, el);
  return el._c;
}
const trim1 = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;
// tool calls of one turn, with Edit/Write diffs and Bash commands inline
// ---------- Claude's turn, in order: its text, then the tools it ran, then more text … (like the Claude app) ----------
// Consecutive tool calls fold into one quiet row ("ran 3 commands · edited 2 files ▸"); each call opens on its own and
// loads its full input/output (diff, command output, an agent's answer) only then. What's open survives re-renders.
const CHAT = { open: new Set(), detail: new Map(), liveAt: new Map(), focus: (() => { try { return localStorage.getItem('bd.chat.focus') === '1'; } catch { return false; } })() };
const fileBase = p => String(p || '').split('/').pop();
const durTxt = ms => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's' : Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm'; };
// one tool call -> { icon, label, sub, meta, cat }; cat drives the group summary
function toolLook(t) {
  const n = t.name || '';
  if (n === 'Bash' || n === 'PowerShell') return { icon: '$', label: t.desc || t.cmd || 'command', sub: t.desc ? t.cmd : '', meta: t.bg ? 'background' : '', cat: 'cmd' };
  if (n === 'Read') return { icon: '◱', label: 'Read ' + fileBase(t.file), meta: t.image ? 'image' : t.lines ? t.lines + ' lines' : '', cat: 'read', title: t.file };
  if (n === 'Edit' || n === 'MultiEdit') return { icon: '✎', label: 'Edit ' + fileBase(t.file), diff: t, cat: 'edit', title: t.file };
  if (n === 'Write') return { icon: '✎', label: (t.created ? 'Create ' : 'Write ') + fileBase(t.file), diff: t, cat: 'edit', title: t.file };
  if (n === 'NotebookEdit') return { icon: '✎', label: 'Edit ' + fileBase(t.file), cat: 'edit' };
  if (n === 'Grep' || n === 'Glob') return { icon: '⌕', label: (n === 'Grep' ? 'Search ' : 'Find ') + t.pattern, meta: t.count != null ? t.count + (n === 'Glob' ? ' files' : ' hits') : '', cat: 'search' };
  if (n === 'Agent' || n === 'Task') return { icon: '✦', label: 'Agent · ' + (t.desc || 'subagent'), meta: [t.sub, t.bg ? 'background' : ''].filter(Boolean).join(' · '), cat: 'agent' };
  if (n === 'WebSearch') return { icon: '⌕', label: 'Web search · ' + t.query, cat: 'web' };
  if (n === 'WebFetch') { let host = t.url; try { host = new URL(t.url).host; } catch {} return { icon: '↗', label: 'Fetch ' + host, cat: 'web', title: t.url }; }
  if (n === 'TodoWrite') return { icon: '☑', label: 'Updated the to-do list', cat: 'other', tag: 'to-do list' };
  if (n === 'Skill') return { icon: '◆', label: t.what || 'Skill', cat: 'other', tag: 'a skill' };
  const mcp = n.match(/^mcp__(.+?)__(.+)$/); if (mcp) { const srv = mcp[1].replace(/^claude[-_]in[-_]/, '').replace(/^claude_ai_/, '').replace(/_/g, ' '); return { icon: '⚙', label: srv + ' · ' + mcp[2].replace(/_/g, ' '), cat: 'other', tag: srv }; }
  return { icon: '⚙', label: t.what || n, cat: 'other', tag: n };
}
function groupSummary(tools) {
  const c = {}, tags = []; for (const t of tools) { const L = toolLook(t); c[L.cat] = (c[L.cat] || 0) + 1; if (L.tag && !tags.includes(L.tag)) tags.push(L.tag); }
  const pl = (k, one, many) => c[k] ? (c[k] === 1 ? one : many.replace('#', c[k])) : null;
  return [pl('cmd', 'ran a command', 'ran # commands'), pl('edit', 'edited a file', 'edited # files'), pl('read', 'read a file', 'read # files'), pl('search', 'searched', '# searches'), pl('agent', 'started an agent', 'started # agents'), pl('web', 'looked something up', '# web lookups'), c.other ? 'used ' + tags.slice(0, 2).join(', ') + (tags.length > 2 ? ' +' + (tags.length - 2) : '') : null].filter(Boolean).join(' · ');
}
const diffMeta = t => t.add != null || t.del ? h('span', { class: 'tdm' }, t.add ? h('b', { class: 'ad' }, '+' + t.add) : null, t.del ? h('b', { class: 'dl' }, '−' + t.del) : null) : null;
function toolDetailView(d) {
  if (d.error && !d.name) return h('div', { class: 'dim' }, d.error);
  const pre = (txt, cls = '') => h('pre', { class: 'mcode tout ' + cls }, txt);
  if (d.name === 'Bash' || d.name === 'PowerShell') return [pre('$ ' + d.cmd, 'tcmd'), d.out ? pre(d.out) : h('div', { class: 'dim tnone' }, d.done ? 'no output' : 'running…')];
  if (d.hunks) return [h('div', { class: 'tdiff2' }, d.hunks.map(hk => [h('div', { class: 'dhk' }, '@@ line ' + (hk.n || hk.o || 1)), hk.lines.map(l => h('div', { class: 'dl ' + (l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx') }, l.slice(1) || ' '))]), d.more ? h('div', { class: 'dim tnone' }, '… more changes not shown') : null), d.out ? pre(d.out, 'terr') : null];
  if (d.name === 'Agent' || d.name === 'Task') return [h('details', { class: 'tprompt' }, h('summary', null, 'prompt'), pre(d.prompt)), d.out ? h('div', { class: 'ttext tans', html: mdLite(d.out) }) : h('div', { class: 'dim tnone' }, 'working…')];
  if (d.qa) return h('div', { class: 'tqa' }, d.qa.map(x => h('div', null, h('div', { class: 'q' }, x.q), h('div', { class: 'a' }, x.a || '—'))));
  return [d.input && d.input !== '{}' ? pre(d.input) : null, d.out ? pre(d.out) : d.image ? h('div', { class: 'dim tnone' }, 'image') : null];
}
function toolRow(t, ctx) {
  const L = toolLook(t); const key = t.id; const open = CHAT.open.has(key);
  const st = !t.done && !t.stale ? h('span', { class: 'spin' }) : t.error ? h('span', { class: 'terrx' }, ico('x', 13)) : null;
  const body = h('div', { class: 'tr-body' });
  const row = h('div', { class: 'trow' + (open ? ' open' : '') + (t.error ? ' err' : '') + (!t.done && !t.stale ? ' run' : '') });
  const load = async () => {
    const cached = CHAT.detail.get(key); if (cached) { body.replaceChildren(...[toolDetailView(cached)].flat(2).filter(Boolean)); if (cached.done || !t.done && CHAT.liveAt.get(key) > Date.now() - 8000) return; }   // running: refresh at most every 8 s
    else body.replaceChildren(h('div', { class: 'dim tnone' }, 'loading…'));
    try { const q = ctx.file ? 'file=' + encodeURIComponent(ctx.file) : 'session=' + encodeURIComponent(ctx.session); CHAT.liveAt.set(key, Date.now()); const d = await api(`transcript-tool?${q}&id=${encodeURIComponent(t.id)}`); CHAT.detail.set(key, d); if (body.isConnected) body.replaceChildren(...[toolDetailView(d)].flat(2).filter(Boolean)); }
    catch (e) { body.replaceChildren(h('div', { class: 'dim tnone' }, e.message)); }
  };
  const sum = h('button', { class: 'tr-sum', title: L.title || '', onclick: () => { const o = !row.classList.contains('open'); row.classList.toggle('open', o); if (o) { CHAT.open.add(key); load(); } else CHAT.open.delete(key); } },
    h('span', { class: 'ti' }, gico(L.icon, 14)), h('span', { class: 'tl2' }, h('span', { class: 'tlab' }, L.label), L.sub ? h('span', { class: 'tsub mono' }, L.sub) : null),
    L.diff ? diffMeta(L.diff) : null, L.meta ? h('span', { class: 'tmeta' }, L.meta) : null, st, h('span', { class: 'tcar' }, '›'));
  row.append(sum, ...feat('toolOpen', t, ctx), body); if (open) load();
  return row;
}
// inline, never folded: what Claude asked you and what you answered; its to-do list
function inlineTool(t) {
  if (t.name === 'AskUserQuestion') return h('div', { class: 'tqa' }, (t.qs || []).map((q, i) => h('div', null, h('div', { class: 'q' }, '？ ' + q), h('div', { class: 'a' }, t.answers ? (t.answers[i] || '—') : t.done ? '—' : 'waiting for your answer…'))));
  if (t.name === 'TodoWrite' && t.todos) return h('div', { class: 'ttodo' }, t.todos.map(x => h('div', { class: 'td ' + x.s }, h('span', { class: 'ck' }, x.s === 'completed' ? '✓' : x.s === 'in_progress' ? '→' : '○'), x.c)));
  return null;
}
function assistantTurn(turn, ctx) {
  const el = h('div', { class: 'turn assistant' }, h('div', { class: 'who' }, gl('✦ claude'), turn.ts ? h('span', { class: 'dim mono' }, ' ' + new Date(turn.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null));
  const steps = turn.steps || []; let run = [];
  const flush = () => {
    if (!run.length) return; const tools = run; run = [];
    if (tools.length === 1) { el.append(toolRow(tools[0], ctx)); return; }
    const key = 'g:' + tools[0].id; const live = tools.some(t => !t.done && !t.stale); if (tools.some(t => CHAT.open.has(t.id))) CHAT.open.add(key); const open = CHAT.open.has(key);
    const g = h('div', { class: 'tgroup' + (open ? ' open' : '') + (live ? ' run' : '') });
    const body = h('div', { class: 'tg-body' }, tools.map(t => toolRow(t, ctx)));
    const cur = live ? tools.filter(t => !t.done && !t.stale).pop() : null;
    g.append(h('button', { class: 'tg-sum', onclick: () => { const o = !g.classList.contains('open'); g.classList.toggle('open', o); o ? CHAT.open.add(key) : CHAT.open.delete(key); } },
      h('span', { class: 'ti' }, ico('layers', 14)), h('span', { class: 'tl2' }, h('span', { class: 'tlab' }, groupSummary(tools)), cur ? h('span', { class: 'tsub' }, toolLook(cur).label) : null),
      h('span', { class: 'tmeta' }, tools.length + ' steps'), tools.some(t => t.error) ? h('span', { class: 'terrx' }, ico('x', 13)) : null, live ? h('span', { class: 'spin' }) : null, h('span', { class: 'tcar' }, '›')), body);
    el.append(g);
  };
  for (const st of steps) {
    if (st.k === 'text') { flush(); el.append(h('div', { class: 'ttext', html: mdLite(st.text) })); continue; }
    const inl = inlineTool(st); if (inl) { flush(); el.append(inl); continue; }
    run.push(st);
  }
  flush();
  if (turn.dur) el.append(h('div', { class: 'tdur' }, 'worked ' + durTxt(turn.dur)));
  else if (turn.stopped != null) el.append(h('div', { class: 'tdur stopped' }, 'you stopped it after ' + durTxt(turn.stopped)));
  return el;
}
function focusToggle(conv) {
  conv.classList.toggle('focus', CHAT.focus);
  return h('button', { class: 'btn sm ghost' + (CHAT.focus ? ' on' : ''), title: 'Focus: only your messages and Claude\'s replies — tool calls hidden', onclick: ev => { CHAT.focus = !CHAT.focus; try { localStorage.setItem('bd.chat.focus', CHAT.focus ? '1' : '0'); } catch {} conv.classList.toggle('focus', CHAT.focus); ev.currentTarget.classList.toggle('on', CHAT.focus); } }, 'Focus');
}
const UPLOAD_MAX_MB = 100;   // same as the server
// images: downscaled to 1568px on the long edge (what Claude uses anyway); anything else raw, keeping its name. Returns the server path.
const PASTE_AS_FILE = 32 * 1024;
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
// Whisper on the server's GPU (beast-whisper service, started on demand): same engine on the laptop and the phone.
// Falls back to the browser's own speech recognition when the service is down.
const WHISPER = { ok: false, at: 0 };
let actx = null;
function beep(freq = 880, ms = 140) { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = freq; o.connect(g); g.connect(actx.destination); const t = actx.currentTime; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000); o.start(t); o.stop(t + ms / 1000 + 0.02); } catch {} }
async function whisperUp() { if (Date.now() - WHISPER.at < 60000) return WHISPER.ok; WHISPER.at = Date.now(); try { const r = await fetch('/api/transcribe', { cache: 'no-store' }); WHISPER.ok = r.ok && (await r.json()).ok === true; } catch { WHISPER.ok = false; } return WHISPER.ok; }
whisperUp();
function voiceButton(ta, chatKey) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRec = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!SR && !canRec) return null;
  // Tap the mic (a long press counts as a tap too) -> a full-screen recording sheet over everything; the only thing
  // you can press is Stop. The words show on the sheet; the message box gets them on Stop (never sent by itself).
  // iOS ends a recognition on its own after a pause or ~1 min while the button still looks live: onend restarts it
  // for as long as we are recording, keeping what was already recognised. One recogniser is reused per page so
  // iOS asks for the microphone as rarely as it lets us (a home-screen app still forgets it on every launch).
  const b = h('button', { class: 'btn sm ghost qk mic', title: 'record — tap, talk, then Stop (the text lands in the message box; you send it)' }, ico('mic', 18));
  let rec = null, final = '', interim = '', active = false, restarts = [], settle = null;
  // while recording: a sheet over the bottom of the screen — red dot + timer, the words as they come in (always
  // scrolled to the newest), one big Stop. The textarea fills too and is kept scrolled to the end.
  let ov = null, ovText = null, ovTime = null, ovTimer = null, t0 = 0, ovStatus = null;
  // spoken language: Settings → voiceLangs (e.g. ['sr', 'en']) — the sheet toggles between them, remembered per chat
  // (falls back to the last one picked anywhere, then the first). Empty list: no toggle, Whisper detects the language.
  const LANGS = () => (Array.isArray(S.settings?.voiceLangs) ? S.settings.voiceLangs : []).filter(x => /^[a-z]{2,3}$/.test(x)); const lk = 'bd.vlang.' + (chatKey || '_');
  const vlang = () => { const L = LANGS(); if (!L.length) return ''; try { const v = localStorage.getItem(lk) || localStorage.getItem('bd.vlang'); return L.includes(v) ? v : L[0]; } catch { return L[0]; } };
  const setVlang = v => { try { localStorage.setItem(lk, v); localStorage.setItem('bd.vlang', v); } catch {} };
  const openOverlay = () => {
    ovText = h('div', { class: 'recov-text' }, h('span', { class: 'dim' }, 'listening…')); ovTime = h('span', { class: 'recov-time mono' }, '0:00'); t0 = Date.now();
    ov = h('div', { class: 'recov' }, h('div', { class: 'recov-box' },
      h('div', { class: 'recov-head' }, h('span', { class: 'recov-dot' }), h('b', null, 'Recording'), ovTime, h('span', { class: 'sp' }), (ovStatus = h('span', { class: 'recov-st' }, canRec && WHISPER.ok ? '' : 'browser speech')),
        canRec && WHISPER.ok && LANGS().length > 1 ? h('button', { class: 'btn sm ghost recov-lang', title: 'language you speak in this chat — tap to switch (' + LANGS().join(' / ') + ', remembered per chat)', onclick: ev => { ev.preventDefault(); ev.stopPropagation(); const L = LANGS(); const n = L[(L.indexOf(vlang()) + 1) % L.length]; setVlang(n); ev.currentTarget.textContent = n.toUpperCase(); } }, vlang().toUpperCase()) : null),
      ovText,
      h('button', { class: 'btn recov-stop', onclick: ev => { ev.preventDefault(); ev.stopPropagation(); finish(); } }, h('span', { class: 'sq' }), 'Stop recording')));
    for (const t of ['pointerdown', 'pointerup', 'click', 'touchstart']) ov.addEventListener(t, ev => { ev.stopPropagation(); if (ev.target === ov) ev.preventDefault(); });
    ov.addEventListener('keydown', ev => ev.stopPropagation());
    document.body.append(ov); document.activeElement && document.activeElement.blur && document.activeElement.blur();
    document.addEventListener('keydown', escStop, true);
    ovTimer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); ovTime.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }, 500);
  };
  const escStop = ev => { if (ev.key === 'Escape' && active) { ev.preventDefault(); ev.stopPropagation(); finish(); } };
  const closeOverlay = () => { stopWave(); clearInterval(ovTimer); if (ov) ov.remove(); ov = null; ovText = null; ovStatus = null; document.removeEventListener('keydown', escStop, true); };
  const show = () => {
    if (ovText) { const said = (final + interim).trim(); ovText.replaceChildren(said ? h('span', null, final, h('span', { class: 'dim' }, interim)) : h('span', { class: 'dim' }, 'listening…')); ovText.scrollTop = ovText.scrollHeight; }
  };
  const ensure = () => {
    if (rec) return rec;
    rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = true;
    rec.onresult = e => { interim = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) final += r[0].transcript.trim() + ' '; else interim += r[0].transcript; } show(); };
    rec.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;           // silence / our own restart: onend takes it from here
      toast(e.error === 'not-allowed' ? 'microphone not allowed — allow it when iOS asks' : 'voice: ' + e.error, 'err'); finish();
    };
    rec.onend = () => {
      if (!active) return;
      if (interim) { final += interim.trim() + ' '; interim = ''; }           // iOS drops the pending words when it ends by itself
      const now = Date.now(); restarts = restarts.filter(t => now - t < 10000); restarts.push(now);
      if (restarts.length > 6) { toast('voice keeps stopping — try again', 'err'); finish(); return; }
      try { rec.start(); } catch { setTimeout(() => { if (active) try { rec.start(); } catch { finish(); } }, 250); }
    };
    return rec;
  };
  const begin = () => {
    active = true; clearTimeout(settle); final = ''; interim = ''; restarts = [];
    b.classList.add('rec'); document.body.classList.add('recording'); openOverlay();
    if (canRec && WHISPER.ok) { startWhisper(); return; }
    if (!SR) { toast('voice: Whisper on the server is not running', 'err'); finish(); return; }
    try { ensure().start(); } catch (e) { try { rec.abort(); } catch {} rec = null; try { ensure().start(); } catch { toast('voice unavailable', 'err'); finish(); } }
  };
  // ---- Whisper engine: record the whole thing with MediaRecorder; on Stop the one audio file goes to the server and
  // the text lands in the message box to check / fix / send. No live preview: re-transcribing a half-finished
  // recording every few seconds showed wrong words and kept the GPU busy while you talked. ----
  let stream = null, mr = null, chunks = [], mime = '', gen = 0, whisperOn = false;
  const whisperSend = async () => {
    const blob = new Blob(chunks, { type: mime || 'audio/webm' }); if (blob.size < 2000) return null;
    const r = await fetch('/api/transcribe?lag=' + lag + (vlang() ? '&lang=' + vlang() : ''), { method: 'POST', body: blob, headers: { 'content-type': 'application/octet-stream' } });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j;
  };
  let tapAt = 0, lag = 0, whisperNote = '';
  const micStatus = (live, extra) => { if (!ovStatus) return; ovStatus.replaceChildren(...(live ? [h('span', { class: 'ok' }, '● Recording — talk')] : [h('span', { class: 'spin' }), ' Starting mic… wait'])); if (whisperNote) ovStatus.append(h('span', { class: 'dim' }, ' · ' + whisperNote)); };
  async function startWhisper() {
    whisperOn = true; chunks = []; const my = ++gen; tapAt = Date.now(); whisperNote = ''; micStatus(false);
    wakeWhisper(my);   // starts the service if it's asleep; audio is buffered, so it doesn't matter when it's ready
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'microphone not allowed — allow it when asked' : 'mic: ' + e.message, 'err'); whisperOn = false; finish(); return; }
    if (!active || my !== gen) { stream.getTracks().forEach(t => t.stop()); return; }
    mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); mime = mr.mimeType || mime;
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstart = () => { lag = Date.now() - tapAt; if (my === gen) { micStatus(true); beep(); startWave(); } };   // only now is the mic really recording
    mr.start(1000);
    if (ovText) ovText.replaceChildren(h('span', { class: 'dim' }, 'Talk — the text appears in the message box after Stop.'));
  }
  // Level meter while recording: bars scroll right-to-left with the mic's loudness (an analyser on the same stream,
  // never connected to the speakers). actx was resumed in the tap, so iOS lets it run.
  let waveRaf = 0, waveSrc = null;
  function startWave() {
    if (!ovText || !stream) return;
    const N = 40, lv = new Array(N).fill(0), bars = Array.from({ length: N }, () => h('i'));
    const wave = h('div', { class: 'recwave' }, ...bars);
    ovText.replaceChildren(wave, h('div', { class: 'dim recwave-hint' }, 'Talk — the text appears in the message box after Stop.'));
    let an = null, buf = null;
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); waveSrc = actx.createMediaStreamSource(stream); an = actx.createAnalyser(); an.fftSize = 1024; waveSrc.connect(an); buf = new Float32Array(an.fftSize); } catch { an = null; }
    let last = 0;
    const tick = t => {
      if (!wave.isConnected) return stopWave();
      waveRaf = requestAnimationFrame(tick); if (t - last < 60) return; last = t;
      let v = 0; if (an) { an.getFloatTimeDomainData(buf); let sq = 0; for (let i = 0; i < buf.length; i++) sq += buf[i] * buf[i]; v = Math.min(1, Math.max(0, Math.sqrt(Math.sqrt(sq / buf.length)) * 2.4 - 0.1)); }
      lv.push(v); lv.shift(); for (let i = 0; i < N; i++) bars[i].style.transform = `scaleY(${Math.max(0.06, lv[i])})`;
    };
    waveRaf = requestAnimationFrame(tick);
  }
  function stopWave() { cancelAnimationFrame(waveRaf); waveRaf = 0; try { waveSrc && waveSrc.disconnect(); } catch {} waveSrc = null; }
  // Asleep -> "Waking Whisper…" with a spinner until it answers, then a short beep + "Ready — talk". Awake -> ready right away,
  // with how long until it sleeps again.
  async function wakeWhisper(my) {
    const note = t => { whisperNote = t; if (my === gen && ov) micStatus(!!(mr && mr.state === 'recording')); };
    let j = null; try { j = await (await fetch('/api/transcribe?warm=1', { cache: 'no-store' })).json(); } catch {}
    if (j && j.loaded) return;
    const w0 = Date.now(); note('Whisper waking');
    while (active && my === gen && Date.now() - w0 < 45000) {
      await new Promise(r => setTimeout(r, 400));
      try { j = await (await fetch('/api/transcribe', { cache: 'no-store' })).json(); } catch { j = null; }
      if (j && j.loaded) { note(''); return; }
    }
    if (active && my === gen) note('Whisper did not wake up');
  }
  async function stopWhisper() {
    const my = gen; stopWave(); if (!mr) { whisperOn = false; return; }
    await new Promise(res => { mr.onstop = res; try { mr.state !== 'inactive' ? mr.stop() : res(); } catch { res(); } });
    stream && stream.getTracks().forEach(t => t.stop()); stream = null; mr = null;
    // one retry after a short pause, so a hiccup (Whisper still waking, the phone switching networks) doesn't lose the recording
    let j = null; try { j = await whisperSend(); } catch { await new Promise(r => setTimeout(r, 1500)); try { j = await whisperSend(); } catch (e) { toast('Whisper: ' + e.message + ' — recording not transcribed', 'err'); } }
    if (my === gen && j) { final = j.text ? j.text + ' ' : ''; interim = ''; }
    whisperOn = false;
  }
  function finish() {
    if (!active) return; active = false;
    b.classList.remove('rec');
    // Whisper: keep the sheet up ("Finishing…") until the final pass is back, then close it and fill the box
    const done = () => { document.body.classList.remove('recording'); closeOverlay(); };
    if (whisperOn && ov) { clearInterval(ovTimer); const sb = ov.querySelector('.recov-stop'); if (sb) { sb.disabled = true; sb.replaceChildren(h('span', { class: 'spin' }), 'Finishing…'); } if (ovStatus) ovStatus.replaceChildren(h('span', { class: 'dim' }, 'Whisper is writing it down')); }
    else done();
    // The box this button was made with can be gone: a re-render (Claude working, a state change, the phone waking)
    // builds a new one. Write into the box of this chat that is on screen now; no box -> the chat's saved draft.
    const settleText = () => {
      if (interim) { final += interim.trim() + ' '; interim = ''; }
      if (!final.trim()) return;
      const box = ta.isConnected ? ta : [...document.querySelectorAll('[data-chat] .creply')].find(x => x.closest('[data-chat]').dataset.chat === chatKey);
      const add = v => (v.trim() ? v.replace(/\s*$/, ' ') : '') + final;
      if (!box) { saveDraft(chatKey, add(loadDraft(chatKey))); toast('saved in the chat\'s draft — open the chat to send it', 'ok'); return; }
      box.value = add(box.value); box.dispatchEvent(new Event('input'));   // that box's own grow(): height + saved draft
      box.focus({ preventScroll: true }); box.setSelectionRange(box.value.length, box.value.length); box.scrollTop = box.scrollHeight; toast('check the text, then send', 'ok');
    };
    // Whisper: the final pass over the whole recording. Browser engine: the last result lands a moment after stop().
    if (whisperOn) { stopWhisper().then(() => { done(); settleText(); }); return; }
    try { rec && rec.stop(); } catch {}
    settle = setTimeout(settleText, 500);
  }
  b.addEventListener('pointerenter', () => whisperUp());
  // tap = start (a long press is the same tap); stopping only happens with Stop on the sheet
  b.addEventListener('pointerdown', ev => { ev.preventDefault(); try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch {} if (!active) begin(); });
  b.addEventListener('click', ev => ev.preventDefault());
  b.addEventListener('contextmenu', ev => ev.preventDefault());
  return b;
}
// Schedule a prompt (or a chain) for a session: modal with quick time chips + a date/time picker + one textarea per message.
function scheduleDialog(name, draft) {
  const m = $('#modal'); m.classList.remove('hidden');
  const sess = S.runtime.sessions.find(x => x.name === name); const cl = sess?.claude || {};
  const pad = n => String(n).padStart(2, '0'); const local = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  let at = Date.now() + 30 * 60e3;
  const wp = FEAT.when ? FEAT.when.picker(at, t => { at = t; rel.textContent = inStr(); for (const c of chips.children) c.classList.toggle('on', +c.dataset.at === Math.round(at / 60e3)); }) : null;
  const when = wp ? null : h('input', { class: 'txt', type: 'datetime-local', value: local(new Date(at)) });
  const inStr = () => { const d = at - Date.now(); return d < 0 ? 'now' : d < 3600e3 ? 'in ' + Math.round(d / 60e3) + ' min' : d < 86400e3 ? 'in ' + (d / 3600e3).toFixed(1).replace('.0', '') + ' h' : 'in ' + Math.round(d / 86400e3) + ' d'; };
  const rel = h('span', { class: 'dim', style: 'font-size:12px' }, inStr());
  const setAt = v => { at = v; if (wp) wp.set(at); else when.value = local(new Date(at)); rel.textContent = inStr(); for (const c of chips.children) c.classList.toggle('on', +c.dataset.at === Math.round(at / 60e3)); };
  if (when) when.addEventListener('input', () => { const t = Date.parse(when.value); if (t) { at = t; rel.textContent = inStr(); for (const c of chips.children) c.classList.remove('on'); } });
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
      h('div', { class: 'sto' }, avatar(sess?.project, 'sm'), h('b', null, cl.label || (sess?.project && byId()[sess.project]?.name) || name), h('span', { class: 'badge tag acc ' + (cl.account || '') }, acct(cl.account)), cl.state ? h('span', { class: 'cst mini ' + cl.state }, STATE_ICON[cl.state], ' ', STATE_LABEL[cl.state]) : null),
      h('div', { class: 'sg' }, h('div', { class: 'sg-t' }, 'When'), chips, h('div', { class: 'swhen' }, wp ? wp.field : when, rel), wp ? wp.pop : null),
      h('div', { class: 'sg' }, h('div', { class: 'sg-t' }, 'Message'), msgs, h('button', { class: 'btn sm ghost', onclick: () => addMsg('').focus() }, ico('plus', 13), 'Add a follow-up message'), h('div', { class: 'hint' }, 'Follow-ups go out one by one, each after Claude finishes the previous one. If the session is busy at the time, the message waits for it to become idle.'))),
    h('div', { class: 'foot' }, h('button', { class: 'btn ghost', onclick: () => m.classList.add('hidden') }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => { const prompts = [...msgs.querySelectorAll('textarea')].map(t => t.value.trim()).filter(Boolean); if (!prompts.length) { first.focus(); return; }
        if (at < Date.now() - 60e3) { toast('that time is in the past', 'err'); return; }
        await act('Scheduled ' + new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), api('schedule', { session: name, at, prompts })); m.classList.add('hidden'); }, }, ico('clock', 15), 'Schedule')));
  m.replaceChildren(box); m.onclick = e => { if (e.target === m) m.classList.add('hidden'); };
  setAt(at); setTimeout(() => first.focus(), 50);
}
function renameDialog(name) {
  const sess = S.runtime.sessions.find(x => x.name === name); if (!sess || !sess.claude) return;
  const m = $('#modal'); m.classList.remove('hidden');
  const cur = sessTitle(sess); const close = () => m.classList.add('hidden');
  const inp = h('input', { class: 'txt', value: (sess.claude.label || sess.claude.title || (isNewChat(name) && sess.claude.firstPrompt) || cur).slice(0, 60), maxlength: 60, placeholder: 'empty = automatic name' });
  const save = async () => { const label = inp.value.trim(); close(); if (label === (sess.claude.label || '')) return; await act(label ? 'Renamed to ' + label : 'Name reset', api('claude-label', { session: name, label })); };
  inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); save(); } else if (ev.key === 'Escape') close(); });
  m.replaceChildren(h('div', { class: 'box settings rename' },
    h('div', { class: 'sh' }, h('h3', null, 'Rename session'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: close }, ico('x', 15))),
    h('div', { class: 'sbody' },
      h('div', { class: 'sto' }, avatar(sess.project, 'sm'), h('b', null, cur), h('span', { class: 'badge tag acc ' + (sess.claude.account || '') }, sess.claude.account || '')),
      inp,
      h('div', { class: 'hint' }, 'Shown in the session list, the terminal bar and history. Leave it empty to go back to the automatic name.')),
    h('div', { class: 'foot' }, sess.claude.label ? h('button', { class: 'btn ghost', onclick: () => { inp.value = ''; save(); } }, 'Reset') : null, h('span', { class: 'sp' }), h('button', { class: 'btn ghost', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save'))));
  m.onclick = e => { if (e.target === m) close(); };
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
}
// Recap: what I did today / yesterday, per project. Collapsed = one calm line per project; open a project to see its
// commits and sessions; open a session to see what you asked and what it edited.
const RECAP = { day: 0, data: {}, at: {}, open: JSON.parse(localStorage.getItem('bd.recap') || '{"show":true}') };
const recapSave = () => localStorage.setItem('bd.recap', JSON.stringify(RECAP.open));
function recapStrip() {
  const d = RECAP.data[RECAP.day];
  if (!d || Date.now() - (RECAP.at[RECAP.day] || 0) > 120000) { RECAP.at[RECAP.day] = Date.now(); api('recap?day=' + RECAP.day).then(r => { RECAP.data[RECAP.day] = r; renderTermStrip(); }).catch(() => {}); }
  const tabs = h('div', { class: 'seg' }, [['Today', 0], ['Yesterday', 1], ['2 days ago', 2], ['3 days ago', 3]].map(([l, i]) => h('button', { class: 'segb' + (RECAP.day === i ? ' on' : ''), onclick: () => { RECAP.day = i; renderTermStrip(); } }, l)));
  const head = h('div', { class: 'rc-head' }, h('button', { class: 'rc-toggle', onclick: () => { RECAP.open.show = !RECAP.open.show; recapSave(); renderTermStrip(); } }, h('span', { class: 'caret' }, RECAP.open.show ? '▾' : '▸'), 'Recap'), d && RECAP.open.show ? h('span', { class: 'rc-sum' }, d.day, ' · ', [d.totals.commits ? `${d.totals.commits} commits` : null, d.totals.sessions ? `${d.totals.sessions} sessions` : null, d.totals.cost ? usd(d.totals.cost) : null].filter(Boolean).join(' · ') || 'nothing recorded') : null, h('span', { class: 'sp' }), RECAP.open.show ? tabs : null);
  const box = h('section', { class: 'recap' }, head);
  if (!RECAP.open.show) return box;
  if (!d) { box.append(h('div', { class: 'rc-empty' }, 'loading…')); return box; }
  if (!d.projects.length) { box.append(h('div', { class: 'rc-empty' }, 'Nothing on ' + d.day + '.')); return box; }
  const fmtT = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  box.append(h('div', { class: 'rc-list' }, d.projects.map(p => {
    const key = d.day + '/' + p.id; const open = !!RECAP.open[key];
    const meta = [p.commits.length ? `${p.commits.length} commit${p.commits.length > 1 ? 's' : ''}` : null, p.sessions.length ? `${p.sessions.length} session${p.sessions.length > 1 ? 's' : ''}` : null, p.cost ? usd(p.cost) : null].filter(Boolean).join(' · ');
    const sub = p.sessions.map(x => x.title).filter(Boolean).slice(0, 2).join(' · ') || (p.commits[0] ? p.commits[0].subject : '');
    const row = h('div', { class: 'rc-row', onclick: () => { RECAP.open[key] = !open; recapSave(); renderTermStrip(); } },
      avatar(p.id.startsWith('dir:') ? null : p.id), h('div', { class: 'rc-t' }, h('div', { class: 'rc-n' }, p.name), sub ? h('div', { class: 'rc-s' }, sub) : null), h('span', { class: 'rc-m' }, meta), h('span', { class: 'caret' }, open ? '▾' : '▸'));
    if (!open) return h('div', { class: 'rc-p' }, row);
    const body = h('div', { class: 'rc-body' });
    if (p.commits.length) body.append(h('div', { class: 'rc-sec' }, h('div', { class: 'rc-k' }, 'Commits', h('span', { class: 'n' }, p.commits.length)), h('div', { class: 'rc-commits' }, p.commits.map(c => h('div', { class: 'rc-c' }, h('span', { class: 'mono t' }, fmtT(c.ts)), h('span', { class: 'mono hsh' }, c.hash), h('span', { class: 'sub' }, c.subject))))));
    for (const x of p.sessions) {
      const skey = key + '/' + x.sessionId; const sopen = !!RECAP.open[skey];
      body.append(h('div', { class: 'rc-sec sess' },
        h('div', { class: 'rc-k' }, h('span', { class: 'ttl' }, x.title || 'Claude session'), h('span', { class: 'badge tag acc ' + x.account }, acct(x.account)), h('span', { class: 'sp' }), h('span', { class: 'mono dim' }, `${x.turns} prompts · ${usd(x.cost)}`), h('button', { class: 'btn sm ghost', title: 'open the conversation', onclick: ev => { ev.stopPropagation(); openTranscriptFile({ file: x.transcript, title: x.title, sessionId: x.sessionId, account: x.account, cwd: x.cwd, mtime: Date.now() }); } }, ico('ext', 13), 'Open')),
        h('button', { class: 'rc-more', onclick: ev => { ev.stopPropagation(); RECAP.open[skey] = !sopen; recapSave(); renderTermStrip(); } }, h('span', { class: 'caret' }, sopen ? '▾' : '▸'), sopen ? 'Hide what I asked' : `What I asked (${Math.min(x.prompts.length, x.turns)})`),
        sopen ? h('div', { class: 'rc-q' }, x.prompts.map(q => h('div', { class: 'q' }, h('span', { class: 'mono t' }, fmtT(q.ts)), h('span', { class: 'tx' }, q.text)))) : null,
        x.files.length ? h('div', { class: 'rc-f' }, h('span', { class: 'lbl' }, 'edited'), x.files.slice(0, 14).map(f => h('span', { class: 'ag-tag', title: f }, f.split('/').pop())), x.files.length > 14 ? h('span', { class: 'dim' }, `+${x.files.length - 14}`) : null) : null));
    }
    return h('div', { class: 'rc-p open' }, row, body);
  })));
  return box;
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
    // links: [text](url) and bare URLs, http(s) only so a link can't run script here; `code` spans are matched first and left for the rule below
    x = x.replace(/(`[^`\n]+`)|\[([^\]\n]+)\]\((https?:\/\/[^\s()<]+)\)|https?:\/\/(?:(?!&quot;|&gt;|&lt;)[^\s<])+/g, (m, code, txt, url) => {
      if (code) return m;
      const a = (href, label) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      if (txt) return a(url, txt);
      let u = m; while (/[.,;:!?'*\]]$/.test(u) || (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length)) u = u.slice(0, -1);   // trailing punctuation isn't part of the URL
      return a(u, u) + m.slice(u.length);
    });
    x = x.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/^(#{1,4}) (.+)$/gm, '<b class="mh">$2</b>').replace(/^[-*] (.+)$/gm, '<span class="mli">• $1</span>').replace(/^(\d+)\. (.+)$/gm, '<span class="mli"><span class="mnum">$1.</span> $2</span>');
    return x.replace(/\n(?=<table)/g, '').replace(/(<\/table>)\n/g, '$1').replace(/\n/g, '<br>');
  }).join('');
}

// A past conversation from search (no live session): read-only view + "Resume here" (claude --resume in that folder)
async function openTranscriptFile(hh) {
  const was = UI.drawer; UI.drawer = 'session:file'; SESS.name = null; SESS.tab = 'transcript';
  $('#drawer').classList.add('open'); $('#scrim').classList.remove('hidden'); if (!was) pushLayer('drawer');
  const d = $('#drawer'); const title = hh.title || (hh.cwd || '').split('/').pop() || hh.sessionId.slice(0, 8);
  let busy = false; const once = fn => { if (busy) return; busy = true; fn().catch(() => {}).finally(() => { busy = false; }); };
  const head = h('div', { class: 'dh' }, h('div', { class: 'row1' }, h('h2', null, h('span', { class: 'sicon' }, gl('✦')), title, h('span', { class: 'badge tag acc ' + hh.account }, acct(hh.account)), h('span', { class: 'dim', style: 'font-size:12px;font-weight:500' }, 'past conversation · ' + ago(hh.mtime) + ' ago')),
      h('button', { class: 'btn sm primary', title: 'continue this conversation as a chat (headless claude -p --resume) in that folder', onclick: () => once(() => act('Continue ' + title, api('claude-resume', { sessionId: hh.sessionId, cwd: hh.cwd, account: hh.account, mode: 'chat' })).then(r => { closeDrawer(); if (r?.name) openTerm(r.name); })) }, ico('chat', 13), 'Continue in chat'),
      h('button', { class: 'btn sm', title: 'start a new tmux session in that folder with claude --resume on this conversation', onclick: () => once(() => act('Resume ' + title, api('claude-resume', { sessionId: hh.sessionId, cwd: hh.cwd, account: hh.account })).then(r => { closeDrawer(); if (r?.name) setTimeout(() => openTerm(r.name), 1200); })) }, ico('terminal', 13), 'In terminal'),
      h('button', { class: 'btn ghost close', onclick: closeDrawer }, gl('✕ Esc'))),
    h('div', { class: 'path' }, hh.cwd || '', ' · ', hh.sessionId));
  const body = h('div', { class: 'db sess' }); d.replaceChildren(head, body); body.append(h('div', { class: 'dim', style: 'padding:20px' }, 'loading…'));
  let t; try { t = await api(`transcript?file=${encodeURIComponent(hh.file)}&n=60`); } catch (e) { body.replaceChildren(h('div', { class: 'dim', style: 'padding:20px' }, e.message)); return; }
  body.innerHTML = ''; const scroller = h('div', { class: 'cscroll' }); body.append(scroller);
  const conv = h('div', { class: 'conv' });
  for (const turn of t.turns) {
    if (turn.role === 'assistant') { conv.append(assistantTurn(turn, { file: hh.file })); continue; }
    if (turn.role === 'event') { conv.append(h('div', { class: 'tevent' }, h('span', { class: 'ic' }, ico(turn.status === 'compacted' ? 'shrink' : 'gear', 13)), h('span', { class: 'tx' }, turn.text))); continue; }
    conv.append(h('div', { class: 'turn user' + (turn.role === 'shell' ? ' shell' : '') }, h('div', { class: 'who' }, turn.role === 'shell' ? gl('❯ you · shell') : gl('❯ you'), turn.ts ? h('span', { class: 'dim mono' }, ' ' + new Date(turn.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) : null), turn.role === 'shell' ? h('pre', { class: 'mcode small' }, '! ' + turn.text) : h('div', { class: 'ttext', html: mdLite(turn.text) })));
  }
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
  if (PAL.open) closePalette(false); else if (UI.drawer) closeDrawer(false); else if (TERM.open) closeTermPanel(false); else feat('back');
});
function openDrawer(id, tab = 'overview', logTarget = null) { const was = UI.drawer; UI.drawer = id; UI.tab = tab; UI.logTarget = logTarget; $('#drawer').classList.add('open'); $('#scrim').classList.remove('hidden'); renderDrawer(true); if (!was) pushLayer('drawer'); }
const CMSG = new Map();
function closeDrawer(pop = true) { if (!UI.drawer) return; UI.drawer = null; liveStream(liveWanted()); fitTermPanel(); $('#drawer').classList.remove('open'); $('#scrim').classList.add('hidden'); stopLog(); FILES.editing = false; if (pop) popLayer(); }
let drawerKey = '';
function renderDrawer(force) {
  if (String(UI.drawer).startsWith('session:')) { // live: re-read when that session got a new hook event (Claude replied / you typed)
    const cl = S.runtime.sessions.find(x => x.name === SESS.name)?.claude; const ev = cl ? cl.lastEventAt + ':' + cl.state : '';
    if (force) renderSessionDrawer(); else if (ev && ev !== SESS.lastEv) { SESS.lastEv = ev; renderSessionDrawer(false); }
    return; }
  const d = $('#drawer'); const p = byId()[UI.drawer]; if (!p) return;
  const r = runtimeFor(p.id); const g = gitOf(p);
  const key = [p.id, UI.tab, UI.logTarget, r.sessions.map(s => s.name).join(), r.containers.map(c => c.id + c.state).join(), UI.tab === 'logs' ? '' : JSON.stringify(g, (k, v) => k === 'rel' ? undefined : v), p.commands.length].join('|');
  if (!force && key === drawerKey) return; // only re-render when something relevant changed
  if (!force && UI.tab === 'changes' && key !== drawerKey && (d.querySelector('.cmsg')?.value.trim() || d.querySelector('.chdiff:not(.hidden)'))) return;
  if (!force && UI.tab === 'files' && FILES.editing) return; // never yank an editor with unsaved text
  drawerKey = key;
  const dirtyN = g && !g.error ? g.dirty + g.untracked : 0;
  const tabs = [['overview', 'Overview'], ['changes', `Changes${dirtyN ? ' (' + dirtyN + ')' : ''}`], ['files', 'Files'], ['logs', 'Logs'], ['branches', 'Branches'], ['docker', `Docker${r.containers.length ? ' (' + r.containers.length + ')' : ''}`], ['recent', 'History']];
  const ftabs = feat('drawerTabs', p, r, g); tabs.splice(3, 0, ...ftabs.map(t => [t.key, t.label]));   // feature tabs (Plan, Worktrees) after Files
  const head = h('div', { class: 'dh' }, h('div', { class: 'row1' }, h('h2', null, h('span', { style: `width:10px;height:10px;border-radius:3px;background:${orgColor(p.org)}` }), p.parentName ? p.parentName + ' › ' : '', p.name, ...badges(p)), h('a', { class: 'btn vsc', href: vscodeUrl(p.path) }, vscIcon(), ' VS Code'), h('button', { class: 'btn ghost close', onclick: closeDrawer }, gl('✕ Esc'))),
    h('div', { class: 'path' }, p.path, p.remoteRepo ? ' · ' + p.remoteRepo : ''),
    h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('div', { class: 'tab' + (UI.tab === k ? ' on' : ''), onclick: () => { UI.tab = k; renderDrawer(true); } }, l))));
  const body = h('div', { class: 'db' });
  d.replaceChildren(head, body);
  if (UI.tab !== 'logs') stopLog();
  const ft = ftabs.find(t => t.key === UI.tab);
  if (ft) { try { ft.render(body, p, r, g); } catch (e) { console.error('feature tab', ft.key, e); body.append(h('div', { class: 'dim', style: 'padding:16px' }, `${ft.label} failed to render — ${e.message}`)); } }
  else (({ overview: tabOverview, changes: tabChanges, files: tabFiles, logs: tabLogs, branches: tabBranches, docker: tabDocker, recent: tabRecent })[UI.tab] || tabOverview)(body, p, r, g);
}
function tabOverview(el, p, r, g) {
  el.append(h('h4', null, 'Info'), h('div', { class: 'kv' }, h('div', { class: 'k' }, 'Path'), h('div', { class: 'v' }, p.path), h('div', { class: 'k' }, 'Stack'), h('div', { class: 'v' }, [p.stack, p.framework, p.pm].filter(Boolean).join(' · ')), h('div', { class: 'k' }, 'Remote'), h('div', { class: 'v' }, p.remote || (p.parent ? 'inherits from ' + p.parentName : '–')), g && !g.error ? [h('div', { class: 'k' }, 'Git'), h('div', { class: 'v' }, `${g.branch}${g.upstream ? ' → ' + g.upstream : ''} · ${g.dirty} modified · ${g.untracked} untracked · ↑${g.ahead} ↓${g.behind}`)] : null, g?.last ? [h('div', { class: 'k' }, 'Last commit'), h('div', { class: 'v' }, `${g.last.hash} ${g.last.subject} — ${g.last.author}, ${g.last.rel}`)] : null, p.composeFiles.length ? [h('div', { class: 'k' }, 'Compose'), h('div', { class: 'v' }, p.composeFiles.join(', '))] : null, h('div', { class: 'k' }, 'Terminal'), h('div', { class: 'v' }, h('code', null, `ssh ${S.settings.sshHost} -t "cd '${p.path}'; exec bash -l"`), ' ', h('button', { class: 'btn sm', onclick: () => navigator.clipboard.writeText(`ssh ${S.settings.sshHost} -t "cd '${p.path}'; exec bash -l"`).then(() => toast('copied')) }, 'copy'))));
  const running = Object.fromEntries(r.sessions.map(s => [s.label, s]));
  el.append(h('h4', null, 'Commands'));
  const list = h('div', { class: 'cmdlist' });
  for (const c of p.commands) { const s = running[c.name]; list.append(h('div', { class: 'cmdrow' + (s ? ' running' : '') }, h('span', { class: 'kind' }, c.custom ? 'custom' : c.kind), h('span', { class: 'k' }, c.name), h('span', { class: 'c', title: c.cmd }, c.cmd), s ? h('span', { class: 'res mono', style: 'font-size:11px;color:var(--muted)' }, `${ago(s.startedAt)} · ${s.cpu.toFixed(0)}% · ${fmtB(s.mem)}`) : null, s ? h('button', { class: 'btn sm', onclick: () => { UI.tab = 'logs'; UI.logTarget = s.name; renderDrawer(true); } }, 'logs') : null, s ? h('button', { class: 'btn sm danger', onclick: () => act('Stop ' + c.name, api('stop', { session: s.name })) }, gl('■ stop')) : h('button', { class: 'btn sm primary', onclick: () => act(`${p.name}: ${c.name}`, api('run', { id: p.id, name: c.name })) }, gl('▶ run')), c.custom ? h('button', { class: 'btn sm ghost', title: 'remove custom command', onclick: () => saveCustom(p, (p.commands.filter(x => x.custom && x.name !== c.name)).map(({ name, cmd }) => ({ name, cmd }))) }, gl('✕')) : null)); }
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
  el.append(h('div', { class: 'logbar' }, sel, follow, filt, cnt, h('button', { class: 'btn sm', title: 'jump to the last error line', onclick: jumpErr }, gl('⚠ last error')), h('span', { style: 'flex:1' }), sess ? h('button', { class: 'btn sm primary', onclick: () => openTerm(sess.name) }, gl('⌨ Terminal')) : null, sess ? h('button', { class: 'btn sm', onclick: () => navigator.clipboard.writeText(`ssh ${S.settings.sshHost} -t tmux attach -t ${sess.name}`).then(() => toast('copied — paste in terminal to attach to tmux')) }, gl('⎘ tmux attach')) : null, sess ? h('button', { class: 'btn sm', onclick: () => act('Restart', api('restart', { session: sess.name })) }, gl('↻ restart')) : null, sess ? h('button', { class: 'btn sm danger', onclick: () => act('Stop', api('stop', { session: sess.name })) }, gl('■ stop')) : null, h('button', { class: 'btn sm ghost', onclick: () => box.innerHTML = '' }, 'clear')), box);
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
  // status at a glance: what is NOT committed, what is NOT pushed
  const pills = [];
  if (total) pills.push(h('span', { class: 'chpill warn' }, `● ${total} uncommitted`));
  if (!d.upstream) pills.push(h('span', { class: 'chpill mute' }, 'local only — no remote'));
  else if (d.ahead) pills.push(h('span', { class: 'chpill hot', title: `${d.ahead} commits exist only here — run git push` }, `⬆ ${d.ahead} NOT PUSHED`));
  else pills.push(h('span', { class: 'chpill ok' }, total ? gl('✓ commits pushed') : gl('✓ committed & pushed')));
  if (d.behind) pills.push(h('span', { class: 'chpill mute' }, gl(`⬇ ${d.behind} behind`)));
  box.replaceChildren(h('div', { class: 'chhead' },
    h('span', { class: 'branch', style: 'cursor:default' }, h('span', { class: 'ico' }, ico('branch', 13)), h('span', { class: 'b' }, d.branch || '?')),
    d.upstream ? h('span', { class: 'dim mono', style: 'font-size:11.5px' }, '→ ' + d.upstream) : null,
    ...pills,
    h('span', { class: 'sp' }),
    h('button', { class: 'btn sm', onclick: () => renderDrawer(true) }, gl('↻ refresh'))));
  if (!total) box.append(h('div', { class: 'chclean' }, gl('✓ Working tree clean — nothing staged, nothing pending.')));
  // commit + push from here, so a session's leftover changes don't need a terminal
  if (total || d.ahead) {
    const msg = h('input', { class: 'txt cmsg', value: CMSG.get(target.id) || '', oninput: e => CMSG.set(target.id, e.target.value), placeholder: total ? 'commit message… (Enter = commit' + (d.upstream ? ', ⇧Enter = commit & push' : '') + ')' : 'nothing to commit', disabled: !total, autocomplete: 'off' });
    const gitDo = async (action, label, extra) => { try { await act(`${target.name}: ${label}`, api('git', { id: target.id, action, ...extra })); } catch {} renderDrawer(true); };
    const doCommit = async (thenPush) => { const m = msg.value.trim(); if (!m) { msg.focus(); return; } if (d.staged.length === 0 && confirm('Nothing is staged. Stage ALL changes (git add -A) and commit?') === false) return; if (d.staged.length === 0) await act('stage all', api('git', { id: target.id, action: 'stage-all' })); await act('commit', api('git', { id: target.id, action: 'commit', message: m })); CMSG.delete(target.id); if (thenPush) await act('push', api('git', { id: target.id, action: 'push' })); renderDrawer(true); };
    msg.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); doCommit(ev.shiftKey); } });
    box.append(h('div', { class: 'cbox' }, msg,
      total ? h('button', { class: 'btn sm', title: 'git add -A', onclick: () => gitDo('stage-all', 'stage all') }, '＋ Stage all') : null,
      d.staged.length ? h('button', { class: 'btn sm ghost', title: 'git reset', onclick: () => gitDo('unstage-all', 'unstage all') }, '－ Unstage') : null,
      total ? h('button', { class: 'btn sm primary', title: 'commit staged (stages everything first if nothing is staged)', onclick: () => doCommit(false) }, gl('✓ Commit')) : null,
      total ? h('button', { class: 'btn sm primary', title: 'commit, then git push', onclick: () => doCommit(true) }, gl('✓ Commit & push')) : null,
      d.ahead || !d.upstream ? h('button', { class: 'btn sm' + (d.ahead ? ' hotbtn' : ''), title: d.upstream ? 'git push' : 'git push -u origin HEAD', onclick: () => gitDo('push', 'push') }, `⬆ Push${d.ahead ? ' ' + d.ahead : ''}`) : null));
  }
  const frow = (f, kind) => {
    const caret = h('span', { class: 'caret' }, '▸');
    const row = h('div', { class: 'chfile' },
      h('span', { class: 'chst s' + (f.s || 'Q') }, f.s || '?'), fileIcon(f.path),
      h('span', { class: 'chpath' }, f.from ? f.from + ' → ' + f.path : f.path),
      f.add != null ? h('span', { class: 'chnum add' }, '+' + f.add) : null,
      f.del != null ? h('span', { class: 'chnum del' }, '−' + f.del) : null,
      p.isGit ? h('button', { class: 'btn sm ghost', title: 'open in Files tab (content, download, edit)', onclick: ev => { ev.stopPropagation(); FILES.sel = f.path; FILES.mode = 'content'; openDrawer(UI.drawer, 'files'); } }, gl('▤')) : null, caret);
    const dv = h('div', { class: 'chdiff hidden', 'data-root': target.path });
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
    h('button', { class: 'btn sm ghost', title: 'copy full hash', onclick: ev => { ev.stopPropagation(); navigator.clipboard?.writeText(c.hash).then(() => toast('copied')); } }, gl('⎘ hash'))));
  if (c.body) el.append(h('pre', { class: 'cbody' }, c.body));
  for (const f of c.files) {
    const caret = h('span', { class: 'caret' }, '▸');
    const row = h('div', { class: 'chfile' }, h('span', { class: 'chst s' + (f.s || 'M') }, f.s || 'M'), fileIcon(f.path), h('span', { class: 'chpath' }, f.from ? f.from + ' → ' + f.path : f.path), f.add != null ? h('span', { class: 'chnum add' }, '+' + f.add) : null, f.del != null ? h('span', { class: 'chnum del' }, '−' + f.del) : null,
      byId()[UI.drawer]?.isGit ? h('button', { class: 'btn sm ghost', title: 'open in Files tab', onclick: ev => { ev.stopPropagation(); FILES.sel = f.path; FILES.mode = 'content'; openDrawer(UI.drawer, 'files'); } }, gl('▤')) : null, caret);
    const dv = h('div', { class: 'chdiff hidden', 'data-root': target.path }); let open = false, loaded = false;
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
const mediaOf = n => { const x = (n.split('.').pop() || '').toLowerCase(); return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(x) ? 'img' : x === 'pdf' ? 'pdf' : ['mp4', 'webm', 'mov'].includes(x) ? 'video' : null; };
const STATUS_TITLE = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '?': 'untracked', U: 'conflict' };
// o: { st: own state (open folders / selection), key: localStorage key for open folders, select: checkboxes + bulk
// download (zip) / delete, noEdit, newest: files newest-first }. Projects use the defaults; ~/Downloads passes all of them.
function tabFiles(el, p, o = {}) {
  const st = o.st || FILES; const okey = o.key || 'bd.fopen';
  el.classList.add('files-tab');
  const tree = h('div', { class: 'ftree' }); const prev = h('div', { class: 'fprev' }, h('div', { class: 'dim', style: 'padding:20px' }, o.select ? 'Pick a file to preview it (images, PDFs, text). Tick files or folders on the left to download them — several at once come as one .zip.' : 'Pick a file. Changed files are marked; the preview shows their diff against HEAD.'));
  // selection (Downloads): a checkbox per row, a sticky bar with Download (one file direct, more / folders as .zip) and Delete
  const picked = st.picked || (st.picked = new Set());
  const selBar = o.select ? h('div', { class: 'fselbar' }) : null;
  const renderSel = () => {
    if (!selBar) return; const n = picked.size; const ps = [...picked];
    const one = n === 1 && tree.querySelector(`.frow.file[data-path="${CSS.escape(ps[0])}"]`);
    const href = one ? `/api/download/${p.id}?path=${encodeURIComponent(ps[0])}` : `/api/zip/${p.id}?` + ps.map(x => 'path=' + encodeURIComponent(x)).join('&');
    selBar.replaceChildren(...[
      h('button', { class: 'btn sm ghost', title: n ? 'clear selection' : 'select everything at the top level', onclick: () => { if (n) picked.clear(); else for (const r of tree.querySelectorAll(':scope > .frow')) picked.add(r.dataset.path); syncChecks(); } }, n ? '☐ none' : '☑ all'),
      h('span', { class: 'dim mono fselc' }, n ? n + ' selected' : 'tick files to download'),
      h('span', { class: 'sp' }),
      h('button', { class: 'btn sm ghost', title: 'reload', onclick: () => loadDir('', tree, 0) }, gl('↻')),
      n ? h('button', { class: 'btn sm ghost danger', title: 'delete the selected files / folders from the server', onclick: async () => { if (!confirm(`Delete ${n} item${n > 1 ? 's' : ''} from ${o.rootLabel || 'here'}?\n\n` + ps.slice(0, 12).join('\n') + (n > 12 ? '\n…' : ''))) return; try { const r = await api('rmpaths', { id: p.id, paths: ps }); toast(r.failed?.length ? 'some failed: ' + r.failed[0] : 'deleted ' + n, r.failed?.length ? 'err' : 'ok'); } catch (e) { toast(e.message, 'err'); } picked.clear(); if (ps.includes(st.sel)) { st.sel = null; prev.replaceChildren(h('div', { class: 'dim', style: 'padding:20px' }, 'Pick a file.')); } loadDir('', tree, 0); } }, '🗑') : null,
      n ? h('a', { class: 'btn sm primary', href, download: one ? ps[0].split('/').pop() : '', title: one ? 'download' : 'download as one .zip' }, one ? gl('⬇ Download') : gl(`⬇ Download ${n} (.zip)`)) : null].filter(Boolean));
  };
  const syncChecks = () => { for (const c of tree.querySelectorAll('.fchk')) c.classList.toggle('on', picked.has(c.parentElement.dataset.path)); renderSel(); };
  const chk = path => o.select ? h('span', { class: 'fchk' + (picked.has(path) ? ' on' : ''), title: 'select', onclick: ev => { ev.stopPropagation(); if (picked.has(path)) picked.delete(path); else picked.add(path); syncChecks(); } }) : null;
  el.append(h('div', { class: 'fwrap' + (st.wide ? ' wide' : '') + (o.select ? ' sel' : '') }, selBar ? h('div', { class: 'ftreebox' }, selBar, tree) : tree, prev));
  renderSel();
  const gitTarget = p.isGit ? p : byId()[p.parent];
  const loadDir = async (rel, box, depth) => {
    box.innerHTML = ''; let d; try { d = await api(`tree/${p.id}?path=${encodeURIComponent(rel)}`); } catch (e) { box.append(h('div', { class: 'dim' }, e.message)); return; }
    if (d.error) { box.append(h('div', { class: 'dim' }, d.error)); return; }
    if (o.newest) d.entries.sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || a.name.localeCompare(b.name));   // Downloads: last modified first, folders and files together (like a file manager sorted by date)
    if (!d.entries.length && !depth) box.append(h('div', { class: 'dim', style: 'padding:12px' }, 'empty'));
    for (const e of d.entries) {
      if (e.type === 'dir') {
        const kids = h('div', { class: 'fkids' }); const isOpen = st.open.has(e.path);
        const row = h('div', { class: 'frow dir' + (e.changed ? ' has' : '') + (e.skip ? ' skip' : ''), style: `padding-left:${8 + depth * 14}px`, title: e.skip ? 'build / dependency folder' : e.path, 'data-path': e.path },
          chk(e.path), h('span', { class: 'fcaret' }, isOpen ? '▾' : '▸'), h('span', { class: 'fico' }, ico(isOpen ? 'folderOpen' : 'folder', 15)), h('span', { class: 'fname' }, e.name), e.changed ? h('span', { class: 'fchg', title: e.changed + ' changed files inside' }, e.changed) : null);
        row.onclick = () => { const now = !st.open.has(e.path); if (now) st.open.add(e.path); else st.open.delete(e.path); localStorage.setItem(okey, JSON.stringify([...st.open].slice(-200))); row.querySelector('.fcaret').textContent = now ? '▾' : '▸'; row.querySelector('.fico').replaceChildren(ico(now ? 'folderOpen' : 'folder', 15)); kids.classList.toggle('hidden', !now); if (now && !kids.childElementCount) loadDir(e.path, kids, depth + 1); };
        if (!isOpen) kids.classList.add('hidden'); else loadDir(e.path, kids, depth + 1);
        box.append(row, kids);
      } else {
        const row = h('div', { class: 'frow file' + (e.status ? ' has st' + (e.status === '?' ? 'Q' : e.status) : '') + (st.sel === e.path ? ' on' : ''), style: `padding-left:${8 + depth * 14}px`, title: e.path + ' · ' + fmtB(e.size) + (e.status ? ' · ' + (STATUS_TITLE[e.status] || e.status) : ''), 'data-path': e.path },
          chk(e.path), h('span', { class: 'fcaret' }), h('span', { class: 'fico' }, fileIcon(e.name)), h('span', { class: 'fname' }, e.name), e.status ? h('span', { class: 'chst s' + (e.status === '?' ? 'Q' : e.status), title: STATUS_TITLE[e.status] || e.status }, e.status) : null, h('span', { class: 'fsize mono' }, fmtB(e.size) + (o.newest && e.mtime ? ' · ' + ago(e.mtime) : '')));
        row.onclick = () => { if (st.editing && !confirm('Discard unsaved edits?')) return; st.editing = false; if (st.sel !== e.path) st.mode = 'auto'; st.sel = e.path; for (const x of tree.querySelectorAll('.frow.file.on')) x.classList.remove('on'); row.classList.add('on'); showFile(e); };
        box.append(row);
      }
    }
  };
  const showFile = async (e) => {
    prev.innerHTML = ''; prev.append(h('div', { class: 'dim', style: 'padding:20px' }, 'loading…'));
    const status = e.status; const wantDiff = status && status !== '?' && status !== 'A' ? (st.mode === 'auto' || st.mode === 'diff') : st.mode === 'diff' && status === '?';
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
        status ? h('button', { class: 'btn sm' + (showDiff ? ' primary' : ''), onclick: () => { st.mode = 'diff'; showFile(e); } }, '± diff') : null,
        h('button', { class: 'btn sm' + (!showDiff && !st.editing ? ' primary' : ''), onclick: () => { st.mode = 'content'; st.editing = false; showFile(e); } }, gl('▤ content')),
        !o.noEdit && !content.error && !content.binary && !content.truncated ? h('button', { class: 'btn sm' + (st.editing ? ' primary' : ''), title: 'edit in place (simple text editor)', onclick: () => { st.mode = 'content'; st.editing = true; render(); } }, gl('✎ edit')) : null,
        h('a', { class: 'btn sm', href: `/api/download/${p.id}?path=${encodeURIComponent(e.path)}&inline=1`, target: '_blank', rel: 'noopener', title: 'open in a new tab' }, '↗ open'),
        h('a', { class: 'btn sm', href: `/api/download/${p.id}?path=${encodeURIComponent(e.path)}`, download: e.name, title: 'download this file' }, gl('⇩ download')),
        h('button', { class: 'btn sm ghost', title: st.wide ? 'show tree' : 'hide tree', onclick: () => { st.wide = !st.wide; !o.st && localStorage.setItem('bd.fwide', st.wide ? '1' : '0'); el.querySelector('.fwrap').classList.toggle('wide', st.wide); } }, st.wide ? '⇤' : '⇥'));
      prev.append(bar);
      if (st.editing && content && !content.error && !content.binary) {
        const ta = h('textarea', { class: 'fedit', spellcheck: false }); ta.value = content.text;
        ta.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Tab') { ev.preventDefault(); const s0 = ta.selectionStart; ta.setRangeText('  ', s0, ta.selectionEnd, 'end'); } if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') { ev.preventDefault(); saveBtn.click(); } });
        const saveBtn = h('button', { class: 'btn sm primary', onclick: async () => { try { const r = await api('savefile', { id: p.id, path: e.path, text: ta.value, mtime: content.mtime }); content.mtime = r.mtime; content.size = r.size; content.text = ta.value; st.editing = false; toast('saved ' + e.name, 'ok'); showFile(e); } catch (err) { toast('save failed: ' + err.message, 'err'); } } }, '💾 Save (⌘S)');
        prev.append(h('div', { class: 'fedbar' }, h('span', { class: 'dim' }, 'Editing in place. Save refuses if the file changed on disk meanwhile (a Claude session may be working here).'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost', onclick: () => { st.editing = false; render(); } }, 'Cancel'), saveBtn), ta);
        setTimeout(() => { ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0; }, 0);
        return;
      }
      if (showDiff) { prev.append(h('div', { class: 'chdiff fdiff hljs', 'data-root': (gitTarget || p).path, html: renderDiffHl(diff.text, langOf(e.name)) })); return; }
      if (content.error) { prev.append(h('div', { class: 'dim', style: 'padding:20px' }, content.error)); return; }
      const media = mediaOf(e.name), raw = `/api/download/${p.id}?path=${encodeURIComponent(e.path)}&inline=1`;
      if (media === 'img') { prev.append(h('div', { class: 'fmedia' }, h('img', { src: raw, alt: e.name }))); return; }
      if (media === 'pdf') { prev.append(h('iframe', { class: 'fmedia pdf', src: raw, title: e.name })); return; }
      if (media === 'video') { prev.append(h('div', { class: 'fmedia' }, h('video', { src: raw, controls: true }))); return; }
      if (content.binary) { prev.append(h('div', { class: 'dim', style: 'padding:20px' }, 'binary file — use download')); return; }
      if (status && diff && diff.error) prev.append(h('div', { class: 'dim', style: 'padding:6px 12px' }, 'diff: ' + diff.error));
      const lines = hlLines(content.text, langOf(e.name));
      prev.append(h('pre', { class: 'fcode hljs' }, lines.map((l, i) => h('div', { class: 'ln' }, h('span', { class: 'n' }, i + 1), h('span', { class: 't', html: l || ' ' }))), content.truncated ? h('div', { class: 'dim' }, '… truncated (2 MB shown) — download for the whole file') : null));
    }
  };
  loadDir('', tree, 0).then(() => { if (st.sel) { const row = tree.querySelector(`.frow.file[data-path="${CSS.escape(st.sel)}"]`); if (row) row.click(); else { const parts = st.sel.split('/'); if (parts.length > 1) { for (let i = 1; i < parts.length; i++) st.open.add(parts.slice(0, i).join('/')); loadDir('', tree, 0).then(() => setTimeout(() => { const r2 = tree.querySelector(`.frow.file[data-path="${CSS.escape(st.sel)}"]`); if (r2) r2.click(); }, 400)); } } } });
}

async function tabBranches(el, p) {
  const target = p.isGit ? p : byId()[p.parent]; if (!target) { el.append(h('div', { class: 'dim' }, 'Not a git repo.')); return; }
  el.append(h('div', { class: 'logbar' }, h('button', { class: 'btn sm', onclick: () => act('fetch', api('git', { id: target.id, action: 'fetch' })).then(() => renderDrawer(true)) }, gl('⇣ Fetch all')), h('button', { class: 'btn sm', onclick: () => act('pull', api('git', { id: target.id, action: 'pull' })) }, '↓ Pull'), h('button', { class: 'btn sm', onclick: () => act('stash', api('git', { id: target.id, action: 'stash' })) }, gl('⧉ Stash')), h('button', { class: 'btn sm', onclick: () => act('stash pop', api('git', { id: target.id, action: 'stash-pop' })) }, gl('⧉ Pop'))));
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
    c.state === 'running' ? [h('button', { class: 'btn sm', onclick: () => act('restart ' + c.name, api('docker', { id: c.id, action: 'restart' })) }, gl('↻')), h('button', { class: 'btn sm danger', onclick: () => act('stop ' + c.name, api('docker', { id: c.id, action: 'stop' })) }, gl('■'))] : [h('button', { class: 'btn sm primary', onclick: () => act('start ' + c.name, api('docker', { id: c.id, action: 'start' })) }, gl('▶')), h('button', { class: 'btn sm danger', onclick: () => confirm('Remove container ' + c.name + '?') && act('rm ' + c.name, api('docker', { id: c.id, action: 'rm' })) }, '🗑')]));
}
function tabRecent(el, p) {
  const rec = S.runtime.recent.filter(x => x.project === p.id);
  if (!rec.length) { el.append(h('div', { class: 'dim' }, 'No finished runs yet.')); return; }
  el.append(h('div', { class: 'recent' }, rec.map(x => h('div', { class: 'r' }, h('span', { class: x.exitCode === 0 ? 'ok' : 'bad' }, x.exitCode === 0 ? gl('✓') : '✗ ' + (x.exitCode ?? '?')), h('span', { style: 'min-width:120px;color:var(--text)' }, x.name), h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, x.cmd), h('span', null, `${ago(x.startedAt)} ago · ran ${Math.round((x.endedAt - x.startedAt) / 1000)}s`), h('button', { class: 'btn sm', onclick: () => { UI.tab = 'logs'; UI.logTarget = x.name; renderDrawer(true); } }, 'log'), h('button', { class: 'btn sm', onclick: () => act('re-run ' + x.name, api('run', { id: p.id, name: x.name, cmd: x.cmd })) }, gl('▶'))))));
}

// ---------- settings ----------
function settingsModal() {
  const s = S.settings; const m = $('#modal'); m.classList.remove('hidden');
  // iOS-style grouped settings: a titled group of rows, label + hint on the left, the control on the right
  const sect = (title, ...rows) => h('section', { class: 'sg' }, h('div', { class: 'sg-t' }, title), h('div', { class: 'sg-b' }, ...rows.filter(Boolean)));
  const row = (label, hint, ctl, cls = '') => h('div', { class: 'sr ' + cls }, h('div', { class: 'sr-l' }, h('div', { class: 'sr-k' }, label), hint ? h('div', { class: 'sr-h' }, hint) : null), h('div', { class: 'sr-c' }, ctl));
  const sw = (checked, attrs = {}) => h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked, ...attrs }), h('i'));
  const txt = (k, extra = {}) => { const i = h('input', { class: 'txt', value: s[k] ?? '', ...extra }); i.dataset.k = k; return i; };
  const auto = h('input', { type: 'checkbox', checked: s.autoExpose, onchange: e => { if (e.target.checked && !s.autoExpose && !confirm(AUTO_EXPOSE_WARN)) e.target.checked = false; } });
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
        ncb('done', 'Session finished'), ncb('permission', 'Needs permission'), ncb('error', 'Session error'), ncb('limit', 'Usage limit hit'), ncb('crash', 'Dev server died'), ncb('system', 'Server too hot / out of memory / runaway process / battery low'), ncb('digest', 'Monday weekly digest'), row('Morning summary', '08:00 — tasks to review, sessions that need you, yesterday\'s spend', sw(n.daily !== false, { 'data-n': 'daily' })),
        row('Quiet hours', 'no push between these times', h('span', { class: 'qh' }, qf, h('span', { class: 'dim' }, '–'), qt)),
        row('Sound', 'ding on this device when a session needs you', sw(SOUND.on, { onchange: e => { SOUND.on = e.target.checked; localStorage.setItem('bd.sound', SOUND.on ? '1' : '0'); if (SOUND.on) ding('done'); } })),
        row('Push', PUSH.supported ? `${S.host.pushSubs || 0} device(s) subscribed · ` + (PUSH.sub ? 'enabled here' : 'not enabled on this device') : 'needs HTTPS (service worker) — open via https://' + (S.host.tsName || '<magicdns-name>'),
          PUSH.supported ? h('span', { class: 'qh' }, PUSH.sub ? h('button', { class: 'btn sm', onclick: () => disablePush().then(() => m.classList.add('hidden')) }, 'Disable') : h('button', { class: 'btn sm primary', onclick: () => enablePush().then(() => m.classList.add('hidden')) }, 'Enable'), h('button', { class: 'btn sm ghost', onclick: () => api('push-test', {}).then(r => toast(`test sent to ${r.sent || 0} device(s)`)) }, 'Test')) : null),
        (s.muted || []).length ? row('Muted sessions', s.muted.join(', '), h('span', { class: 'dim', style: 'font-size:11.5px' }, 'bell in the terminal bar')) : null),
      s.sleepButton ? sect('Power',
        row('Sleep', 'suspend the server now — it wakes itself ' + (S.host.nextWake ? 'on ' + new Date(S.host.nextWake).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' (Mon–Fri 07:00)' : 'at 07:00 on weekdays'), h('button', { class: 'btn sm', onclick: sleepModal }, gl('☾ Sleep…')))) : null,
      sect('Sessions',
        row('Auto-restore after reboot', 'claude --resume in the same folders as soon as the dashboard starts', sw(!!s.autoRestore, { id: 'set-autorestore' })),
        row('Messages while Claude works', 'chat sessions, this device · ' + (IS_PHONE ? 'the send button does this, the second button the other' : 'Enter does this, Alt+Enter the other'), h('span', { class: 'seg' }, [['steer', 'Send now'], ['queue', 'After the turn']].map(([v, l]) => h('button', { class: 'segb' + (followUp() === v ? ' on' : ''), title: v === 'steer' ? 'goes into the running turn — Claude reads it at its next step' : 'waits in the queue and goes out when the turn is over', onclick: ev => { FEAT.queue?.setFollowUp(v); for (const b of ev.currentTarget.parentElement.children) b.classList.toggle('on', b === ev.currentTarget); renderChatPane(true); } }, l)))),
        row('Move chats to a new Claude Code', 'when a new version passes the start check, chat sessions restart on it one by one (idle now, busy ones after their turn)', sw(s.chatAutoUpgrade !== false, { id: 'set-chatupgrade' }))),
      sect('Claude accounts',
        row(acct('personal') + ' (~/.claude)', 'name shown on cards and badges', h('input', { class: 'txt', value: s.accountLabels?.personal ?? 'Personal', 'data-acct': 'personal' })),
        row(acct('company') + ' (~/.claude-company)', 'second login via CLAUDE_CONFIG_DIR — leave as is if you only use one', h('input', { class: 'txt', value: s.accountLabels?.company ?? 'Company', 'data-acct': 'company' }))),
      sect('Connection',
        row('SSH host alias', 'as in ~/.ssh/config on your laptop · used for VS Code links and copied ssh commands', txt('sshHost', { placeholder: 'myserver' })),
        row('SSH user', 'empty if the alias sets it', txt('sshUser')),
        row('Public host for port links', `empty = ${S.host.tsIp || 'tailscale IP'}${S.host.tsName ? ' · "' + S.host.tsName + '" if MagicDNS works' : ''}`, txt('publicHost', { placeholder: S.host.tsIp || '' })),
        row('Dev root', 'folder scanned for projects', txt('devRoot')),
        row('Scan depth', '', txt('scanDepth', { type: 'number', class: 'txt sm' }))),
      hidden.length ? sect('Hidden projects', ...hidden.map(id => row(id, '', h('button', { class: 'btn sm', onclick: () => api('project', { id, hidden: false }).then(() => { m.classList.add('hidden'); toast('unhidden'); }) }, 'Unhide')))) : null),
    h('div', { class: 'foot' }, h('button', { class: 'btn ghost', onclick: () => m.classList.add('hidden') }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => { const patch = { autoExpose: auto.checked, autoRestore: !!box.querySelector('#set-autorestore')?.checked, chatAutoUpgrade: !!box.querySelector('#set-chatupgrade')?.checked, notify: { ...(s.notify || {}) } }; for (const i of box.querySelectorAll('input[data-n]')) patch.notify[i.dataset.n] = i.checked; for (const i of box.querySelectorAll('input[data-q]')) patch.notify[i.dataset.q] = i.value; for (const i of box.querySelectorAll('input[data-k]')) patch[i.dataset.k] = i.type === 'number' ? +i.value : i.value.trim(); patch.accountLabels = { ...(s.accountLabels || {}) }; for (const i of box.querySelectorAll('input[data-acct]')) patch.accountLabels[i.dataset.acct] = i.value.trim() || i.dataset.acct; await act('Settings saved', api('settings', patch)); m.classList.add('hidden'); } }, 'Save')));
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
  const review = open.filter(t => t.result); const doing = open.filter(t => t.status === 'doing' && !t.result); const todo = open.filter(t => t.status === 'todo');
  for (const [label, ts, cls] of [['Needs your review', review, ' review'], ['In progress', doing, ''], ['To do', todo, '']]) { if (!ts.length) continue; el.append(h('div', { class: 'tksec' + cls }, label, h('span', { class: 'n' }, ts.length)), h('div', { class: 'tklist' }, ts.map(taskCard))); }
  if (TASKS_UI.showDone && done.length) el.append(h('div', { class: 'tksec' }, 'Done', h('span', { class: 'n' }, done.length)), h('div', { class: 'tklist done' }, done.sort((a, b) => b.doneAt - a.doneAt).map(taskCard)));
}
function taskCard(t) {
  const p = t.project && byId()[t.project]; const live = p ? S.runtime.sessions.filter(s => s.claude && s.project === p.id) : [];
  const lastRun = t.runs[t.runs.length - 1]; const runSess = lastRun && S.runtime.sessions.find(s => s.name === lastRun.session);
  const imgs = t.files.filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f)); const others = t.files.filter(f => !imgs.includes(f));
  return h('div', { class: 'tk st-' + t.status, 'data-id': t.id },
    h('div', { class: 'tk-head' }, avatar(p ? p.id : null), h('div', { class: 'tk-hd' }, h('div', { class: 'tk-title', onclick: () => taskModal(t) }, t.title), h('div', { class: 'tk-sub' }, p ? p.name : h('span', { class: 'dim' }, 'no project'), ' · ', ago(t.createdAt) + ' ago', lastRun ? [' · ', h('span', { class: 'tk-run' + (runSess ? ' on' : '') }, 'sent to ', runSess ? h('a', { href: '#', onclick: ev => { ev.preventDefault(); openTerm(lastRun.session); } }, lastRun.session.replace(/^claude-/, '')) : lastRun.session.replace(/^claude-/, ''), ' ', ago(lastRun.at) + ' ago')] : null)),
      h('div', { class: 'tk-acts' },
        t.status !== 'done' ? h('button', { class: 'btn sm primary', title: 'hand this task to Claude on ' + (p ? p.name : 'its project'), onclick: ev => runTaskMenu(ev, t) }, gl('▶ Run'), h('span', { class: 'caret' }, '▾')) : null,
        t.status !== 'done' ? h('button', { class: 'btn sm', title: 'mark done', onclick: () => api('task-update', { id: t.id, status: 'done' }).then(() => toast('done ✓', 'ok')) }, gl('✓ Done')) : h('button', { class: 'btn sm', title: 'reopen', onclick: () => api('task-update', { id: t.id, status: 'todo' }) }, gl('↺ Reopen')),
        h('button', { class: 'btn sm icon ghost', title: 'edit', onclick: () => taskModal(t) }, gl('✎')),
        h('button', { class: 'btn sm icon ghost', title: 'delete', onclick: () => { if (confirm('Delete this task?')) api('task-remove', { id: t.id }); } }, ico('x', 13)))),
    t.result ? h('div', { class: 'tk-result' + (t.result.ok ? '' : ' err') }, h('div', { class: 'tk-rh' }, t.result.ok ? gl('✓ Claude finished') : '✗ failed', h('span', { class: 'dim' }, ' · ' + ago(t.result.at) + ' ago'), h('span', { class: 'sp' }), t.status !== 'done' ? h('button', { class: 'btn sm primary', onclick: () => api('task-update', { id: t.id, status: 'done' }).then(() => toast('done ✓', 'ok')) }, gl('✓ Accept · Done')) : null, t.result.session ? h('button', { class: 'btn sm', onclick: () => openTerm(t.result.session) }, 'Open chat') : null), h('div', { class: 'tk-rs' }, oneLine(t.result.summary || t.result.error || '', 600))) : null,
    t.body ? h('div', { class: 'tk-body', onclick: () => taskModal(t) }, t.body) : null,
    imgs.length || others.length ? h('div', { class: 'tk-files' }, imgs.map(f => h('a', { href: '/api/file?p=' + encodeURIComponent(f), target: '_blank', title: f.split('/').pop() }, h('img', { src: '/api/file?p=' + encodeURIComponent(f), loading: 'lazy' }))), others.map(f => h('a', { class: 'tk-file', href: '/api/file?p=' + encodeURIComponent(f), target: '_blank', title: f }, ico('clip', 12), f.split('/').pop()))) : null);
}
function runTaskMenu(ev, t) {
  const p = t.project && byId()[t.project]; if (!p) { toast('pick a project for this task first', 'err'); return taskModal(t); }
  const live = S.runtime.sessions.filter(s => s.claude && s.project === p.id);
  const others = (S.claude?.tasks || []).filter(x => x.project === p.id && x.status !== 'done' && x.id !== t.id);
  const go = (account, session, ids) => act((ids ? ids.length + ' tasks' : 'Task') + ' → ' + p.name, api('task-run', { id: t.id, account, session, ids })).then(r => { if (r && r.session) setTimeout(() => openTerm(r.session), 1200); });
  const chain = [t.id, ...others.map(x => x.id)];
  openMenu(ev, [
    { header: 'Send the task as a prompt to…' },
    ...live.map(s => ({ label: (s.claude.label || p.name) + (instOf(s).n ? ' #' + instOf(s).n : ''), sub: `${s.name} · ${STATE_LABEL[s.claude.state] || ''}${s.claude.state === 'working' ? ' — queued until it is idle' : ''}`, icon: '●', cur: true, onclick: () => go(s.claude.account, s.name) })),
    live.length ? 'sep' : null,
    { label: `New ${acctL('personal')} session`, sub: 'starts claude in ' + home(p.path), icon: '＋', onclick: () => go('personal') },
    { label: `New ${acctL('company')} session`, sub: `starts claude (${acctL('company')} account)`, icon: '＋', onclick: () => go('company') },
    others.length ? 'sep' : null,
    others.length ? { header: `Chain: this + ${others.length} more open task${others.length > 1 ? 's' : ''} on ${p.name}, one after another` } : null,
    ...(others.length ? live.map(s => ({ label: 'Run all on ' + (s.claude.label || p.name) + (instOf(s).n ? ' #' + instOf(s).n : ''), sub: s.name, icon: '▶▶', onclick: () => go(s.claude.account, s.name, chain) })) : []),
    others.length ? { label: `Run all in a new ${acctL('personal')} session`, icon: '▶▶', onclick: () => go('personal', null, chain) } : null,
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
  $('#view-home').classList.toggle('hidden', v !== 'home'); $('#view-projects').classList.toggle('hidden', v !== 'projects'); $('#view-tasks').classList.toggle('hidden', v !== 'tasks'); $('#view-code').classList.toggle('hidden', v !== 'code');
  for (const b of document.querySelectorAll('#nav .navb')) b.classList.toggle('on', b.dataset.view === v);
  if (v === 'home' && !keepQuery) { $('#search').value = ''; UI.q = ''; }
  render();
}
function render() {
  if (UI.menuOpen) return; // don't yank menus from under the cursor
  $('#view-home').classList.toggle('hidden', UI.view !== 'home'); $('#view-projects').classList.toggle('hidden', UI.view !== 'projects'); $('#view-tasks').classList.toggle('hidden', UI.view !== 'tasks'); $('#view-code').classList.toggle('hidden', UI.view !== 'code');
  for (const b of document.querySelectorAll('#nav .navb')) b.classList.toggle('on', b.dataset.view === UI.view);
  for (const b of document.querySelectorAll('#tabbar .tb')) b.classList.toggle('on', b.dataset.view === UI.view);
  document.body.classList.toggle('view-projects', UI.view === 'projects'); document.body.dataset.view = UI.view;
  const vt = $('#vtitle'); if (vt) vt.textContent = ({ home: 'Home', projects: 'Projects', tasks: 'Tasks', code: 'Code' })[UI.view] || '';
  renderHeader(); renderBanner(); renderTunnels(); renderRail();
  if (UI.view === 'home') { renderStats(); renderFeatHome(); renderTermStrip(); renderRunning(); } else if (UI.view === 'tasks') renderTasks(); else if (UI.view !== 'code') renderMain();
  if (UI.drawer) renderDrawer(false);
  if (TERM.open) { renderTermPanel(); renderChatPane(false); } else $('#term-count').textContent = S.runtime.sessions.length;
  gcFrames();
  if (PAL.open) renderPalette();
  feat('onState');
}
// Home tiles from feature modules (inbox banner, emulator, cost by model). Features hand back the same nodes every
// time, so the section is only rebuilt when the set of tiles changes — images don't reload, nothing flickers.
function renderFeatHome() {
  const el = $('#feat-home'); if (!el) return;
  const all = feat('homeTiles'); const hero = all.filter(x => x.dataset?.slot === 'hero'); const t = all.filter(x => x.dataset?.slot !== 'hero');
  const put = (box, list) => { if (!box) return; const kids = [...box.children]; if (list.length !== kids.length || list.some((x, i) => x !== kids[i])) box.replaceChildren(...list); box.classList.toggle('hidden', !list.length); };
  put(el, t); put($('#home-hero'), hero);
}
// ---------- rail (desktop): every live session in fixed tmux order, one click to open it ----------
// Rebuilt only when something it shows changes (state, label, the open session, the minute), so hover never flickers.
let railKey = '';
function renderRail() {
  const el = $('#rail-list'); if (!el) return;
  const S3 = termSessions(); const act = TERM.open ? TERM.active : null; const min = Math.floor(Date.now() / 60000);
  const key = JSON.stringify([act, min, S.projects.length, S3.all.map(x => [x.name, x.pid, x.claude?.state, x.claude?.needsYou, x.claude?.label, x.claude?.title, x.claude?.firstPrompt, x.claude?.since, x.claude?.lastTool, x.claude?.model, x.claude?.worktree?.name, x.claude?.settled?.at, x.claude?.settled?.until, x.project, x.label, x.current, x.cwd, x.ports.map(p => p.port)])]);
  if (key === railKey) return; railKey = key;
  const sub = it => {
    const cl = it.claude; if (!cl) return it.label ? it.label + (it.ports.length ? ' · :' + it.ports.map(p => p.port).join(' :') : '') : (it.current || 'bash') + ' · ' + home(it.cwd);
    const st = cl.state || 'unknown';
    if (st === 'working') return cl.lastTool || 'working…';
    if (st === 'background') return 'background agents';
    return (STATE_SHORT[st] || st) + (cl.since && st !== 'unknown' ? ' · ' + ago(cl.since) : '');
  };
  const row = (it, kind, tuck) => {
    const cl = it.claude; const st = cl ? cl.state || 'unknown' : kind; const i = kind === 'claude' ? instOf(it) : null;
    const nm = kind === 'claude' ? (isNewChat(it.name) ? chatTitle(cl) : cl?.label || (tuck ? (i.wt ? it.project : '#' + (i.n || 1)) : it.name.startsWith('sh-') ? it.name : it.project)) : kind === 'dev' ? it.project : it.name;
    return h('button', { class: 'rrow k-' + kind + ' st-' + st + (tuck ? ' sub' : '') + (act === it.name ? ' on' : '') + (cl?.needsYou ? ' need' : '') + (cl?.settled ? ' settled' : ''), title: it.name + (cl ? ' · ' + (STATE_LABEL[st] || st) : '') + (cl?.settled ? ' · ' + (cl.settled.until ? 'snoozed' : 'settled') : ''), onclick: () => openTerm(it.name) },
      kind === 'claude' && !tuck ? h('span', { class: 'rav' }, avatar(it.pid, 'sm'), h('i', { class: 'rdot' })) : h('i', { class: 'rdot' }),
      h('span', { class: 'rtx' }, h('span', { class: 'rnm' }, h('b', null, nm), i && i.n && !(tuck && !cl?.label && !i.wt) ? h('em', null, '#' + i.n) : null, i && i.wt ? h('em', { class: 'wt' }, '⎇ ' + i.wt.name) : null),
        h('span', { class: 'rln2' }, h('span', { class: 'rsub' + (st === 'working' ? ' mono' : '') }, sub(it)), kind === 'claude' && multiAcct() ? h('span', { class: 'racc ' + it.account, title: 'Claude Code account: ' + acct(it.account) }, acct(it.account)) : null)),
      cl ? h('span', { class: 'redit', role: 'button', title: 'rename this session', onclick: ev => { ev.stopPropagation(); renameDialog(it.name); } }, ico('pencil', 13)) : null);
  };
  const out = [];
  for (const og of orgGroups(S3.claude)) {
    const rows = [];
    for (const g of claudeGroups(og.items)) {
      if (g.items.length === 1) { rows.push(row(g.items[0], 'claude')); continue; }
      rows.push(h('div', { class: 'rgrp-p' }, h('div', { class: 'rproj', title: g.items.length + ' Claude sessions on ' + g.project }, avatar(g.pid, 'sm'), h('b', null, g.project), h('em', null, '×' + g.items.length)), ...g.items.map(it => row(it, 'claude', true))));
    }
    if (og.items.length < 2 || !og.org) { out.push(...rows); continue; }
    out.push(h('div', { class: 'rgrp-o', style: `--org:${orgColor(og.org)}` }, h('div', { class: 'rorg' }, h('i', null), og.org, h('em', null, og.items.length)), ...rows));
  }
  if (S3.dev.length) out.push(h('div', { class: 'rsec' }, 'Dev servers'), ...S3.dev.map(it => row(it, 'dev')));
  if (S3.other.length) out.push(h('div', { class: 'rsec' }, 'Shells'), ...S3.other.map(it => row(it, 'other')));
  if (!out.length) out.push(h('div', { class: 'rempty' }, 'No sessions yet.'));
  el.replaceChildren(...out);
}

// ---------- events ----------
const LIVE = { base: null, seq: null, connected: false, lastMsg: 0, offlineSince: 0, retry: 0, timer: null };
const LIVE_BACKOFF = [1000, 2000, 5000, 10000];
const LIVE_SILENCE = 45000;
function renderLiveDot() {
  const md = $('#mdot'); document.body.classList.toggle('offline', !LIVE.connected && !!LIVE.offlineSince);
  if (!LIVE.connected && LIVE.offlineSince) { const t = 'offline since ' + new Date(LIVE.offlineSince).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); $('#hostline').textContent = t; $('#hostline').title = t + ' — showing the last known state, reconnecting'; if (md) { md.className = 'mdot off'; md.title = t; } return; }
  if (md) { md.className = 'mdot on'; md.title = 'connected · ' + (S.host?.hostname || ''); }
}
function liveUp() { LIVE.lastMsg = Date.now(); if (LIVE.connected) return; LIVE.connected = true; LIVE.retry = 0; LIVE.offlineSince = 0; if (LIVE.base) renderHeader(); else renderLiveDot(); }
function liveDown() { LIVE.connected = false; if (!LIVE.offlineSince) LIVE.offlineSince = Date.now(); renderLiveDot(); }
function retryLive() { if (LIVE.timer) return; const ms = LIVE_BACKOFF[Math.min(LIVE.retry++, LIVE_BACKOFF.length - 1)]; LIVE.timer = setTimeout(() => { LIVE.timer = null; reconnect(); }, ms); }
function applyState(d) { if (d.host && d.host.build) { if (!S.build) S.build = d.host.build; else if (S.build !== d.host.build) { S.build = d.host.build; newBuild(); } } Object.assign(S, { projects: d.projects, wip: d.wip || S.wip, runtime: d.runtime, settings: d.settings, host: d.host, claude: d.claude || S.claude, health: d.health || S.health || {}, crashes: d.crashes || [] }); render(); }
function applyOps(root, ops) {
  for (const [p, ...val] of ops) {
    if (p.includes('__proto__')) throw new Error('unsafe path');
    let o = root; for (let i = 0; i < p.length - 1; i++) o = o[p[i]];
    if (val.length) o[p[p.length - 1]] = val[0]; else delete o[p[p.length - 1]];
  }
}
function reconnect() { try { UI.es && UI.es.close(); } catch {} clearTimeout(LIVE.timer); LIVE.timer = null; LIVE.base = null; LIVE.seq = null; LIVE.lastMsg = Date.now(); connect(); }
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = liveUp;
  es.addEventListener('ping', liveUp);
  es.addEventListener('state', e => { liveUp(); const d = JSON.parse(e.data); LIVE.seq = d.seq; delete d.seq; LIVE.base = d; applyState(structuredClone(d)); firstState(); });
  es.addEventListener('patch', e => {
    liveUp(); const p = JSON.parse(e.data);
    if (!LIVE.base || p.from !== LIVE.seq) return reconnect();
    try { applyOps(LIVE.base, p.ops); } catch { return reconnect(); }
    LIVE.seq = p.to; applyState(structuredClone(LIVE.base));
  });
  es.addEventListener('history', e => { S.hist = JSON.parse(e.data); drawSparks(); });
  es.addEventListener('stats', e => { S.stats = JSON.parse(e.data); const H = S.hist; const push = (a, v) => { a.push(v); if (a.length > 180) a.shift(); }; push(H.cpu, S.stats.cpu.pct); push(H.mem, S.stats.mem.used / S.stats.mem.total * 100); push(H.gpu, S.stats.gpu?.util || 0); push(H.net, [S.stats.net.rxRate, S.stats.net.txRate]); renderRailFoot(); if (!UI.menuOpen && UI.view === 'home') renderStats(); });
  es.addEventListener('ding', e => { const d = JSON.parse(e.data); if (SOUND.on) ding(d.state); });
  es.onerror = () => { if (UI.es !== es) return; liveDown(); if (es.readyState === 2) retryLive(); };
  UI.es = es;
}
// Coming back to the foreground (phone unlock, tab switch): fetch the state right away instead of waiting for the
// next event, and rebuild the stream if the browser dropped it while we were away.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (!UI.es || UI.es.readyState !== 1 || Date.now() - hiddenAt > 30000 || Date.now() - LIVE.lastMsg > LIVE_SILENCE) reconnect();
});
setInterval(() => { if (!document.hidden && UI.es && Date.now() - LIVE.lastMsg > LIVE_SILENCE) { liveDown(); reconnect(); } }, 5000);
// short sound on the Mac when a session needs you (per-device setting; browsers only play after you interacted with the page)
const SOUND = { on: localStorage.getItem('bd.sound') === '1' };
function ding(state) {
  try { const ctx = ding.ctx || (ding.ctx = new (window.AudioContext || window.webkitAudioContext)()); const t = ctx.currentTime;
    const notes = state === 'permission' ? [660, 660] : state === 'error' || state === 'limit' ? [440, 330] : [523, 784];
    notes.forEach((f, i) => { const o = ctx.createOscillator(); const g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t + i * 0.16); g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.16 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.15); o.connect(g).connect(ctx.destination); o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.16); });
  } catch {}
}
$('#search').addEventListener('input', e => { UI.q = e.target.value.trim(); if (UI.q && UI.view !== 'projects') setView('projects', true); else renderMain(); });
for (const b of document.querySelectorAll('#nav .navb')) b.onclick = () => { if (TERM.open) closeTermPanel(); if (UI.drawer) closeDrawer(); setView(b.dataset.view); };
if ($('#btn-inbox')) $('#btn-inbox').onclick = () => FEAT.inbox?.open?.();
if ($('#btn-newterm')) $('#btn-newterm').onclick = () => newSessionModal();
if ($('#btn-downloads-m')) $('#btn-downloads-m').onclick = () => downloadsModal();
for (const b of document.querySelectorAll('#tabbar .tb')) b.onclick = () => {
  if (b.dataset.view) { if (UI.view === b.dataset.view) window.scrollTo({ top: 0, behavior: 'smooth' }); setView(b.dataset.view); return; }
  if (b.dataset.act === 'inbox') FEAT.inbox?.open?.();
  if (b.dataset.act === 'sessions') { if (!TERM.open) pushLayer('term'); TERM.open = true; TERM.showList = true; renderTermPanel(true); }
};
$('#btn-shell').onclick = () => { if (TERM.open) return closeTermPanel(); pushLayer('term'); TERM.open = true; if (!TERM.active) { const c = S.runtime.sessions.find(x => x.name.startsWith('claude-')) || S.runtime.sessions[0]; if (c) { ensureFrame(c.name); TERM.active = c.name; } } renderTermPanel(); };
$('#btn-settings').onclick = settingsModal;
// ---------- downloads (~/Downloads on the server) ----------
// Claude drops finished reports/files there. Same explorer as a project's Files tab (tree + preview), plus
// checkboxes: download one file, or several files / folders as one .zip; delete. Newest first.
const DLF = { open: new Set(JSON.parse(localStorage.getItem('bd.dlopen') || '[]')), sel: null, mode: 'content', editing: false, wide: false, picked: new Set() };
function downloadsModal() {
  const m = $('#modal'); m.classList.remove('hidden');
  const close = () => { m.classList.add('hidden'); document.removeEventListener('keydown', esc, true); };
  const esc = e => { if (e.key === 'Escape' && !m.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  const body = h('div', { class: 'db files-tab dlx-body' });
  const box = h('div', { class: 'box dlx' },
    h('div', { class: 'sh' }, h('h3', null, gl('⬇ Downloads')), h('span', { class: 'dim mono', style: 'font-size:12px' }, '~/Downloads on the server'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: close }, ico('x', 15))),
    body);
  m.replaceChildren(box); m.onclick = e => { if (e.target === m) close(); };
  tabFiles(body, { id: '_downloads', isGit: false, parent: null, rel: '' }, { st: DLF, key: 'bd.dlopen', select: true, noEdit: true, newest: true, rootLabel: '~/Downloads on the server' });
}
// "☾ Sleep": suspend the beast to RAM; the server sets an RTC alarm for the next Mon-Fri 07:00 first. While asleep the
// dashboard / terminals / Tailscale are gone (nothing on the network can wake it), so this asks first.
function sleepModal() {
  const m = $('#modal'); m.classList.remove('hidden');
  const close = () => { m.classList.add('hidden'); document.removeEventListener('keydown', esc, true); };
  const esc = e => { if (e.key === 'Escape' && !m.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  const at = S.host.nextWake ? new Date(S.host.nextWake) : null;
  const when = at ? at.toLocaleString([], { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const cl = S.runtime.sessions.filter(s => s.claude);
  const busy = cl.filter(s => s.claude.state === 'working' || s.claude.state === 'background' || s.claude.state === 'permission');
  const dev = S.runtime.sessions.filter(s => s.managed).length;
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    btn.disabled = true; btn.textContent = 'Setting the alarm…';
    try { const r = await api('suspend', { confirm: true }); toast('Sleeping in a few seconds — wakes ' + new Date(r.wakeAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }), 'ok'); close(); }
    catch (e) { btn.disabled = false; btn.replaceChildren(...gl('☾ Sleep now')); toast('Sleep failed: ' + e.message, 'err'); }
  } }, gl('☾ Sleep now'));
  m.replaceChildren(h('div', { class: 'box', style: 'width:min(460px,92vw)' },
    h('h3', null, gl('☾ Put the server to sleep?')),
    h('p', { style: 'margin:0 0 10px' }, 'It wakes itself on ', h('b', null, when), ' (Mon–Fri, 07:00). If you switch it on yourself before that, nothing else happens.'),
    h('p', { class: 'dim', style: 'margin:0 0 10px;font-size:13px' }, 'Until then the dashboard, terminals and Tailscale are unreachable — nothing on the network can wake it, not even from home.'),
    busy.length ? h('p', { style: 'margin:0 0 10px;color:var(--amber)' }, `⚠ ${busy.length} Claude agent${busy.length === 1 ? '' : 's'} ${busy.length === 1 ? 'is' : 'are'} still working (${busy.map(s => s.claude.label || s.name).slice(0, 3).join(', ')}) — sleep freezes ${busy.length === 1 ? 'it' : 'them'} until the morning.`) : null,
    dev ? h('p', { class: 'dim', style: 'margin:0 0 10px;font-size:13px' }, `${dev} dev server${dev === 1 ? '' : 's'} running here will pause too.`) : null,
    h('div', { class: 'foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Cancel'), btn)));
  m.onclick = e => { if (e.target === m) close(); };
}
if ($('#btn-downloads')) $('#btn-downloads').onclick = downloadsModal;   // guarded: a phone may still hold an older index.html
$('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', e => {
  const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'SELECT');
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); PAL.open ? closePalette() : openPalette(); return; }
  if (PAL.open) return;   // the palette handles its own keys
  if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'Escape') { if (!$('#modal').classList.contains('hidden')) $('#modal').classList.add('hidden'); else if (UI.menuOpen) closeMenu(); else if (UI.drawer) closeDrawer(); else if (TERM.open) closeTermPanel(); else if (UI.q) { $('#search').value = ''; UI.q = ''; renderMain(); } else if (UI.view === 'code' && FEAT.code?.back(true)) {} else if (UI.view === 'projects' || UI.view === 'tasks' || UI.view === 'code') setView('home'); } // drawer before term: the Changes drawer can sit on top of the terminal
  // dashboard-level shortcuts (not while typing): t = terminals, n = next session that needs you, s = new shell
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$('#modal').classList.contains('hidden')) return;
  if (e.key === 't') { e.preventDefault(); $('#btn-shell').click(); }
  if (e.key === 'd') { e.preventDefault(); downloadsModal(); }
  if (e.key === 'p') { e.preventDefault(); setView('projects'); }
  if (e.key === 'h') { e.preventDefault(); setView('home'); }
  if (e.key === 'n') { e.preventDefault(); const c = termSessions().claude.find(x => x.claude?.needsYou) || termSessions().claude[0]; if (c) openTerm(c.name); }
  if (e.key === 's' && !TERM.open) { e.preventDefault(); newSessionModal(); }
  if (TERM.open && $('#modal').classList.contains('hidden') && feat('termKey', e).includes(true)) { e.preventDefault(); return; }
  if (!TERM.open && $('#modal').classList.contains('hidden') && feat('key', e).includes(true)) { e.preventDefault(); return; }   // never replace an open modal (unsaved Settings …)   // feature shortcuts: i = inbox, a = android
  if (/^[1-9]$/.test(e.key) && TERM.open) { const o = termOrder(); if (o[+e.key - 1]) openTerm(o[+e.key - 1]); }
});
window.addEventListener('resize', drawSparks);

// ---------- command palette (Cmd/Ctrl+K): jump to any session or project, run the common actions ----------
const PAL = { open: false, q: '', idx: 0 };
function paletteItems() {
  const q = PAL.q.toLowerCase().trim(); const items = [];
  const S3 = termSessions();
  for (const it of S3.claude) items.push({ kind: 'claude', label: isNewChat(it.name) ? chatTitle(it.claude) : it.project + (it.name.match(/-wt-([^-]+)/) ? ' ⎇ ' + it.name.match(/-wt-([^-]+)/)[1] : '') + (it.name.match(/^claude-.*-(\d+)(-company)?$/) ? ' #' + it.name.match(/-(\d+)(-company)?$/)[1] : ''), sub: (it.claude ? (STATE_LABEL[it.claude.state] || '') + (it.claude.title ? ' · ' + it.claude.title : '') : '') || it.name, tag: it.account, icon: STATE_ICON[it.claude?.state] || '✦', cls: 'st-' + (it.claude?.state || 'unknown'), hay: [it.project, it.name, it.claude?.label, it.claude?.title, it.claude?.firstPrompt, it.claude?.lastPrompt, it.account].join(' '), run: () => openTerm(it.name), rank: 1 });
  for (const it of S3.dev) items.push({ kind: 'dev', label: it.project + ' · ' + it.label, sub: it.ports.map(p => ':' + p.port).join(' ') || it.name, icon: '▶', hay: [it.project, it.label, it.name].join(' '), run: () => openTerm(it.name), rank: 10 });
  for (const it of S3.other) items.push({ kind: 'other', label: it.name, sub: it.cwd, icon: '⌨', hay: it.name + ' ' + it.cwd, run: () => openTerm(it.name), rank: 11 });
  for (const p of S.projects.filter(p => !p.hidden)) items.push({ kind: 'project', label: p.name, sub: [p.org, p.group, p.framework].filter(Boolean).join(' · '), icon: '▤', hay: [p.name, p.rel, p.org, p.framework].join(' '), run: () => openDrawer(p.id, 'overview'), rank: 20, more: [{ l: '✦', t: `Claude (${acctL('personal')})`, f: () => startClaude(p, 'personal') }, { l: '✦c', t: `Claude (${acctL('company')})`, f: () => startClaude(p, 'company') }, { l: '±', t: 'changes', f: () => openDrawer(p.id, 'changes') }] });
  items.push({ kind: 'action', label: 'New chat', sub: 'type right away — the project is guessed', icon: '＋', hay: 'new chat session claude start', run: () => newSessionModal('new'), rank: 28 },
    { kind: 'action', label: 'Resume a conversation', sub: 'past conversations, with search', icon: '↺', hay: 'resume history past conversation old chat', run: () => newSessionModal('resume'), rank: 28 },
    { kind: 'action', label: 'New terminal', sub: 'pick project + account + resume, or plain shell', icon: '＋', hay: 'new terminal project claude session', run: newTerminalModal, rank: 29 },
    { kind: 'action', label: 'New shell', sub: 'bash in the dev folder (tmux sh-N)', icon: '$', hay: 'shell bash terminal new', run: newShell, rank: 30 },
    { kind: 'action', label: 'Terminals panel', sub: 'full-screen terminal view', icon: '⛶', hay: 'terminals panel', run: () => $('#btn-shell').click(), rank: 31 },
    { kind: 'action', label: 'Tunnels', sub: 'exposed ports', icon: '⇄', hay: 'tunnels ports expose socat', run: () => { UI.showTunnels = true; renderTunnels(); }, rank: 32 },
    { kind: 'action', label: 'Tasks', sub: `${(S.claude?.tasks || []).filter(t => t.status !== 'done').length} open`, icon: '☑', hay: 'tasks todo backlog', run: () => setView('tasks'), rank: 30 },
    { kind: 'action', label: 'New task', sub: 'write yourself a prompt-style task', icon: '＋', hay: 'new task add todo', run: () => taskModal(null), rank: 30 },
    { kind: 'action', label: 'Settings', sub: '', icon: '⚙', hay: 'settings config push notifications', run: settingsModal, rank: 33 },
    { kind: 'action', label: 'Rescan projects', sub: '', icon: '↻', hay: 'rescan projects', run: () => act('Rescan', api('rescan', {})), rank: 34 },
    { kind: 'action', label: 'Search conversations', sub: 'type ? followed by words — every session, both accounts', icon: '🔍', hay: 'search conversations transcripts find', run: () => setTimeout(() => openPalette('search'), 0), rank: 27 },
    ...(FEAT.newproj ? [{ kind: 'action', label: 'New project', sub: 'make a folder, git init, then start a chat in it', icon: '＋', hay: 'new project create folder repo init', run: () => FEAT.newproj.open(), rank: 29 }] : []),
    { kind: 'action', label: 'Projects', sub: 'all projects, filters, search  (p)', icon: '▤', hay: 'projects view page', run: () => setView('projects'), rank: 29 },
    { kind: 'action', label: 'Home', sub: 'stats · agents · running  (h)', icon: '⌂', hay: 'home dashboard', run: () => setView('home'), rank: 28 });
  items.push(...feat('paletteItems'));
  if (S.claude?.update) items.push({ kind: 'action', label: 'Update Claude Code', sub: `${S.claude.installed || '?'} → ${S.claude.update.version} (mise upgrade claude)`, icon: 'arrowUp', hay: 'update upgrade claude code version mise', run: () => updateClaude(null), rank: 0 });
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
    h('span', { class: 'ico' }, gico(it.icon)), h('span', { class: 'k' }, it.label, it.tag ? h('span', { class: 'badge tag acc ' + it.tag }, acct(it.tag)) : null), h('span', { class: 'c' + (it.kind === 'hit' ? ' wrap' : '') }, it.sub || '', it.extra ? h('span', { class: 'dim', style: 'display:block;font-size:11px' }, it.extra) : null),
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
  else if (sess && q.get('view') !== 'code') { history.replaceState(null, '', location.pathname); openSession(sess, q.get('tab') || 'transcript'); }
  else if (['chat', 'resume'].includes(q.get('new'))) { history.replaceState(null, '', location.pathname); newSessionModal(q.get('new') === 'chat' ? 'new' : 'resume', q.get('text') || '', { project: q.get('project') || null, account: q.get('account') || null }); }
  else if (['projects', 'home', 'tasks'].includes(q.get('view'))) { history.replaceState(null, '', location.pathname); setView(q.get('view')); }
  else if (q.get('newtask')) { history.replaceState(null, '', location.pathname); setView('tasks'); taskModal(null, q.get('newtask') === '1' ? null : q.get('newtask')); }
  else if (q.get('settings')) { history.replaceState(null, '', location.pathname); settingsModal(); }
  else if (q.get('downloads')) { history.replaceState(null, '', location.pathname); downloadsModal(); }
  else if (q.get('schedule')) { history.replaceState(null, '', location.pathname); scheduleDialog(q.get('schedule'), ''); }
  else if (q.get('drawer')) { history.replaceState(null, '', location.pathname); openDrawer(q.get('drawer'), q.get('tab') || 'overview'); }   // ?drawer=<project id>&tab=<key>
  else feat('deepLink', q);   // ?inbox=1, ?emu=1 …
  pushStatus();
  takePendingOpen();
}
// ---------- notification tap -> that conversation ----------
// Two paths, whichever lands first: the service worker's postMessage (app already open) and the target it parks in
// Cache Storage (iOS resumes / reloads the PWA after the message was sent). Registered at load, not after first state.
function openFromUrl(u) {
  let qq; try { qq = new URL(u, location.origin).searchParams; } catch { return; }
  const term = qq.get('term');
  if (term) {
    if (qq.get('mode') === 'chat') { TERM.mode = 'chat'; localStorage.setItem('bd.mode', 'chat'); }
    if (PAL.open) closePalette(false); if (UI.drawer) closeDrawer(); $('#modal')?.classList.add('hidden');
    if (!firstDone) { setTimeout(() => openFromUrl(u), 400); return; }   // first state not here yet (cold start)
    openTerm(term);
  } else if (qq.get('session')) openSession(qq.get('session'), 'transcript');
  else if (qq.get('view')) setView(qq.get('view'));
}
let takingOpen = false, lastOpenAt = 0;
async function takePendingOpen() {
  if (takingOpen) return; takingOpen = true;
  try {
    if (!window.caches) return; const c = await caches.open('bd-nav'); const r = await c.match('/__pending-open'); if (!r) return;
    const { url, at } = await r.json(); await c.delete('/__pending-open');
    if (Date.now() - at < 120000) navOnce(url);
  } catch {} finally { takingOpen = false; }
}
// the same tap can arrive three ways (message, broadcast, parked target): act on it once
function navOnce(u) { if (Date.now() - lastOpenAt < 3000) return; lastOpenAt = Date.now(); caches?.open('bd-nav').then(c => c.delete('/__pending-open')).catch(() => {}); openFromUrl(u); }
try { const bc = new BroadcastChannel('bd-nav'); bc.onmessage = ev => { if (ev.data && ev.data.open) navOnce(ev.data.open); }; } catch {}
if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', ev => { const u = ev.data && ev.data.open; if (u) navOnce(u); });
// iOS brings the app to the front *before* the service worker handles the tap, so the parked target appears a moment
// later: keep looking for a few seconds after every wake-up
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') return; for (const ms of [0, 250, 600, 1200, 2000, 3500, 5000]) setTimeout(takePendingOpen, ms); });
window.addEventListener('focus', () => { for (const ms of [0, 600, 2000]) setTimeout(takePendingOpen, ms); });
window.addEventListener('pageshow', () => takePendingOpen());
connect();
$('#btn-palette').onclick = () => openPalette();

// ---------- auto-update: reload into the new build once it's safe ----------
// The page carries its build (meta bd-ver, stamped by the server). Every minute and on every wake-up it asks for the
// current one; when they differ it reloads — but only when nothing is in progress: not recording, no text being
// typed, no modal / palette open. A pending reload is retried until that moment comes.
const MY_VER = document.querySelector('meta[name="bd-ver"]')?.content || null;
let newVer = null;
function safeToReload() {
  if (document.body.classList.contains('recording')) return false;
  const a = document.activeElement; if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') && a.value && a.value.trim()) return false;
  for (const t of document.querySelectorAll('textarea:not(.creply)')) if (t.value && t.value.trim()) return false;   // unsent text outside a chat (chat drafts are saved per chat and come back)
  if (!$('#modal')?.classList.contains('hidden')) return false;
  if (typeof PAL !== 'undefined' && PAL.open) return false;
  if (typeof FILES !== 'undefined' && FILES.editing) return false;
  for (const t of document.querySelectorAll('input.cmsg, input.qr-in')) if (t.value && t.value.trim()) return false;
  return true;
}
async function checkVersion() {
  if (!MY_VER) return;
  try { const r = await fetch('/api/version', { cache: 'no-store' }); const { v } = await r.json(); if (v && v !== MY_VER) newVer = v; } catch { return; }
  if (newVer) reloadPending = true;
  if (reloadPending) maybeReload();
}
setInterval(checkVersion, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(checkVersion, 1500); });
setTimeout(checkVersion, 5000);
try { if (sessionStorage.getItem('bd.updated')) { sessionStorage.removeItem('bd.updated'); setTimeout(() => toast('updated to the latest version', 'ok'), 1200); } } catch {}
