'use strict';
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, readBody, corrupted } = require('./lib/util');
const settings = require('./lib/settings');
const discovery = require('./lib/discovery');
const git = require('./lib/gitinfo');
const rt = require('./lib/runtime');
const sys = require('./lib/sys');
const hogs = require('./lib/hogs');
const probe = require('./lib/probe');
const { detachHelpers } = require('./lib/detach');
// a process's cwd -> the project it runs in (deepest matching project path)
hogs.setResolver(cwd => { const id = rt.attributeTo(projects, cwd); return id ? projects.find(p => p.id === id) : null; });
const expose = require('./lib/expose');
const actions = require('./lib/actions');
const SAFE_NAME = /^[\w.-]+$/;
const claude = require('./lib/claude');
const files = require('./lib/files');
const transcript = require('./lib/transcript');
const health = require('./lib/health');
const search = require('./lib/search');
const schedule = require('./lib/schedule');
const usage = require('./lib/usage');
const limits = require('./lib/limits');
const tasks = require('./lib/tasks');
const recap = require('./lib/recap');
const UPLOAD_MAX = 100e6;   // /api/paste-image: any file up to this, into <devRoot>/.pasted
const pastedDir = () => path.join(settings.get().devRoot, '.pasted');
const push = require('./lib/push');
// Feature routes: plans, worktrees, subagents, Android emulator (stable API)
const plans = require('./lib/plans');
const worktrees = require('./lib/worktrees');
const subagents = require('./lib/subagents');
const emulator = require('./lib/emulator');
// BD_TEST=1: a test copy (own state/, own port) — loopback only, no Anthropic limits polling, no push, no scheduler, no auto-expose
const TEST = process.env.BD_TEST === '1';
if (TEST) push.notify = async () => ({ sent: 0, test: true });

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
  return { projects: projects.map(p => ({ ...p, git: gitStatus[p.id] || null })), runtime: { ...snapshot, manual: expose.manual() }, settings: s, host: { tsIp: TS_IP, tsName: expose.tailscaleName(), tailscale: TS_INFO, publicHost: s.publicHost || TS_IP || 'localhost', terminalPort: 7681, hostname: require('os').hostname(), devRoot: s.devRoot, user: process.env.USER || 'user', lastResume: LAST_RESUME, startedAt: STARTED_AT, build: build(), pushSubs: push.subscriptions().length, probe: probe.status(), stateErrors: corrupted() }, claude: { restorable: claude.restorable(), usage: usage.summary(), limits: limits.all(), installed: CLAUDE_VERSION, update: CLAUDE_UPDATE, schedule: schedule.all(), tasks: tasks.all() }, health: health.all(), crashes: recentCrashes(), stats: sys.latest(), statsHistory: sys.history() };
}
let TS_IP = null, TS_INFO = null, LAST_RESUME = null, LAST_TICK = Date.now();
// front-end build id = newest mtime of public/*: a client that sees it change reloads itself, so a PWA that sat open
// on the phone for hours never runs yesterday's app.js against today's server
let BUILD = 0, buildAt = 0;
function build() { if (Date.now() - buildAt > 5000) { buildAt = Date.now(); try { BUILD = Math.max(...fs.readdirSync(path.join(__dirname, 'public')).map(f => fs.statSync(path.join(__dirname, 'public', f)).mtimeMs)); } catch {} } return Math.round(BUILD); }
const STARTED_AT = Date.now();

function broadcast(event, data) { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(msg); }
let base = null, baseSeq = 0;
function diffOps(a, b, p = [], ops = []) {
  if (a === b) return ops;
  if (b === undefined) { ops.push([p]); return ops; }
  const isObj = x => x !== null && typeof x === 'object';
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b) && (!Array.isArray(a) || a.length === b.length)) {
    for (const k of Object.keys(b)) diffOps(a[k], b[k], [...p, k], ops);
    if (!Array.isArray(a)) for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) ops.push([[...p, k]]);
    return ops;
  }
  ops.push([p, b]);
  return ops;
}
function pushState(force) {
  const s = stateObj(); delete s.statsHistory; delete s.stats;
  const j = JSON.stringify(s);
  if (!force && j === lastStateJson) return;
  const next = JSON.parse(j); const prev = base;
  lastStateJson = j; base = next; baseSeq++;
  if (prev && !force) broadcast('patch', { from: baseSeq - 1, to: baseSeq, ops: diffOps(prev, next) });
  else broadcast('state', { ...next, seq: baseSeq });
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

const TICK_STUCK_MS = 60000;
let tickRun = null, tickNext = null, tickStartedAt = 0;
function tick() {
  if (tickRun && Date.now() - tickStartedAt < TICK_STUCK_MS) {
    if (!tickNext) tickNext = tickRun.then(() => { tickNext = null; return tick(); });
    return tickNext;
  }
  if (tickRun) console.error(`tick: previous tick still running after ${TICK_STUCK_MS / 1000} s, starting a new one`);
  tickStartedAt = Date.now();
  const run = tickBody().finally(() => { if (tickRun === run) tickRun = null; });
  tickRun = run;
  return run;
}
async function tickBody() {
  try {
    const now = Date.now();
    if (now - LAST_TICK > 45000) { LAST_RESUME = now; console.log(`resume detected (gap ${Math.round((now - LAST_TICK) / 1000)}s)`); }
    LAST_TICK = now;
    TS_IP = await expose.tailscaleIp(); TS_INFO = await expose.tailscaleInfo();
    let snap = await rt.snapshot(projects);
    if (!TEST && await expose.reconcile(snap, settings.get().autoExpose, settings.get().exposeDeny)) snap = { ...snap, exposures: await rt.exposures() };
    await decorateClaude(snap);
    snapshot = snap;
    await probeHealth();
    detectCrashes();
    await claudeVersion();
    weeklyDigest().catch(() => {}); backupState();
    if (!TEST) detachHelpers().catch(e => console.error('detach', e));
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

// Installed Claude Code version (the sessions report theirs from the transcript): a mismatch = "restart to update".
// The native installer updates itself; a mise install (Omarchy) only prints "Run: mise upgrade claude", so there
// CLAUDE_UPDATE = the newer release mise sees, and /api/claude-upgrade installs it.
let CLAUDE_VERSION = null, CLAUDE_UPDATE = null, versionAt = 0, miseChecking = false, miseUpgrade = null;
async function claudeVersion(force) {
  if (!force && Date.now() - versionAt < 10 * 60e3) return; versionAt = Date.now();
  try { const link = fs.readlinkSync(path.join(process.env.HOME, '.local', 'bin', 'claude')); const m = link.match(/(\d+\.\d+\.\d+)$/); if (m) { CLAUDE_VERSION = m[1]; CLAUDE_UPDATE = null; return; } } catch {}
  const r = await run('claude', ['--version'], { timeout: 8000 }); const m = r.stdout.match(/(\d+\.\d+\.\d+)/); if (m) CLAUDE_VERSION = m[1];
  miseOutdated();   // not awaited: it may go to the network
}
// mise lists claude only when a newer release is out; its "current" has to be the claude found above, or mise's isn't the one in use
async function miseOutdated() {
  if (miseChecking) return; miseChecking = true;
  try {
    const r = await run('mise', ['outdated', 'claude', '--json'], { timeout: 30000, cwd: process.env.HOME });
    const c = r.ok ? JSON.parse(r.stdout || '{}').claude : null;
    CLAUDE_UPDATE = c && c.latest && c.latest !== c.current && c.current === CLAUDE_VERSION ? { version: c.latest, via: 'mise' } : null;
  } catch {} finally { miseChecking = false; }
}
// Scheduled prompts: send when due and the session is not busy; push when a job finishes.
async function runSchedule() {
  // busy = hooks + pane merged (so "waiting on background agents" counts as busy); exists = ask tmux directly
  const busy = name => { const st = claude.info(name).state; return st === 'working' || st === 'background' || st === 'permission'; };
  const exists = name => actions.sessionExists(name);
  const done = await schedule.run(busy, (name, text) => claude.send(name, text, true), exists);
  for (const j of done) {
    if (j.whenFree && j.state === 'done') continue;   // the session's own "done" push already covers it
    // a task rode on this job: attach Claude's closing message and tell the phone about the TASK, not the job
    const tk = tasks.noteResult(j.id, { ok: j.state === 'done', summary: claude.get(j.session)?.lastMessage, session: j.session, error: j.error });
    if (tk) { if (pushAllowed('done', j.session)) push.notify({ title: `${tk.title.slice(0, 60)} · ${j.state === 'done' ? 'Claude finished' : 'failed'}`, body: oneLine(tk.result.summary || tk.result.error || 'review it on the Tasks screen', 80), url: '/?view=tasks', tag: 'task-' + tk.id }).catch(() => {}); pushState(true); continue; } const ok = j.state === 'done'; if (pushAllowed('done', j.session)) push.notify({ title: `${j.session.replace(/^claude-/, '').replace(/-company$/, '')} · scheduled ${ok ? 'done' : 'failed'}`, body: oneLine(ok ? j.prompts[0] : (j.error || ''), 80), url: `/?term=${encodeURIComponent(j.session)}&mode=chat`, tag: 'sched-' + j.id }).catch(() => {}); }
  if (done.length) setTimeout(tick, 200);
}
// Weekly digest (Monday 09:00 local): sessions, cost per account, commits by you across all repos in the last 7 days.
async function myCommits(start, end) {
  const me = await recap.author(); let commits = 0, projectsTouched = 0;
  for (const p of projects.filter(x => x.isGit)) { const r = await run('git', ['-C', p.path, 'log', `--since=${new Date(start).toISOString()}`, `--until=${new Date(end).toISOString()}`, '--author=' + me, '--no-merges', '--oneline'], { timeout: 8000 }); const n = r.stdout.split('\n').filter(Boolean).length; if (n) { commits += n; projectsTouched++; } }
  return { commits, projectsTouched };
}
let lastDigestDay = settings.get().lastDigestDay || '';
async function weeklyDigest() {
  const d = new Date(); if (d.getDay() !== 1 || d.getHours() < 9) return;
  const day = recap.dayWindow(0).key; if (lastDigestDay === day) return; lastDigestDay = day; settings.update({ lastDigestDay: day });
  if (!(settings.get().notify || {}).digest) return;
  const u = usage.summary(); const { commits, projectsTouched } = await myCommits(recap.dayWindow(7).start, Date.now());
  const sessions = Object.values(claude.all()).filter(r => Date.now() - (r.lastEventAt || 0) < 7 * 86400e3).length;
  push.notify({ title: '📊 Beast weekly', body: `${sessions} Claude sessions · $${u.total.week.toFixed(0)} API-equiv (personal $${u.personal.week.toFixed(0)}, company $${u.company.week.toFixed(0)}) · ${commits} commits in ${projectsTouched} repos`, url: '/', tag: 'digest' }).catch(() => {});
}
// Morning summary (08:00 local): what waits for you — tasks to review / open, sessions that need you, yesterday's spend + commits.
let lastDailyDay = settings.get().lastDailyDay || '';
async function dailySummary() {
  const d = new Date(); if (d.getHours() < 8) return;
  const day = recap.dayWindow(0).key; if (lastDailyDay === day) return; lastDailyDay = day; settings.update({ lastDailyDay: day });
  const n = settings.get().notify || {}; if (n.daily === false) return;
  const tk = tasks.all(); const review = tk.filter(t => t.status !== 'done' && t.result).length, open = tk.filter(t => t.status !== 'done').length;
  const need = snapshot.sessions.filter(s => s.claude && s.claude.needsYou).length;
  const y = recap.dayWindow(1); const u = usage.summary(); const { commits } = await myCommits(y.start, y.end);
  const parts = []; if (review) parts.push(`${review} task${review > 1 ? 's' : ''} to review`); if (open) parts.push(`${open} open`); if (need) parts.push(`${need} session${need > 1 ? 's' : ''} need you`); parts.push(`yesterday $${u.total.yesterday.toFixed(0)} · ${commits} commits`);
  push.notify({ title: '☀️ Good morning', body: parts.join(' · ').slice(0, 120), url: review || open ? '/?view=tasks' : '/', tag: 'daily' }).catch(() => {});
}
// Nightly backup of the dashboard's own state (sessions, labels, push subscriptions, settings, schedule): state-backups/, keep 7.
let lastBackupDay = '';
function backupState() {
  const day = recap.dayWindow(0).key; if (lastBackupDay === day) return; lastBackupDay = day;
  const dir = path.join(__dirname, 'state-backups'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `state-${day}.tar.gz`); if (fs.existsSync(out)) return;
  run('tar', ['-czf', out, '-C', path.join(__dirname, 'state'), '--exclude=logs', '--exclude=usage-cache.json', '.'], { timeout: 60000 }).then(r => {
    if (!r.ok) return console.error('backup failed', r.stderr);
    const files = fs.readdirSync(dir).filter(f => f.startsWith('state-')).sort(); while (files.length > 7) { try { fs.unlinkSync(path.join(dir, files.shift())); } catch {} }
  });
}
// Auto-restore after a reboot: the first tick after start sees the remembered sessions with no tmux behind them.
let autoRestored = false;
async function autoRestore() {
  if (autoRestored) return; autoRestored = true;
  if (TEST) return;   // a test copy / design preview never starts sessions in the real tmux
  if (!settings.get().autoRestore) return;
  const list = claude.restorable().filter(r => r.gone && Date.now() - r.gone < 7 * 86400e3); if (!list.length) return;
  console.log('auto-restore:', list.map(r => r.tmux).join(', '));
  for (const r of list) { const rec = claude.get(r.tmux); const res = await actions.restoreClaude(rec); console.log('  ', r.tmux, res.ok ? 'ok' : res.error); }
  setTimeout(tick, 1500); setTimeout(tick, 4000);
}

// Claude sessions: peek at every claude-* pane, merge with hook state, keep the restore list current, scan usage.
let lastUsageScan = 0;
async function decorateClaude(snap) {
  const names = snap.sessions.map(s => s.name);
  // a Claude session is anything named claude-* (dashboard / `cs` helper) or whose foreground process is `claude` (started by hand)
  const isClaude = s => s.name.startsWith('claude-') || s.current === 'claude' || !!claude.get(s.name);
  const cl = snap.sessions.filter(isClaude).map(s => s.name);
  await claude.refreshPeeks(cl);
  claude.reconcile(names);
  claude.refreshTitles();
  for (const s of snap.sessions) if (isClaude(s)) { s.claude = claude.info(s.name, s.activity); s.claude.usage = usage.bySession(s.claude.sessionId); Object.assign(s.claude, await whereIs(s)); if (s.claudeVersion) s.claude.version = s.claudeVersion; }
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
const pushGate = require('./lib/pushgate').createPushGate();
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
  const now = Date.now();
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
  if (!skipQuick && !pushGate.blocked(r.tmux, kind, now) && pushAllowed(kind, r.tmux)) { pushGate.sent(r.tmux, kind, now); push.notify({ title, body, url: `/?term=${encodeURIComponent(r.tmux)}&mode=chat`, tag: r.tmux, session: r.tmux, kind, since: r.since }).then(res => { if (res.sent) console.log(`push: ${title} -> ${res.sent}`); }); }
  broadcast('ding', { tmux: r.tmux, state: r.state, title });
  setTimeout(tick, 150);
});

async function statsTick() { try { const s = await sys.sample(); try { const table = await probe.procs(); s.hogs = hogs.sample(Date.now(), table); } catch (e) { s.hogs = []; } sys.tempsSample(s); systemAlerts(s); broadcast('stats', s); } catch (e) { console.error('stats failed', e); } }
// Phone buzz when the machine itself is in trouble: CPU too hot, memory nearly gone, a process pinning many cores for
// a long time. Each alert at most once per 30 min (per process: once per its life), under the 'system' toggle.
const sysAlertAt = new Map(); let hotSince = null;
function systemAlerts(s) {
  const now = Date.now(); const once = (key, gap, fn) => { if (now - (sysAlertAt.get(key) || 0) < gap) return; sysAlertAt.set(key, now); if (pushAllowed('system')) fn(); };
  const t = s.cpu.temp; hotSince = t >= 90 ? (hotSince || now) : null;
  const host = settings.get().serverName || require('os').hostname();
  if (hotSince && now - hotSince > 60000) once('temp', 30 * 60e3, () => push.notify({ title: `🔥 ${host} CPU ${t.toFixed(0)}°C`, body: oneLine((s.hogs[0] ? 'Top: ' + s.hogs[0].name + ' · ' + s.hogs[0].cpu + '% CPU' : 'no single process to blame'), 80), url: '/?view=home', tag: 'sys-temp' }).catch(() => {}));
  const availPct = s.mem.total ? (s.mem.total - s.mem.used) / s.mem.total * 100 : 100;
  if (availPct < 6) once('mem', 30 * 60e3, () => push.notify({ title: `🧠 ${host} memory ${Math.round(100 - availPct)}% used`, body: oneLine(s.hogs.slice().sort((a, b) => b.rss - a.rss).slice(0, 2).map(x => x.name + ' ' + (x.rss / 2 ** 30).toFixed(1) + ' GB').join(' · ') || 'check Home', 80), url: '/?view=home', tag: 'sys-mem' }).catch(() => {}));
  for (const hg of s.hogs) if (hg.cpu >= 300 && hg.heavyFor > 10 * 60e3) once('hog-' + hg.pid, 24 * 3600e3, () => push.notify({ title: `🐷 ${hg.name} · ${hg.cpu}% CPU`, body: oneLine(`busy for ${Math.round(hg.heavyFor / 60e3)} min` + (hg.tip ? ' — ' + hg.tip : ''), 100), url: '/?view=home', tag: 'hog-' + hg.pid }).catch(() => {}));
}

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
  { const ap = settings.get().allowedPrefixes; for (const p of Array.isArray(ap) ? ap : []) if (typeof p === 'string' && p && ip.startsWith(p)) return true; }
  return false;
}
// Anti cross-site / DNS-rebinding guard. The IP allow-list above only says "this request came from the tailnet" — but a
// web page open in your laptop's or phone's browser ALSO comes from the tailnet, so any site could POST to /api/shell,
// /api/claude… or read the dashboard. So: the Host must be one of our own names, and a browser request must be same-host
// (Origin host:port) and not cross-site. An IP literal is always fine (a rebinding attack sends the attacker's domain as Host);
// a custom DNS name for the server (not *.ts.net) goes in `publicHost` or `allowedHosts` in state/settings.json.
const hostName = h => { h = String(h || '').toLowerCase(); const v6 = h.match(/^\[([^\]]+)\]/); return v6 ? v6[1] : h.replace(/:\d+$/, ''); };
const hostPort = h => String(h || '').toLowerCase().replace(/:(80|443)$/, '');   // host[:port], default ports dropped
const TERM_PORT = 7681;   // ttyd; over plain http its page is another origin (same host, this port)
function hostOk(req) {
  const n = hostName(req.headers.host), s = settings.get();
  if (n === 'localhost' || !n.includes('.') || n.endsWith('.ts.net')) return true;
  if (require('net').isIP(n)) return true;   // IPv4 / IPv6 literal
  const extra = Array.isArray(s.allowedHosts) ? s.allowedHosts : [];
  return [s.publicHost, ...extra].some(x => typeof x === 'string' && x && hostName(x) === n);
}
// Origin must be exactly this host:port — another port on the same host (a forwarded dev server, any app on your own
// localhost when you use an SSH tunnel) is another site. Only the terminal page may upload pasted files.
// /api also takes only same-origin fetches (Sec-Fetch-Site): a page on another port of the same host is "same-site".
function sameOrigin(req, path) {
  const o = req.headers.origin; const paste = path === '/api/paste-image';
  if (o !== undefined) {
    let u; try { u = new URL(o); } catch { return false; }
    if (hostPort(u.host) !== hostPort(req.headers.host)) {
      const fromTerm = hostName(u.host) === hostName(req.headers.host) && +u.port === TERM_PORT;
      if (!(fromTerm && paste)) return false;
    }
  }
  const sfs = req.headers['sec-fetch-site'];
  if (path.startsWith('/api/') && sfs && sfs !== 'same-origin' && sfs !== 'none' && !(paste && sfs === 'same-site')) return false;
  return true;
}
const GZIP_TYPE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;
function wantsGzip(req) { return !!req && /\bgzip\b/.test(req.headers['accept-encoding'] || ''); }
function send(res, code, headers, body, level = 1) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  if (buf.length > 1400 && GZIP_TYPE.test(headers['content-type'] || '') && wantsGzip(res.req)) {
    const z = zlib.gzipSync(buf, { level });
    res.writeHead(code, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding', 'content-length': z.length }); return res.end(z);
  }
  res.writeHead(code, { ...headers, vary: 'accept-encoding', 'content-length': buf.length }); res.end(buf);
}
function json(res, code, obj) { send(res, code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(obj)); }
const staticGz = new Map();
function sendStatic(req, res, fp, url) {
  const st = fs.statSync(fp); const type = MIME[path.extname(fp)] || 'application/octet-stream';
  const etag = `W/"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
  const headers = { 'content-type': type, 'cache-control': url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'no-cache', etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  if (!GZIP_TYPE.test(type)) { res.writeHead(200, { ...headers, 'content-length': st.size }); return fs.createReadStream(fp).pipe(res); }
  const raw = fs.readFileSync(fp);
  if (!wantsGzip(req) || raw.length <= 1400) return send(res, 200, headers, raw);
  let c = staticGz.get(fp);
  if (!c || c.etag !== etag) { c = { etag, gz: zlib.gzipSync(raw, { level: 9 }) }; staticGz.set(fp, c); }
  res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding', 'content-length': c.gz.length }); res.end(c.gz);
}
const body = readBody;
function sse(res) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' }); res.write(': hi\n\n'); }
const proj = id => projects.find(p => p.id === id);
const shqPrompt = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---- Whisper on demand ----
let whisperInfo = null;   // last /health answer: { idle, exitIn } — shown in the recording sheet
function whisperHealth() { return new Promise(res => { const r = require('http').get({ host: '127.0.0.1', port: 8790, path: '/health', timeout: 800 }, up => { let d = ''; up.on('data', x => d += x); up.on('end', () => { try { whisperInfo = JSON.parse(d); } catch { whisperInfo = null; } res(up.statusCode === 200); }); }); r.on('error', () => { whisperInfo = null; res(false); }); r.on('timeout', () => { r.destroy(); res(false); }); }); }
let whisperStarting = null;
const whisperInstalled = () => fs.existsSync(path.join(require('os').homedir(), '.config', 'systemd', 'user', 'beast-whisper.service'));
function whisperStart() { if (!whisperStarting) { whisperStarting = run('systemctl', ['--user', 'start', 'beast-whisper'], { timeout: 10000 }).finally(() => setTimeout(() => { whisperStarting = null; }, 5000)); } return whisperStarting; }
async function whisperEnsure(ms = 45000) { whisperStart(); const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await whisperHealth()) return true; await new Promise(r => setTimeout(r, 400)); } return false; }
// UI build version = newest mtime of the files the page is made of. Open pages poll /api/version and reload
// themselves (when idle) once it changes, so a phone never runs an old index.html against a new app.js.
const UI_FILE = /^(index\.html|app\.js|style\.css|sw\.js|f-[\w-]+\.(js|css))$/;   // f-*.js / f-*.css = feature modules
function uiVersion() { let v = 0; let fl = []; try { fl = fs.readdirSync(PUBLIC).filter(f => UI_FILE.test(f)); } catch {} for (const f of fl) { try { v = Math.max(v, fs.statSync(path.join(PUBLIC, f)).mtimeMs); } catch {} } return Math.round(v).toString(36); }
// ~/Downloads on the server, browsed with the same file explorer as a project's Files tab (id "_downloads")
const DOWNLOADS = { id: '_downloads', name: 'downloads', path: path.join(require('os').homedir(), 'Downloads'), isGit: false, parent: null, rel: '' };
const fsRoot = id => { if (id !== '_downloads') return proj(id); try { fs.mkdirSync(DOWNLOADS.path, { recursive: true }); } catch {} return DOWNLOADS; };   // a fresh server may have no ~/Downloads yet
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after 'api'
  const m = req.method;
  if (m === 'GET' && parts[0] === 'state') return json(res, 200, stateObj());
  if (m === 'GET' && parts[0] === 'events') {
    if (!base) pushState(true);
    sse(res); clients.add(res); setPace();
    res.write(`event: state\ndata: ${JSON.stringify({ ...base, seq: baseSeq })}\n\n`);
    res.write(`event: history\ndata: ${JSON.stringify(sys.history())}\n\n`);
    if (sys.latest()) res.write(`event: stats\ndata: ${JSON.stringify(sys.latest())}\n\n`);
    const ka = setInterval(() => res.write('event: ping\ndata: 1\n\n'), 20000);
    req.on('close', () => { clients.delete(res); clearInterval(ka); setPace(); });
    return;
  }
  if (m === 'GET' && parts[0] === 'logs' && parts[1]) {
    const name = decodeURIComponent(parts[1]); if (!SAFE_NAME.test(name)) return json(res, 400, { error: 'bad name' });
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
    if (!actions.SAFE_CONTAINER.test(parts[2])) return json(res, 400, { error: 'bad container id' });
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
    const p = fsRoot(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    const gitRoot = p.isGit ? p : (p.parent && proj(p.parent)) || null;
    let changed = {};
    if (gitRoot) { const all = await git.changedPaths(gitRoot.path); const sub = path.relative(gitRoot.path, p.path); const pre = sub ? sub + '/' : ''; for (const [k, v] of Object.entries(all)) if (k.startsWith(pre)) changed[k.slice(pre.length)] = v; }
    const r = files.list(p.path, url.searchParams.get('path') || '', changed); r.git = !!gitRoot; r.sub = gitRoot ? path.relative(gitRoot.path, p.path) : '';
    return json(res, r.error ? 400 : 200, r);
  }
  if (m === 'GET' && parts[0] === 'read' && parts[1]) { // file content for the preview / editor
    const p = fsRoot(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    const r = files.read(p.path, url.searchParams.get('path') || ''); return json(res, r.error ? 400 : 200, r);
  }
  if (m === 'GET' && parts[0] === 'download' && parts[1]) { // raw file, as attachment (inline=1: shown in the browser — image / PDF preview)
    const p = fsRoot(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    return files.stream(p.path, url.searchParams.get('path') || '', res, url.searchParams.get('inline') === '1');
  }
  if (m === 'GET' && parts[0] === 'zip' && parts[1]) { // several files / folders as one zip (?path=a&path=b)
    const p = fsRoot(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    const ps = url.searchParams.getAll('path');
    return files.zip(p.path, ps, res, ps.length === 1 ? path.basename(ps[0]) + '.zip' : `${p.name || p.id}-${recap.dayWindow(0).key}-${ps.length}-items.zip`);
  }
  if (m === 'GET' && parts[0] === 'file' && !parts[1] && url.searchParams.get('p')) { // an uploaded attachment (only from <devRoot>/.pasted)
    const base = pastedDir(); const fp = path.resolve(url.searchParams.get('p'));
    if (!fp.startsWith(base + path.sep) || !fs.existsSync(fp)) return json(res, 404, { error: 'missing' });
    const ext = path.extname(fp).toLowerCase(); const type = MIME[ext] || ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' })[ext] || 'application/octet-stream';
    // an uploaded .html / .svg must not run script as the dashboard's origin: sandbox it (no scripts, opaque origin)
    res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600', ...(/html|svg/.test(type) ? { 'content-security-policy': 'sandbox' } : {}) }); return fs.createReadStream(fp).pipe(res);
  }
  // ---- v1.4 features ----
  if (m === 'GET' && parts[0] === 'plans' && !parts[1]) return json(res, 200, plans.summary(projects));
  if (m === 'GET' && parts[0] === 'plan' && parts[1]) {
    const p = proj(parts[1]); if (!p) return json(res, 404, { error: 'no project' });
    const topic = url.searchParams.get('topic') || ''; if (!/^[\w.-]+$/.test(topic)) return json(res, 400, { error: 'bad topic' });
    const r = url.searchParams.get('file') ? plans.file(p.path, topic, url.searchParams.get('file')) : plans.detail(p.path, topic);
    return json(res, r.error ? 404 : 200, r);
  }
  if (m === 'GET' && parts[0] === 'worktrees' && !parts[1]) return json(res, 200, await worktrees.summary(projects, snapshot.sessions));
  if (m === 'GET' && parts[0] === 'worktrees' && parts[1]) {
    const p = proj(parts[1]); if (!p || !p.isGit) return json(res, 404, { error: 'no git project' });
    return json(res, 200, await worktrees.list(p.path, snapshot.sessions));
  }
  if (m === 'GET' && parts[0] === 'worktree-diff' && parts[1]) {
    const p = proj(parts[1]); if (!p || !p.isGit) return json(res, 404, { error: 'no git project' });
    const r = await worktrees.diff(p.path, url.searchParams.get('path') || ''); return json(res, r.error ? 400 : 200, r);
  }
  if (m === 'GET' && parts[0] === 'usage' && parts[1] === 'models') return json(res, 200, usage.models(Math.max(1, Math.min(30, +url.searchParams.get('days') || 7))));
  if (m === 'GET' && parts[0] === 'subagents' && parts[1]) {
    const r = claude.get(decodeURIComponent(parts[1])); if (!r || !r.transcriptPath) return json(res, 404, { error: 'no transcript' });
    const agent = url.searchParams.get('agent');
    if (agent) { if (!/^[a-z0-9]+$/.test(agent)) return json(res, 400, { error: 'bad agent id' }); const d = subagents.agentDetail(r.transcriptPath, agent); return json(res, d.error ? 404 : 200, d); }
    return json(res, 200, subagents.forSession(r.transcriptPath));
  }
  if (m === 'GET' && parts[0] === 'emu' && !parts[1]) return json(res, 200, await emulator.status());
  if (m === 'GET' && parts[0] === 'emu-screen') {
    const serial = url.searchParams.get('serial') || ''; if (!/^[\w.:-]+$/.test(serial)) return json(res, 400, { error: 'bad serial' });
    const r = await emulator.screen(serial); if (r.error) return json(res, r.status || 404, { error: r.error });
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); return res.end(r.png);
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
  if (m === 'GET' && parts[0] === 'temps') return json(res, 200, sys.tempsHistory(Number(url.searchParams.get('days')) || 1));
  if (m === 'GET' && parts[0] === 'recap') { const off = Math.max(0, Math.min(6, +(url.searchParams.get('day') || 0))); return json(res, 200, await recap.recap(off, projects, usage.files(), cwd => rt.attributeTo(projects, cwd))); }
  if (m === 'GET' && parts[0] === 'claude' && parts[1] === 'sessions') return json(res, 200, claude.all());
  if (m === 'GET' && parts[0] === 'transcript-tool') { // one tool call in full (opened in the chat): ?session=<tmux> or ?file=<transcript>, &id=<tool_use id>
    const id = url.searchParams.get('id') || ''; if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return json(res, 400, { error: 'bad id' });
    let file = url.searchParams.get('file') || '';
    if (file) { if (!search.isTranscript(file)) return json(res, 400, { error: 'not a transcript' }); }
    else { const r = claude.get(url.searchParams.get('session') || ''); if (!r || !r.transcriptPath) return json(res, 404, { error: 'no transcript' }); file = r.transcriptPath; }
    const t = transcript.tool(file, id); return json(res, t.error ? 404 : 200, t);
  }
  if (m === 'GET' && parts[0] === 'transcript' && parts[1]) { // last N turns of a Claude session, by tmux name
    const r = claude.get(decodeURIComponent(parts[1])); if (!r) return json(res, 200, { ...transcript.tail('', 1), touched: [], cwd: null, sessionId: null, noHooks: true });
    return json(res, 200, { ...transcript.tail(r.transcriptPath || '', Math.min(200, +url.searchParams.get('n') || 40)), touched: r.touched || [], cwd: r.cwd, sessionId: r.sessionId });
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
    const cors = { 'access-control-allow-origin': req.headers.origin || 'null', vary: 'Origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
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
  if (m === 'GET' && parts[0] === 'version') return json(res, 200, { v: uiVersion() });
  // speech-to-text: the recorded audio goes straight through to the local Whisper service (beast-whisper, GPU).
  // It runs on demand: GET ?warm=1 (sent when the mic is pressed) starts it, it loads in ~2 s while you talk, and
  // it exits by itself 1 min after the last use so the GPU isn't held at ~9 W all day.
  if (parts[0] === 'transcribe') {
    if (m === 'GET') {
      if (!whisperInstalled()) return json(res, 200, { ok: false, installed: false });   // no bin/setup-whisper.sh yet: the mic uses the browser's speech recognition
      const up = await whisperHealth();
      if (!up && url.searchParams.get('warm') === '1') whisperStart();
      return json(res, 200, { ok: true, loaded: up, onDemand: true, exitIn: up ? whisperInfo?.exitIn ?? null : null, starting: !up && !!whisperStarting });
    }
    if (m !== 'POST') return json(res, 405, { error: 'POST audio' });
    if (!whisperInstalled()) { req.resume(); return json(res, 503, { error: 'Whisper is not installed (bin/setup-whisper.sh)' }); }
    if (!(await whisperHealth()) && !(await whisperEnsure())) { req.resume(); return json(res, 503, { error: 'whisper did not start' }); }
    const http = require('http');
    const up = http.request({ host: '127.0.0.1', port: 8790, method: 'POST', path: '/transcribe' + (url.search || ''), headers: { 'content-type': 'application/octet-stream', 'content-length': req.headers['content-length'] || 0 }, timeout: 120000 }, r2 => { res.writeHead(r2.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' }); r2.pipe(res); });
    up.on('error', e => { if (!res.headersSent) json(res, 503, { error: 'whisper: ' + e.message }); });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    req.pipe(up); return;
  }
  if (m !== 'POST') return json(res, 404, { error: 'not found' });
  const b = await body(req, parts[0] === 'savefile' ? 8e6 : 1e6);
  switch (parts[0]) {
    case 'proc-kill': { // stop (TERM) / kill (KILL) one of the heavy processes shown on Home
      const r = hogs.kill(b.pid, b.sig, sys.latest()?.hogs); if (r.ok) setTimeout(statsTick, 1500); return json(res, r.ok ? 200 : 400, r);
    }
    case 'rmpaths': { // delete selected files / folders — only in ~/Downloads (the Files tab of projects is read/edit, not delete)
      if (b.id !== '_downloads' || !Array.isArray(b.paths)) return json(res, 400, { error: 'only ~/Downloads' });
      const r = files.remove(DOWNLOADS.path, b.paths.map(String)); return json(res, r.ok ? 200 : 207, r);
    }
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
    case 'claude-upgrade': { // mise install: Claude Code can't update itself there. Install the newer release; sessions then get "restart"
      if (CLAUDE_UPDATE?.via !== 'mise') return json(res, 400, { error: 'no Claude Code update to install' });
      if (!miseUpgrade) miseUpgrade = run('mise', ['upgrade', 'claude'], { timeout: 5 * 60e3, cwd: process.env.HOME }).finally(() => { miseUpgrade = null; });
      const r = await miseUpgrade; if (r.ok) CLAUDE_UPDATE = null;
      await claudeVersion(true); pushState(true);
      return json(res, r.ok ? 200 : 500, r.ok ? { ok: true, installed: CLAUDE_VERSION } : { error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || 'mise upgrade failed' });
    }
    case 'claude-mute': { const name = String(b.session || ''); const set = new Set(settings.get().muted || []); if (b.muted) set.add(name); else set.delete(name); settings.update({ muted: [...set] }); pushState(true); return json(res, 200, { ok: true, muted: [...set] }); }
    case 'unit': { const u = String(b.unit || ''); if (!/^[A-Za-z0-9@._-]+\.service$/.test(u) || !['restart', 'stop', 'start'].includes(b.action)) return json(res, 400, { error: 'bad unit/action' }); const r = await run('systemctl', ['--user', b.action, u], { timeout: 20000 }); setTimeout(tick, 1500); return json(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.stderr.trim() || 'failed' }); }
    case 'clientlog': { console.log('client:', String(b.ua || '').slice(0, 60), '|', String(b.msg || '').slice(0, 300), '|', String(b.where || '').slice(0, 200)); return json(res, 200, { ok: true }); }
    // ---- v1.4 features ----
    case 'worktree-merge': case 'worktree-remove': case 'worktree-prune': {
      const p = proj(String(b.id || '')); if (!p || !p.isGit) return json(res, 404, { error: 'no git project' });
      const r = parts[0] === 'worktree-prune' ? await worktrees.prune(p.path)
        : parts[0] === 'worktree-merge' ? await worktrees.merge(p.path, String(b.path || ''))
        : await worktrees.remove(p.path, String(b.path || ''), { force: !!b.force, deleteBranch: !!b.deleteBranch }, snapshot.sessions);
      lastGit = 0; setTimeout(tick, 300); return json(res, r.error ? 400 : 200, r);
    }
    case 'emu-start': { const avd = String(b.avd || ''); if (!/^[\w.-]+$/.test(avd)) return json(res, 400, { error: 'bad avd' }); const r = await emulator.start(avd); return json(res, r.error ? 400 : 200, r); }
    case 'emu-stop': case 'emu-input': {
      const serial = String(b.serial || ''); if (!/^[\w.:-]+$/.test(serial)) return json(res, 400, { error: 'bad serial' });
      const r = parts[0] === 'emu-stop' ? await emulator.stop(serial) : await emulator.input(serial, b); return json(res, r.error ? 400 : 200, r);
    }
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
      // one job per task, all on the same session, in order: the scheduler sends the next one only when the session is idle again
      const list = Array.isArray(b.ids) && b.ids.length ? b.ids.map(i => tasks.all().find(x => x.id === String(i))).filter(x => x && x.status !== 'done' && x.project === p.id) : [t];
      let last = null; for (const tk of list) { const r = schedule.add(name, at, [tasks.prompt(tk, p.name)]); if (!r.ok) return json(res, 500, r); tasks.noteRun(tk.id, name, r.job.id); last = r.job.id; }
      pushState(true); return json(res, 200, { ok: true, session: name, job: last, count: list.length });
    }
    case 'schedule': { const r = schedule.add(b.session, +b.at, b.prompts || b.prompt, { whenFree: !!b.whenFree }); pushState(true); setTimeout(() => runSchedule().catch(() => {}), 300); return json(res, r.ok ? 200 : 400, r); }
    case 'schedule-now': { // "send now" on a queued message: drop it from the queue and type it in
      const j = schedule.all().find(x => x.id === b.id); if (!j) return json(res, 404, { error: 'gone' });
      schedule.remove(j.id); const r = await claude.send(j.session, j.prompts.slice(j.idx).join('\n\n'), true); pushState(true); return json(res, r.ok ? 200 : 500, r);
    }
    case 'schedule-remove': { const r = schedule.remove(String(b.id || '')); pushState(true); return json(res, 200, r); }
    case 'handoff': { // usage limit on one account: start the other account in the same folder with a summary of where this one stopped
      const from = claude.get(String(b.session || '')); if (!from || !from.cwd) return json(res, 404, { error: 'unknown session' });
      const to = from.account === 'company' ? 'personal' : 'company';
      const t = from.transcriptPath ? transcript.tail(from.transcriptPath, 12) : { turns: [] };
      const users = t.turns.filter(x => x.role === 'user').slice(-4).map(x => '- ' + x.text.replace(/\s+/g, ' ').slice(0, 300));
      const lastA = [...t.turns].reverse().find(x => x.role === 'assistant' && transcript.turnText(x)); const last = lastA && { text: transcript.turnText(lastA) }; const files = (from.touched || []).slice(0, 15).map(x => '- ' + x.path);
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
    case 'choose': { const r = await claude.choose(String(b.session || ''), b.index, b.label); setTimeout(tick, 400); return json(res, r.ok ? 200 : 409, r); }
    case 'answer': { const r = await claude.answer(String(b.session || ''), Number.isFinite(b.since) ? b.since : null, b.choice); setTimeout(tick, 400); return json(res, r.ok ? 200 : r.status || 409, r); }
    case 'key': { const r = await claude.key(String(b.session || ''), String(b.key || '')); setTimeout(tick, 400); return json(res, r.ok ? 200 : 400, r); }
    case 'push-subscribe': { const r = push.subscribe(b.subscription, b.label); pushState(true); return json(res, r.ok ? 200 : 400, r); }
    case 'push-unsubscribe': { const r = push.unsubscribe(b.endpoint); pushState(true); return json(res, 200, r); }
    case 'push-test': { const r = await push.notify({ title: 'Beast Dash', body: 'Push works. Claude sessions will buzz you here when they need you.', url: '/', tag: 'test' }); return json(res, 200, r); }
    case 'restart': {
      const runs = rt.loadRuns(); const rec = runs[b.session]; if (!rec) return json(res, 404, { error: 'unknown session' });
      const p = proj(rec.project); if (!p) return json(res, 404, { error: 'no project' });
      await actions.stop(b.session); const r = await actions.start(p, rec.name, rec.cmd); setTimeout(tick, 800); return json(res, 200, r);
    }
    case 'kill': { if (!snapshot.external.some(x => String(x.pid) === String(b.pid))) return json(res, 403, { error: 'not a process the dashboard lists' }); const r = await actions.kill(+b.pid, !!b.force); setTimeout(tick, 300); return json(res, 200, r); }
    case 'docker': { const r = await actions.docker(b.id, b.action); setTimeout(tick, 500); return json(res, r.ok ? 200 : 500, r); }
    case 'git': {
      const p = proj(b.id); if (!p) return json(res, 404, { error: 'no project' });
      const r = await actions.gitAction(p, b.action, b.action === 'commit' ? b.message : b.action === 'revert-file' ? b.file : b.branch); await refreshGitOne(p.id); pushState(true); return json(res, r.ok ? 200 : 409, r);
    }
    case 'expose': { const r = await expose.expose(+b.port, b.addr || null, snapshot); if (r.ok) settings.update({ exposeDeny: (settings.get().exposeDeny || []).filter(x => x !== +b.port) }); setTimeout(tick, 400); setTimeout(tick, 1500); return json(res, r.ok ? 200 : 400, r); }
    case 'unexpose': { if (b.pid != null && !snapshot.exposures.some(e => e.pid === +b.pid)) return json(res, 403, { error: 'not a forward the dashboard lists' }); const r = await expose.unexpose(b.pid != null ? +b.pid : null, b.port ? +b.port : null); if (Number.isInteger(b.deny) && b.deny > 0 && b.deny < 65536) settings.update({ exposeDeny: [...new Set([...(settings.get().exposeDeny || []), b.deny])] }); setTimeout(tick, 400); return json(res, 200, r); }
    case 'expose-rebuild': {
      for (const e of snapshot.exposures.filter(e => expose.ours(e, null))) await expose.unexpose(e.pid);
      await new Promise(r => setTimeout(r, 700)); snapshot = await rt.snapshot(projects);
      await expose.reconcile(snapshot, settings.get().autoExpose, settings.get().exposeDeny); setTimeout(tick, 600); return json(res, 200, { ok: true, count: snapshot.exposures.length });
    }
    case 'recover': { // after suspend/resume: refresh tailscale info, rebuild forwards, force state push
      TS_INFO = null; TS_IP = null; const ts = await run('tailscale', ['status', '--json'], { timeout: 5000 });
      for (const e of snapshot.exposures.filter(e => expose.ours(e, null))) await expose.unexpose(e.pid);
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

async function handle(req, res) {
  if (!allowed(req)) { res.writeHead(403); return res.end('forbidden (not localhost / tailnet)'); }
  if (!hostOk(req)) { res.writeHead(403); return res.end('forbidden (unknown Host — reach it by IP, localhost or *.ts.net, or add this name to allowedHosts in state/settings.json and restart)'); }
  const url = new URL(req.url, 'http://x');
  if (!sameOrigin(req, url.pathname)) { res.writeHead(403); return res.end('forbidden (cross-site request)'); }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    // nobody frames the dashboard: a hidden iframe on another site would turn clicks into taps on the emulator, merges … (clickjacking).
    // Test copies (BD_TEST) stay frameable — the screenshot kit wraps them in an iframe.
    const csp = ["script-src 'self'", "object-src 'none'", "base-uri 'self'"];
    if (!TEST || process.env.BD_BIND) { res.setHeader('x-frame-options', 'DENY'); csp.push("frame-ancestors 'none'"); }
    res.setHeader('content-security-policy', csp.join('; '));
    let f = url.pathname === '/' ? '/index.html' : url.pathname;
    f = path.normalize(f).replace(/^(\.\.[\/\\])+/, '');
    const fp = path.join(PUBLIC, f);
    if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('404'); }
    if (f === '/index.html') { // stamp the build: the page knows which version it is, and app.js / style.css can't come from an older cache
      const v = uiVersion(); const html = fs.readFileSync(fp, 'utf8').replace('</head>', `<meta name="bd-ver" content="${v}"></head>`).replace(/src="\/(app|f-[\w-]+)\.js"/g, `src="/$1.js?v=${v}"`).replace(/href="\/(style|f-[\w-]+)\.css"/g, `href="/$1.css?v=${v}"`);
      return send(res, 200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache, no-store' }, html, 6);
    }
    return sendStatic(req, res, fp, url);
  } catch (e) { console.error(e); if (!res.headersSent) json(res, e.status || 500, { error: String(e.message || e) }); else try { res.end(); } catch {} }
}
const server = http.createServer(handle);
const tailnetServers = new Map();
async function bindTailnet(port) {
  const r = await run('tailscale', ['ip'], { timeout: 3000 });
  const ips = r.ok ? r.stdout.split('\n').map(x => x.trim()).filter(Boolean) : [];
  if (!ips.length) return;
  for (const [ip, srv] of tailnetServers) if (!ips.includes(ip)) { srv.close(); tailnetServers.delete(ip); console.log(`beast-dash: stopped listening on ${ip}`); }
  for (const ip of ips) {
    if (tailnetServers.has(ip)) continue;
    const srv = http.createServer(handle); tailnetServers.set(ip, srv);
    srv.on('error', e => { console.error(`beast-dash: cannot listen on ${ip}:${port} (${e.code || e.message}), retrying`); tailnetServers.delete(ip); });
    srv.listen(port, ip, () => console.log(`beast-dash on http://${ip.includes(':') ? '[' + ip + ']' : ip}:${port}`));
  }
}

(async () => {
  const s = settings.get();
  await rescan();
  await sys.sample();
  await tick();
  setPace();   // starts at the calm pace; the first client speeds it up
  if (!TEST) {
    limits.start(() => pushState(false));   // plan limits (5 h / 7 d / Fable) per account, every minute
    setInterval(() => runSchedule().catch(e => console.error('schedule', e)), 5000);
    setInterval(() => dailySummary().catch(e => console.error('daily', e)), 60000);   // scheduled prompts: own clock, not tied to the (slow when unwatched) tick
  }
  server.listen(s.port, (TEST && process.env.BD_BIND) || '127.0.0.1',   // BD_BIND: a test copy may listen on the tailnet IP (design preview)
   () => console.log(`beast-dash on http://127.0.0.1:${s.port}  (${projects.length} projects)`));
  if (!TEST) { await bindTailnet(s.port); setInterval(() => bindTailnet(s.port).catch(e => console.error('bind', e)), 15000); }
})();
