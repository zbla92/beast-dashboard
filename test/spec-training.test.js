const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-spec-train-')));
process.env.BD_TEST = '1';
process.env.BD_MIRROR = tmp;
process.env.XDG_RUNTIME_DIR = tmp;
process.env.HOME = tmp;
process.env.BD_HL_EXIT_MS = '150';
process.env.BD_SPECIALISTS_DIR = path.join(tmp, 'specialists');
const PORT = 8798, procs = path.join(tmp, 'procs'), bin = path.join(tmp, 'bin');
const RUNNER = path.join(__dirname, '..', 'bin', 'headless-runner.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const FAKE_ARGS = path.join(tmp, 'fake-args.jsonl'), FAKE_INPUT = path.join(tmp, 'fake-input.jsonl');
const SECRET = 'postgres://reader:s3cret-value-9f2@db.invalid/app';
process.env.FAKE_ARGS = FAKE_ARGS;
process.env.FAKE_INPUT = FAKE_INPUT;
process.env.FAKE_ENV_SHOW = 'DB_URL';
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
const accesses = require('../lib/accesses');
const { createRuns } = require('../lib/specialist-runs');
const { createSpecialistApi } = require('../lib/specialist-api');
const { createTraining, cleanName, summaryLine, feedbackMessage } = require('../lib/training');
const { readBody } = require('../lib/util');
headless.init({ port: PORT, test: true, claudeBin: FAKE });

const pidOf = name => { try { return +fs.readFileSync(path.join(procs, name + '.pid'), 'utf8'); } catch { return 0; } };
const alive = name => { try { process.kill(pidOf(name), 0); return pidOf(name) > 0; } catch { return false; } };
const tmuxHas = async name => alive(name);
const lines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const fakeArgs = () => lines(FAKE_ARGS).filter(a => a.argv);
const inputs = () => lines(FAKE_INPUT).map(c => Array.isArray(c) ? c.map(b => b.text || '').join('') : c);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); } };
const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });

const training = createTraining({ store, headless, tmuxHas, claudeGet: claude.get, goneMs: 50 });
const runs = createRuns({ store, headless, tmuxHas, claudeGet: claude.get, training, goneMs: 50 });
const api = createSpecialistApi({ store, runs, training, readBody });
const reply = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  if (!(await api.handle(req, res, parts, url, reply))) reply(res, 418, { other: true });
});
const listening = new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = async () => { await listening; return `http://127.0.0.1:${srv.address().port}`; };
const responses = [];
const call = async (method, p, body) => {
  const r = await fetch((await base()) + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  responses.push(text);
  return [r.status, JSON.parse(text)];
};
const upload = async (name, filename, chunks, { chunked = false } = {}) => {
  const u = new URL(`${await base()}/api/specialist/${name}/train/upload?filename=${encodeURIComponent(filename)}`);
  const parts = Array.isArray(chunks) ? chunks : [chunks];
  const size = parts.reduce((n, c) => n + Buffer.byteLength(c), 0);
  return new Promise((resolve, reject) => {
    const req = http.request(u, { method: 'POST', headers: chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': size } }, res => {
      const out = [];
      res.on('data', d => out.push(d));
      res.on('end', () => { const text = Buffer.concat(out).toString('utf8'); responses.push(text); resolve([res.statusCode, JSON.parse(text), res.headers.connection]); });
    });
    req.on('error', e => { if (!['EPIPE', 'ECONNRESET'].includes(e.code)) reject(e); });
    (async () => { for (const c of parts) { if (req.destroyed) return; if (!req.write(c)) await new Promise(r => req.once('drain', r)); } req.end(); })().catch(() => {});
  });
};

test.after(() => {
  for (const f of fs.readdirSync(procs).filter(f => f.endsWith('.pid'))) { try { process.kill(+fs.readFileSync(path.join(procs, f), 'utf8'), 'SIGKILL'); } catch {} }
  srv.close();
  process.env.PATH = PATH0;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const counter = { n: 0 };
const fresh = (fields = {}) => store.create({ name: `t${++counter.n}`, ...fields });
const trainerDone = name => until(async () => { const [, o] = await call('GET', `/api/specialist/${name}/train`); return o.trainer && o.trainer.live && o.trainer.state === 'idle' ? o : null; });

test('file names: NFC, unsafe characters become -, runs collapse, 100 chars with the extension kept; type and shape errors', () => {
  assert.deepStrictEqual(cleanName('Notes — v1!!.md'), { stem: 'Notes - v1-', ext: 'md' });
  assert.deepStrictEqual(cleanName('../../a/b\\Plan   (final).PDF'), { stem: 'Plan (final)', ext: 'PDF' });
  assert.deepStrictEqual(cleanName('Cafe\u0301.txt').stem, 'Café');
  const status = code => e => e instanceof store.SpecialistError && e.status === code;
  assert.throws(() => cleanName('run.exe'), e => status(415)(e) && e.message === ".exe files can't be used for training: save it as PDF or text");
  for (const bad of ['', '.env', '-x.md', 'noext', '!!!']) assert.throws(() => cleanName(bad), status(400), bad);
  assert.strictEqual(summaryLine('Changed the tone.\n\n**Summary:** Warmer greetings\n'), 'Warmer greetings');
  assert.strictEqual(summaryLine('Summary: first\nmore\nSummary: second'), 'second');
  assert.strictEqual(summaryLine('No summary here'), null);
  const msg = feedbackMessage({ title: 'Writer' }, { runId: 'claude-spec-w-261111-0930', original: 'Hi\n\nthere', better: null, note: 'Say hello' });
  assert.strictEqual(msg, 'Feedback on an answer from Writer (run claude-spec-w-261111-0930):\n\nThe answer it gave:\n> Hi\n>\n> there\n\nNote from the owner: Say hello\n\nChange the profile so future answers come out like the better version. Change only what this feedback is about.');
});

test('runner flags: trainer runs restricted with its settings and no accesses; other runs get --accesses', () => {
  assert.deepStrictEqual(headless.runnerArgs({ trainer: true, settings: '/t/settings.json', addDirs: ['/p'], permissionMode: 'plan', accesses: '/p', model: 'opus' }), ['--trainer', '--settings', '/t/settings.json', '--add-dir', '/p']);
  assert.deepStrictEqual(headless.runnerArgs({ permissionMode: 'plan', addDirs: [], accesses: '/p' }), ['--permission-mode', 'plan', '--accesses', '/p']);
  claude.markChat('claude-spec-zz_train', { cwd: tmp, account: 'personal', sessionId: '11111111-2222-4333-8444-555555555555', specialist: 'zz', runner: { trainer: true, addDirs: ['/p'] } });
  assert.deepStrictEqual(claude.get('claude-spec-zz_train').runner.settings, null);
  assert.deepStrictEqual(headless.runnerArgs(claude.get('claude-spec-zz_train').runner).slice(0, 3), ['--trainer', '--settings', '']);
});

test('runner: --trainer needs --settings and refuses --accesses', async () => {
  const run = extra => new Promise(r => spawn(process.execPath, [RUNNER, '--sock', path.join(tmp, 'x.sock'), '--cwd', tmp, '--session-id', '11111111-2222-4333-8444-555555555555', '--start', 'new', ...extra], { stdio: 'ignore' }).on('exit', r));
  assert.strictEqual(await run(['--trainer']), 2);
  assert.strictEqual(await run(['--trainer', '--settings', 'rel.json']), 2);
  assert.strictEqual(await run(['--trainer', '--settings', '/t/s.json', '--accesses', '/p']), 2);
  assert.strictEqual(await run(['--settings', 'rel.json']), 2);
});

test('history: nothing on disk before training; uploads init git with a starting point, outside changes, diff, pagination', async () => {
  const p = fresh();
  const [g, empty] = await call('GET', `/api/specialist/${p.name}/train`);
  assert.strictEqual(g, 200);
  assert.deepStrictEqual([empty.trainer, empty.history, empty.feedback, empty.accesses, empty.uploads], [null, { ready: false, head: null, commits: [] }, [], [], { files: 0, bytes: 0, maxFiles: 500, maxBytes: 209715200 }]);
  assert.deepStrictEqual((await call('GET', `/api/specialist/${p.name}/train/history`))[1], { ok: true, commits: [], more: false });
  assert.ok(!fs.existsSync(path.join(p.dir, '.git')) && !fs.existsSync(path.join(p.dir, 'knowledge')));
  const before = store.get(p.name).updatedAt;
  const [u, up] = await upload(p.name, 'Notes — v1!!.md', 'hello\n');
  assert.strictEqual(u, 201);
  assert.deepStrictEqual(up.file, { path: 'knowledge/files/Notes - v1-.md', bytes: 6 });
  assert.deepStrictEqual([up.commit.message, up.commit.source, up.commit.undoOf, up.commit.undone, up.commit.files], ['Added Notes - v1-.md', 'upload', null, false, [{ path: 'knowledge/files/Notes - v1-.md', change: 'added' }]]);
  assert.match(up.commit.id, /^[0-9a-f]{40}$/);
  assert.strictEqual(up.commit.short, up.commit.id.slice(0, 7));
  assert.notStrictEqual(store.get(p.name).updatedAt, before);
  assert.strictEqual(fs.readFileSync(path.join(p.dir, '.gitignore'), 'utf8'), '/*\n!/CLAUDE.md\n!/style.md\n!/knowledge/\n!/examples/\n/.secrets/\n/.bd/\n/.trainers/\n');
  assert.deepStrictEqual(gitIn(p.dir, 'ls-files').trim().split('\n').sort(), ['CLAUDE.md', 'knowledge/files/Notes - v1-.md']);
  assert.strictEqual(gitIn(p.dir, 'branch', '--show-current').trim(), 'main');
  assert.strictEqual(gitIn(p.dir, 'log', '-1', '--format=%an <%ae>').trim(), 'beast-dash <beast-dash@localhost>');
  const [, again] = await upload(p.name, 'a.txt', 'one');
  const [, twice] = await upload(p.name, 'a.txt', 'two');
  assert.deepStrictEqual([again.file.path, twice.file.path], ['knowledge/files/a.txt', 'knowledge/files/a-2.txt']);
  fs.writeFileSync(path.join(p.dir, 'style.md'), 'Warm and short.\n');
  fs.writeFileSync(path.join(p.dir, '.bd-note'), 'not tracked');
  const [, third] = await upload(p.name, 'b.csv', 'x,y\n');
  const [, hist] = await call('GET', `/api/specialist/${p.name}/train/history`);
  assert.deepStrictEqual(hist.commits.map(c => [c.source, c.message]), [['upload', 'Added b.csv'], ['outside', 'Changes made outside training'], ['upload', 'Added a-2.txt'], ['upload', 'Added a.txt'], ['upload', 'Added Notes - v1-.md'], ['start', 'Starting point']]);
  assert.deepStrictEqual(hist.commits[1].files, [{ path: 'style.md', change: 'added' }]);
  assert.strictEqual(hist.more, false);
  assert.strictEqual(third.commit.id, hist.commits[0].id);
  const [, page] = await call('GET', `/api/specialist/${p.name}/train/history?limit=2&before=${hist.commits[1].short}`);
  assert.deepStrictEqual([page.commits.map(c => c.message), page.more], [['Added a-2.txt', 'Added a.txt'], true]);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/history?before=${'0'.repeat(40)}`))[0], 404);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/history?before=zz`))[0], 400);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/history?limit=201`))[0], 400);
  const [d, detail] = await call('GET', `/api/specialist/${p.name}/train/commit/${hist.commits[1].short}`);
  assert.strictEqual(d, 200);
  assert.strictEqual(detail.commit.id, hist.commits[1].id);
  assert.match(detail.diff, /^diff --git a\/style\.md b\/style\.md/);
  assert.match(detail.diff, /\+Warm and short\./);
  assert.strictEqual(detail.truncated, false);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/commit/deadbeef`))[0], 404);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/commit/xyz`))[0], 400);
  const [, view] = await call('GET', `/api/specialist/${p.name}/train`);
  assert.deepStrictEqual([view.history.ready, view.history.head, view.history.commits.length, view.uploads.files, view.uploads.bytes], [true, hist.commits[0].id, 6, 4, 6 + 3 + 3 + 4]);
});

test('uploads: limits, traversal, symlinked folders and trainable paths are refused', async () => {
  const p = fresh();
  const [code, , conn] = await upload(p.name, 'big.txt', Buffer.alloc(20 * 1024 * 1024 + 1, 'a'));
  assert.deepStrictEqual([code, conn], [413, 'close']);
  const chunk = Buffer.alloc(1024 * 1024, 'b');
  const [streamed, out] = await upload(p.name, 'stream.txt', Array.from({ length: 21 }, () => chunk), { chunked: true });
  assert.deepStrictEqual([streamed, out.error], [413, 'a file can be at most 20 MiB']);
  assert.deepStrictEqual(fs.readdirSync(path.join(p.dir, 'knowledge', 'files')), []);
  assert.strictEqual((await upload(p.name, 'run.exe', 'x'))[0], 415);
  assert.strictEqual((await upload(p.name, '.env', 'x'))[0], 400);
  const meta = fs.readFileSync(path.join(p.dir, 'specialist.json'), 'utf8');
  const [t, trav] = await upload(p.name, '../../specialist.json', '{"evil":true}');
  assert.deepStrictEqual([t, trav.file.path], [201, 'knowledge/files/specialist.json']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(p.dir, 'specialist.json'), 'utf8')).name, JSON.parse(meta).name);
  assert.strictEqual((await upload(p.name, '..%2F..%2Fx.md', 'y'))[0], 400);
  assert.strictEqual((await upload(p.name, 'a/../../b.md', 'y'))[1].file.path, 'knowledge/files/b.md');
  const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
  const q = fresh();
  fs.mkdirSync(path.join(q.dir, 'knowledge'));
  fs.symlinkSync(outside, path.join(q.dir, 'knowledge', 'files'));
  const [s, sym] = await upload(q.name, 'a.md', 'x');
  assert.deepStrictEqual([s, sym.error], [409, 'knowledge/files/ is not a plain folder']);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
  const r = fresh();
  fs.symlinkSync(outside, path.join(r.dir, 'examples'));
  for (const [m, route, body] of [['GET', 'train'], ['GET', 'train/history'], ['POST', 'train/undo', { commit: 'abcdef1' }], ['POST', 'train/send', { text: 'hi' }], ['POST', 'train/feedback', { note: 'x' }]]) {
    const [c, o] = await call(m, `/api/specialist/${r.name}/${route}`, body);
    assert.deepStrictEqual([route, c, o.error], [route, 409, 'examples must be a real folder, not a symlink']);
  }
  assert.strictEqual((await upload(r.name, 'a.md', 'x'))[0], 409);
  assert.ok(!fs.existsSync(path.join(r.dir, '.git')));
  const full = fresh();
  fs.mkdirSync(path.join(full.dir, 'knowledge', 'files'), { recursive: true });
  Array.from({ length: 500 }, (_, i) => fs.writeFileSync(path.join(full.dir, 'knowledge', 'files', `f${i}.txt`), ''));
  assert.strictEqual((await upload(full.name, 'one-more.txt', 'x'))[0], 413);
  assert.strictEqual((await call('GET', '/api/specialist/nobody/train'))[0], 404);
});

test('undo: reverts one commit, undo of an undo, conflicts leave the files as they were, the starting point is 400', async () => {
  const p = fresh();
  const [, up] = await upload(p.name, 'a.txt', 'one');
  const [s, undone] = await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: up.commit.short });
  assert.strictEqual(s, 201);
  assert.deepStrictEqual([undone.commit.source, undone.commit.message, undone.commit.undoOf, undone.commit.files], ['undo', 'Undo: Added a.txt', up.commit.id, [{ path: 'knowledge/files/a.txt', change: 'deleted' }]]);
  assert.ok(!fs.existsSync(path.join(p.dir, 'knowledge', 'files', 'a.txt')));
  const [, h1] = await call('GET', `/api/specialist/${p.name}/train/history`);
  assert.strictEqual(h1.commits.find(c => c.id === up.commit.id).undone, true);
  const [, redo] = await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: undone.commit.id });
  assert.strictEqual(redo.commit.message, 'Undo: Undo: Added a.txt');
  assert.strictEqual(fs.readFileSync(path.join(p.dir, 'knowledge', 'files', 'a.txt'), 'utf8'), 'one');
  const [, h2] = await call('GET', `/api/specialist/${p.name}/train/history`);
  assert.deepStrictEqual(h2.commits.slice(0, 3).map(c => c.undone), [false, true, false]);
  const start = h2.commits[h2.commits.length - 1];
  assert.deepStrictEqual(await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: start.id }), [400, { ok: false, error: "the starting point can't be undone" }]);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: 'nothex' }))[0], 400);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: 'abcdef1', extra: 1 }))[0], 400);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: '0000000' }))[0], 404);
  const claudeMd = path.join(p.dir, 'CLAUDE.md');
  fs.writeFileSync(claudeMd, 'line one\nline two\n');
  await upload(p.name, 'b.txt', 'b');
  fs.writeFileSync(claudeMd, 'line one\nline two changed\n');
  await upload(p.name, 'c.txt', 'c');
  const [, h3] = await call('GET', `/api/specialist/${p.name}/train/history`);
  const first = h3.commits.filter(c => c.source === 'outside')[1];
  const [c, conflict] = await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: first.id });
  assert.deepStrictEqual([c, conflict.error], [409, 'later changes touch the same lines; undo those first']);
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf8'), 'line one\nline two changed\n');
  assert.strictEqual(gitIn(p.dir, 'status', '--porcelain').trim(), '');
  const [, h4] = await call('GET', `/api/specialist/${p.name}/train/history`);
  assert.strictEqual(h4.commits.length, h3.commits.length);
});

test('profile tab: an instructions update is its own commit once history exists; ifUpdatedAt still guards', async () => {
  const p = fresh();
  const [, plain] = await call('POST', `/api/specialist/${p.name}`, { instructions: 'v0\n' });
  assert.ok(!fs.existsSync(path.join(p.dir, '.git')));
  await upload(p.name, 'a.txt', 'a');
  fs.writeFileSync(path.join(p.dir, 'style.md'), 'by hand\n');
  const [u, upd] = await call('POST', `/api/specialist/${p.name}`, { instructions: 'v1\n', ifUpdatedAt: store.get(p.name).updatedAt });
  assert.strictEqual(u, 200);
  assert.strictEqual(upd.specialist.updatedAt, store.get(p.name).updatedAt);
  const [, hist] = await call('GET', `/api/specialist/${p.name}/train/history`);
  assert.deepStrictEqual(hist.commits.slice(0, 2).map(c => [c.source, c.message, c.files.map(f => f.path).join()]), [['profile', 'Edited instructions', 'CLAUDE.md'], ['outside', 'Changes made outside training', 'style.md']]);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}`, { instructions: 'v2\n', ifUpdatedAt: plain.specialist.updatedAt }))[0], 409);
  const [, same] = await call('POST', `/api/specialist/${p.name}`, { title: 'Renamed' });
  assert.strictEqual(same.specialist.title, 'Renamed');
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/history`))[1].commits.length, hist.commits.length);
});

test('accesses: validated, kept 0600 in .secrets, never returned, logged in history or committed', async () => {
  const p = fresh();
  assert.deepStrictEqual(await call('GET', `/api/specialist/${p.name}/accesses`), [200, { ok: true, accesses: [], usedByRuns: true }]);
  const [c, made] = await call('POST', `/api/specialist/${p.name}/accesses`, { name: 'DB_URL', value: SECRET, note: 'read replica' });
  assert.strictEqual(c, 200);
  assert.deepStrictEqual(Object.keys(made.access), ['name', 'note', 'bytes', 'updatedAt']);
  assert.deepStrictEqual([made.access.name, made.access.note, made.access.bytes], ['DB_URL', 'read replica', Buffer.byteLength(SECRET)]);
  assert.match(made.access.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  await call('POST', `/api/specialist/${p.name}/accesses`, { name: 'API_TOKEN', value: 'tok\nline two' });
  assert.deepStrictEqual((await call('GET', `/api/specialist/${p.name}/accesses`))[1].accesses.map(a => a.name), ['API_TOKEN', 'DB_URL']);
  for (const bad of [{ name: 'PATH', value: 'x' }, { name: 'lower', value: 'x' }, { name: 'GIT_DIR', value: 'x' }, { name: 'CLAUDE_X', value: 'x' }, { name: 'OK_NAME', value: '' }, { name: 'OK_NAME', value: 'a\0b' }, { name: 'OK_NAME', value: 'x'.repeat(65537) }, { name: 'OK_NAME', value: 'x', note: 'two\nlines' }, { name: 'OK_NAME', value: 'x', other: 1 }]) {
    assert.strictEqual((await call('POST', `/api/specialist/${p.name}/accesses`, bad))[0], 400, JSON.stringify(bad).slice(0, 60));
  }
  const dir = path.join(p.dir, '.secrets'), file = path.join(dir, 'accesses.json');
  assert.deepStrictEqual([fs.statSync(dir).mode & 0o777, fs.statSync(file).mode & 0o777], [0o700, 0o600]);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).DB_URL.value, SECRET);
  await upload(p.name, 'a.txt', 'a');
  assert.ok(!gitIn(p.dir, 'ls-files').includes('.secrets'));
  assert.ok(!gitIn(p.dir, 'log', '-p', '--all').includes('s3cret'));
  const [, view] = await call('GET', `/api/specialist/${p.name}/train`);
  assert.deepStrictEqual(view.accesses.map(a => a.name), ['API_TOKEN', 'DB_URL']);
  fs.chmodSync(file, 0o644);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/accesses`))[0], 409);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/accesses`, { name: 'X_Y', value: 'v' }))[0], 409);
  fs.chmodSync(file, 0o600);
  fs.chmodSync(dir, 0o755);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/accesses`))[0], 409);
  fs.chmodSync(dir, 0o700);
  assert.deepStrictEqual(await call('POST', `/api/specialist/${p.name}/accesses/API_TOKEN/delete`), [200, { ok: true, name: 'API_TOKEN' }]);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/accesses/API_TOKEN/delete`))[0], 404);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/accesses/bad name/delete`))[0], 400);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/accesses/PATH/delete`))[0], 400);
  const q = fresh();
  const elsewhere = fs.mkdtempSync(path.join(tmp, 'sec-'));
  fs.symlinkSync(elsewhere, path.join(q.dir, '.secrets'));
  assert.strictEqual((await call('POST', `/api/specialist/${q.name}/accesses`, { name: 'DB_URL', value: SECRET }))[0], 409);
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
  const api2 = fresh({ provider: 'openai', model: 'gpt-5' });
  assert.strictEqual((await call('GET', `/api/specialist/${api2.name}/accesses`))[1].usedByRuns, false);
  assert.ok(responses.every(r => !r.includes('s3cret') && !r.includes('tok\\nline')));
});

test('runs of a claude specialist get accesses as env with names and notes in the system prompt, never in argv or the record', async () => {
  const p = fresh();
  accesses.set(p.dir, { name: 'DB_URL', value: SECRET, note: 'read replica' });
  const n0 = fakeArgs().length;
  const [, asked] = await call('POST', `/api/specialist/${p.name}/ask`, { text: 'show it' });
  const [, run] = await call('GET', `/api/specialist/run/${asked.runId}?wait=1&timeoutSec=10`);
  assert.strictEqual(run.state, 'done');
  const a = fakeArgs().slice(n0).find(x => x.cwd === p.dir);
  assert.strictEqual(a.env.DB_URL, SECRET);
  assert.strictEqual(a.argv[a.argv.indexOf('--append-system-prompt') + 1], 'Accesses, as environment variables: DB_URL (read replica); use them by name, never print them');
  assert.ok(!a.argv.join(' ').includes('s3cret'));
  assert.ok(!fs.readFileSync(path.join(p.dir, '.bd', 'runs', asked.runId + '.json'), 'utf8').includes('s3cret'));
  assert.ok(!JSON.stringify(claude.get(asked.tmux) || {}).includes('s3cret'));
  fs.chmodSync(path.join(p.dir, '.secrets', 'accesses.json'), 0o640);
  const [code, err] = await call('POST', `/api/specialist/${p.name}/ask`, { text: 'again' });
  assert.deepStrictEqual([code, /mode 640/.test(err.error)], [409, true]);
});

test('trainer: restricted launch in its own folder, Summary commits, files list, busy 409, no accesses, no shell', async () => {
  const p = fresh({ title: 'Mail writer' });
  accesses.set(p.dir, { name: 'DB_URL', value: SECRET, note: 'read replica' });
  const n0 = fakeArgs().length;
  const [s, sent] = await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'write style.md=Short and warm.\nSummary: Warmer style' });
  assert.strictEqual(s, 200);
  const tmux = `claude-spec-${p.name}_train`;
  assert.deepStrictEqual([sent.trainer.tmux, sent.trainer.account, sent.trainer.live, sent.trainer.turns], [tmux, 'personal', true, 1]);
  const T = path.join(path.dirname(p.dir), '.trainers', p.name);
  const a = await until(() => fakeArgs().slice(n0).find(x => x.cwd === T));
  for (const f of ['--restricted', '--strict-mcp-config']) assert.ok(a.argv.includes(f), f);
  assert.strictEqual(a.argv[a.argv.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
  assert.strictEqual(a.argv[a.argv.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.strictEqual(a.argv[a.argv.indexOf('--settings') + 1], path.join(T, 'settings.json'));
  assert.deepStrictEqual(a.argv.filter((x, i) => a.argv[i - 1] === '--add-dir'), [p.dir]);
  for (const f of ['--dangerously-skip-permissions', '--permission-prompt-tool', '--append-system-prompt']) assert.ok(!a.argv.includes(f), f);
  assert.strictEqual(a.env.DB_URL, null);
  const settings = JSON.parse(fs.readFileSync(path.join(T, 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.allow.includes(`Edit(/${p.dir}/style.md)`) && settings.permissions.allow.includes(`Write(/${p.dir}/knowledge/**)`));
  assert.ok(settings.permissions.deny.includes(`Read(/${p.dir}/.secrets/**)`) && settings.permissions.deny.includes(`Edit(/${p.dir}/specialist.json)`) && settings.permissions.deny.includes(`Write(/${p.dir}/.git/**)`));
  assert.ok(!settings.permissions.allow.some(r => /\.secrets|specialist\.json|\.bd/.test(r)));
  assert.strictEqual(settings.permissions.defaultMode, 'dontAsk');
  const context = fs.readFileSync(path.join(T, 'context.md'), 'utf8');
  assert.match(context, /Title: Mail writer/);
  assert.match(context, /- DB_URL: read replica/);
  assert.ok(!context.includes('s3cret'));
  assert.match(fs.readFileSync(path.join(T, 'CLAUDE.md'), 'utf8'), /Summary: <what changed, under 80 chars>/);
  const done = await trainerDone(p.name);
  assert.deepStrictEqual(done.history.commits.slice(0, 2).map(c => [c.source, c.message]), [['trainer', 'Warmer style'], ['start', 'Starting point']]);
  assert.deepStrictEqual(done.history.commits[0].files, [{ path: 'style.md', change: 'added' }]);
  assert.strictEqual(fs.readFileSync(path.join(p.dir, 'style.md'), 'utf8'), 'Short and warm.');
  const trainerJson = JSON.parse(fs.readFileSync(path.join(p.dir, '.bd', 'trainer.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(trainerJson), ['tmux', 'account', 'sessionId', 'transcriptPath', 'startedAt', 'turns', 'lastTurnAt']);
  const { specialist, runner } = claude.get(tmux);
  assert.deepStrictEqual([specialist, runner.trainer, runner.settings, runner.addDirs, runner.permissionMode], [p.name, true, path.join(T, 'settings.json'), [p.dir], null]);
  assert.deepStrictEqual((await headless.shell(tmux, 'cat ../.secrets/accesses.json')).error, 'the trainer has no shell');
  const nIn = inputs().length;
  const [, up] = await upload(p.name, 'guide.pdf', '%PDF-1.4');
  assert.strictEqual(inputs().length, nIn);
  for (const files of [['../x'], ['knowledge/files/../../specialist.json'], ['knowledge/files/none.pdf'], ['style.md'], 'knowledge/files/guide.pdf']) {
    assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'x', files }))[0], 400, JSON.stringify(files));
  }
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/send`, { text: '   ' }))[0], 400);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'x'.repeat(100001) }))[0], 400);
  await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'read it', files: [up.file.path] });
  await until(() => inputs().includes('read it\n\nFiles the owner added:\n- knowledge/files/guide.pdf'));
  await trainerDone(p.name);
  await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'slow' });
  assert.deepStrictEqual(await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'more' }), [409, { ok: false, error: 'trainer is busy' }]);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: done.history.commits[0].id }))[0], 409);
  assert.deepStrictEqual((await training.chatSend(tmux, 'from the chat')).error, 'trainer is busy');
  assert.match((await training.chatSend(`${tmux}-company`, 'x')).error, /not the specialist's current trainer/);
  const [, list] = await call('GET', '/api/specialists');
  assert.ok(!('trainer' in list.specialists.find(x => x.name === p.name)));
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/archive`))[0], 409);
  await trainerDone(p.name);
  const [, detail] = await call('GET', `/api/specialist/${p.name}`);
  assert.ok(!('trainer' in detail.specialist));
  assert.strictEqual(fakeArgs().filter(x => x.cwd === T).length, 1);
});

test('trainer guard: files outside the trainable paths and the trainer folder are put back after the turn', async () => {
  const p = fresh();
  const T = path.join(path.dirname(p.dir), '.trainers', p.name);
  await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'hello' });
  await trainerDone(p.name);
  const meta = JSON.parse(fs.readFileSync(path.join(p.dir, 'specialist.json'), 'utf8'));
  const settings = fs.readFileSync(path.join(T, 'settings.json'), 'utf8');
  const heads = (await call('GET', `/api/specialist/${p.name}/train/history`))[1].commits.length;
  await call('POST', `/api/specialist/${p.name}/train/send`, { text: `write specialist.json={"evil":true}\nwrite .claude/settings.json={"hooks":{}}\nwrite .git/hooks/post-commit=#!/bin/sh\nwrite ../.trainers/${p.name}/settings.json={}\nwrite knowledge/ok.md=fine` });
  await trainerDone(p.name);
  const after = JSON.parse(fs.readFileSync(path.join(p.dir, 'specialist.json'), 'utf8'));
  assert.deepStrictEqual([after.name, after.title, after.evil], [meta.name, meta.title, undefined]);
  assert.ok(!fs.existsSync(path.join(p.dir, '.claude', 'settings.json')));
  assert.ok(!fs.existsSync(path.join(p.dir, '.git', 'hooks', 'post-commit')));
  assert.strictEqual(fs.readFileSync(path.join(T, 'settings.json'), 'utf8'), settings);
  const [, hist] = await call('GET', `/api/specialist/${p.name}/train/history`);
  assert.strictEqual(hist.commits.length, heads + 1);
  assert.deepStrictEqual(hist.commits[0].files, [{ path: 'knowledge/ok.md', change: 'added' }]);
  assert.strictEqual(hist.commits[0].message, 'Training: knowledge/ok.md');
});

test('trainer: an oversized CLAUDE.md gets one follow-up before the commit', async () => {
  const p = fresh();
  await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'fill CLAUDE.md 300000' });
  await until(() => inputs().includes('CLAUDE.md is 293 KiB, the limit is 256 KiB: move details into knowledge/'));
  const done = await until(async () => { const o = await trainerDone(p.name); return o.history.commits[0].source === 'trainer' ? o : null; });
  assert.deepStrictEqual(done.history.commits[0].files, [{ path: 'CLAUDE.md', change: 'modified' }]);
  assert.strictEqual(inputs().filter(t => /^CLAUDE\.md is \d+ KiB/.test(t)).length, 1);
});

test('feedback: sent one per turn, applied with the commit, failed turns can be retried; validation and the 50 pending cap', async () => {
  const p = fresh({ title: 'Replies' });
  const q = fresh();
  const [, asked] = await call('POST', `/api/specialist/${p.name}/ask`, { text: 'draft a greeting' });
  await call('GET', `/api/specialist/run/${asked.runId}?wait=1&timeoutSec=10`);
  for (const bad of [{ note: '' }, { better: '   ' }, { runId: 'nope', note: 'x' }, { note: 'x', extra: 1 }, { note: 5 }]) assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/feedback`, bad))[0], 400, JSON.stringify(bad));
  assert.strictEqual((await call('POST', `/api/specialist/${q.name}/train/feedback`, { runId: asked.runId, note: 'x' }))[0], 400);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/feedback`, { runId: `claude-spec-${p.name}-200101-0000`, note: 'x' }))[0], 404);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/feedback`, { note: 'x'.repeat(10001) }))[0], 413);
  assert.ok(!fs.existsSync(path.join(p.dir, '.bd', 'feedback.jsonl')));
  const [c, made] = await call('POST', `/api/specialist/${p.name}/train/feedback`, { runId: asked.runId, better: 'write examples/greeting.md=Hello there', note: 'Open with Hello' });
  assert.strictEqual(c, 201);
  assert.match(made.feedback.id, /^fb-[0-9a-z]+-[0-9a-f]{4}$/);
  assert.deepStrictEqual([made.feedback.state, made.feedback.original, made.feedback.runId], ['sent', 'Echo: draft a greeting', asked.runId]);
  assert.strictEqual(made.trainer.live, true);
  const [, second] = await call('POST', `/api/specialist/${p.name}/train/feedback`, { better: 'fail turn' });
  assert.strictEqual(second.feedback.state, 'pending');
  const applied = await until(async () => { const [, o] = await call('GET', `/api/specialist/${p.name}/train/feedback?ids=${made.feedback.id}`); return o.feedback[0].state === 'applied' ? o.feedback[0] : null; });
  const [, hist] = await call('GET', `/api/specialist/${p.name}/train/history`);
  assert.strictEqual(applied.commit, hist.commits.find(x => x.message === 'Training: examples/greeting.md').id);
  assert.ok(applied.appliedAt >= applied.sentAt && applied.sentAt >= applied.createdAt);
  assert.ok(inputs().includes(`Feedback on an answer from Replies (run ${asked.runId}):\n\nThe answer it gave:\n> Echo: draft a greeting\n\nA better version:\n> write examples/greeting.md=Hello there\n\nNote from the owner: Open with Hello\n\nChange the profile so future answers come out like the better version. Change only what this feedback is about.`));
  const failed = await until(async () => { const [, o] = await call('GET', `/api/specialist/${p.name}/train/feedback?ids=${second.feedback.id}`); return o.feedback[0].state === 'failed' ? o.feedback[0] : null; });
  assert.match(failed.error, /model_error/);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/feedback/${made.feedback.id}/retry`))[0], 409);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/feedback/fb-zz-0000/retry`))[0], 404);
  const [r, retried] = await call('POST', `/api/specialist/${p.name}/train/feedback/${second.feedback.id}/retry`);
  assert.deepStrictEqual([r, retried.feedback.state, retried.feedback.error], [200, 'sent', null]);
  await until(async () => (await call('GET', `/api/specialist/${p.name}/train/feedback?ids=${second.feedback.id}`))[1].feedback[0].state === 'failed');
  const [, all] = await call('GET', `/api/specialist/${p.name}/train/feedback?limit=1`);
  assert.deepStrictEqual(all.feedback.map(f => f.id), [second.feedback.id]);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/feedback?limit=501`))[0], 400);
  const pending = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: `fb-a${i}-0000`, runId: null, original: null, better: null, note: 'x', state: 'pending', createdAt: 1, sentAt: null, appliedAt: null, commit: null, error: null })).join('\n') + '\n';
  fs.mkdirSync(path.join(q.dir, '.bd', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(q.dir, '.bd', 'feedback.jsonl'), pending);
  assert.strictEqual((await call('POST', `/api/specialist/${q.name}/train/feedback`, { note: 'one more' }))[0], 429);
});

test('trainer: relaunch resumes the stored conversation, fresh starts a new one, boot fails feedback left sent and commits outside changes', async () => {
  const p = fresh();
  const tmux = `claude-spec-${p.name}_train`, T = path.join(path.dirname(p.dir), '.trainers', p.name);
  await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'one' });
  const first = await trainerDone(p.name);
  fs.mkdirSync(path.dirname(headless.transcriptOf(T, 'personal', first.trainer.sessionId)), { recursive: true });
  fs.writeFileSync(headless.transcriptOf(T, 'personal', first.trainer.sessionId), '');
  process.kill(pidOf(tmux), 'SIGKILL');
  await until(() => !alive(tmux));
  const n0 = fakeArgs().length;
  await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'two' });
  const second = await trainerDone(p.name);
  const a = fakeArgs().slice(n0).find(x => x.cwd === T);
  assert.strictEqual(a.argv[a.argv.indexOf('--resume') + 1], first.trainer.sessionId);
  assert.deepStrictEqual([second.trainer.sessionId, second.trainer.startedAt, second.trainer.turns], [first.trainer.sessionId, first.trainer.startedAt, 2]);
  await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'three', fresh: true });
  const third = await trainerDone(p.name);
  assert.notStrictEqual(third.trainer.sessionId, first.trainer.sessionId);
  assert.strictEqual(third.trainer.turns, 1);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'x', fresh: 'yes' }))[0], 400);
  process.kill(pidOf(tmux), 'SIGKILL');
  await until(() => !alive(tmux));
  const fb = { id: 'fb-b1-0000', runId: null, original: null, better: null, note: 'left', state: 'sent', createdAt: 1, sentAt: 2, appliedAt: null, commit: null, error: null };
  fs.writeFileSync(path.join(p.dir, '.bd', 'feedback.jsonl'), JSON.stringify(fb) + '\n');
  fs.writeFileSync(path.join(p.dir, 'style.md'), 'edited while down\n');
  await createTraining({ store, headless, tmuxHas, claudeGet: claude.get, goneMs: 50 }).boot();
  const [, view] = await call('GET', `/api/specialist/${p.name}/train`);
  assert.deepStrictEqual([view.feedback[0].state, view.feedback[0].error], ['failed', 'the trainer went away']);
  assert.deepStrictEqual([view.history.commits[0].source, view.history.commits[0].files], ['outside', [{ path: 'style.md', change: 'added' }]]);
  assert.deepStrictEqual([view.trainer.live, view.trainer.state], [false, null]);
});

test('trainer: a trainable file that imports from .secrets, .bd or .git is put back and never committed; uploads and instructions with one are refused', async () => {
  const p = fresh();
  accesses.set(p.dir, { name: 'DB_URL', value: SECRET });
  await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'hello' });
  await trainerDone(p.name);
  const instructions = fs.readFileSync(path.join(p.dir, 'CLAUDE.md'), 'utf8');
  const [, made] = await call('POST', `/api/specialist/${p.name}/train/feedback`, { better: 'write CLAUDE.md=Read @.secrets/accesses.json\nwrite knowledge/leak.md=see @../.git/config\nwrite knowledge/ok.md=fine' });
  const failed = await until(async () => { const [, o] = await call('GET', `/api/specialist/${p.name}/train/feedback?ids=${made.feedback.id}`); return o.feedback[0].state === 'failed' ? o.feedback[0] : null; });
  assert.match(failed.error, /imported from \.secrets, \.bd or \.git, and those files were put back: CLAUDE\.md, knowledge\/leak\.md/);
  assert.strictEqual(fs.readFileSync(path.join(p.dir, 'CLAUDE.md'), 'utf8'), instructions);
  assert.ok(!fs.existsSync(path.join(p.dir, 'knowledge', 'leak.md')));
  const [, hist] = await call('GET', `/api/specialist/${p.name}/train/history`);
  assert.deepStrictEqual([hist.commits[0].id, hist.commits[0].files], [failed.commit, [{ path: 'knowledge/ok.md', change: 'added' }]]);
  const [bad] = await upload(p.name, 'notes.md', 'Remember @../../.secrets/accesses.json');
  assert.strictEqual(bad, 400);
  assert.deepStrictEqual(fs.readdirSync(path.join(p.dir, 'knowledge', 'files')), []);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}`, { instructions: '# X\n\n@.secrets/accesses.json\n' }))[0], 400);
  assert.strictEqual((await call('POST', '/api/specialist', { name: `t${++counter.n}`, instructions: 'see @./.bd/runs' }))[0], 400);
  fs.writeFileSync(path.join(p.dir, 'knowledge', 'hand.md'), 'see @.bd/runs');
  fs.writeFileSync(path.join(p.dir, 'knowledge', 'fine.md'), 'ok');
  assert.strictEqual((await upload(p.name, 'a.txt', 'plain'))[0], 201);
  const tracked = gitIn(p.dir, 'ls-files').split('\n');
  assert.ok(tracked.includes('knowledge/fine.md') && tracked.includes('knowledge/files/a.txt') && !tracked.includes('knowledge/hand.md'));
  const log = gitIn(p.dir, 'log', '-p', '--all');
  for (const s of ['@.secrets', '@../.git', '@.bd', 's3cret']) assert.ok(!log.includes(s), s);
});

test('trainer: a turn cut by a restart is finished, its feedback fails with "the turn was restarted", and the trainer takes the next message', async () => {
  const p = fresh();
  const tmux = `claude-spec-${p.name}_train`;
  const [, made] = await call('POST', `/api/specialist/${p.name}/train/feedback`, { better: 'write knowledge/part.md=half\nhang turn' });
  await until(() => fs.existsSync(path.join(p.dir, 'knowledge', 'part.md')));
  await headless.restart(tmux);
  const failed = await until(async () => { const [, o] = await call('GET', `/api/specialist/${p.name}/train/feedback?ids=${made.feedback.id}`); return o.feedback[0].state === 'failed' ? o.feedback[0] : null; });
  assert.strictEqual(failed.error, 'the turn was restarted');
  const [, hist] = await call('GET', `/api/specialist/${p.name}/train/history`);
  assert.deepStrictEqual([hist.commits[0].id, hist.commits[0].source, hist.commits[0].files], [failed.commit, 'trainer', [{ path: 'knowledge/part.md', change: 'added' }]]);
  await trainerDone(p.name);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'after the restart' }))[0], 200);
  await until(() => inputs().includes('after the restart'));
  await trainerDone(p.name);
});

test('trainer busy: send, upload and instructions never sweep a running turn\'s edits into another commit; a failing end of turn still frees the trainer', async () => {
  const p = fresh();
  const tmux = `claude-spec-${p.name}_train`, T = path.join(path.dirname(p.dir), '.trainers', p.name);
  await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'hang' });
  await until(async () => (await call('GET', `/api/specialist/${p.name}/train`))[1].trainer.state === 'working');
  fs.mkdirSync(path.join(p.dir, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, 'knowledge', 'partial.md'), 'half done');
  const count = async () => (await call('GET', `/api/specialist/${p.name}/train/history`))[1].commits.length;
  const n0 = await count();
  assert.deepStrictEqual(await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'more' }), [409, { ok: false, error: 'trainer is busy' }]);
  assert.deepStrictEqual(await call('POST', `/api/specialist/${p.name}`, { instructions: '# New\n' }), [409, { ok: false, error: 'trainer is busy' }]);
  assert.strictEqual(await count(), n0);
  const [s, up] = await upload(p.name, 'u.txt', 'uploaded');
  assert.deepStrictEqual([s, up.commit.source, up.commit.files], [201, 'upload', [{ path: 'knowledge/files/u.txt', change: 'added' }]]);
  assert.strictEqual(await count(), n0 + 1);
  assert.ok(!gitIn(p.dir, 'ls-files').split('\n').includes('knowledge/partial.md'));
  fs.rmSync(path.join(T, 'CLAUDE.md'));
  fs.mkdirSync(path.join(T, 'CLAUDE.md', 'locked'), { recursive: true });
  fs.writeFileSync(path.join(T, 'CLAUDE.md', 'locked', 'x'), 'x');
  fs.chmodSync(path.join(T, 'CLAUDE.md', 'locked'), 0o500);
  try {
    await headless.interrupt(tmux);
    const done = await until(async () => { const o = await trainerDone(p.name); return o.history.commits[0].source === 'trainer' ? o : null; });
    assert.deepStrictEqual(done.history.commits[0].files, [{ path: 'knowledge/partial.md', change: 'added' }]);
    assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/send`, { text: 'free again' }))[0], 200);
    await until(() => inputs().includes('free again'));
    await trainerDone(p.name);
  } finally { fs.chmodSync(path.join(T, 'CLAUDE.md', 'locked'), 0o700); }
});

test('feedback file: rewrites keep every open record and the newest 500 finished ones', async () => {
  const p = fresh();
  const rec = (i, state) => ({ id: `fb-p${i.toString(36)}-0000`, runId: null, original: null, better: null, note: 'x', state, createdAt: i + 1, sentAt: state === 'pending' ? null : i + 1, appliedAt: state === 'applied' ? i + 1 : null, commit: null, error: state === 'failed' ? 'e' : null });
  const old = { ...rec(0, 'pending'), id: 'fb-old-0000', createdAt: 0 };
  fs.mkdirSync(path.join(p.dir, '.bd', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, '.bd', 'feedback.jsonl'), [old, ...Array.from({ length: 600 }, (_, i) => rec(i, i % 2 ? 'applied' : 'failed'))].map(f => JSON.stringify(f) + '\n').join(''));
  const [c, made] = await call('POST', `/api/specialist/${p.name}/train/feedback`, { note: 'newest' });
  assert.strictEqual(c, 201);
  const ids = () => lines(path.join(p.dir, '.bd', 'feedback.jsonl'));
  assert.deepStrictEqual([ids().length, ids()[0].id, ids()[1].id, ids()[ids().length - 1].id], [502, 'fb-old-0000', 'fb-p2s-0000', made.feedback.id]);
  await until(() => ids().filter(f => f.state === 'applied' && [old.id, made.feedback.id].includes(f.id)).length === 2, 15000);
  const all = ids();
  assert.strictEqual(all.length, 500);
  assert.ok(all.some(f => f.id === old.id) && all.some(f => f.id === made.feedback.id) && !all.some(f => f.id === 'fb-p2t-0000'));
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train`))[0], 200);
});

test('git: a stale index.lock left by a killed git is cleared, a fresh one is not', async () => {
  const p = fresh();
  assert.strictEqual((await upload(p.name, 'one.txt', '1'))[0], 201);
  const lock = path.join(p.dir, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  assert.strictEqual((await upload(p.name, 'two.txt', '2'))[0], 500);
  const old = (Date.now() - 60000) / 1000;
  fs.utimesSync(lock, old, old);
  assert.strictEqual((await upload(p.name, 'three.txt', '3'))[0], 201);
  assert.ok(!fs.existsSync(lock));
});

test('trainer guard: the snapshot taken at turn start survives a dashboard restart mid-turn', async () => {
  const p = fresh();
  const tmux = `claude-spec-${p.name}_train`;
  const blind = createTraining({ store, headless: { ...headless, subscribe: () => () => {} }, tmuxHas, claudeGet: claude.get, goneMs: 50 });
  await blind.send(p.name, { text: 'hang' });
  const meta = fs.readFileSync(path.join(p.dir, 'specialist.json'), 'utf8');
  assert.ok(fs.existsSync(path.join(p.dir, '.bd', 'trainer-guard.json')));
  await until(async () => (await headless.status(tmux)).state === 'working');
  fs.writeFileSync(path.join(p.dir, 'specialist.json'), JSON.stringify({ ...JSON.parse(meta), title: 'Evil' }));
  fs.mkdirSync(path.join(p.dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, '.claude', 'settings.json'), '{"hooks":{}}');
  await createTraining({ store, headless, tmuxHas, claudeGet: claude.get, goneMs: 50 }).boot();
  await headless.interrupt(tmux);
  await until(() => !fs.existsSync(path.join(p.dir, '.bd', 'trainer-guard.json')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(p.dir, 'specialist.json'), 'utf8')).title, JSON.parse(meta).title);
  assert.ok(!fs.existsSync(path.join(p.dir, '.claude', 'settings.json')));
});

test('trainer: a message that does not reach the trainer is 500, and the trainer is not left busy', async () => {
  const p = fresh();
  const deaf = createTraining({ store, headless: { ...headless, send: async () => ({ ok: false, error: 'runner not reachable' }) }, tmuxHas, claudeGet: claude.get, goneMs: 50 });
  await assert.rejects(deaf.send(p.name, { text: 'hello' }), e => e.status === 500 && /did not reach the trainer/.test(e.message));
  assert.ok(!fs.existsSync(path.join(p.dir, '.bd', 'trainer-guard.json')));
  await assert.rejects(deaf.send(p.name, { text: 'hello' }), e => e.status === 500);
});

test('own chat: a new bot is a repository with the preamble; teaching turns commit as chat, protected files are put back, the preamble cannot be undone and undo waits for the turn', async () => {
  const name = `t${++counter.n}`;
  const [c, made] = await call('POST', '/api/specialist', { name, title: 'Teacher' });
  assert.strictEqual(c, 201);
  const dir = made.specialist.dir;
  const commits = async () => (await call('GET', `/api/specialist/${name}/train/history`))[1].commits;
  assert.deepStrictEqual((await commits()).map(x => [x.source, x.message]), [['start', 'Starting point']]);
  assert.ok(gitIn(dir, 'show', 'HEAD:CLAUDE.md').startsWith('<!-- beast-dash bot preamble v1: written by the dashboard, do not edit -->\n'));
  assert.deepStrictEqual(gitIn(dir, 'ls-files').trim().split('\n'), ['CLAUDE.md']);
  const [o, opened] = await call('POST', `/api/specialist/${name}/chat`, {});
  const tmux = `claude-spec-${name}`;
  assert.deepStrictEqual([o, opened.ok, opened.started, opened.thread.tmux, opened.thread.live], [200, true, true, tmux, true]);
  assert.strictEqual(claude.get(tmux).specialist, name);
  assert.strictEqual((await commits()).length, 1);
  const settled = () => until(async () => !(await training.busy(name)));
  assert.ok((await training.chatTurn(tmux, 'write knowledge/alpha.md=Alpha\nSummary: Learned alpha')).ok);
  await until(async () => (await commits())[0].source === 'chat');
  await settled();
  let hist = await commits();
  assert.deepStrictEqual([hist[0].message, hist[0].files], ['Learned alpha', [{ path: 'knowledge/alpha.md', change: 'added' }]]);
  const meta = () => { const { updatedAt, ...m } = JSON.parse(fs.readFileSync(path.join(dir, 'specialist.json'), 'utf8')); return m; };
  const before = meta();
  const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.ok((await training.chatTurn(tmux, 'write specialist.json={"evil":true}\nwrite .gitignore=*\nwrite CLAUDE.md=# Only mine\nwrite knowledge/beta.md=Beta')).ok);
  await until(async () => (await commits()).length === hist.length + 1);
  await settled();
  hist = await commits();
  assert.deepStrictEqual(meta(), before);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), ignore);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), store.placePreamble('# Only mine'));
  assert.deepStrictEqual([hist[0].source, hist[0].message, hist[0].files.map(f => f.path)], ['chat', 'Learned: CLAUDE.md, knowledge/beta.md', ['CLAUDE.md', 'knowledge/beta.md']]);
  assert.ok((await training.chatTurn(tmux, 'hello')).ok);
  await settled();
  assert.strictEqual((await commits()).length, hist.length);
  assert.ok((await training.chatTurn(tmux, 'slow')).ok);
  assert.deepStrictEqual(await call('POST', `/api/specialist/${name}/train/undo`, { commit: hist[0].id }), [409, { ok: false, error: 'the bot is busy' }]);
  assert.deepStrictEqual(await call('POST', `/api/specialist/${name}/chat`, { fresh: true }), [409, { ok: false, error: 'the bot is busy' }]);
  await settled();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Edited by hand\n');
  const asked = await runs.ask(name, { text: 'a call', wait: true, timeoutSec: 10 });
  assert.deepStrictEqual([asked.state, asked.mode], ['done', 'run']);
  hist = await commits();
  assert.deepStrictEqual(hist.slice(0, 2).map(x => [x.source, x.message]), [['preamble', 'Updated the bot preamble'], ['outside', 'Changes made outside training']]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), store.placePreamble('# Edited by hand\n'));
  assert.deepStrictEqual(await call('POST', `/api/specialist/${name}/train/undo`, { commit: hist[0].id }), [400, { ok: false, error: 'the preamble is managed by the dashboard' }]);
  const [u] = await call('POST', `/api/specialist/${name}/train/undo`, { commit: hist.find(x => x.message === 'Learned alpha').id });
  assert.strictEqual(u, 201);
  assert.ok(!fs.existsSync(path.join(dir, 'knowledge', 'alpha.md')));
  const plain = fresh();
  assert.ok(!fs.existsSync(path.join(plain.dir, '.git')));
  await training.boot();
  assert.deepStrictEqual((await call('GET', `/api/specialist/${plain.name}/train/history`))[1].commits.map(x => x.source), ['start']);
});
