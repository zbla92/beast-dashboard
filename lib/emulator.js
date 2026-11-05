'use strict';
// Android emulator / adb devices. Starts headless on the real GPU (-gpu host); software rendering burns a CPU core.
// SDK: $ANDROID_HOME / $ANDROID_SDK_ROOT, else ~/Android/Sdk. EMULATOR_LAUNCHER=<script>: your own start script (called with the AVD name).
// Absolute SDK paths (the systemd service's PATH has no SDK), args arrays only (no shell strings), short timeouts.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { run, spawnDetached, exists, HOME } = require('./util');

const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(HOME, 'Android', 'Sdk');
const ADB = path.join(SDK, 'platform-tools', 'adb');
const EMULATOR = path.join(SDK, 'emulator', 'emulator');
const EMU_SH = process.env.EMULATOR_LAUNCHER || '';
const KEYS = new Set(['BACK', 'HOME', 'APP_SWITCH', 'ENTER', 'DEL', 'TAB', 'VOLUME_UP', 'VOLUME_DOWN', 'POWER']);
const SERIAL_RE = /^[\w.:-]+$/;
const AVD_RE = /^[\w.-]+$/;

let cache = null, cacheAt = 0, inflight = null;
let avdCache = { at: 0, list: [] };   // `emulator -list-avds` is slow and AVDs rarely change: 60 s
const cpuPrev = new Map();            // pid -> { t, ticks }
const starting = new Map();           // avd -> start ms (a started emulator needs a while to show up in adb)
const sizes = new Map();              // serial -> { w, hgt, at }

const adb = (args, timeout = 3000) => run(ADB, args, { timeout });

function parseDevices(out) {
  const devs = [];
  for (const line of out.split('\n').slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\S+)(.*)$/); if (!m) continue;
    const model = (m[3].match(/model:(\S+)/) || [])[1] || null;
    devs.push({ serial: m[1], state: m[2], kind: m[1].startsWith('emulator-') ? 'emulator' : 'usb', avd: null, model, booted: false, w: null, hgt: null });
  }
  return devs;
}

// `wm size` is always the portrait/natural size. The display rotation (0/90/180/270) comes from `dumpsys input`
// ("Orientation: Rotation90"; verified on this emulator). w/hgt returned here (and in /api/emu) are the CURRENT-orientation
// size: swapped when rotated 90/270, so they match what screencap returns and what input tap/swipe coordinates use.
async function wmSize(serial) {
  const [r, o] = await Promise.all([
    adb(['-s', serial, 'shell', 'wm', 'size']),
    adb(['-s', serial, 'shell', "dumpsys input | grep -m1 'Orientation: Rotation'"]),
  ]);
  const ov = r.stdout.match(/Override size:\s*(\d+)x(\d+)/) || r.stdout.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!ov) return { w: null, hgt: null };
  const rot = +((o.stdout.match(/Rotation(\d+)/) || [])[1] || 0);
  return rot === 90 || rot === 270 ? { w: +ov[2], hgt: +ov[1] } : { w: +ov[1], hgt: +ov[2] };
}

function procs() {
  return run('ps', ['-eo', 'pid=,args='], { timeout: 3000 }).then(r => {
    const out = [];
    for (const line of r.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/); if (!m) continue;
      const cmd = m[2];
      if (!/(^|\/)qemu-system[\w-]*\s/.test(cmd) || !/\s-avd\s/.test(cmd)) continue;
      const avd = (cmd.match(/\s-avd\s+(\S+)/) || [])[1] || null;
      const g = (cmd.match(/\s-gpu\s+(\S+)/) || [])[1] || 'auto';
      out.push({ pid: +m[1], avd, gpu: /^(swiftshader|swangle)/.test(g) ? 'software' : g, cpu: cpuOf(+m[1]) });
    }
    return out;
  });
}

// % of one core since the previous call (from /proc/<pid>/stat); the first sample is the lifetime average via /proc uptime.
function cpuOf(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
    const ticks = +f[11] + +f[12], now = Date.now(); const prev = cpuPrev.get(pid); cpuPrev.set(pid, { t: now, ticks });
    const hz = 100;
    if (prev && now - prev.t > 500) return Math.round(Math.max(0, (ticks - prev.ticks) / hz / ((now - prev.t) / 1000)) * 1000) / 10;
    const up = +fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]; const age = up - (+f[19] / hz);
    return age > 0 ? Math.round(ticks / hz / age * 1000) / 10 : 0;
  } catch { return 0; }
}

async function listAvds() {
  if (Date.now() - avdCache.at < 60000) return avdCache.list;
  if (!exists(EMULATOR)) return [];
  const r = await run(EMULATOR, ['-list-avds'], { timeout: 3000 });
  const list = r.stdout.split('\n').map(s => s.trim()).filter(s => AVD_RE.test(s));
  if (r.ok !== false && (list.length || !avdCache.list.length)) avdCache = { at: Date.now(), list };
  return list.length ? list : avdCache.list;
}

async function build() {
  const sdk = exists(ADB);
  if (!sdk) return { sdk: false, avds: [], devices: [], procs: [] };
  const [dv, av, ps] = await Promise.all([
    adb(['devices', '-l']),
    listAvds(),
    procs().catch(() => []),
  ]);
  const avds = av;
  const devices = parseDevices(dv.stdout);
  await Promise.all(devices.map(async d => {
    if (d.state !== 'device') return;
    const [boot, size, name] = await Promise.all([
      adb(['-s', d.serial, 'shell', 'getprop', 'sys.boot_completed']),
      wmSize(d.serial),
      d.kind === 'emulator' ? adb(['-s', d.serial, 'emu', 'avd', 'name']) : Promise.resolve({ stdout: '' }),
    ]);
    d.booted = boot.stdout.trim() === '1'; d.w = size.w; d.hgt = size.hgt;
    if (size.w) sizes.set(d.serial, { w: size.w, hgt: size.hgt, at: Date.now() });
    const n = name.stdout.split('\n')[0].trim(); if (n && n !== 'OK' && AVD_RE.test(n)) d.avd = n;
  }));
  const live = new Set(ps.map(p => p.pid)); for (const k of cpuPrev.keys()) if (!live.has(k)) cpuPrev.delete(k);
  return { sdk: true, avds, devices, procs: ps };
}

async function status(fresh) {
  if (!fresh && cache && Date.now() - cacheAt < 2000) return cache;
  if (inflight) return inflight;
  inflight = build().then(r => { cache = r; cacheAt = Date.now(); return r; }).catch(() => cache || { sdk: false, avds: [], devices: [], procs: [] }).finally(() => { inflight = null; });
  return inflight;
}

async function findDevice(serial) {
  if (!SERIAL_RE.test(String(serial || ''))) return null;
  let st = await status(); let d = st.devices.find(x => x.serial === serial);
  if (!d) { st = await status(true); d = st.devices.find(x => x.serial === serial); }
  return d && d.state === 'device' ? d : null;
}

// ---- screen: one capture in flight per serial, a capture younger than 700 ms is reused
const shots = new Map();   // serial -> { at, png, p }
function capture(serial) {
  return new Promise(resolve => {
    execFile(ADB, ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 6000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
      if (err || !out || out.length < 8 || out.readUInt32BE(0) !== 0x89504e47) return resolve(null);
      resolve(out);
    });
  });
}
async function screen(serial) {
  if (!SERIAL_RE.test(String(serial || ''))) return { error: 'bad serial', status: 400 };
  const s = shots.get(serial);
  if (s && s.p) { const png = await s.p; return png ? { png } : { error: 'capture failed', status: 502 }; }
  if (s && s.png && Date.now() - s.at < 700) return { png: s.png };
  if (!(await findDevice(serial))) return { error: 'device not found', status: 404 };
  const e = { at: 0, png: s && s.png, p: null };
  e.p = capture(serial).then(png => { e.p = null; if (png) { e.png = png; e.at = Date.now(); } else e.png = null; return png; });
  shots.set(serial, e);
  const png = await e.p;
  return png ? { png } : { error: 'capture failed', status: 502 };
}

// ---- start / stop
async function start(avd) {
  if (!AVD_RE.test(String(avd || ''))) return { error: 'bad avd' };
  if (!exists(ADB)) return { error: 'Android SDK not found at ' + SDK };
  const st = await status(true);
  if (!st.avds.includes(avd)) return { error: 'unknown AVD: ' + avd };
  if (st.procs.some(p => p.avd === avd) || st.devices.some(d => d.avd === avd)) return { error: avd + ' is already running (one emulator per AVD)' };
  const t = starting.get(avd); if (t && Date.now() - t < 60000) return { error: avd + ' is already starting' };
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
  if (EMU_SH && exists(EMU_SH)) spawnDetached(EMU_SH, [avd], { env });
  else if (exists(EMULATOR)) spawnDetached(EMULATOR, ['-avd', avd, '-no-window', '-no-audio', '-no-boot-anim', '-gpu', 'host'], { env });
  else return { error: 'emulator binary not found' };
  starting.set(avd, Date.now());
  cacheAt = 0;
  return { ok: true, out: 'starting ' + avd + ' via ' + (EMU_SH && exists(EMU_SH) ? path.basename(EMU_SH) : 'emulator -gpu host') + '; takes about a minute to boot' };
}

async function stop(serial) {
  const d = await findDevice(serial);
  if (!d) return { error: 'device not found' };
  if (d.kind !== 'emulator') return { error: 'only emulators can be stopped here' };
  const r = await adb(['-s', serial, 'emu', 'kill'], 5000);
  cacheAt = 0;
  return r.ok ? { ok: true } : { error: (r.stderr || 'emu kill failed').trim().slice(0, 200) };
}

// ---- input
// `adb shell` joins its args and the DEVICE shell parses them again, so every character that is not plainly safe gets a
// backslash. Spaces become %s (input text's own encoding). Non-ASCII and control characters are rejected (input text can't type them).
function escapeText(t) {
  let out = '';
  for (const c of t) {
    if (c === ' ') out += '%s';
    else if (/^[A-Za-z0-9._,:@\/=+-]$/.test(c)) out += c;
    else if (c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127) out += '\\' + c;
    else return null;
  }
  return out;
}
const int = v => (typeof v === 'number' || (typeof v === 'string' && /^-?\d+$/.test(v))) && Number.isFinite(+v) ? Math.round(+v) : null;

async function input(serial, ev) {
  ev = ev || {};
  const d = await findDevice(serial);
  if (!d) return { error: 'device not found' };
  const kind = String(ev.kind || '');
  let args;
  if (kind === 'key') {
    const key = String(ev.key || ''); if (!KEYS.has(key)) return { error: 'bad key' };
    args = ['keyevent', 'KEYCODE_' + key];
  } else if (kind === 'text') {
    const t = typeof ev.text === 'string' ? ev.text : ''; if (!t || t.length > 500) return { error: 'text must be 1-500 chars' };
    const e = escapeText(t); if (e == null) return { error: 'text has characters the device cannot type (ASCII only)' };
    args = ['text', e];
  } else if (kind === 'tap' || kind === 'swipe') {
    // fresh size every time: the device may have rotated since the last status poll (d.w/hgt can be 2 s old)
    let { w, hgt } = await wmSize(serial);
    if (!w) { const s = sizes.get(serial) || {}; w = s.w || d.w; hgt = s.hgt || d.hgt; }
    if (!w) return { error: 'screen size unknown' };
    const cl = (v, max) => Math.min(max - 1, Math.max(0, v));
    const x = int(ev.x), y = int(ev.y); if (x == null || y == null) return { error: 'x, y must be integers' };
    if (kind === 'tap') args = ['tap', String(cl(x, w)), String(cl(y, hgt))];
    else {
      const x2 = int(ev.x2), y2 = int(ev.y2); if (x2 == null || y2 == null) return { error: 'x2, y2 must be integers' };
      const ms = ev.ms == null ? 300 : int(ev.ms); if (ms == null) return { error: 'ms must be an integer' };
      args = ['swipe', String(cl(x, w)), String(cl(y, hgt)), String(cl(x2, w)), String(cl(y2, hgt)), String(Math.min(5000, Math.max(10, ms)))];
    }
  } else return { error: 'bad kind' };
  const r = await adb(['-s', serial, 'shell', 'input', ...args], 5000);
  return r.ok ? { ok: true } : { error: (r.stderr || 'input failed').trim().slice(0, 200) };
}

module.exports = { status, screen, start, stop, input };
