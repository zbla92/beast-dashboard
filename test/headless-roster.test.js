const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const headless = require('../lib/headless');

const RUNNER = path.join(__dirname, '..', 'bin', 'headless-runner.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const FIX = name => path.join(__dirname, 'fixtures', name);
const SID = '11111111-2222-4333-8444-555555555555';

function runner(t, stream, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-roster-'));
  const sock = path.join(dir, 'run', 's.sock');
  const p = spawn(process.execPath, [RUNNER, '--sock', sock, '--cwd', dir, '--session-id', SID, '--start', 'new', '--claude', FAKE, '--name', 'claude-test'],
    { env: { ...process.env, FAKE_STREAM: stream, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.resume();
  t.after(() => { try { p.kill('SIGKILL'); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { p, sock, dir };
}

async function client(t, sock) {
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(sock) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  const c = net.connect(sock); await new Promise((r, j) => { c.once('connect', r); c.once('error', j); });
  t.after(() => c.destroy());
  const evs = [], waiters = [];
  const st = { buf: '', cid: 0 };
  c.setEncoding('utf8');
  c.on('data', d => { const parts = (st.buf + d).split('\n'); st.buf = parts.pop(); for (const l of parts) if (l) evs.push(JSON.parse(l)); if (parts.length) for (const w of waiters.splice(0)) w(); });
  const until = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) { const hit = evs.find(pred); if (hit) return hit; if (Date.now() > end) throw new Error('timeout; got ' + JSON.stringify(evs.map(e => e.ev))); await new Promise(r => { waiters.push(r); setTimeout(r, 50); }); }
  };
  const op = o => { const id = 'c' + ++st.cid; c.write(JSON.stringify({ ...o, cid: id }) + '\n'); return until(e => (e.ev === 'ack' || e.ev === 'error') && e.cid === id); };
  const all = ev => evs.filter(e => e.ev === ev);
  const results = n => until(() => all('result').length >= n).then(() => all('result'));
  const snapshot = async () => { const n = all('snapshot').length; c.write('{"op":"hello"}\n'); await until(() => all('snapshot').length > n); return all('snapshot').at(-1); };
  return { evs, until, op, all, results, snapshot };
}

const ids = l => l.map(x => x.id);
const synthetic = (t, frames) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-roster-fx-')), 'stream.jsonl');
  fs.writeFileSync(f, frames.map(x => JSON.stringify(x)).join('\n') + '\n');
  t.after(() => fs.rmSync(path.dirname(f), { recursive: true, force: true }));
  return f;
};
const sys = (subtype, o = {}) => ({ type: 'system', subtype, ...o });
const init = () => sys('init', { model: 'fake-model', claude_code_version: '9.9.9', capabilities: ['interrupt_receipt_v1'] });
const echo = text => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, isReplay: true, uuid: 'x' });
const ev = event => ({ type: 'stream_event', event, parent_tool_use_id: null });
const say = text => [ev({ type: 'message_start', message: { id: 'm' } }), ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }), ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })];
const result = (o = {}) => ({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', num_turns: 1, result: 'ok', duration_ms: 1, ...o });
const level = list => sys('background_tasks_changed', { tasks: list.map(([task_id, task_type]) => ({ task_id, task_type, description: task_id + ' work', run_id: 'r-' + task_id })) });
const started = (task_id, tool_use_id, extra = {}) => sys('task_started', { task_id, tool_use_id, description: task_id + ' work', is_backgrounded: true, task_type: 'local_bash', run_id: 'r-' + task_id, ...extra });

test('replay: a background command and a background agent with a nested foreground command, progress and two wake turns', async t => {
  const r = runner(t, FIX('stream-bg-tasks.jsonl')); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'go' });
  const res = await k.results(3);
  assert.deepStrictEqual(res.map(x => [x.end, x.interrupted, x.wake && x.wake.taskId]), [['turn', false, null], ['wake', false, 'b7arm4dxt'], ['wake', false, 'a76527224ef24c7ee']]);
  assert.strictEqual(res[0].text, 'started'); assert.strictEqual(res[0].subtype, 'success');
  const tasks = k.all('tasks').map(e => e.tasks);
  assert.ok(tasks.every(l => !l.some(x => x.id === 'bi0tm27m8' || x.owed)));
  const both = tasks.find(l => l.length === 2);
  assert.deepStrictEqual(both.map(x => [x.id, x.kind]), [['b7arm4dxt', 'shell'], ['a76527224ef24c7ee', 'agent']]);
  assert.strictEqual(both[0].toolUseId, 'toolu_018QBKAzpiGqANG2bfBfog34');
  assert.ok(tasks.some(l => l.length === 2 && l[1].toolUseId === 'toolu_01Pa2Q9RDH8fGDkD7P7RHtjd' && l[1].progress === 'Running Sleep for 25 seconds in the foreground'));
  const agentOnly = tasks.filter(l => l.length === 1 && l[0].kind === 'agent');
  assert.deepStrictEqual(agentOnly.map(l => l[0].progress), ['Running Sleep for 25 seconds in the foreground', 'Running Print current date and time']);
  assert.deepStrictEqual(tasks.at(-1), []);
  for (const l of tasks) for (const x of l) { assert.strictEqual(x.awaited, false); assert.strictEqual(typeof x.startedAt, 'number'); assert.ok(x.description); }
  const wakes = k.all('wake').map(e => e.wake);
  assert.deepStrictEqual(wakes.map(w => [w.taskId, w.kind, w.outcome, w.summary]), [
    ['b7arm4dxt', 'shell', 'completed', 'Background command "Sleep 20s in background" completed (exit code 0)'],
    ['a76527224ef24c7ee', 'agent', 'completed', 'agent-done'],
  ]);
  assert.deepStrictEqual(res[1].wake, wakes[0]); assert.deepStrictEqual(res[2].wake, wakes[1]);
  const s = await k.snapshot();
  assert.strictEqual(s.v, 3); assert.deepStrictEqual(s.tasks, []); assert.deepStrictEqual(s.wake, wakes[1]);
  assert.deepStrictEqual({ ...s.lastResult, at: 0 }, { at: 0, end: 'wake', interrupted: false, isError: false, subtype: 'success', reason: 'completed', wakeOutcome: 'completed' });
  assert.strictEqual(s.state, 'idle'); assert.strictEqual(s.turn, null);
});

test('replay: an interrupted foreground command marks the turn interrupted and the background command still wakes it later', async t => {
  const r = runner(t, FIX('stream-bg-interrupt.jsonl')); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'go' });
  await k.until(e => e.ev === 'tool' && e.id === 'toolu_01NT7jqnSnHrijhid2PKs43q');
  assert.deepStrictEqual(k.all('tasks').at(-1).tasks.map(x => [x.id, x.kind, x.toolUseId]), [['b71gugtcq', 'shell', 'toolu_01Kx28RoDiL4dG3JmAXxvikB']]);
  await k.op({ op: 'interrupt' });
  const res = await k.results(2);
  assert.deepStrictEqual(res.map(x => [x.subtype, x.reason, x.isError, x.end, x.interrupted]), [['error_during_execution', 'aborted_tools', true, 'turn', true], ['success', 'completed', false, 'wake', false]]);
  assert.strictEqual(res[0].wake, null);
  assert.deepStrictEqual([res[1].wake.taskId, res[1].wake.outcome], ['b71gugtcq', 'completed']);
  const s = await k.snapshot();
  assert.deepStrictEqual(s.tasks, []);
  assert.deepStrictEqual([s.lastResult.end, s.lastResult.interrupted, s.lastResult.wakeOutcome], ['wake', false, 'completed']);
});

test('replay: a background command stopped inside a second user turn wakes as cancelled without its own result', async t => {
  const r = runner(t, FIX('stream-bg-stop.jsonl')); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'start it' });
  const [first] = await k.results(1);
  assert.deepStrictEqual([first.end, first.interrupted, first.wake], ['turn', false, null]);
  assert.deepStrictEqual(k.all('tasks').at(-1).tasks.map(x => [x.id, x.kind]), [['brh59u96k', 'shell']]);
  await k.until(e => e.ev === 'state' && e.state === 'idle');
  await k.op({ op: 'send', text: 'stop it' });
  const res = await k.results(2);
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(k.all('result').length, 2);
  assert.deepStrictEqual([res[1].end, res[1].wake, res[1].text], ['turn', null, 'stopped']);
  const wakes = k.all('wake').map(e => e.wake);
  assert.deepStrictEqual(wakes.map(w => [w.taskId, w.kind, w.outcome, w.summary]), [['brh59u96k', 'shell', 'cancelled', 'Run 90 second wait in background']]);
  const s = await k.snapshot();
  assert.deepStrictEqual(s.tasks, []); assert.strictEqual(s.wake.outcome, 'cancelled'); assert.strictEqual(s.lastResult.end, 'turn'); assert.strictEqual(s.lastResult.wakeOutcome, null);
});

test('replay: a Monitor is told apart by its tool name; event wakes without a notification come out as updated', async t => {
  const r = runner(t, FIX('stream-bg-monitor.jsonl')); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'watch' });
  const res = await k.results(4);
  assert.deepStrictEqual(res.map(x => [x.end, x.text, x.wake && x.wake.outcome]), [['turn', 'watching', null], ['wake', 'tick 1', 'updated'], ['wake', 'tick 2', 'updated'], ['wake', 'tick 3 (stream ended)', 'completed']]);
  const filled = k.all('tasks').map(e => e.tasks).filter(l => l.length && l[0].toolUseId);
  assert.ok(filled.length);
  for (const l of filled) assert.deepStrictEqual(l.map(x => [x.id, x.kind, x.toolUseId]), [['b0i0euitq', 'monitor', 'toolu_01EzdZBacr8nHprrxzX4PFYd']]);
  const wakes = k.all('wake').map(e => e.wake);
  assert.deepStrictEqual(wakes.map(w => [w.taskId, w.kind, w.outcome, w.summary]), [
    [null, null, 'updated', 'tick 1'], [null, null, 'updated', 'tick 2'],
    ['b0i0euitq', 'monitor', 'completed', 'Monitor "tick events from 3-iteration loop" stream ended'],
  ]);
  const s = await k.snapshot();
  assert.deepStrictEqual(s.tasks, []); assert.strictEqual(s.lastResult.wakeOutcome, 'completed');
});

test('an empty task-notification result with num_turns 0 is not a turn: no result event, the running turn and state stay', async t => {
  const empty = result({ origin: { kind: 'task-notification', producer: 'session-task' }, num_turns: 0, result: '' });
  const f = synthetic(t, [init(), echo('hi'), ...say('Hello'), empty, ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'World' } }),
    result({ result: 'Hello\n\nWorld' }), empty, level([['b1', 'local_bash']])]);
  const r = runner(t, f); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hi' });
  await k.until(e => e.ev === 'tasks' && e.tasks.length === 1);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(k.all('result').length, 1);
  assert.strictEqual(k.all('wake').length, 0);
  assert.strictEqual(k.all('block').length, 1);
  const states = k.all('state').map(e => e.state);
  assert.deepStrictEqual(states.slice(states.indexOf('working')), ['working', 'idle']);
  const s = await k.snapshot();
  assert.strictEqual(s.state, 'idle'); assert.strictEqual(s.lastResult.end, 'turn');
});

test('owed: a task that leaves the roster without its notification stays owed, then drops after the owed window', async t => {
  const f = synthetic(t, [init(), echo('hi'), ...say('ok'),
    started('bf', 'tu-f', { is_backgrounded: false }), started('bn', 'tu-n', { parent_task_id: 'bx', owned_by_subagent: true }),
    level([['bx', 'local_bash'], ['bf', 'local_bash']]), started('bx', 'tu-x'), result(), level([])]);
  const r = runner(t, f, { BD_HL_OWED_MS: '400' }); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hi' });
  const owed = await k.until(e => e.ev === 'tasks' && e.tasks.length && e.tasks.every(x => x.owed));
  assert.deepStrictEqual(owed.tasks.map(x => [x.id, x.toolUseId, x.owed]), [['bx', 'tu-x', true], ['bf', 'tu-f', true]]);
  assert.ok(k.all('tasks').every(e => !e.tasks.some(x => x.id === 'bn')));
  assert.deepStrictEqual((await k.snapshot()).tasks.map(x => x.owed), [true, true]);
  const at = Date.now();
  await k.until(e => e.ev === 'tasks' && e.tasks.length === 0 && k.evs.indexOf(e) > k.evs.indexOf(owed));
  assert.ok(Date.now() - at >= 250);
  assert.strictEqual(k.all('wake').length, 0);
});

test('owed: the default window keeps an owed task for 10 s and a task back on the roster is no longer owed', async t => {
  const f = synthetic(t, [init(), echo('hi'), ...say('ok'), level([['bx', 'local_agent']]), result(), level([])]);
  const r = runner(t, f); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hi' });
  await k.until(e => e.ev === 'tasks' && e.tasks.length === 1 && e.tasks[0].owed);
  await new Promise(r => setTimeout(r, 1000));
  assert.deepStrictEqual((await k.snapshot()).tasks.map(x => [x.id, x.kind, x.owed]), [['bx', 'agent', true]]);
  assert.strictEqual(k.all('tasks').at(-1).tasks.length, 1);
});

test('owed: a notification that lands after the owed window still wakes as a real completion, not as progress', async t => {
  const note = sys('task_notification', { task_id: 'bx', tool_use_id: 'tu-x', status: 'completed', summary: 'bx finished' });
  const wakeResult = result({ origin: { kind: 'task-notification' }, result: 'all done' });
  const f = synthetic(t, [init(), echo('hi'), ...say('ok'), level([['bx', 'local_bash']]), started('bx', 'tu-x'), result(), level([]), { type: 'fake_sleep', ms: 600 }, note, init(), ...say('all done'), wakeResult]);
  const r = runner(t, f, { BD_HL_OWED_MS: '200' }); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hi' });
  const res = await k.results(2);
  assert.deepStrictEqual(k.all('tasks').slice(-2).map(e => e.tasks.map(x => [x.id, x.owed])), [[['bx', true]], []]);
  assert.deepStrictEqual(k.all('wake').map(e => [e.wake.taskId, e.wake.kind, e.wake.outcome, e.wake.summary]), [['bx', 'shell', 'completed', 'bx finished']]);
  assert.deepStrictEqual([res[1].end, res[1].wake && res[1].wake.outcome], ['wake', 'completed']);
  assert.strictEqual((await k.snapshot()).lastResult.wakeOutcome, 'completed');
});

test('a level bringing an owed task back clears owed; child exit clears the roster and keeps lastResult', async t => {
  const f = synthetic(t, [init(), echo('hi'), ...say('ok'), level([['bx', 'local_bash']]), result(), level([]), level([['bx', 'local_bash']]), { type: 'fake_exit' }]);
  const r = runner(t, f); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hi' });
  await k.until(e => e.ev === 'state' && e.state === 'exited');
  const tasks = k.all('tasks').map(e => e.tasks.map(x => [x.id, x.owed]));
  assert.deepStrictEqual(tasks, [[['bx', false]], [['bx', true]], [['bx', false]], []]);
  const s = await k.snapshot();
  assert.deepStrictEqual(s.tasks, []);
  assert.deepStrictEqual([s.lastResult.end, s.lastResult.subtype], ['turn', 'success']);
});

test('apply keeps tasks, wake and lastResult, and an old runner snapshot stays without a roster', () => {
  const old = { turn: { text: 'x', tools: [] }, pending: [] };
  headless.apply(old, { ev: 'result', subtype: 'success', reason: 'completed', isError: false });
  assert.strictEqual(old.turn, null); assert.strictEqual(Array.isArray(old.tasks), false);
  assert.deepStrictEqual({ ...old.lastResult, at: 0 }, { at: 0, end: 'turn', interrupted: false, isError: false, subtype: 'success', reason: 'completed', wakeOutcome: null });
  const snap = { tasks: [], wake: null, lastResult: null, pending: [] };
  const list = [{ id: 'b1', kind: 'shell', description: 'd', startedAt: 1, toolUseId: 'tu', awaited: false, progress: null, owed: false }];
  headless.apply(snap, { ev: 'tasks', tasks: list });
  assert.deepStrictEqual(snap.tasks, list); assert.notStrictEqual(snap.tasks[0], list[0]);
  const w = { at: 2, taskId: 'b1', kind: 'shell', outcome: 'failed', summary: 's' };
  headless.apply(snap, { ev: 'wake', wake: w });
  assert.deepStrictEqual(snap.wake, w);
  headless.apply(snap, { ev: 'result', subtype: 'error_during_execution', reason: 'aborted_tools', isError: true, end: 'wake', interrupted: true, wake: w });
  assert.deepStrictEqual({ ...snap.lastResult, at: 0 }, { at: 0, end: 'wake', interrupted: true, isError: true, subtype: 'error_during_execution', reason: 'aborted_tools', wakeOutcome: 'failed' });
  headless.apply(snap, { ev: 'tasks' });
  assert.deepStrictEqual(snap.tasks, list);
});
