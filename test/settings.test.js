const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const copy = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-settings-'));
  fs.mkdirSync(path.join(root, 'lib'));
  for (const f of ['util.js', 'settings.js']) fs.copyFileSync(path.join(__dirname, '..', 'lib', f), path.join(root, 'lib', f));
  const file = path.join(root, 'state', 'settings.json');
  const settings = require(path.join(root, 'lib', 'settings.js'));
  const disk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { root, file, settings, disk, done: () => fs.rmSync(root, { recursive: true }) };
};

test('update keeps keys edited by hand in settings.json after startup', () => {
  const t = copy();
  fs.writeFileSync(t.file, JSON.stringify({ port: 9001 }));
  assert.strictEqual(t.settings.get().port, 9001);
  fs.writeFileSync(t.file, JSON.stringify({ port: 9001, deviceCache: false, serverName: 'box' }));
  const next = t.settings.update({ lastDailyDay: '2026-11-03' });
  assert.strictEqual(next.deviceCache, false);
  assert.deepStrictEqual([t.disk().deviceCache, t.disk().serverName, t.disk().lastDailyDay], [false, 'box', '2026-11-03']);
  assert.strictEqual(t.settings.get().deviceCache, false);
  t.settings.update({ muted: ['claude-x'] });
  assert.strictEqual(t.disk().deviceCache, false);
  t.done();
});

test('update merges project overrides with the file on disk', () => {
  const t = copy();
  fs.writeFileSync(t.file, JSON.stringify({ projects: { a: { label: 'A' } } }));
  t.settings.get();
  fs.writeFileSync(t.file, JSON.stringify({ projects: { a: { label: 'A' }, b: { hidden: true } } }));
  t.settings.setProjectOverride('c', { pin: true });
  assert.deepStrictEqual(t.disk().projects, { a: { label: 'A' }, b: { hidden: true }, c: { pin: true } });
  t.done();
});

test('a file that is not a valid object falls back to the copy in memory', () => {
  const t = copy();
  fs.writeFileSync(t.file, JSON.stringify({ port: 9002 }));
  t.settings.get();
  fs.writeFileSync(t.file, '{"port": 90');
  assert.strictEqual(t.settings.update({ serverName: 'x' }).port, 9002);
  assert.deepStrictEqual([t.disk().port, t.disk().serverName], [9002, 'x']);
  fs.writeFileSync(t.file, '[1]');
  assert.strictEqual(t.settings.update({ serverName: 'y' }).port, 9002);
  t.done();
});
