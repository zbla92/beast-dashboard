'use strict';
// Exposes loopback-only ports on the Tailscale IP via socat so the Mac can reach them without SSH tunnels.
// Manual exposures are persisted (state/manual-exposes.json) and never auto-removed.
const path = require('path');
const { run, spawnDetached, readJson, writeJson, STATE } = require('./util');

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
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (e) { return { ok: false, error: e.message }; } }
  return { ok: true };
}

// Reconcile: auto-expose loopback project ports; keep manual ones alive; drop auto ones whose target is gone.
async function reconcile(snapshot, auto) {
  const ip = await tailscaleIp(); if (!ip) return;
  const live = new Map(snapshot.exposures.map(e => [e.port, e]));
  const wanted = new Map();
  const consider = (p, owner) => { if (p.loopback && owner && !p.ephemeral) wanted.set(p.port, p.addr); };
  for (const s of snapshot.sessions) for (const p of s.ports) consider(p, s.project);
  for (const e of snapshot.external) for (const p of e.ports) consider(p, e.project);
  for (const c of snapshot.containers) if (c.state === 'running') for (const p of c.ports) if (p.host && (p.hostIp === '127.0.0.1' || p.hostIp === '::1')) consider({ port: p.host, addr: p.hostIp, loopback: true }, c.project || 'docker');
  const tsBound = new Set(snapshot.ports.filter(p => (p.addr === ip || p.wildcard) && p.proc !== 'socat').map(p => p.port));
  const manualPorts = new Map(manual().map(m => [m.port, m.addr]));
  if (auto) for (const [port, addr] of wanted) if (!live.has(port) && !tsBound.has(port)) spawnSocat(port, addr, ip);
  for (const [port, addr] of manualPorts) { const lo = snapshot.ports.find(p => p.port === port && p.loopback); if (!live.has(port) && !tsBound.has(port)) spawnSocat(port, lo ? lo.addr : addr, ip); }
  const listening = new Set(snapshot.ports.filter(p => p.loopback).map(p => p.port));
  for (const [port, e] of live) if (!listening.has(port) && !manualPorts.has(port)) await unexpose(e.pid);
}
module.exports = { expose, unexpose, reconcile, tailscaleIp, tailscaleName, tailscaleInfo, manual };
