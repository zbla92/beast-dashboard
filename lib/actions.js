'use strict';
// Actions: run commands in tmux sessions (logged), stop/kill, docker, git.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const { run, sleep, shq, tdir, STATE } = require('./util');
const rt = require('./runtime');
const git = require('./gitinfo');

const LOGS = path.join(STATE, 'logs'), CMDS = path.join(STATE, 'cmds'), EXIT = path.join(STATE, 'exit');
const safe = s => String(s).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
function sessionName(projectId, label) { return `bd_${projectId}__${safe(label)}`; }
function logFile(name) { return path.join(LOGS, name + '.log'); }

async function sessionExists(name) { return (await run('tmux', ['has-session', '-t', '=' + name])).ok; }

async function start(project, label, cmd) {
  const name = sessionName(project.id, label);
  if (await sessionExists(name)) return { ok: false, error: `Session ${name} already running`, name };
  const script = path.join(CMDS, name + '.sh');
  fs.writeFileSync(script, `#!/usr/bin/env bash\nsleep 0.2\ncd ${shq(project.path)} || exit 1\nprintf '\\033[2m[beast-dash] %s  %s  $ %s\\033[0m\\n' "$(date '+%H:%M:%S')" ${shq(project.rel)} ${shq(cmd)}\n${cmd}\n`, { mode: 0o755 });
  const lf = logFile(name); try { fs.unlinkSync(lf); } catch {} try { fs.unlinkSync(path.join(EXIT, name)); } catch {}
  // interactive bash (-i) inside a tmux pty: loads ~/.bashrc (nvm, dev-env) exactly like a manual terminal, but without echoing a prompt
  const inner = `bash ${shq(script)}; echo $? > ${shq(path.join(EXIT, name))}`;
  const r = await run('tmux', ['new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-c', tdir(project.path), `bash -ic ${shq(inner)}`]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || 'tmux failed', name };
  rt.setLabel(name, null);   // a fresh session starts without an earlier one's name
  await run('tmux', ['pipe-pane', '-t', name, '-o', `cat >> ${shq(lf)}`]);
  const runs = rt.loadRuns();
  runs[name] = { project: project.id, name: label, cmd, startedAt: Date.now(), endedAt: null, exitCode: null };
  rt.saveRuns(runs);
  return { ok: true, name };
}

async function stop(name, force = false) {
  if (!(await sessionExists(name))) return { ok: true, note: 'not running' };
  const chat = (await run('tmux', ['list-panes', '-t', '=' + name, '-F', '#{pane_pid} #{pane_start_command}'])).stdout.split('\n').find(l => l.includes('headless-runner.js'));
  if (!force && chat) {
    const pid = chat.split(' ')[0];
    if (/^\d+$/.test(pid)) await run('kill', ['-TERM', pid]);
    for (let i = 0; i < 20; i++) { await sleep(400); if (!(await sessionExists(name))) return { ok: true }; }
  } else if (!force) {
    await run('tmux', ['send-keys', '-t', name, 'C-c', '']);
    for (let i = 0; i < 12; i++) { await sleep(400); if (!(await sessionExists(name))) return { ok: true }; if (i === 4) await run('tmux', ['send-keys', '-t', name, 'C-c', '']); }
  }
  // Kill the whole pane process tree, then the session
  const panes = await run('tmux', ['list-panes', '-t', name, '-F', '#{pane_pid}']);
  for (const pid of panes.stdout.split('\n').filter(Boolean)) await run('pkill', ['-KILL', '-P', pid]).catch(() => {});
  await run('tmux', ['kill-session', '-t', '=' + name]);
  return { ok: true, forced: true };
}

async function restart(name) {
  const runs = rt.loadRuns(); const rec = runs[name];
  if (!rec) return { ok: false, error: 'unknown session' };
  await stop(name);
  return { rec };
}

async function kill(pid, force = false) {
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { return { ok: false, error: e.message }; }
  await sleep(600);
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  return { ok: true, alive };
}

const SAFE_CONTAINER = /^[A-Za-z0-9][\w.-]*$/;
async function docker(id, action) {
  const allowed = ['start', 'stop', 'restart', 'rm', 'pause', 'unpause'];
  if (!allowed.includes(action)) return { ok: false, error: 'bad action' };
  if (!SAFE_CONTAINER.test(String(id))) return { ok: false, error: 'bad container id' };
  const args = action === 'rm' ? ['rm', '-f', id] : [action, id];
  const r = await run('docker', args, { timeout: 60000 });
  return { ok: r.ok, out: (r.stdout + r.stderr).trim() };
}

async function gitAction(project, action, branch) {
  switch (action) {
    case 'checkout': return git.checkout(project.path, branch);
    case 'fetch': return git.simple(project.path, ['fetch', '--all', '--prune'], 120000);
    case 'pull': return git.simple(project.path, ['pull', '--rebase', '--autostash'], 180000);
    case 'stash': return git.simple(project.path, ['stash', 'push', '-u', '-m', 'beast-dash']);
    case 'stash-pop': return git.simple(project.path, ['stash', 'pop']);
    case 'discard': return git.simple(project.path, ['checkout', '--', '.']);
    case 'stage-all': return git.stageAll(project.path);
    case 'unstage-all': return git.unstageAll(project.path);
    case 'commit': return git.commitMsg(project.path, branch);   // `branch` carries the message for this action
    case 'push': return git.push(project.path);
    case 'revert-file': return git.revertFile(project.path, branch);   // `branch` carries the path
    default: return { ok: false, out: 'bad action' };
  }
}

function readLog(name, maxBytes = 200 * 1024) {
  const f = logFile(name);
  try { const st = fs.statSync(f); const fd = fs.openSync(f, 'r'); const len = Math.min(st.size, maxBytes); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd); return { text: buf.toString('utf8'), size: st.size }; }
  catch { return { text: '', size: 0 }; }
}

const paneCmd = async name => (await run('tmux', ['display-message', '-p', '-t', '=' + name + ':', '#{pane_current_command}'])).stdout.trim();
async function exitClaude(name) {
  if (await paneCmd(name) !== 'claude') return true;
  await run('tmux', ['send-keys', '-t', '=' + name + ':', 'Escape']); await sleep(200);
  await run('tmux', ['send-keys', '-t', '=' + name + ':', '-l', '/exit']); await sleep(150); await run('tmux', ['send-keys', '-t', '=' + name + ':', 'Enter']);
  for (let i = 0; i < 40; i++) { await sleep(250); if (await paneCmd(name) !== 'claude') break; }
  if (await paneCmd(name) === 'claude') { await run('tmux', ['send-keys', '-t', '=' + name + ':', 'C-c']); await sleep(300); await run('tmux', ['send-keys', '-t', '=' + name + ':', 'C-c']); for (let i = 0; i < 20; i++) { await sleep(250); if (await paneCmd(name) !== 'claude') break; } }
  return await paneCmd(name) !== 'claude';
}
const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish']);
async function paneInfo(name) {
  const r = await run('tmux', ['display-message', '-p', '-t', '=' + name + ':', '#{session_windows} #{window_panes} #{pane_pid} #{pane_current_command}']);
  const [windows, panes, pid, cmd] = r.stdout.trim().split(' ');
  if (!r.ok || !/^\d+$/.test(pid || '')) return null;
  let root = ''; try { root = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch {}
  return { windows: +windows, panes: +panes, cmd, root, shell: SHELLS.has(root) };
}
// Restart Claude inside its tmux session (picks up an installed update) and resume the same conversation.
// A second request for the same session while one runs joins it: two at once typed "/exit/exit" as one prompt.
const restarting = new Map();
function restartClaude(name, rec, bin) {
  if (!restarting.has(name)) restarting.set(name, doRestartClaude(name, rec, bin).finally(() => restarting.delete(name)));
  return restarting.get(name);
}
async function doRestartClaude(name, rec, bin) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || !(await sessionExists(name))) return { ok: false, error: 'no such session' };
  if (rec?.mode !== 'chat') return { ok: false, error: 'only chat sessions can be restarted — start a new chat instead' };
  return require('./headless').restartChat(name, rec, bin);
}
// Bring back a session whose tmux session is gone (reboot): same name, same dir, `--resume <id>` (or --continue).
async function restoreClaude(rec) {
  if (!rec || !rec.cwd || !/^[A-Za-z0-9_.-]+$/.test(rec.tmux || '')) return { ok: false, error: 'bad record' };
  if (!fs.existsSync(rec.cwd)) return { ok: false, error: `directory gone: ${rec.cwd}` };
  if (await sessionExists(rec.tmux)) return { ok: true, name: rec.tmux, existed: true };
  const headless = require('./headless'); const claude = require('./claude');
  const sid = claude.conversationOf(rec);
  if (rec.mode === 'chat' && rec.forkFrom && sid === rec.sessionId) return headless.launch(rec.tmux, rec.cwd, rec.account, { sessionId: rec.sessionId, transcriptPath: rec.transcriptPath, start: 'fork', forkFrom: rec.forkFrom });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sid || '')) { claude.forget(rec.tmux); return { ok: false, error: 'no conversation id to resume' }; }
  const live = Object.values(claude.all()).find(x => !x.gone && x.sessionId === sid && x.tmux !== rec.tmux);
  if (live) { claude.forgetGone(sid, live.tmux); return { ok: true, name: live.tmux, existed: true }; }
  const tr = headless.locateTranscript(rec.cwd, headless.recordAccount(rec), sid);
  if (!tr && rec.mode !== 'chat') return { ok: false, error: 'the conversation file was not found in this folder or any parent folder' };
  const r = await headless.launch(rec.tmux, tr ? tr.dir : rec.cwd, tr ? tr.account : rec.account, { start: 'resume', sessionId: sid, transcriptPath: tr ? tr.file : rec.transcriptPath });
  if (r.ok && !r.existed) claude.forgetGone(sid, rec.tmux);
  return r;
}

// "+ shell": a plain login bash in devRoot, but INSIDE tmux (sh-1, sh-2, …) so it survives a dashboard reload / closed
// iframe exactly like the Claude sessions do. Reusing a free number keeps the names short.
async function shellSession() {
  const devRoot = settings.get().devRoot;
  for (let i = 1; i < 100; i++) {
    const name = `sh-${i}`;
    if (await sessionExists(name)) continue;
    const r = await run('tmux', ['new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-c', tdir(devRoot)]);
    if (!r.ok) return { ok: false, error: r.stderr.trim() || 'tmux failed', name };
    rt.setLabel(name, null);
    return { ok: true, name };
  }
  return { ok: false, error: 'too many shells' };
}

module.exports = { SAFE_CONTAINER, shellSession, restoreClaude, restartClaude, exitClaude, paneInfo, paneCmd, start, stop, restart, kill, docker, gitAction, readLog, logFile, sessionName, sessionExists };
