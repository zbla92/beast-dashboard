'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWhisper, parseService, isFailing } = require('../lib/whisper');

const REPO = path.join(__dirname, '..');

function sandbox({ unit = true, venv = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  const root = path.join(dir, 'repo'), home = path.join(dir, 'home');
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'whisper'), { recursive: true });
  const unitFile = path.join(unitDir, 'beast-whisper.service');
  if (unit) fs.writeFileSync(unitFile, `[Service]\nExecStart=${path.join(root, 'whisper', 'run.sh')}\n`);
  if (venv) {
    fs.mkdirSync(path.join(root, 'whisper', '.venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'whisper', '.venv', 'bin', 'python'), '#!/bin/sh\n', { mode: 0o755 });
  }
  return { dir, root, home, unitFile };
}

function harness(box, { service = 'ActiveState=active\nSubState=running\n', startOk = true, up = () => false } = {}) {
  const clock = { t: 1000 };
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args[1]);
    if (args[1] === 'start') return { ok: startOk };
    if (args[1] === 'show') return { ok: true, stdout: typeof service === 'function' ? service(clock.t) : service };
    return { ok: true };
  };
  const whisper = createWhisper({ root: box.root, home: box.home, run, health: async () => up(clock.t), now: () => clock.t, sleep: async ms => { clock.t += ms; await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 1)); }, startMemoMs: 0 });
  return { whisper, calls, clock };
}

const FAILED = 'ActiveState=failed\nSubState=failed\n';
const LOOPING = 'ActiveState=activating\nSubState=auto-restart\n';

test('the unit file alone does not count as installed', async () => {
  const { whisper, calls } = harness(sandbox({ venv: false }));
  assert.equal(whisper.installed(), false);
  assert.deepEqual(await whisper.status(true), { ok: false, installed: false });
  const ready = await whisper.ready(false);
  assert.equal(ready.ok, false);
  assert.equal(ready.installed, false);
  assert.deepEqual(calls, []);
});

test('the venv alone does not count as installed', () => {
  assert.equal(harness(sandbox({ unit: false })).whisper.installed(), false);
});

test('a python that is not executable does not count, same as run.sh', () => {
  const box = sandbox();
  fs.chmodSync(path.join(box.root, 'whisper', '.venv', 'bin', 'python'), 0o644);
  assert.equal(harness(box).whisper.installed(), false);
});

test('asleep but installed: plain status starts nothing, warm starts it', async () => {
  const { whisper, calls } = harness(sandbox(), { service: 'ActiveState=inactive\nSubState=dead\n' });
  assert.deepEqual(await whisper.status(false), { ok: true, loaded: false, onDemand: true, starting: false });
  assert.deepEqual(calls, []);
  const warm = await whisper.status(true);
  assert.equal(warm.ok, true);
  assert.equal(calls.includes('start'), true);
});

test('a failed state from an earlier run does not count before a new start', async () => {
  const { whisper, calls } = harness(sandbox(), { service: FAILED });
  const plain = await whisper.status(false);
  assert.equal(plain.ok, true);
  assert.equal(calls.includes('stop'), false);
});

for (const [name, service] of [['failed', FAILED], ['restarting', LOOPING]]) {
  test(`waiting for the service gives up at once when it is ${name}, and stops the unit`, async () => {
    const { whisper, calls, clock } = harness(sandbox(), { service });
    const ready = await whisper.ready(false);
    assert.equal(ready.ok, false);
    assert.equal(ready.failed, true);
    assert.equal(ready.error, 'whisper did not start');
    assert.equal(clock.t, 1000);
    assert.equal(calls.includes('stop'), true);
  });
}

test('a start that systemctl refuses gives up at once', async () => {
  const { whisper, clock } = harness(sandbox(), { startOk: false, service: 'ActiveState=inactive\nSubState=dead\n' });
  assert.equal((await whisper.ready(false)).failed, true);
  assert.equal(clock.t, 1000);
});

test('warm notices the failure, then the mic stays on the browser and nothing restarts', async () => {
  const { whisper, calls, clock } = harness(sandbox(), { service: LOOPING });
  assert.deepEqual(await whisper.status(true), { ok: false, installed: true, failed: true, loaded: false });
  const starts = calls.filter(c => c === 'start').length;
  assert.equal((await whisper.status(true)).failed, true);
  assert.equal((await whisper.status(false)).failed, true);
  assert.equal((await whisper.ready(false)).failed, true);
  assert.equal(calls.filter(c => c === 'start').length, starts);
  clock.t += 5 * 60000;
  assert.equal((await whisper.status(false)).ok, true);
});

test('an explicit retry starts it again and a healthy service clears the failure', async () => {
  const box = sandbox();
  const { whisper, calls, clock } = harness(box, {
    service: () => (calls.filter(c => c === 'start').length < 2 ? FAILED : 'ActiveState=active\nSubState=running\n'),
    up: () => calls.filter(c => c === 'start').length >= 2,
  });
  assert.equal((await whisper.ready(false)).failed, true);
  assert.equal(clock.t, 1000);
  assert.deepEqual(await whisper.ready(true), { ok: true });
  assert.equal(calls.filter(c => c === 'start').length, 2);
  assert.equal((await whisper.status(false)).loaded, true);
});

test('a slow load waits to the deadline and is not stopped', async () => {
  const { whisper, calls, clock } = harness(sandbox());
  const ready = await whisper.ready(false);
  assert.equal(ready.ok, false);
  assert.equal(ready.failed, false);
  assert.equal(clock.t >= 46000, true);
  assert.equal(calls.includes('stop'), false);
});

test('a service that exited after idling is started again while waiting', async () => {
  const { whisper, calls } = harness(sandbox(), {
    service: () => (calls.filter(c => c === 'start').length < 2 ? 'ActiveState=inactive\nSubState=dead\n' : 'ActiveState=active\nSubState=running\n'),
    up: () => calls.filter(c => c === 'start').length >= 2,
  });
  assert.deepEqual(await whisper.ready(false), { ok: true });
});

test('stopOrphan stops only this repo\'s unit, and only without a venv', async () => {
  const orphan = harness(sandbox({ venv: false }));
  assert.equal(await orphan.whisper.stopOrphan(), true);
  assert.deepEqual(orphan.calls, ['stop']);

  const withVenv = harness(sandbox());
  assert.equal(await withVenv.whisper.stopOrphan(), false);
  assert.deepEqual(withVenv.calls, []);

  const noUnit = harness(sandbox({ unit: false, venv: false }));
  assert.equal(await noUnit.whisper.stopOrphan(), false);

  const other = sandbox({ venv: false });
  fs.writeFileSync(other.unitFile, '[Service]\nExecStart=/somewhere/else/whisper/run.sh\n');
  const otherCopy = harness(other);
  assert.equal(await otherCopy.whisper.stopOrphan(), false);
  assert.deepEqual(otherCopy.calls, []);
});

test('parseService reads systemctl show output and keeps = in values', () => {
  assert.deepEqual(parseService('ActiveState=failed\nSubState=a=b\n\n'), { ActiveState: 'failed', SubState: 'a=b' });
  assert.equal(isFailing({ ActiveState: 'active', SubState: 'running' }), false);
  assert.equal(isFailing({ ActiveState: 'inactive', SubState: 'dead' }), false);
  assert.equal(isFailing({}), false);
});

test('the shipped unit never restarts itself', () => {
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, 'beast-whisper.service'), 'utf8'), /^Restart=(?!no)/m);
});

function unitScript(box) {
  fs.mkdirSync(path.join(box.root, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'bin', 'whisper-unit.sh'), path.join(box.root, 'bin', 'whisper-unit.sh'));
  fs.copyFileSync(path.join(REPO, 'beast-whisper.service'), path.join(box.root, 'beast-whisper.service'));
  const fakeBin = path.join(box.dir, 'fakebin'), log = path.join(box.dir, 'systemctl.log');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'systemctl'), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  execFileSync('bash', [path.join(box.root, 'bin', 'whisper-unit.sh')], { env: { ...process.env, HOME: box.home, PATH: `${fakeBin}:${process.env.PATH}` } });
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
}

test('whisper-unit.sh writes the unit only when the venv exists', () => {
  const box = sandbox({ unit: false });
  assert.equal(unitScript(box), '');
  assert.match(fs.readFileSync(box.unitFile, 'utf8'), new RegExp(`ExecStart=${path.join(fs.realpathSync(box.root), 'whisper', 'run.sh')}`));
});

test('whisper-unit.sh does not write a unit without a venv', () => {
  const box = sandbox({ unit: false, venv: false });
  assert.equal(unitScript(box), '');
  assert.equal(fs.existsSync(box.unitFile), false);
});

test('whisper-unit.sh stops and removes this repo\'s stale unit', () => {
  const box = sandbox({ venv: false });
  const log = unitScript(box);
  assert.match(log, /--user stop beast-whisper/);
  assert.equal(fs.existsSync(box.unitFile), false);
});

test('whisper-unit.sh leaves another checkout\'s unit alone', () => {
  const box = sandbox({ venv: false });
  fs.writeFileSync(box.unitFile, '[Service]\nExecStart=/somewhere/else/whisper/run.sh\n');
  assert.equal(unitScript(box), '');
  assert.equal(fs.existsSync(box.unitFile), true);
});
