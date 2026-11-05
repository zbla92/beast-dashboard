const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson, wasCorrupt } = require('../lib/util');

test('a corrupt state file is moved aside, reported, and not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-json-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"port": 87');
  assert.deepStrictEqual(readJson(file, { def: true }, true), { def: true });
  assert.ok(wasCorrupt(file));
  const kept = fs.readdirSync(dir).find(f => f.startsWith('settings.json.corrupt-'));
  assert.strictEqual(fs.readFileSync(path.join(dir, kept), 'utf8'), '{"port": 87');
  fs.rmSync(dir, { recursive: true });
});

test('a corrupt file outside state/ is left where it is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-json-'));
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(file, '<<<<<<< HEAD');
  assert.strictEqual(readJson(file, null), null);
  assert.deepStrictEqual(fs.readdirSync(dir), ['package.json']);
  assert.ok(!wasCorrupt(file));
  fs.rmSync(dir, { recursive: true });
});

test('a corrupt file from an earlier run still counts as corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-json-'));
  const file = path.join(dir, 'push.json');
  fs.writeFileSync(file + '.corrupt-1700000000000', '{');
  assert.ok(wasCorrupt(file));
  fs.rmSync(dir, { recursive: true });
});

test('a missing file is just the fallback; writeJson round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-json-'));
  const file = path.join(dir, 'x.json');
  assert.strictEqual(readJson(file, 7), 7);
  assert.ok(!wasCorrupt(file));
  writeJson(file, { a: 'č' });
  assert.deepStrictEqual(readJson(file, null), { a: 'č' });
  assert.deepStrictEqual(fs.readdirSync(dir), ['x.json']);
  fs.rmSync(dir, { recursive: true });
});
