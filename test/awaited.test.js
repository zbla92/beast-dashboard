const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { awaitedIds, fromToolUse } = require('../lib/awaited');

test('plain call', () => assert.deepStrictEqual(awaitedIds('bd-wait b71gugtcq'), ['b71gugtcq']));
test('several ids, quotes, duplicates', () => assert.deepStrictEqual(awaitedIds("bd-wait 'b1' \"b2\" b1"), ['b1', 'b2']));
test('inside a compound command', () => assert.deepStrictEqual(awaitedIds('cd /tmp && bd-wait b7arm4dxt; echo ok'), ['b7arm4dxt']));
test('path and env prefix', () => assert.deepStrictEqual(awaitedIds('FOO=1 ~/.local/bin/bd-wait bx'), ['bx']));
test('not a command word', () => {
  assert.deepStrictEqual(awaitedIds('echo bd-wait b1'), []);
  assert.deepStrictEqual(awaitedIds('grep -n bd-wait lib/x.js'), []);
  assert.deepStrictEqual(awaitedIds('my-bd-wait b1'), []);
});
test('flags and junk are skipped', () => assert.deepStrictEqual(awaitedIds('bd-wait --help b$1 b2'), ['b2']));
test('non-string', () => { assert.deepStrictEqual(awaitedIds(null), []); assert.deepStrictEqual(awaitedIds(5), []); });
test('fromToolUse reads Bash tool_use only', () => {
  assert.deepStrictEqual(fromToolUse({ type: 'tool_use', name: 'Bash', input: { command: 'bd-wait b1' } }), ['b1']);
  assert.deepStrictEqual(fromToolUse({ type: 'tool_use', name: 'Monitor', input: { command: 'bd-wait b1' } }), []);
  assert.deepStrictEqual(fromToolUse(null), []);
});
test('cli', () => {
  const bin = path.join(__dirname, '..', 'bin', 'bd-wait');
  assert.match(execFileSync(bin, ['b1', 'b2'], { encoding: 'utf8' }), /until b1, b2 end/);
  assert.throws(() => execFileSync(bin, ['b$x'], { stdio: 'pipe' }));
  assert.throws(() => execFileSync(bin, [], { stdio: 'pipe' }));
});
