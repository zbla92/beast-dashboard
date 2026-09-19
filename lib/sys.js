'use strict';
// System stats: CPU, RAM, GPU (nvidia-smi), disk, load, net, temps. Keeps a rolling history.
const fs = require('fs');
const os = require('os');
const { run, readText } = require('./util');

const HISTORY = 180; // samples
const hist = { cpu: [], mem: [], gpu: [], net: [], t: [] };
let prevCpu = null, prevNet = null, prevNetTs = 0;
let last = null;

function cpuTimes() {
  const line = readText('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = line[3] + line[4];
  const total = line.reduce((a, b) => a + b, 0);
  return { idle, total };
}
function perCore() {
  const lines = readText('/proc/stat').split('\n').filter(l => /^cpu\d+/.test(l));
  return lines.map(l => { const n = l.trim().split(/\s+/).slice(1).map(Number); return { idle: n[3] + n[4], total: n.reduce((a, b) => a + b, 0) }; });
}
let prevCores = null;

function mem() {
  const m = {};
  for (const l of readText('/proc/meminfo').split('\n')) { const x = l.match(/^(\w+):\s+(\d+)/); if (x) m[x[1]] = +x[2] * 1024; }
  return { total: m.MemTotal, available: m.MemAvailable, used: m.MemTotal - m.MemAvailable, swapTotal: m.SwapTotal, swapUsed: m.SwapTotal - m.SwapFree, cached: m.Cached + (m.SReclaimable || 0) };
}
function net() {
  let rx = 0, tx = 0; const ifaces = {};
  for (const l of readText('/proc/net/dev').split('\n').slice(2)) {
    const m = l.trim().match(/^([\w.-]+):\s*(.*)$/); if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (m[1] === 'lo' || m[1].startsWith('veth') || m[1].startsWith('br-') || m[1] === 'docker0') continue;
    ifaces[m[1]] = { rx: f[0], tx: f[8] }; rx += f[0]; tx += f[8];
  }
  return { rx, tx, ifaces };
}
// hottest sensor of a hwmon driver family (nvme drives, the r8169 NIC): first temp*_input of every matching chip
function hwmonMax(match) {
  let best = null;
  try {
    for (const h of fs.readdirSync('/sys/class/hwmon')) {
      const name = readText(`/sys/class/hwmon/${h}/name`)?.trim() || ''; if (!match.test(name)) continue;
      const v = +readText(`/sys/class/hwmon/${h}/temp1_input`) / 1000; if (v > 0 && (best === null || v > best)) best = v;
    }
  } catch {}
  return best;
}
function cpuTemp() {
  try {
    for (const h of fs.readdirSync('/sys/class/hwmon')) {
      const name = readText(`/sys/class/hwmon/${h}/name`)?.trim();
      if (name === 'k10temp' || name === 'coretemp' || name === 'zenpower') {
        const files = fs.readdirSync(`/sys/class/hwmon/${h}`).filter(f => /^temp\d+_input$/.test(f));
        let best = null;
        for (const f of files) { const label = readText(`/sys/class/hwmon/${h}/${f.replace('_input', '_label')}`)?.trim(); const v = +readText(`/sys/class/hwmon/${h}/${f}`) / 1000; if (label === 'Tctl' || label === 'Package id 0' || best === null) best = v; }
        return best;
      }
    }
  } catch {}
  return null;
}
async function gpu() {
  const r = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'], { timeout: 3000 });
  if (!r.ok) return null;
  const [name, util, memUsed, memTotal, temp, power] = r.stdout.trim().split(',').map(s => s.trim());
  return { name, util: +util, memUsed: +memUsed * 1024 * 1024, memTotal: +memTotal * 1024 * 1024, temp: +temp, power: parseFloat(power) || null };
}
async function disks() {
  const r = await run('df', ['-B1', '--output=target,size,used,avail,fstype', '/', '/home', '/var/lib/docker'], { timeout: 3000 });
  const seen = new Set(), out = [];
  for (const l of r.stdout.split('\n').slice(1)) { const f = l.trim().split(/\s+/); if (f.length < 5) continue; const key = f[1] + f[2]; if (seen.has(key)) continue; seen.add(key); out.push({ mount: f[0], size: +f[1], used: +f[2], avail: +f[3], fs: f[4] }); }
  return out;
}

let gpuCache = null, gpuTs = 0, diskCache = null, diskTs = 0;
async function sample() {
  const now = Date.now();
  const c = cpuTimes();
  let cpuPct = 0;
  if (prevCpu) { const dt = c.total - prevCpu.total; cpuPct = dt > 0 ? Math.round((1 - (c.idle - prevCpu.idle) / dt) * 1000) / 10 : 0; }
  prevCpu = c;
  const cores = perCore(); let corePct = [];
  if (prevCores && prevCores.length === cores.length) corePct = cores.map((x, i) => { const dt = x.total - prevCores[i].total; return dt > 0 ? Math.round((1 - (x.idle - prevCores[i].idle) / dt) * 100) : 0; });
  prevCores = cores;
  const m = mem();
  const n = net(); let rxRate = 0, txRate = 0;
  if (prevNet) { const dt = (now - prevNetTs) / 1000; rxRate = Math.max(0, (n.rx - prevNet.rx) / dt); txRate = Math.max(0, (n.tx - prevNet.tx) / dt); }
  prevNet = n; prevNetTs = now;
  if (now - gpuTs > 2500) { gpuCache = await gpu(); gpuTs = now; }
  if (now - diskTs > 30000) { diskCache = await disks(); diskTs = now; }
  const push = (arr, v) => { arr.push(v); if (arr.length > HISTORY) arr.shift(); };
  push(hist.cpu, cpuPct); push(hist.mem, Math.round(m.used / m.total * 1000) / 10); push(hist.gpu, gpuCache ? gpuCache.util : 0); push(hist.net, [Math.round(rxRate), Math.round(txRate)]); push(hist.t, now);
  last = {
    ts: now, cpu: { pct: cpuPct, cores: corePct, count: os.cpus().length, model: os.cpus()[0]?.model, temp: cpuTemp() }, temps: { nvme: hwmonMax(/^nvme/), nic: hwmonMax(/^r8169|^igc|^e1000|^ixgbe/) },
    mem: m, gpu: gpuCache, disks: diskCache, load: os.loadavg(), uptime: os.uptime(), net: { rxRate, txRate, ifaces: n.ifaces }, hostname: os.hostname(),
  };
  return last;
}
function history() { return hist; }
function latest() { return last; }
module.exports = { sample, history, latest };
