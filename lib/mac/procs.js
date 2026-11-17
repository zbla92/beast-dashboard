'use strict';
// macOS process table, listening ports and per-process cwd / stdout: what Linux reads from /proc and `ss`.
//
// Shapes match lib/probe.js, so its callers don't change:
//   table() -> Map pid -> { pid, comm, ppid, cpuTicks, rss, start, uid }
//   snap()  -> { procs: <table>, ports: [{ addr, port, pid, proc }] }
// cpuTicks and start are in 1/100 s like Linux USER_HZ, start counted from boot.
//
// Sources: `ps` (two calls: the fixed columns, then the full command line), `netstat -anv` (listening sockets with
// their pid), `lsof` (cwd and fd 1). cwd and stdout are cached per process and refreshed in the background, so the
// sync readers in runtime.js and hogs.js stay sync: the first look at a new process may miss, the next tick has it.
const { execFileSync } = require('child_process');
const { exec } = require('./exec');

const HZ = 100;
const FD_TTL = 30000;

const bootMs = (() => {
  try {
    const m = execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }).match(/sec = (\d+), usec = (\d+)/);
    if (m) return +m[1] * 1000 + Math.round(+m[2] / 1000);
  } catch {}
  return Date.now() - require('os').uptime() * 1000;
})();

let TABLE = new Map();   // the latest table() result
let ARGS = new Map();    // pid -> full command line
let lastError = null;

// `ps -o time`: [dd-][hh:]mm:ss.cc
function cpuSecs(s) {
  const [d, rest] = s.includes('-') ? s.split('-') : ['0', s];
  return +d * 86400 + rest.split(':').reduce((a, p) => a * 60 + parseFloat(p), 0);
}

let inflight = null;
function table() {
  if (!inflight) inflight = readTable().finally(() => { inflight = null; });
  return inflight;
}
async function readTable() {
  const [a, b] = await Promise.all([
    exec('ps', ['-axww', '-o', 'pid=,ppid=,uid=,rss=,time=,lstart=,ucomm=']),
    exec('ps', ['-axww', '-o', 'pid=,args=']),
  ]);
  if (!a.ok) { lastError = 'ps: ' + (a.stderr.trim().split('\n')[0] || 'failed'); return TABLE; }
  const procs = new Map();
  for (const line of a.stdout.split('\n')) {
    // pid ppid uid rss time | lstart = "Wed Nov 11 13:58:20 2026" | ucomm (may contain spaces)
    const f = line.trim().split(/\s+/); if (f.length < 11) continue;
    const pid = +f[0]; if (!pid) continue;
    const startMs = Date.parse(`${f[6]} ${f[7]}, ${f[9]} ${f[8]}`);
    procs.set(pid, {
      pid, comm: f.slice(10).join(' '), ppid: +f[1], cpuTicks: Math.round(cpuSecs(f[4]) * HZ), rss: +f[3] * 1024,
      start: Number.isFinite(startMs) ? Math.max(0, Math.round((startMs - bootMs) / 1000 * HZ)) : 0, uid: +f[2],
    });
  }
  const args = new Map();
  for (const line of b.stdout.split('\n')) { const m = line.match(/^\s*(\d+) (.*)$/); if (m) args.set(+m[1], m[2]); }
  TABLE = procs; ARGS = args; lastError = null;
  for (const pid of FD.keys()) if (!procs.has(pid)) FD.delete(pid);
  return procs;
}

// Apple's own daemons (AirPlay receiver on 5000/7000, rapportd, sharingd…) listen on ports that have nothing to do
// with development; Linux has no such noise, so the rest of the dashboard never learned to skip them.
function isSystem(pid) { return /^\/(System|usr\/libexec|usr\/sbin|Library\/Apple)\//.test(ARGS.get(pid) || ''); }

async function listening() {
  const r = await exec('netstat', ['-anvp', 'tcp']);
  const out = [], seen = new Set();
  for (const line of r.stdout.split('\n')) {
    if (!/\sLISTEN\s/.test(line)) continue;
    const f = line.trim().split(/\s+/);
    const proto = f[0], local = f[3] || '';
    const i = local.lastIndexOf('.'); if (i < 0) continue;
    let addr = local.slice(0, i); const port = +local.slice(i + 1);
    if (addr === '*') addr = proto === 'tcp4' ? '0.0.0.0' : '::';
    if (addr.includes('%')) addr = addr.split('%')[0];
    // … LISTEN rxbytes txbytes rhiwat shiwat process:pid …
    const m = line.match(/LISTEN\s+\d+\s+\d+\s+\d+\s+\d+\s+(.*?):(\d+)\s/);
    const pid = m ? +m[2] : null, proc = m ? m[1] : null;
    const key = `${addr} ${port} ${pid}`; if (seen.has(key)) continue; seen.add(key);
    out.push({ addr, port, pid, proc });
  }
  return out;
}

async function snap() {
  const [procs, ports] = await Promise.all([table(), listening()]);
  const live = ports.filter(p => !p.pid || !isSystem(p.pid));
  // runtime.js attributes a listening process to a project by its cwd, or a parent's (up to 4 hops): have those now
  const want = new Set();
  for (const p of live) for (let pid = p.pid, hops = 0; pid > 1 && hops < 4; pid = procs.get(pid)?.ppid || 0, hops++) want.add(pid);
  await fill([...want]);
  return { procs, ports: live };
}

// ---- cwd + stdout (fd 1), cached per process ----
const FD = new Map();   // pid -> { start, at, cwd, out }
let queued = new Set(), timer = null, filling = null;

function fresh(pid) {
  const e = FD.get(pid), p = TABLE.get(pid);
  return e && p && e.start === p.start && Date.now() - e.at < FD_TTL ? e : null;
}
async function fill(pids) {
  const need = pids.filter(pid => !fresh(pid)); if (!need.length) return;
  if (filling) await filling;
  filling = lsof(need).finally(() => { filling = null; });
  return filling;
}
async function lsof(pids) {
  const r = await exec('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd,1', '-Fpfn'], 8000);   // exits 1 when a pid is gone; the rest is still printed
  const got = new Map(); let pid = null, fd = null;
  for (const l of r.stdout.split('\n')) {
    const k = l[0], v = l.slice(1);
    if (k === 'p') { pid = +v; got.set(pid, { cwd: null, out: null }); }
    else if (k === 'f') fd = v;
    else if (k === 'n' && got.has(pid)) { if (fd === 'cwd') got.get(pid).cwd = v; else if (fd === '1') got.get(pid).out = v; }
  }
  const now = Date.now();
  for (const p of pids) FD.set(p, { ...(got.get(p) || { cwd: null, out: null }), start: TABLE.get(p)?.start ?? null, at: now });
}
// Sync read: the cached value (even a stale one of the same process); a miss queues a background lsof.
function info(pid) {
  pid = +pid; const e = FD.get(pid), p = TABLE.get(pid);
  if (!fresh(pid)) {
    queued.add(pid);
    if (!timer) timer = setTimeout(() => { timer = null; const list = [...queued]; queued = new Set(); fill(list).catch(() => {}); }, 0);
  }
  return e && (!p || e.start === p.start) ? e : null;
}
function cwd(pid) { return info(pid)?.cwd || null; }
function stdout(pid) {
  const o = info(pid)?.out || '';
  return { tty: o.startsWith('/dev/ttys') ? o : null, outFile: o.startsWith('/') && !o.startsWith('/dev/') ? o : null };
}

// ---- lookups in the latest table ----
function args(pid) { return ARGS.get(+pid) || ''; }
function argv(pid) { const a = args(pid); return a ? a.split(' ').filter(Boolean) : []; }   // ps joins argv with spaces; good enough for naming
function proc(pid) { return TABLE.get(+pid) || null; }
function uid(pid) { const p = TABLE.get(+pid); return p ? p.uid : null; }
async function commOf(pid) { const r = await exec('ps', ['-o', 'ucomm=', '-p', String(+pid)], 3000); return r.stdout.trim(); }
// One process's CPU time (in ticks) and age (s), read now: for callers that sample a single pid on their own clock.
function cpuNow(pid) {
  try {
    const [time, etime] = execFileSync('ps', ['-o', 'time=,etime=', '-p', String(+pid)], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } }).trim().split(/\s+/);
    return time && etime ? { ticks: Math.round(cpuSecs(time) * HZ), age: cpuSecs(etime) } : null;
  } catch { return null; }
}

module.exports = { HZ, bootMs, table, snap, listening, isSystem, cwd, stdout, args, argv, proc, uid, commOf, cpuNow, lastError: () => lastError };
