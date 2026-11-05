'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { create, newer } = require('../lib/claudeupdate');

const HOUR = 3600e3;

function rig(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-cupd-'));
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(over.settings || {}));
  const box = { cur: over.cur === undefined ? '2.1.317' : over.cur, latest: over.latest || '2.1.318', channels: [], installs: 0, time: 1000 * HOUR, changes: 0 };
  const u = create({
    current: () => box.cur,
    autoOn: () => over.auto !== false,
    fetchText: async c => { box.channels.push(c); if (over.fetchFails) throw new Error('offline'); return box.latest + '\n'; },
    runUpdate: over.runUpdate || (async () => { box.installs++; box.cur = box.latest; return { ok: true, stdout: '' }; }),
    onChange: () => { box.changes++; },
    now: () => box.time,
    env: over.env || {},
    settingsFile,
  });
  return { u, box };
}

test('newer compares numerically, not as text', () => {
  assert.equal(newer('2.1.318', '2.1.317'), true);
  assert.equal(newer('2.1.100', '2.1.99'), true);
  assert.equal(newer('2.1.311', '2.1.317'), false);
  assert.equal(newer('2.1.317', '2.1.317'), false);
  assert.equal(newer('3.0.0', '2.9.9'), true);
});

test('a new release installs by itself and the indicator goes away', async () => {
  const { u, box } = rig();
  await u.check();
  assert.equal(box.installs, 1);
  assert.equal(box.cur, '2.1.318');
  assert.equal(u.status(), null);
});

test('with automatic updates off the release is only offered, and the button installs it', async () => {
  const { u, box } = rig({ auto: false });
  await u.check();
  assert.equal(box.installs, 0);
  assert.deepEqual(u.status(), { version: '2.1.318', via: 'native', installing: false, error: null });
  const r = await u.install();
  assert.deepEqual(r, { ok: true, installed: '2.1.318' });
  assert.equal(u.status(), null);
});

test('a failed install stays visible, retries after 6 hours and the button can retry at once', async () => {
  const seen = { n: 0 };
  const { u, box } = rig({ runUpdate: async () => { seen.n++; return { ok: false, stderr: 'line\nno space left' }; } });
  await u.check();
  assert.equal(seen.n, 1);
  assert.equal(u.status().error, 'line\nno space left');
  box.time += HOUR;
  await u.check();
  assert.equal(seen.n, 1);
  assert.equal(u.status().error, 'line\nno space left');
  const manual = await u.install();
  assert.equal(manual.ok, false);
  assert.equal(seen.n, 2);
  box.time += 6 * HOUR;
  await u.check();
  assert.equal(seen.n, 3);
});

test('an update that exits 0 but leaves the old version counts as failed', async () => {
  const { u } = rig({ runUpdate: async () => ({ ok: true, stdout: '' }) });
  await u.check();
  assert.match(u.status().error, /Still on 2\.1\.317/);
});

test('a thrown install error is reported, not raised', async () => {
  const { u } = rig({ runUpdate: async () => { throw new Error('spawn claude ENOENT'); } });
  await u.check();
  assert.equal(u.status().error, 'spawn claude ENOENT');
});

test('double clicks share one install and the indicator says installing meanwhile', async () => {
  const gate = {};
  const held = new Promise(res => { gate.open = res; });
  const { u, box } = rig({ auto: false, runUpdate: async () => { box.installs++; await held; box.cur = box.latest; return { ok: true }; } });
  await u.check();
  const a = u.install(), b = u.install();
  assert.equal(a, b);
  assert.equal(u.status().installing, true);
  await u.check();
  gate.open();
  await a;
  assert.equal(box.installs, 1);
  assert.equal(u.status(), null);
});

test('an installation not managed by the native installer does nothing', async () => {
  const { u, box } = rig({ cur: null });
  await u.check();
  assert.deepEqual(box.channels, []);
  assert.equal(u.status(), null);
});

test('the channel comes from Claude settings and stable never downgrades', async () => {
  const { u, box } = rig({ settings: { autoUpdatesChannel: 'stable' }, latest: '2.1.311' });
  await u.check();
  assert.deepEqual(box.channels, ['stable']);
  assert.equal(box.installs, 0);
  assert.equal(u.status(), null);
});

test('DISABLE_AUTOUPDATER stops installing but keeps the indicator, from env or settings', async () => {
  const viaEnv = rig({ env: { DISABLE_AUTOUPDATER: '1' } });
  await viaEnv.u.check();
  assert.equal(viaEnv.box.installs, 0);
  assert.equal(viaEnv.u.status().version, '2.1.318');
  const viaSettings = rig({ settings: { env: { DISABLE_AUTOUPDATER: '1' } } });
  await viaSettings.u.check();
  assert.equal(viaSettings.box.installs, 0);
  assert.equal(viaSettings.u.status().version, '2.1.318');
});

test('DISABLE_UPDATES turns the whole thing off', async () => {
  const { u, box } = rig({ env: { DISABLE_UPDATES: '1' } });
  await u.check();
  assert.deepEqual(box.channels, []);
  assert.equal(u.status(), null);
});

test('a failed or garbage answer changes nothing', async () => {
  const off = rig({ fetchFails: true });
  await off.u.check();
  assert.equal(off.u.status(), null);
  const junk = rig({ latest: '<html>' });
  await junk.u.check();
  assert.equal(junk.box.installs, 0);
  assert.equal(junk.u.status(), null);
});

test('a newer release clears the old error and gets its own try', async () => {
  const seen = { n: 0 };
  const { u, box } = rig({ runUpdate: async () => { seen.n++; return { ok: false, stderr: 'boom' }; } });
  await u.check();
  assert.equal(seen.n, 1);
  box.latest = '2.1.319';
  await u.check();
  assert.equal(seen.n, 2);
});
