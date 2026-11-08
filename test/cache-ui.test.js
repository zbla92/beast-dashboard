'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FEAT = {};
const chips = [];
const sessions = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'f-cache.js'), 'utf8'), { FEAT, claudeOf: n => sessions[n] || null, document: { querySelectorAll: sel => sel.includes('.ccache') ? chips : [] } });
const { view } = FEAT.cache;
const plain = v => JSON.parse(JSON.stringify(v));

test('no cache information shows nothing', () => {
  for (const cl of [null, {}, { cache: null }]) assert.deepStrictEqual(plain(view(cl)), { text: '', cls: 'ccache', title: '', offer: false });
});

test('warm shows minutes and warns near the end', () => {
  assert.strictEqual(view({ cache: { cold: false, min: 38 } }).text, '38m');
  assert.strictEqual(view({ cache: { cold: false, min: 38 } }).cls, 'ccache');
  assert.strictEqual(view({ cache: { cold: false, min: 5 } }).cls, 'ccache ccache-warn');
  assert.strictEqual(view({ cache: { cold: false, min: 38 } }).offer, false);
});

test('the offer appears only on a cold chat with at least 100k of context', () => {
  const cold = (used, mode) => ({ mode, cache: { cold: true }, ctx: { used } });
  assert.strictEqual(view(cold(100000, 'chat')).offer, true);
  assert.strictEqual(view(cold(99999, 'chat')).offer, false);
  assert.strictEqual(view(cold(150000, 'terminal')).offer, false);
  assert.strictEqual(view({ mode: 'chat', cache: { cold: true }, ctx: null }).offer, false);
  assert.strictEqual(view(cold(150000, 'chat')).cls, 'ccache ccache-warn');
  assert.strictEqual(view(cold(150000, 'terminal')).cls, 'ccache ccache-warn');
  assert.strictEqual(view(cold(99999, 'chat')).cls, 'ccache');
});

test('the countdown changes the chip in place and writes only what differs', () => {
  const writes = [];
  const chip = new Proxy({ textContent: '', className: 'ccache', title: '', parentElement: { dataset: { s: 'a' } } }, { set(o, k, v) { writes.push(k); o[k] = v; return true; } });
  chips.push(chip);
  sessions.a = { cache: { cold: false, min: 38 } };
  FEAT.cache.onState();
  assert.strictEqual(chip.textContent, '38m');
  assert.deepStrictEqual(writes.sort(), ['textContent', 'title']);
  writes.length = 0;
  FEAT.cache.onState();
  assert.deepStrictEqual(writes, []);
  sessions.a = { state: 'working', cache: null };
  FEAT.cache.onState();
  assert.strictEqual(chip.textContent, '');
  chips.length = 0;
});
