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
const SID = '11111111-2222-4333-8444-555555555555';
const NODE = process.execPath;
const MARK = 'bd-shell-test';
const wait = ms => new Promise(r => setTimeout(r, ms));

function runner(t, extraEnv = {}, cwd = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-sh-')), home = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-sh-home-'));
  const sock = path.join(dir, 'run', 's.sock'), input = path.join(dir, 'input.jsonl'), pidf = path.join(dir, 'pid');
  const p = spawn(NODE, [RUNNER, '--sock', sock, '--cwd', cwd || dir, '--session-id', SID, '--start', 'new', '--claude', FAKE, '--name', 'claude-test'],
    { env: { ...process.env, HOME: home, SHELL: '/bin/sh', FAKE_INPUT: input, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', d => { log += d; });
  t.after(() => {
    try { p.kill('SIGKILL'); } catch {}
    const pid = fs.existsSync(pidf) ? +fs.readFileSync(pidf, 'utf8').trim() : 0;
    if (pid && alive(pid) && fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(MARK)) try { process.kill(pid, 'SIGKILL'); } catch {}
  });
  return { p, sock, dir, pidf, log: () => log, inputs: () => fs.existsSync(input) ? fs.readFileSync(input, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [] };
}

async function client(t, sock) {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await wait(20);
  const c = net.connect(sock); await new Promise((r, j) => { c.once('connect', r); c.once('error', j); });
  t.after(() => c.destroy());
  const evs = [], waiters = []; let buf = '', cid = 0;
  c.setEncoding('utf8');
  c.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const o = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); evs.push(o); for (const w of waiters.splice(0)) w(); } });
  const until = async (pred, ms = 6000) => {
    const end = Date.now() + ms;
    for (;;) { const hit = evs.find(pred); if (hit) return hit; if (Date.now() > end) throw new Error('timeout; got ' + JSON.stringify(evs.map(e => e.ev))); await new Promise(r => { waiters.push(r); setTimeout(r, 50); }); }
  };
  const op = o => { const id = 'c' + ++cid; c.write(JSON.stringify({ ...o, cid: id }) + '\n'); return until(e => (e.ev === 'ack' || e.ev === 'error') && e.cid === id); };
  const ended = id => until(e => e.ev === 'shell' && e.shell.id === id && e.shell.state !== 'running');
  const snap = async () => { const n = evs.length; c.write('{"op":"hello"}\n'); return until(e => e.ev === 'snapshot' && evs.indexOf(e) >= n); };
  return { c, evs, until, op, ended, snap };
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function pidOf(r) { for (let i = 0; i < 200 && !(fs.existsSync(r.pidf) && fs.readFileSync(r.pidf, 'utf8').trim()); i++) await wait(20); return +fs.readFileSync(r.pidf, 'utf8').trim(); }
async function gone(pid) { for (let i = 0; i < 200 && alive(pid); i++) await wait(20); return !alive(pid); }
const lingering = (r, js = 'setTimeout(()=>{},60000)') => `${NODE} -e '${js}' ${MARK} & echo $! > ${r.pidf}; wait`;
const userInputs = (r, text) => r.inputs().filter(x => Array.isArray(x) ? x[x.length - 1].text === text : x === text);

test('shell: runs in the session folder with a clean env, streams output, and the next message carries it as bash blocks', async t => {
  const r = runner(t, { FAKE_NO_UUID: '1' }); const k = await client(t, r.sock);
  const cwd = fs.realpathSync(r.dir);
  const cmd = `pwd; echo "$TERM $NO_COLOR"; printf '\\033[31mred\\033[0m\\r\\n'; echo err >&2; ${NODE} -e 'setTimeout(()=>{},400)'; exit 3`;
  const ack = await k.op({ op: 'shell', cmd: '  ' + cmd + '  ' });
  assert.strictEqual(ack.ev, 'ack'); assert.match(ack.id, /^s-\d+$/);
  const started = k.evs.find(e => e.ev === 'shell' && e.shell.id === ack.id);
  assert.deepStrictEqual({ ...started.shell, at: 0 }, { id: ack.id, cmd, state: 'running', code: null, at: 0, end: null, out: '', cut: false, signal: null });
  await k.until(e => e.ev === 'shell-out' && e.id === ack.id);
  const end = (await k.ended(ack.id)).shell;
  assert.strictEqual(end.state, 'done'); assert.strictEqual(end.code, 3); assert.ok(end.end >= end.at);
  assert.match(end.out, new RegExp(`^${cwd}\\ndumb 1\\nred\\n`)); assert.match(end.out, /err\n/); assert.doesNotMatch(end.out, /[\x1b\r]/);
  const streamed = k.evs.filter(e => e.ev === 'shell-out' && e.id === ack.id).map(e => e.chunk).join('');
  assert.strictEqual(streamed, end.out);
  assert.deepStrictEqual((await k.snap()).shells, [end]);
  assert.match(r.log(), /\$ pwd; echo/); assert.match(r.log(), /\[exit 3\]/);
  await k.op({ op: 'send', text: 'hi' });
  await k.until(e => e.ev === 'shells' && !e.shells.length);
  await k.until(e => e.ev === 'result');
  assert.deepStrictEqual(userInputs(r, 'hi')[0], [
    { type: 'text', text: `<bash-input>${cmd}</bash-input>` },
    { type: 'text', text: `<bash-stdout>${cwd}\ndumb 1\nred\n</bash-stdout><bash-stderr>err\n\nExit code 3</bash-stderr>` },
    { type: 'text', text: 'hi' }]);
  assert.ok(k.evs.some(e => e.ev === 'inbox' && e.inbox.some(m => m.text === 'hi')));
  await k.until(e => e.ev === 'inbox' && !e.inbox.length);
  const after = await k.snap();
  assert.deepStrictEqual(after.shells, []); assert.deepStrictEqual(after.inbox, []);
  await k.op({ op: 'send', text: 'plain' }); await k.until(e => e.ev === 'result' && k.evs.filter(x => x.ev === 'result').length === 2);
  assert.strictEqual(userInputs(r, 'plain')[0], 'plain');
});

test('shell: one command at a time, a running one is not attached, stop kills the whole process group', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  const ack = await k.op({ op: 'shell', cmd: lingering(r) });
  const pid = await pidOf(r); assert.ok(alive(pid));
  assert.deepStrictEqual([(await k.op({ op: 'shell', cmd: 'echo two' })).error], ['a command is still running']);
  assert.strictEqual((await k.op({ op: 'shell-drop', id: ack.id })).error, 'the command is still running');
  await k.op({ op: 'send', text: 'hi' }); await k.until(e => e.ev === 'result');
  assert.strictEqual(userInputs(r, 'hi')[0], 'hi');
  assert.strictEqual((await k.snap()).shells[0].state, 'running');
  assert.strictEqual((await k.op({ op: 'shell-stop', id: 's-99' })).ev, 'error');
  assert.strictEqual((await k.op({ op: 'shell-stop', id: ack.id })).ev, 'ack');
  const end = (await k.ended(ack.id)).shell;
  assert.strictEqual(end.state, 'stopped'); assert.ok(await gone(pid));
  assert.match(r.log(), /\[stopped\]/);
  assert.strictEqual((await k.op({ op: 'shell-stop', id: ack.id })).error, 'no such running command');
  await k.op({ op: 'send', text: 'next' }); await k.until(e => e.ev === 'result' && k.evs.filter(x => x.ev === 'result').length === 2);
  assert.match(userInputs(r, 'next')[0][1].text, /<bash-stderr>\nStopped by the user<\/bash-stderr>$/);
  assert.strictEqual((await k.op({ op: 'shell', cmd: '   ' })).error, 'cmd must be 1..10000 chars');
  assert.strictEqual((await k.op({ op: 'shell', cmd: 'x'.repeat(10001) })).error, 'cmd must be 1..10000 chars');
});

test('shell: a command that ignores SIGTERM is killed with SIGKILL after 3 s', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  const ready = r.pidf + '.ready';
  const ack = await k.op({ op: 'shell', cmd: `trap '' TERM; ${lingering(r, `process.on("SIGTERM",()=>{});require("fs").writeFileSync("${ready}","");setTimeout(()=>{},60000)`)}` });
  const pid = await pidOf(r);
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await wait(20);
  const t0 = Date.now();
  await k.op({ op: 'shell-stop', id: ack.id });
  await wait(500); assert.ok(alive(pid));
  assert.strictEqual((await k.ended(ack.id)).shell.state, 'stopped');
  assert.ok(Date.now() - t0 >= 2900); assert.ok(await gone(pid));
});

test('shell: BD_HL_SHELL_MS times a command out and the note says so', async t => {
  const r = runner(t, { BD_HL_SHELL_MS: '1000' }); const k = await client(t, r.sock);
  const ack = await k.op({ op: 'shell', cmd: lingering(r) });
  const pid = await pidOf(r);
  const end = (await k.ended(ack.id)).shell;
  assert.strictEqual(end.state, 'timeout'); assert.ok(await gone(pid));
  assert.match(r.log(), /\[timed out\]/);
  await k.op({ op: 'send', text: 'hi' }); await k.until(e => e.ev === 'result');
  assert.match(userInputs(r, 'hi')[0][1].text, /<bash-stderr>\nTimed out after 1 s<\/bash-stderr>$/);
});

test('shell: drop removes a finished command so claude never gets it', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  const ack = await k.op({ op: 'shell', cmd: 'echo secret' });
  await k.ended(ack.id);
  assert.strictEqual((await k.op({ op: 'shell-drop', id: 's-99' })).error, 'no such command');
  assert.strictEqual((await k.op({ op: 'shell-drop', id: ack.id })).ev, 'ack');
  await k.until(e => e.ev === 'shells' && !e.shells.length);
  await k.op({ op: 'send', text: 'hi' }); await k.until(e => e.ev === 'result');
  assert.strictEqual(userInputs(r, 'hi')[0], 'hi');
});

test('shell: at most the last 5 finished commands are kept, oldest first', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  for (let i = 1; i <= 6; i++) await k.ended((await k.op({ op: 'shell', cmd: `echo n${i}` })).id);
  assert.deepStrictEqual((await k.snap()).shells.map(e => e.cmd), ['echo n2', 'echo n3', 'echo n4', 'echo n5', 'echo n6']);
  await k.op({ op: 'send', text: 'hi' }); await k.until(e => e.ev === 'result');
  const got = userInputs(r, 'hi')[0];
  assert.strictEqual(got.length, 11);
  assert.deepStrictEqual(got.filter((b, i) => i % 2 === 0 && i < 10).map(b => b.text), [2, 3, 4, 5, 6].map(i => `<bash-input>echo n${i}</bash-input>`));
  assert.strictEqual(got[1].text, '<bash-stdout>n2\n</bash-stdout><bash-stderr></bash-stderr>');
});

test('shell: a command killed by a signal we did not send ends done with the signal and a note', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  const ack = await k.op({ op: 'shell', cmd: 'kill -9 $$' });
  const end = (await k.ended(ack.id)).shell;
  assert.strictEqual(end.state, 'done'); assert.strictEqual(end.code, null); assert.strictEqual(end.signal, 'SIGKILL');
  assert.match(r.log(), /\[killed SIGKILL\]/);
  await k.op({ op: 'send', text: 'hi' }); await k.until(e => e.ev === 'result');
  assert.match(userInputs(r, 'hi')[0][1].text, /<bash-stderr>\nKilled by SIGKILL<\/bash-stderr>$/);
  const ok = await k.op({ op: 'shell', cmd: 'true' });
  assert.strictEqual((await k.ended(ok.id)).shell.signal, null);
});

test('shell: a slash command attaches nothing, the entries wait for the next message', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.ended((await k.op({ op: 'shell', cmd: 'echo waits' })).id);
  await k.op({ op: 'send', text: '/help' }); await k.until(e => e.ev === 'result');
  assert.strictEqual(userInputs(r, '/help')[0], '/help');
  assert.strictEqual((await k.snap()).shells.length, 1);
  await k.op({ op: 'send', text: 'real' }); await k.until(e => e.ev === 'result' && k.evs.filter(x => x.ev === 'result').length === 2);
  assert.deepStrictEqual(userInputs(r, 'real')[0].map(b => b.text), ['<bash-input>echo waits</bash-input>', '<bash-stdout>waits\n</bash-stdout><bash-stderr></bash-stderr>', 'real']);
});

test('shell: a message re-sent after a restart keeps its bash blocks', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'send', text: 'hang' }); await k.until(e => e.ev === 'delta');
  await k.ended((await k.op({ op: 'shell', cmd: 'echo kept' })).id);
  await k.op({ op: 'send', text: 'keep me' });
  await k.until(e => e.ev === 'inbox' && e.inbox.length === 1);
  await k.op({ op: 'restart' });
  await k.until(e => e.ev === 'result' && e.subtype === 'success');
  await k.until(e => e.ev === 'inbox' && !e.inbox.length);
  for (let i = 0; i < 200 && userInputs(r, 'keep me').length < 2; i++) await wait(20);
  const sent = userInputs(r, 'keep me');
  assert.strictEqual(sent.length, 2); assert.deepStrictEqual(sent[0], sent[1]);
  assert.deepStrictEqual(sent[0].map(b => b.text), ['<bash-input>echo kept</bash-input>', '<bash-stdout>kept\n</bash-stdout><bash-stderr></bash-stderr>', 'keep me']);
});

test('shell: output is capped at 64 KB with cut, claude gets the last 30000 chars of each stream with a cut note', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  const ack = await k.op({ op: 'shell', cmd: `${NODE} -e 'process.stdout.write("x".repeat(70000) + "END")'` });
  const end = (await k.ended(ack.id)).shell;
  assert.strictEqual(end.out.length, 64 * 1024); assert.ok(end.out.endsWith('xEND')); assert.strictEqual(end.cut, true);
  await k.op({ op: 'send', text: 'hi' }); await k.until(e => e.ev === 'result');
  const out = userInputs(r, 'hi')[0][1].text;
  assert.ok(out.startsWith('<bash-stdout>[… 40003 chars cut]\n' + 'x'.repeat(29997) + 'END</bash-stdout>'));
});

test('shell: SIGTERM to the runner kills a running command', async t => {
  const r = runner(t); const k = await client(t, r.sock);
  await k.op({ op: 'shell', cmd: lingering(r) });
  const pid = await pidOf(r);
  assert.strictEqual((await k.op({ op: 'send', text: 'hi' })).ev, 'ack');
  const exited = new Promise(res => r.p.on('exit', res));
  r.p.kill('SIGTERM'); await exited;
  assert.ok(await gone(pid));
});

test('shell: a shell that cannot start ends in error with the reason, $SHELL falls back to /bin/bash', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-sh-cwd-'));
  const r = runner(t, { SHELL: 'sh' }, cwd); const k = await client(t, r.sock);
  const a = await k.op({ op: 'shell', cmd: 'echo $0' });
  assert.match((await k.ended(a.id)).shell.out, /^\/bin\/bash\n/);
  fs.rmSync(cwd, { recursive: true, force: true });
  const b = await k.op({ op: 'shell', cmd: 'echo x' });
  const end = (await k.ended(b.id)).shell;
  assert.strictEqual(end.state, 'error'); assert.match(end.out, /^cannot run \/bin\/bash: .*ENOENT/); assert.match(r.log(), /\[failed\]/);
});

test('apply keeps snap.shells current: start, appended output with the 64 KB cap, state change, list', () => {
  const snap = { shells: [] }, e = { id: 's-1', cmd: 'x', state: 'running', code: null, at: 1, end: null, out: '', cut: false };
  headless.apply(snap, { ev: 'shell', shell: e });
  headless.apply(snap, { ev: 'shell-out', id: 's-1', chunk: 'a'.repeat(60000) });
  assert.strictEqual(snap.shells[0].cut, false);
  headless.apply(snap, { ev: 'shell-out', id: 's-1', chunk: 'b'.repeat(10000) });
  assert.strictEqual(snap.shells[0].out.length, 64 * 1024); assert.ok(snap.shells[0].out.endsWith('a' + 'b'.repeat(10000))); assert.strictEqual(snap.shells[0].cut, true);
  assert.strictEqual(e.out, '');
  headless.apply(snap, { ev: 'shell-out', id: 's-9', chunk: 'z' });
  headless.apply(snap, { ev: 'shell', shell: { ...e, state: 'done', code: 0, end: 2, out: 'final' } });
  assert.deepStrictEqual(snap.shells.map(x => [x.state, x.out]), [['done', 'final']]);
  headless.apply(snap, { ev: 'shell', shell: { ...e, id: 's-2' } });
  assert.deepStrictEqual(snap.shells.map(x => x.id), ['s-1', 's-2']);
  headless.apply(snap, { ev: 'shells', shells: [] });
  assert.deepStrictEqual(snap.shells, []);
  const old = {}; headless.apply(old, { ev: 'shell', shell: e }); assert.strictEqual(old.shells.length, 1);
});

test('client: shell input is checked before it reaches a runner', async () => {
  assert.deepStrictEqual(await headless.shell('claude-x', '  '), { ok: false, error: 'command must be 1..10000 chars' });
  assert.deepStrictEqual(await headless.shell('claude-x', 'x'.repeat(10001)), { ok: false, error: 'command must be 1..10000 chars' });
  assert.deepStrictEqual(await headless.shellStop('claude-x', 'nope'), { ok: false, error: 'bad command id' });
  assert.deepStrictEqual(await headless.shellDrop('claude-x', 5), { ok: false, error: 'bad command id' });
});
