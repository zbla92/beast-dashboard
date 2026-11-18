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
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
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
  assert.deepStrictEqual(w, { agents: [{ id: 'a1', description: 'review' }], shells: [{ id: 'bnew', description: 'npm test' }], queued: 0, busy: false, source: 'hook' });
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
  assert.deepStrictEqual(waitingOn(r, { state: 'idle', inbox: ['x', 'y'] }, 2), { agents: [], shells: [], queued: 2, busy: false, source: 'hook' });
  assert.strictEqual(waitingOn(r, { state: 'idle', turn: { startedAt: 1 } }, 2).busy, true);
  assert.strictEqual(waitingOn(r, { state: 'idle', pending: [{ rid: 1 }] }, 2).busy, true);
  assert.strictEqual(waitingOn(r, { state: 'working' }, 2).busy, true);
  assert.strictEqual(holds(waitingOn(r, { state: 'working', inbox: ['x'], stale: true }, 2)), false);
  assert.strictEqual(holds(waitingOn(r, { state: 'idle', inbox: [], pending: [] }, 2)), false);
});

test('waitingOn handles a missing record and shells without a stored description', () => {
  const { waitingOn } = require('../lib/donepush');
  assert.deepStrictEqual(waitingOn(null, null, 0), { agents: [], shells: [], queued: 0, busy: false, source: 'hook' });
  assert.deepStrictEqual(waitingOn({ bgShells: ['b1'] }, null, 0).shells, [{ id: 'b1', description: 'b1' }]);
});

const task = (id, kind, startedAt, extra = {}) => ({ id, kind, description: `${kind} ${id}`, startedAt, toolUseId: null, awaited: false, progress: null, owed: false, ...extra });
const chat = (tasks, extra = {}) => ({ state: 'idle', inbox: [], pending: [], turn: null, tasks, ...extra });

test('a live roster replaces the Stop hook fields: agents and generic tasks always hold, with kind, start time and progress', () => {
  const { waitingOn, holds } = require('../lib/donepush');
  const r = { bgTasks: [{ id: 'hook-agent' }], bgShells: ['hook-shell'], shellsAtAsk: [], askedAt: 1000, stopAt: 2000 };
  const w = waitingOn(r, chat([task('a1', 'agent', 10, { progress: 'Running tests' }), task('t1', 'task', 20)]), 3000);
  assert.strictEqual(w.source, 'live');
  assert.deepStrictEqual(w.agents, [
    { id: 'a1', description: 'agent a1', kind: 'agent', startedAt: 10, progress: 'Running tests' },
    { id: 't1', description: 'task t1', kind: 'task', startedAt: 20, progress: null },
  ]);
  assert.deepStrictEqual(w.shells, []);
  assert.strictEqual(holds(w), true);
  assert.deepStrictEqual(waitingOn(r, chat([]), 3000), { agents: [], shells: [], queued: 0, busy: false, source: 'live' });
});

test('live shells and monitors hold only when started for this prompt, or when awaited', () => {
  const { waitingOn } = require('../lib/donepush');
  const r = { askedAt: 1000, stopAt: 2000 };
  const tasks = [task('old', 'shell', 500), task('new', 'shell', 1500), task('mon', 'monitor', 1200), task('oldmon', 'monitor', 900), task('kept', 'shell', 100, { awaited: true })];
  assert.deepStrictEqual(waitingOn(r, chat(tasks), 3000).shells.map(x => [x.id, x.kind]), [['new', 'shell'], ['mon', 'monitor'], ['kept', 'shell']]);
});

test('live shells stop holding once the turn ended more than the max wait ago, but awaited ones keep holding', () => {
  const { waitingOn, MAX_WAIT } = require('../lib/donepush');
  const r = { askedAt: 1000, stopAt: 2000 };
  const tasks = [task('new', 'shell', 1500), task('kept', 'shell', 1500, { awaited: true }), task('a1', 'agent', 1500)];
  assert.strictEqual(waitingOn(r, chat(tasks), 2000 + MAX_WAIT).shells.length, 2);
  const w = waitingOn(r, chat(tasks), 2001 + MAX_WAIT);
  assert.deepStrictEqual(w.shells.map(x => x.id), ['kept']);
  assert.deepStrictEqual(w.agents.map(x => x.id), ['a1']);
});

test('a v 4 roster holds shells and monitors only when awaited, with no time limit; agents and generic tasks always hold', () => {
  const { waitingOn, holds, marksAwaited, MAX_WAIT } = require('../lib/donepush');
  const r = { askedAt: 1000, stopAt: 2000 };
  const tasks = [task('new', 'shell', 1500), task('mon', 'monitor', 1200), task('old', 'shell', 100, { awaited: true }), task('wmon', 'monitor', 1500, { awaited: true }), task('a1', 'agent', 500), task('t1', 'task', 500), task('ow', 'shell', 1500, { awaited: true, owed: true })];
  for (const now of [3000, 2001 + MAX_WAIT, 2000 + 50 * MAX_WAIT]) {
    const w = waitingOn(r, chat(tasks, { v: 4 }), now);
    assert.deepStrictEqual(w.shells.map(x => [x.id, x.kind]), [['old', 'shell'], ['wmon', 'monitor'], ['ow', 'shell']]);
    assert.deepStrictEqual(w.agents.map(x => x.id), ['a1', 't1']);
  }
  const unmarked = waitingOn(r, chat([task('new', 'shell', 1500), task('mon', 'monitor', 1500)], { v: 4 }), 3000);
  assert.deepStrictEqual(unmarked.shells, []); assert.strictEqual(holds(unmarked), false);
  assert.strictEqual(marksAwaited(chat([], { v: 4 })), true);
  assert.strictEqual(marksAwaited(chat([], { v: 3 })), false);
  assert.strictEqual(marksAwaited(chat([])), false);
  assert.strictEqual(marksAwaited(null), false);
});

test('a v 3 roster keeps the started-for-this-prompt rule with the max wait cut-off', () => {
  const { waitingOn, MAX_WAIT } = require('../lib/donepush');
  const r = { askedAt: 1000, stopAt: 2000 };
  const tasks = [task('old', 'shell', 500), task('new', 'shell', 1500), task('mon', 'monitor', 1200)];
  assert.deepStrictEqual(waitingOn(r, chat(tasks, { v: 3 }), 3000).shells.map(x => x.id), ['new', 'mon']);
  assert.deepStrictEqual(waitingOn(r, chat(tasks, { v: 3 }), 2001 + MAX_WAIT).shells, []);
});

test('a v 4 snapshot that went stale falls back to the Stop hook rule', () => {
  const { waitingOn } = require('../lib/donepush');
  const r = { bgTasks: [], bgShells: ['b1'], shellsAtAsk: [], askedAt: 1000, stopAt: 2000 };
  const w = waitingOn(r, chat([task('x', 'shell', 1500)], { v: 4, stale: true }), 3000);
  assert.deepStrictEqual([w.source, w.shells.map(x => x.id)], ['hook', ['b1']]);
});

test('a stop from an earlier prompt does not cut off the shells of the turn that is still running', () => {
  const { waitingOn, MAX_WAIT } = require('../lib/donepush');
  const r = { askedAt: 5000, stopAt: 1000 };
  assert.deepStrictEqual(waitingOn(r, chat([task('new', 'shell', 6000)]), 1001 + MAX_WAIT).shells.map(x => x.id), ['new']);
});

test('owed tasks count as their kind', () => {
  const { waitingOn } = require('../lib/donepush');
  const w = waitingOn({ askedAt: 1000 }, chat([task('a1', 'agent', 10, { owed: true }), task('s1', 'shell', 1500, { owed: true })]), 2000);
  assert.deepStrictEqual([w.agents.map(x => x.id), w.shells.map(x => x.id)], [['a1'], ['s1']]);
});

test('old runners without a roster and stale snapshots keep the Stop hook rule', () => {
  const { waitingOn } = require('../lib/donepush');
  const r = { bgTasks: [{ id: 'a1', description: 'review' }], bgShells: ['b1'], shellsAtAsk: [], stopAt: 1000 };
  const old = waitingOn(r, { state: 'idle' }, 2000);
  assert.strictEqual(old.source, 'hook');
  assert.deepStrictEqual([old.agents.length, old.shells.length], [1, 1]);
  const stale = waitingOn(r, chat([], { stale: true }), 2000);
  assert.strictEqual(stale.source, 'hook');
  assert.deepStrictEqual([stale.agents.length, stale.shells.length], [1, 1]);
});

test('liveVerdict: old runners and plain finished turns may push', () => {
  const { liveVerdict } = require('../lib/donepush');
  assert.strictEqual(liveVerdict(null, null, 0), true);
  assert.strictEqual(liveVerdict({ state: 'idle', lastResult: { interrupted: true } }, null, 0), true);
  assert.strictEqual(liveVerdict(chat([], { lastResult: { at: 1000, end: 'turn', interrupted: false, wakeOutcome: null } }), null, 2000), true);
  assert.strictEqual(liveVerdict(chat([], { lastResult: null, wake: null }), null, 2000), true);
});

test('liveVerdict: an interrupted turn never pushes done', () => {
  const { liveVerdict } = require('../lib/donepush');
  assert.strictEqual(liveVerdict(chat([], { lastResult: { at: 1000, end: 'turn', interrupted: true, wakeOutcome: null } }), null, 99999), false);
});

test('liveVerdict: a progress wake (outcome updated) never pushes done', () => {
  const { liveVerdict } = require('../lib/donepush');
  const L = chat([], { wake: { at: 900, outcome: 'updated' }, lastResult: { at: 1000, end: 'wake', interrupted: false, wakeOutcome: 'updated' } });
  assert.strictEqual(liveVerdict(L, 900, 99999), false);
  assert.strictEqual(liveVerdict(L, 900, 99999, true), true);
  assert.strictEqual(liveVerdict(chat([], { lastResult: { at: 1000, end: 'wake', interrupted: true, wakeOutcome: 'updated' } }), 900, 99999, true), false);
});

test('liveVerdict: a wake newer than the last result means a wake turn is coming, so check again soon for up to the settle time', () => {
  const { liveVerdict, SETTLE } = require('../lib/donepush');
  const L = chat([], { wake: { at: 2000, outcome: 'completed' }, lastResult: { at: 1000, end: 'turn', interrupted: false, wakeOutcome: null } });
  assert.strictEqual(liveVerdict(L, null, 3000), 'soon');
  assert.strictEqual(liveVerdict(L, null, 2000 + SETTLE), true);
});

test('liveVerdict: a final wake within 5 s of a progress wake waits 5 s more', () => {
  const { liveVerdict, QUICK } = require('../lib/donepush');
  const L = chat([], { wake: { at: 4000, outcome: 'completed' }, lastResult: { at: 5000, end: 'wake', interrupted: false, wakeOutcome: 'completed' } });
  assert.strictEqual(liveVerdict(L, 1000, 5000 + QUICK), 'soon');
  assert.strictEqual(liveVerdict(L, 1000, 5000 + 2 * QUICK), true);
  assert.strictEqual(liveVerdict(L, 4000 - QUICK, 5000 + QUICK), true);
  assert.strictEqual(liveVerdict(L, null, 5000 + QUICK), true);
});

test('the roster watch asks for a quick re-check only after held work left the roster during this prompt', () => {
  const { createRosterWatch } = require('../lib/donepush');
  const watch = createRosterWatch();
  assert.strictEqual(watch.check('claude-a', [], [], 500), false);
  assert.strictEqual(watch.check('claude-a', ['s1'], ['s1'], 500), false);
  assert.strictEqual(watch.check('claude-a', [], [], 500), true);
  assert.strictEqual(watch.check('claude-a', [], [], 500), true);
  assert.strictEqual(watch.check('claude-a', [], [], 3000), false);
  assert.strictEqual(watch.check('claude-b', [], [], 0), false);
  assert.deepStrictEqual(watch.names(), ['claude-a', 'claude-b']);
  watch.forget('claude-a');
  assert.deepStrictEqual(watch.names(), ['claude-b']);
});

test('the roster watch ignores a held shell that stops counting because a new prompt started', () => {
  const { createRosterWatch, waitingOn } = require('../lib/donepush');
  const watch = createRosterWatch();
  const tasks = [task('s1', 'shell', 1500)];
  const check = (r, now) => { const w = waitingOn(r, chat(tasks), now); return watch.check('claude-a', [...w.agents, ...w.shells].map(t => t.id), tasks.map(t => t.id), r.askedAt); };
  assert.strictEqual(check({ askedAt: 1000, stopAt: 2000 }, 2000), false);
  assert.strictEqual(check({ askedAt: 3000, stopAt: 2000 }, 3500), false);
  assert.strictEqual(check({ askedAt: 3000, stopAt: 4000 }, 4000), false);
});

test('the roster watch ignores a held shell that stops counting at the 15 min cut-off while it still runs', () => {
  const { createRosterWatch, waitingOn, MAX_WAIT } = require('../lib/donepush');
  const watch = createRosterWatch();
  const tasks = [task('s1', 'shell', 1500)];
  const r = { askedAt: 1000, stopAt: 2000 };
  const check = (list, now) => { const w = waitingOn(r, chat(list), now); return watch.check('claude-a', [...w.agents, ...w.shells].map(t => t.id), list.map(t => t.id), r.askedAt); };
  assert.strictEqual(check(tasks, 2000), false);
  assert.strictEqual(check(tasks, 2001 + MAX_WAIT), false);
  assert.strictEqual(check([], 2002 + MAX_WAIT), false);
});

test('a progress wake during the settle does not cancel the push a real turn is owed', async () => {
  const { liveVerdict } = require('../lib/donepush');
  const clock = { t: 0 };
  const L = chat([], { wake: { at: 1000, outcome: 'updated' }, lastResult: { at: 2000, end: 'wake', interrupted: false, wakeOutcome: 'updated' } });
  const { d, sent, run } = rig((name, mark, owed) => liveVerdict(L, 1000, clock.t, owed), null, clock);
  d.schedule('claude-a', 100, 50, true);
  d.cancel('claude-a');
  d.schedule('claude-a', 200, 50, false);
  clock.t = 99999; await run();
  assert.deepStrictEqual(sent, ['claude-a']);
  assert.strictEqual(d.schedule('claude-a', 300, 50, false), false);
});

test('a progress wake with no real turn owed still never pushes, and a settled real push is not owed again', async () => {
  const { liveVerdict } = require('../lib/donepush');
  const clock = { t: 0 };
  const L = chat([], { wake: { at: 1000, outcome: 'updated' }, lastResult: { at: 2000, end: 'wake', interrupted: false, wakeOutcome: 'updated' } });
  const state = { verdict: false };
  const { d, sent, run } = rig((name, mark, owed) => state.verdict === null ? liveVerdict(L, 1000, clock.t, owed) : state.verdict, null, clock);
  d.schedule('claude-a', 100, 50, false);
  clock.t = 99999; await run();
  assert.deepStrictEqual(sent, []);
  d.schedule('claude-a', 200, 60, true);
  await run();
  state.verdict = null;
  d.schedule('claude-a', 300, 60, false);
  await run();
  assert.deepStrictEqual(sent, []);
});

test('an interrupted real turn is forgone, so a later progress wake does not push for it', async () => {
  const { liveVerdict } = require('../lib/donepush');
  const L = chat([], { wake: { at: 1000, outcome: 'updated' }, lastResult: { at: 2000, end: 'wake', interrupted: false, wakeOutcome: 'updated' } });
  const { d, sent, run } = rig((name, mark, owed) => liveVerdict(L, 1000, 99999, owed));
  d.forgo('claude-a', 50);
  d.schedule('claude-a', 100, 50, true);
  d.cancel('claude-a');
  d.schedule('claude-a', 200, 50, false);
  await run();
  assert.deepStrictEqual(sent, []);
});

test('a hold verdict keeps checking while live agents run and drops the push after the max wait instead of sending', async () => {
  const { SETTLE, QUICK } = require('../lib/donepush');
  const clock = { t: 0 };
  const state = { verdict: 'hold' };
  const { d, sent, timers, run } = rig(() => state.verdict, null, clock);
  d.schedule('claude-a', 100, 50, true);
  clock.t = SETTLE; await run();
  assert.strictEqual(timers[0].ms, SETTLE);
  d.soon('claude-a');
  assert.strictEqual(timers.at(-1).ms, QUICK);
  state.verdict = true;
  await run();
  assert.deepStrictEqual(sent, ['claude-a']);
  d.schedule('claude-b', 100, 50, true);
  state.verdict = 'hold';
  clock.t = 16 * 60000; await run();
  assert.deepStrictEqual(sent, ['claude-a']);
});

test('forget drops every trace of a session', async () => {
  const { d, sent, run } = rig();
  d.schedule('claude-a', 100, 50, true);
  await run();
  assert.deepStrictEqual(d.names(), ['claude-a']);
  d.forget('claude-a');
  assert.deepStrictEqual(d.names(), []);
  assert.strictEqual(d.schedule('claude-a', 200, 50, true), true);
  await run();
  assert.deepStrictEqual(sent, ['claude-a', 'claude-a']);
});

test('soon() moves a pending push to the quick re-check, and does nothing without one', async () => {
  const { QUICK, SETTLE } = require('../lib/donepush');
  const { d, sent, timers, run } = rig();
  assert.strictEqual(d.soon('claude-a'), false);
  d.schedule('claude-a', 100, 50);
  assert.strictEqual(timers[0].ms, SETTLE);
  assert.strictEqual(d.soon('claude-a'), true);
  assert.strictEqual(timers[0].cleared, true);
  assert.strictEqual(timers[1].ms, QUICK);
  assert.strictEqual(d.soon('claude-a'), true);
  assert.strictEqual(timers.length, 2);
  await run();
  assert.deepStrictEqual(sent, ['claude-a']);
});

test('a soon verdict re-checks after the quick delay, and the max wait still ends it', async () => {
  const { QUICK } = require('../lib/donepush');
  const clock = { t: 0 };
  const state = { verdict: 'soon' };
  const { d, sent, timers, run } = rig(() => state.verdict, null, clock);
  d.schedule('claude-a', 100, 50);
  clock.t = 60000; await run();
  assert.strictEqual(timers[0].ms, QUICK);
  assert.deepStrictEqual(sent, []);
  clock.t = 16 * 60000; await run();
  assert.deepStrictEqual(sent, ['claude-a']);
});

test('soon() during a running re-check makes a wait verdict come back after the quick delay', async () => {
  const { QUICK } = require('../lib/donepush');
  const gates = [];
  const { d, timers } = rig(() => new Promise(res => gates.push(res)));
  d.schedule('claude-a', 100, 50);
  const first = timers[0].fn();
  await new Promise(setImmediate);
  assert.strictEqual(d.soon('claude-a'), true);
  assert.strictEqual(timers.length, 1);
  gates[0]('wait');
  await first;
  assert.strictEqual(timers[1].ms, QUICK);
});

test('while someone is at the computer a done push waits past the max wait, and goes out when they leave', async () => {
  const state = { verdict: 'present' };
  const clock = { t: 0 };
  const { d, sent, run, timers } = rig(() => state.verdict, null, clock);
  d.schedule('claude-a', 100, 50);
  clock.t = 60000; await run();
  assert.strictEqual(timers.length, 0);
  clock.t = 40 * 60000;
  assert.strictEqual(d.soon('claude-a'), true);
  await run();
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(await d.release(), []);
  assert.deepStrictEqual(sent, []);
  state.verdict = true;
  assert.deepStrictEqual(await d.release(), ['claude-a']);
  assert.deepStrictEqual(sent, ['claude-a']);
  assert.deepStrictEqual(await d.release(), []);
  assert.strictEqual(d.schedule('claude-a', 200, 50), false);
});

test('released done pushes can be collected instead of sent; one already seen is dropped, one still holding waits again', async () => {
  const verdicts = { 'claude-a': 'present', 'claude-b': 'present', 'claude-c': 'present' };
  const clock = { t: 0 };
  const { d, sent, run } = rig(name => verdicts[name], null, clock);
  for (const n of Object.keys(verdicts)) d.schedule(n, 100, 50);
  clock.t = 60000; await run();
  Object.assign(verdicts, { 'claude-a': true, 'claude-b': false, 'claude-c': 'wait' });
  clock.t = 30 * 60000;
  const got = [];
  assert.deepStrictEqual(await d.release(name => { got.push(name); }), ['claude-a']);
  assert.deepStrictEqual(got, ['claude-a']);
  verdicts['claude-c'] = true;
  clock.t += 60000; await run();
  assert.deepStrictEqual(sent, ['claude-c']);
});

test('a parked push that a new turn cancels never goes out', async () => {
  const clock = { t: 0 };
  const { d, sent, run } = rig(() => 'present', null, clock);
  d.schedule('claude-a', 100, 50);
  clock.t = 60000; await run();
  d.cancel('claude-a');
  assert.deepStrictEqual(await d.release(() => true), []);
  assert.deepStrictEqual(sent, []);
});

test('a push held for live agents still ends at the max wait while someone is at the computer, without being sent', async () => {
  const clock = { t: 0 };
  const parks = [];
  const timers = [];
  const sent = [];
  const d = createDonePush({ ready: () => 'hold', send: n => { sent.push(n); }, onPark: n => parks.push(n), now: () => clock.t, setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimer: t => { t.cleared = true; } });
  d.schedule('claude-a', 100, 50);
  for (clock.t = 60000; clock.t <= 16 * 60000; clock.t += 60000) for (const t of timers.splice(0)) if (!t.cleared) await t.fn();
  assert.strictEqual(timers.length, 0);
  assert.deepStrictEqual(parks, []);
  assert.deepStrictEqual(await d.release(), []);
  assert.deepStrictEqual(sent, []);
});

test('parked pushes are listed for saving and restored parked after a restart, then released as usual', async () => {
  const clock = { t: 0 };
  const a = rig(() => 'present', null, clock);
  assert.deepStrictEqual(a.d.parked(), []);
  a.d.schedule('claude-a', 100, 50, true);
  clock.t = 60000; await a.run();
  const saved = JSON.parse(JSON.stringify(a.d.parked()));
  assert.deepStrictEqual(saved, [{ name: 'claude-a', mark: 100, askedAt: 50, real: true }]);
  const marks = [];
  const sent = [];
  const c = createDonePush({ ready: (name, mark, owed) => { marks.push([mark, owed]); return true; }, send: n => { sent.push(n); }, now: () => clock.t, setTimer: () => ({}), clearTimer: () => {} });
  c.restore([...saved, null, { name: 7 }]);
  assert.deepStrictEqual(c.parked(), saved);
  assert.deepStrictEqual(await c.release(), ['claude-a']);
  assert.deepStrictEqual(marks, [[100, true]]);
  assert.deepStrictEqual(sent, ['claude-a']);
  assert.strictEqual(c.schedule('claude-a', 200, 50), false);
});

test('parking a push reports it so the list can be saved', async () => {
  const parks = [];
  const timers = [];
  const d = createDonePush({ ready: () => 'present', send: () => {}, onPark: n => parks.push(n), now: () => 0, setTimer: fn => { const t = { fn }; timers.push(t); return t; }, clearTimer: () => {} });
  d.schedule('claude-a', 100, 50);
  await timers[0].fn();
  assert.deepStrictEqual(parks, ['claude-a']);
});
