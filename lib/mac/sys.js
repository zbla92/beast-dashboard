'use strict';
// macOS system stats in the shapes lib/sys.js builds on Linux.
//   CPU      os.cpus() times (what /proc/stat gives on Linux)
//   memory   vm_stat + vm.swapusage, counted like Activity Monitor: used = app + wired + compressed
//   network  netstat -ib, physical interfaces (en*) only, so tunnel traffic isn't counted twice
//   disk     df on the data volume (APFS: / is the sealed system snapshot)
//   GPU      ioreg IOAccelerator (Apple GPU utilization, unified memory in use)
//   battery  ioreg AppleSmartBattery; null on a desktop Mac
// refresh() runs the commands once per stats sample; the readers below are sync and return what it cached.
const os = require('os');
const { exec } = require('./exec');

const BATTERY_EVERY = 10000;
let MEM = null, NET = null, BAT = null, batAt = 0;

function cpuTimes() {
  let idle = 0, total = 0;
  for (const { times: t } of os.cpus()) { idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; }
  return { idle, total };
}
function perCore() { return os.cpus().map(({ times: t }) => ({ idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq })); }

function parseVm(text) {
  const page = +(text.match(/page size of (\d+) bytes/) || [])[1] || 16384, v = {};
  for (const l of text.split('\n')) { const m = l.match(/^"?([^:"]+)"?:\s+(\d+)\.?\s*$/); if (m) v[m[1].trim()] = +m[2] * page; }
  return v;
}
function parseSwap(text) {
  const n = k => { const m = text.match(new RegExp(k + ' = ([\\d.]+)([KMG])')); return m ? +m[1] * { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2]] : 0; };
  return { total: n('total'), used: n('used') };
}
function mem() {
  const total = os.totalmem();
  if (!MEM) { const free = os.freemem(); return { total, available: free, used: total - free, swapTotal: 0, swapUsed: 0, cached: 0 }; }
  const v = MEM.vm, g = k => v[k] || 0;
  const used = Math.min(total, Math.max(0, g('Anonymous pages') - g('Pages purgeable')) + g('Pages wired down') + g('Pages occupied by compressor'));
  return { total, available: total - used, used, swapTotal: MEM.swap.total, swapUsed: MEM.swap.used, cached: g('File-backed pages') + g('Pages purgeable') };
}

// netstat -ib: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll; Address can be empty, so count from the end
function parseNet(text) {
  let rx = 0, tx = 0; const ifaces = {};
  for (const l of text.split('\n').slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 10 || !/^en\d+$/.test(f[0]) || !/^<Link#\d+>$/.test(f[2]) || ifaces[f[0]]) continue;
    const i = +f[f.length - 5], o = +f[f.length - 2];
    ifaces[f[0]] = { rx: i, tx: o }; rx += i; tx += o;
  }
  return { rx, tx, ifaces };
}
function net() { return NET || { rx: 0, tx: 0, ifaces: {} }; }

// ioreg prints negative numbers (a discharging battery's current) as unsigned 64-bit
function ioNum(s) { if (s.length < 16) return +s; const b = BigInt(s); return Number(b >= 2n ** 63n ? b - 2n ** 64n : b); }
function parseIoreg(text) {
  const o = {};
  for (const m of text.matchAll(/^\s*"(\w+)" = (Yes|No|-?\d+)\s*$/gm)) o[m[1]] = m[2] === 'Yes' ? true : m[2] === 'No' ? false : ioNum(m[2]);
  return o;
}
function battery() {
  const b = BAT; if (!b || b.CurrentCapacity == null) return null;
  const pct = Math.min(100, Math.round(b.CurrentCapacity / (b.MaxCapacity || 100) * 100));
  const ac = !!b.ExternalConnected;
  const status = b.IsCharging ? 'Charging' : b.FullyCharged ? 'Full' : ac ? 'Not charging' : 'Discharging';
  const amps = b.InstantAmperage ?? b.Amperage;   // mA, negative while draining; × mV = µW
  const uw = amps != null && b.Voltage ? Math.abs(amps * b.Voltage) : 0;
  const mins = v => v != null && v > 0 && v < 65535 ? v : null;   // 65535 = still estimating
  const full = b.NominalChargeCapacity || b.AppleRawMaxCapacity;
  return {
    name: 'InternalBattery', pct, status, ac, watts: uw ? Math.round(uw / 1e5) / 10 : null,
    minsLeft: status === 'Discharging' ? mins(b.AvgTimeToEmpty ?? b.TimeRemaining) : status === 'Charging' ? mins(b.AvgTimeToFull ?? b.TimeRemaining) : null,
    health: full && b.DesignCapacity ? Math.min(100, Math.round(full / b.DesignCapacity * 100)) : null, cycles: b.CycleCount ?? null,
  };
}

async function gpu() {
  const r = await exec('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], 3000);
  const util = r.stdout.match(/"Device Utilization %"=(\d+)/); if (!util) return null;
  const used = r.stdout.match(/"In use system memory"=(\d+)/), model = r.stdout.match(/"model" = "([^"]+)"/), cores = r.stdout.match(/"gpu-core-count" = (\d+)/);
  return { name: `${model ? model[1] : 'Apple'} GPU${cores ? ` (${cores[1]} cores)` : ''}`, util: +util[1], memUsed: used ? +used[1] : 0, memTotal: os.totalmem(), temp: null, power: null };
}

async function disks() {
  const r = await exec('df', ['-kP', '/System/Volumes/Data'], 3000);
  const f = (r.stdout.trim().split('\n')[1] || '').trim().split(/\s+/); if (f.length < 6) return [];
  const size = +f[1] * 1024, avail = +f[3] * 1024;
  return [{ mount: '/', size, used: size - avail, avail, fs: 'apfs' }];   // container-wide used, like Finder shows
}

async function refresh() {
  const now = Date.now(), withBattery = now - batAt > BATTERY_EVERY;
  const [vm, sw, ns, bat] = await Promise.all([exec('vm_stat'), exec('sysctl', ['-n', 'vm.swapusage']), exec('netstat', ['-ibn']),
    withBattery ? exec('ioreg', ['-r', '-n', 'AppleSmartBattery'], 3000) : null]);
  if (vm.ok) MEM = { vm: parseVm(vm.stdout), swap: parseSwap(sw.stdout) };
  if (ns.ok) NET = parseNet(ns.stdout);
  if (bat) { batAt = now; BAT = bat.ok && bat.stdout.trim() ? parseIoreg(bat.stdout) : null; }
}

module.exports = { refresh, cpuTimes, perCore, mem, net, battery, gpu, disks, parseVm, parseSwap, parseNet, parseIoreg };
