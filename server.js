'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run } = require('./lib/util');
const settings = require('./lib/settings');
const discovery = require('./lib/discovery');
const git = require('./lib/gitinfo');
const rt = require('./lib/runtime');
const sys = require('./lib/sys');
const expose = require('./lib/expose');
const actions = require('./lib/actions');
const claude = require('./lib/claude');
const files = require('./lib/files');
const transcript = require('./lib/transcript');
const health = require('./lib/health');
const search = require('./lib/search');
const schedule = require('./lib/schedule');
const usage = require('./lib/usage');
const limits = require('./lib/limits');
const tasks = require('./lib/tasks');
const UPLOAD_MAX = 100e6;   // /api/paste-image: any file up to this, into <devRoot>/.pasted
const pastedDir = () => path.join(settings.get().devRoot, '.pasted');
const push = require('./lib/push');

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

// ---- state ----
let projects = [];
let gitStatus = {};
let snapshot = { sessions: [], recent: [], external: [], containers: [], otherPorts: [], exposures: [], ports: [] };
let lastGit = 0, scanning = false, gitBusy = false;
const clients = new Set();
let lastStateJson = '';

function stateObj() {
  const s = settings.get();
  return { projects: projects.map(p => ({ ...p, git: gitStatus[p.id] || null })), runtime: { ...snapshot, manual: expose.manual() }, settings: s, host: { tsIp: TS_IP, tsName: expose.tailscaleName(), tailscale: TS_INFO, publicHost: s.publicHost || TS_IP || 'localhost', terminalPort: 7681, hostname: require('os').hostname(), devRoot: s.devRoot, user: process.env.USER || 'user', lastResume: LAST_RESUME, startedAt: STARTED_AT, pushSubs: push.subscriptions().length }, claude: { restorable: claude.restorable(), usage: usage.summary(), limits: limits.all(), installed: CLAUDE_VERSION, schedule: schedule.all(), tasks: tasks.all() }, health: health.all(), crashes: recentCrashes(), stats: sys.latest(), statsHistory: sys.history() };
}
let TS_IP = null, TS_INFO = null, LAST_RESUME = null, LAST_TICK = Date.now();
const STARTED_AT = Date.now();

function broadcast(event, data) { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(msg); }
function pushState(force) {
  const s = stateObj(); delete s.statsHistory; delete s.stats;
  const j = JSON.stringify(s);
  if (force || j !== lastStateJson) { lastStateJson = j; broadcast('state', s); }
}

async function rescan() {
  if (scanning) return; scanning = true;
  try { projects = await discovery.scan(); await refreshGit(true); watchGit(); } catch (e) { console.error('scan failed', e); } finally { scanning = false; }
}
async function refreshGit(force) {
  if (gitBusy) return; if (!force && Date.now() - lastGit < settings.get().gitRefreshSec * 1000) return;
  gitBusy = true; try { gitStatus = await git.statusAll(projects); lastGit = Date.now(); } finally { gitBusy = false; }
}
async function refreshGitOne(id) { const p = projects.find(x => x.id === id); if (p && p.isGit) gitStatus[id] = await git.status(p.path); }
// Watch each repo's .git directory (index = staging, HEAD/refs = commits, checkouts, pulls) so the branch, ahead/behind
// and dirty counts update the moment something happens, instead of on the next poll. Working-tree edits still come
// from the poll (watching whole trees would mean watching node_modules too).
const gitWatchers = new Map(); const gitDebounce = new Map();
function watchGit() {
  const want = new Set(projects.filter(p => p.isGit).map(p => p.id));
  for (const [id, w] of gitWatchers) if (!want.has(id)) { try { w.close(); } catch {} gitWatchers.delete(id); }
  for (const p of projects) {
    if (!p.isGit || gitWatchers.has(p.id)) continue;
    try {
      const w = fs.watch(path.join(p.path, '.git'), { recursive: true }, (ev, name) => {
        if (name && /\.lock$|^objects\/|^logs\//.test(name)) return;   // object writes and reflog noise; index/HEAD/refs are what matter
        clearTimeout(gitDebounce.get(p.id));
        gitDebounce.set(p.id, setTimeout(() => refreshGitOne(p.id).then(() => pushState(false)).catch(() => {}), 400));
      });
      w.on('error', () => { try { w.close(); } catch {} gitWatchers.delete(p.id); });
      gitWatchers.set(p.id, w);
    } catch (e) { /* recursive watch unsupported or repo gone: the poll still covers it */ }
  }
}

async function tick() {
  try {
    const now = Date.now();
    if (now - LAST_TICK > 45000) { LAST_RESUME = now; console.log(`resume detected (gap ${Math.round((now - LAST_TICK) / 1000)}s)`); }
    LAST_TICK = now;
    TS_IP = await expose.tailscaleIp(); TS_INFO = await expose.tailscaleInfo();
    snapshot = await rt.snapshot(projects);
    await expose.reconcile(snapshot, settings.get().autoExpose);
    if (snapshot.exposures.length) snapshot = { ...snapshot, exposures: (await rt.snapshot(projects)).exposures }; // refresh exposure list after reconcile
    await decorateClaude();
    await probeHealth();
    detectCrashes();
    await claudeVersion();
    weeklyDigest().catch(() => {}); backupState();
    pushState(false);
    autoRestore().catch(e => console.error('auto-restore', e));
    refreshGit(false).then(() => pushState(false));
  } catch (e) { console.error('tick failed', e); }
}
// Port health for every chip the UI shows (dev servers, external processes, running containers on the host).
async function probeHealth() {
  const ports = [];
  for (const s of snapshot.sessions) for (const p of s.ports) if (!p.ephemeral) ports.push({ port: p.port, addr: p.addr });
  for (const e of snapshot.external) for (const p of e.ports) if (!p.ephemeral) ports.push({ port: p.port, addr: p.addr });
  for (const c of snapshot.containers) if (c.state === 'running') for (const p of c.ports) if (p.host) ports.push({ port: p.host, addr: p.hostIp });
  try { await health.refresh(ports); } catch (e) { console.error('health', e); }
}
// A dev server started from the dashboard that exited non-zero in the last 15 minutes: banner + push (once).
const crashNotified = new Set();
function recentCrashes() { const now = Date.now(); return snapshot.recent.filter(r => r.endedAt && now - r.endedAt < 15 * 60e3 && r.exitCode != null && r.exitCode !== 0 && !dismissedCrash.has(r.name + r.endedAt)); }
const dismissedCrash = new Set();
function detectCrashes() {
  for (const r of recentCrashes()) {
    const key = r.name + r.endedAt; if (crashNotified.has(key)) continue; crashNotified.add(key);
    const p = proj(r.project); const title = `▶ ${p ? p.name : r.project} · ${r.name.split('__')[1] || r.name} exited ${r.exitCode}`;
    console.log('crash:', title);
    if (pushAllowed('crash')) push.notify({ title, body: oneLine(r.cmd || '', 80), url: '/', tag: 'crash-' + r.name }).catch(() => {});
  }
}

// Installed Claude Code version (the sessions report theirs from the transcript): a mismatch = "restart to update"
let CLAUDE_VERSION = null, versionAt = 0;
async function claudeVersion() {
  if (Date.now() - versionAt < 10 * 60e3) return; versionAt = Date.now();
  try { const link = fs.readlinkSync(path.join(process.env.HOME, '.local', 'bin', 'claude')); const m = link.match(/(\d+\.\d+\.\d+)$/); if (m) { CLAUDE_VERSION = m[1]; return; } } catch {}
  const r = await run('claude', ['--version'], { timeout: 8000 }); const m = r.stdout.match(/(\d+\.\d+\.\d+)/); if (m) CLAUDE_VERSION = m[1];
}
// Scheduled prompts: send when due and the session is not busy; push when a job finishes.
async function runSchedule() {
  // busy = what the hooks say right now (the store is live even when the tick is slow); exists = ask tmux directly
  const busy = name => { const st = claude.get(name)?.state; return st === 'working' || st === 'background' || st === 'permission'; };
  const exists = name => actions.sessionExists(name);
  const done = await schedule.run(busy, (name, text) => claude.send(name, text, true), exists);
  for (const j of done) { const ok = j.state === 'done'; if (pushAllowed('done', j.session)) push.notify({ title: `${j.session.replace(/^claude-/, '').replace(/-company$/, '')} · scheduled ${ok ? 'done' : 'failed'}`, body: oneLine(ok ? j.prompts[0] : (j.error || ''), 80), url: `/?term=${encodeURIComponent(j.session)}&mode=chat`, tag: 'sched-' + j.id }).catch(() => {}); }
  if (done.length) setTimeout(tick, 200);
}
// Weekly digest (Monday 09:00 local): sessions, cost per account, commits by you across all repos in the last 7 days.
let lastDigestDay = settings.get().lastDigestDay || '';
async function weeklyDigest() {
  const d = new Date(); if (d.getDay() !== 1 || d.getHours() < 9) return;
  const day = d.toISOString().slice(0, 10); if (lastDigestDay === day) return; lastDigestDay = day; settings.update({ lastDigestDay: day });
  if (!(settings.get().notify || {}).digest) return;
  const u = usage.summary(); let commits = 0, projectsTouched = 0;
  for (const p of projects.filter(x => x.isGit)) { const r = await run('git', ['-C', p.path, 'log', '--since=7 days ago', '--author=' + (process.env.USER || ''), '--oneline'], { timeout: 8000 }); const n = r.stdout.split('\n').filter(Boolean).length; if (n) { commits += n; projectsTouched++; } }
  const sessions = Object.values(claude.all()).filter(r => Date.now() - (r.lastEventAt || 0) < 7 * 86400e3).length;
  push.notify({ title: '📊 Beast weekly', body: `${sessions} Claude sessions · $${u.total.week.toFixed(0)} API-equiv (personal $${u.personal.week.toFixed(0)}, company $${u.company.week.toFixed(0)}) · ${commits} commits in ${projectsTouched} repos`, url: '/', tag: 'digest' }).catch(() => {});
}
// Nightly backup of the dashboard's own state (sessions, labels, push subscriptions, settings, schedule): state-backups/, keep 14.
let lastBackupDay = '';
function backupState() {
  const day = new Date().toISOString().slice(0, 10); if (lastBackupDay === day) return; lastBackupDay = day;
  const dir = path.join(__dirname, 'state-backups'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `state-${day}.tar.gz`); if (fs.existsSync(out)) return;
  run('tar', ['-czf', out, '-C', path.join(__dirname, 'state'), '--exclude=logs', '--exclude=usage-cache.json', '.'], { timeout: 60000 }).then(r => {
    if (!r.ok) return console.error('backup failed', r.stderr);
    const files = fs.readdirSync(dir).filter(f => f.startsWith('state-')).sort(); while (files.length > 14) { try { fs.unlinkSync(path.join(dir, files.shift())); } catch {} }
  });
}
// Auto-restore after a reboot: the first tick after start sees the remembered sessions with no tmux behind them.
let autoRestored = false;
async function autoRestore() {
  if (autoRestored) return; autoRestored = true;
  if (!settings.get().autoRestore) return;
  const list = claude.restorable().filter(r => r.gone && Date.now() - r.gone < 7 * 86400e3); if (!list.length) return;
  console.log('auto-restore:', list.map(r => r.tmux).join(', '));
  for (const r of list) { const rec = claude.get(r.tmux); const res = await actions.restoreClaude(rec); console.log('  ', r.tmux, res.ok ? 'ok' : res.error); }
  setTimeout(tick, 1500); setTimeout(tick, 4000);
}

// Claude sessions: peek at every claude-* pane, merge with hook state, keep the restore list current, scan usage.
let lastUsageScan = 0;
async function decorateClaude() {
  const names = snapshot.sessions.map(s => s.name);
  // a Claude session is anything named claude-* (dashboard / `cs` helper) or whose foreground process is `claude` (started by hand)
  const isClaude = s => s.name.startsWith('claude-') || s.current === 'claude' || !!claude.get(s.name);
  const cl = snapshot.sessions.filter(isClaude).map(s => s.name);
  await claude.refreshPeeks(cl);
  claude.reconcile(names);
  claude.refreshTitles();
  for (const s of snapshot.sessions) if (isClaude(s)) { s.claude = claude.info(s.name, s.activity); s.claude.usage = usage.bySession(s.claude.sessionId); Object.assign(s.claude, await whereIs(s)); if (s.claudeVersion) s.claude.version = s.claudeVersion; }
  if (Date.now() - lastUsageScan > 30000) { lastUsageScan = Date.now(); usage.scan().then(() => pushState(false)); }
}
// Where a Claude session actually works: its branch, and whether that is a git worktree apart from the project
// checkout (claude --worktree <name>, or a manual `git worktree add`). Branch lookups are cached per directory.
const whereCache = new Map();   // dir -> { branch, at }
async function whereIs(s) {
  const dir = s.claude.cwd || s.cwd; if (!dir) return {};
  const pr = projects.find(p => p.id === s.project);
  let c = whereCache.get(dir);
  if (!c || Date.now() - c.at > 20000) {
    const [b, t] = await Promise.all([run('git', ['-C', dir, 'branch', '--show-current'], { timeout: 3000 }), run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 3000 })]);
    c = { branch: b.ok ? (b.stdout.trim() || null) : null, top: t.ok ? t.stdout.trim() : null, at: Date.now() }; whereCache.set(dir, c);
  }
  // a worktree = the session's git toplevel is not the project's checkout (claude --worktree lives in <repo>/.claude/worktrees/<name>)
  const wt = !!(pr && c.top && path.resolve(c.top) !== path.resolve(pr.path));
  return { branch: c.branch, worktree: wt ? { path: c.top, name: path.basename(c.top) } : null };
}
// first sentence-ish of a reply, markdown stripped, clipped
function oneLine(t, n = 80) {
  t = String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]+/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,}?[.!?])\s/); if (m && m[1].length <= n) t = m[1];
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
// State transitions worth a phone buzz: Claude finished / needs permission / hit an error. At most one per session per 30 s.
const lastPush = new Map();
// Should this event buzz? Respects the per-event toggles, quiet hours and muted sessions from settings.
function pushAllowed(kind, tmux) {
  const n = settings.get().notify || {}; if (n[kind] === false) return false;
  if (tmux && (settings.get().muted || []).includes(tmux)) return false;
  if (n.quietFrom && n.quietTo) { const d = new Date(); const cur = d.getHours() * 60 + d.getMinutes(); const [f, t] = [n.quietFrom, n.quietTo].map(x => { const [hh, mm] = x.split(':').map(Number); return hh * 60 + (mm || 0); });
    const quiet = f <= t ? (cur >= f && cur < t) : (cur >= f || cur < t); if (quiet) return false; }
  return true;
}
claude.onChange((ev, r, prev) => {
  if (r.state === 'limit') limits.refresh().then(() => pushState(false));   // the plan numbers just changed: show the fresh reset time right away
  if (!['needs-you', 'permission', 'error', 'limit'].includes(r.state)) return;
  if (r.state === 'needs-you' && prev.state !== 'working' && prev.state !== 'background') return;
  const kind = r.state === 'needs-you' ? 'done' : r.state;
  const now = Date.now(); if (now - (lastPush.get(r.tmux) || 0) < 30000) return; lastPush.set(r.tmux, now);
  // One glance: "<project> · done" and ONE short line saying what the task was. No markdown dumps.
  // Quick turns (under 20 s) don't buzz the phone — the ding in the open dashboard is enough for those.
  const proj = r.label || r.tmux.replace(/^claude-/, '').replace(/-company$/, '').replace(/-\d+$/, '').replace(/-wt-.*$/, '');
  const both = Object.values(claude.all()).some(x => !x.gone && x.tmux !== r.tmux && x.account !== r.account && x.tmux.replace(/^claude-/, '').replace(/-company$/, '').replace(/-\d+$/, '').replace(/-wt-.*$/, '') === proj);
  const who = proj + (both && r.account ? ` (${r.account})` : '');
  const turn = r.promptAt && r.stopAt ? r.stopAt - r.promptAt : null;
  const title = r.state === 'permission' ? `${who} · needs permission` : r.state === 'error' ? `${who} · error` : r.state === 'limit' ? `${who} · usage limit` : `${who} · done`;
  const body = r.state === 'permission' ? oneLine(r.lastTool || 'wants to run a tool', 80)
    : r.state === 'limit' ? oneLine((r.lastMessage || '').replace(/^.*?(resets?[^.]*).*$/i, '$1') || `${r.account || ''} account`, 80)
    : r.state === 'error' ? oneLine(r.lastMessage || 'API error', 80)
    : oneLine(r.title || r.lastPrompt || r.lastMessage || 'finished', 80);
  const skipQuick = r.state === 'needs-you' && turn != null && turn < 20000;
  if (!skipQuick && pushAllowed(kind, r.tmux)) push.notify({ title, body, url: `/?term=${encodeURIComponent(r.tmux)}&mode=chat`, tag: r.tmux }).then(res => { if (res.sent) console.log(`push: ${title} -> ${res.sent}`); });
  broadcast('ding', { tmux: r.tmux, state: r.state, title });
  setTimeout(tick, 150);
});

async function statsTick() { try { const s = await sys.sample(); broadcast('stats', s); } catch (e) { console.error('stats failed', e); } }

// ---- pace: full speed only while someone is watching ----
/*
 One `tick` walks the whole process table (a few hundred pids, ~30 ms synchronous, blocks the
 event loop) plus one `ss` spawn — no reason to do that 20 times a minute all night for nobody.

 The server already knows who is listening: the SSE clients in `clients`. With none connected the
 pace drops to 30 s.

 Why 30 s and not a minute: `tick` treats a gap larger than 45 s as the machine waking from
 suspend. A slower idle pace would trigger that every cycle.

 `statsTick` is not stopped entirely but slowed to 30 s: it is cheap (three files from /proc),
 and the chart history would otherwise have a hole exactly over the night — you could not tell
 whether the server was doing anything while you were away.
*/
const PACE = { live: { tick: 3000, stats: 2000 }, idle: { tick: 30000, stats: 30000 } };
let tickTimer = null, statsTimer = null, wasWatched = null;

function setPace() {
  const watched = clients.size > 0;
  if (wasWatched === watched) return;
  wasWatched = watched;
  const t = watched ? PACE.live : PACE.idle;
  clearInterval(tickTimer); clearInterval(statsTimer);
  tickTimer = setInterval(tick, t.tick);
  statsTimer = setInterval(statsTick, t.stats);
  console.log(`pace: ${watched ? 'live' : 'idle'} (tick ${t.tick}ms, stats ${t.stats}ms, clients ${clients.size})`);
  // The first viewer must not wait for the interval.
  if (watched) { tick(); statsTick(); }
}

// ---- http ----
// The only access control there is: the request must come from this machine or from the tailnet.
// There is no login — whoever reaches this port can run commands and open shells. `allowedPrefixes` in
// settings.json adds other private ranges (a WireGuard net, a LAN) as plain string prefixes, e.g. ["10.8.0."].
function allowed(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true; // tailscale CGNAT 100.64.0.0/10
  if (ip.startsWith('fd7a:115c:a1e0:')) return true;
  for (const p of settings.get().allowedPrefixes || []) if (p && ip.startsWith(p)) return true;
  return false;
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req, max = 1e6) { return new Promise((resolve, reject) => { let d = ''; req.on('data', c => { d += c; if (d.length > max) req.destroy(); }); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } }); }); }
function sse(res) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' }); res.write(': hi\n\n'); }
const proj = id => projects.find(p => p.id === id);
const shqPrompt = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after 'api'
  const m = req.method;
  if (m === 'GET' && parts[0] === 'state') return json(res, 200, stateObj());
  if (m === 'GET' && parts[0] === 'events') {
    sse(res); clients.add(res); setPace();
    res.write(`event: state\ndata: ${JSON.stringify((() => { const s = stateObj(); delete s.statsHistory; delete s.stats; return s; })())}\n\n`);
    res.write(`event: history\ndata: ${JSON.stringify(sys.history())}\n\n`);
    if (sys.latest()) res.write(`event: stats\ndata: ${JSON.stringify(sys.latest())}\n\n`);
    const ka = setInterval(() => res.write(': ka\n\n'), 20000);
    req.on('close', () => { clients.delete(res); clearInterval(ka); setPace(); });
    return;
  }
  if (m === 'GET' && parts[0] === 'logs' && parts[1]) {
    const name = decodeURIComponent(parts[1]);
    if (parts[2] === 'stream') {
      sse(res);
      const f = actions.logFile(name);
      let pos = 0; const init = actions.readLog(name, 300 * 1024); pos = init.size; res.write(`event: log\ndata: ${JSON.stringify(init.text)}\n\n`);
      const timer = setInterval(() => {
        try { const st = fs.statSync(f); if (st.size < pos) pos = 0; if (st.size > pos) { const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(Math.min(st.size - pos, 512 * 1024)); fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); pos += buf.length; res.write(`event: log\ndata: ${JSON.stringify(buf.toString('utf8'))}\n\n`); } } catch {}
      }, 400);
      req.on('close', () => clearInterval(timer));
      return;
    }
    return json(res, 200, actions.readLog(name));
  }
  // logs of a process started outside the dashboard: journal of its systemd unit, the tmux pane it prints to, or the file it writes
  if (m === 'GET' && parts[0] === 'extlogs' && parts[1]) {
    const e = snapshot.external.find(x => String(x.pid) === parts[1]); if (!e) return json(res, 404, { error: 'process gone' });
    sse(res);
    const send = d => res.write(`event: log\ndata: ${JSON.stringify(d.toString('utf8'))}\n\n`);
    if (e.unit) {
      const child = spawn('journalctl', ['--user', '-u', e.unit, '-n', '400', '-f', '-o', 'cat', '--no-pager']);
      child.stdout.on('data', send); child.stderr.on('data', send); child.on('close', () => { try { res.write('event: end\ndata: {}\n\n'); } catch {} }); req.on('close', () => child.kill()); return;
    }
    if (e.tty) {
      const pane = (await run('tmux', ['list-panes', '-a', '-F', '#{pane_tty}\t#{session_name}:#{window_index}.#{pane_index}'])).stdout.split('\n').find(l => l.startsWith(e.tty + '\t'));
      if (!pane) { send(`(prints to ${e.tty}, not a tmux pane — nothing to follow)\n`); res.write('event: end\ndata: {}\n\n'); return; }
      const target = pane.split('\t')[1]; let last = '';
      const grab = async () => { const r = await run('tmux', ['capture-pane', '-p', '-J', '-t', target, '-S', '-400']); const txt = r.stdout.replace(/\s+$/, '') + '\n'; if (txt !== last) { if (last && txt.startsWith(last.slice(0, -1))) send(txt.slice(last.length - 1)); else send((last ? '\x1b[2m--- pane redrawn ---\x1b[0m\n' : '') + txt); last = txt; } };
      await grab(); const timer = setInterval(grab, 1000); req.on('close', () => clearInterval(timer)); return;
    }
    if (e.outFile) {
      let pos = 0; try { const st = fs.statSync(e.outFile); pos = Math.max(0, st.size - 300 * 1024); } catch {}
      const pump = () => { try { const st = fs.statSync(e.outFile); if (st.size < pos) pos = 0; if (st.size > pos) { const fd = fs.openSync(e.outFile, 'r'); const buf = Buffer.alloc(Math.min(st.size - pos, 512 * 1024)); fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); pos += buf.length; send(buf); } } catch {} };
      pump(); const timer = setInterval(pump, 500); req.on('close', () => clearInterval(timer)); return;
    }
    send('(this process writes to a socket/pipe the dashboard cannot read — start it from the dashboard or as a systemd unit to get logs here)\n'); res.write('event: end\ndata: {}\n\n'); return;
  }
  if (m === 'GET' && parts[0] === 'docker' && parts[1] === 'logs' && parts[2]) {
    sse(res);
    const child = spawn('docker', ['logs', '-f', '--tail', '300', parts[2]]);
    const send = d => res.write(`event: log\ndata: ${JSON.stringify(d.toString('utf8'))}\n\n`);
    child.stdout.on('data', send); child.stderr.on('data', send);
    child.on('close', () => { try { res.write('event: end\ndata: {}\n\n'); } catch {} });
    req.on('close', () => child.kill());
    return;
  }
  if (m === 'GET' && parts[0] === 'git' && parts[1] && parts[2] === 'branches') {
    const p = proj(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    return json(res, 200, await git.branches(p.path));
  }
  if (m === 'GET' && parts[0] === 'git' && parts[1] && parts[2] === 'changes') {
    const p = proj(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    return json(res, 200, await git.changes(p.path));
  }
  if (m === 'GET' && parts[0] === 'git' && parts[1] && parts[2] === 'diff') {
    const p = proj(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    const file = url.searchParams.get('file') || ''; const kind = url.searchParams.get('kind') || 'unstaged';
    if (!file || file.includes('..') || path.isAbsolute(file)) return json(res, 400, { error: 'bad path' });
    return json(res, 200, await git.fileDiff(p.path, file, kind));
  }
  if (m === 'GET' && parts[0] === 'git' && parts[1] && parts[2] === 'commit' && parts[3]) { // one commit: message + files
    const p = proj(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    const file = url.searchParams.get('file');
    return json(res, 200, file ? await git.commitFileDiff(p.path, parts[3], file) : await git.commit(p.path, parts[3]));
  }
  if (m === 'GET' && parts[0] === 'git' && parts[1] && parts[2] === 'headdiff') { // working tree vs HEAD for one file
    const p = proj(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    const file = url.searchParams.get('file') || ''; if (!file || file.includes('..') || path.isAbsolute(file)) return json(res, 400, { error: 'bad path' });
    return json(res, 200, await git.headDiff(p.path, file, url.searchParams.get('untracked') === '1'));
  }
  if (m === 'GET' && parts[0] === 'tree' && parts[1]) { // Files tab: one directory level, with git change marks
    const p = proj(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    const gitRoot = p.isGit ? p : (p.parent && proj(p.parent)) || null;
    let changed = {};
    if (gitRoot) { const all = await git.changedPaths(gitRoot.path); const sub = path.relative(gitRoot.path, p.path); const pre = sub ? sub + '/' : ''; for (const [k, v] of Object.entries(all)) if (k.startsWith(pre)) changed[k.slice(pre.length)] = v; }
    const r = files.list(p.path, url.searchParams.get('path') || '', changed); r.git = !!gitRoot; r.sub = gitRoot ? path.relative(gitRoot.path, p.path) : '';
    return json(res, r.error ? 400 : 200, r);
  }
  if (m === 'GET' && parts[0] === 'read' && parts[1]) { // file content for the preview / editor
    const p = proj(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    const r = files.read(p.path, url.searchParams.get('path') || ''); return json(res, r.error ? 400 : 200, r);
  }
  if (m === 'GET' && parts[0] === 'download' && parts[1]) { // raw file, as attachment
    const p = proj(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    return files.stream(p.path, url.searchParams.get('path') || '', res);
  }
  if (m === 'GET' && parts[0] === 'file' && !parts[1] && url.searchParams.get('p')) { // an uploaded attachment (only from <devRoot>/.pasted)
    const base = pastedDir(); const fp = path.resolve(url.searchParams.get('p'));
    if (!fp.startsWith(base + path.sep) || !fs.existsSync(fp)) return json(res, 404, { error: 'missing' });
    const ext = path.extname(fp).toLowerCase(); const type = MIME[ext] || ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' })[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600' }); return fs.createReadStream(fp).pipe(res);
  }
  if (m === 'GET' && parts[0] === 'file' && parts[1]) { // README / CLAUDE.md preview
    const p = proj(parts[1]); const f = decodeURIComponent(parts[2] || 'README.md');
    if (!p || !/^[\w.-]+$/.test(f)) return json(res, 400, { error: 'bad' });
    try { return json(res, 200, { text: fs.readFileSync(path.join(p.path, f), 'utf8').slice(0, 200000) }); } catch { return json(res, 404, { error: 'missing' }); }
  }
  if (parts[0] === 'hook') { // Claude Code hook events (bin/claude-hook.sh); payload may carry a big tool_input
    if (m !== 'POST') return json(res, 405, { error: 'POST only' });
    const b = await body(req, 8e6); const r = claude.onHook(req.headers, b);
    if (r.ok && !r.ignored) setTimeout(tick, 200);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (m === 'GET' && parts[0] === 'push' && parts[1] === 'key') return json(res, 200, { key: push.publicKey(), subs: push.subscriptions().length });
  if (m === 'GET' && parts[0] === 'usage') return json(res, 200, usage.summary());
  if (m === 'GET' && parts[0] === 'claude' && parts[1] === 'sessions') return json(res, 200, claude.all());
  if (m === 'GET' && parts[0] === 'transcript' && parts[1]) { // last N turns of a Claude session, by tmux name
    const r = claude.get(decodeURIComponent(parts[1])); if (!r || !r.transcriptPath) return json(res, 404, { error: 'no transcript known for this session yet (it appears after its first hook event)' });
    return json(res, 200, { ...transcript.tail(r.transcriptPath, Math.min(200, +url.searchParams.get('n') || 40)), touched: r.touched || [], cwd: r.cwd, sessionId: r.sessionId });
  }
  if (m === 'GET' && parts[0] === 'transcript') { // any past conversation by transcript file (from search)
    const file = url.searchParams.get('file') || ''; if (!search.isTranscript(file)) return json(res, 400, { error: 'not a transcript' });
    return json(res, 200, { ...transcript.tail(file, Math.min(200, +url.searchParams.get('n') || 40)), touched: [], file });
  }
  if (m === 'GET' && parts[0] === 'backup') { // latest state backup as a download
    const dir = path.join(__dirname, 'state-backups'); let files = []; try { files = fs.readdirSync(dir).filter(f => f.startsWith('state-')).sort(); } catch {}
    if (!files.length) return json(res, 404, { error: 'no backup yet (made nightly)' });
    const f = path.join(dir, files[files.length - 1]); const st = fs.statSync(f);
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': st.size, 'content-disposition': `attachment; filename="beast-dash-${files[files.length - 1]}"` }); return fs.createReadStream(f).pipe(res);
  }
  if (m === 'GET' && parts[0] === 'search') return json(res, 200, await search.search(url.searchParams.get('q') || ''));
  if (m === 'GET' && parts[0] === 'badge') { // tiny summary for the Mac menubar (xbar / SwiftBar plugin in mac/)
    const cl = snapshot.sessions.filter(x => x.claude); const need = cl.filter(x => x.claude.needsYou); const u = usage.summary();
    return json(res, 200, { need: need.length, working: cl.filter(x => x.claude.state === 'working' || x.claude.state === 'background').length, sessions: cl.length, today: u.total.today, needList: need.map(x => ({ name: x.name, label: x.claude.label, state: x.claude.state, msg: (x.claude.lastMessage || '').slice(0, 100) })), crashes: recentCrashes().length });
  }
  if (parts[0] === 'paste-image') {
    // Upload from the web terminal: the page on :7681 is another origin, hence CORS + preflight.
    // Saved under <devRoot>/.pasted; the returned path is what the terminal layer types into the prompt.
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (m === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (m !== 'POST') return json(res, 405, { error: 'POST only' });
    // Any file type. `name=` keeps the original file name (csv, json, log, zip … — Claude sees what it is); a bare
    // clipboard image (no name) gets paste-<timestamp>.<ext>. Up to UPLOAD_MAX; older than 7 days is swept.
    const base = pastedDir();
    const dir = url.searchParams.get('keep') ? path.join(base, 'keep') : base;   // keep/: task attachments, never swept
    fs.mkdirSync(dir, { recursive: true });
    try { for (const f of fs.readdirSync(base)) { const old = path.join(base, f); if (fs.statSync(old).isFile() && Date.now() - fs.statSync(old).mtimeMs > 7 * 86400e3) fs.unlinkSync(old); } } catch {}
    const extRaw = (url.searchParams.get('ext') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'png';
    let name = path.basename(url.searchParams.get('name') || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 120);
    if (!name || name.startsWith('.')) name = `paste-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Math.random().toString(36).slice(2, 6)}.${extRaw}`;
    else if (fs.existsSync(path.join(dir, name))) { const e = path.extname(name); const b = name.slice(0, name.length - e.length); let n = 2; while (fs.existsSync(path.join(dir, `${b}-${n}${e}`))) n++; name = `${b}-${n}${e}`; }
    const fp = path.join(dir, name);
    const declared = +req.headers['content-length'] || 0;
    if (declared > UPLOAD_MAX) { res.writeHead(413, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: `too big — max ${Math.round(UPLOAD_MAX / 1e6)} MB` })); }
    const ws = fs.createWriteStream(fp);
    let size = 0;
    req.on('data', c => { size += c.length; if (size > UPLOAD_MAX) { req.destroy(); ws.destroy(); try { fs.unlinkSync(fp); } catch {} } });
    req.on('error', () => { try { ws.destroy(); fs.unlinkSync(fp); } catch {} });
    req.pipe(ws);
    ws.on('finish', () => { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: fp, size })); });
    ws.on('error', () => { try { json(res, 500, { error: 'write failed' }); } catch {} });
    return;
  }
  if (m !== 'POST') return json(res, 404, { error: 'not found' });
  const b = await body(req, parts[0] === 'savefile' ? 8e6 : 1e6);
  switch (parts[0]) {
    case 'run': {
      const p = proj(b.id); if (!p) return json(res, 404, { error: 'no project' });
      const cmd = b.cmd || p.commands.find(c => c.name === b.name)?.cmd; if (!cmd) return json(res, 400, { error: 'no command' });
      const r = await actions.start(p, b.name || 'run', cmd); setTimeout(tick, 800); return json(res, r.ok ? 200 : 409, r);
    }
    case 'stop': { const r = await actions.stop(b.session, !!b.force); if (String(b.session).startsWith('claude-')) claude.forget(b.session); setTimeout(tick, 300); return json(res, 200, r); }
    case 'shell': { const r = await actions.shellSession(); setTimeout(tick, 600); return json(res, r.ok ? 200 : 500, r); } // persistent bash in tmux (sh-N)
    case 'claude': { // start (or reuse) a persistent Claude Code tmux session for a project: personal | company account
      const p = proj(b.id); if (!p) return json(res, 404, { error: 'no project' });
      const account = b.account === 'company' ? 'company' : 'personal';
      const r = await actions.claudeSession(p, account, { resume: b.resume === true ? true : (b.resume || false), fresh: !!b.fresh, worktree: b.worktree || null }); setTimeout(tick, 800); setTimeout(tick, 2500); return json(res, r.ok ? 200 : 500, r);
    }
    case 'claude-restore': { // relaunch sessions whose tmux session vanished (reboot): all of them, or one by tmux name
      const list = claude.restorable().filter(r => !b.tmux || r.tmux === b.tmux); const out = [];
      for (const r of list) { const rec = claude.get(r.tmux); out.push({ tmux: r.tmux, ...(await actions.restoreClaude(rec)) }); }
      setTimeout(tick, 1000); setTimeout(tick, 3000); return json(res, 200, { ok: true, restored: out });
    }
    case 'claude-forget': { if (typeof b.tmux !== 'string') return json(res, 400, { error: 'tmux?' }); const r = claude.forget(b.tmux); setTimeout(tick, 100); return json(res, 200, r); }
    case 'claude-resume': { // start a session from a past conversation (search result): same dir, same account, --resume <id>
      const { sessionId, cwd, account } = b; if (!/^[0-9a-f-]{36}$/.test(sessionId || '') || !cwd || !fs.existsSync(cwd)) return json(res, 400, { error: 'bad session / folder gone' });
      const base = path.basename(cwd).replace(/[^A-Za-z0-9_.-]+/g, '-'); const acc = account === 'company' ? 'company' : 'personal'; const suffix = acc === 'company' ? '-company' : '';
      let name = `claude-${base}${suffix}`; let n = 2; while (await actions.sessionExists(name)) name = `claude-${base}-${n++}${suffix}`;
      const r = await actions.restoreClaude({ tmux: name, cwd, account: acc, sessionId }); setTimeout(tick, 1000); setTimeout(tick, 3000); return json(res, r.ok ? 200 : 500, r);
    }
    case 'claude-restart': { // exit + relaunch with --resume in the same tmux (picks up an installed Claude Code update)
      const r = await actions.restartClaude(String(b.session || ''), claude.get(String(b.session || ''))); setTimeout(tick, 1500); setTimeout(tick, 5000); return json(res, r.ok ? 200 : 500, r);
    }
    case 'claude-mute': { const name = String(b.session || ''); const set = new Set(settings.get().muted || []); if (b.muted) set.add(name); else set.delete(name); settings.update({ muted: [...set] }); pushState(true); return json(res, 200, { ok: true, muted: [...set] }); }
    case 'unit': { const u = String(b.unit || ''); if (!/^[A-Za-z0-9@._-]+\.service$/.test(u) || !['restart', 'stop', 'start'].includes(b.action)) return json(res, 400, { error: 'bad unit/action' }); const r = await run('systemctl', ['--user', b.action, u], { timeout: 20000 }); setTimeout(tick, 1500); return json(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.stderr.trim() || 'failed' }); }
    case 'task': { const r = tasks.add(b); pushState(true); return json(res, r.ok ? 200 : 400, r); }
    case 'task-update': { const r = tasks.update(String(b.id || ''), b); pushState(true); return json(res, r.ok ? 200 : 400, r); }
    case 'task-remove': { const r = tasks.remove(String(b.id || '')); pushState(true); return json(res, 200, r); }
    case 'task-run': {
      // hand the task to a Claude session on its project: reuse a running one, else start one; the prompt goes out
      // through the scheduler so it waits until the session is idle (a freshly started Claude needs a few seconds)
      const t = tasks.all().find(x => x.id === String(b.id || '')); if (!t) return json(res, 404, { error: 'no such task' });
      const p = t.project ? proj(t.project) : null; if (!p) return json(res, 400, { error: 'task has no project — pick one first' });
      const account = b.account === 'company' ? 'company' : 'personal';
      let name = b.session && snapshot.sessions.find(s => s.name === b.session) ? b.session : null;
      if (!name) { const cands = snapshot.sessions.filter(s => s.claude && s.project === p.id && (s.claude.account || (s.name.endsWith('-company') ? 'company' : 'personal')) === account); name = cands[0]?.name || null; }
      if (!name) { const r = await actions.claudeSession(p, account, {}); if (!r.ok) return json(res, 500, r); name = r.name; setTimeout(tick, 800); setTimeout(tick, 2500); }
      const at = Date.now() + (snapshot.sessions.some(s => s.name === name) ? 0 : 8000);
      const r = schedule.add(name, at, [tasks.prompt(t, p.name)]); if (!r.ok) return json(res, 500, r);
      tasks.noteRun(t.id, name); pushState(true); return json(res, 200, { ok: true, session: name, job: r.job.id });
    }
    case 'schedule': { const r = schedule.add(b.session, +b.at, b.prompts || b.prompt); pushState(true); return json(res, r.ok ? 200 : 400, r); }
    case 'schedule-remove': { const r = schedule.remove(String(b.id || '')); pushState(true); return json(res, 200, r); }
    case 'handoff': { // usage limit on one account: start the other account in the same folder with a summary of where this one stopped
      const from = claude.get(String(b.session || '')); if (!from || !from.cwd) return json(res, 404, { error: 'unknown session' });
      const to = from.account === 'company' ? 'personal' : 'company';
      const t = from.transcriptPath ? transcript.tail(from.transcriptPath, 12) : { turns: [] };
      const users = t.turns.filter(x => x.role === 'user').slice(-4).map(x => '- ' + x.text.replace(/\s+/g, ' ').slice(0, 300));
      const last = [...t.turns].reverse().find(x => x.role === 'assistant' && x.text); const files = (from.touched || []).slice(0, 15).map(x => '- ' + x.path);
      const prompt = [`Handoff from another Claude Code session in this same folder (it hit its usage limit). Continue its work.`, ``, `What I asked it recently:`, ...users, ``, last ? `Its last reply (may be incomplete):\n${last.text.slice(0, 1500)}` : '', files.length ? `\nFiles it edited in that session:\n${files.join('\n')}` : '', ``, `Start by running git status and git diff --stat here to see the uncommitted state, then continue from where it stopped. Ask me if the goal is unclear.`].filter(x => x !== null).join('\n');
      const base = path.basename(from.cwd).replace(/[^A-Za-z0-9_.-]+/g, '-'); const suffix = to === 'company' ? '-company' : '';
      let name = `claude-${base}${suffix}`; let n = 2; while (await actions.sessionExists(name)) name = `claude-${base}-${n++}${suffix}`;
      const r = await actions.launchClaude(name, from.cwd, to, shqPrompt(prompt)); setTimeout(tick, 1500); setTimeout(tick, 4000); return json(res, r.ok ? 200 : 500, { ...r, to });
    }
    case 'claude-label': { const r = claude.setLabel(String(b.session || ''), b.label); setTimeout(tick, 100); return json(res, 200, r); }
    case 'dismiss-crash': { dismissedCrash.add(String(b.key || '')); pushState(true); return json(res, 200, { ok: true }); }
    case 'claude-seen': { const r = claude.seen(String(b.session || '')); setTimeout(tick, 100); return json(res, 200, r); }
    case 'savefile': { // editor save; refuses if the file changed since it was loaded
      const p = proj(b.id); if (!p) return json(res, 404, { error: 'no project' });
      if (typeof b.path !== 'string' || typeof b.text !== 'string') return json(res, 400, { error: 'path + text' });
      const r = files.save(p.path, b.path, b.text, +b.mtime || 0); if (r.ok) refreshGitOne(p.isGit ? p.id : p.parent).then(() => pushState(false)); return json(res, r.ok ? 200 : 409, r);
    }
    case 'send': { // type into a tmux session (quick reply from the card / phone)
      if (typeof b.session !== 'string' || typeof b.text !== 'string') return json(res, 400, { error: 'session + text' });
      const r = await claude.send(b.session, b.text.slice(0, 4000), b.enter !== false); setTimeout(tick, 400); return json(res, r.ok ? 200 : 400, r);
    }
    case 'key': { const r = await claude.key(String(b.session || ''), String(b.key || '')); setTimeout(tick, 400); return json(res, r.ok ? 200 : 400, r); }
    case 'push-subscribe': { const r = push.subscribe(b.subscription, b.label); pushState(true); return json(res, r.ok ? 200 : 400, r); }
    case 'push-unsubscribe': { const r = push.unsubscribe(b.endpoint); pushState(true); return json(res, 200, r); }
    case 'push-test': { const r = await push.notify({ title: 'Beast Dash', body: 'Push works. Claude sessions will buzz you here when they need you.', url: '/', tag: 'test' }); return json(res, 200, r); }
    case 'restart': {
      const runs = rt.loadRuns(); const rec = runs[b.session]; if (!rec) return json(res, 404, { error: 'unknown session' });
      const p = proj(rec.project); if (!p) return json(res, 404, { error: 'no project' });
      await actions.stop(b.session); const r = await actions.start(p, rec.name, rec.cmd); setTimeout(tick, 800); return json(res, 200, r);
    }
    case 'kill': { const r = await actions.kill(+b.pid, !!b.force); setTimeout(tick, 300); return json(res, 200, r); }
    case 'docker': { const r = await actions.docker(b.id, b.action); setTimeout(tick, 500); return json(res, r.ok ? 200 : 500, r); }
    case 'git': {
      const p = proj(b.id); if (!p) return json(res, 404, { error: 'no project' });
      const r = await actions.gitAction(p, b.action, b.action === 'commit' ? b.message : b.action === 'revert-file' ? b.file : b.branch); await refreshGitOne(p.id); pushState(true); return json(res, r.ok ? 200 : 409, r);
    }
    case 'expose': { const r = await expose.expose(+b.port, b.addr || null, snapshot); setTimeout(tick, 400); setTimeout(tick, 1500); return json(res, r.ok ? 200 : 400, r); }
    case 'unexpose': { const r = await expose.unexpose(b.pid ? +b.pid : null, b.port ? +b.port : null); setTimeout(tick, 400); return json(res, 200, r); }
    case 'expose-rebuild': {
      for (const e of snapshot.exposures) await expose.unexpose(e.pid);
      await new Promise(r => setTimeout(r, 700)); snapshot = await rt.snapshot(projects);
      await expose.reconcile(snapshot, true); setTimeout(tick, 600); return json(res, 200, { ok: true, count: snapshot.exposures.length });
    }
    case 'recover': { // after suspend/resume: refresh tailscale info, rebuild forwards, force state push
      TS_INFO = null; TS_IP = null; const ts = await run('tailscale', ['status', '--json'], { timeout: 5000 });
      for (const e of snapshot.exposures) await expose.unexpose(e.pid);
      await new Promise(r => setTimeout(r, 700)); await tick(); LAST_RESUME = null; pushState(true);
      return json(res, 200, { ok: true, tailscale: ts.ok ? 'ok' : (ts.stderr || 'unreachable').trim(), exposures: snapshot.exposures.length });
    }
    case 'settings': { const s = settings.update(b); if (b.devRoot || b.scanDepth) await rescan(); pushState(true); return json(res, 200, s); }
    case 'project': { // per-project overrides: label, hidden, pin, commands
      if (!proj(b.id)) return json(res, 404, { error: 'no project' });
      const { id, ...patch } = b; settings.setProjectOverride(id, patch); await rescan(); pushState(true); return json(res, 200, { ok: true });
    }
    case 'rescan': { await rescan(); await tick(); pushState(true); return json(res, 200, { ok: true, count: projects.length }); }
    case 'refresh-git': { await refreshGit(true); pushState(true); return json(res, 200, { ok: true }); }
    case 'clear-recent': { const runs = rt.loadRuns(); for (const k of Object.keys(runs)) if (runs[k].endedAt) delete runs[k]; rt.saveRuns(runs); setTimeout(tick, 100); return json(res, 200, { ok: true }); }
    default: return json(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) { res.writeHead(403); return res.end('forbidden (not localhost / tailnet)'); }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let f = url.pathname === '/' ? '/index.html' : url.pathname;
    f = path.normalize(f).replace(/^(\.\.[\/\\])+/, '');
    const fp = path.join(PUBLIC, f);
    if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else try { res.end(); } catch {} }
});

(async () => {
  const s = settings.get();
  await rescan();
  await sys.sample();
  await tick();
  setPace();   // krece u mirnom taktu; prvi klijent ga digne
  limits.start(() => pushState(false));   // plan limits (5 h / 7 d / Fable) per account, every minute
  setInterval(() => runSchedule().catch(e => console.error('schedule', e)), 5000);   // scheduled prompts: own clock, not tied to the (slow when unwatched) tick
  server.listen(s.port, '0.0.0.0', () => console.log(`beast-dash on http://${TS_IP || '0.0.0.0'}:${s.port}  (${projects.length} projects)`));
})();
