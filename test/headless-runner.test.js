const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RUNNER = path.join(__dirname, '..', 'bin', 'headless-runner.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const SID = '11111111-2222-4333-8444-555555555555';

function runner(t, start = 'new', extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-hl-'));
  const sock = path.join(dir, 'run', 's.sock'), argsLog = path.join(dir, 'args.jsonl');
  const p = spawn(process.execPath, [RUNNER, '--sock', sock, '--cwd', dir, '--session-id', SID, '--start', start, '--claude', FAKE, '--name', 'claude-test'],
    { env: { ...process.env, FAKE_ARGS: argsLog, CLAUDE_CODE_CHILD_SESSION: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', d => { log += d; });
  t.after(() => { try { p.kill('SIGKILL'); } catch {} });
  return { p, sock, dir, argsLog, log: () => log, args: () => fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [] };
}

async function client(t, sock) {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 20));
  const c = net.connect(sock); await new Promise((r, j) => { c.once('connect', r); c.once('error', j); });
  t.after(() => c.destroy());
  const evs = []; const waiters = []; let buf = '', cid = 0;
  c.setEncoding('utf8');
  c.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const o = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); evs.push(o); for (const w of waiters.splice(0)) w(); } });
  const until = async (pred, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) { const hit = evs.find(pred); if (hit) return hit; if (Date.now() > end) throw new Error('timeout; got ' + JSON.stringify(evs.map(e => e.ev))); await new Promise(r => { waiters.push(r); setTimeout(r, 50); }); }
  };
  const op = o => { const id = 'c' + ++cid; c.write(JSON.stringify({ ...o, cid: id }) + '\n'); return until(e => (e.ev === 'ack' || e.ev === 'error') && e.cid === id); };
  const text = () => evs.filter(e => e.ev === 'delta').map(e => e.text).join('');
  return { c, evs, until, op, text, clear: () => evs.splice(0) };
}

test('hello, send and streamed deltas; child started with clean env and --session-id', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  k.c.write('{"op":"hello"}\n');
  const snap = await k.until(e => e.ev === 'snapshot');
  assert.strictEqual(snap.sessionId, SID); assert.strictEqual(snap.v, 2);
  assert.strictEqual((await k.op({ op: 'send', text: 'hi there' })).ev, 'ack');
  await k.until(e => e.ev === 'state' && e.state === 'working');
  const res = await k.until(e => e.ev === 'result');
  assert.strictEqual(res.subtype, 'success');
  assert.strictEqual(k.text(), 'Echo: hi there');
  await k.until(e => e.ev === 'state' && e.state === 'idle');
  await k.until(e => e.ev === 'rate');
  const a = r.args()[0];
  assert.ok(a.argv.includes('--session-id') && a.argv.includes(SID) && !a.argv.includes('--resume'));
  assert.ok(a.argv.includes('--permission-prompt-tool') && a.argv.includes('--include-partial-messages'));
  assert.strictEqual(a.child, null); assert.strictEqual(a.config, null);
  assert.match(r.log(), /you: hi there/); assert.match(r.log(), /Echo: hi there/);
  assert.doesNotMatch(r.log(), /^\s*[❯>]/m);
});

test('context: used from the last assistant usage, window from the result, /compact drops it to the post-compact size', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hi' });
  await k.until(e => e.ev === 'ctx' && e.ctx.used === 5020 && e.ctx.window === 1000000);
  await k.until(e => e.ev === 'state' && e.state === 'idle');
  k.clear(); await k.op({ op: 'send', text: '/compact' });
  await k.until(e => e.ev === 'ctx' && e.ctx.used === 1234 && e.ctx.window === 1000000);
  await k.until(e => e.ev === 'result');
  k.c.write('{"op":"hello"}\n');
  const snap = await k.until(e => e.ev === 'snapshot');
  assert.deepStrictEqual(snap.ctx, { used: 1234, window: 1000000 });
});

test('a message sent while working is injected into the running turn', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'slow' });
  await k.until(e => e.ev === 'tool' && e.id === 't1');
  await k.op({ op: 'send', text: 'also this' });
  await k.until(e => e.ev === 'result');
  assert.match(k.text(), /got: also this/);
  assert.strictEqual(k.evs.filter(e => e.ev === 'result').length, 1);
  const tool = k.evs.find(e => e.ev === 'tool'); assert.strictEqual(tool.what, 'Wait a bit');
  assert.ok(k.evs.some(e => e.ev === 'tool-done' && e.id === 't1' && !e.error));
  assert.match(r.log(), /you \(while working\): also this/);
});

test('interrupt ends the turn and the next message still works', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hang' });
  await k.until(e => e.ev === 'delta');
  await k.op({ op: 'interrupt' });
  const res = await k.until(e => e.ev === 'result');
  assert.strictEqual(res.reason, 'aborted_streaming');
  await k.until(e => e.ev === 'state' && e.state === 'idle');
  k.clear();
  await k.op({ op: 'send', text: 'again' });
  await k.until(e => e.ev === 'result');
  assert.strictEqual(k.text(), 'Echo: again');
});

test('a question becomes pending and the chosen answer reaches claude', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'ask' });
  const p = await k.until(e => e.ev === 'pending');
  assert.strictEqual(p.req.kind, 'question'); assert.strictEqual(p.req.questions[0].question, 'Which color?');
  const k2 = await client(t, r.sock); k2.c.write('{"op":"hello"}\n');
  const snap = await k2.until(e => e.ev === 'snapshot');
  assert.strictEqual(snap.pending[0].rid, p.req.rid); assert.strictEqual(snap.state, 'working');
  assert.strictEqual((await k.op({ op: 'answer', rid: 'nope', decision: 'allow' })).ev, 'error');
  await k.op({ op: 'answer', rid: p.req.rid, decision: 'allow', answers: { 'Which color?': 'Blue' } });
  await k.until(e => e.ev === 'resolved' && e.rid === p.req.rid);
  await k.until(e => e.ev === 'result');
  assert.strictEqual(k.text(), 'answer: {"Which color?":"Blue"}');
});

test('a permission denied with a message reaches claude as the tool error', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'perm' });
  const p = await k.until(e => e.ev === 'pending');
  assert.strictEqual(p.req.kind, 'permission'); assert.strictEqual(p.req.what, 'Write x.txt'); assert.strictEqual(p.req.suggestions[0].mode, 'acceptEdits');
  await k.op({ op: 'answer', rid: p.req.rid, decision: 'deny', message: 'not now' });
  await k.until(e => e.ev === 'result');
  assert.strictEqual(k.text(), 'denied: not now');
  assert.ok(k.evs.some(e => e.ev === 'tool-done' && e.error));
});

test('a plan approval is a question without questions; approving and declining both reach claude', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  k.c.write('{"op":"hello"}\n');
  await k.until(e => e.ev === 'snapshot');
  await k.op({ op: 'send', text: 'exitplan' });
  const first = await k.until(e => e.ev === 'pending');
  assert.strictEqual(first.req.kind, 'question'); assert.strictEqual(first.req.tool, 'ExitPlanMode');
  assert.strictEqual(first.req.questions, undefined); assert.match(first.req.input.plan, /first step/);
  assert.strictEqual((await k.op({ op: 'answer', rid: first.req.rid, decision: 'allow', answers: {} })).ev, 'ack');
  await k.until(e => e.ev === 'result');
  assert.match(k.text(), /plan approved/);
  k.clear();
  await k.op({ op: 'send', text: 'exitplan' });
  const second = await k.until(e => e.ev === 'pending');
  await k.op({ op: 'answer', rid: second.req.rid, decision: 'deny', message: 'The user wants to keep planning.' });
  await k.until(e => e.ev === 'result');
  assert.match(k.text(), /keep planning: The user wants to keep planning\./);
});

test('interrupting a pending question denies it and ends the turn', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'ask' });
  const p = await k.until(e => e.ev === 'pending');
  await k.op({ op: 'interrupt' });
  await k.until(e => e.ev === 'resolved' && e.rid === p.req.rid);
  await k.until(e => e.ev === 'result');
  k.c.write('{"op":"hello"}\n'); k.clear();
  const snap = await k.until(e => e.ev === 'snapshot');
  assert.deepStrictEqual(snap.pending, []);
});

test('a client that connects mid-turn gets the text streamed so far', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hang' });
  await k.until(e => e.ev === 'delta' && k.text().length >= 8);
  const k2 = await client(t, r.sock); k2.c.write('{"op":"hello"}\n');
  const snap = await k2.until(e => e.ev === 'snapshot');
  assert.strictEqual(snap.state, 'working'); assert.strictEqual(snap.turn.text, 'Thinking');
  await k.op({ op: 'interrupt' });
});

test('when claude dies the runner stays up and the next send resumes the session', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hello' }); await k.until(e => e.ev === 'result');
  await k.op({ op: 'send', text: 'crash' });
  await k.until(e => e.ev === 'state' && e.state === 'exited');
  k.c.write('{"op":"hello"}\n');
  const snap = await k.until(e => e.ev === 'snapshot' && e.state === 'exited');
  assert.match(snap.error, /fake crash/);
  k.clear();
  await k.op({ op: 'send', text: 'back' });
  await k.until(e => e.ev === 'result');
  assert.strictEqual(k.text(), 'Echo: back');
  const a = r.args(); assert.strictEqual(a.length, 2);
  assert.ok(a[1].argv.includes('--resume') && a[1].argv.includes(SID));
});

test('--start resume resumes, company account sets the config dir, unknown control requests get an error', async t => {
  const r = runner(t, 'resume'); const k = await client(t, r.sock);
  r.p.kill('SIGKILL');
  const r2 = (() => { const x = spawn(process.execPath, [RUNNER, '--sock', r.sock + '2', '--cwd', r.dir, '--session-id', SID, '--start', 'resume', '--claude', FAKE, '--account', 'company'], { env: { ...process.env, FAKE_ARGS: r.argsLog }, stdio: 'ignore' }); t.after(() => { try { x.kill('SIGKILL'); } catch {} }); return x; })();
  const k2 = await client(t, r.sock + '2');
  await k2.op({ op: 'send', text: 'hook' });
  await k2.op({ op: 'send', text: 'x' });
  await k2.until(e => e.ev === 'result');
  const a = r.args();
  assert.ok(a.filter(x => x.argv).every(x => x.argv.includes('--resume')));
  assert.ok(a.some(x => x.config && x.config.endsWith('.claude-company')));
  assert.ok(a.some(x => x.response && x.response.subtype === 'error' && x.response.request_id === 'h1'));
  assert.ok(k && r2);
});

test('bad input is rejected without killing the runner; SIGTERM removes the socket and stops claude', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  k.c.write('not json\n');
  await k.until(e => e.ev === 'error' && e.error === 'bad json');
  assert.strictEqual(fs.statSync(r.sock).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(r.sock)).mode & 0o777, 0o700);
  assert.strictEqual((await k.op({ op: 'send', text: '   ' })).ev, 'error');
  assert.strictEqual((await k.op({ op: 'nope' })).ev, 'error');
  await k.op({ op: 'send', text: 'hang' }); await k.until(e => e.ev === 'delta');
  const exited = new Promise(res => r.p.on('exit', res));
  r.p.kill('SIGTERM');
  await exited;
  assert.ok(!fs.existsSync(r.sock));
});

test('a runner replaced on the same socket path does not remove the new runner\'s socket when it exits', async t => {
  const a = runner(t); await client(t, a.sock);
  const b = spawn(process.execPath, [RUNNER, '--sock', a.sock, '--cwd', a.dir, '--session-id', SID, '--start', 'resume', '--claude', FAKE, '--name', 'claude-test'],
    { env: { ...process.env, FAKE_ARGS: a.argsLog }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { b.kill('SIGKILL'); } catch {} });
  const ino = fs.statSync(a.sock).ino;
  for (let i = 0; i < 100 && (!fs.existsSync(a.sock) || fs.statSync(a.sock).ino === ino); i++) await new Promise(r => setTimeout(r, 20));
  const exited = new Promise(res => a.p.on('exit', res));
  a.p.kill('SIGHUP'); await exited;
  assert.ok(fs.existsSync(a.sock));
  const kb = await client(t, a.sock);
  kb.c.write(JSON.stringify({ op: 'hello' }) + '\n'); await kb.until(e => e.ev === 'snapshot');
});

test('a runner whose socket file is removed listens again', async t => {
  const r = runner(t); const first = await client(t, r.sock);
  first.c.write(JSON.stringify({ op: 'hello' }) + '\n'); await first.until(e => e.ev === 'snapshot');
  fs.unlinkSync(r.sock);
  for (let i = 0; i < 150 && !fs.existsSync(r.sock); i++) await new Promise(res => setTimeout(res, 20));
  const k = await client(t, r.sock);
  k.c.write(JSON.stringify({ op: 'hello' }) + '\n'); await k.until(e => e.ev === 'snapshot');
  await k.op({ op: 'send', text: 'hi' }); await k.until(e => e.ev === 'delta');
});

test('a runner that is stopping refuses new messages instead of losing them', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'stubborn' }); await k.until(e => e.ev === 'delta');
  r.p.kill('SIGHUP'); await new Promise(res => setTimeout(res, 300));
  const late = await k.op({ op: 'send', text: 'too late' });
  assert.deepStrictEqual([late.ev, late.error], ['error', 'runner is stopping']);
});

test('child env drops CLAUDE_CODE_* except the compact window, and child files keep the normal umask', async t => {
  const touch = path.join(os.tmpdir(), `bd-hl-touch-${process.pid}`);
  t.after(() => { try { fs.unlinkSync(touch); } catch {} });
  const r = runner(t, 'new', { CLAUDE_CODE_OTHER: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '5', FAKE_TOUCH: touch });
  const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hi' }); await k.until(e => e.ev === 'result');
  const a = r.args()[0];
  assert.strictEqual(a.other, null); assert.strictEqual(a.window, '5');
  const mask = process.umask(); process.umask(mask);
  assert.strictEqual(fs.statSync(touch).mode & 0o777, 0o666 & ~mask);
});

test('resume of a conversation that was never saved falls back to a new session and keeps the message', async t => {
  const r = runner(t, 'resume', { FAKE_NO_CONV: '1' }); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'first' });
  await k.until(e => e.ev === 'result');
  assert.strictEqual(k.text(), 'Echo: first');
  const a = r.args().filter(x => x.argv);
  assert.ok(a[0].argv.includes('--resume'));
  assert.ok(a[a.length - 1].argv.includes('--session-id') && a[a.length - 1].argv.includes(SID));
  k.c.write('{"op":"hello"}\n');
  const snap = await k.until(e => e.ev === 'snapshot');
  assert.strictEqual(snap.error, null);
});

test('restart ends the turn, and a message sent during the restart goes to the new claude only', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hang' }); await k.until(e => e.ev === 'delta');
  await k.op({ op: 'restart' });
  await k.op({ op: 'send', text: 'after' });
  const res = await k.until(e => e.ev === 'result');
  assert.strictEqual(res.subtype, 'restarted');
  await k.until(e => e.ev === 'result' && e.subtype === 'success');
  assert.match(k.text(), /Echo: after$/);
  const a = r.args().filter(x => x.argv);
  assert.strictEqual(a.length, 2); assert.ok(a[1].argv.includes('--resume'));
});

test('model and effort switch live, carry over a restart as --model / --effort, and unknown values are rejected', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hi' }); await k.until(e => e.ev === 'result');
  await k.until(e => e.ev === 'snapshot' && e.model === 'fake-model' && e.effort === 'high');
  assert.strictEqual((await k.op({ op: 'model', model: 'sonnet' })).ev, 'ack');
  assert.strictEqual((await k.op({ op: 'effort', effort: 'max' })).ev, 'ack');
  await k.until(e => e.ev === 'snapshot' && e.model === 'claude-sonnet-9' && e.effort === 'max');
  assert.strictEqual((await k.op({ op: 'model', model: 'gpt' })).ev, 'error');
  assert.strictEqual((await k.op({ op: 'effort', effort: 'turbo' })).ev, 'error');
  assert.match(r.log(), /model sonnet/); assert.match(r.log(), /effort max/);
  k.clear();
  await k.op({ op: 'restart' }); await k.op({ op: 'send', text: 'again' });
  await k.until(e => e.ev === 'result' && e.subtype === 'success');
  const a = r.args().filter(x => x.argv);
  assert.strictEqual(a.length, 2);
  assert.deepStrictEqual(a[1].argv.slice(a[1].argv.indexOf('--model')), ['--model', 'sonnet', '--effort', 'max']);
  await k.until(e => e.ev === 'snapshot' && e.model === 'claude-sonnet-9' && e.effort === 'max');
});

test('a claude binary that cannot be started ends in exited with an error, and the runner stays up', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-hl-'));
  const sock = path.join(dir, 's.sock');
  const p = spawn(process.execPath, [RUNNER, '--sock', sock, '--cwd', dir, '--session-id', SID, '--start', 'new', '--claude', path.join(dir, 'no-such-claude')], { env: { ...process.env, PATH: dir }, stdio: 'ignore' });
  t.after(() => { try { p.kill('SIGKILL'); } catch {} });
  const k = await client(t, sock);
  await k.op({ op: 'send', text: 'x' });
  await k.until(e => e.ev === 'state' && e.state === 'exited');
  k.c.write('{"op":"hello"}\n');
  const snap = await k.until(e => e.ev === 'snapshot' && e.state === 'exited');
  assert.match(snap.error, /cannot start/); assert.strictEqual(snap.turn, null);
  assert.strictEqual((await k.op({ op: 'send', text: 'y' })).ev, 'ack');
});

test('a pinned claude path that is gone falls back to claude from PATH and keeps the message', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-hl-'));
  const sock = path.join(dir, 's.sock'), bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
  const p = spawn(process.execPath, [RUNNER, '--sock', sock, '--cwd', dir, '--session-id', SID, '--start', 'new', '--claude', path.join(dir, 'gone', '2.0.0')], { env: { ...process.env, PATH: bin + ':/usr/bin:/bin' }, stdio: 'ignore' });
  t.after(() => { try { p.kill('SIGKILL'); } catch {} });
  const k = await client(t, sock);
  await k.op({ op: 'send', text: 'hello' });
  await k.until(e => e.ev === 'result');
  assert.ok(k.text().length > 0);
});

function fakeVersion(dir, ver) {
  const f = path.join(dir, ver);
  fs.writeFileSync(f, `#!/bin/sh\nFAKE_VERSION=${ver} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
  return f;
}

test('upgrade while idle restarts claude now on the new binary and keeps the conversation', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hello' }); await k.until(e => e.ev === 'result');
  await k.until(e => e.ev === 'state' && e.state === 'idle');
  const bin = fakeVersion(r.dir, '7.7.7');
  const ack = await k.op({ op: 'upgrade', claude: bin });
  assert.strictEqual(ack.ev, 'ack'); assert.strictEqual(ack.when, 'now');
  for (let i = 0; i < 100 && r.args().length < 2; i++) await new Promise(res => setTimeout(res, 20));
  const a = r.args(); assert.strictEqual(a.length, 2); assert.ok(a[1].argv.includes('--resume') && a[1].argv.includes(SID));
  k.clear();
  await k.op({ op: 'send', text: 'again' }); await k.until(e => e.ev === 'result');
  assert.strictEqual(k.text(), 'Echo: again');
  k.c.write('{"op":"hello"}\n');
  const snap = await k.until(e => e.ev === 'snapshot' && e.version === '7.7.7');
  assert.strictEqual(snap.claude, bin);
});

test('upgrade during a turn waits for the result, then restarts on the new binary', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'slow' }); await k.until(e => e.ev === 'tool');
  const bin = fakeVersion(r.dir, '7.7.8');
  const ack = await k.op({ op: 'upgrade', claude: bin });
  assert.strictEqual(ack.when, 'after-turn');
  const res = await k.until(e => e.ev === 'result');
  assert.strictEqual(res.subtype, 'success');
  assert.strictEqual(r.args().length, 1);
  for (let i = 0; i < 150 && r.args().length < 2; i++) await new Promise(res2 => setTimeout(res2, 20));
  assert.strictEqual(r.args().length, 2);
  await k.op({ op: 'send', text: 'next' });
  await k.until(e => e.ev === 'snapshot' && e.version === '7.7.8');
  assert.ok(k.evs.filter(e => e.ev === 'result').every(e => e.subtype !== 'restarted'));
});

test('upgrade after claude exited applies at the next start; a bad path is refused', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'crash' });
  await k.until(e => e.ev === 'state' && e.state === 'exited');
  const bad = await k.op({ op: 'upgrade', claude: 'claude' });
  assert.strictEqual(bad.ev, 'error');
  assert.strictEqual((await k.op({ op: 'upgrade', claude: path.join(r.dir, 'missing') })).ev, 'error');
  const bin = fakeVersion(r.dir, '7.7.9');
  assert.strictEqual((await k.op({ op: 'upgrade', claude: bin })).when, 'next-start');
  assert.strictEqual(r.args().length, 1);
  await k.op({ op: 'send', text: 'back' });
  await k.until(e => e.ev === 'snapshot' && e.version === '7.7.9');
  await k.until(e => e.ev === 'result' && e.subtype === 'success');
  assert.strictEqual(r.args().length, 2);
});

test('a message sent during the upgrade restart runs as a working turn that can be interrupted', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  const bin = fakeVersion(r.dir, '7.8.0');
  assert.strictEqual((await k.op({ op: 'upgrade', claude: bin })).when, 'now');
  await k.op({ op: 'send', text: 'hang' });
  await k.until(e => e.ev === 'delta');
  k.c.write('{"op":"hello"}\n');
  const snap = await k.until(e => e.ev === 'snapshot' && e.turn);
  assert.strictEqual(snap.state, 'working');
  await k.op({ op: 'interrupt' });
  const res = await k.until(e => e.ev === 'result' && e.subtype !== 'restarted');
  assert.strictEqual(res.reason, 'aborted_streaming');
});

test('a message injected into the waiting turn defers the upgrade to the next result; a second upgrade replaces the first', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'slow' }); await k.until(e => e.ev === 'tool');
  assert.strictEqual((await k.op({ op: 'upgrade', claude: fakeVersion(r.dir, '7.8.1') })).when, 'after-turn');
  const bin = fakeVersion(r.dir, '7.8.2');
  assert.strictEqual((await k.op({ op: 'upgrade', claude: bin })).when, 'after-turn');
  await k.op({ op: 'send', text: 'also this' });
  await k.until(e => e.ev === 'result');
  await new Promise(res => setTimeout(res, 2000));
  assert.strictEqual(r.args().length, 1);
  k.clear();
  await k.op({ op: 'send', text: 'next' }); await k.until(e => e.ev === 'result');
  for (let i = 0; i < 150 && r.args().length < 2; i++) await new Promise(res => setTimeout(res, 20));
  assert.strictEqual(r.args().length, 2);
  await k.op({ op: 'send', text: 'then' });
  const snap = await k.until(e => e.ev === 'snapshot' && e.version);
  assert.strictEqual(snap.version, '7.8.2'); assert.strictEqual(snap.claude, bin);
});

test('findTranscript: the known file wins, then a walk up from the folder, then any project dir; dir is always the session folder', async t => {
  const { findTranscript, transcriptOf } = require('../lib/headless');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-home-')); const was = process.env.HOME; process.env.HOME = home; t.after(() => { process.env.HOME = was; });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-cwd-')); const sub = path.join(base, 'org', 'proj'); fs.mkdirSync(sub, { recursive: true });
  const put = f => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{}\n'); return f; };
  assert.strictEqual(findTranscript(sub, 'personal', SID, null), null);
  const atBase = put(transcriptOf(base, 'personal', SID));
  assert.deepStrictEqual(findTranscript(sub, 'personal', SID, null), { dir: sub, file: atBase });
  const known = put(path.join(home, '.claude', 'projects', '-elsewhere', SID + '.jsonl'));
  assert.deepStrictEqual(findTranscript(sub, 'personal', SID, known), { dir: sub, file: known });
  fs.rmSync(atBase);
  assert.deepStrictEqual(findTranscript(sub, 'personal', SID, null), { dir: sub, file: known });
  assert.deepStrictEqual(findTranscript(sub, 'personal', SID, '/etc/' + SID + '.jsonl'), { dir: sub, file: known });
  assert.deepStrictEqual(findTranscript(path.join(base, 'gone'), 'personal', SID, known), { dir: null, file: known });
  assert.strictEqual(findTranscript(sub, 'company', SID, known), null);
  assert.strictEqual(findTranscript(sub, 'personal', 'not-a-uuid', known), null);
});

test('chat names: claude-chat-YYMMDD-HHMM, -n on collision, -company suffix', async () => {
  const { chatName } = require('../lib/headless');
  const d = new Date(2026, 9, 29, 9, 5);
  assert.strictEqual(await chatName(d, 'personal', async () => false), 'claude-chat-261029-0905');
  assert.strictEqual(await chatName(d, 'company', async () => false), 'claude-chat-261029-0905-company');
  const taken = new Set(['claude-chat-261029-0905', 'claude-chat-261029-0905-2']);
  assert.strictEqual(await chatName(d, 'personal', async n => taken.has(n)), 'claude-chat-261029-0905-3');
});

test('/clear moves the chat to the new conversation id: snapshot follows it and a restart resumes it, not the first id', async t => {
  const NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const r = runner(t, 'resume', { FAKE_CLEAR_ID: NEW }); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hello' }); await k.until(e => e.ev === 'result');
  k.clear(); await k.op({ op: 'send', text: '/clear' });
  const moved = await k.until(e => e.ev === 'snapshot' && e.sessionId === NEW);
  assert.strictEqual(moved.v, 2);
  await k.until(e => e.ev === 'result');
  assert.match(r.log(), new RegExp(`conversation is now ${NEW} \\(was ${SID}\\)`));
  k.clear(); await k.op({ op: 'restart' });
  await k.until(e => e.ev === 'snapshot' && e.sessionId === NEW && e.childAt > 0 && e.state === 'idle');
  await k.op({ op: 'send', text: 'after' }); await k.until(e => e.ev === 'result');
  const a = r.args().filter(x => x.argv);
  assert.ok(a[a.length - 1].argv.includes('--resume') && a[a.length - 1].argv.includes(NEW) && !a[a.length - 1].argv.includes(SID));
  assert.match(r.log(), new RegExp(`claude resume ${NEW}`));
});

test('the snapshot knows the version right after a start, from the binary path or from claude on PATH', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-hl-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const versions = path.join(dir, 'versions'), bin = path.join(dir, 'bin'); fs.mkdirSync(versions); fs.mkdirSync(bin);
  const v1 = fakeVersion(versions, '3.4.5'); fs.symlinkSync(v1, path.join(bin, 'claude'));
  const sock = path.join(dir, 'run', 's.sock');
  const p = spawn(process.execPath, [RUNNER, '--sock', sock, '--cwd', dir, '--session-id', SID, '--start', 'new'], { env: { ...process.env, PATH: bin + ':/usr/bin:/bin' }, stdio: 'ignore' });
  t.after(() => { try { p.kill('SIGKILL'); } catch {} });
  const k = await client(t, sock);
  k.c.write('{"op":"hello"}\n');
  const first = await k.until(e => e.ev === 'snapshot');
  assert.strictEqual(first.claude, 'claude'); assert.strictEqual(first.version, '3.4.5'); assert.ok(first.childAt > 0);
  const v2 = fakeVersion(versions, '3.4.6');
  assert.strictEqual((await k.op({ op: 'restart', claude: 'claude' })).ev, 'error');
  k.clear(); const t0 = Date.now();
  assert.strictEqual((await k.op({ op: 'restart', claude: v2 })).ev, 'ack');
  const after = await k.until(e => e.ev === 'snapshot' && e.childAt >= t0);
  assert.strictEqual(after.version, '3.4.6'); assert.strictEqual(after.claude, v2);
});

test('--start fork forks the old conversation into the new id once, then resumes the new id', async t => {
  const OLD = '99999999-8888-4777-8666-555555555555';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-hl-home-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-hl-')); const sock = path.join(dir, 'run', 's.sock'), argsLog = path.join(dir, 'args.jsonl');
  const p = spawn(process.execPath, [RUNNER, '--sock', sock, '--cwd', dir, '--session-id', SID, '--start', 'fork', '--fork-from', OLD, '--claude', FAKE],
    { env: { ...process.env, HOME: home, FAKE_ARGS: argsLog }, stdio: 'ignore' });
  t.after(() => { try { p.kill('SIGKILL'); } catch {} });
  const k = await client(t, sock);
  await k.op({ op: 'send', text: 'x' }); await k.until(e => e.ev === 'result');
  const tdir = path.join(home, '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(tdir, { recursive: true }); fs.writeFileSync(path.join(tdir, SID + '.jsonl'), '{}\n');
  await k.op({ op: 'send', text: 'crash' }); await k.until(e => e.ev === 'state' && e.state === 'exited');
  k.clear(); await k.op({ op: 'send', text: 'y' }); await k.until(e => e.ev === 'result');
  const a = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.argv);
  const tail = x => x.argv.slice(x.argv.indexOf('--dangerously-skip-permissions') + 1);
  assert.deepStrictEqual(tail(a[0]), ['--resume', OLD, '--fork-session', '--session-id', SID]);
  assert.deepStrictEqual(tail(a[a.length - 1]), ['--resume', SID]);

  const bad = spawn(process.execPath, [RUNNER, '--sock', sock + 'b', '--cwd', dir, '--session-id', SID, '--start', 'fork', '--claude', FAKE], { stdio: 'ignore' });
  assert.strictEqual(await new Promise(r => bad.on('exit', r)), 2);
});

const logged = r => r.args().filter(x => x.argv).length;
const inboxIds = k => k.evs.filter(e => e.ev === 'inbox').map(e => e.inbox.map(m => m.id).join(','));

test('inbox: a send is acked with its id, waits in the inbox while claude works and leaves it when claude replays it', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  const first = await k.op({ op: 'send', text: 'slow' });
  assert.strictEqual(first.id, 'm-1');
  await k.until(e => e.ev === 'tool' && e.id === 't1');
  assert.deepStrictEqual(inboxIds(k).slice(0, 2), ['m-1', '']);
  assert.ok(r.args()[0].argv.includes('--replay-user-messages'));
  const ack = await k.op({ op: 'send', text: '  also this  ' });
  assert.strictEqual(ack.id, 'm-2');
  const waiting = await k.until(e => e.ev === 'inbox' && e.inbox.length === 1 && e.inbox[0].id === 'm-2');
  assert.deepStrictEqual(Object.keys(waiting.inbox[0]).sort(), ['at', 'id', 'text']);
  assert.strictEqual(waiting.inbox[0].text, '  also this  '); assert.ok(Math.abs(waiting.inbox[0].at - Date.now()) < 5000);
  const k2 = await client(t, r.sock); k2.c.write('{"op":"hello"}\n');
  const snap = await k2.until(e => e.ev === 'snapshot');
  assert.deepStrictEqual(snap.inbox.map(m => m.id), ['m-2']);
  await k.until(e => e.ev === 'result');
  assert.deepStrictEqual(inboxIds(k).slice(-1), ['']);
  assert.match(r.log(), /claude took in: also this/);
});

test('inbox: messages still waiting at an interrupt are replayed together as the next turn and leave the inbox', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hang' }); await k.until(e => e.ev === 'delta');
  await k.op({ op: 'send', text: 'first' }); await k.op({ op: 'send', text: 'second' });
  await k.until(e => e.ev === 'inbox' && e.inbox.map(m => m.id).join(',') === 'm-2,m-3');
  k.clear();
  await k.op({ op: 'interrupt' });
  await k.until(e => e.ev === 'result' && e.reason === 'aborted_streaming');
  await k.until(e => e.ev === 'inbox' && !e.inbox.length);
  await k.until(e => e.ev === 'result' && e.subtype === 'success');
  assert.strictEqual(k.text(), 'Echo: first\nsecond');
  k.c.write('{"op":"hello"}\n');
  assert.deepStrictEqual((await k.until(e => e.ev === 'snapshot')).inbox, []);
});

test('inbox: messages claude never took in are dropped and logged when claude exits', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'die' }); await k.until(e => e.ev === 'delta');
  await k.op({ op: 'send', text: 'lost one' });
  await k.until(e => e.ev === 'inbox' && e.inbox.length === 1);
  await k.until(e => e.ev === 'state' && e.state === 'exited');
  await k.until(e => e.ev === 'inbox' && !e.inbox.length);
  assert.match(r.log(), /not taken in \(claude exited\): lost one/);
  k.clear(); await k.op({ op: 'send', text: 'back' }); await k.until(e => e.ev === 'result');
  assert.strictEqual(k.text(), 'Echo: back');
});

test('inbox: a restart sends the waiting messages to the new claude under the same id', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hang' }); await k.until(e => e.ev === 'delta');
  await k.op({ op: 'send', text: 'keep me' });
  await k.until(e => e.ev === 'inbox' && e.inbox.length === 1);
  k.clear();
  await k.op({ op: 'restart' });
  await k.until(e => e.ev === 'result' && e.subtype === 'success');
  assert.strictEqual(k.text(), 'Echo: keep me');
  assert.deepStrictEqual(inboxIds(k), ['']);
  const a = r.args().filter(x => x.argv); assert.strictEqual(a.length, 2); assert.ok(a[1].argv.includes('--resume'));
  assert.match(r.log(), /sending again 1 message claude had not taken in yet/);
});

test('inbox: a message sent during a restart waits in the inbox until the new claude takes it', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hang' }); await k.until(e => e.ev === 'delta');
  await k.op({ op: 'restart' });
  const ack = await k.op({ op: 'send', text: 'after' });
  assert.ok(k.evs.some(e => e.ev === 'inbox' && e.inbox.some(m => m.id === ack.id)));
  await k.until(e => e.ev === 'result' && e.subtype === 'success');
  assert.deepStrictEqual(inboxIds(k).slice(-1), ['']);
});

test('inbox: the echo is matched by uuid, so two messages with the same text each leave once', async t => {
  const r = runner(t, 'new', { BD_HL_SWEEP_MS: '60000' }); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hang' }); await k.until(e => e.ev === 'delta');
  await k.op({ op: 'send', text: 'same' }); await k.op({ op: 'send', text: 'same' });
  await k.until(e => e.ev === 'inbox' && e.inbox.map(m => m.id).join(',') === 'm-2,m-3');
  k.clear();
  await k.op({ op: 'interrupt' });
  await k.until(e => e.ev === 'result' && e.subtype === 'success');
  assert.deepStrictEqual(inboxIds(k), ['m-3', '']);
});

test('inbox: a slash command whose echo text never matches leaves by uuid; without a uuid it is swept after the turn', async t => {
  const r = runner(t, 'new', { BD_HL_SWEEP_MS: '60000' }); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: '/compact' });
  await k.until(e => e.ev === 'result');
  assert.deepStrictEqual(inboxIds(k), ['m-1', '']);
  const r2 = runner(t, 'new', { FAKE_NO_UUID: '1', BD_HL_SWEEP_MS: '300' }); const k2 = await client(t, r2.sock);
  await k2.op({ op: 'send', text: '/compact' });
  await k2.until(e => e.ev === 'result');
  assert.deepStrictEqual(inboxIds(k2), ['m-1']);
  await k2.until(e => e.ev === 'inbox' && !e.inbox.length, 3000);
  assert.match(r2.log(), /not taken in \(no echo from claude\): \/compact/);
  await k2.op({ op: 'restart' });
  for (let i = 0; i < 50 && logged(r2) < 2; i++) await new Promise(res => setTimeout(res, 20));
  assert.strictEqual(logged(r2), 2);
  assert.doesNotMatch(r2.log(), /sending again/);
});

test('inbox: a message claude ran without an echo is not sent again on restart; a newer one is, and the resumed claude only acks it', async t => {
  const seen = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-seen-')), 'seen');
  const r = runner(t, 'new', { BD_HL_SWEEP_MS: '60000', FAKE_SEEN: seen }); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'noecho' }); await k.until(e => e.ev === 'result');
  await k.op({ op: 'send', text: 'noecho-hang' }); await k.until(e => e.ev === 'delta' && e.text === 'Thin');
  assert.deepStrictEqual(inboxIds(k).slice(-1), ['m-1,m-2']);
  k.clear();
  await k.op({ op: 'restart' });
  await k.until(e => e.ev === 'inbox' && !e.inbox.length);
  assert.match(r.log(), /not taken in \(no echo from claude\): noecho\x1b/);
  assert.match(r.log(), /sending again 1 message/);
  await new Promise(res => setTimeout(res, 200));
  const k2 = await client(t, r.sock); k2.c.write('{"op":"hello"}\n');
  const snap = await k2.until(e => e.ev === 'snapshot');
  assert.strictEqual(snap.state, 'idle'); assert.strictEqual(snap.turn, null);
  assert.ok(!k.evs.some(e => e.ev === 'delta'));
});

test('inbox: a merged echo with an unrelated message between its parts takes only its parts, with or without uuids', async t => {
  for (const env of [{ FAKE_MERGED_ONLY: '1' }, { FAKE_MERGED_ONLY: '1', FAKE_NO_UUID: '1' }]) {
    const r = runner(t, 'new', { BD_HL_SWEEP_MS: '60000', ...env }); const k = await client(t, r.sock);
    await k.op({ op: 'send', text: 'hang' }); await k.until(e => e.ev === 'delta');
    await k.op({ op: 'send', text: 'first' }); await k.op({ op: 'send', text: 'aside' }); await k.op({ op: 'send', text: 'second' });
    await k.until(e => e.ev === 'inbox' && e.inbox.length === 3);
    k.clear();
    await k.op({ op: 'interrupt' });
    await k.until(e => e.ev === 'inbox' && !e.inbox.length);
    assert.deepStrictEqual(inboxIds(k), ['m-3', ''], JSON.stringify(env));
  }
});

test('inbox: an echo the old claude sends while a restart stops it still counts, so the message is not sent twice', async t => {
  const r = runner(t, 'new', { FAKE_TERM_ECHO: '1' }); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hang' }); await k.until(e => e.ev === 'delta');
  await k.op({ op: 'send', text: 'heard late' });
  await k.until(e => e.ev === 'inbox' && e.inbox.length === 1);
  k.clear();
  await k.op({ op: 'restart' });
  await k.until(e => e.ev === 'inbox' && !e.inbox.length);
  for (let i = 0; i < 50 && logged(r) < 2; i++) await new Promise(res => setTimeout(res, 20));
  assert.strictEqual(logged(r), 2);
  await new Promise(res => setTimeout(res, 200));
  assert.doesNotMatch(r.log(), /sending again/);
  assert.ok(!k.evs.some(e => e.ev === 'delta'));
});
