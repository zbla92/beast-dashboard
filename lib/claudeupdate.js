'use strict';
const path = require('path');
const { HOME, readJson, run } = require('./util');

const RELEASES = 'https://downloads.claude.ai/claude-code-releases/';
const VER = /^\d+\.\d+\.\d+$/;
const FIRST_CHECK = 60e3, CHECK_EVERY = 3600e3, AUTO_RETRY = 6 * 3600e3, FETCH_TIMEOUT = 10e3, INSTALL_TIMEOUT = 5 * 60e3;
const ERROR_MAX = 300;

const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  const i = [0, 1, 2].find(n => x[n] !== y[n]);
  return i !== undefined && x[i] > y[i];
};

const fetchChannel = async channel => {
  const res = await fetch(RELEASES + channel, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  return res.ok ? res.text() : null;
};

const runClaudeUpdate = () => run('claude', ['update'], { timeout: INSTALL_TIMEOUT, cwd: HOME });

const failure = r => String(r.stderr || r.stdout || r.message || '').trim().split('\n').slice(-3).join('\n').slice(0, ERROR_MAX);

function create(opts) {
  const { current, autoOn, onInstalled = () => {}, onChange = () => {}, now = Date.now, env = process.env } = opts;
  const fetchText = opts.fetchText || fetchChannel;
  const runUpdate = opts.runUpdate || runClaudeUpdate;
  const settingsFile = opts.settingsFile || path.join(HOME, '.claude', 'settings.json');
  const state = { latest: null, error: null, triedAt: 0, running: null, timers: [] };

  const userSettings = () => readJson(settingsFile, {}) || {};
  const flag = (name, s) => !!(env[name] || s.env?.[name]);
  const channel = s => s.autoUpdatesChannel === 'stable' ? 'stable' : 'latest';

  function status() {
    const cur = current();
    if (!state.latest || !cur) return null;
    if (state.running) return { version: state.latest, via: 'native', installing: true, error: null };
    return newer(state.latest, cur) ? { version: state.latest, via: 'native', installing: false, error: state.error } : null;
  }

  async function runInstall() {
    state.triedAt = now(); state.error = null;
    const r = await runUpdate().catch(e => ({ ok: false, message: e.message }));
    await onInstalled();
    const cur = current();
    if (r.ok && cur && !newer(state.latest, cur)) return { ok: true, installed: cur };
    state.error = failure(r) || `Still on ${cur || 'an unknown version'} after the update ran`;
    return { ok: false, error: state.error };
  }

  function install() {
    if (state.running) return state.running;
    state.running = runInstall().finally(() => { state.running = null; onChange(); });
    onChange();
    return state.running;
  }

  async function check() {
    if (!current() || state.running) return;
    const s = userSettings();
    if (flag('DISABLE_UPDATES', s)) { state.latest = null; return; }
    const text = await fetchText(channel(s)).catch(() => null);
    const v = String(text || '').trim();
    if (!VER.test(v)) return;
    if (v !== state.latest) { state.latest = v; state.error = null; state.triedAt = 0; onChange(); }
    if (status() && autoOn() && !flag('DISABLE_AUTOUPDATER', s) && now() - state.triedAt >= AUTO_RETRY) await install();
  }

  function start() {
    const tick = () => { check().catch(e => console.error('claude update check', e)); };
    state.timers.push(setTimeout(tick, FIRST_CHECK), setInterval(tick, CHECK_EVERY));
    state.timers.forEach(t => t.unref());
  }

  function stop() {
    state.timers.forEach(clearTimeout);
    state.timers.length = 0;
  }

  return { status, check, install, start, stop };
}

module.exports = { create, newer };
