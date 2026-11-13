'use strict';
// Where the two Claude Code logins keep their config.
//   personal  ~/.claude
//   company   ~/.claude-company, or the folder in BD_COMPANY_DIR when the second login lives elsewhere
//             (started with CLAUDE_CONFIG_DIR=~/.claude-work, say). Claude Code ties a login to its config path, so
//             renaming that folder would mean signing in again; naming it here doesn't.
// The dashboard, the chat runner, bd-chat and the hook installer all ask here, so they agree.
const os = require('os');
const path = require('path');

const homeOf = env => env.HOME || os.homedir();
function expand(p, env) { return p === '~' ? homeOf(env) : p.startsWith('~/') ? path.join(homeOf(env), p.slice(2)) : path.resolve(p); }

function companyDir(env = process.env) {
  return env.BD_COMPANY_DIR ? expand(env.BD_COMPANY_DIR, env) : path.join(homeOf(env), '.claude-company');
}
function configDir(account, env = process.env) {
  return account === 'company' ? companyDir(env) : path.join(homeOf(env), '.claude');
}
// The login a CLAUDE_CONFIG_DIR belongs to. Only these two logins carry the dashboard's hooks, so any folder other
// than the default ~/.claude is the second one, whatever it is called.
function accountOf(configDirValue) {
  const d = String(configDirValue || '').replace(/\/+$/, '');
  return !d || path.basename(d) === '.claude' ? 'personal' : 'company';
}

module.exports = { companyDir, configDir, accountOf };
