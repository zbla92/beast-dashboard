const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-spec-runs-')));
process.env.BD_TEST = '1';
process.env.BD_MIRROR = tmp;
process.env.XDG_RUNTIME_DIR = tmp;
process.env.HOME = tmp;
process.env.BD_HL_EXIT_MS = '150';
process.env.BD_SPECIALISTS_DIR = path.join(tmp, 'specialists');
fs.writeFileSync(path.join(tmp, 'claude-sessions.json'), '{}');
const PORT = 8796, procs = path.join(tmp, 'procs'), bin = path.join(tmp, 'bin');
const RUNNER = path.join(__dirname, '..', 'bin', 'headless-runner.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const FAKE_ARGS = path.join(tmp, 'fake-args.jsonl');
process.env.FAKE_ARGS = FAKE_ARGS;
fs.mkdirSync(procs); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
D=${JSON.stringify(procs)}
case "$1" in
  has-session) n="\${3#=}"; [ -f "$D/$n.pid" ] && kill -0 "$(cat "$D/$n.pid")" 2>/dev/null && exit 0; exit 1 ;;
  new-session)
    name=""; while [ $# -gt 1 ]; do [ "$1" = "-s" ] && name="$2"; shift; done
    cmd=$(printf '%s' "$1" | sed 's/^bash -ic /bash -c /')
    sh -c "exec $cmd" </dev/null >"$D/$name.log" 2>&1 &
    echo $! > "$D/$name.pid"; exit 0 ;;
  respawn-pane)
    name=""; while [ $# -gt 1 ]; do [ "$1" = "-t" ] && name="$2"; shift; done
    name="\${name#=}"; name="\${name%:}"
    [ -f "$D/$name.pid" ] && kill -9 "$(cat "$D/$name.pid")" 2>/dev/null
    cmd=$(printf '%s' "$1" | sed 's/^bash -ic /bash -c /')
    sh -c "exec $cmd" </dev/null >>"$D/$name.log" 2>&1 &
    echo $! > "$D/$name.pid"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
const PATH0 = process.env.PATH; process.env.PATH = bin + ':' + PATH0;

const store = require('../lib/specialists');
const claude = require('../lib/claude');
const headless = require('../lib/headless');
const { createRuns, transcriptText, finalOf, taskText } = require('../lib/specialist-runs');
const { createSpecialistApi } = require('../lib/specialist-api');
const { createTraining } = require('../lib/training');
const { readBody } = require('../lib/util');
headless.init({ port: PORT, test: true, claudeBin: FAKE });

const alive = name => { try { process.kill(+fs.readFileSync(path.join(procs, name + '.pid'), 'utf8'), 0); return true; } catch { return false; } };
const tmuxHas = async name => alive(name);
const fakeArgs = () => fs.existsSync(FAKE_ARGS) ? fs.readFileSync(FAKE_ARGS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(a => a.argv) : [];
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); } };
const status = code => e => e instanceof store.SpecialistError && e.status === code;

test.after(() => {
  for (const f of fs.readdirSync(procs).filter(f => f.endsWith('.pid'))) { try { process.kill(+fs.readFileSync(path.join(procs, f), 'utf8'), 'SIGKILL'); } catch {} }
  process.env.PATH = PATH0;
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
const fresh = (fields = {}) => store.create({ name: `s${++n}`, ...fields });
const runsReal = createRuns({ store, headless, tmuxHas, claudeGet: claude.get, goneMs: 50 });

test('runner: permission mode, add-dir, model and effort reach claude; bypass keeps --dangerously-skip-permissions', async t => {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  const args = path.join(dir, 'args.jsonl');
  const start = extra => new Promise(resolve => {
    const sock = path.join(dir, `s${extra.length}.sock`);
    const p = spawn(process.execPath, [RUNNER, '--sock', sock, '--cwd', dir, '--session-id', '11111111-2222-4333-8444-555555555555', '--start', 'new', '--claude', FAKE, ...extra], { env: { ...process.env, FAKE_ARGS: args }, stdio: 'ignore' });
    t.after(() => { try { p.kill('SIGKILL'); } catch {} });
    const tick = setInterval(() => { if (fs.existsSync(args) && fs.readFileSync(args, 'utf8').trim().split('\n').length >= 1 + (extra.length ? 1 : 0)) { clearInterval(tick); resolve(p); } }, 20);
  });
  await start([]);
  await start(['--permission-mode', 'dontAsk', '--add-dir', '/tmp/a', '--add-dir', '/tmp/b', '--model', 'haiku', '--effort', 'low']);
  const [plain, spec] = fs.readFileSync(args, 'utf8').trim().split('\n').map(l => JSON.parse(l).argv);
  assert.ok(plain.includes('--dangerously-skip-permissions') && !plain.includes('--permission-mode'));
  assert.ok(!spec.includes('--dangerously-skip-permissions'));
  assert.deepStrictEqual(spec.slice(spec.indexOf('--permission-mode'), spec.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk']);
  assert.ok(spec.includes('--permission-prompt-tool'));
  assert.deepStrictEqual(spec.filter((a, i) => spec[i - 1] === '--add-dir'), ['/tmp/a', '/tmp/b']);
  assert.strictEqual(spec[spec.indexOf('--model') + 1], 'haiku');
  assert.strictEqual(spec[spec.indexOf('--effort') + 1], 'low');
  const bad = spawn(process.execPath, [RUNNER, '--sock', path.join(dir, 'x.sock'), '--cwd', dir, '--session-id', '11111111-2222-4333-8444-555555555555', '--start', 'new', '--permission-mode', 'yolo'], { stdio: 'ignore' });
  assert.strictEqual(await new Promise(r => bad.on('exit', r)), 2);
});

async function exitRunner(t, sessionId, env) {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  const sock = path.join(dir, 's.sock');
  const p = spawn(process.execPath, [RUNNER, '--sock', sock, '--cwd', dir, '--session-id', sessionId, '--start', 'new', '--claude', FAKE, '--exit-after-result'], { env: { ...process.env, FAKE_ARGS: '', ...env }, stdio: 'ignore' });
  t.after(() => { try { p.kill('SIGKILL'); } catch {} });
  const exited = new Promise(r => p.on('exit', code => r(code)));
  await until(() => fs.existsSync(sock));
  const c = net.connect(sock); c.setEncoding('utf8');
  const evs = [], rest = { buf: '' };
  c.on('data', d => { const lines = (rest.buf + d).split('\n'); rest.buf = lines.pop(); for (const l of lines) evs.push(JSON.parse(l)); });
  c.on('error', () => {});
  await new Promise(r => c.once('connect', r));
  return { p, sock, c, evs, exited };
}

test('runner: the result event carries the final text, and --exit-after-result ends the runner cleanly', async t => {
  const { p, sock, c, evs, exited } = await exitRunner(t, '11111111-2222-4333-8444-555555555555', {});
  c.write(JSON.stringify({ op: 'send', text: 'hello', cid: 'a' }) + '\n');
  const res = await until(() => evs.find(e => e.ev === 'result'));
  assert.strictEqual(res.text, 'Echo: hello');
  assert.strictEqual(res.isError, false);
  assert.strictEqual(res.truncated, false);
  assert.strictEqual(await exited, 0);
  assert.ok(!fs.existsSync(sock));
});

test('runner: --exit-after-result waits for a follow-up still in its inbox, and an upgrade waits for the next start', async t => {
  const { p, c, evs, exited } = await exitRunner(t, '11111111-2222-4333-8444-555555555556', { BD_HL_SWEEP_MS: '900' });
  c.write(JSON.stringify({ op: 'send', text: 'a longer message so the turn takes a moment', cid: 'a' }) + '\n');
  await until(() => evs.find(e => e.ev === 'state' && e.state === 'working'));
  c.write(JSON.stringify({ op: 'send', text: 'follow-up', cid: 'b' }) + '\n');
  c.write(JSON.stringify({ op: 'upgrade', claude: FAKE, cid: 'u' }) + '\n');
  assert.strictEqual((await until(() => evs.find(e => e.cid === 'u'))).when, 'next-start');
  await until(() => evs.find(e => e.ev === 'result'));
  const at = Date.now();
  await new Promise(r => setTimeout(r, 500));
  assert.strictEqual(p.exitCode, null, 'the runner stays while a follow-up is open');
  assert.strictEqual(await exited, 0);
  assert.ok(Date.now() - at >= 700);
  assert.strictEqual(evs.filter(e => e.ev === 'result').length, 1);
});

test('runnerArgs maps profile settings to runner flags', () => {
  assert.deepStrictEqual(headless.runnerArgs({}), []);
  assert.deepStrictEqual(headless.runnerArgs(null), []);
  assert.strictEqual(headless.chatBase('spec-kit'), 'spec_kit');
  assert.strictEqual(headless.chatBase('my app'), 'my-app');
  assert.deepStrictEqual(headless.runnerArgs({ permissionMode: 'bypassPermissions', model: null, effort: null, addDirs: [] }), []);
  assert.deepStrictEqual(headless.runnerArgs({ permissionMode: 'plan', model: 'opus[1m]', effort: 'max', addDirs: ['/a'], exitAfterResult: true }),
    ['--permission-mode', 'plan', '--add-dir', '/a', '--model', 'opus[1m]', '--effort', 'max', '--exit-after-result']);
});

test('transcript fallback: the text blocks of the last main-thread assistant message after the prompt', () => {
  const f = path.join(tmp, 'tr.jsonl');
  const line = o => JSON.stringify(o);
  fs.writeFileSync(f, [
    line({ type: 'user', message: { role: 'user', content: 'first' } }),
    line({ type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'old answer' }] } }),
    line({ type: 'user', message: { role: 'user', content: 'second' } }),
    line({ type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: 'Part one.' }] } }),
    line({ type: 'assistant', message: { id: 'a2', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }),
    line({ type: 'assistant', isSidechain: true, message: { id: 's1', content: [{ type: 'text', text: 'subagent' }] } }),
    line({ type: 'assistant', message: { id: 'a3', content: [{ type: 'text', text: 'Final ' }] } }),
    line({ type: 'assistant', message: { id: 'a3', content: [{ type: 'text', text: 'answer' }] } }),
    'not json',
  ].join('\n') + '\n');
  assert.strictEqual(transcriptText(f), 'Final \nanswer');
  fs.appendFileSync(f, line({ type: 'user', message: { role: 'user', content: 'third' } }) + '\n');
  assert.strictEqual(transcriptText(f), null);
  assert.strictEqual(transcriptText(path.join(tmp, 'missing.jsonl')), null);
  assert.strictEqual(transcriptText('relative.jsonl'), null);
});

test('result mapping: success is done, interrupts are stopped, the rest is an error', () => {
  assert.deepStrictEqual(finalOf({ subtype: 'success', reason: 'completed', isError: false }), { state: 'done', error: null });
  assert.strictEqual(finalOf({ subtype: 'success', isError: true }).state, 'error');
  assert.strictEqual(finalOf({ subtype: 'error_during_execution', reason: 'aborted_streaming' }).state, 'stopped');
  assert.deepStrictEqual(finalOf({ subtype: 'exited', reason: '3' }), { state: 'error', error: 'claude exited (3)' });
  assert.strictEqual(finalOf({ subtype: 'error_max_turns', reason: 'max_turns' }).state, 'error');
});

test('task text: files are appended as a list and their folders become add-dirs; limits are checked', () => {
  const a = path.join(tmp, 'f1.txt'), b = path.join(tmp, 'sub', 'f2.txt');
  fs.mkdirSync(path.dirname(b), { recursive: true }); fs.writeFileSync(a, 'x'); fs.writeFileSync(b, 'y');
  assert.deepStrictEqual(taskText({ text: 'do it', files: [a, b, a] }, 100000), { text: `do it\n\nFiles for this task:\n- ${a}\n- ${b}`, addDirs: [tmp, path.dirname(b)] });
  assert.throws(() => taskText({ text: '  ' }, 100), status(400));
  assert.throws(() => taskText({ text: 'x', files: ['rel.txt'] }, 100), status(400));
  assert.throws(() => taskText({ text: 'x', files: [path.join(tmp, 'nope')] }, 100), status(400));
  assert.throws(() => taskText({ text: 'x', files: [tmp] }, 100), status(400));
  assert.throws(() => taskText({ text: 'x', files: Array(21).fill(a) }, 100000), status(400));
  assert.throws(() => taskText({ text: 'x'.repeat(101) }, 100), status(413));
});

test('run mode end to end: ask waits for the full text, the runner ends itself, send resumes the same run', async () => {
  const p = fresh({ permissionMode: 'dontAsk', model: 'haiku', effort: 'low' });
  const file = path.join(tmp, 'brief.md'); fs.writeFileSync(file, 'brief');
  const r = await runsReal.ask(p.name, { text: 'hi there', files: [file], wait: true, timeoutSec: 10 });
  assert.strictEqual(r.state, 'done');
  assert.strictEqual(r.text, `Echo: hi there\n\nFiles for this task:\n- ${file}`);
  assert.strictEqual(r.mode, 'run');
  assert.match(r.runId, new RegExp(`^claude-spec-${p.name}-\\d{6}-\\d{4}$`));
  assert.strictEqual(r.tmux, r.runId);
  assert.strictEqual(r.cwd, p.dir);
  assert.ok(r.endedAt >= r.startedAt);
  assert.match(r.sessionId, /^[0-9a-f-]{36}$/);
  const argv = fakeArgs().find(a => a.cwd === p.dir).argv;
  assert.ok(argv.includes('--permission-mode') && argv.includes('dontAsk') && !argv.includes('--dangerously-skip-permissions'));
  assert.strictEqual(argv[argv.indexOf('--add-dir') + 1], tmp);
  assert.strictEqual(argv[argv.indexOf('--model') + 1], 'haiku');
  assert.strictEqual(claude.get(r.tmux).specialist, p.name);
  assert.strictEqual(claude.info(r.tmux).specialist, p.name);
  await until(() => !alive(r.tmux));
  assert.strictEqual(store.getRun(r.runId).state, 'done');
  await assert.rejects(runsReal.send(r.runId, { text: 'x', bogus: 1 }), status(400));
  const again = await runsReal.send(r.runId, { text: 'and again', wait: true, timeoutSec: 10 });
  assert.strictEqual(again.state, 'done');
  assert.strictEqual(again.text, 'Echo: and again');
  assert.strictEqual(again.turns, 2);
  assert.strictEqual(again.runId, r.runId);
  const resumed = fakeArgs().filter(a => a.cwd === p.dir).pop().argv;
  assert.strictEqual(resumed[resumed.indexOf('--resume') + 1], r.sessionId);
  await until(() => !alive(r.tmux));
  const listed = await runsReal.list();
  const mine = listed.find(s => s.name === p.name);
  assert.strictEqual(mine.active, 0);
  assert.strictEqual(mine.lastRun.preview, 'Echo: and again');
  assert.strictEqual(mine.lastRun.text, undefined);
  assert.strictEqual(mine.thread, null);
});

test('send into a run that is still live goes to the same runner; a final run is required', async () => {
  const p = fresh();
  const r = await runsReal.ask(p.name, { text: 'hang' });
  assert.ok(['starting', 'working'].includes(r.state));
  await assert.rejects(runsReal.send(r.runId, { text: 'more' }), status(409));
  const waited = await runsReal.get(r.runId, { wait: true, timeoutSec: 1 });
  assert.strictEqual(waited.timedOut, true);
  assert.strictEqual(waited.state, 'working');
  await headless.interrupt(r.tmux);
  const ended = await runsReal.get(r.runId, { wait: true, timeoutSec: 5 });
  assert.strictEqual(ended.state, 'stopped');
  assert.strictEqual(ended.timedOut, undefined);
  await until(() => !alive(r.tmux));
});

test('own chat: opened once and resumed when gone, fresh starts a new conversation, calls stay runs, archive ends an idle chat only with endChat', async () => {
  const ended = [];
  const pid = name => +fs.readFileSync(path.join(procs, name + '.pid'), 'utf8');
  const endSession = async tmux => { ended.push(tmux); process.kill(pid(tmux), 'SIGTERM'); await until(() => !alive(tmux)); };
  const runs = createRuns({ store, headless, tmuxHas, claudeGet: claude.get, endSession, goneMs: 50 });
  const p = fresh({ mode: 'thread', title: 'Helper' });
  const tmux = `claude-spec-${p.name}`;
  const launches = () => fakeArgs().filter(a => a.cwd === p.dir);
  const idle = () => until(async () => { const L = await headless.status(tmux); return L && L.state === 'idle' && !L.turn; });
  const opened = await runs.chat(p.name, {});
  assert.strictEqual(opened.started, true);
  assert.deepStrictEqual(Object.keys(opened.thread), ['tmux', 'account', 'live', 'state', 'sessionId', 'transcriptPath', 'startedAt']);
  assert.deepStrictEqual([opened.thread.tmux, opened.thread.account, opened.thread.live], [tmux, 'personal', true]);
  assert.deepStrictEqual([claude.get(tmux).specialist, claude.get(tmux).firstPrompt, claude.get(tmux).runner.exitAfterResult], [p.name, 'Helper', false]);
  assert.strictEqual((await runs.chat(p.name, {})).started, false);
  assert.strictEqual(launches().length, 1);
  const call = await runs.ask(p.name, { text: 'one', wait: true, timeoutSec: 10 });
  assert.deepStrictEqual([call.mode, call.text, call.caller], ['run', 'Echo: one', null]);
  assert.notStrictEqual(call.tmux, tmux);
  await until(() => !alive(call.tmux));
  assert.ok(alive(tmux));
  assert.ok((await headless.send(tmux, 'hello')).ok);
  await idle();
  const info = await until(async () => { const x = (await runs.list()).find(s => s.name === p.name); return x.thread.state === 'idle' && x; });
  assert.deepStrictEqual([info.recentCalls.map(r => r.runId), 'trainer' in info], [[call.runId], false]);
  await assert.rejects(runs.archive(p.name), e => e.status === 409 && /live thread/.test(e.message));
  assert.ok((await headless.send(tmux, 'hang')).ok);
  await until(async () => (await runs.detail(p.name, 5)).thread.state === 'working');
  await assert.rejects(runs.chat(p.name, { fresh: true }), e => e.status === 409 && e.message === 'the bot is busy');
  await assert.rejects(runs.archive(p.name, { endChat: true }), e => e.status === 409 && /is busy in its chat/.test(e.message));
  await headless.interrupt(tmux);
  await idle();
  const thread = store.getThread(p.name);
  const tr = headless.transcriptOf(p.dir, 'personal', thread.sessionId);
  fs.mkdirSync(path.dirname(tr), { recursive: true }); fs.writeFileSync(tr, '');
  process.kill(pid(tmux), 'SIGTERM');
  await until(() => !alive(tmux));
  assert.strictEqual((await runs.detail(p.name, 5)).thread.live, false);
  const again = await runs.chat(p.name, {});
  assert.strictEqual(again.started, true);
  const resumed = launches().pop().argv;
  assert.strictEqual(resumed[resumed.indexOf('--resume') + 1], thread.sessionId);
  assert.deepStrictEqual([store.getThread(p.name).sessionId, store.getThread(p.name).startedAt], [thread.sessionId, thread.startedAt]);
  await idle();
  const renewed = await runs.chat(p.name, { fresh: true });
  assert.strictEqual(renewed.started, true);
  assert.notStrictEqual(renewed.thread.sessionId, thread.sessionId);
  assert.ok(!launches().pop().argv.includes('--resume'));
  await assert.rejects(runs.chat(p.name, { fresh: 'yes' }), status(400));
  await assert.rejects(runs.chat(p.name, { other: 1 }), status(400));
  await assert.rejects(runs.archive(p.name, { endChat: 1 }), status(400));
  await assert.rejects(runs.archive(p.name, { other: true }), status(400));
  await idle();
  assert.strictEqual((await runs.archive(p.name, { endChat: true })).name, p.name);
  assert.deepStrictEqual(ended, [tmux]);
});

function fakeHeadless() {
  const subs = new Map(), launched = [], sent = [];
  const up = new Set();
  const h = {
    launched, sent, up, snaps: new Map(),
    launch: async (name, cwd, account, opts) => { launched.push({ name, cwd, account, opts }); up.add(name); return { ok: true, name, existed: false, account, sessionId: opts.sessionId || '0b8f7a2c-1111-4222-8333-444455556666', transcriptPath: path.join(tmp, 'none.jsonl') }; },
    subscribe: (name, fn) => { subs.set(name, fn); return () => { if (subs.get(name) === fn) subs.delete(name); }; },
    waitForRunner: async () => ({ up: true }),
    send: async (name, text) => { sent.push({ name, text }); return { ok: true, id: 'm-1' }; },
    live: name => h.snaps.get(name) || null,
    status: async name => h.snaps.get(name) || null,
    locateTranscript: () => null,
    transcriptOf: (cwd, account, sid) => path.join(tmp, sid + '.jsonl'),
    emit: (name, o) => { const fn = subs.get(name); if (fn) fn(o); },
    subs,
  };
  return h;
}

test('fake runner: permission prompts move the run to waiting and back; a runner gone without result is stopped with the transcript text', async () => {
  const h = fakeHeadless();
  const runs = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name), goneMs: 10 });
  const p = fresh();
  const r = await runs.ask(p.name, { text: 'go' });
  assert.strictEqual(r.state, 'working');
  assert.strictEqual(h.launched[0].opts.specialist, p.name);
  assert.deepStrictEqual(h.launched[0].opts.runner, { permissionMode: 'bypassPermissions', model: null, effort: null, addDirs: [], exitAfterResult: true, accesses: p.dir, settings: path.join(p.dir, '.bd', 'call-settings.json') });
  h.snaps.set(r.tmux, { pending: [{ rid: 'q' }] });
  h.emit(r.tmux, { ev: 'pending', req: { rid: 'q' } });
  assert.strictEqual(store.getRun(r.runId).state, 'waiting');
  const timed = await runs.get(r.runId, { wait: true, timeoutSec: 1 });
  assert.deepStrictEqual([timed.state, timed.timedOut], ['waiting', true]);
  h.snaps.set(r.tmux, { pending: [] });
  h.emit(r.tmux, { ev: 'resolved', rid: 'q' });
  assert.strictEqual(store.getRun(r.runId).state, 'working');
  fs.writeFileSync(path.join(tmp, 'none.jsonl'), JSON.stringify({ type: 'assistant', message: { id: 'x', content: [{ type: 'text', text: 'half done' }] } }) + '\n');
  const waiting = runs.get(r.runId, { wait: true, timeoutSec: 5 });
  h.up.delete(r.tmux);
  h.emit(r.tmux, { ev: 'gone' });
  const ended = await waiting;
  assert.strictEqual(ended.state, 'stopped');
  assert.strictEqual(ended.text, 'half done');
  assert.ok(!h.subs.has(r.tmux));
  fs.rmSync(path.join(tmp, 'none.jsonl'));
});

test('fake runner: an error result, 4 active runs give 429, archive waits for active runs, boot stops runs whose session is gone', async () => {
  const h = fakeHeadless();
  const runs = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name), now: (() => { let t = Date.UTC(2026, 10, 11, 9, 0); return () => (t += 1000); })() });
  const p = fresh();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await runs.ask(p.name, { text: 'go ' + i })).runId);
  assert.strictEqual(new Set(ids).size, 4);
  assert.match(ids[1], /-2$/);
  await assert.rejects(runs.ask(p.name, { text: 'five' }), status(429));
  await assert.rejects(runs.archive(p.name), status(409));
  h.emit(ids[0], { ev: 'result', subtype: 'error_max_turns', reason: 'max_turns', text: '', isError: true });
  const e = store.getRun(ids[0]);
  assert.deepStrictEqual([e.state, e.error, e.text], ['error', 'error_max_turns: max_turns', null]);
  h.emit(ids[1], { ev: 'result', subtype: 'restarted', reason: 'restart' });
  assert.strictEqual(store.getRun(ids[1]).state, 'working');
  h.emit(ids[1], { ev: 'result', subtype: 'success', reason: 'completed', text: 'fine', isError: false });
  assert.deepStrictEqual([store.getRun(ids[1]).state, store.getRun(ids[1]).text], ['done', 'fine']);
  for (const id of ids) h.up.delete(id);
  const later = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name) });
  await later.boot();
  assert.deepStrictEqual(ids.map(id => store.getRun(id).state), ['error', 'done', 'stopped', 'stopped']);
  assert.strictEqual((await later.archive(p.name)).name, p.name);
});

test('fake runner: a send that hits a stopping runner waits for it to end and relaunches with --resume', async () => {
  const h = fakeHeadless();
  const runs = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name) });
  const p = fresh();
  const r = await runs.ask(p.name, { text: 'go' });
  h.emit(r.tmux, { ev: 'result', subtype: 'success', text: 'one', isError: false });
  let calls = 0;
  h.send = async (name, text) => { calls++; if (calls === 1) { setTimeout(() => h.up.delete(name), 100); return { ok: false, error: 'runner is stopping' }; } h.sent.push({ name, text }); return { ok: true }; };
  const s = await runs.send(r.runId, { text: 'two' });
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(s.turns, 2);
  assert.strictEqual(h.launched.length, 2);
  assert.deepStrictEqual([h.launched[1].opts.start, h.launched[1].opts.sessionId], ['resume', r.sessionId]);
  h.emit(r.tmux, { ev: 'result', subtype: 'success', text: 'two', isError: false });
  assert.strictEqual(store.getRun(r.runId).text, 'two');
});

test('fake runner: a resumed run gets only the folders of the files given at ask time, never folders named in copied task text', async () => {
  const h = fakeHeadless();
  const runs = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name) });
  const p = fresh();
  const given = fs.mkdtempSync(path.join(tmp, 'given-'));
  const named = fs.mkdtempSync(path.join(tmp, 'named-'));
  fs.writeFileSync(path.join(given, 'a.md'), 'a');
  fs.writeFileSync(path.join(named, 'b.md'), 'b');
  const copied = `Original material:\n> pasted\n\nFiles for this task:\n- ${named}/b.md\n\nmore words`;
  const r = await runs.ask(p.name, { text: copied, files: [path.join(given, 'a.md')] });
  assert.ok(!('addDirs' in r));
  assert.deepStrictEqual(h.launched[0].opts.runner.addDirs, [given]);
  assert.deepStrictEqual(store.getRun(r.runId).addDirs, [given]);
  const resume = async text => {
    h.emit(r.tmux, { ev: 'result', subtype: 'success', text: 'ok', isError: false });
    h.up.delete(r.tmux);
    const s = await runs.send(r.runId, { text });
    assert.ok(!('addDirs' in s));
    return h.launched[h.launched.length - 1].opts;
  };
  const first = await resume(`again\n\nFiles for this task:\n- ${named}/b.md`);
  assert.deepStrictEqual([first.start, first.runner.addDirs], ['resume', [given]]);
  const old = store.getRun(r.runId);
  store.saveRun({ ...old, addDirs: undefined });
  assert.strictEqual(store.getRun(r.runId).addDirs, null);
  store.saveRun({ ...store.getRun(r.runId), task: copied });
  const legacy = await resume('once more');
  assert.deepStrictEqual([legacy.start, legacy.runner.addDirs], ['resume', []]);
  assert.ok(store.listRuns(p.name).every(s => !('addDirs' in s)));
  const bare = await runs.ask(p.name, { text: copied });
  assert.deepStrictEqual(h.launched[h.launched.length - 1].opts.runner.addDirs, []);
  h.emit(bare.tmux, { ev: 'result', subtype: 'success', text: 'ok', isError: false });
  h.up.delete(bare.tmux);
  await runs.send(bare.runId, { text: 'go on' });
  assert.deepStrictEqual(h.launched[h.launched.length - 1].opts.runner.addDirs, []);
});

test('fake runner: a send the runner took but did not answer is not sent again; a live company thread blocks archive', async () => {
  const h = fakeHeadless();
  const runs = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name) });
  const p = fresh();
  const r = await runs.ask(p.name, { text: 'go' });
  h.emit(r.tmux, { ev: 'result', subtype: 'success', text: 'one', isError: false });
  const calls = [];
  h.send = async (name, text) => { calls.push(text); return { ok: false, error: 'runner did not answer' }; };
  await runs.send(r.runId, { text: 'two' }).catch(() => {});
  assert.strictEqual(calls.length, 1);
  h.up.delete(r.tmux);
  const t1 = fresh({ mode: 'thread' });
  h.up.add(`claude-spec-${t1.name}-company`);
  await assert.rejects(runs.archive(t1.name), e => e.status === 409 && /live thread/.test(e.message));
  h.up.delete(`claude-spec-${t1.name}-company`);
  assert.strictEqual((await runs.archive(t1.name)).name, t1.name);
});

test('fake runner: a restart that finds the runner already connected reads its snapshot at once', async () => {
  const h = fakeHeadless();
  const runs = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name), goneMs: 10 });
  const p = fresh();
  const r = await runs.ask(p.name, { text: 'go' });
  const t1 = fresh({ mode: 'thread' });
  const threadTmux = `claude-spec-${t1.name}`;
  h.up.add(threadTmux);
  const th = store.saveRun({ runId: `${threadTmux}_1`, specialist: t1.name, mode: 'thread', tmux: threadTmux, account: 'personal', sessionId: '0b8f7a2c-1111-4222-8333-444455556666', cwd: t1.dir, transcriptPath: null, state: 'working', task: 'one', text: null, startedAt: Date.now(), endedAt: null, turns: 1 });
  h.snaps.set(r.tmux, { ev: 'snapshot', state: 'idle', turn: null, pending: [], inbox: [], sessionId: r.sessionId });
  h.snaps.set(th.tmux, { ev: 'snapshot', state: 'idle', turn: null, pending: [], inbox: [], sessionId: th.sessionId });
  const answered = path.join(tmp, 'answered.jsonl');
  fs.writeFileSync(answered, [{ type: 'user', message: { role: 'user', content: 'go' } }, { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'all of it' }] } }].map(e => JSON.stringify(e)).join('\n') + '\n');
  store.patchRun(r.runId, { transcriptPath: answered });
  const quiet = { ...h, subscribe: (name, fn) => { h.subs.set(name, fn); return () => {}; } };
  const later = createRuns({ store, headless: quiet, tmuxHas: async name => h.up.has(name), claudeGet: name => ({ specialist: name === th.tmux ? t1.name : p.name, runner: { addDirs: [] } }), goneMs: 10 });
  await later.boot();
  assert.deepStrictEqual([store.getRun(r.runId).state, store.getRun(r.runId).text], ['done', 'all of it']);
  assert.strictEqual(store.getRun(th.runId).state, 'stopped');
  fs.rmSync(answered);
});

test('fake runner: a result with a follow-up still open waits for the next result; a forgotten connection is watched again', async () => {
  const h = fakeHeadless();
  const runs = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name), goneMs: 10, settleMs: 20 });
  const p = fresh();
  const r = await runs.ask(p.name, { text: 'go' });
  h.snaps.set(r.tmux, { state: 'working', turn: null, pending: [], inbox: [{ id: 'm-2', text: 'more' }] });
  h.emit(r.tmux, { ev: 'result', subtype: 'success', text: 'first', isError: false });
  assert.strictEqual(store.getRun(r.runId).state, 'working');
  h.snaps.set(r.tmux, { state: 'working', turn: { text: '' }, pending: [], inbox: [] });
  await new Promise(res => setTimeout(res, 60));
  assert.strictEqual(store.getRun(r.runId).state, 'working');
  const fn = h.subs.get(r.tmux);
  h.subs.delete(r.tmux);
  fn({ ev: 'gone', forgotten: true });
  await until(() => h.subs.has(r.tmux));
  h.snaps.set(r.tmux, { state: 'idle', turn: null, pending: [], inbox: [] });
  h.emit(r.tmux, { ev: 'result', subtype: 'success', text: 'second', isError: false });
  assert.deepStrictEqual([store.getRun(r.runId).state, store.getRun(r.runId).text], ['done', 'second']);
  const q = await runs.ask(p.name, { text: 'again' });
  h.snaps.set(q.tmux, { state: 'working', turn: null, pending: [], inbox: [{ id: 'm-3', text: 'never taken' }] });
  h.emit(q.tmux, { ev: 'result', subtype: 'success', text: 'only', isError: false });
  h.snaps.set(q.tmux, { state: 'idle', turn: null, pending: [], inbox: [] });
  const fin = await runs.get(q.runId, { wait: true, timeoutSec: 2 });
  assert.deepStrictEqual([fin.state, fin.text], ['done', 'only']);
});

test('fake runner: the own chat refuses a name taken by another session, adopts a live chat of the bot, restarts only an idle one and follows an account change', async () => {
  const h = fakeHeadless();
  const records = new Map();
  const launch = h.launch;
  h.launch = async (name, cwd, account, opts) => { records.set(name, { specialist: opts.specialist, runner: opts.runner }); return launch(name, cwd, account, opts); };
  const runs = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name), claudeGet: name => records.get(name) || null });
  const p = fresh({ mode: 'thread', title: 'Helper' });
  const tmux = `claude-spec-${p.name}`;
  h.up.add(tmux);
  records.set(tmux, { specialist: null });
  await assert.rejects(runs.chat(p.name, {}), e => e.status === 409 && e.message === `the session ${tmux} is not this specialist's thread`);
  const sid = '11111111-2222-4333-8444-555555555555';
  records.set(tmux, { specialist: p.name, sessionId: sid, transcriptPath: path.join(tmp, 'adopted.jsonl') });
  const adopted = await runs.chat(p.name, {});
  assert.deepStrictEqual([adopted.started, adopted.thread.tmux, adopted.thread.sessionId, h.launched.length], [false, tmux, sid, 0]);
  h.up.delete(tmux); records.delete(tmux);
  const opened = await runs.chat(p.name, {});
  assert.deepStrictEqual([opened.started, h.launched.length], [true, 1]);
  const { name, opts } = h.launched[0];
  assert.deepStrictEqual([name, opts.start, opts.firstPrompt, opts.specialist, opts.replace], [tmux, 'new', 'Helper', p.name, false]);
  assert.deepStrictEqual(opts.runner, { permissionMode: 'bypassPermissions', model: null, effort: null, addDirs: [], exitAfterResult: false, accesses: p.dir, settings: path.join(p.dir, '.bd', 'settings.json') });
  h.snaps.set(tmux, { state: 'working', turn: { text: '' }, pending: [], inbox: [] });
  await assert.rejects(runs.chat(p.name, { fresh: true }), e => e.status === 409 && e.message === 'the bot is busy');
  h.snaps.set(tmux, { state: 'idle', turn: null, pending: [], inbox: [{ id: 'm-1', text: 'queued' }] });
  await assert.rejects(runs.chat(p.name, { fresh: true }), e => e.status === 409 && e.message === 'the bot is busy');
  h.snaps.set(tmux, { state: 'idle', turn: null, pending: [], inbox: [] });
  assert.strictEqual((await runs.chat(p.name, { fresh: true })).started, true);
  assert.deepStrictEqual([h.launched.length, h.launched[1].opts.replace, h.launched[1].opts.start], [2, true, 'new']);
  store.update(p.name, { account: 'company' });
  const moved = await runs.chat(p.name, {});
  assert.deepStrictEqual([moved.started, moved.thread.tmux, moved.thread.account, h.launched.at(-1).name], [true, `${tmux}-company`, 'company', `${tmux}-company`]);
  assert.ok(h.up.has(tmux));
});

test('fake runner: validation errors', async () => {
  const h = fakeHeadless();
  const runs = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name) });
  const p = fresh();
  await assert.rejects(runs.ask('nobody', { text: 'x' }), status(404));
  await assert.rejects(runs.ask('Bad Name', { text: 'x' }), status(400));
  await assert.rejects(runs.ask(p.name, { text: '' }), status(400));
  await assert.rejects(runs.ask(p.name, { text: 'x', extra: 1 }), status(400));
  await assert.rejects(runs.ask(p.name, { text: 'x', timeoutSec: 0 }), status(400));
  await assert.rejects(runs.ask(p.name, { text: 'x', timeoutSec: 1801 }), status(400));
  await assert.rejects(runs.ask(p.name, { text: 'x', wait: 'yes' }), status(400));
  await assert.rejects(runs.ask(p.name, { text: 'x'.repeat(100001) }), status(413));
  await assert.rejects(runs.get('nope'), status(400));
  await assert.rejects(runs.get(`claude-spec-${p.name}-261111-0930`), status(404));
  await assert.rejects(runs.send(`claude-spec-${p.name}-261111-0930`, { text: 'x' }), status(404));
  for (const from of ['has space', 'x'.repeat(129), 5, 'a/b']) await assert.rejects(runs.ask(p.name, { text: 'x', from }), e => e.status === 400 && /^from must be a tmux session name/.test(e.message));
  assert.strictEqual(h.launched.length, 0);
  const called = await runs.ask(p.name, { text: 'x', from: 'claude-chat-261111-0912' });
  assert.deepStrictEqual([called.caller, store.getRun(called.runId).caller, store.listRuns(p.name)[0].caller], ['claude-chat-261111-0912', 'claude-chat-261111-0912', 'claude-chat-261111-0912']);
  assert.strictEqual((await runs.ask(p.name, { text: 'y', from: null })).caller, null);
});

test('fake runner: recentCalls lists open calls first, then the newest finished ones, five at most, calls only', async () => {
  const h = fakeHeadless();
  let clock = Date.UTC(2026, 10, 11, 9, 0);
  const runs = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name), now: () => clock, maxActive: 10 });
  const p = fresh();
  const made = [];
  for (let i = 0; i < 7; i++) { clock += 60000; made.push(await runs.ask(p.name, { text: `t${i}` })); }
  for (const r of made.slice(1)) { h.emit(r.tmux, { ev: 'result', subtype: 'success', text: 'ok', isError: false }); h.up.delete(r.tmux); }
  store.saveRun({ runId: `claude-spec-${p.name}_1`, specialist: p.name, mode: 'thread', tmux: `claude-spec-${p.name}`, account: 'personal', sessionId: null, cwd: p.dir, transcriptPath: null, state: 'done', task: 'old', text: 'old', startedAt: clock + 60000, endedAt: clock + 60000, turns: 1 });
  const item = (await runs.list()).find(s => s.name === p.name);
  assert.deepStrictEqual(item.recentCalls.map(r => r.runId), [made[0], made[6], made[5], made[4], made[3]].map(r => r.runId));
  assert.ok(item.recentCalls.every(r => !('text' in r) && 'caller' in r));
});

test('restorable skips specialist sessions; markChat keeps the specialist on a later update', () => {
  const sid = '22222222-2222-4222-8222-222222222222';
  claude.markChat('claude-spec-zz-261111-0930', { cwd: tmp, account: 'personal', sessionId: sid, specialist: 'zz', runner: { permissionMode: 'plan', model: 'haiku', addDirs: ['/a', 'rel'], exitAfterResult: true } });
  claude.markChat('claude-chat-261111-0930', { cwd: tmp, account: 'personal', sessionId: sid });
  claude.markChat('claude-spec-zz-261111-0930', { cwd: tmp, account: 'personal', sessionId: sid });
  assert.strictEqual(claude.get('claude-spec-zz-261111-0930').specialist, 'zz');
  assert.deepStrictEqual(claude.get('claude-spec-zz-261111-0930').runner, { permissionMode: 'plan', model: 'haiku', effort: null, addDirs: ['/a'], exitAfterResult: true });
  assert.deepStrictEqual(claude.setRunner('claude-spec-zz-261111-0930', { addDirs: ['/a', '/b'] }).addDirs, ['/a', '/b']);
  assert.strictEqual(claude.get('claude-chat-261111-0930').runner, undefined);
  for (const name of ['claude-spec-zz-261111-0930', 'claude-chat-261111-0930']) claude.get(name).gone = Date.now();
  const names = claude.restorable().map(r => r.tmux);
  assert.ok(names.includes('claude-chat-261111-0930'));
  assert.ok(!names.includes('claude-spec-zz-261111-0930'));
});

test('http routes: create, list, get, update, archive and errors as { ok: false, error }', async t => {
  const h = fakeHeadless();
  const training = createTraining({ store, headless: h, tmuxHas: async name => h.up.has(name) });
  const runs = createRuns({ store, headless: h, tmuxHas: async name => h.up.has(name), training });
  const api = createSpecialistApi({ store, runs, training, readBody });
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    if (!(await api.handle(req, res, parts, url, send))) send(res, 418, { other: true });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }); return [r.status, await r.json()]; };
  const name = `web${++n}`;
  const [c, created] = await call('POST', '/api/specialist', { name, template: 'writer', description: 'Writes.' });
  assert.strictEqual(c, 201);
  assert.strictEqual(created.specialist.icon, 'write');
  assert.strictEqual((await call('POST', '/api/specialist', { name }))[0], 409);
  assert.strictEqual((await call('POST', '/api/specialist', { name: '../x' }))[0], 400);
  assert.strictEqual((await call('POST', '/api/specialist', { name: 'q', template: 'nope' }))[0], 400);
  assert.deepStrictEqual(await call('POST', '/api/specialist', '{bad'), [400, { ok: false, error: 'bad JSON' }]);
  const [, list] = await call('GET', '/api/specialists');
  assert.strictEqual(list.root, process.env.BD_SPECIALISTS_DIR);
  assert.ok(list.templates.some(x => x.id === 'writer'));
  const item = list.specialists.find(s => s.name === name);
  assert.deepStrictEqual([item.active, item.lastRun, item.recentCalls, item.thread, 'trainer' in item], [0, null, [], null, false]);
  const [, got] = await call('GET', `/api/specialist/${name}?runs=5`);
  assert.match(got.specialist.instructions, /style\.md/);
  assert.deepStrictEqual(got.runs, []);
  assert.strictEqual((await call('GET', `/api/specialist/${name}?runs=0`))[0], 400);
  assert.strictEqual((await call('GET', '/api/specialist/nobody'))[0], 404);
  const [u, upd] = await call('POST', `/api/specialist/${name}`, { title: 'Pen', ifUpdatedAt: got.specialist.updatedAt });
  assert.deepStrictEqual([u, upd.specialist.title], [200, 'Pen']);
  assert.strictEqual((await call('POST', `/api/specialist/${name}`, { title: 'x', ifUpdatedAt: '2000-01-01T00:00:00.000Z' }))[0], 409);
  assert.strictEqual((await call('POST', `/api/specialist/${name}`, { name: 'other' }))[0], 400);
  const [a, asked] = await call('POST', `/api/specialist/${name}/ask`, { text: 'draft it' });
  assert.deepStrictEqual([a, asked.ok, asked.state, asked.specialist], [200, true, 'working', name]);
  assert.strictEqual((await call('POST', `/api/specialist/${name}/ask`, { text: '' }))[0], 400);
  const [g, run] = await call('GET', `/api/specialist/run/${asked.runId}?wait=1&timeoutSec=1`);
  assert.deepStrictEqual([g, run.timedOut, run.state], [200, true, 'working']);
  assert.strictEqual((await call('GET', `/api/specialist/run/${asked.runId}?timeoutSec=99999`))[0], 400);
  assert.strictEqual((await call('POST', `/api/specialist/run/${asked.runId}/send`, { text: 'more' }))[0], 409);
  assert.strictEqual((await call('POST', `/api/specialist/${name}/archive`))[0], 409);
  h.emit(asked.tmux, { ev: 'result', subtype: 'success', text: 'Dear …', isError: false });
  const [, doneRun] = await call('GET', `/api/specialist/run/${asked.runId}?wait=1`);
  assert.deepStrictEqual([doneRun.state, doneRun.text], ['done', 'Dear …']);
  const [lr, liveRun] = await call('POST', `/api/specialist/${name}/archive`);
  assert.deepStrictEqual([lr, /live run session/.test(liveRun.error)], [409, true]);
  h.up.delete(asked.tmux);
  const [ch, opened] = await call('POST', `/api/specialist/${name}/chat`, {});
  assert.deepStrictEqual([ch, opened.ok, opened.started, opened.thread.tmux, opened.thread.live], [200, true, true, `claude-spec-${name}`, true]);
  assert.strictEqual((await call('POST', `/api/specialist/${name}/chat`, { fresh: 1 }))[0], 400);
  const [, listed] = await call('GET', '/api/specialists');
  const again = listed.specialists.find(s => s.name === name);
  assert.deepStrictEqual([again.recentCalls.map(r => r.runId), again.thread.tmux], [[asked.runId], `claude-spec-${name}`]);
  assert.strictEqual((await call('POST', `/api/specialist/${name}/archive`, { endChat: true }))[0], 409);
  assert.strictEqual((await call('POST', `/api/specialist/${name}/archive`, { other: true }))[0], 400);
  h.up.delete(`claude-spec-${name}`);
  const [ar, archived] = await call('POST', `/api/specialist/${name}/archive`);
  assert.strictEqual(ar, 200);
  assert.match(archived.archivedAs, new RegExp(`^_archive/${name}-\\d{8}-\\d{6}$`));
  assert.strictEqual((await call('GET', `/api/specialist/${name}`))[0], 404);
  assert.strictEqual((await call('GET', '/api/specialist/run/%E0%A4'))[0], 400);
  assert.strictEqual((await call('DELETE', `/api/specialist/${name}`))[0], 404);
  assert.deepStrictEqual(await call('GET', '/api/state'), [418, { other: true }]);
});
