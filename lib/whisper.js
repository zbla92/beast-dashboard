'use strict';
const fs = require('fs');
const path = require('path');

const UNIT = 'beast-whisper';
const LABEL = 'com.beastdash.whisper';   // macOS: a launchd agent instead of the systemd unit
const launchd = process.platform === 'darwin' ? require('./mac/launchd') : null;
const RETRY_AFTER_MS = 5 * 60000;
const WATCH_AFTER_START_MS = 60000;
const NOT_INSTALLED = 'Whisper is not installed (bin/setup-whisper.sh)';
const DID_NOT_START = 'whisper did not start';

const parseService = text => Object.fromEntries(text.split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const isFailing = service => service.ActiveState === 'failed' || service.SubState === 'auto-restart';

function createWhisper({ root, home, run, health, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = 400, startMemoMs = 5000 }) {
  const unitFile = launchd ? launchd.plistOf(home, LABEL) : path.join(home, '.config', 'systemd', 'user', `${UNIT}.service`);
  const python = path.join(root, 'whisper', '.venv', 'bin', 'python');
  const execStart = launchd ? `<string>${path.join(root, 'whisper', 'run.sh')}</string>` : `ExecStart=${path.join(root, 'whisper', 'run.sh')}`;
  const state = { starting: null, failedAt: 0, watchUntil: 0 };

  const hasVenv = () => { try { fs.accessSync(python, fs.constants.X_OK); return true; } catch { return false; } };
  const installed = () => fs.existsSync(unitFile) && hasVenv();
  const recentlyFailed = () => state.failedAt > 0 && now() - state.failedAt < RETRY_AFTER_MS;
  const stopUnit = () => launchd ? launchd.stop(run, LABEL) : run('systemctl', ['--user', 'stop', UNIT], { timeout: 10000 });
  const readService = async () => { if (launchd) return launchd.state(run, LABEL); const r = await run('systemctl', ['--user', 'show', '-p', 'ActiveState,SubState', UNIT], { timeout: 5000 }); return r.ok ? parseService(r.stdout) : {}; };

  function start() {
    if (state.starting) return state.starting;
    state.watchUntil = now() + WATCH_AFTER_START_MS;
    const starting = (launchd ? launchd.start(run, home, LABEL) : run('systemctl', ['--user', 'start', UNIT], { timeout: 10000 })).finally(() => {
      const timer = setTimeout(() => { if (state.starting === starting) state.starting = null; }, startMemoMs);
      timer.unref?.();
    });
    state.starting = starting;
    return starting;
  }

  async function markFailed() {
    state.failedAt = now();
    state.watchUntil = 0;
    state.starting = null;
    await stopUnit();
  }

  async function startFailed() {
    if (now() >= state.watchUntil) return false;
    const started = await state.starting;
    if ((started && !started.ok) || isFailing(await readService())) { await markFailed(); return true; }
    return false;
  }

  async function ensure(ms = 45000) {
    const deadline = now() + ms;
    const started = await start();
    while (now() < deadline) {
      if (await health()) { state.failedAt = 0; return true; }
      if (!started.ok) { await markFailed(); return false; }
      const service = await readService();
      if (isFailing(service)) { await markFailed(); return false; }
      if (service.ActiveState === 'inactive') start();
      await sleep(pollMs);
    }
    return false;
  }

  async function status(warm) {
    if (!installed()) return { ok: false, installed: false };
    if (await health()) { state.failedAt = 0; return { ok: true, loaded: true, onDemand: true, starting: false }; }
    if (recentlyFailed()) return { ok: false, installed: true, failed: true, loaded: false };
    if (warm) start();
    if (await startFailed()) return { ok: false, installed: true, failed: true, loaded: false };
    return { ok: true, loaded: false, onDemand: true, starting: !!state.starting };
  }

  async function ready(retry) {
    if (!installed()) return { ok: false, installed: false, error: NOT_INSTALLED };
    if (await health()) { state.failedAt = 0; return { ok: true }; }
    if (recentlyFailed() && !retry) return { ok: false, installed: true, failed: true, error: DID_NOT_START };
    if (await ensure()) return { ok: true };
    return { ok: false, installed: true, failed: recentlyFailed(), error: DID_NOT_START };
  }

  async function stopOrphan() {
    if (hasVenv()) return false;
    const unit = fs.existsSync(unitFile) ? fs.readFileSync(unitFile, 'utf8') : '';
    if (!(launchd ? unit.includes(execStart) : unit.split('\n').includes(execStart))) return false;
    await stopUnit();
    return true;
  }

  return { installed, status, ready, stopOrphan };
}

module.exports = { createWhisper, parseService, isFailing };
