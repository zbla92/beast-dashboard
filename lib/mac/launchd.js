'use strict';
// launchd control for the on-demand Whisper agent: the `systemctl --user start/stop/show` calls it replaces on macOS.
// state() answers in systemd's words ({ ActiveState, SubState }) so lib/whisper.js keeps one state machine.
const path = require('path');

const domain = () => `gui/${process.getuid()}`;
const plistOf = (home, label) => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);

function parsePrint(text) {
  const state = (text.match(/^\s*state = (.+)$/m) || [])[1];
  const exit = (text.match(/^\s*last exit code = (.+)$/m) || [])[1];
  if (state === 'running') return { ActiveState: 'active', SubState: 'running' };
  if (exit && exit !== '0' && !/never exited/.test(exit)) return { ActiveState: 'failed', SubState: 'failed' };
  return { ActiveState: 'inactive', SubState: 'dead' };
}

async function state(run, label) {
  const r = await run('launchctl', ['print', `${domain()}/${label}`], { timeout: 5000 });
  return r.ok ? parsePrint(r.stdout) : {};
}
// kickstart needs the agent loaded; after a reboot without the installer it may not be, so load it first then
async function start(run, home, label) {
  const r = await run('launchctl', ['kickstart', `${domain()}/${label}`], { timeout: 10000 });
  if (r.ok) return r;
  await run('launchctl', ['bootstrap', domain(), plistOf(home, label)], { timeout: 10000 });
  return run('launchctl', ['kickstart', `${domain()}/${label}`], { timeout: 10000 });
}
function stop(run, label) { return run('launchctl', ['kill', 'SIGTERM', `${domain()}/${label}`], { timeout: 10000 }); }

module.exports = { plistOf, parsePrint, state, start, stop };
