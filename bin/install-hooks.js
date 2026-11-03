#!/usr/bin/env node
'use strict';
// Adds the Beast Dash hook to Claude Code's settings, idempotently. Re-run any time.
//   node bin/install-hooks.js            # install / update
//   node bin/install-hooks.js --remove   # take it out again
// Two accounts are supported: ~/.claude (the default) and ~/.claude-company (a second Claude Code login started
// with CLAUDE_CONFIG_DIR=~/.claude-company). The second one is only touched if that folder already exists.
const fs = require('fs');
const path = require('path');
// SessionEnd is synchronous (an async hook is killed at teardown) with a short timeout; everything else is async.
const EVENTS = { SessionStart: { async: true }, UserPromptSubmit: { async: true }, PreToolUse: { async: true }, PermissionRequest: { async: true }, Notification: { async: true }, Stop: { async: true }, StopFailure: { async: true }, SessionEnd: { timeout: 3 } };
const isOurs = h => h && h.type === 'command' && typeof h.command === 'string' && h.command.includes('claude-hook.sh');
const isPlanHook = h => h && h.type === 'command' && typeof h.command === 'string' && h.command.replace(/"/g, '').endsWith('/bin/plan context');

function stripFrom(groups, pred) {
  return (groups || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !pred(h)) })).filter(g => g.hooks.length);
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch { return null; }
}

function linkPlan(binDir, planBin, wanted, log) {
  const link = path.join(binDir, 'plan');
  const st = lstatOrNull(link);
  if (!wanted) {
    if (st && st.isSymbolicLink() && fs.readlinkSync(link) === planBin) { fs.unlinkSync(link); log(`removed ${link}`); }
    else if (st) log(`kept ${link}: not our symlink`);
    return;
  }
  if (st) {
    if (st.isSymbolicLink() && fs.readlinkSync(link) === planBin) return;
    log(`warning: ${link} already exists and is not our symlink, left alone`);
    return;
  }
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(planBin, link);
  log(`linked ${link} -> ${planBin}`);
  const onPath = (process.env.PATH || '').split(path.delimiter).includes(binDir);
  if (!onPath) log(`hint: add ${binDir} to PATH so agents can run \`plan\``);
}

function readSettings(f) {
  if (!fs.existsSync(f)) return { settings: {}, text: null };
  try {
    const text = fs.readFileSync(f, 'utf8');
    return { settings: JSON.parse(text), text };
  } catch (e) { return { error: e.message }; }
}

function writeSettings(f, text) {
  const st = lstatOrNull(f);
  const target = st ? fs.realpathSync(f) : f;
  const mode = st ? fs.statSync(target).mode & 0o777 : 0o644;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function run(opts = {}) {
  const home = opts.home || process.env.HOME;
  const root = opts.root || path.join(__dirname, '..');
  const log = opts.log || (m => console.log(m));
  const remove = !!opts.remove;
  const plans = !remove && !!opts.plans;
  const planOnly = !!opts.planOnly;
  const script = path.join(root, 'bin', 'claude-hook.sh');
  const planBin = path.join(root, 'bin', 'plan');
  const planCmd = /\s/.test(planBin) ? `"${planBin}" context` : `${planBin} context`;
  const files = [path.join(home, '.claude', 'settings.json')];
  if (fs.existsSync(path.join(home, '.claude-company'))) files.push(path.join(home, '.claude-company', 'settings.json'));
  for (const f of files) {
    const loaded = readSettings(f);
    if (loaded.error) { log(`skip ${f}: ${loaded.error}`); continue; }
    const s = loaded.settings;
    s.hooks = s.hooks || {};
    if (!planOnly) {
      for (const [ev, extra] of Object.entries(EVENTS)) {
        const groups = stripFrom(s.hooks[ev], isOurs);
        if (!remove) groups.push({ hooks: [{ type: 'command', command: script, ...extra }] });
        if (groups.length) s.hooks[ev] = groups; else delete s.hooks[ev];
      }
    }
    const start = stripFrom(s.hooks.SessionStart, isPlanHook);
    if (plans) start.push({ hooks: [{ type: 'command', command: planCmd, timeout: 5 }] });
    if (start.length) s.hooks.SessionStart = start; else delete s.hooks.SessionStart;
    if (!Object.keys(s.hooks).length) delete s.hooks;
    const text = JSON.stringify(s, null, 2) + '\n';
    if (text === loaded.text) { log(`unchanged ${f}`); continue; }
    if (loaded.text === null && !Object.keys(s).length) continue;
    try {
      writeSettings(f, text);
      log(`${remove ? 'removed from' : 'installed in'} ${f}`);
    } catch (e) {
      log(`warning: could not write ${f}: ${e.message}`);
    }
  }
  try { linkPlan(opts.binDir || path.join(home, '.local', 'bin'), planBin, plans, log); } catch (e) { log(`warning: could not update the plan command link: ${e.message}`); }
}

function syncPlans(before, after, opts = {}) {
  if (!!before === !!after) return false;
  run({ ...opts, plans: !!after, planOnly: true });
  return true;
}

module.exports = { run, syncPlans };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const plans = argv.includes('--plans') ? true : argv.includes('--no-plans') ? false : !!require('../lib/settings').get().plans;
  run({ remove: argv.includes('--remove'), plans });
}
