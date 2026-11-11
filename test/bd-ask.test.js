'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { main, parse } = require('../bin/bd-ask');

function fakeDash(t, reply) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      const [status, out] = reply(seen.at(-1), seen.length);
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

const ID = 'claude-spec-writer-261111-0930';
const run = (state, extra = {}) => ({ ok: true, runId: ID, specialist: 'writer', state, text: null, error: null, ...extra });
const envOf = d => ({ BEAST_DASH_PORT: String(d.port) });

test('--list prints name, title and description per specialist', async t => {
  const d = await fakeDash(t, () => [200, { ok: true, specialists: [
    { name: 'writer', title: 'Writer', description: 'Drafts  messages\nin my voice' },
    { name: 'broken', dir: '/x', error: 'bad json' },
  ] }]);
  const o = io();
  assert.equal(await main(['--list'], envOf(d), o), 0);
  assert.equal(d.seen[0].method, 'GET');
  assert.equal(d.seen[0].url, '/api/specialists');
  assert.deepEqual(o.outs, ['writer\tWriter\tDrafts messages in my voice', 'broken\t(invalid: bad json)']);
});

test('asking posts text, absolute files and wait, then prints only the text', async t => {
  const d = await fakeDash(t, () => [200, run('done', { text: 'Hi there' })]);
  const o = io();
  assert.equal(await main(['writer', 'Reply to Ana', '--file', 'a.txt', '--file=/abs/b.txt'], envOf(d), o), 0, o.errs.join('\n'));
  assert.equal(d.seen.length, 1);
  assert.equal(d.seen[0].method, 'POST');
  assert.equal(d.seen[0].url, '/api/specialist/writer/ask');
  assert.deepEqual(d.seen[0].body, { text: 'Reply to Ana', wait: true, timeoutSec: 300, files: [path.resolve('/work/repo', 'a.txt'), '/abs/b.txt'] });
  assert.deepEqual(o.outs, ['Hi there']);
  assert.deepEqual(o.errs, []);
});

test('the task can come from stdin', async t => {
  const d = await fakeDash(t, () => [200, run('done', { text: 'ok' })]);
  assert.equal(await main(['writer', '-'], envOf(d), io()), 0);
  assert.equal(d.seen[0].body.text, 'from stdin');
});

test('a wait that times out on the server is polled again until the run is done', async t => {
  const d = await fakeDash(t, (req, n) => [200, n === 1 ? run('working', { timedOut: true }) : n === 2 ? run('waiting', { timedOut: true }) : run('done', { text: 'late answer' })]);
  const o = io();
  assert.equal(await main(['writer', 'x'], envOf(d), o), 0);
  assert.deepEqual(d.seen.map(s => `${s.method} ${s.url.split('&')[0]}`), [
    'POST /api/specialist/writer/ask',
    `GET /api/specialist/run/${ID}?wait=1`,
    `GET /api/specialist/run/${ID}?wait=1`,
  ]);
  assert.deepEqual(o.outs, ['late answer']);
  assert.equal(o.errs.length, 1);
  assert.match(o.errs[0], /needs an answer in the dashboard/);
});

test('--no-wait prints the run id only', async t => {
  const d = await fakeDash(t, () => [200, run('starting')]);
  const o = io();
  assert.equal(await main(['writer', 'x', '--no-wait'], envOf(d), o), 0);
  assert.equal(d.seen[0].body.wait, false);
  assert.deepEqual(o.outs, [ID]);
});

test('--wait follows an existing run', async t => {
  const d = await fakeDash(t, () => [200, run('done', { text: 'result' })]);
  const o = io();
  assert.equal(await main(['--wait', ID], envOf(d), o), 0);
  assert.equal(d.seen[0].method, 'GET');
  assert.equal(d.seen[0].url, `/api/specialist/run/${ID}?wait=1&timeoutSec=300`);
  assert.deepEqual(o.outs, ['result']);
});

test('--continue sends the follow-up to the run and waits', async t => {
  const d = await fakeDash(t, () => [200, run('done', { text: 'shorter' })]);
  const o = io();
  assert.equal(await main(['--continue', ID, 'Shorter'], envOf(d), o), 0);
  assert.equal(d.seen[0].url, `/api/specialist/run/${ID}/send`);
  assert.deepEqual(d.seen[0].body, { text: 'Shorter', wait: true, timeoutSec: 300 });
  assert.deepEqual(o.outs, ['shorter']);
});

test('a failed run exits 1 with its error on stderr', async t => {
  const d = await fakeDash(t, () => [200, run('error', { error: 'claude exited' })]);
  const o = io();
  assert.equal(await main(['writer', 'x'], envOf(d), o), 1);
  assert.match(o.errs[0], /failed: claude exited/);
  assert.deepEqual(o.outs, []);
});

test('an API refusal exits 1 with its message', async t => {
  const d = await fakeDash(t, () => [404, { ok: false, error: 'no such specialist' }]);
  const o = io();
  assert.equal(await main(['nobody', 'x'], envOf(d), o), 1);
  assert.deepEqual(o.errs, ['bd-ask: no such specialist']);
});

test('running past --timeout exits 4 and names the run id to resume', async t => {
  const d = await fakeDash(t, () => [200, run('working', { timedOut: true })]);
  const o = io();
  assert.equal(await main(['writer', 'x', '--timeout', '1'], envOf(d), o), 4);
  assert.match(o.errs.join('\n'), new RegExp(`bd-ask --wait ${ID}`));
  assert.deepEqual(o.outs, []);
});

test('an unreachable dashboard exits 3', async () => {
  const o = io();
  assert.equal(await main(['--list'], { BEAST_DASH_PORT: '1' }, o), 3);
  assert.match(o.errs[0], /cannot reach the dashboard on 127\.0\.0\.1:1/);
});

test('usage mistakes exit 2', async () => {
  for (const argv of [[], ['writer'], ['--bogus'], ['writer', 'x', '--timeout', 'soon'], ['--wait', 'r', '--file', 'f'], ['--list', 'extra'], ['--continue', 'r']]) {
    const o = io();
    assert.equal(await main(argv, { BEAST_DASH_PORT: '1' }, o), 2, argv.join(' '));
  }
  assert.throws(() => parse(['--file']), /needs a value/);
});

test('--help prints usage and exits 0', async () => {
  const o = io();
  assert.equal(await main(['--help'], {}, o), 0);
  assert.match(o.outs[0], /usage: bd-ask/);
});
