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
const GUARD_MATCHER = 'Bash|Grep|Glob';
const isGuard = h => h && h.type === 'command' && typeof h.command === 'string' && h.command.replace(/"/g, '').endsWith('/bin/pasted-guard.sh');

const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);

function hooksProblem(s) {
  if (!isPlain(s)) return 'not a JSON object';
  if (s.hooks === undefined) return null;
  if (!isPlain(s.hooks)) return 'hooks is not an object';
  for (const ev of Object.keys(EVENTS)) {
    const groups = s.hooks[ev];
    if (groups !== undefined && !(Array.isArray(groups) && groups.every(g => isPlain(g) && (g.hooks === undefined || Array.isArray(g.hooks))))) return `hooks.${ev} has an unexpected shape`;
  }
  return null;
}

function stripFrom(groups, pred) {
  return (groups || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !pred(h)) })).filter(g => g.hooks.length);
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch { return null; }
}

function linkBin(binDir, name, planBin, wanted, log) {
  const link = path.join(binDir, name);
  const st = lstatOrNull(link);
  const target = st && st.isSymbolicLink() ? fs.readlinkSync(link) : null;
  const movedRepo = target !== null && target !== planBin && target.endsWith(`/bin/${name}`) && !fs.existsSync(link);
  if (!wanted) {
    if (target === planBin || movedRepo) { fs.unlinkSync(link); log(`removed ${link}`); }
    else if (st) log(`kept ${link}: not our symlink`);
    return;
  }
  if (target === planBin) return;
  if (st && !movedRepo) {
    log(`warning: ${link} already exists and is not our symlink, left alone`);
    return;
  }
  if (movedRepo) fs.unlinkSync(link);
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(planBin, link);
  log(`linked ${link} -> ${planBin}`);
  const onPath = (process.env.PATH || '').split(path.delimiter).includes(binDir);
  if (!onPath) log(`hint: add ${binDir} to PATH so agents can run \`${name}\``);
}

function readSettings(f) {
  if (!fs.existsSync(f)) return { settings: {}, text: null };
  try {
    const text = fs.readFileSync(f, 'utf8');
    return { settings: JSON.parse(text), text };
  } catch (e) { return { error: e.message }; }
}

function writeFileAtomic(f, text) {
  const st = lstatOrNull(f);
  const target = st ? fs.realpathSync(f) : f;
  const mode = st ? fs.statSync(target).mode & 0o777 : 0o644;
  if (!(mode & 0o200)) throw new Error('the file is read-only');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function accountDirs(home) {
  const dirs = [path.join(home, '.claude')];
  if (fs.existsSync(path.join(home, '.claude-company'))) dirs.push(path.join(home, '.claude-company'));
  return dirs;
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
  const chatBin = path.join(root, 'bin', 'bd-chat');
  const askBin = path.join(root, 'bin', 'bd-ask');
  const planCmd = /\s/.test(planBin) ? `"${planBin}" context` : `${planBin} context`;
  const guard = !remove && opts.pastedGuard !== false;
  const guardBin = path.join(root, 'bin', 'pasted-guard.sh');
  const guardCmd = /\s/.test(guardBin) ? `"${guardBin}"` : guardBin;
  const files = accountDirs(home).map(d => path.join(d, 'settings.json'));
  for (const f of files) {
    const loaded = readSettings(f);
    if (loaded.error) { log(`skip ${f}: ${loaded.error}`); continue; }
    const s = loaded.settings;
    const problem = hooksProblem(s);
    if (problem) { log(`skip ${f}: ${problem}`); continue; }
    s.hooks = s.hooks || {};
    if (!planOnly) {
      for (const [ev, extra] of Object.entries(EVENTS)) {
        const groups = stripFrom(s.hooks[ev], isOurs);
        if (!remove) groups.push({ hooks: [{ type: 'command', command: script, ...extra }] });
        if (groups.length) s.hooks[ev] = groups; else delete s.hooks[ev];
      }
      const pre = stripFrom(s.hooks.PreToolUse, isGuard);
      if (guard) pre.push({ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: guardCmd, timeout: 5 }] });
      if (pre.length) s.hooks.PreToolUse = pre; else delete s.hooks.PreToolUse;
    }
    const start = stripFrom(s.hooks.SessionStart, isPlanHook);
    if (plans) start.push({ hooks: [{ type: 'command', command: planCmd, timeout: 5 }] });
    if (start.length) s.hooks.SessionStart = start; else delete s.hooks.SessionStart;
    if (!Object.keys(s.hooks).length) delete s.hooks;
    const text = JSON.stringify(s, null, 2) + '\n';
    if (text === loaded.text) { log(`unchanged ${f}`); continue; }
    if (loaded.text === null && !Object.keys(s).length) continue;
    try {
      writeFileAtomic(f, text);
      log(`${remove ? 'removed from' : 'installed in'} ${f}`);
    } catch (e) {
      log(`warning: could not write ${f}: ${e.message}`);
    }
  }
  const binDir = opts.binDir || path.join(home, '.local', 'bin');
  try { linkBin(binDir, 'plan', planBin, plans, log); } catch (e) { log(`warning: could not update the plan command link: ${e.message}`); }
  if (!planOnly) try { linkBin(binDir, 'bd-chat', chatBin, !remove, log); } catch (e) { log(`warning: could not update the bd-chat command link: ${e.message}`); }
  if (!planOnly) try { linkBin(binDir, 'bd-ask', askBin, !remove, log); } catch (e) { log(`warning: could not update the bd-ask command link: ${e.message}`); }
}

function syncPlans(before, after, opts = {}) {
  if (!!before === !!after) return false;
  run({ ...opts, plans: !!after, planOnly: true });
  return true;
}

module.exports = { run, syncPlans, accountDirs, writeFileAtomic };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const settings = require('../lib/settings');
  const plans = argv.includes('--plans') ? true : argv.includes('--no-plans') ? false : !!settings.get().plans;
  if (argv.includes('--no-pasted-guard')) settings.update({ pastedGuard: false });
  if (argv.includes('--pasted-guard')) settings.update({ pastedGuard: true });
  run({ remove: argv.includes('--remove'), plans, pastedGuard: settings.get().pastedGuard });
}
