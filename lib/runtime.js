'use strict';
// Runtime snapshot: processes, listening ports, tmux sessions, docker containers — attributed to projects.
const fs = require('fs');
const path = require('path');
const { run, readJson, writeJson, readText, inside, STATE } = require('./util');
const settings = require('./settings');

const RUNS_FILE = path.join(STATE, 'runs.json');
const PAGE = 4096;
const HZ = 100;
// /proc/<pid>/stat start time is in clock ticks since boot; boot time from /proc/stat makes it a real timestamp
let BOOT_MS = 0; { const m = (readText('/proc/stat') || '').match(/^btime (\d+)/m); BOOT_MS = m ? +m[1] * 1000 : Date.now() - os_uptime_ms(); }
function os_uptime_ms() { try { return Math.round(parseFloat(readText('/proc/uptime')) * 1000); } catch { return 0; } }
const startOf = pr => pr && pr.start != null ? BOOT_MS + Math.round(pr.start / HZ * 1000) : null;
let prevProcCpu = new Map(); let prevTs = 0;

function readProcs() {
  const procs = new Map();
  let pids;
  try { pids = fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)); } catch { return procs; }
  for (const pid of pids) {
    const stat = readText(`/proc/${pid}/stat`); if (!stat) continue;
    const close = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const f = stat.slice(close + 2).split(' ');
    procs.set(+pid, { pid: +pid, comm, ppid: +f[1], cpuTicks: +f[11] + +f[12], rss: +f[21] * PAGE, start: +f[19] });
  }
  return procs;
}
function cmdline(pid) { const c = readText(`/proc/${pid}/cmdline`); return c ? c.split('\0').filter(Boolean).join(' ') : ''; }
const TOOLS = 'vite|next|tsx|ts-node|nodemon|nest|expo|webpack|turbo|storybook|uvicorn|gunicorn|celery|flask|pnpm|yarn|npm|bun|deno|java|dotnet|gradle|cargo|go';
const TOOL_RE = new RegExp('(?:node_modules/(?:\\.bin/)?|/bin/|^|\\s)(' + TOOLS + ')(?=[/\\s]|$)');
function labelFromCmd(cmd, comm) {
  const tool = cmd.match(TOOL_RE)?.[1];
  const scripts = [...cmd.matchAll(/(?:^|\s)((?!--)[^\s]+\.(?:[cm]?[jt]sx?|py))(?=\s|$)/g)].map(m => m[1]).filter(x => !/node_modules|preflight|loader/.test(x));
  const script = scripts.length ? scripts[scripts.length - 1].split('/').pop() : null;
  if (tool && script) return `${tool} ${script}`;
  if (tool) return tool;
  if (script) return script;
  return comm === 'MainThread' ? 'node' : comm;
}
function cwd(pid) { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }
function childrenMap(procs) { const m = new Map(); for (const p of procs.values()) { if (!m.has(p.ppid)) m.set(p.ppid, []); m.get(p.ppid).push(p.pid); } return m; }
function subtree(root, ch) { const out = [root]; const stack = [root]; while (stack.length) { const x = stack.pop(); for (const c of ch.get(x) || []) { out.push(c); stack.push(c); } } return out; }

async function listeningPorts() {
  const r = await run('ss', ['-tlnpH'], { timeout: 4000 });
  const ports = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const f = line.trim().split(/\s+/);
    const local = f[3]; if (!local) continue;
    const i = local.lastIndexOf(':');
    let addr = local.slice(0, i).replace(/^\[|\]$/g, ''); const port = +local.slice(i + 1);
    if (addr.includes('%')) addr = addr.split('%')[0];
    const users = [...line.matchAll(/\("([^"]+)",pid=(\d+)/g)].map(m => ({ proc: m[1], pid: +m[2] }));
    ports.push({ addr, port, pid: users[0]?.pid || null, proc: users[0]?.proc || null, loopback: addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.'), wildcard: addr === '*' || addr === '0.0.0.0' || addr === '::' });
  }
  return ports;
}

async function tmuxSessions() {
  const r = await run('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{session_created}\t#{pane_current_path}\t#{pane_current_command}\t#{session_attached}\t#{window_activity}'], { timeout: 3000 });
  if (!r.ok) return [];
  const map = new Map();
  for (const l of r.stdout.split('\n')) {
    if (!l) continue; const [name, pid, created, cwdp, cmd, attached, activity] = l.split('\t');
    if (!map.has(name)) map.set(name, { name, panes: [], created: +created * 1000, cwd: cwdp, cmd, attached: attached !== '0', activity: +activity * 1000 || null });
    map.get(name).panes.push(+pid);
  }
  return [...map.values()];
}

async function dockerContainers() {
  const r = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], { timeout: 8000 });
  if (!r.ok) return { containers: [], error: (r.stderr || 'docker unavailable').trim().split('\n')[0] };
  const out = [];
  for (const l of r.stdout.split('\n')) {
    if (!l.trim()) continue; let j; try { j = JSON.parse(l); } catch { continue; }
    const labels = {}; for (const kv of (j.Labels || '').split(',')) { const i = kv.indexOf('='); if (i > 0) labels[kv.slice(0, i)] = kv.slice(i + 1); }
    const ports = [];
    for (const p of (j.Ports || '').split(',').map(s => s.trim()).filter(Boolean)) {
      const m = p.match(/^(?:([\d.:a-f\[\]]+):)?(\d+)(?:-\d+)?->(\d+)(?:-\d+)?\/(tcp|udp)$/);
      if (m) ports.push({ hostIp: (m[1] || '0.0.0.0').replace(/^\[|\]$/g, ''), host: +m[2], container: +m[3], proto: m[4] });
      else { const m2 = p.match(/^(\d+)\/(tcp|udp)$/); if (m2) ports.push({ hostIp: null, host: null, container: +m2[1], proto: m2[2] }); }
    }
    out.push({ id: j.ID.slice(0, 12), name: j.Names, image: j.Image, state: j.State, status: j.Status, ports, created: j.CreatedAt, compose: labels['com.docker.compose.project'] || null, service: labels['com.docker.compose.service'] || null, composeDir: labels['com.docker.compose.project.working_dir'] || null, composeFiles: labels['com.docker.compose.project.config_files'] || null });
  }
  return { containers: out, error: null };
}

function loadRuns() { return readJson(RUNS_FILE, {}); }
function saveRuns(r) { writeJson(RUNS_FILE, r); }

function attributeTo(projects, p) {
  if (!p) return null; let best = null;
  for (const pr of projects) if (inside(p, pr.path) && (!best || pr.path.length > best.path.length)) best = pr;
  return best ? best.id : null;
}

async function snapshot(projects) {
  const s = settings.get();
  const now = Date.now();
  const procs = readProcs();
  const ch = childrenMap(procs);
  const [ports, tmux, docker] = await Promise.all([listeningPorts(), tmuxSessions(), dockerContainers()]);

  // CPU% per pid since last snapshot
  const dt = prevTs ? (now - prevTs) / 1000 : 0;
  const cpuOf = pid => { const p = procs.get(pid); if (!p || !dt) return 0; const prev = prevProcCpu.get(pid); return prev == null ? 0 : Math.max(0, (p.cpuTicks - prev) / HZ / dt * 100); };
  const treeStats = pids => { let cpu = 0, mem = 0; for (const pid of pids) { cpu += cpuOf(pid); mem += procs.get(pid)?.rss || 0; } return { cpu: Math.round(cpu * 10) / 10, mem }; };

  // Map pid -> tmux session (via pane subtree)
  const pidSession = new Map(); const sessionPids = new Map();
  for (const t of tmux) { const all = []; for (const pane of t.panes) for (const pid of subtree(pane, ch)) { pidSession.set(pid, t.name); all.push(pid); } sessionPids.set(t.name, all); }

  const ownPid = process.pid; const ownTree = new Set(subtree(ownPid, ch));
  const runs = loadRuns(); let runsDirty = false;
  const sessions = [];
  for (const t of tmux) {
    const pids = sessionPids.get(t.name) || [];
    const myPorts = ports.filter(p => p.pid && pids.includes(p.pid));
    const rec = runs[t.name];
    const projectId = rec?.project || attributeTo(projects, t.cwd);
    const managed = t.name.startsWith('bd_');
    // the foreground command: deepest interesting process
    const leafs = pids.filter(pid => !(ch.get(pid) || []).length).map(pid => procs.get(pid)).filter(Boolean);
    const main = leafs.find(p => p.comm !== 'bash' && p.comm !== 'sleep') || leafs[0];
    // the Claude Code binary actually running (native installer keeps versions/<x.y.z>): the truth for "needs restart"
    let claudeVersion = null; const cp = pids.map(pid => procs.get(pid)).find(p => p && p.comm === 'claude');
    if (cp) { try { const m = fs.readlinkSync(`/proc/${cp.pid}/exe`).match(/versions\/(\d+\.\d+\.\d+)/); if (m) claudeVersion = m[1]; } catch {} }
    sessions.push({ name: t.name, managed, project: projectId, cwd: t.cwd, created: t.created, attached: t.attached, activity: t.activity, ports: myPorts.map(p => ({ addr: p.addr, port: p.port, loopback: p.loopback, ephemeral: p.loopback && p.port >= 32768 })), ...treeStats(pids), pids: pids.length, claudeVersion, cmd: rec?.cmd || null, label: rec?.name || (t.name.startsWith('bd_') ? t.name.split('__')[1] : t.name), current: main ? labelFromCmd(cmdline(main.pid), main.comm) : t.cmd, startedAt: rec?.startedAt || t.created, exitCode: null, running: true });
  }
  // Runs whose session vanished -> mark ended
  for (const [name, rec] of Object.entries(runs)) {
    if (!rec.endedAt && !tmux.find(t => t.name === name)) {
      const ec = readText(path.join(STATE, 'exit', name)); rec.endedAt = now; rec.exitCode = ec != null ? +ec.trim() : null; runsDirty = true;
    }
  }
  if (runsDirty) saveRuns(runs);
  const recent = Object.entries(runs).filter(([, r]) => r.endedAt).sort((a, b) => b[1].endedAt - a[1].endedAt).slice(0, 40).map(([name, r]) => ({ name, ...r, running: false }));

  // External listening processes (not in tmux, not us, not docker-proxy): attribute by cwd (self, then parents)
  const seen = new Set(); const external = [];
  for (const p of ports) {
    if (!p.pid || pidSession.has(p.pid) || ownTree.has(p.pid) || seen.has(p.pid)) continue;
    const pr = procs.get(p.pid); if (!pr) continue;
    if (pr.comm === 'docker-proxy' || pr.comm === 'sshd' || pr.comm === 'systemd-resolve' || pr.comm === 'cupsd' || pr.comm === 'tailscaled' || pr.comm === 'socat') continue;
    let cur = p.pid, projectId = null, wd = null, hops = 0;
    while (cur > 1 && hops < 4 && !projectId) { wd = cwd(cur); projectId = attributeTo(projects, wd); cur = procs.get(cur)?.ppid || 0; hops++; }
    if (!projectId) continue;
    seen.add(p.pid);
    const tree = subtree(p.pid, ch);
    const myPorts = ports.filter(x => x.pid === p.pid).map(x => ({ addr: x.addr, port: x.port, loopback: x.loopback, ephemeral: x.loopback && x.port >= 32768 }));
    if (myPorts.every(x => x.ephemeral) && /query-engine|inspect|language-server|tsserver/.test(pr.comm + cmdline(p.pid))) continue;
    const fullCmd = cmdline(p.pid);
    // where its output goes: a systemd user unit (journal), a pty (tmux pane) or a plain file — the Logs tab can follow all three
    let unit = null, tty = null, outFile = null;
    try { const cg = fs.readFileSync(`/proc/${p.pid}/cgroup`, 'utf8'); const mu = cg.match(/\/([^/\n]+\.service)\s*$/m); if (mu && !/^(user@|session-|beast-)/.test(mu[1])) unit = mu[1]; } catch {}
    try { const o = fs.readlinkSync(`/proc/${p.pid}/fd/1`); if (o.startsWith('/dev/pts/')) tty = o; else if (o.startsWith('/') && !o.startsWith('/dev/')) outFile = o; } catch {}
    external.push({ pid: p.pid, comm: pr.comm, label: labelFromCmd(fullCmd, pr.comm), unit, tty, outFile, cmd: fullCmd.replace(/\/home\/[^/]+\//g, '~/').replace(/\/home\/[^/]+\/\.nvm\/versions\/node\/[^/]+\/bin\//g, '').slice(0, 160), project: projectId, cwd: cwd(p.pid), ports: myPorts, ...treeStats(tree), startedAt: startOf(pr) });
  }

  // Docker attribution
  const containers = docker.containers.map(c => ({ ...c, project: attributeTo(projects, c.composeDir) }));

  // Other listening ports (unattributed, informational)
  const attributedPids = new Set([...pidSession.keys(), ...external.map(e => e.pid)]);
  const containerPorts = new Set(containers.flatMap(c => c.ports.map(p => p.host)));
  const otherPorts = ports.filter(p => !attributedPids.has(p.pid) && !ownTree.has(p.pid) && p.proc !== 'socat' && !/^code/.test(p.proc || '') && !(p.addr === '127.0.0.53' || p.addr === '127.0.0.54') && ![22, 631].includes(p.port) && !containerPorts.has(p.port) && !(p.loopback && p.port >= 32768) && !(p.addr.startsWith('100.') || p.addr.startsWith('fd7a')) ).map(p => ({ addr: p.addr, port: p.port, proc: p.proc, pid: p.pid, loopback: p.loopback }));

  // socat exposures
  const exposures = [];
  for (const p of procs.values()) if (p.comm === 'socat') { const c = cmdline(p.pid); const m = c.match(/TCP4?-LISTEN:(\d+),bind=([\d.]+)/); const t = c.match(/TCP[46]?:\[?([\d.:a-f]+)\]?:(\d+)/); if (m) exposures.push({ pid: p.pid, port: +m[1], bind: m[2], target: t ? `${t[1]}:${t[2]}` : null, alive: true }); }

  prevProcCpu = new Map([...procs.values()].map(p => [p.pid, p.cpuTicks])); prevTs = now;
  return { ts: now, sessions, recent, external, containers, dockerError: docker.error, otherPorts, exposures, ports };
}

module.exports = { snapshot, loadRuns, saveRuns, tmuxSessions };
