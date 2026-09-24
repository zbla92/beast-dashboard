'use strict';
const path = require('path');
const { readJson, writeJson, STATE, HOME } = require('./util');

const FILE = path.join(STATE, 'settings.json');
const DEFAULTS = {
  devRoot: path.join(HOME, 'dev'),
  port: 8787,
  publicHost: '',            // '' => auto (tailscale IPv4). Can be set to the MagicDNS name of the server.
  sshHost: '',               // ssh host alias on the client machine, used for vscode://vscode-remote/ssh-remote+<sshHost>/path
  sshUser: '',               // optional login name — makes the vscode link ssh-remote+user@host
  // Display names of the two Claude Code logins: 'personal' = ~/.claude, 'company' = ~/.claude-company (CLAUDE_CONFIG_DIR).
  // The ids are fixed (they name the folders); only what you see on the cards is yours to change.
  accountLabels: { personal: 'Personal', company: 'Company' },
  pushContact: 'mailto:admin@example.com',   // VAPID contact (RFC 8292) sent to push services; any reachable mailto:/https: of yours
  allowedPrefixes: [],       // extra client IP prefixes allowed besides localhost + tailnet, e.g. ['10.8.0.'] for a WireGuard net
  autoExpose: true,          // auto socat-forward loopback-bound project ports onto tailscale IP
  scanDepth: 4,
  gitRefreshSec: 20,
  serverName: '',            // shown in system push titles ("<name> CPU 92 °C"); '' => the hostname
  voiceLangs: [],            // languages the mic switches between, e.g. ['sr', 'en'] (first = default); [] => Whisper detects
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
