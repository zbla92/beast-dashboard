const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAuthLogin, urlOf, redact } = require('../lib/authlogin');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude-auth');
const GOOD = 'GOOD-fake-code-1234';

function setup(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-auth-'));
  const dir = path.join(home, 'fake');
  fs.mkdirSync(path.join(home, '.claude-company'));
  process.env.FAKE_AUTH_DIR = dir;
  const calls = [];
  const sessions = { 'claude-a': 'personal', 'claude-b': 'personal', 'claude-c-company': 'company' };
  const auth = createAuthLogin({
    home, accounts: () => ['personal', 'company'], claudeBin: () => FAKE, okHoldMs: 60e3, checkGapMs: 0,
    sessionAccount: name => sessions[name] || null,
    restart: async name => { calls.push(['restart', name]); return { ok: true }; },
    send: async (name, text) => { calls.push(['send', name, text]); return { ok: true }; },
    ...extra,
  });
  t.after(() => { auth.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const login = (account = 'personal') => auth.state()[account].login;
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 30)); } throw new Error('timed out; state ' + JSON.stringify(auth.state())); };
  const pidOf = account => +fs.readFileSync(path.join(dir, account + '.pid'), 'utf8');
  const waiting = async account => { await auth.api('start', { account }); return until(() => login(account)?.state === 'waiting' && login(account)); };
  return { auth, home, dir, calls, login, until, pidOf, waiting };
}
const alive = pid => { try { process.kill(pid, 0); return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); } catch { return false; } };

test('start reaches waiting with the oauth url from the OSC 8 link', async t => {
  const { auth, waiting } = setup(t);
  const r = await auth.api('start', { account: 'nope' });
  assert.strictEqual(r.status, 400);
  const L = await waiting('personal');
  assert.match(L.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=fake-client&/);
  assert.ok(!/\x1b/.test(L.url));
  assert.ok(L.endsAt - L.startedAt === 15 * 60e3);
  assert.strictEqual(L.state, 'waiting');
});

test('a good code ends in ok, the account is logged in and failed is cleared', async t => {
  const { auth, login, until, waiting } = setup(t);
  auth.onEvent('claude-a', { ev: 'result', isError: true, text: 'Login expired · Please run /login' });
  assert.ok(auth.state().personal.failed);
  const L = await waiting('personal');
  const r = await auth.api('code', { account: 'personal', id: L.id, code: `  ${GOOD}\n` });
  assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
  await until(() => login()?.state === 'ok');
  const s = auth.state().personal;
  assert.strictEqual(s.loggedIn, true);
  assert.ok(s.expiresAt > Date.now());
  assert.strictEqual(s.failed, null);
  assert.strictEqual(s.needsLogin, false);
  assert.strictEqual(login().message, 'Signed in');
});

test('ok disappears after the hold time', async t => {
  const { auth, login, until, waiting } = setup(t, { okHoldMs: 100 });
  const L = await waiting('personal');
  await auth.api('code', { account: 'personal', id: L.id, code: GOOD });
  await until(() => login()?.state === 'ok');
  await until(() => login() === null);
});

test('a bad code ends in error with the Login failed line and the code never shows', async t => {
  const { auth, login, until, waiting } = setup(t);
  const code = 'BAD-secret-code-98765#state';
  const L = await waiting('personal');
  const r = await auth.api('code', { account: 'personal', id: L.id, code });
  assert.strictEqual(r.status, 200);
  await until(() => login()?.state === 'error');
  assert.match(login().message, /^Login failed: That code wasn't accepted/);
  assert.ok(login().message.length <= 300);
  assert.match(login().message, /\[code\]/);
  assert.ok(!/\x1b/.test(login().message));
  assert.ok(!JSON.stringify(auth.state()).includes(code));
  assert.ok(!JSON.stringify(auth.state()).includes('BAD-secret'));
  const again = await auth.api('code', { account: 'personal', id: L.id, code: GOOD });
  assert.deepStrictEqual(again, { status: 409, body: { ok: false, error: 'Login expired, start again' } });
});

test('bad codes and wrong ids are refused before anything reaches the PTY', async t => {
  const { auth, login, waiting } = setup(t);
  const L = await waiting('personal');
  for (const code of ['short', 'has space inside', 'ctrl\x03-char-code', 'tab\tinside-code', 'x'.repeat(4097), 'üñíçødé-code', 42, null]) {
    const r = await auth.api('code', { account: 'personal', id: L.id, code });
    assert.strictEqual(r.status, 400, String(code));
  }
  assert.strictEqual((await auth.api('code', { account: 'nope', id: L.id, code: GOOD })).status, 400);
  assert.strictEqual((await auth.api('code', { account: 'personal', id: 'wrong', code: GOOD })).status, 409);
  assert.strictEqual((await auth.api('code', { account: 'company', id: L.id, code: GOOD })).status, 409);
  assert.strictEqual(login().state, 'waiting');
});

test('the timeout kills the login and asks to start again', async t => {
  const { auth, login, until, pidOf } = setup(t, { timeoutMs: 600 });
  await auth.api('start', { account: 'personal' });
  await until(() => login()?.state === 'waiting');
  const pid = pidOf('personal');
  await until(() => login()?.state === 'expired');
  assert.strictEqual(login().message, 'Login expired, start again');
  await until(() => !alive(pid));
  const r = await auth.api('code', { account: 'personal', id: login().id, code: GOOD });
  assert.deepStrictEqual(r.body, { ok: false, error: 'Login expired, start again' });
});

test('start again kills the old login process, cancel kills the new one', async t => {
  const { auth, login, until, pidOf, waiting } = setup(t);
  const first = await waiting('personal');
  const p1 = pidOf('personal');
  assert.ok(alive(p1));
  await auth.api('start', { account: 'personal' });
  await until(() => login()?.state === 'waiting' && login().id !== first.id && pidOf('personal') !== p1);
  await until(() => !alive(p1));
  const p2 = pidOf('personal');
  assert.ok(alive(p2));
  assert.deepStrictEqual(await auth.api('cancel', { account: 'personal' }), { status: 200, body: { ok: true } });
  assert.strictEqual(login(), null);
  await until(() => !alive(p2));
  assert.strictEqual((await auth.api('cancel', { account: 'nope' })).status, 400);
});

test('the company login runs with CLAUDE_CONFIG_DIR and does not touch personal', async t => {
  const { auth, login, until, dir, waiting } = setup(t);
  const L = await waiting('company');
  await auth.api('code', { account: 'company', id: L.id, code: GOOD });
  await until(() => login('company')?.state === 'ok');
  assert.ok(fs.existsSync(path.join(dir, 'company.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'personal.json')));
  assert.strictEqual(login('personal'), null);
});

test('check reads claude auth status: logged out, logged in, expired', async t => {
  const { auth, dir } = setup(t);
  const r1 = await auth.api('check', { account: 'personal' });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.body.auth.loggedIn, false);
  assert.strictEqual(r1.body.auth.needsLogin, true);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'personal.json'), JSON.stringify({ loggedIn: true, expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
  const r2 = await auth.api('check', { account: 'personal' });
  assert.strictEqual(r2.body.auth.loggedIn, true);
  assert.strictEqual(r2.body.auth.needsLogin, false);
  assert.ok(r2.body.auth.checkedAt > 0);
  fs.writeFileSync(path.join(dir, 'personal.json'), JSON.stringify({ loggedIn: true, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const r3 = await auth.api('check', { account: 'personal' });
  assert.strictEqual(r3.body.auth.needsLogin, true);
  assert.strictEqual((await auth.api('check', { account: '../x' })).status, 400);
});

test('check is throttled per account', async t => {
  const { auth, dir } = setup(t, { checkGapMs: 60e3 });
  const a = await auth.api('check', { account: 'personal' });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'personal.json'), JSON.stringify({ loggedIn: true }));
  const b = await auth.api('check', { account: 'personal' });
  assert.strictEqual(b.body.auth.checkedAt, a.body.auth.checkedAt);
  assert.strictEqual(b.body.auth.loggedIn, false);
});

test('a session auth error marks failed + needsLogin, a later good result clears it', async t => {
  const { auth } = setup(t);
  auth.onEvent('claude-a', { ev: 'inbox', inbox: [{ id: 'm-1', text: 'please fix the bug', at: 1 }] });
  auth.onEvent('claude-a', { ev: 'inbox', inbox: [] });
  auth.onEvent('claude-a', { ev: 'result', isError: true, text: 'Login expired · Please run /login' });
  const s1 = auth.state().personal;
  assert.deepStrictEqual(s1.failed.sessions, ['claude-a']);
  assert.strictEqual(s1.needsLogin, true);
  assert.deepStrictEqual(s1.retry, ['claude-a']);
  assert.strictEqual(auth.state().company.failed, null);
  auth.onEvent('claude-b', { ev: 'result', isError: true, text: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}' });
  const s2 = auth.state().personal;
  assert.deepStrictEqual(s2.failed.sessions, ['claude-a', 'claude-b']);
  assert.deepStrictEqual(s2.retry, ['claude-a']);
  auth.onEvent('claude-a', { ev: 'result', isError: true, text: 'Some other tool error' });
  auth.onEvent('claude-a', { ev: 'result', subtype: 'restarted', reason: 'restart' });
  assert.ok(auth.state().personal.failed);
  auth.onEvent('claude-b', { ev: 'result', isError: false, text: 'done' });
  const s3 = auth.state().personal;
  assert.strictEqual(s3.failed, null);
  assert.deepStrictEqual(s3.retry, ['claude-a']);
  auth.onEvent('claude-a', { ev: 'result', isError: false, text: 'done' });
  assert.deepStrictEqual(auth.state().personal.retry, []);
});

test('a runner error after the child exits counts, sessions without a known account do not', async t => {
  const { auth } = setup(t);
  auth.onEvent('claude-c-company', { ev: 'snapshot', state: 'exited', error: 'Invalid API key · Please run /login', inbox: [] });
  assert.strictEqual(auth.state().company.failed, null);
  auth.onEvent('claude-c-company', { ev: 'state', state: 'exited' });
  auth.onEvent('claude-c-company', { ev: 'snapshot', state: 'exited', error: 'OAuth token has expired', inbox: [] });
  assert.deepStrictEqual(auth.state().company.failed.sessions, ['claude-c-company']);
  assert.deepStrictEqual(auth.state().company.retry, []);
  auth.onEvent('unknown-session', { ev: 'result', isError: true, text: 'Not logged in · Please run /login' });
  assert.strictEqual(auth.state().personal.failed, null);
});

test('retry restarts the chat, sends the failed turn again and leaves the list; dismiss only drops it', async t => {
  const { auth, calls, dir } = setup(t);
  auth.onEvent('claude-a', { ev: 'inbox', inbox: [{ id: 'm-1', text: 'write the report', at: 1 }] });
  auth.onEvent('claude-a', { ev: 'result', isError: true, text: 'Login expired · Please run /login' });
  auth.onEvent('claude-b', { ev: 'inbox', inbox: [{ id: 'm-2', text: 'other turn', at: 1 }] });
  auth.onEvent('claude-b', { ev: 'result', isError: true, text: 'Login expired · Please run /login' });
  await new Promise(r => setTimeout(r, 300));
  assert.deepStrictEqual((await auth.api('retry', { session: 'claude-a' })).body, { ok: false, error: 'Authenticate first' });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'personal.json'), JSON.stringify({ loggedIn: true }));
  assert.strictEqual((await auth.api('retry', { session: 'bad name!' })).status, 400);
  assert.strictEqual((await auth.api('retry', { session: 'claude-zzz' })).status, 409);
  const r = await auth.api('retry', { session: 'claude-a' });
  assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
  assert.deepStrictEqual(calls, [['restart', 'claude-a'], ['send', 'claude-a', 'write the report']]);
  assert.deepStrictEqual(auth.state().personal.retry, ['claude-b']);
  assert.strictEqual((await auth.api('retry', { session: 'claude-a' })).status, 409);
  assert.deepStrictEqual(await auth.api('retry', { session: 'claude-b', dismiss: true }), { status: 200, body: { ok: true } });
  assert.deepStrictEqual(auth.state().personal.retry, []);
  assert.strictEqual(calls.length, 2);
});

test('a double tap on retry sends once', async t => {
  const gate = Promise.withResolvers();
  const { auth, calls, dir } = setup(t, { restart: async name => { calls.push(['restart', name]); await gate.promise; return { ok: true }; } });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'personal.json'), JSON.stringify({ loggedIn: true }));
  auth.onEvent('claude-a', { ev: 'inbox', inbox: [{ id: 'm-1', text: 'once', at: 1 }] });
  auth.onEvent('claude-a', { ev: 'result', isError: true, text: 'Please run /login' });
  const first = auth.api('retry', { session: 'claude-a' });
  await new Promise(r => setTimeout(r, 200));
  const second = await auth.api('retry', { session: 'claude-a' });
  assert.strictEqual(second.status, 409);
  gate.resolve();
  assert.strictEqual((await first).status, 200);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'send'), [['send', 'claude-a', 'once']]);
});

test('a missing script command gives a clear error', async t => {
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  const { auth, login, until } = setup(t);
  process.env.PATH = '/nonexistent';
  await auth.api('start', { account: 'personal' });
  process.env.PATH = saved;
  await until(() => login()?.state === 'error');
  assert.match(login().message, /script command/);
});

test('a non-zero exit without a Login failed line still ends in error', async t => {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-auth-bin-')), 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\necho "something broke"\nexit 3\n', { mode: 0o755 });
  t.after(() => fs.rmSync(path.dirname(bin), { recursive: true, force: true }));
  const { auth, login, until } = setup(t, { claudeBin: () => bin });
  await auth.api('start', { account: 'personal' });
  await until(() => login()?.state === 'error');
  assert.strictEqual(login().message, 'claude auth login stopped (exit 3)');
  assert.strictEqual(login().url, null);
});

test('a server that gets SIGTERM takes its login process with it', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-auth-exit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'fake'), pidFile = path.join(dir, 'personal.pid');
  const src = `const a = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'authlogin.js'))}).createAuthLogin({ home: ${JSON.stringify(home)}, accounts: () => ['personal'], claudeBin: () => ${JSON.stringify(FAKE)}, sessionAccount: () => null });
a.api('start', { account: 'personal' }); setInterval(() => {}, 1000);`;
  const p = require('node:child_process').spawn(process.execPath, ['-e', src], { env: { ...process.env, FAKE_AUTH_DIR: dir }, stdio: 'ignore' });
  const end = Date.now() + 8000;
  while (!fs.existsSync(pidFile) && Date.now() < end) await new Promise(r => setTimeout(r, 30));
  const pid = +fs.readFileSync(pidFile, 'utf8');
  assert.ok(alive(pid));
  const exited = new Promise(r => p.on('exit', (code, sig) => r(sig)));
  p.kill('SIGTERM');
  assert.strictEqual(await exited, 'SIGTERM');
  while (alive(pid) && Date.now() < end) await new Promise(r => setTimeout(r, 30));
  assert.ok(!alive(pid));
});

const statusCalls = dir => { try { return fs.readFileSync(path.join(dir, 'status.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };

test('claude auth status is not run at start or on a timer, only after a session auth error', async t => {
  const { auth, dir, until } = setup(t);
  assert.strictEqual(auth.begin, undefined);
  await new Promise(r => setTimeout(r, 400));
  const s = auth.state().personal;
  assert.deepStrictEqual([s.loggedIn, s.checkedAt, s.needsLogin], [null, null, false]);
  assert.deepStrictEqual(statusCalls(dir), []);
  auth.onEvent('claude-a', { ev: 'result', isError: true, text: 'Please run /login' });
  assert.strictEqual(auth.state().personal.needsLogin, true);
  await until(() => auth.state().personal.checkedAt > 0);
  assert.deepStrictEqual(statusCalls(dir), ['personal']);
  assert.strictEqual(auth.state().personal.loggedIn, false);
  assert.strictEqual(auth.state().company.checkedAt, null);
});

test('retry is refused while the chat is busy and keeps the entry', async t => {
  const flags = { idle: false };
  const { auth, calls, dir } = setup(t, { idle: async () => flags.idle });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'personal.json'), JSON.stringify({ loggedIn: true }));
  auth.onEvent('claude-a', { ev: 'snapshot', state: 'idle', inbox: [] });
  auth.onEvent('claude-a', { ev: 'inbox', inbox: [{ id: 'm-1', text: 'old text', at: 1 }] });
  auth.onEvent('claude-a', { ev: 'result', isError: true, text: 'Please run /login' });
  const r = await auth.api('retry', { session: 'claude-a' });
  assert.deepStrictEqual(r, { status: 409, body: { ok: false, error: 'The chat is busy, wait until it is idle' } });
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(auth.state().personal.retry, ['claude-a']);
  flags.idle = true;
  assert.strictEqual((await auth.api('retry', { session: 'claude-a' })).status, 200);
  assert.deepStrictEqual(calls, [['restart', 'claude-a'], ['send', 'claude-a', 'old text']]);
});

test('a new message in the chat drops its retry entry, a message leaving the inbox does not', async t => {
  const { auth, calls, dir } = setup(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'personal.json'), JSON.stringify({ loggedIn: true }));
  auth.onEvent('claude-a', { ev: 'snapshot', state: 'idle', inbox: [] });
  auth.onEvent('claude-a', { ev: 'inbox', inbox: [{ id: 'm-1', text: 'old text', at: 1 }] });
  auth.onEvent('claude-a', { ev: 'result', isError: true, text: 'Please run /login' });
  auth.onEvent('claude-a', { ev: 'inbox', inbox: [] });
  assert.deepStrictEqual(auth.state().personal.retry, ['claude-a']);
  auth.onEvent('claude-a', { ev: 'snapshot', state: 'idle', inbox: [] });
  assert.deepStrictEqual(auth.state().personal.retry, ['claude-a']);
  auth.onEvent('claude-a', { ev: 'inbox', inbox: [{ id: 'm-2', text: 'something new', at: 2 }] });
  assert.deepStrictEqual(auth.state().personal.retry, []);
  assert.strictEqual((await auth.api('retry', { session: 'claude-a' })).status, 409);
  assert.deepStrictEqual(calls, []);
});

test('the text of a turn that ended without an auth error is never stored as the failed turn', async t => {
  const { auth } = setup(t);
  auth.onEvent('claude-a', { ev: 'inbox', inbox: [{ id: 'm-1', text: 'tool error turn', at: 1 }] });
  auth.onEvent('claude-a', { ev: 'result', isError: true, text: 'Some other tool error' });
  auth.onEvent('claude-a', { ev: 'result', isError: true, text: 'Please run /login' });
  assert.deepStrictEqual(auth.state().personal.retry, []);
  auth.onEvent('claude-b', { ev: 'inbox', inbox: [{ id: 'm-1', text: 'stopped turn', at: 1 }] });
  auth.onEvent('claude-b', { ev: 'result', subtype: 'interrupted' });
  auth.onEvent('claude-b', { ev: 'state', state: 'exited' });
  auth.onEvent('claude-b', { ev: 'snapshot', state: 'exited', error: 'Not logged in · Please run /login', inbox: [] });
  assert.deepStrictEqual(auth.state().personal.failed.sessions, ['claude-a', 'claude-b']);
  assert.deepStrictEqual(auth.state().personal.retry, []);
});

test('the exit path keeps the text only when a turn was running when claude exited', async t => {
  const { auth, calls, dir } = setup(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'company.json'), JSON.stringify({ loggedIn: true }));
  auth.onEvent('claude-c-company', { ev: 'inbox', inbox: [{ id: 'm-1', text: 'running turn', at: 1 }] });
  auth.onEvent('claude-c-company', { ev: 'result', subtype: 'exited', reason: '1' });
  auth.onEvent('claude-c-company', { ev: 'state', state: 'exited' });
  auth.onEvent('claude-c-company', { ev: 'snapshot', state: 'exited', error: 'OAuth token has expired', inbox: [] });
  assert.deepStrictEqual(auth.state().company.retry, ['claude-c-company']);
  assert.strictEqual((await auth.api('retry', { session: 'claude-c-company' })).status, 200);
  assert.deepStrictEqual(calls, [['restart', 'claude-c-company'], ['send', 'claude-c-company', 'running turn']]);
});

test('the sign-in url must be an https oauth/authorize link on a Claude or Anthropic host, OSC 8 or plain text', () => {
  const good = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=s';
  const osc = u => `\x1b]8;;${u}\x1b\\label\x1b]8;;\x1b\\`;
  assert.strictEqual(urlOf(`${osc('https://docs.claude.com/help')} then ${osc(good)}\r\n`), good);
  assert.strictEqual(urlOf(`${osc('https://evil.example/oauth/authorize?x=1')}\r\n`), null);
  assert.strictEqual(urlOf(`${osc('https://claude.ai.evil.example/oauth/authorize?x=1')}\r\n`), null);
  assert.strictEqual(urlOf(`${osc('http://claude.ai/oauth/authorize?x=1')}\r\n`), null);
  assert.strictEqual(urlOf(`see https://evil.example/oauth/authorize?x=1 or ${good}\r\n`), good);
  assert.strictEqual(urlOf(`visit https://claude.ai@evil.example/oauth/authorize?x=1 now\n`), null);
  assert.strictEqual(urlOf(`visit https://claude.ai/login?next=oauth/authorize?x now\n`), null);
  assert.strictEqual(urlOf(`visit https://platform.claude.com/oauth/authorize?a=b now\n`), 'https://platform.claude.com/oauth/authorize?a=b');
  assert.strictEqual(urlOf(`visit https://console.anthropic.com/oauth/authorize?a=b now\n`), 'https://console.anthropic.com/oauth/authorize?a=b');
});

test('redact hides the whole code and each # part of it', () => {
  assert.strictEqual(redact('x ABCDEFGH#STATE1 y ABCDEFGH z STATE1 w', 'ABCDEFGH#STATE1'), 'x [code] y [code] z [code] w');
  assert.strictEqual(redact('a#b c', 'LONGCODE#a#b'), 'a#b c');
});
