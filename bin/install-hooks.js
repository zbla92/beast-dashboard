#!/usr/bin/env node
'use strict';
// Adds the Beast Dash hook to Claude Code's settings, idempotently. Re-run any time.
//   node bin/install-hooks.js            # install / update
//   node bin/install-hooks.js --remove   # take it out again
// Two accounts are supported: ~/.claude (the default) and ~/.claude-company (a second Claude Code login started
// with CLAUDE_CONFIG_DIR=~/.claude-company). The second one is only touched if that folder already exists.
const fs = require('fs');
const path = require('path');
const HOME = process.env.HOME;
// Resolved from this file, not from ~/beast-dash, so a clone that lives anywhere still registers correctly.
const SCRIPT = path.join(__dirname, 'claude-hook.sh');
const FILES = [path.join(HOME, '.claude', 'settings.json')];
if (fs.existsSync(path.join(HOME, '.claude-company'))) FILES.push(path.join(HOME, '.claude-company', 'settings.json'));
// SessionEnd is synchronous (an async hook is killed at teardown) with a short timeout; everything else is async.
const EVENTS = { SessionStart: { async: true }, UserPromptSubmit: { async: true }, PreToolUse: { async: true }, PermissionRequest: { async: true }, Notification: { async: true }, Stop: { async: true }, StopFailure: { async: true }, SessionEnd: { timeout: 3 } };
const remove = process.argv.includes('--remove');
const isOurs = h => h && h.type === 'command' && typeof h.command === 'string' && h.command.includes('claude-hook.sh');

for (const f of FILES) {
  let s = {}; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (fs.existsSync(f)) { console.error(`skip ${f}: ${e.message}`); continue; } }
  s.hooks = s.hooks || {};
  for (const [ev, extra] of Object.entries(EVENTS)) {
    const groups = (s.hooks[ev] || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
    if (!remove) groups.push({ hooks: [{ type: 'command', command: SCRIPT, ...extra }] });
    if (groups.length) s.hooks[ev] = groups; else delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
  console.log(`${remove ? 'removed from' : 'installed in'} ${f}`);
}
