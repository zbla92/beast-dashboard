const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const headless = require('../lib/headless');

const PORT = 8813;
headless.init({ port: PORT, test: true });
const RUNNER = path.join(__dirname, '..', 'bin', 'headless-runner.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const FIX = path.join(__dirname, 'fixtures', 'stream-bg-stoptask.jsonl');
const SID = '11111111-2222-4333-8444-555555555555';
const TASK = 'bsy8zsrni';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (pred, ms = 2000) => { const end = Date.now() + ms; while (!(await pred()) && Date.now() < end) await sleep(20); };

function runner(t, sock, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-stoptask-'));
  const args = path.join(dir, 'args.jsonl');
  const p = spawn(process.execPath, [RUNNER, '--sock', sock || path.join(dir, 'run', 's.sock'), '--cwd', dir, '--session-id', SID, '--start', 'new', '--claude', FAKE, '--name', 'claude-test'],
    { env: { ...process.env, FAKE_STREAM: FIX, FAKE_ARGS: args, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.resume();
  t.after(() => { try { p.kill('SIGKILL'); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { sock: sock || path.join(dir, 'run', 's.sock'), requests: () => fs.existsSync(args) ? fs.readFileSync(args, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.request).map(x => x.request) : [] };
}

async function client(t, sock) {
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(sock) && Date.now() < deadline) await sleep(20);
  const c = net.connect(sock); await new Promise((r, j) => { c.once('connect', r); c.once('error', j); });
  t.after(() => c.destroy());
  const evs = [], waiters = [], st = { buf: '', cid: 0 };
  c.setEncoding('utf8');
  c.on('data', d => { const parts = (st.buf + d).split('\n'); st.buf = parts.pop(); for (const l of parts) if (l) evs.push(JSON.parse(l)); if (parts.length) for (const w of waiters.splice(0)) w(); });
  const until = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) { const hit = evs.find(pred); if (hit) return hit; if (Date.now() > end) throw new Error('timeout; got ' + JSON.stringify(evs.map(e => e.ev))); await new Promise(r => { waiters.push(r); setTimeout(r, 50); }); }
  };
  const write = o => { const id = 'c' + ++st.cid; c.write(JSON.stringify({ ...o, cid: id }) + '\n'); return id; };
  const reply = id => until(e => (e.ev === 'ack' || e.ev === 'error') && e.cid === id);
  const op = o => reply(write(o));
  const all = ev => evs.filter(e => e.ev === ev);
  const snapshot = async () => { const n = all('snapshot').length; c.write('{"op":"hello"}\n'); await until(() => all('snapshot').length > n); return all('snapshot').at(-1); };
  return { evs, until, op, write, reply, all, snapshot };
}

async function started(t, extraEnv) {
  const r = runner(t, null, extraEnv); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'go' });
  await k.until(e => e.ev === 'result');
  await k.until(e => e.ev === 'state' && e.state === 'idle');
  assert.deepStrictEqual(k.all('tasks').at(-1).tasks.map(x => [x.id, x.kind]), [[TASK, 'shell']]);
  return { r, k };
}

test('replay: stop-task sends stop_task for a roster task, the roster and a cancelled wake follow from the notification, no extra turn', async t => {
  const { r, k } = await started(t);
  const s0 = await k.snapshot();
  assert.strictEqual(s0.stopTask, true); assert.strictEqual(s0.v, 4);
  assert.deepStrictEqual(await k.op({ op: 'stop-task', id: 'nope' }).then(e => [e.ev, e.error]), ['error', 'no such background task']);
  assert.deepStrictEqual(await k.op({ op: 'stop-task' }).then(e => [e.ev, e.error]), ['error', 'no such background task']);
  assert.deepStrictEqual(r.requests(), []);
  const ack = await k.op({ op: 'stop-task', id: TASK });
  assert.strictEqual(ack.ev, 'ack');
  assert.deepStrictEqual(r.requests(), [{ subtype: 'stop_task', task_id: TASK }]);
  const out = k.all('stop-task');
  assert.deepStrictEqual(out.map(e => [e.id, e.ok, e.error]), [[TASK, true, null]]);
  const wakes = k.all('wake').map(e => e.wake);
  assert.deepStrictEqual(wakes.map(w => [w.taskId, w.kind, w.outcome, w.summary]), [[TASK, 'shell', 'cancelled', 'Sleep 60 seconds in background']]);
  assert.deepStrictEqual(k.all('tasks').at(-1).tasks, []);
  const wakeAt = k.evs.findIndex(e => e.ev === 'wake'), stopAt = k.evs.findIndex(e => e.ev === 'stop-task');
  assert.ok(wakeAt >= 0 && wakeAt < stopAt);
  await sleep(200);
  assert.strictEqual(k.all('result').length, 1);
  const s = await k.snapshot();
  assert.deepStrictEqual(s.tasks, []); assert.strictEqual(s.wake.outcome, 'cancelled'); assert.strictEqual(s.lastResult.end, 'turn');
  assert.deepStrictEqual(await k.op({ op: 'stop-task', id: TASK }).then(e => [e.ev, e.error]), ['error', 'no such background task']);
});

test('stop-task: a second stop for the same task while the first is in flight is refused', async t => {
  const { r, k } = await started(t);
  const a = k.write({ op: 'stop-task', id: TASK }), b = k.write({ op: 'stop-task', id: TASK });
  const [ra, rb] = await Promise.all([k.reply(a), k.reply(b)]);
  assert.deepStrictEqual([ra.ev, rb.ev, rb.error], ['ack', 'error', 'that task is already being stopped']);
  assert.strictEqual(r.requests().length, 1);
});

test('stop-task: an error answer from claude comes back as the op error and a failed stop-task event, the roster stays', async t => {
  const msg = 'stop_task is not supported in this context (callback not registered)';
  const { k } = await started(t, { FAKE_STOP_ERROR: msg });
  const e = await k.op({ op: 'stop-task', id: TASK });
  assert.deepStrictEqual([e.ev, e.error], ['error', msg]);
  assert.deepStrictEqual(k.all('stop-task').map(x => [x.id, x.ok, x.error]), [[TASK, false, msg]]);
  assert.deepStrictEqual((await k.snapshot()).tasks.map(x => x.id), [TASK]);
  assert.strictEqual(k.all('wake').length, 0);
});

test('headless.stopTask checks the id, the runner support and the roster before it forwards the stop', async t => {
  const name = 'claude-chat-stoptask';
  fs.mkdirSync(path.dirname(headless.sockPath(name)), { recursive: true });
  try { fs.unlinkSync(headless.sockPath(name)); } catch {}
  const r = runner(t, headless.sockPath(name));
  t.after(() => headless.forget(name));
  const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'go' });
  await k.until(e => e.ev === 'state' && e.state === 'idle');
  await waitFor(async () => ((await headless.status(name)) || {}).tasks?.length);
  assert.deepStrictEqual(await headless.stopTask(name, '../x'), { ok: false, status: 400, error: 'bad task id' });
  assert.deepStrictEqual(await headless.stopTask(name, 5), { ok: false, status: 400, error: 'bad task id' });
  assert.deepStrictEqual(await headless.stopTask(name, 'b999'), { ok: false, status: 409, error: 'no such background task' });
  assert.deepStrictEqual(await headless.stopTask(name, TASK), { ok: true, status: 200 });
  await waitFor(() => !headless.live(name).tasks.length);
  assert.deepStrictEqual(headless.live(name).tasks, []);
  assert.strictEqual(headless.live(name).wake.outcome, 'cancelled');
  assert.deepStrictEqual(await headless.stopTask(name, TASK), { ok: false, status: 409, error: 'no such background task' });
});

test('headless.stopTask refuses an old runner without stopTask and an unreachable chat', async t => {
  const name = 'claude-chat-stoptask-old', sock = headless.sockPath(name);
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  try { fs.unlinkSync(sock); } catch {}
  const ops = [];
  const srv = net.createServer(c => {
    c.setEncoding('utf8');
    c.on('data', d => { for (const l of d.split('\n').filter(Boolean)) { const m = JSON.parse(l); if (m.op === 'hello') c.write(JSON.stringify({ ev: 'snapshot', v: 4, state: 'idle', pending: [], tasks: [{ id: TASK, kind: 'shell', owed: false }] }) + '\n'); else { ops.push(m.op); c.write(JSON.stringify({ ev: 'error', cid: m.cid, error: 'unknown op' }) + '\n'); } } });
  });
  await new Promise(r => srv.listen(sock, r));
  t.after(() => { headless.forget(name); srv.close(); try { fs.unlinkSync(sock); } catch {} });
  assert.deepStrictEqual(await headless.stopTask(name, TASK), { ok: false, status: 409, error: 'this chat started before background tasks could be stopped' });
  assert.deepStrictEqual(ops, []);
  t.after(() => headless.forget('claude-chat-stoptask-gone'));
  assert.deepStrictEqual(await headless.stopTask('claude-chat-stoptask-gone', TASK), { ok: false, status: 409, error: 'chat runner is not reachable' });
});

const actSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-activity.js'), 'utf8');
const textOf = n => n == null || n === false ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : n.kids.map(textOf).join('');
const findAll = (n, pred, out = []) => {
  if (Array.isArray(n)) for (const x of n) findAll(x, pred, out);
  else if (n && typeof n === 'object' && n.kids) { if (pred(n)) out.push(n); findAll(n.kids, pred, out); }
  return out;
};
function bootUi(live) {
  const calls = [], clock = { now: 1000000 }, box = { strip: null, dataset: { chat: 'claude-chat-x' } };
  const node = (tag, attrs, kids) => ({ tag, attrs: attrs || {}, kids, dataset: {}, innerHTML: '', append(...more) { kids.push(...more); }, replaceWith: n => { box.strip = n; }, remove: () => { box.strip = null; } });
  box.querySelector = sel => sel === ':scope > .act-strip' ? box.strip : sel === ':scope > .cscroll' ? { scrollHeight: 0, scrollTop: 0, clientHeight: 0, after: n => { box.strip = n; } } : null;
  const ctx = {
    FEAT: {}, S: { runtime: { sessions: [] } },
    Date: { now: () => clock.now },
    h: (tag, attrs, ...kids) => node(tag, attrs, kids),
    document: { addEventListener() {}, querySelectorAll: sel => sel === '[data-chat]' ? [box] : [], hidden: false },
    setInterval() {}, setTimeout() {},
    liveOf: () => live.snap,
    claudeOf: () => ({ mode: 'chat', state: 'idle', waitingOn: { agents: [], shells: [] } }),
    displayState: () => 'idle',
    api: (ep, body) => new Promise((resolve, reject) => calls.push({ ep, body, resolve, reject })),
    toast() {},
  };
  vm.runInNewContext(actSrc, ctx);
  const paint = () => ctx.FEAT.activity.composerShown(box);
  const stops = () => findAll(box.strip, n => n.tag === 'button' && /^Stop /.test(n.attrs['aria-label'] || ''));
  const rows = () => findAll(box.strip, n => n.attrs.class && /^bg-pi/.test(n.attrs.class));
  return { calls, clock, box, paint, stops, rows, ctx };
}
const task = (id, kind) => ({ id, kind, description: id + ' work', startedAt: 999000, toolUseId: null, awaited: false, progress: null, owed: false });

test('popover: each live task gets a Stop button only when the runner supports it', () => {
  const live = { snap: { state: 'idle', tasks: [task('b1', 'shell'), task('a1', 'agent')], stopTask: true } };
  const ui = bootUi(live);
  ui.paint();
  assert.deepStrictEqual(ui.stops().map(b => [b.attrs['aria-label'], textOf(b), b.attrs.disabled]), [['Stop command', 'Stop', false], ['Stop agent', 'Stop', false]]);
  live.snap = { state: 'idle', tasks: [task('b1', 'shell')] };
  ui.paint();
  assert.strictEqual(ui.rows().length, 1); assert.deepStrictEqual(ui.stops(), []);
  live.snap = { state: 'idle', tasks: [{ ...task('b1', 'shell'), owed: true }], stopTask: true };
  ui.paint();
  assert.deepStrictEqual(ui.stops(), []);
});

test('popover: Stop is disabled while the request is in flight and after it, and the row goes once the roster drops the task', async () => {
  const live = { snap: { state: 'idle', tasks: [task('b1', 'shell'), task('a1', 'agent')], stopTask: true } };
  const ui = bootUi(live);
  ui.paint();
  ui.stops()[0].attrs.onclick({ stopPropagation() {} });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ui.calls.map(c => [c.ep, c.body]))), [['hl-task-stop', { session: 'claude-chat-x', id: 'b1' }]]);
  assert.deepStrictEqual(ui.stops().map(b => [textOf(b), b.attrs.disabled]), [['Stopping…', true], ['Stop', false]]);
  ui.stops()[0].attrs.onclick({ stopPropagation() {} });
  assert.strictEqual(ui.calls.length, 1);
  ui.calls[0].resolve({ ok: true });
  await sleep(0);
  assert.deepStrictEqual(ui.stops().map(b => [textOf(b), b.attrs.disabled]), [['Stopping…', true], ['Stop', false]]);
  live.snap = { ...live.snap, tasks: [task('a1', 'agent')] };
  ui.paint();
  assert.deepStrictEqual(ui.rows().length, 1);
  assert.deepStrictEqual(ui.stops().map(b => [b.attrs['aria-label'], textOf(b)]), [['Stop agent', 'Stop']]);
});

test('popover: a failed stop shows its error on the row for a few seconds and the button works again', async () => {
  const live = { snap: { state: 'idle', tasks: [task('b1', 'shell')], stopTask: true } };
  const ui = bootUi(live);
  ui.paint();
  ui.stops()[0].attrs.onclick({ stopPropagation() {} });
  ui.calls[0].reject(new Error('no such background task'));
  await sleep(0);
  const err = findAll(ui.box.strip, n => /bg-err/.test(n.attrs.class || ''));
  assert.deepStrictEqual(err.map(textOf), ['Could not stop: no such background task']);
  assert.deepStrictEqual(ui.stops().map(b => [textOf(b), b.attrs.disabled]), [['Stop', false]]);
  ui.clock.now += 6000;
  ui.paint();
  assert.deepStrictEqual(findAll(ui.box.strip, n => /bg-err/.test(n.attrs.class || '')), []);
  ui.stops()[0].attrs.onclick({ stopPropagation() {} });
  assert.strictEqual(ui.calls.length, 2);
});
