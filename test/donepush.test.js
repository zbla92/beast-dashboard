const test = require('node:test');
const assert = require('node:assert');
const { createDonePush, fromNotification } = require('../lib/donepush');

function rig(ready = () => true, send = null, clock = { t: 0 }) {
  const timers = [];
  const sent = [];
  const d = createDonePush({
    ready,
    now: () => clock.t,
    send: send || (name => { sent.push(name); }),
    setTimer: fn => { const t = { fn, cleared: false }; timers.push(t); return t; },
    clearTimer: t => { t.cleared = true; },
  });
  const run = async () => { for (const t of timers.splice(0)) if (!t.cleared) await t.fn(); };
  return { d, sent, timers, run };
}

test('a done push waits for the settle time and is sent only if the session is still finished', async () => {
  const marks = [];
  const { d, sent, run } = rig((name, mark) => { marks.push(mark); return true; });
  d.schedule('claude-a', 100, 50);
  assert.deepStrictEqual(sent, []);
  await run();
  assert.deepStrictEqual(sent, ['claude-a']);
  assert.deepStrictEqual(marks, [100]);
});

test('no push when the re-check says the session is still busy', async () => {
  const { d, sent, run } = rig(() => false);
  d.schedule('claude-a', 100, 50);
  await run();
  assert.deepStrictEqual(sent, []);
});

test('a new turn before the settle time cancels the pending push', async () => {
  const { d, sent, run } = rig();
  d.schedule('claude-a', 100, 50);
  d.cancel('claude-a');
  await run();
  assert.deepStrictEqual(sent, []);
});

test('one push per prompt: follow-up turns from task notifications do not buzz again', async () => {
  const { d, sent, run } = rig();
  d.schedule('claude-a', 100, 50);
  await run();
  assert.strictEqual(d.schedule('claude-a', 200, 50), false);
  await run();
  assert.deepStrictEqual(sent, ['claude-a']);
  assert.strictEqual(d.schedule('claude-a', 300, 250), true);
  await run();
  assert.deepStrictEqual(sent, ['claude-a', 'claude-a']);
});

test('a push that was held back still lets the later real finish of the same prompt through', async () => {
  const busy = new Set([100]);
  const { d, sent, run } = rig((name, mark) => !busy.has(mark));
  d.schedule('claude-a', 100, 50);
  await run();
  d.schedule('claude-a', 200, 50);
  await run();
  assert.deepStrictEqual(sent, ['claude-a']);
});

test('a reschedule while the re-check is still running drops the older one', async () => {
  const gates = [];
  const { d, sent, timers } = rig(() => new Promise(res => gates.push(res)));
  d.schedule('claude-a', 100, 50);
  const first = timers[0].fn();
  d.schedule('claude-a', 200, 60);
  await new Promise(setImmediate);
  gates[0](true);
  await first;
  assert.deepStrictEqual(sent, []);
  const second = timers[1].fn();
  await new Promise(setImmediate);
  gates[1](true);
  await second;
  assert.deepStrictEqual(sent, ['claude-a']);
});

test('a re-check that throws sends nothing', async () => {
  const { d, sent, run } = rig(() => { throw new Error('boom'); });
  d.schedule('claude-a', 100, 50);
  await run();
  assert.deepStrictEqual(sent, []);
});

test('sessions are handled separately', async () => {
  const { d, sent, run } = rig();
  d.schedule('claude-a', 100, 50);
  d.schedule('claude-b', 100, 50);
  d.cancel('claude-a');
  await run();
  assert.deepStrictEqual(sent, ['claude-b']);
});

test('task notification prompts are told apart from what the user typed', () => {
  assert.strictEqual(fromNotification('<task-notification> <task-id>b1</task-id>'), true);
  assert.strictEqual(fromNotification('  <task-notification>x'), true);
  assert.strictEqual(fromNotification('fix the push'), false);
  assert.strictEqual(fromNotification(null), false);
});

test('while a command started for this prompt still runs the push keeps waiting, and goes out once it ends', async () => {
  const state = { verdict: 'wait' };
  const clock = { t: 0 };
  const { d, sent, run } = rig(() => state.verdict, null, clock);
  d.schedule('claude-a', 100, 50);
  clock.t = 60000; await run();
  clock.t = 120000; await run();
  assert.deepStrictEqual(sent, []);
  state.verdict = true;
  clock.t = 180000; await run();
  assert.deepStrictEqual(sent, ['claude-a']);
});

test('a command that never ends (a dev server) holds the push for at most the max wait', async () => {
  const clock = { t: 0 };
  const { d, sent, run } = rig(() => 'wait', null, clock);
  d.schedule('claude-a', 100, 50);
  clock.t = 10 * 60000; await run();
  assert.deepStrictEqual(sent, []);
  clock.t = 16 * 60000; await run();
  assert.deepStrictEqual(sent, ['claude-a']);
});

test('a send that throws is swallowed and does not mark the prompt as pushed', async () => {
  const calls = [];
  const { d, run } = rig(() => true, name => { calls.push(name); throw new Error('boom'); });
  d.schedule('claude-a', 100, 50);
  await run();
  assert.strictEqual(d.schedule('claude-a', 200, 50), true);
  await run();
  assert.deepStrictEqual(calls, ['claude-a', 'claude-a']);
});

test('a push the gate or quiet hours dropped does not count as sent for that prompt', async () => {
  const calls = [];
  const { d, run } = rig(() => true, name => { calls.push(name); return false; });
  d.schedule('claude-a', 100, 50);
  await run();
  assert.strictEqual(d.schedule('claude-a', 200, 50), true);
});

test('waitingOn lists running agents and only the background commands started for this prompt', () => {
  const { waitingOn, holds } = require('../lib/donepush');
  const r = { bgTasks: [{ id: 'a1', type: 'agent', description: 'review' }], bgShells: ['bold', 'bnew'], shellsAtAsk: ['bold'], bgShellInfo: [{ id: 'bnew', description: 'npm test' }], stopAt: 1000 };
  const w = waitingOn(r, null, 2000);
  assert.deepStrictEqual(w, { agents: [{ id: 'a1', description: 'review' }], shells: [{ id: 'bnew', description: 'npm test' }], queued: 0, busy: false });
  assert.strictEqual(holds(w), true);
});

test('waitingOn drops background commands once the turn ended more than the max wait ago', () => {
  const { waitingOn, holds, MAX_WAIT } = require('../lib/donepush');
  const r = { bgShells: ['bnew'], shellsAtAsk: [], stopAt: 1000 };
  assert.strictEqual(waitingOn(r, null, 1000 + MAX_WAIT).shells.length, 1);
  const w = waitingOn(r, null, 1001 + MAX_WAIT);
  assert.deepStrictEqual(w.shells, []);
  assert.strictEqual(holds(w), false);
});

test('waitingOn counts queued chat messages and a chat that is still mid-turn, but ignores a stale chat', () => {
  const { waitingOn, holds } = require('../lib/donepush');
  const r = { bgShells: [], stopAt: 1 };
  assert.deepStrictEqual(waitingOn(r, { state: 'idle', inbox: ['x', 'y'] }, 2), { agents: [], shells: [], queued: 2, busy: false });
  assert.strictEqual(waitingOn(r, { state: 'idle', turn: { startedAt: 1 } }, 2).busy, true);
  assert.strictEqual(waitingOn(r, { state: 'idle', pending: [{ rid: 1 }] }, 2).busy, true);
  assert.strictEqual(waitingOn(r, { state: 'working' }, 2).busy, true);
  assert.strictEqual(holds(waitingOn(r, { state: 'working', inbox: ['x'], stale: true }, 2)), false);
  assert.strictEqual(holds(waitingOn(r, { state: 'idle', inbox: [], pending: [] }, 2)), false);
});

test('waitingOn handles a missing record and shells without a stored description', () => {
  const { waitingOn } = require('../lib/donepush');
  assert.deepStrictEqual(waitingOn(null, null, 0), { agents: [], shells: [], queued: 0, busy: false });
  assert.deepStrictEqual(waitingOn({ bgShells: ['b1'] }, null, 0).shells, [{ id: 'b1', description: 'b1' }]);
});
