'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, syncPlans } = require('../bin/install-hooks');

const ROOT = path.join(__dirname, '..');
const PLAN_BIN = path.join(ROOT, 'bin', 'plan');
const PLAN_CMD = `${PLAN_BIN} context`;

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-hooks-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.mkdirSync(path.join(dir, '.claude-company'));
  const other = { hooks: [{ type: 'command', command: '/usr/bin/other-hook' }] };
  const seed = { theme: 'dark', hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/opt/mine.sh' }] }], Stop: [other] } };
  for (const d of ['.claude', '.claude-company']) fs.writeFileSync(path.join(dir, d, 'settings.json'), JSON.stringify(seed));
  return dir;
}
const read = (h, d = '.claude') => JSON.parse(fs.readFileSync(path.join(h, d, 'settings.json'), 'utf8'));
const go = (h, o = {}) => run({ home: h, log: () => {}, ...o });
const planHooks = s => (s.hooks.SessionStart || []).flatMap(g => g.hooks).filter(x => x.command === PLAN_CMD);
const GUARD_BIN = path.join(ROOT, 'bin', 'pasted-guard.sh');
const guardGroups = s => (s.hooks.PreToolUse || []).filter(g => g.hooks.some(x => x.command === GUARD_BIN));
const cmds = (s, ev) => (s.hooks[ev] || []).flatMap(g => g.hooks).map(x => x.command);

test('plans on adds a synchronous plan context hook to both accounts, keeping other hooks', t => {
  const h = home(t);
  go(h, { plans: true });
  for (const d of ['.claude', '.claude-company']) {
    const s = read(h, d);
    const ph = planHooks(s);
    assert.equal(ph.length, 1);
    assert.equal(ph[0].async, undefined);
    assert.ok(ph[0].timeout > 0 && ph[0].timeout <= 5);
    assert.ok(cmds(s, 'SessionStart').includes('/opt/mine.sh'));
    assert.deepEqual(cmds(s, 'Stop').filter(c => c === '/usr/bin/other-hook'), ['/usr/bin/other-hook']);
    assert.ok(cmds(s, 'Stop').some(c => c.endsWith('claude-hook.sh')));
    assert.equal(s.theme, 'dark');
  }
});

test('second run is idempotent', t => {
  const h = home(t);
  go(h, { plans: true });
  const first = fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8');
  go(h, { plans: true });
  assert.equal(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8'), first);
});

test('plans off removes only the plan hook', t => {
  const h = home(t);
  go(h, { plans: true });
  go(h, { plans: false });
  const s = read(h);
  assert.equal(planHooks(s).length, 0);
  assert.ok(cmds(s, 'SessionStart').includes('/opt/mine.sh'));
  assert.ok(cmds(s, 'SessionStart').some(c => c.endsWith('claude-hook.sh')));
  assert.ok(cmds(s, 'Stop').includes('/usr/bin/other-hook'));
});

test('planOnly leaves claude-hook.sh handling alone', t => {
  const h = home(t);
  go(h, { plans: true, planOnly: true });
  const s = read(h);
  assert.equal(planHooks(s).length, 1);
  assert.ok(!cmds(s, 'Stop').some(c => c.endsWith('claude-hook.sh')));
});

test('symlink is created, idempotent and removed again', t => {
  const h = home(t);
  const link = path.join(h, '.local', 'bin', 'plan');
  go(h, { plans: true });
  assert.equal(fs.readlinkSync(link), PLAN_BIN);
  go(h, { plans: true });
  assert.equal(fs.readlinkSync(link), PLAN_BIN);
  go(h, { plans: false });
  assert.throws(() => fs.lstatSync(link));
});

test('symlink never clobbers a foreign file or symlink and is never removed then', t => {
  const h = home(t);
  const bin = path.join(h, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const link = path.join(bin, 'plan');
  const logs = [];
  fs.writeFileSync(link, 'mine');
  go(h, { plans: true, log: m => logs.push(m) });
  assert.equal(fs.readFileSync(link, 'utf8'), 'mine');
  assert.ok(logs.some(m => /warning/.test(m)));
  go(h, { plans: false });
  assert.equal(fs.readFileSync(link, 'utf8'), 'mine');
  fs.rmSync(link);
  fs.symlinkSync('/somewhere/else', link);
  go(h, { plans: true });
  assert.equal(fs.readlinkSync(link), '/somewhere/else');
  go(h, { plans: false });
  assert.equal(fs.readlinkSync(link), '/somewhere/else');
});

test('--remove takes out both our hooks and the symlink, nothing else', t => {
  const h = home(t);
  go(h, { plans: true });
  go(h, { remove: true, plans: true });
  const s = read(h);
  assert.equal(planHooks(s).length, 0);
  for (const ev of Object.keys(s.hooks)) assert.ok(!cmds(s, ev).some(c => c.endsWith('claude-hook.sh')));
  assert.deepEqual(cmds(s, 'SessionStart'), ['/opt/mine.sh']);
  assert.deepEqual(cmds(s, 'Stop'), ['/usr/bin/other-hook']);
  assert.throws(() => fs.lstatSync(path.join(h, '.local', 'bin', 'plan')));
});

test('second account is skipped when its folder is missing', t => {
  const h = home(t);
  fs.rmSync(path.join(h, '.claude-company'), { recursive: true });
  go(h, { plans: true });
  assert.ok(!fs.existsSync(path.join(h, '.claude-company')));
});

const snap = f => { const st = fs.statSync(f); return { text: fs.readFileSync(f, 'utf8'), mtime: st.mtimeMs, ino: st.ino }; };
const settingsFiles = h => ['.claude', '.claude-company'].map(d => path.join(h, d, 'settings.json'));

test('syncPlans does nothing when the plans value did not change', t => {
  const h = home(t);
  const before = settingsFiles(h).map(snap);
  assert.equal(syncPlans(false, false, { home: h, log: () => {} }), false);
  assert.equal(syncPlans(true, true, { home: h, log: () => {} }), false);
  assert.deepEqual(settingsFiles(h).map(snap), before);
  assert.throws(() => fs.lstatSync(path.join(h, '.local', 'bin', 'plan')));
  assert.equal(syncPlans(false, true, { home: h, log: () => {} }), true);
  assert.equal(planHooks(read(h)).length, 1);
  assert.ok(!cmds(read(h), 'Stop').some(c => c.endsWith('claude-hook.sh')));
});

test('unchanged settings are not rewritten', t => {
  const h = home(t);
  go(h, { plans: true });
  const before = settingsFiles(h).map(snap);
  const logs = [];
  go(h, { plans: true, log: m => logs.push(m) });
  assert.deepEqual(settingsFiles(h).map(snap), before);
  assert.ok(logs.some(m => /^unchanged /.test(m)));
});

test('removing the plan hook never creates a missing settings file', t => {
  const h = home(t);
  for (const f of settingsFiles(h)) fs.rmSync(f);
  go(h, { plans: false, planOnly: true });
  go(h, { remove: true });
  for (const f of settingsFiles(h)) assert.ok(!fs.existsSync(f));
  go(h, { plans: true, planOnly: true });
  assert.equal(planHooks(read(h)).length, 1);
});

test('settings are replaced atomically, through a symlinked settings.json, keeping its mode', t => {
  const h = home(t);
  const f = path.join(h, '.claude', 'settings.json');
  const real = path.join(h, 'dotfiles-settings.json');
  fs.renameSync(f, real);
  fs.chmodSync(real, 0o600);
  fs.symlinkSync(real, f);
  go(h, { plans: true, planOnly: true });
  assert.ok(fs.lstatSync(f).isSymbolicLink());
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.equal(planHooks(read(h)).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(h, '.claude')), ['settings.json']);
});

test('the uploads guard is a blocking hook on Bash, Grep and Glob in both accounts', t => {
  const h = home(t);
  go(h);
  for (const d of ['.claude', '.claude-company']) {
    const groups = guardGroups(read(h, d));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].matcher, 'Bash|Grep|Glob');
    assert.equal(groups[0].hooks[0].async, undefined);
    assert.ok(groups[0].hooks[0].timeout > 0);
    assert.ok(cmds(read(h, d), 'PreToolUse').some(c => c.endsWith('claude-hook.sh')));
  }
  fs.accessSync(GUARD_BIN, fs.constants.X_OK);
});

test('the uploads guard is not added twice and moves with the repo', t => {
  const h = home(t);
  const f = path.join(h, '.claude', 'settings.json');
  const s = read(h);
  s.hooks.PreToolUse = [{ matcher: 'Bash|Grep|Glob', hooks: [{ type: 'command', command: '/old/place/bin/pasted-guard.sh', timeout: 5 }] }];
  fs.writeFileSync(f, JSON.stringify(s));
  go(h);
  go(h);
  const after = read(h);
  assert.equal(guardGroups(after).length, 1);
  assert.ok(!cmds(after, 'PreToolUse').includes('/old/place/bin/pasted-guard.sh'));
});

test('pastedGuard false takes the guard out and keeps a hook of the user in the same group', t => {
  const h = home(t);
  const f = path.join(h, '.claude', 'settings.json');
  go(h);
  const s = read(h);
  guardGroups(s)[0].hooks.push({ type: 'command', command: '/opt/my-check.sh' });
  fs.writeFileSync(f, JSON.stringify(s));
  go(h, { pastedGuard: false });
  const after = read(h);
  assert.equal(guardGroups(after).length, 0);
  assert.ok(cmds(after, 'PreToolUse').includes('/opt/my-check.sh'));
  assert.ok(cmds(after, 'PreToolUse').some(c => c.endsWith('claude-hook.sh')));
});

test('--remove takes the guard out, a plans toggle leaves it alone', t => {
  const h = home(t);
  go(h);
  syncPlans(false, true, { home: h, log: () => {} });
  assert.equal(guardGroups(read(h)).length, 1);
  syncPlans(true, false, { home: h, log: () => {} });
  assert.equal(guardGroups(read(h)).length, 1);
  go(h, { remove: true });
  assert.equal(read(h).hooks.PreToolUse, undefined);
});

test('a plans toggle on a fresh account does not install the guard', t => {
  const h = home(t);
  go(h, { plans: true, planOnly: true });
  assert.equal(guardGroups(read(h)).length, 0);
});

for (const [name, content] of [['hooks as a string', '{"hooks":"x"}'], ['an event as an object', '{"hooks":{"PreToolUse":{}}}'], ['a null group', '{"hooks":{"PreToolUse":[null]}}'], ['group hooks as a string', '{"hooks":{"Stop":[{"hooks":"x"}]}}'], ['null', 'null'], ['an array', '[]'], ['hooks as an array', '{"hooks":[]}']]) {
  test(`settings with ${name} are skipped and left as they are, the other login still gets the hooks`, t => {
    const h = home(t);
    fs.mkdirSync(path.join(h, '.claude-company'), { recursive: true });
    const f = path.join(h, '.claude', 'settings.json');
    fs.writeFileSync(f, content);
    const logs = [];
    run({ home: h, log: m => logs.push(m) });
    assert.equal(fs.readFileSync(f, 'utf8'), content);
    assert.ok(logs.some(l => l.startsWith(`skip ${f}`)));
    assert.ok(read(h, '.claude-company').hooks.Stop);
  });
}

test('a plan link left dangling by a moved repo is replaced, a link elsewhere is not', t => {
  const h = home(t);
  const bin = path.join(h, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const link = path.join(bin, 'plan');
  fs.symlinkSync('/gone/beast-dash/bin/plan', link);
  go(h, { plans: true, binDir: bin });
  assert.equal(fs.readlinkSync(link), PLAN_BIN);
  fs.unlinkSync(link);
  fs.symlinkSync('/gone/someone-else/tool', link);
  go(h, { plans: true, binDir: bin });
  assert.equal(fs.readlinkSync(link), '/gone/someone-else/tool');
});

test('turning plans off also removes a dangling plan link of a moved repo', t => {
  const h = home(t);
  const bin = path.join(h, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const link = path.join(bin, 'plan');
  fs.symlinkSync('/gone/beast-dash/bin/plan', link);
  go(h, { plans: false, binDir: bin });
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
});
