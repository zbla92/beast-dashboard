const test = require('node:test');
const assert = require('node:assert');
const { createWatching, TTL } = require('../lib/watching');

test('a chat counts as watched while its tab keeps reporting, and stops after the TTL', () => {
  const w = createWatching();
  assert.strictEqual(w.watched('claude-chat-1', 0), false);
  w.report('tab-aaaaaa', 'claude-chat-1', 0);
  assert.strictEqual(w.watched('claude-chat-1', 1000), true);
  assert.strictEqual(w.watched('claude-chat-2', 1000), false);
  assert.strictEqual(w.watched('claude-chat-1', TTL + 1), false);
});

test('null clears that tab only; another tab on the same chat still counts', () => {
  const w = createWatching();
  w.report('tab-aaaaaa', 'claude-chat-1', 0);
  w.report('tab-bbbbbb', 'claude-chat-1', 0);
  w.report('tab-aaaaaa', null, 100);
  assert.strictEqual(w.watched('claude-chat-1', 200), true);
  w.report('tab-bbbbbb', null, 300);
  assert.strictEqual(w.watched('claude-chat-1', 400), false);
});

test('a tab that moves to another chat stops watching the first', () => {
  const w = createWatching();
  w.report('tab-aaaaaa', 'claude-chat-1', 0);
  w.report('tab-aaaaaa', 'claude-chat-2', 100);
  assert.strictEqual(w.watched('claude-chat-1', 200), false);
  assert.strictEqual(w.watched('claude-chat-2', 200), true);
});

test('bad ids and session names are refused; the number of tabs is capped', () => {
  const w = createWatching();
  assert.strictEqual(w.report('x', 'claude-chat-1').ok, false);
  assert.strictEqual(w.report({}, 'claude-chat-1').ok, false);
  assert.strictEqual(w.report('tab-aaaaaa', '../etc').ok, false);
  assert.strictEqual(w.report('tab-aaaaaa', 42).ok, false);
  assert.strictEqual(w.report('tab-aaaaaa', 'c'.repeat(65)).ok, false);
  for (let i = 0; i < 100; i++) assert.strictEqual(w.report('tab-' + String(i).padStart(6, '0'), 'claude-chat-1', 0).ok, true);
  assert.strictEqual(w.report('tab-overflow', 'claude-chat-1', 0).ok, false);
  assert.strictEqual(w.report('tab-000001', 'claude-chat-2', 0).ok, true);   // a known tab can still update
  assert.strictEqual(w.report('tab-overflow', 'claude-chat-1', TTL + 1).ok, true);   // old ones expire
});

test('an active tab counts as someone at the dashboard even when it watches no chat, and stops after the TTL', () => {
  const w = createWatching();
  assert.strictEqual(w.active(0), false);
  assert.strictEqual(w.report('tab-aaaaaa', null, 0, true).ok, true);
  assert.strictEqual(w.active(1000), true);
  assert.strictEqual(w.watched('claude-chat-1', 1000), false);
  assert.strictEqual(w.active(TTL + 1), false);
});

test('a tab that is no longer active stops counting; a watching tab without activity is not active', () => {
  const w = createWatching();
  w.report('tab-aaaaaa', 'claude-chat-1', 0, true);
  assert.strictEqual(w.active(100), true);
  w.report('tab-aaaaaa', 'claude-chat-1', 200, false);
  assert.strictEqual(w.active(300), false);
  assert.strictEqual(w.watched('claude-chat-1', 300), true);
  w.report('tab-aaaaaa', null, 400, true);
  assert.strictEqual(w.watched('claude-chat-1', 500), false);
  assert.strictEqual(w.active(500), true);
  w.report('tab-aaaaaa', null, 600, false);
  assert.strictEqual(w.active(700), false);
});
