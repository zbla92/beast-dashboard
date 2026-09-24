'use strict';
// Heavy processes ("hogs"): what is eating the server right now, in words a human recognises.
//
// Every stats sample reads /proc/<pid>/stat for all processes: CPU time delta -> CPU% (100% = one core, smoothed
// over ~20 s so one busy second doesn't flag anything), RSS -> memory. A process is a hog when it keeps at least one
// core busy or holds a lot of memory. Each one gets a friendly name (Android emulator + AVD, "vite · <project>",
// Gradle daemon, …), the project it runs in (from its cwd), how long it has been heavy, and a tip when there is
// a known fix (e.g. the emulator rendering its GPU in software on the CPU).
const fs = require('fs');
const os = require('os');
const path = require('path');

const TICK = 100;                                   // USER_HZ on Linux
const PAGE = 4096;
const CPU_HOG = 100, CPU_HOT = 400;                 // % of one core
const MEM_HOG = 3 * 2 ** 30, MEM_HOT = 6 * 2 ** 30;
const TAU = 20000;                                  // smoothing time constant (ms)
const MY_UID = process.getuid ? process.getuid() : null;

const seen = new Map();                             // pid -> { t, jif, cpu, hotSince, heavySince, start }
let resolveProject = () => null;                    // cwd -> { id, name } (set by server.js)
function setResolver(fn) { resolveProject = fn; }

function readStat(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const r = s.lastIndexOf(')');
    const comm = s.slice(s.indexOf('(') + 1, r); const f = s.slice(r + 2).split(' ');
    // after ") ": state(0) ppid(1) … utime(11) stime(12) … starttime(19) vsize(20) rss(21)
    return { comm, ppid: +f[1], jif: +f[11] + +f[12], start: +f[19], rss: +f[21] * PAGE };
  } catch { return null; }
}
const bootTime = (() => { try { const m = fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m); return m ? +m[1] * 1000 : Date.now() - os.uptime() * 1000; } catch { return Date.now() - os.uptime() * 1000; } })();
function cmdline(pid) { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; } }
function cwdOf(pid) { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }
function uidOf(pid) { try { return fs.statSync(`/proc/${pid}`).uid; } catch { return null; } }
function container(pid) { try { const c = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'); const m = c.match(/docker[-/]([0-9a-f]{12})/); return m ? m[1] : null; } catch { return null; } }

// A name you recognise + a tip when there's an obvious fix.
function describe(pid, comm, argv, cwd) {
  const cmd = argv.join(' '); const base = path.basename(argv[0] || comm);
  const proj = cwd ? resolveProject(cwd) : null; const pn = proj ? ' · ' + proj.name : '';
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (/^qemu-system/.test(base) || /emulator\/qemu/.test(cmd)) {
    const avd = arg('-avd'); const soft = /swiftshader/.test(cmd);
    return { name: 'Android emulator' + (avd ? ' · ' + avd : ''), kind: 'emulator', icon: '📱',
      tip: soft ? 'Renders its GPU in software on the CPU (swiftshader). Start it with -gpu host to use the real GPU instead.' : null };
  }
  if (base === 'node' || base === 'bun' || base === 'deno') {
    const tool = (cmd.match(/\b(vite|next|expo|metro|react-native|webpack|tsc|jest|vitest|playwright|storybook|nest|nodemon|turbo|eslint|tsserver)\b/) || [])[1];
    if (tool === 'tsserver') return { name: 'TypeScript server' + pn, kind: 'node', icon: '🟦', project: proj };
    return { name: (tool || 'node') + pn, kind: 'node', icon: '🟩', project: proj, tip: tool === 'jest' || tool === 'vitest' ? 'A test run — it ends by itself.' : null };
  }
  if (base === 'java' && /gradle/i.test(cmd)) return { name: 'Gradle daemon' + pn, kind: 'java', icon: '🐘', project: proj, tip: 'Idle Gradle daemons keep their memory: ./gradlew --stop frees it.' };
  if (base === 'java' && /kotlin-daemon|KotlinCompileDaemon/.test(cmd)) return { name: 'Kotlin daemon' + pn, kind: 'java', icon: '🟪', project: proj };
  if (base === 'java') return { name: 'Java' + pn, kind: 'java', icon: '☕', project: proj };
  if (/^python/.test(base)) { const script = argv.slice(1).find(a => !a.startsWith('-')); return { name: 'python ' + (script ? path.basename(script) : '') + pn, kind: 'python', icon: '🐍', project: proj }; }
  if (/chrome|chromium/.test(base)) return { name: 'Chrome' + (/--headless/.test(cmd) ? ' (headless)' : ''), kind: 'browser', icon: '🌐' };
  if (/firefox/.test(base)) return { name: 'Firefox', kind: 'browser', icon: '🦊' };
  if (base === 'claude' || /claude-code|@anthropic-ai\/claude/.test(cmd)) return { name: 'Claude Code' + pn, kind: 'claude', icon: '✦', project: proj };
  if (/^(cc1|cc1plus|rustc|go|clang|ld|gcc|g\+\+|cargo)$/.test(base)) return { name: base + ' (compiling)' + pn, kind: 'build', icon: '🔨', project: proj };
  if (base === 'dockerd' || base === 'containerd') return { name: base, kind: 'docker', icon: '🐳' };
  return { name: comm + pn, kind: 'other', icon: '⚙', project: proj };
}

// One pass over /proc. Returns the hogs, heaviest first.
function sample(now = Date.now()) {
  const pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
  const alive = new Set(); const hogs = [];
  for (const p of pids) {
    const pid = +p; const st = readStat(pid); if (!st) continue; alive.add(pid);
    let s = seen.get(pid);
    if (!s || s.start !== st.start) { s = { t: now, jif: st.jif, cpu: 0, start: st.start, heavySince: null, hotSince: null }; seen.set(pid, s); continue; }
    const dt = now - s.t; if (dt < 500) continue;
    const inst = ((st.jif - s.jif) / TICK) / (dt / 1000) * 100;       // % of one core over this interval
    const a = 1 - Math.exp(-dt / TAU); s.cpu = s.cpu + a * (inst - s.cpu);
    s.t = now; s.jif = st.jif;
    const heavy = s.cpu >= CPU_HOG || st.rss >= MEM_HOG; const hot = s.cpu >= CPU_HOT || st.rss >= MEM_HOT;
    s.heavySince = heavy ? (s.heavySince || now) : null; s.hotSince = hot ? (s.hotSince || now) : null;
    if (!heavy) continue;
    const argv = cmdline(pid); const cwd = cwdOf(pid); const d = describe(pid, st.comm, argv, cwd);
    hogs.push({ pid, comm: st.comm, cmd: argv.join(' ').slice(0, 400), cwd, cpu: Math.round(s.cpu), rss: st.rss,
      level: hot ? 'hot' : 'warn', heavyFor: now - s.heavySince, hotFor: s.hotSince ? now - s.hotSince : 0,
      runningFor: now - (bootTime + st.start / TICK * 1000), mine: uidOf(pid) === MY_UID, container: container(pid),
      ...d, project: d.project ? { id: d.project.id, name: d.project.name } : null });
  }
  for (const pid of seen.keys()) if (!alive.has(pid)) seen.delete(pid);
  hogs.sort((a, b) => (b.level === 'hot') - (a.level === 'hot') || b.cpu - a.cpu || b.rss - a.rss);
  return hogs.slice(0, 8);
}

// Stop / kill one of the hogs — only processes of this user, and only ones currently listed as a hog.
function kill(pid, sig, current) {
  pid = +pid; if (!pid || pid < 2) return { ok: false, error: 'bad pid' };
  const h = (current || []).find(x => x.pid === pid); if (!h) return { ok: false, error: 'not a listed heavy process (refresh)' };
  if (!h.mine) return { ok: false, error: 'not your process (root / system)' };
  try { process.kill(pid, sig === 'KILL' ? 'SIGKILL' : 'SIGTERM'); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { sample, kill, setResolver };
