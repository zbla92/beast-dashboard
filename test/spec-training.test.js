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
const { createTraining, summaryLine } = require('../lib/training');
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
test.after(() => {
  for (const f of fs.readdirSync(procs).filter(f => f.endsWith('.pid'))) { try { process.kill(+fs.readFileSync(path.join(procs, f), 'utf8'), 'SIGKILL'); } catch {} }
  srv.close();
  process.env.PATH = PATH0;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const counter = { n: 0 };
const fresh = (fields = {}) => store.create({ name: `t${++counter.n}`, ...fields });
const repoOf = async (fields = {}) => { const p = fresh(fields); await training.created(p.name); return p; };
const historyOf = async name => (await call('GET', `/api/specialist/${name}/train/history`))[1].commits;
const saveFile = async (p, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(p.dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(p.dir, rel), text);
  await training.beforeLaunch(p.name);
  return (await historyOf(p.name)).find(c => c.source === 'outside');
};

test('summary line: the last Summary line of a reply names the commit', () => {
  assert.strictEqual(summaryLine('Changed the tone.\n\n**Summary:** Warmer greetings\n'), 'Warmer greetings');
  assert.strictEqual(summaryLine('Summary: first\nmore\nSummary: second'), 'second');
  assert.strictEqual(summaryLine('No summary here'), null);
});

test('runner flags: accesses and settings go to every run, and a stored trainer flag is dropped', () => {
  assert.deepStrictEqual(headless.runnerArgs({ permissionMode: 'plan', addDirs: [], accesses: '/p', settings: '/s.json' }), ['--permission-mode', 'plan', '--accesses', '/p', '--settings', '/s.json']);
  claude.markChat('claude-spec-zz', { cwd: tmp, account: 'personal', sessionId: '11111111-2222-4333-8444-555555555555', specialist: 'zz', runner: { trainer: true, settings: '/s.json', addDirs: ['/p'] } });
  assert.ok(!('trainer' in claude.get('claude-spec-zz').runner));
  assert.deepStrictEqual(headless.runnerArgs(claude.get('claude-spec-zz').runner), ['--add-dir', '/p', '--settings', '/s.json']);
});

test('runner: a relative --settings or --accesses is refused', async () => {
  const run = extra => new Promise(r => spawn(process.execPath, [RUNNER, '--sock', path.join(tmp, 'x.sock'), '--cwd', tmp, '--session-id', '11111111-2222-4333-8444-555555555555', '--start', 'new', ...extra], { stdio: 'ignore' }).on('exit', r));
  assert.strictEqual(await run(['--settings', 'rel.json']), 2);
  assert.strictEqual(await run(['--accesses', 'rel']), 2);
});

test('history: a new bot is a repository with a starting point; outside changes, diff, pagination', async () => {
  const p = await repoOf();
  assert.deepStrictEqual((await historyOf(p.name)).map(c => c.source), ['start']);
  assert.strictEqual(fs.readFileSync(path.join(p.dir, '.gitignore'), 'utf8'), '/*\n!/CLAUDE.md\n!/style.md\n!/knowledge/\n!/examples/\n/.secrets/\n/.bd/\n/.trainers/\n');
  assert.strictEqual(gitIn(p.dir, 'branch', '--show-current').trim(), 'main');
  assert.strictEqual(gitIn(p.dir, 'log', '-1', '--format=%an <%ae>').trim(), 'beast-dash <beast-dash@localhost>');
  for (const route of ['train', 'train/send', 'train/upload', 'train/feedback', 'train/feedback/fb-a-0000/retry']) {
    for (const m of ['GET', 'POST']) assert.strictEqual((await call(m, `/api/specialist/${p.name}/${route}`, m === 'POST' ? {} : undefined))[0], 404, `${m} ${route}`);
  }
  const before = store.get(p.name).updatedAt;
  const a = await saveFile(p, 'knowledge/a.md', 'one\n');
  assert.deepStrictEqual([a.message, a.source, a.undoOf, a.undone, a.files], ['Changes made outside training', 'outside', null, false, [{ path: 'knowledge/a.md', change: 'added' }]]);
  assert.match(a.id, /^[0-9a-f]{40}$/);
  assert.strictEqual(a.short, a.id.slice(0, 7));
  assert.notStrictEqual(store.get(p.name).updatedAt, before);
  fs.writeFileSync(path.join(p.dir, '.bd-note'), 'not tracked');
  await saveFile(p, 'knowledge/b.md', 'two\n');
  const style = await saveFile(p, 'style.md', 'Warm and short.\n');
  const hist = await historyOf(p.name);
  assert.strictEqual(hist[0].id, style.id);
  assert.strictEqual(hist[hist.length - 1].source, 'start');
  assert.ok(!gitIn(p.dir, 'ls-files').includes('.bd-note'));
  const [, page] = await call('GET', `/api/specialist/${p.name}/train/history?limit=2&before=${hist[1].short}`);
  assert.deepStrictEqual([page.commits.map(c => c.id), page.more], [hist.slice(2, 4).map(c => c.id), hist.length > 4]);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/history?before=${'0'.repeat(40)}`))[0], 404);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/history?before=zz`))[0], 400);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/history?limit=201`))[0], 400);
  const [d, detail] = await call('GET', `/api/specialist/${p.name}/train/commit/${style.short}`);
  assert.strictEqual(d, 200);
  assert.strictEqual(detail.commit.id, style.id);
  assert.match(detail.diff, /^diff --git a\/style\.md b\/style\.md/);
  assert.match(detail.diff, /\+Warm and short\./);
  assert.strictEqual(detail.truncated, false);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/commit/deadbeef`))[0], 404);
  assert.strictEqual((await call('GET', `/api/specialist/${p.name}/train/commit/xyz`))[0], 400);
  assert.strictEqual((await call('GET', '/api/specialist/nobody/train/history'))[0], 404);
});

test('a symlinked trainable folder is refused by history and undo', async () => {
  const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
  const r = fresh();
  fs.symlinkSync(outside, path.join(r.dir, 'examples'));
  for (const [m, route, body] of [['GET', 'train/history'], ['POST', 'train/undo', { commit: 'abcdef1' }]]) {
    const [c, o] = await call(m, `/api/specialist/${r.name}/${route}`, body);
    assert.deepStrictEqual([route, c, o.error], [route, 409, 'examples must be a real folder, not a symlink']);
  }
  assert.ok(!fs.existsSync(path.join(r.dir, '.git')));
});

test('undo: reverts one commit, undo of an undo, conflicts leave the files as they were, the starting point is 400', async () => {
  const p = await repoOf();
  const up = await saveFile(p, 'knowledge/a.txt', 'one');
  const [s, undone] = await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: up.short });
  assert.strictEqual(s, 201);
  assert.deepStrictEqual([undone.commit.source, undone.commit.message, undone.commit.undoOf, undone.commit.files], ['undo', 'Undo: Changes made outside training', up.id, [{ path: 'knowledge/a.txt', change: 'deleted' }]]);
  assert.ok(!fs.existsSync(path.join(p.dir, 'knowledge', 'a.txt')));
  const h1 = await historyOf(p.name);
  assert.strictEqual(h1.find(c => c.id === up.id).undone, true);
  const [, redo] = await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: undone.commit.id });
  assert.strictEqual(redo.commit.message, 'Undo: Undo: Changes made outside training');
  assert.strictEqual(fs.readFileSync(path.join(p.dir, 'knowledge', 'a.txt'), 'utf8'), 'one');
  const h2 = await historyOf(p.name);
  assert.deepStrictEqual(h2.slice(0, 3).map(c => c.undone), [false, true, false]);
  const start = h2[h2.length - 1];
  assert.deepStrictEqual(await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: start.id }), [400, { ok: false, error: "the starting point can't be undone" }]);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: 'nothex' }))[0], 400);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: 'abcdef1', extra: 1 }))[0], 400);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: '0000000' }))[0], 404);
  const claudeMd = path.join(p.dir, 'CLAUDE.md');
  fs.writeFileSync(claudeMd, 'line one\nline two\n');
  const first = await saveFile(p, 'knowledge/b.txt', 'b');
  fs.writeFileSync(claudeMd, 'line one\nline two changed\n');
  await saveFile(p, 'knowledge/c.txt', 'c');
  const h3 = await historyOf(p.name);
  const [c, conflict] = await call('POST', `/api/specialist/${p.name}/train/undo`, { commit: first.id });
  assert.deepStrictEqual([c, conflict.error], [409, 'later changes touch the same lines; undo those first']);
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf8'), store.placePreamble('line one\nline two changed\n'));
  assert.strictEqual(gitIn(p.dir, 'status', '--porcelain').trim(), '');
  assert.strictEqual((await historyOf(p.name)).length, h3.length);
});

test('profile tab: an instructions update is its own commit once history exists; ifUpdatedAt still guards', async () => {
  const p = fresh();
  const [, plain] = await call('POST', `/api/specialist/${p.name}`, { instructions: 'v0\n' });
  assert.ok(!fs.existsSync(path.join(p.dir, '.git')));
  await training.created(p.name);
  fs.writeFileSync(path.join(p.dir, 'style.md'), 'by hand\n');
  const [u, upd] = await call('POST', `/api/specialist/${p.name}`, { instructions: 'v1\n', ifUpdatedAt: store.get(p.name).updatedAt });
  assert.strictEqual(u, 200);
  assert.strictEqual(upd.specialist.updatedAt, store.get(p.name).updatedAt);
  const hist = await historyOf(p.name);
  assert.deepStrictEqual(hist.slice(0, 2).map(c => [c.source, c.message, c.files.map(f => f.path).join()]), [['profile', 'Edited instructions', 'CLAUDE.md'], ['outside', 'Changes made outside training', 'style.md']]);
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}`, { instructions: 'v2\n', ifUpdatedAt: plain.specialist.updatedAt }))[0], 409);
  const [, same] = await call('POST', `/api/specialist/${p.name}`, { title: 'Renamed' });
  assert.strictEqual(same.specialist.title, 'Renamed');
  assert.strictEqual((await historyOf(p.name)).length, hist.length);
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
  await training.created(p.name);
  await saveFile(p, 'knowledge/a.md', 'a');
  assert.ok(!gitIn(p.dir, 'ls-files').includes('.secrets'));
  assert.ok(!gitIn(p.dir, 'log', '-p', '--all').includes('s3cret'));
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

test('git: a stale index.lock left by a killed git is cleared, a fresh one is not', async () => {
  const p = await repoOf();
  const lock = path.join(p.dir, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  fs.writeFileSync(path.join(p.dir, 'style.md'), 'one\n');
  await assert.rejects(training.beforeLaunch(p.name), e => e.status === 500);
  const old = (Date.now() - 60000) / 1000;
  fs.utimesSync(lock, old, old);
  await training.beforeLaunch(p.name);
  assert.ok(!fs.existsSync(lock));
  assert.strictEqual((await historyOf(p.name)).find(c => c.source === 'outside').files[0].path, 'style.md');
});

test('guard: the snapshot taken at turn start survives a dashboard restart mid-turn', async () => {
  const p = await repoOf();
  const tmux = store.threadName(p.name, 'personal');
  store.setThread(p.name, { account: 'personal', seq: 0 });
  const subs = [];
  const live = { state: 'idle' };
  const fake = {
    subscribe: (t, fn) => { if (t === tmux) subs.push(fn); return () => {}; },
    live: () => null,
    status: async () => live,
    send: async () => ({ ok: true }),
    waitForRunner: async () => ({ up: true }),
  };
  const first = createTraining({ store, headless: fake, tmuxHas: async () => true, goneMs: 50 });
  assert.ok((await first.chatTurn(tmux, 'hang')).ok);
  const guardFile = path.join(p.dir, '.bd', 'trainer-guard.json');
  assert.ok(fs.existsSync(guardFile));
  const meta = fs.readFileSync(path.join(p.dir, 'specialist.json'), 'utf8');
  fs.writeFileSync(path.join(p.dir, 'specialist.json'), JSON.stringify({ ...JSON.parse(meta), title: 'Evil' }));
  fs.mkdirSync(path.join(p.dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, '.claude', 'settings.json'), '{"hooks":{}}');
  subs.length = 0;
  live.state = 'working';
  const second = createTraining({ store, headless: fake, tmuxHas: async () => true, goneMs: 50 });
  await second.boot();
  assert.strictEqual(await second.busy(p.name), 'the bot is busy');
  live.state = 'idle';
  subs.forEach(fn => fn({ ev: 'result', subtype: 'success', text: 'done' }));
  await until(() => !fs.existsSync(guardFile));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(p.dir, 'specialist.json'), 'utf8')).title, JSON.parse(meta).title);
  assert.ok(!fs.existsSync(path.join(p.dir, '.claude', 'settings.json')));
});

test('imports: a trainable file that imports from .secrets, .bd or .git is put back and never committed; instructions with one are refused', async () => {
  const p = await repoOf();
  accesses.set(p.dir, { name: 'DB_URL', value: SECRET });
  assert.strictEqual((await call('POST', `/api/specialist/${p.name}`, { instructions: '# X\n\n@.secrets/accesses.json\n' }))[0], 400);
  assert.strictEqual((await call('POST', '/api/specialist', { name: `t${++counter.n}`, instructions: 'see @./.bd/runs' }))[0], 400);
  fs.mkdirSync(path.join(p.dir, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, 'knowledge', 'hand.md'), 'see @.bd/runs');
  fs.writeFileSync(path.join(p.dir, 'knowledge', 'fine.md'), 'ok');
  await training.beforeLaunch(p.name);
  const tracked = gitIn(p.dir, 'ls-files').split('\n');
  assert.ok(tracked.includes('knowledge/fine.md') && !tracked.includes('knowledge/hand.md'));
  const log = gitIn(p.dir, 'log', '-p', '--all');
  for (const s of ['@.secrets', '@../.git', '@.bd', 's3cret']) assert.ok(!log.includes(s), s);
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

test('own chat: a turn that starts right after a result is marked, guarded and committed', async () => {
  const p = fresh();
  const tmux = store.threadName(p.name, 'personal');
  const subs = [];
  const live = { now: null };
  const fake = {
    subscribe: (t, fn) => { if (t === tmux) subs.push(fn); return () => {}; },
    live: () => live.now,
    status: async () => ({ state: 'idle' }),
    send: async () => ({ ok: true }),
    waitForRunner: async () => ({ up: true }),
  };
  const own = createTraining({ store, headless: fake, tmuxHas, goneMs: 50 });
  const emit = o => subs.forEach(fn => fn(o));
  const subjects = () => gitIn(p.dir, 'log', '--format=%s').trim().split('\n');
  assert.ok((await own.chatTurn(tmux, 'first')).ok);
  fs.mkdirSync(path.join(p.dir, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, 'knowledge', 'one.md'), 'one\n');
  live.now = { state: 'working', turn: { startedAt: 1 } };
  emit({ ev: 'result', subtype: 'success', text: 'Summary: First' });
  emit({ ev: 'state', state: 'working' });
  await own.serial(p.name, async () => {});
  assert.strictEqual(subjects()[0], 'First');
  assert.strictEqual(await own.busy(p.name), 'the bot is busy');
  const meta = () => { const { updatedAt, ...m } = JSON.parse(fs.readFileSync(path.join(p.dir, 'specialist.json'), 'utf8')); return m; };
  const before = meta();
  fs.writeFileSync(path.join(p.dir, 'knowledge', 'two.md'), 'two\n');
  fs.writeFileSync(path.join(p.dir, 'specialist.json'), '{"evil":true}\n');
  live.now = { state: 'idle' };
  emit({ ev: 'result', subtype: 'success', text: 'Summary: Second' });
  await until(() => subjects()[0] === 'Second');
  assert.deepStrictEqual(meta(), before);
  assert.deepStrictEqual(gitIn(p.dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['knowledge/two.md']);
  assert.strictEqual(gitIn(p.dir, 'log', '-1', '--format=%b').trim(), 'Bd-Source: chat');
});
