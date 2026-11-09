'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { main, parse, currentAccount } = require('../bin/bd-chat');

function fakeDash(t, reply) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      const [status, out] = reply(seen.at(-1).body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  t.after(() => srv.close());
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, seen })));
}

function io(extra = {}) {
  const o = { outs: [], errs: [], cwd: '/work/repo', stdin: () => 'from stdin', ...extra };
  o.out = s => o.outs.push(s); o.err = s => o.errs.push(s);
  return o;
}

test('bd-chat new posts the message, folder and account to /api/chat-new on the dashboard port', async t => {
  const d = await fakeDash(t, b => [200, { ok: true, name: 'claude-chat-261109-2100', cwd: b.cwd, sent: true }]);
  const o = io();
  const code = await main(['new', '--cwd', 'sub', 'Continue the plan'], { BEAST_DASH_PORT: String(d.port) }, o);
  assert.equal(code, 0, o.errs.join('\n'));
  assert.equal(d.seen.length, 1);
  assert.equal(d.seen[0].method, 'POST');
  assert.equal(d.seen[0].url, '/api/chat-new');
  assert.equal(d.seen[0].headers.origin, undefined);
  assert.equal(d.seen[0].headers['sec-fetch-site'], undefined);
  assert.deepEqual(d.seen[0].body, { text: 'Continue the plan', account: 'personal', cwd: path.resolve('/work/repo', 'sub') });
  assert.deepEqual(o.outs, [`started claude-chat-261109-2100 in ${path.resolve('/work/repo', 'sub')} (personal)`]);
});

test('bd-chat new - reads the message from stdin, --empty sends none, --account picks the login', async t => {
  const d = await fakeDash(t, b => [200, { ok: true, name: 'claude-chat-x', cwd: b.cwd, sent: true, empty: !!b.empty }]);
  const env = { BEAST_DASH_PORT: String(d.port) };
  assert.equal(await main(['new', '-'], env, io()), 0);
  assert.equal(await main(['new', '--empty', '--account=company'], env, io()), 0);
  assert.deepEqual(d.seen.map(s => s.body), [
    { text: 'from stdin', account: 'personal', cwd: '/work/repo' },
    { empty: true, account: 'company', cwd: '/work/repo' },
  ]);
});

test('the account defaults to the login this shell runs under', () => {
  assert.equal(currentAccount({ CLAUDE_CONFIG_DIR: '/home/u/.claude-company' }), 'company');
  assert.equal(currentAccount({ CLAUDE_CONFIG_DIR: '/home/u/.claude' }), 'personal');
  assert.equal(currentAccount({}), 'personal');
});

test('a refusal from the dashboard is an error with its message and a non-zero exit', async t => {
  const d = await fakeDash(t, () => [400, { ok: false, error: 'cwd must be an existing folder inside the dev folder' }]);
  const o = io();
  assert.equal(await main(['new', 'hi'], { BEAST_DASH_PORT: String(d.port) }, o), 1);
  assert.deepEqual(o.errs, ['bd-chat: cwd must be an existing folder inside the dev folder']);
  assert.deepEqual(o.outs, []);
});

test('a chat that started but did not get its first message is reported as a failure', async t => {
  const d = await fakeDash(t, () => [200, { ok: true, name: 'claude-chat-y', sent: false, error: 'chat runner is not reachable' }]);
  const o = io();
  assert.equal(await main(['new', 'hi'], { BEAST_DASH_PORT: String(d.port) }, o), 1);
  assert.match(o.errs[0], /started claude-chat-y, but the first message was not sent: chat runner is not reachable/);
});

test('--json prints the answer as it came', async t => {
  const d = await fakeDash(t, () => [200, { ok: true, name: 'claude-chat-z', cwd: '/work/repo', sent: true }]);
  const o = io();
  assert.equal(await main(['new', '--json', 'hi'], { BEAST_DASH_PORT: String(d.port) }, o), 0);
  assert.deepEqual(JSON.parse(o.outs[0]), { ok: true, name: 'claude-chat-z', cwd: '/work/repo', sent: true });
});

test('bad usage exits 2 without calling the dashboard', async () => {
  const env = { BEAST_DASH_PORT: '1' };
  for (const argv of [[], ['old', 'x'], ['new'], ['new', 'a', 'b'], ['new', '--empty', 'x'], ['new', '   '], ['new', '--account', 'other', 'x'], ['new', '--cwd'], ['new', '--nope', 'x']]) {
    assert.equal(await main(argv, env, io()), 2, argv.join(' '));
  }
  assert.throws(() => parse(['--cwd']), /needs a value/);
});

test('an unreachable dashboard is an error that names the port', async () => {
  const o = io();
  assert.equal(await main(['new', 'hi'], { BEAST_DASH_PORT: '1' }, o), 1);
  assert.match(o.errs[0], /cannot reach the dashboard on 127\.0\.0\.1:1/);
});
