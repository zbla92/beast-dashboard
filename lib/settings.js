'use strict';
const path = require('path');
const { readJson, writeJson, STATE, HOME } = require('./util');

const FILE = path.join(STATE, 'settings.json');
const DEFAULTS = {
  devRoot: path.join(HOME, 'dev'),
  port: 8787,
  publicHost: '',            // '' => auto (tailscale IPv4). Can set to 'beast' (MagicDNS) etc.
  sshHost: '',               // ssh host alias on the client machine, used for vscode://vscode-remote/ssh-remote+<sshHost>/path
  sshUser: '',               // optional, e.g. your login name — makes vscode link ssh-remote+user@host
  autoExpose: true,          // auto socat-forward loopback-bound project ports onto tailscale IP
  scanDepth: 4,
  gitRefreshSec: 20,
  autoRestore: false,        // bring Claude sessions back on their own when the dashboard starts and their tmux is gone (reboot)
  notify: { done: true, permission: true, error: true, limit: true, crash: true, quietFrom: '', quietTo: '' },   // quietFrom/To 'HH:MM' local; empty = never quiet
  muted: [],                 // tmux session names that never push
  projects: {}               // per-project overrides: { [id]: { hidden, label, commands: [{name, cmd}], pin } }
};

let cache = null;
function get() {
  if (!cache) cache = { ...DEFAULTS, ...readJson(FILE, {}) };
  return cache;
}
function update(patch) {
  const cur = get();
  const next = { ...cur, ...patch };
  if (patch.projects) next.projects = { ...cur.projects, ...patch.projects };
  cache = next;
  writeJson(FILE, next);
  return next;
}
function projectOverride(id) { return (get().projects || {})[id] || {}; }
function setProjectOverride(id, patch) {
  const cur = get();
  const projects = { ...(cur.projects || {}) };
  projects[id] = { ...(projects[id] || {}), ...patch };
  return update({ projects });
}
module.exports = { get, update, projectOverride, setProjectOverride, DEFAULTS };
