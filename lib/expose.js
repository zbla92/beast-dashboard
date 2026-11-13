'use strict';
// Exposes loopback-only ports on the Tailscale IP via socat so the Mac can reach them without SSH tunnels.
// Manual exposures are persisted (state/manual-exposes.json) and never auto-removed.
const path = require('path');
const { run, spawnDetached, readJson, writeJson, readText, STATE } = require('./util');
const mac = process.platform === 'darwin' ? require('./mac/procs') : null;

const MANUAL_FILE = path.join(STATE, 'manual-exposes.json');
let tsIp = null, tsIpTs = 0, tsName = null, tsInfo = { online: null, peers: [] }, tsInfoTs = 0;

async function tailscaleIp() {
  if (tsIp && Date.now() - tsIpTs < 60000) return tsIp;
  const r = await run('tailscale', ['ip', '-4'], { timeout: 3000 });
  if (r.ok && r.stdout.trim()) { tsIp = r.stdout.trim().split('\n')[0]; tsIpTs = Date.now(); }
  return tsIp;
}
async function tailscaleInfo() {
  if (Date.now() - tsInfoTs < 10000) return tsInfo;
  tsInfoTs = Date.now();
  const s = await run('tailscale', ['status', '--json'], { timeout: 4000 });
  try {
    const j = JSON.parse(s.stdout);
    tsName = (j.Self.DNSName || '').replace(/\.$/, '');
    tsInfo = { online: !!j.Self.Online, backend: j.BackendState, health: j.Health || [], peers: Object.values(j.Peer || {}).map(p => ({ name: (p.DNSName || '').split('.')[0], os: p.OS, online: !!p.Online, ip: (p.TailscaleIPs || [])[0], lastSeen: p.LastSeen })) };
  } catch { tsInfo = { online: false, backend: 'unknown', health: ['tailscale status failed'], peers: [] }; }
  return tsInfo;
}
function tailscaleName() { return tsName; }

function manual() { return readJson(MANUAL_FILE, []); }
function setManual(list) { writeJson(MANUAL_FILE, list); }

function spawnSocat(port, addr, ip) {
  const target = addr === '::1' ? `TCP6:[::1]:${port}` : `TCP4:127.0.0.1:${port}`;
  spawnDetached('socat', [`TCP4-LISTEN:${port},bind=${ip},fork,reuseaddr`, target]);
}

// Manual expose: persist + start socat (unless the port is already reachable on the tailscale IP / wildcard).
async function expose(port, addr, snapshot) {
  const ip = await tailscaleIp();
  if (!ip) return { ok: false, error: 'tailscale IP not available' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'bad port' };
  const ports = snapshot?.ports || [];
  const bound = ports.filter(p => p.port === port);
  const list = manual().filter(m => m.port !== port);
  const lo = bound.find(p => p.loopback); if (lo && !addr) addr = lo.addr;
  list.push({ port, addr: addr || '127.0.0.1', addedAt: Date.now() }); setManual(list);
  const direct = bound.find(p => (p.wildcard || p.addr === ip) && p.proc !== 'socat');
  if (direct) return { ok: true, port, bind: ip, note: `already reachable at ${ip}:${port} (bound to ${direct.addr}) — pinned as manual anyway` };
  if ((snapshot?.exposures || []).some(e => e.port === port)) return { ok: true, port, bind: ip, note: 'already exposed — now pinned as manual' };
  spawnSocat(port, addr || '127.0.0.1', ip);
  return { ok: true, port, bind: ip, note: bound.length ? `forwarding ${ip}:${port} → ${addr || '127.0.0.1'}:${port}` : `forwarding ${ip}:${port} → 127.0.0.1:${port} (nothing listens there yet; works once the service starts)` };
}
async function unexpose(pid, port) {
  if (port) setManual(manual().filter(m => m.port !== port));
  if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, 'SIGTERM'); } catch (e) { return { ok: false, error: e.message }; } }
  return { ok: true };
}

// Reconcile: auto-expose loopback project ports; keep manual ones alive; drop auto ones whose target is gone.
const DENY_PROCS = new Set(['postgres', 'mysqld', 'mariadbd', 'redis-server', 'memcached', 'mongod', 'headless_shell', 'chrome', 'chromium', 'docker-proxy']);
const DENY_PORTS = new Set([5432, 3306, 6379, 11211, 27017, 9200, 5672, 9229, 9230, 9222, 5678, 5005]);
function debugPorts(cmd) {
  const out = [];
  for (const m of (cmd || '').matchAll(/--inspect(?:-brk|-wait)?(?:=(?:\S*:)?(\d+))?(?=\s|$)/g)) out.push(+(m[1] || 9229));
  for (const m of (cmd || '').matchAll(/--remote-debugging-port=(\d+)/g)) out.push(+m[1]);
  return out;
}
function autoWanted(snapshot, deny = []) {
  const denied = new Set([...DENY_PORTS, ...(Array.isArray(deny) ? deny.filter(Number.isInteger) : [])]);
  const procOf = new Map(snapshot.ports.map(p => [p.port, p.proc]));
  const wanted = new Map();
  const consider = (p, owner) => { if (p.loopback && owner && !p.ephemeral && !denied.has(p.port) && !DENY_PROCS.has(p.proc || procOf.get(p.port))) wanted.set(p.port, p.addr); };
  for (const s of snapshot.sessions) for (const p of s.ports) consider(p, s.project);
  for (const e of snapshot.external) for (const p of e.ports) consider(p, e.project);
  return wanted;
}
const TS_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
function ours(e, ip) { return (e.target === '127.0.0.1:' + e.port || e.target === '::1:' + e.port) && (ip ? e.bind === ip : TS_V4.test(e.bind || '')); }
function plan(snapshot, ip, { auto, manualPorts, deny }) {
  const live = new Map(snapshot.exposures.map(e => [e.port, e]));
  const wanted = auto ? autoWanted(snapshot, deny) : new Map();
  const tsBound = new Set(snapshot.ports.filter(p => (p.addr === ip || p.wildcard) && p.proc !== 'socat').map(p => p.port));
  const listening = new Set(snapshot.ports.filter(p => p.loopback).map(p => p.port));
  const spawn = [], kill = [];
  for (const [port, addr] of wanted) if (!live.has(port) && !tsBound.has(port)) spawn.push([port, addr]);
  for (const [port, addr] of manualPorts) { const lo = snapshot.ports.find(p => p.port === port && p.loopback); if (!live.has(port) && !tsBound.has(port)) spawn.push([port, lo ? lo.addr : addr]); }
  for (const [port, e] of live) if (ours(e, ip) && !manualPorts.has(port) && (!wanted.has(port) || !listening.has(port))) kill.push(e.pid);
  return { spawn, kill };
}
async function reconcile(snapshot, auto, deny) {
  const ip = await tailscaleIp(); if (!ip) return false;
  const pids = new Set(snapshot.ports.filter(p => p.loopback && p.pid && p.proc !== 'socat').map(p => p.pid));
  const debug = [...pids].flatMap(pid => debugPorts(mac ? mac.args(pid) : (readText(`/proc/${pid}/cmdline`) || "").split('\0').join(' ')));
  const { spawn, kill } = plan(snapshot, ip, { auto, manualPorts: new Map(manual().map(m => [m.port, m.addr])), deny: [...(Array.isArray(deny) ? deny : []), ...debug] });
  for (const [port, addr] of spawn) spawnSocat(port, addr, ip);
  for (const pid of kill) await unexpose(pid);
  return spawn.length + kill.length > 0;
}
module.exports = { expose, unexpose, reconcile, plan, ours, debugPorts, tailscaleIp, tailscaleName, tailscaleInfo, manual };
