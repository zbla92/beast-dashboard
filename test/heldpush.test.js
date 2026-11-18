const test = require('node:test');
const assert = require('node:assert');
const { createHeldPush, createStillDue, MAX_AGE, MAX_HELD } = require('../lib/heldpush');

const item = (who, extra = {}) => ({ who, session: 'claude-' + who, kind: 'permission', push: { title: `${who} · needs permission`, url: `/?term=claude-${who}`, tag: 'claude-' + who }, ...extra });
function rig({ allowed, still, clock = { t: 1000 } } = {}) {
  const out = [];
  const h = createHeldPush({ allowed, still, now: () => clock.t, deliver: (payload, items) => out.push({ payload, items: items.map(x => x.who) }) });
  return { h, out, clock };
}

test('a held permission push goes out as the normal push when the user leaves, once', () => {
  const { h, out } = rig();
  h.hold('claude-a', item('a'));
  assert.deepStrictEqual(out, []);
  assert.strictEqual(h.release(), 1);
  assert.deepStrictEqual(out, [{ payload: item('a').push, items: ['a'] }]);
  assert.strictEqual(h.release(), 0);
  assert.strictEqual(out.length, 1);
});

test('a held push is dropped when the session no longer needs you, or is not allowed any more', () => {
  const { h, out } = rig({ allowed: x => x.who !== 'b', still: x => { if (x.who === 'c') throw new Error('gone'); return x.who !== 'a'; } });
  for (const n of ['a', 'b', 'c']) h.hold('claude-' + n, item(n));
  assert.strictEqual(h.release(), 0);
  assert.deepStrictEqual(out, []);
});

test('several missed pushes become one combined push that opens the dashboard, each with its own tag', () => {
  const { h, out, clock } = rig();
  for (const n of ['b', 'c', 'd', 'e']) h.hold('claude-' + n, item(n));
  h.hold('claude-b', item('b'));
  assert.strictEqual(h.release([item('a')]), 5);
  assert.deepStrictEqual(out[0].items, ['a', 'c', 'd', 'e', 'b']);
  assert.deepStrictEqual(out[0].payload, { title: '5 sessions need you', body: 'a · c · d +2', url: '/', tag: 'held-1000' });
  h.hold('claude-x', item('x')); h.hold('claude-y', item('y'));
  clock.t = 2000;
  h.release();
  assert.strictEqual(out[1].payload.tag, 'held-2000');
});

test('two missed pushes from the same session name it once', () => {
  const { h, out } = rig();
  h.hold('task-1', item('a', { kind: 'done' }));
  assert.strictEqual(h.release([item('a', { kind: 'done' })]), 2);
  assert.deepStrictEqual(out[0].payload, { title: 'a · 2 updates', body: 'a', url: '/', tag: 'held-1000' });
});

test('a done push released with nothing else held goes out as itself', () => {
  const { h, out } = rig();
  const done = item('a', { kind: 'done' });
  assert.strictEqual(h.release([done]), 1);
  assert.deepStrictEqual(out[0].payload, done.push);
});

test('held pushes older than the max age are dropped, and only the newest ones are kept', () => {
  const { h, out, clock } = rig();
  h.hold('sched-old', item('old'));
  clock.t += MAX_AGE + 1;
  Array.from({ length: MAX_HELD + 5 }, (x, i) => h.hold('sched-' + i, item('n' + i)));
  assert.strictEqual(h.list().length, MAX_HELD);
  assert.strictEqual(h.list()[0][0], 'sched-5');
  assert.strictEqual(h.release(), MAX_HELD);
  assert.ok(!out[0].items.includes('old'));
});

test('the held list survives a restart: list() saved as JSON loads back with its hold time', () => {
  const a = rig();
  a.h.hold('claude-a', item('a', { check: { type: 'state', session: 'claude-a', state: 'permission', since: 5 } }));
  const saved = JSON.parse(JSON.stringify(a.h.list()));
  const b = rig({ clock: { t: 9000 } });
  b.h.load(saved);
  b.h.load([null, ['x'], [1, item('z')], 'junk']);
  assert.deepStrictEqual(b.h.list(), saved);
  assert.strictEqual(b.h.list()[0][1].at, 1000);
  b.clock.t = 1000 + MAX_AGE + 1;
  assert.strictEqual(b.h.release(), 0);
});

test('re-checks: same state since the same moment and not opened; open ask; unreviewed task; not seen since', () => {
  const recs = { 'claude-a': { state: 'permission', since: 100, seenAt: 50 } };
  const live = { 'claude-c': { pending: [{ rid: 'r1' }] } };
  const tasks = [{ id: 't1', status: 'doing', result: { at: 300 } }];
  const watched = new Set();
  const still = createStillDue({ get: n => recs[n], live: n => live[n], tasks: () => tasks, watched: n => watched.has(n) });
  const state = { type: 'state', session: 'claude-a', state: 'permission', since: 100 };
  assert.strictEqual(still({ check: state }), true);
  assert.strictEqual(still({ check: { ...state, since: 99 } }), false);
  assert.strictEqual(still({ check: { ...state, state: 'error' } }), false);
  watched.add('claude-a');
  assert.strictEqual(still({ check: state }), false);
  watched.clear();
  recs['claude-a'].seenAt = 150;
  assert.strictEqual(still({ check: state }), false);
  assert.strictEqual(still({ check: { type: 'ask', session: 'claude-c', rid: 'r1', at: 200 } }), true);
  assert.strictEqual(still({ check: { type: 'ask', session: 'claude-c', rid: 'r2', at: 200 } }), false);
  assert.strictEqual(still({ check: { type: 'ask', session: 'claude-x', rid: 'r1', at: 200 } }), false);
  assert.strictEqual(still({ check: { type: 'task', id: 't1', at: 300 } }), true);
  assert.strictEqual(still({ check: { type: 'task', id: 't1', at: 301 } }), false);
  tasks[0].status = 'done';
  assert.strictEqual(still({ check: { type: 'task', id: 't1', at: 300 } }), false);
  assert.strictEqual(still({ check: { type: 'seen', session: 'claude-a', at: 200 } }), true);
  assert.strictEqual(still({ check: { type: 'seen', session: 'claude-a', at: 120 } }), false);
  assert.strictEqual(still({}), false);
});
