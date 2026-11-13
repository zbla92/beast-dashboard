const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-bots-secrets-')));
process.env.BD_TEST = '1';
process.env.BD_MIRROR = tmp;
process.env.XDG_RUNTIME_DIR = tmp;
process.env.HOME = tmp;
process.env.BD_HL_EXIT_MS = '150';
process.env.BD_SPECIALISTS_DIR = path.join(tmp, 'specialists');
const PORT = 8811, procs = path.join(tmp, 'procs'), bin = path.join(tmp, 'bin');
const RUNNER = path.join(__dirname, '..', 'bin', 'headless-runner.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const FAKE_ARGS = path.join(tmp, 'fake-args.jsonl'), FAKE_INPUT = path.join(tmp, 'fake-input.jsonl');
const SECRET = 'example-dummy-token-7f3a9c';
const TOKEN = 'tok-abcdef123';
const SHORT = 'abc1234';
const KNOWN = "this message contains one of the bot's credentials; set credentials in the bot's settings";
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

const logged = [];
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k];
  console[k] = (...a) => { logged.push(a.map(String).join(' ')); if (k !== 'error') orig(...a); };
}

const store = require('../lib/specialists');
const claude = require('../lib/claude');
const headless = require('../lib/headless');
const accesses = require('../lib/accesses');
const { createRuns } = require('../lib/specialist-runs');
const { createSpecialistApi } = require('../lib/specialist-api');
const { createTraining } = require('../lib/training');
const { readBody } = require('../lib/util');
headless.init({ port: PORT, test: true, claudeBin: FAKE });

const pidOf = name => { try { return +fs.readFileSync(path.join(procs, name + '.pid'), 'utf8'); } catch { return 0; } };
const alive = name => { try { process.kill(pidOf(name), 0); return pidOf(name) > 0; } catch { return false; } };
const tmuxHas = async name => alive(name);
const lines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const fakeArgs = () => lines(FAKE_ARGS).filter(a => a.argv);
const inputs = () => lines(FAKE_INPUT);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); } };
const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
const flagOf = (argv, f) => argv.includes(f) ? argv[argv.indexOf(f) + 1] : null;

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
  const r = await fetch((await base()) + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
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
const fresh = (fields = {}) => store.create({ name: `s${++counter.n}`, ...fields });
const withAccess = (fields = {}) => {
  const p = fresh(fields);
  accesses.set(p.dir, { name: 'DB_URL', value: SECRET, note: 'read replica' });
  return p;
};
const trainerDone = name => until(async () => { const [, o] = await call('GET', `/api/specialist/${name}/train`); return o.trainer && o.trainer.live && o.trainer.state === 'idle' ? o : null; });
const teach = async (p, text) => {
  const [s] = await call('POST', `/api/specialist/${p.name}/train/send`, { text });
  assert.strictEqual(s, 200);
  return trainerDone(p.name);
};
const tracked = dir => gitIn(dir, 'log', '--all', '--name-only', '--format=').split('\n').filter(Boolean);
const history = dir => gitIn(dir, 'log', '--all', '-p', '--format=%H %s%n%b');

const rules = (dir, tools, rels) => tools.flatMap(t => rels.map(r => `${t}(/${dir}/${r})`));
const chatDeny = dir => [
  ...rules(dir, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit'], ['.secrets', '.secrets/**']),
  ...rules(dir, ['Edit', 'Write', 'NotebookEdit'], ['specialist.json', '.claude/**', '.mcp.json', '.gitignore', '.git/**', '.bd/**']),
];
const callDeny = dir => [...chatDeny(dir), ...rules(dir, ['Edit', 'Write', 'NotebookEdit'], ['CLAUDE.md', 'style.md', 'knowledge/**', 'examples/**'])];

test('generated settings: chat and call files hold only deny rules on // paths, never a value; an unsafe folder path is refused', () => {
  const p = withAccess();
  assert.strictEqual(store.botSettings(p, 'chat'), path.join(p.dir, '.bd', 'settings.json'));
  assert.strictEqual(store.botSettings(p, 'call'), path.join(p.dir, '.bd', 'call-settings.json'));
  const chat = JSON.parse(fs.readFileSync(path.join(p.dir, '.bd', 'settings.json'), 'utf8'));
  const callSettings = JSON.parse(fs.readFileSync(path.join(p.dir, '.bd', 'call-settings.json'), 'utf8'));
  assert.deepStrictEqual(chat, { permissions: { deny: chatDeny(p.dir) } });
  assert.deepStrictEqual(callSettings, { permissions: { deny: callDeny(p.dir) } });
  assert.ok(chat.permissions.deny.includes(`Read(/${p.dir}/.secrets/**)`) && chat.permissions.deny[0].startsWith('Read(//'));
  assert.ok(!chat.permissions.deny.some(r => /CLAUDE\.md|style\.md|knowledge|examples/.test(r)));
  for (const f of ['settings.json', 'call-settings.json']) {
    const st = fs.statSync(path.join(p.dir, '.bd', f));
    assert.strictEqual(st.mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(path.join(p.dir, '.bd', f), 'utf8').includes(SECRET));
  }
  for (const dir of ['/tmp/a b/bot', '/tmp/a(b)/bot', '/tmp/a*b/bot', 'relative/bot']) {
    assert.throws(() => store.botSettings({ dir }, 'chat'), e => e.status === 409 && e.message === "the bot folder path has characters the permission rules can't hold", dir);
  }
  assert.throws(() => store.botSettings(p, 'other'), e => e.status === 500);
  assert.doesNotThrow(() => store.checkBotPath(p.dir));
  assert.throws(() => store.checkBotPath('/tmp/a b'), e => e.status === 409);
});

test('a call runs with --settings call-settings.json next to --accesses under bypassPermissions; values only reach its env', async () => {
  const p = withAccess();
  const n0 = fakeArgs().length;
  const [s, asked] = await call('POST', `/api/specialist/${p.name}/ask`, { text: 'look it up' });
  assert.strictEqual(s, 200);
  const [, run] = await call('GET', `/api/specialist/run/${asked.runId}?wait=1&timeoutSec=10`);
  assert.strictEqual(run.state, 'done');
  const a = fakeArgs().slice(n0).find(x => x.cwd === p.dir);
  assert.strictEqual(flagOf(a.argv, '--settings'), path.join(p.dir, '.bd', 'call-settings.json'));
  assert.ok(a.argv.includes('--dangerously-skip-permissions'));
  assert.strictEqual(a.env.DB_URL, SECRET);
  assert.ok(!a.argv.join('\n').includes(SECRET));
  assert.deepStrictEqual(claude.get(asked.tmux).runner.settings, path.join(p.dir, '.bd', 'call-settings.json'));
  assert.deepStrictEqual(claude.get(asked.tmux).runner.accesses, p.dir);
  await until(async () => !(await tmuxHas(asked.tmux)));
  const [c2] = await call('POST', `/api/specialist/run/${asked.runId}/send`, { text: 'once more', wait: true, timeoutSec: 10 });
  assert.strictEqual(c2, 200);
  const again = fakeArgs().slice(n0).filter(x => x.cwd === p.dir);
  assert.ok(again.length >= 2);
  assert.strictEqual(flagOf(again[again.length - 1].argv, '--settings'), path.join(p.dir, '.bd', 'call-settings.json'));
});

test('the own chat runs with --settings settings.json and keeps it through an in-runner restart and a respawn', async () => {
  const p = withAccess({ mode: 'thread', permissionMode: 'acceptEdits' });
  const n0 = fakeArgs().length;
  const [s, asked] = await call('POST', `/api/specialist/${p.name}/ask`, { text: 'hello', wait: true, timeoutSec: 10 });
  assert.strictEqual(s, 200);
  const tmux = store.threadName(p.name, 'personal');
  const chatFile = path.join(p.dir, '.bd', 'settings.json');
  const first = fakeArgs().slice(n0).find(x => x.cwd === p.dir);
  assert.strictEqual(flagOf(first.argv, '--settings'), chatFile);
  assert.strictEqual(flagOf(first.argv, '--permission-mode'), 'acceptEdits');
  assert.strictEqual(first.env.DB_URL, SECRET);
  assert.strictEqual(asked.tmux || tmux, tmux);
  const rec = claude.get(tmux);
  assert.deepStrictEqual([rec.runner.settings, rec.runner.accesses], [chatFile, p.dir]);
  assert.deepStrictEqual(headless.runnerArgs(rec.runner).slice(-4), ['--accesses', p.dir, '--settings', chatFile]);

  const n1 = fakeArgs().length;
  assert.strictEqual((await headless.restartChat(tmux, claude.get(tmux))).ok, true);
  const restarted = await until(() => fakeArgs().slice(n1).find(x => x.cwd === p.dir));
  assert.strictEqual(flagOf(restarted.argv, '--settings'), chatFile);
  assert.strictEqual(restarted.env.DB_URL, SECRET);

  process.kill(pidOf(tmux), 'SIGKILL');
  await until(async () => !(await tmuxHas(tmux)));
  const n2 = fakeArgs().length;
  const r = await headless.restartChat(tmux, claude.get(tmux));
  assert.strictEqual(r.ok, true, r.error);
  const respawned = await until(() => fakeArgs().slice(n2).find(x => x.cwd === p.dir));
  assert.strictEqual(flagOf(respawned.argv, '--settings'), chatFile);
  assert.strictEqual(claude.get(tmux).runner.settings, chatFile);
});

test('runner: --settings is taken for any session when absolute, refused when relative; session records keep it', async () => {
  const run = extra => new Promise(r => spawn(process.execPath, [RUNNER, '--sock', path.join(tmp, 'x.sock'), '--cwd', tmp, '--session-id', '11111111-2222-4333-8444-555555555555', '--start', 'new', ...extra], { stdio: 'ignore' }).on('exit', r));
  assert.strictEqual(await run(['--settings', 'rel.json']), 2);
  assert.strictEqual(await run(['--settings', '/t/s.json', '--accesses', 'rel']), 2);
  assert.deepStrictEqual(headless.runnerArgs({ permissionMode: 'bypassPermissions', addDirs: [], accesses: '/p', settings: '/p/.bd/settings.json' }), ['--accesses', '/p', '--settings', '/p/.bd/settings.json']);
  claude.markChat('claude-spec-zz-keep', { cwd: tmp, account: 'personal', sessionId: '11111111-2222-4333-8444-555555555556', specialist: 'zz-keep', runner: { accesses: '/p', settings: '/p/.bd/settings.json' } });
  assert.deepStrictEqual([claude.get('claude-spec-zz-keep').runner.accesses, claude.get('claude-spec-zz-keep').runner.settings], ['/p', '/p/.bd/settings.json']);
  claude.setRunner('claude-spec-zz-keep', { ...claude.get('claude-spec-zz-keep').runner, settings: 'rel.json' });
  assert.ok(!('settings' in claude.get('claude-spec-zz-keep').runner));
});

test('a message holding a credential value is refused for an ask, a continued call and a bot session send; nothing is sent or saved', async () => {
  const p = withAccess();
  accesses.set(p.dir, { name: 'PIN', value: SHORT });
  const before = accesses.list(p.dir);
  const runs0 = store.listRuns(p.name).length, args0 = fakeArgs().length, in0 = inputs().length;
  for (const text of [SECRET, `please use ${SECRET} for this`, `line one\n${SECRET}\nline three`]) {
    const [s, out] = await call('POST', `/api/specialist/${p.name}/ask`, { text });
    assert.deepStrictEqual([s, out.error], [409, KNOWN], text);
  }
  assert.strictEqual(store.listRuns(p.name).length, runs0);
  assert.strictEqual(fakeArgs().length, args0);

  const [s, asked] = await call('POST', `/api/specialist/${p.name}/ask`, { text: `the pin ${SHORT} is short`, wait: true, timeoutSec: 10 });
  assert.strictEqual(s, 200);
  assert.strictEqual(asked.state, 'done');
  const in1 = inputs().length;
  assert.ok(in1 > in0);
  const [c, out] = await call('POST', `/api/specialist/run/${asked.runId}/send`, { text: `now with ${SECRET}` });
  assert.deepStrictEqual([c, out.error], [409, KNOWN]);
  assert.strictEqual(store.getRun(asked.runId).turns, 1);
  assert.strictEqual(inputs().length, in1);

  for (const tmux of [store.threadName(p.name, 'personal'), store.threadName(p.name, 'company'), asked.tmux, store.trainerName(p.name, 'personal')]) {
    assert.throws(() => accesses.refuseInSession(tmux, [`hi ${SECRET}`]), e => e.status === 409 && e.message === KNOWN, tmux);
    assert.throws(() => accesses.refuseInSession(tmux, ['fine', 42, SECRET]), e => e.status === 409, tmux);
    assert.doesNotThrow(() => accesses.refuseInSession(tmux, [`hi ${SHORT}`, null]));
  }
  for (const tmux of ['claude-other', 'sh-1', 'claude-spec-nobody', '', undefined]) assert.doesNotThrow(() => accesses.refuseInSession(tmux, [SECRET]));
  assert.throws(() => accesses.refuseKnown(p.dir, Buffer.from(SECRET).toString('utf8')), e => e.status === 409);
  assert.doesNotThrow(() => accesses.refuseKnown(p.dir, SECRET.slice(0, -1)));
  assert.deepStrictEqual(accesses.list(p.dir), before);
  assert.deepStrictEqual(accesses.values(p.dir).map(v => [v.name, Buffer.isBuffer(v.value)]), [['DB_URL', true], ['PIN', true]]);
});

test('commit guard: .secrets never enters history, staged files holding a value or a private segment are left out and logged by name, empty commits are skipped', async () => {
  const p = withAccess();
  accesses.set(p.dir, { name: 'TOKEN', value: TOKEN, note: 'api' });
  await teach(p, 'write style.md=Short and warm.\nSummary: Warmer style');
  assert.ok(!tracked(p.dir).some(f => f.startsWith('.secrets') || f.startsWith('.bd')));
  assert.ok(tracked(p.dir).includes('style.md'));

  const log0 = logged.length;
  fs.mkdirSync(path.join(p.dir, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, 'knowledge', 'leak.md'), `connect with ${SECRET}\n`);
  fs.writeFileSync(path.join(p.dir, 'knowledge', `${TOKEN}.md`), 'harmless body\n');
  fs.writeFileSync(path.join(p.dir, 'knowledge', 'ok.md'), 'plain notes\n');
  gitIn(p.dir, 'add', '-f', '.secrets/accesses.json');
  fs.mkdirSync(path.join(p.dir, 'examples', '.bd'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, 'examples', '.bd', 'x.md'), 'private\n');
  await teach(p, 'write examples/one.md=An example\nSummary: Example');
  const files = tracked(p.dir);
  assert.ok(files.includes('knowledge/ok.md') && files.includes('examples/one.md'));
  for (const f of ['knowledge/leak.md', `knowledge/${TOKEN}.md`, '.secrets/accesses.json', 'examples/.bd/x.md']) assert.ok(!files.includes(f), f);
  assert.ok(!history(p.dir).includes(SECRET) && !history(p.dir).includes(TOKEN));
  const notes = logged.slice(log0).filter(l => l.includes('left out of the commit'));
  assert.ok(notes.some(l => l.includes('knowledge/leak.md contains the value of DB_URL')), notes.join('\n'));
  assert.ok(notes.some(l => l.includes('a file name contains the value of TOKEN')), notes.join('\n'));
  assert.ok(notes.some(l => l.includes('.secrets/accesses.json is inside .secrets')), notes.join('\n'));
  assert.ok(notes.some(l => l.includes('examples/.bd/x.md is inside .bd')), notes.join('\n'));
  assert.ok(!notes.some(l => l.includes(SECRET) || l.includes(TOKEN)));
  assert.strictEqual(gitIn(p.dir, 'diff', '--cached', '--name-only'), '');

  const head = gitIn(p.dir, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(p.dir, 'knowledge', 'leak.md'), `still ${SECRET}\n`);
  await teach(p, 'nothing to change');
  assert.strictEqual(gitIn(p.dir, 'rev-parse', 'HEAD').trim(), head);
  assert.ok(!history(p.dir).includes(SECRET));

  fs.writeFileSync(path.join(p.dir, 'knowledge', 'ok.md'), `now holds ${SECRET}\n`);
  await teach(p, 'nothing again');
  assert.strictEqual(gitIn(p.dir, 'rev-parse', 'HEAD').trim(), head);
  assert.strictEqual(gitIn(p.dir, 'show', 'HEAD:knowledge/ok.md'), 'plain notes\n');
});

test('values never appear in API responses, logs, run records, session records, generated files or anything else outside .secrets and the fake env log', () => {
  for (const r of responses) assert.ok(!r.includes(SECRET) && !r.includes(TOKEN), r.slice(0, 200));
  for (const l of logged) assert.ok(!l.includes(SECRET) && !l.includes(TOKEN), l.slice(0, 200));
  const hits = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '.secrets' && e.name !== '.git') walk(f); continue; }
      if (!e.isFile() || f === FAKE_ARGS || f === FAKE_INPUT) continue;
      if (path.basename(path.dirname(f)) === 'knowledge' && fs.readFileSync(f).includes(SECRET)) continue;
      const b = fs.readFileSync(f);
      if (b.includes(SECRET) || b.includes(TOKEN)) hits.push(path.relative(tmp, f));
    }
  };
  walk(tmp);
  assert.deepStrictEqual(hits, []);
});
