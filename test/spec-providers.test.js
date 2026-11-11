const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-spec-providers-')));
process.env.BD_TEST = '1';
process.env.BD_MIRROR = tmp;
process.env.XDG_RUNTIME_DIR = tmp;
process.env.HOME = tmp;
process.env.BD_HL_EXIT_MS = '150';
process.env.BD_SPECIALISTS_DIR = path.join(tmp, 'specialists');
const KEYS = path.join(tmp, 'keys', 'providers.json');
process.env.BD_PROVIDERS_FILE = KEYS;
fs.mkdirSync(path.dirname(KEYS), { mode: 0o700 });
fs.writeFileSync(path.join(tmp, 'claude-sessions.json'), '{}');
const PORT = 8799, procs = path.join(tmp, 'procs'), bin = path.join(tmp, 'bin'), TMUX_LOG = path.join(tmp, 'tmux-args.log');
fs.mkdirSync(procs); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
D=${JSON.stringify(procs)}
printf '%s\\n' "$*" >> ${JSON.stringify(TMUX_LOG)}
case "$1" in
  has-session) n="\${3#=}"; [ -f "$D/$n.pid" ] && kill -0 "$(cat "$D/$n.pid")" 2>/dev/null && exit 0; exit 1 ;;
  new-session)
    name=""; while [ $# -gt 1 ]; do [ "$1" = "-s" ] && name="$2"; shift; done
    cmd=$(printf '%s' "$1" | sed 's/^bash -ic /bash -c /')
    sh -c "exec $cmd" </dev/null >"$D/$name.log" 2>&1 &
    echo $! > "$D/$name.pid"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
const PATH0 = process.env.PATH; process.env.PATH = bin + ':' + PATH0;

const store = require('../lib/specialists');
const claude = require('../lib/claude');
const headless = require('../lib/headless');
const providers = require('../lib/providers');
const transcript = require('../lib/transcript');
const { createRuns } = require('../lib/specialist-runs');
const { createSpecialistApi } = require('../lib/specialist-api');
const { readBody } = require('../lib/util');
headless.init({ port: PORT, test: true });

const KEY = 'sk-test-' + 'Q7'.repeat(12) + 'zz';
const XKEY = 'xai-test-' + 'R4'.repeat(12);
const alive = name => { try { process.kill(+fs.readFileSync(path.join(procs, name + '.pid'), 'utf8'), 0); return true; } catch { return false; } };
const tmuxHas = async name => alive(name);
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); } };
const status = code => e => e instanceof store.SpecialistError && e.status === code;
const noKey = text => { assert.ok(!String(text).includes(KEY), 'the key leaked'); assert.ok(!String(text).includes(XKEY), 'the key leaked'); };
const readAll = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile()).map(d => fs.readFileSync(path.join(d.parentPath, d.name), 'utf8')).join('\n');

const mock = { requests: [], mode: 'ok', status: 200, body: null, flooded: null };
const flood = res => {
  const chunk = Buffer.alloc(64 * 1024, 'a'), sent = { n: 0 };
  res.on('close', () => { mock.flooded = sent.n; });
  const pump = () => {
    while (sent.n < 1024 && !res.destroyed) { sent.n++; if (!res.write(chunk)) { res.once('drain', pump); return; } }
    res.end();
  };
  pump();
};
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    mock.requests.push({ url: req.url, auth: req.headers.authorization, body });
    if (mock.mode === 'hang' || (mock.mode === 'hang-first' && mock.requests.length === 1)) return;
    if (mock.mode === 'flood') { res.writeHead(mock.status, { 'content-type': 'application/json' }); flood(res); return; }
    if (mock.mode === 'status') { res.writeHead(mock.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(mock.body)); return; }
    const last = body.messages[body.messages.length - 1];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: `answer ${mock.requests.length}: ${last.content}` }, finish_reason: 'stop' }] }));
  });
});
const base = () => `http://127.0.0.1:${server.address().port}/v1`;
const writeKeys = (obj, mode = 0o600) => { fs.rmSync(KEYS, { force: true }); fs.writeFileSync(KEYS, typeof obj === 'string' ? obj : JSON.stringify(obj), { mode }); fs.chmodSync(KEYS, mode); };
const goodKeys = () => writeKeys({ openai: { apiKey: KEY, baseUrl: base() }, xai: { apiKey: XKEY, baseUrl: base() + '/' } });

test.before(() => new Promise(r => server.listen(0, '127.0.0.1', r)));
test.after(() => {
  for (const f of fs.readdirSync(procs).filter(f => f.endsWith('.pid'))) { try { process.kill(+fs.readFileSync(path.join(procs, f), 'utf8'), 'SIGKILL'); } catch {} }
  server.closeAllConnections();
  server.close();
  process.env.PATH = PATH0;
  fs.rmSync(tmp, { recursive: true, force: true });
});
test.beforeEach(() => { mock.requests = []; mock.mode = 'ok'; mock.flooded = null; });

const seq = { n: 0 };
const fresh = (fields = {}) => store.create({ name: `p${++seq.n}`, ...fields });
const runs = createRuns({ store, headless, tmuxHas, claudeGet: claude.get, goneMs: 50 });

test('providers: openai and xai need a model id; claude keeps its aliases; api, codex and grok are not available yet', () => {
  assert.deepStrictEqual(store.PROVIDERS, ['claude', 'openai', 'xai']);
  assert.throws(() => fresh({ provider: 'openai' }), e => status(400)(e) && /model is required for openai/.test(e.message));
  assert.throws(() => fresh({ provider: 'xai', model: 'default' }), /model is required for xai/);
  assert.throws(() => fresh({ model: 'gpt-5' }), /claude-… model id/);
  for (const p of ['api', 'codex', 'grok']) assert.throws(() => fresh({ provider: p, model: 'm' }), e => status(400)(e) && /not available yet/.test(e.message));
  assert.throws(() => fresh({ provider: 'openai', model: 'x'.repeat(129) }), /1-128 characters/);
  assert.throws(() => fresh({ provider: 'openai', model: 'a\nb' }), /one line/);
  const p = fresh({ provider: 'openai', model: ' gpt-5-mini ', account: 'company', effort: 'max', permissionMode: 'plan' });
  assert.deepStrictEqual([p.provider, p.model, p.account, p.effort, p.permissionMode], ['openai', 'gpt-5-mini', 'company', 'max', 'plan']);
  assert.throws(() => store.update(p.name, { provider: 'claude' }), e => status(400)(e) && /claude-… model id/.test(e.message));
  assert.throws(() => store.update(p.name, { model: null }), e => status(400)(e) && /model is required/.test(e.message));
  const back = store.update(p.name, { provider: 'claude', model: 'opus' });
  assert.deepStrictEqual([back.provider, back.model, back.account, back.effort, back.permissionMode], ['claude', 'opus', 'company', 'max', 'plan']);
  assert.strictEqual(store.update(p.name, { provider: 'xai', model: 'grok-4' }).model, 'grok-4');
  const raw = JSON.parse(fs.readFileSync(path.join(p.dir, 'specialist.json'), 'utf8'));
  fs.writeFileSync(path.join(p.dir, 'specialist.json'), JSON.stringify({ ...raw, model: null }));
  assert.match(store.list().find(x => x.name === p.name).error, /invalid: model is required for xai/);
});

test('key file: missing, wrong mode, symlink, not a file, bad JSON, missing provider or key, bad baseUrl', () => {
  fs.rmSync(KEYS, { force: true });
  assert.match(providers.keyError('openai'), /^no key for openai: .*does not exist.*docs\/guide\/specialists\.md$/);
  writeKeys({ openai: { apiKey: KEY } }, 0o644);
  const loose = providers.keyError('openai');
  assert.match(loose, /can be read by other users \(mode 644\); run: chmod 600 /);
  noKey(loose);
  writeKeys({ openai: { apiKey: KEY } }, 0o640);
  assert.match(providers.keyError('openai'), /chmod 600/);
  const real = path.join(tmp, 'keys', 'real.json');
  fs.writeFileSync(real, JSON.stringify({ openai: { apiKey: KEY } }), { mode: 0o600 });
  fs.rmSync(KEYS, { force: true }); fs.symlinkSync(real, KEYS);
  assert.match(providers.keyError('openai'), /is a symlink; replace it with a regular file/);
  fs.rmSync(KEYS, { force: true }); fs.mkdirSync(KEYS, { mode: 0o700 });
  assert.match(providers.keyError('openai'), /is not a regular file/);
  fs.rmdirSync(KEYS);
  writeKeys(`{"openai":{"apiKey":"${KEY}",}`);
  const bad = providers.keyError('openai');
  assert.match(bad, /is not valid JSON/);
  noKey(bad);
  writeKeys('[1]');
  assert.match(providers.keyError('openai'), /must hold a JSON object/);
  writeKeys({ openai: { apiKey: KEY } });
  assert.strictEqual(providers.keyError('openai'), null);
  assert.match(providers.keyError('xai'), /has no "xai" entry/);
  writeKeys({ xai: 'key' });
  assert.match(providers.keyError('xai'), /"xai" in .* must be an object/);
  writeKeys({ xai: { apiKey: '  ' } });
  assert.match(providers.keyError('xai'), /"xai"\.apiKey in .* is missing or empty/);
  writeKeys({ xai: { apiKey: 'two words' } });
  assert.match(providers.keyError('xai'), /one line of plain ASCII without spaces/);
  for (const baseUrl of ['http://example.com/v1', 'ftp://127.0.0.1/', 'https://u:p@example.com/v1', 'nope']) {
    writeKeys({ xai: { apiKey: XKEY, baseUrl } });
    const e = providers.keyError('xai');
    assert.match(e, /baseUrl in .* must be an https:\/\/ URL/);
    noKey(e);
  }
  writeKeys({ xai: { apiKey: XKEY, baseUrl: 'https://proxy.example/v1/' } });
  assert.deepStrictEqual(providers.providerConfig('xai'), { apiKey: XKEY, baseUrl: 'https://proxy.example/v1' });
  writeKeys({ openai: { apiKey: KEY } });
  assert.deepStrictEqual(providers.providerConfig('openai'), { apiKey: KEY, baseUrl: 'https://api.openai.com/v1' });
  writeKeys({ xai: { apiKey: XKEY } });
  assert.strictEqual(providers.providerConfig('xai').baseUrl, 'https://api.x.ai/v1');
  assert.strictEqual(providers.keyFile({ HOME: '/home/u' }), '/home/u/.config/beast-dash/providers.json');
  assert.strictEqual(providers.keyFile({ HOME: '/home/u', BD_PROVIDERS_FILE: '/x/k.json' }), '/x/k.json');
});

test('system prompt: CLAUDE.md with @imports resolved inside the profile folder only', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'prompt-'));
  const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.md'), 'OUTSIDE');
  fs.mkdirSync(path.join(dir, 'knowledge'));
  fs.writeFileSync(path.join(dir, 'style.md'), 'STYLE');
  fs.writeFileSync(path.join(dir, 'knowledge', 'a.md'), 'A then @../style.md and @b.md');
  fs.writeFileSync(path.join(dir, 'knowledge', 'b.md'), 'B loops @a.md');
  fs.writeFileSync(path.join(dir, 'knowledge', 'big.md'), 'x'.repeat(256 * 1024 + 1));
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'knowledge', 'link.md'));
  fs.symlinkSync(outside, path.join(dir, 'knowledge', 'linkdir'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), [
    '# Role', '', '@style.md', 'see @knowledge/a.md', `@../${path.basename(outside)}/secret.md`, `@${path.join(outside, 'secret.md')}`,
    '@knowledge/link.md', '@knowledge/linkdir/secret.md', '@knowledge/missing.md', '@knowledge/big.md', '@~/x.md', 'mail me@style.md', 'inline `@style.md` code',
    '```', '@style.md', '```', `@${path.join(dir, 'style.md')}`,
  ].join('\n'));
  const text = providers.systemPrompt(dir);
  const lines = text.split('\n');
  assert.strictEqual(lines[2], 'STYLE');
  assert.strictEqual(lines[3], 'see A then STYLE and B loops @a.md');
  assert.ok(!text.includes('OUTSIDE'));
  for (const literal of [`@../${path.basename(outside)}/secret.md`, `@${path.join(outside, 'secret.md')}`, '@knowledge/link.md', '@knowledge/linkdir/secret.md', '@knowledge/missing.md', '@knowledge/big.md', '@~/x.md', 'mail me@style.md', 'inline `@style.md` code']) assert.ok(lines.includes(literal), literal);
  assert.deepStrictEqual(lines.slice(13, 16), ['```', '@style.md', '```']);
  assert.strictEqual(lines[16], 'STYLE');
  fs.rmSync(path.join(dir, 'CLAUDE.md'));
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'CLAUDE.md'));
  assert.strictEqual(providers.systemPrompt(dir), '');
  assert.strictEqual(providers.systemPrompt(path.join(tmp, 'nope')), '');
});

test('system prompt: imports reach only CLAUDE.md, style.md, knowledge/ and examples/, never .secrets, .bd, .git or dot names', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'prompt-'));
  for (const d of ['.secrets', '.bd', '.git', '.claude', 'knowledge', 'examples', 'other']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, '.secrets', 'accesses.json'), '{"DB_URL":{"value":"SECRET-VALUE"}}');
  fs.writeFileSync(path.join(dir, '.bd', 'trainer.json'), 'BD-FILE');
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'GIT-FILE');
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), 'CLAUDE-FILE');
  fs.writeFileSync(path.join(dir, 'specialist.json'), 'META-FILE');
  fs.writeFileSync(path.join(dir, 'other', 'x.md'), 'OTHER-FILE');
  fs.writeFileSync(path.join(dir, 'knowledge', '.hidden.md'), 'HIDDEN-FILE');
  fs.writeFileSync(path.join(dir, 'knowledge', 'up.md'), 'UP @../.secrets/accesses.json');
  fs.writeFileSync(path.join(dir, 'examples', 'one.md'), 'EXAMPLE');
  fs.symlinkSync(path.join(dir, '.secrets'), path.join(dir, 'knowledge', 'keys'));
  const refs = ['@.secrets/accesses.json', '@./.secrets/accesses.json', '@knowledge/../.secrets/accesses.json', '@.bd/trainer.json', '@.git/config', '@.claude/settings.json', '@specialist.json', '@other/x.md', '@knowledge/.hidden.md', '@knowledge/keys/accesses.json', `@${path.join(dir, '.secrets', 'accesses.json')}`];
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), [...refs, '@knowledge/up.md', '@examples/one.md'].join('\n'));
  const lines = providers.systemPrompt(dir).split('\n');
  assert.deepStrictEqual(lines, [...refs, 'UP @../.secrets/accesses.json', 'EXAMPLE']);
  assert.strictEqual(providers.shutImport('fine @knowledge/a.md and me@x'), null);
  for (const ref of ['@.secrets/accesses.json', '@knowledge/../.bd/runs', '@../other/.git/config', '@~/.secrets', 'x\n@./.git']) assert.ok(providers.shutImport(ref), ref);
});

test('chat: one /chat/completions request; 401, 403, 404, 429, 5xx, 400, network errors, timeouts and stops never show the key', async () => {
  goodKeys();
  const r = await providers.chat({ provider: 'openai', model: 'gpt-5', system: 'SYS', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r.text, 'answer 1: hi');
  assert.deepStrictEqual(mock.requests[0], { url: '/v1/chat/completions', auth: `Bearer ${KEY}`, body: { model: 'gpt-5', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] } });
  await providers.chat({ provider: 'xai', model: 'grok-4', system: ' ', messages: [{ role: 'user', content: 'yo' }] });
  assert.deepStrictEqual([mock.requests[1].url, mock.requests[1].auth, mock.requests[1].body.messages.length], ['/v1/chat/completions', `Bearer ${XKEY}`, 1]);
  const failWith = async (provider, re) => {
    const e = await providers.chat({ provider, model: 'm', system: '', messages: [{ role: 'user', content: 'x' }], timeoutMs: 300 }).then(() => null, e => e);
    assert.ok(e instanceof providers.ProviderError, String(e));
    assert.match(e.message, re);
    noKey(e.message); noKey(e.stack);
    assert.doesNotMatch(e.message, /abort|interrupt|cancel/i);
    return e;
  };
  mock.mode = 'status';
  const cases = [
    [401, /^OpenAI refused the API key \(401\); check "openai"\.apiKey in /],
    [403, /refused the API key \(403\)/],
    [404, /^OpenAI answered 404; check the model id and "openai"\.baseUrl: no model m$/],
    [429, /^OpenAI rate limit or quota reached \(429\); try again later: slow down \[key\]$/],
    [500, /^OpenAI server error \(500\); try again later$/],
    [503, /server error \(503\)/],
    [400, /^OpenAI rejected the request \(400\): bad Bearer \[key\] \[key\]$/],
  ];
  const bodies = { 401: { error: { message: `wrong key ${KEY}` } }, 403: { error: 'no' }, 404: { error: { message: 'no model m' } }, 429: { error: { message: `slow down ${KEY}` } }, 500: { error: { message: KEY } }, 503: 'x', 400: { error: { message: `bad Bearer ${KEY} sk-other-0123456789ab` } } };
  for (const [code, re] of cases) { mock.status = code; mock.body = bodies[code]; await failWith('openai', re); }
  mock.status = 200; mock.body = { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
  await failWith('openai', /^OpenAI sent an answer without text \(finish_reason length\)$/);
  mock.mode = 'hang';
  await failWith('xai', /^xAI did not answer within 1 s$/);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 100);
  const stop = await providers.chat({ provider: 'xai', model: 'm', system: '', messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal }).then(() => null, e => e);
  assert.strictEqual(stop.stopped, true);
  const closed = http.createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise(r => closed.close(r));
  writeKeys({ openai: { apiKey: KEY, baseUrl: `http://127.0.0.1:${port}/v1` } });
  await failWith('openai', new RegExp(`^OpenAI could not be reached at 127\\.0\\.0\\.1:${port} \\(ECONNREFUSED\\)$`));
  fs.rmSync(KEYS);
  await failWith('openai', /^no key for openai: .*does not exist/);
});

test('chat: an answer over 8 MiB and an endless error body are cut off while reading', async () => {
  goodKeys();
  const ask = () => providers.chat({ provider: 'openai', model: 'm', system: '', messages: [{ role: 'user', content: 'x' }], timeoutMs: 20000 }).then(() => null, e => e);
  mock.mode = 'flood';
  for (const [code, re] of [[200, /^OpenAI sent an answer larger than 8388608 bytes$/], [500, /^OpenAI server error \(500\); try again later$/], [400, /^OpenAI rejected the request \(400\)$/]]) {
    mock.status = code; mock.flooded = null;
    const e = await ask();
    assert.ok(e instanceof providers.ProviderError, String(e));
    assert.match(e.message, re);
    await until(() => mock.flooded !== null);
    assert.ok(mock.flooded < 1024, `the whole body was sent (${mock.flooded} chunks)`);
  }
});

const call = async (api, method, p, body) => {
  const srv = http.createServer(async (req, res) => {
    const send = (r, code, obj) => { r.writeHead(code, { 'content-type': 'application/json' }); r.end(JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://x');
    if (!(await api.handle(req, res, url.pathname.split('/').filter(Boolean).slice(1), url, send))) send(res, 418, {});
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    noKey(text);
    return [r.status, JSON.parse(text)];
  } finally { srv.close(); }
};

test('no key: asking answers 409 with what to fix, list and detail still work and say why; files are refused', async () => {
  fs.rmSync(KEYS, { force: true });
  const p = fresh({ provider: 'openai', model: 'gpt-5' });
  const api = createSpecialistApi({ store, runs, readBody });
  const [code, body] = await call(api, 'POST', `/api/specialist/${p.name}/ask`, { text: 'hello' });
  assert.strictEqual(code, 409);
  assert.strictEqual(body.ok, false);
  assert.match(body.error, /^no key for openai: .*see docs\/guide\/specialists\.md$/);
  const [lc, list] = await call(api, 'GET', '/api/specialists');
  assert.strictEqual(lc, 200);
  assert.match(list.specialists.find(s => s.name === p.name).keyError, /^no key for openai/);
  const [gc, got] = await call(api, 'GET', `/api/specialist/${p.name}`);
  assert.strictEqual(gc, 200);
  assert.match(got.specialist.keyError, /^no key for openai/);
  const c = fresh();
  assert.ok(!('keyError' in (await call(api, 'GET', `/api/specialist/${c.name}`))[1].specialist));
  goodKeys();
  assert.strictEqual((await call(api, 'GET', `/api/specialist/${p.name}`))[1].specialist.keyError, null);
  const [fc, fb] = await call(api, 'POST', `/api/specialist/${p.name}/ask`, { text: 'x', files: [KEYS] });
  assert.deepStrictEqual([fc, fb.error], [400, 'files are not available for openai specialists: they only get the task text']);
  assert.strictEqual(mock.requests.length, 0);
  assert.strictEqual(store.listRuns(p.name).length, 0);
});

test('run: one request with the resolved instructions, a claude-shaped run record and chat transcript, a follow-up keeps the history', async () => {
  goodKeys();
  const p = fresh({ provider: 'openai', model: 'gpt-5', account: 'company', effort: 'high', permissionMode: 'plan' });
  fs.writeFileSync(path.join(p.dir, 'CLAUDE.md'), '# Helper\n\n@knowledge/notes.md\n');
  fs.mkdirSync(path.join(p.dir, 'knowledge'));
  fs.writeFileSync(path.join(p.dir, 'knowledge', 'notes.md'), 'Answer briefly.');
  const run = await runs.ask(p.name, { text: 'what is 2+2?', wait: true, timeoutSec: 20 });
  assert.strictEqual(run.state, 'done', run.error);
  assert.match(run.runId, new RegExp(`^claude-spec-${p.name}-\\d{6}-\\d{4}$`));
  assert.deepStrictEqual([run.mode, run.account, run.text, run.error, run.turns, run.truncated], ['run', 'personal', 'answer 1: what is 2+2?', null, 1, false]);
  assert.deepStrictEqual(Object.keys(run).sort(), ['account', 'cwd', 'endedAt', 'error', 'mode', 'runId', 'sessionId', 'specialist', 'startedAt', 'state', 'task', 'text', 'tmux', 'transcriptPath', 'truncated', 'turns'].sort());
  assert.strictEqual(run.transcriptPath, path.join(p.dir, '.bd', 'conversations', run.sessionId + '.jsonl'));
  assert.strictEqual(mock.requests.length, 1);
  assert.deepStrictEqual(mock.requests[0].body, { model: 'gpt-5', messages: [{ role: 'system', content: '# Helper\n\nAnswer briefly.\n' }, { role: 'user', content: 'what is 2+2?' }] });
  assert.strictEqual(fs.statSync(run.transcriptPath).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(run.transcriptPath)).mode & 0o777, 0o700);
  const t = transcript.tail(run.transcriptPath);
  assert.deepStrictEqual(t.turns.map(x => [x.role, x.role === 'user' ? x.text : x.steps.map(s => s.text).join('')]), [['user', 'what is 2+2?'], ['assistant', 'answer 1: what is 2+2?']]);
  assert.ok(Number.isFinite(t.turns[1].dur));
  const rec = claude.get(run.tmux);
  assert.deepStrictEqual([rec.specialist, rec.runner.provider, rec.runner.model, rec.transcriptPath], [p.name, 'openai', 'gpt-5', run.transcriptPath]);
  await until(() => !alive(run.tmux));
  const again = await runs.send(run.runId, { text: 'and 3+3?', wait: true, timeoutSec: 20 });
  assert.deepStrictEqual([again.state, again.turns, again.text], ['done', 2, 'answer 2: and 3+3?'], again.error);
  assert.deepStrictEqual(mock.requests[1].body.messages.slice(1), [{ role: 'user', content: 'what is 2+2?' }, { role: 'assistant', content: 'answer 1: what is 2+2?' }, { role: 'user', content: 'and 3+3?' }]);
  await until(() => !alive(run.tmux));
  store.update(p.name, { provider: 'claude', model: null });
  await assert.rejects(runs.send(run.runId, { text: 'more' }), e => status(409)(e) && /another provider/.test(e.message));
  const tmuxArgs = fs.readFileSync(TMUX_LOG, 'utf8');
  assert.match(tmuxArgs, /api-runner\.js/);
  assert.match(tmuxArgs, new RegExp(`--keys.*${KEYS.replace(/[.]/g, '\\.')}`));
  noKey(tmuxArgs);
  noKey(readAll(path.join(p.dir, '.bd')));
  noKey(readAll(procs));
  noKey(fs.readFileSync(path.join(tmp, 'claude-sessions.json'), 'utf8'));
});

test('thread: a follow-up continues the same conversation; the runner env and argv hold no key', async () => {
  goodKeys();
  const p = fresh({ provider: 'xai', model: 'grok-4', mode: 'thread' });
  const first = await runs.ask(p.name, { text: 'remember 7', wait: true, timeoutSec: 20 });
  assert.deepStrictEqual([first.state, first.runId, first.mode, first.text], ['done', `claude-spec-${p.name}_1`, 'thread', 'answer 1: remember 7'], first.error);
  const second = await runs.ask(p.name, { text: 'what number?', wait: true, timeoutSec: 20 });
  assert.deepStrictEqual([second.state, second.runId, second.sessionId, second.transcriptPath], ['done', `claude-spec-${p.name}_2`, first.sessionId, first.transcriptPath], second.error);
  assert.deepStrictEqual(mock.requests[1].body.messages, [{ role: 'system', content: providers.systemPrompt(p.dir) }, { role: 'user', content: 'remember 7' }, { role: 'assistant', content: 'answer 1: remember 7' }, { role: 'user', content: 'what number?' }]);
  assert.strictEqual(mock.requests[1].auth, `Bearer ${XKEY}`);
  const tmux = store.threadName(p.name, 'personal');
  assert.ok(alive(tmux));
  const pid = fs.readFileSync(path.join(procs, tmux + '.pid'), 'utf8').trim();
  noKey(fs.readFileSync(`/proc/${pid}/environ`, 'utf8'));
  const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  assert.match(argv, /api-runner\.js/);
  noKey(argv);
  const live = await headless.status(tmux);
  assert.deepStrictEqual([live.v, live.provider, live.model, live.claude, live.version, live.state], [2, 'xai', 'grok-4', null, null, 'idle']);
  const detail = await runs.detail(p.name, 10);
  assert.deepStrictEqual([detail.thread.live, detail.runs.length, detail.specialist.keyError], [true, 2, null]);
  store.update(p.name, { provider: 'openai', model: 'gpt-5' });
  await assert.rejects(runs.ask(p.name, { text: 'x' }), e => status(409)(e) && /still runs on xai/.test(e.message));
  noKey(readAll(path.join(p.dir, '.bd')));
});

test('a conversation file past 16 MiB still sends the new task with the newest history and keeps the link', async () => {
  goodKeys();
  const p = fresh({ provider: 'openai', model: 'gpt-5' });
  const run = await runs.ask(p.name, { text: 'start', wait: true, timeoutSec: 20 });
  assert.strictEqual(run.state, 'done', run.error);
  await until(() => !alive(run.tmux));
  const big = 'x'.repeat(100 * 1024);
  const pad = Array.from({ length: 180 }, (_, i) => ({ type: i % 2 ? 'assistant' : 'user', uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, sessionId: run.sessionId,
    message: i % 2 ? { role: 'assistant', content: [{ type: 'text', text: `old ${i} ${big}` }] } : { role: 'user', content: `old ${i} ${big}` } }));
  fs.appendFileSync(run.transcriptPath, pad.map(e => JSON.stringify(e) + '\n').join(''));
  assert.ok(fs.statSync(run.transcriptPath).size > 16 * 1024 * 1024);
  const again = await runs.send(run.runId, { text: 'after the padding', wait: true, timeoutSec: 30 });
  assert.deepStrictEqual([again.state, again.text], ['done', 'answer 2: after the padding'], again.error);
  const sent = mock.requests[1].body.messages;
  assert.deepStrictEqual(sent[sent.length - 1], { role: 'user', content: 'after the padding' });
  assert.ok(sent[sent.length - 2].content.startsWith('old 179 '));
  assert.ok(sent.length > 2 && sent.length < 10 && sent[1].role === 'user');
  const entries = fs.readFileSync(run.transcriptPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const asked = entries.find(e => e.type === 'user' && e.message.content === 'after the padding');
  assert.strictEqual(asked.parentUuid, pad[pad.length - 1].uuid);
});

test('a restart during a turn sends the task again and the run waits for that answer', async () => {
  goodKeys();
  const p = fresh({ provider: 'xai', model: 'grok-4' });
  mock.mode = 'hang-first';
  const run = await runs.ask(p.name, { text: 'slow one' });
  await until(() => mock.requests.length === 1);
  await until(async () => (await headless.status(run.runId) || {}).state === 'working');
  assert.ok((await headless.restart(run.runId)).ok);
  const done = await runs.get(run.runId, { wait: true, timeoutSec: 20 });
  assert.deepStrictEqual([done.state, done.text, done.error], ['done', 'answer 2: slow one', null]);
  assert.deepStrictEqual(mock.requests[1].body, mock.requests[0].body);
  const t = transcript.tail(done.transcriptPath);
  assert.deepStrictEqual(t.turns.map(x => x.role), ['user', 'assistant']);
});

test('errors and stops: a refused key ends the run as error without the key; an interrupt stops it', async () => {
  goodKeys();
  const p = fresh({ provider: 'openai', model: 'gpt-5' });
  mock.mode = 'status'; mock.status = 401; mock.body = { error: { message: `Incorrect API key provided: ${KEY}` } };
  const bad = await runs.ask(p.name, { text: 'hi', wait: true, timeoutSec: 20 });
  assert.strictEqual(bad.state, 'error');
  assert.match(bad.error, /^error_during_execution: OpenAI refused the API key \(401\); check "openai"\.apiKey in /);
  noKey(JSON.stringify(bad));
  mock.mode = 'hang';
  const slow = await runs.ask(p.name, { text: 'take your time' });
  await until(() => mock.requests.length === 2);
  await until(async () => (await headless.status(slow.runId) || {}).state === 'working');
  assert.strictEqual((await headless.shell(slow.runId, 'ls')).error, '! commands are not available in OpenAI sessions');
  assert.match((await headless.setModel(slow.runId, 'opus')).error, /set in the specialist profile/);
  assert.strictEqual((await headless.send(slow.runId, 'more')).ok, false);
  assert.ok((await headless.interrupt(slow.runId)).ok);
  const stopped = await runs.get(slow.runId, { wait: true, timeoutSec: 20 });
  assert.deepStrictEqual([stopped.state, stopped.error], ['stopped', null]);
  const t = transcript.tail(stopped.transcriptPath);
  assert.deepStrictEqual(t.turns.map(x => x.role === 'event' ? x.status : x.role), ['user', 'interrupted']);
  noKey(readAll(path.join(p.dir, '.bd')));
  noKey(readAll(procs));
});
