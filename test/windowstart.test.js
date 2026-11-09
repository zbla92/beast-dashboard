const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ws = require('../lib/windowstart');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-winstart-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const at = (h, m = 0, day = 9) => new Date(2026, 10, day, h, m).getTime();
const MIN = 60000;
const ON = ws.config({ personal: { on: true, start: '07:00', end: '22:00' } }, 'personal');
const idle = (now, f) => ({ session: { pct: 0, resetsAt: null, severity: 'normal', active: false }, fetchedAt: now - 5 * MIN, error: null, ...f });
const running = (now, resetsAt) => ({ session: { pct: 12, resetsAt, active: true }, fetchedAt: now - 5 * MIN, error: null });
const justReset = (now, resetAt) => ({ session: { pct: 0, resetsAt: null, reset: true, resetAt, active: true }, fetchedAt: now - 5 * MIN, error: null });
const decide = f => ws.decide({ cfg: ON, done: [], busy: false, lastActivity: 0, ...f });
const quiet = () => {};
const fileOf = name => path.join(tmp, name + '.json');

test('at the start time with no window running it sends, keyed by the day', () => {
  const now = at(7, 0);
  assert.deepStrictEqual(decide({ limits: idle(now), now }), { key: 'start:2026-11-09', slot: at(7, 0) });
  assert.deepStrictEqual(decide({ limits: idle(at(9, 30)), now: at(9, 30) }), { key: 'start:2026-11-09', slot: at(7, 0) });
});

test('before the start time nothing is sent', () => {
  assert.strictEqual(decide({ limits: idle(at(6, 59)), now: at(6, 59) }), null);
});

test('it is off by default and when switched off', () => {
  assert.deepStrictEqual(ws.config({}, 'personal'), { on: false, start: 7 * 60, end: 22 * 60 });
  assert.strictEqual(decide({ cfg: ws.config({}, 'personal'), limits: idle(at(7)), now: at(7) }), null);
  assert.strictEqual(decide({ cfg: ws.config({ personal: { on: false } }, 'personal'), limits: idle(at(7)), now: at(7) }), null);
});

test('a window that is already running is left alone', () => {
  const now = at(7, 5);
  assert.strictEqual(decide({ limits: running(now, at(10, 0)), now }), null);
  assert.strictEqual(decide({ limits: { session: { pct: 3, resetsAt: null, active: true }, fetchedAt: now - MIN, error: null }, now }), null);
});

test('a reset between start and end sends again a minute after it, keyed by the reset time', () => {
  const r = at(12, 0);
  assert.strictEqual(decide({ limits: justReset(r + 30e3, r), now: r + 30e3 }), null);
  assert.deepStrictEqual(decide({ limits: justReset(r + ws.DELAY, r), now: r + ws.DELAY }), { key: `reset:${r}`, slot: r });
  assert.deepStrictEqual(decide({ limits: justReset(r + 40 * MIN, r), now: r + 40 * MIN, done: ['start:2026-11-09'] }), { key: `reset:${r}`, slot: r });
});

test('a reset right at the end time still counts within the grace minutes', () => {
  const r = at(22, 0);
  assert.deepStrictEqual(decide({ limits: justReset(r + 2 * MIN, r), now: r + 2 * MIN }), { key: `reset:${r}`, slot: r });
  assert.strictEqual(decide({ limits: justReset(r + ws.GRACE + MIN, r), now: r + ws.GRACE + MIN }), null);
});

test('after the end time nothing is sent', () => {
  assert.strictEqual(decide({ limits: idle(at(22, 1)), now: at(22, 1) }), null);
  assert.strictEqual(decide({ limits: justReset(at(22, 40), at(22, 30)), now: at(22, 40) }), null);
  assert.strictEqual(decide({ limits: idle(at(23, 30)), now: at(23, 30) }), null);
});

test('a reset before the start time does not use up the day: the start slot goes out', () => {
  const now = at(7, 0);
  assert.deepStrictEqual(decide({ limits: justReset(now, at(3, 0)), now }), { key: 'start:2026-11-09', slot: at(7, 0) });
  assert.deepStrictEqual(decide({ limits: justReset(now, at(21, 0, 8)), now }), { key: 'start:2026-11-09', slot: at(7, 0) });
});

test('the same slot is never sent twice', () => {
  const now = at(7, 2);
  assert.strictEqual(decide({ limits: idle(now), now, done: ['start:2026-11-09'] }), null);
  const r = at(12, 0);
  assert.strictEqual(decide({ limits: justReset(r + 2 * MIN, r), now: r + 2 * MIN, done: [`reset:${r}`] }), null);
  assert.deepStrictEqual(decide({ limits: idle(at(7, 0, 10)), now: at(7, 0, 10), done: ['start:2026-11-09'] }), { key: 'start:2026-11-10', slot: at(7, 0, 10) });
});

test('nothing is sent while a send for that account is in flight', () => {
  assert.strictEqual(decide({ limits: idle(at(7)), now: at(7), busy: true }), null);
});

test('unknown limits mean no send', () => {
  const now = at(8);
  assert.strictEqual(decide({ limits: undefined, now }), null);
  assert.strictEqual(decide({ limits: {}, now }), null);
  assert.strictEqual(decide({ limits: idle(now, { error: 'rate limited' }), now }), null);
  assert.strictEqual(decide({ limits: idle(now, { fetchedAt: null }), now }), null);
  assert.strictEqual(decide({ limits: idle(now, { stale: true }), now }), null);
  assert.strictEqual(decide({ limits: idle(now, { fetchedAt: now - ws.FRESH - MIN }), now }), null);
  assert.deepStrictEqual(decide({ limits: idle(now, { fetchedAt: now - ws.FRESH + MIN }), now }), { key: 'start:2026-11-09', slot: at(7, 0) });
});

test('the user already started the window after the reset: no send', () => {
  const r = at(12, 0);
  assert.strictEqual(decide({ limits: justReset(r + 5 * MIN, r), now: r + 5 * MIN, lastActivity: r + 2 * MIN }), null);
  assert.deepStrictEqual(decide({ limits: justReset(r + 5 * MIN, r), now: r + 5 * MIN, lastActivity: r - 20 * MIN }), { key: `reset:${r}`, slot: r });
  const now = at(7, 10);
  assert.strictEqual(decide({ limits: idle(now), now, lastActivity: () => now - MIN }), null);
  assert.deepStrictEqual(decide({ limits: idle(now), now, lastActivity: () => now - 20 * MIN }), { key: 'start:2026-11-09', slot: at(7, 0) });
});

test('transcripts are only read when a send is otherwise due', () => {
  const calls = [];
  const lastActivity = () => { calls.push(1); return 0; };
  decide({ limits: idle(at(6)), now: at(6), lastActivity });
  decide({ limits: idle(at(8)), now: at(8), lastActivity, done: ['start:2026-11-09'] });
  decide({ limits: running(at(8), at(11)), now: at(8), lastActivity });
  assert.strictEqual(calls.length, 0);
});

test('start and end times are cleaned; bad ones or a start at or after the end keep the previous times', () => {
  assert.deepStrictEqual(ws.clean({ personal: { on: true, start: '6:30', end: '25:00' }, company: 'x', other: { on: true } }), { personal: { on: true, start: '06:30', end: '22:00' }, company: { on: false, start: '07:00', end: '22:00' } });
  assert.deepStrictEqual(ws.clean({ personal: { on: true, start: '22:00', end: '08:00' } }, { personal: { on: false, start: '06:00', end: '21:00' } }).personal, { on: true, start: '06:00', end: '21:00' });
  assert.deepStrictEqual(ws.clean({ personal: { on: true, start: '09:00', end: '09:00' } }).personal, { on: true, start: '07:00', end: '22:00' });
  assert.deepStrictEqual(ws.config({ personal: { on: true, start: '20:00', end: '08:00' } }, 'personal'), { on: true, start: 7 * 60, end: 22 * 60 });
  const cfg = { on: true, start: 20 * 60, end: 8 * 60 };
  assert.strictEqual(decide({ cfg, limits: idle(at(21)), now: at(21) }), null);
  assert.strictEqual(decide({ cfg, limits: idle(at(7)), now: at(7) }), null);
});

const settings = { personal: { on: true, start: '07:00', end: '22:00' }, company: { on: true, start: '07:00', end: '22:00' } };

test('the runner sends once per slot, per account, and keeps the result', async () => {
  const calls = [];
  const r = ws.create({ file: fileOf('once'), send: async a => { calls.push(a); return { ok: true }; }, log: quiet });
  const now = at(7, 1);
  const lim = { personal: idle(now), company: idle(now) };
  const first = r.tick({ settings, accounts: ['personal', 'company'], limits: lim, lastActivity: () => 0, now });
  assert.strictEqual(first.length, 2);
  assert.deepStrictEqual((await Promise.all(first)).map(x => [x.account, x.key, x.ok]), [['personal', 'start:2026-11-09', true], ['company', 'start:2026-11-09', true]]);
  assert.strictEqual(r.tick({ settings, accounts: ['personal', 'company'], limits: lim, lastActivity: () => 0, now: now + MIN }).length, 0);
  assert.deepStrictEqual(calls, ['personal', 'company']);
  assert.deepStrictEqual([r.status().personal.ok, r.status().personal.key, r.status().personal.at], [true, 'start:2026-11-09', now]);
});

test('one send in flight per account: a second tick while it runs does nothing', async () => {
  const gate = {};
  const hold = new Promise(res => { gate.open = res; });
  const calls = [];
  const r = ws.create({ file: fileOf('inflight'), send: async a => { calls.push(a); await hold; return { ok: true }; }, log: quiet });
  const r0 = at(12, 0);
  const p = r.tick({ settings, accounts: ['personal'], limits: { personal: justReset(r0 + 2 * MIN, r0) }, now: r0 + 2 * MIN });
  assert.strictEqual(r.status().personal.ok, null);
  assert.strictEqual(r.tick({ settings, accounts: ['personal'], limits: { personal: idle(at(12, 5)) }, now: at(12, 5) }).length, 0);
  gate.open(); await Promise.all(p);
  assert.deepStrictEqual(calls, ['personal']);
});

test('a failed send is logged and not retried for the same slot', async () => {
  const calls = []; const logs = [];
  const r = ws.create({ file: fileOf('fail'), send: async a => { calls.push(a); return { ok: false, error: 'boom' }; }, log: l => logs.push(l) });
  const now = at(7, 0);
  const [res] = await Promise.all(r.tick({ settings, accounts: ['personal'], limits: { personal: idle(now) }, now }));
  assert.deepStrictEqual([res.ok, res.error], [false, 'boom']);
  assert.strictEqual(r.tick({ settings, accounts: ['personal'], limits: { personal: idle(now + 5 * MIN) }, now: now + 5 * MIN }).length, 0);
  assert.deepStrictEqual(calls, ['personal']);
  assert.match(logs[0], /window-start: personal failed: boom \(start:2026-11-09\)/);
  assert.deepStrictEqual([r.status().personal.ok, r.status().personal.error], [false, 'boom']);
  const thrown = ws.create({ file: fileOf('throw'), send: async () => { throw new Error('spawn ENOENT'); }, log: quiet });
  const [t] = await Promise.all(thrown.tick({ settings, accounts: ['personal'], limits: { personal: idle(now) }, now }));
  assert.deepStrictEqual([t.ok, t.error], [false, 'spawn ENOENT']);
});

test('after a restart the saved keys still hold, and a send cut off by the restart counts as failed', async () => {
  const file = fileOf('restart');
  const calls = [];
  const now = at(7, 0);
  const a = ws.create({ file, send: async x => { calls.push(x); return { ok: true }; }, log: quiet });
  await Promise.all(a.tick({ settings, accounts: ['personal'], limits: { personal: idle(now) }, now }));
  const b = ws.create({ file, send: async x => { calls.push(x); return { ok: true }; }, log: quiet });
  assert.strictEqual(b.tick({ settings, accounts: ['personal'], limits: { personal: idle(now + MIN) }, now: now + MIN }).length, 0);
  assert.strictEqual(b.status().personal.ok, true);
  assert.deepStrictEqual(calls, ['personal']);
  const cut = fileOf('cut');
  const c = ws.create({ file: cut, send: () => new Promise(() => {}), log: quiet });
  c.tick({ settings, accounts: ['personal'], limits: { personal: idle(now) }, now });
  const d = ws.create({ file: cut, send: async x => { calls.push(x); return { ok: true }; }, log: quiet });
  assert.deepStrictEqual([d.status().personal.ok, d.status().personal.error], [false, 'interrupted by a restart']);
  assert.strictEqual(d.tick({ settings, accounts: ['personal'], limits: { personal: idle(now + MIN) }, now: now + MIN }).length, 0);
});

test('accounts without settings or without limits are skipped', () => {
  const r = ws.create({ file: fileOf('skip'), send: async () => ({ ok: true }), log: quiet });
  const now = at(8);
  assert.strictEqual(r.tick({ settings: { personal: { on: true } }, accounts: ['personal', 'company'], limits: { company: idle(now) }, now }).length, 0);
});

const fakeSpawn = (calls, behave) => (bin, args, opts) => {
  const p = new EventEmitter();
  p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdout.setEncoding = () => {}; p.stderr.setEncoding = () => {};
  p.exitCode = null; p.killed = [];
  p.kill = sig => { p.killed.push(sig); };
  p.stdin = new EventEmitter(); p.stdin.end = text => { calls.push({ bin, args, opts, text, proc: p }); setImmediate(() => behave(p)); };
  return p;
};

test('the ping runs claude -p on haiku with no tools and no saved session, in the account\'s config dir', async () => {
  const calls = [];
  const cwd = path.join(tmp, 'ping-cwd');
  const ok = ws.ping('company', { bin: '/x/claude', cwd, spawnFn: fakeSpawn(calls, p => { p.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hey' }) + '\n'); p.exitCode = 0; p.emit('close', 0); }) });
  assert.deepStrictEqual(await ok, { ok: true });
  const c = calls[0];
  assert.strictEqual(c.bin, '/x/claude');
  assert.deepStrictEqual(c.args, ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json']);
  assert.strictEqual(c.text, ws.PROMPT);
  assert.strictEqual(c.opts.cwd, cwd);
  assert.ok(fs.statSync(cwd).isDirectory());
  assert.strictEqual(c.opts.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude-company'));
  assert.strictEqual(ws.childEnv('personal').CLAUDE_CONFIG_DIR, undefined);
});

test('the ping reports an error result, a non-zero exit and a timeout as failed', async () => {
  const calls = [];
  const cwd = path.join(tmp, 'ping-cwd');
  const limit = await ws.ping('personal', { cwd, spawnFn: fakeSpawn(calls, p => { p.stdout.emit('data', JSON.stringify({ type: 'result', is_error: true, result: "You've hit your limit" })); p.exitCode = 1; p.emit('close', 1); }) });
  assert.deepStrictEqual(limit, { ok: false, error: "You've hit your limit" });
  const crash = await ws.ping('personal', { cwd, spawnFn: fakeSpawn(calls, p => { p.stderr.emit('data', 'Error: not logged in\n'); p.exitCode = 1; p.emit('close', 1); }) });
  assert.deepStrictEqual(crash, { ok: false, error: 'Error: not logged in' });
  const slow = await ws.ping('personal', { cwd, timeout: 20, spawnFn: fakeSpawn(calls, () => {}) });
  assert.deepStrictEqual(slow, { ok: false, error: 'no answer in 0 s' });
  assert.deepStrictEqual(calls[2].proc.killed, ['SIGTERM']);
});

test('a handled reset also uses up the day\'s start slot, so the same idle stretch is not sent twice', async () => {
  const calls = [];
  const r = ws.create({ file: fileOf('reset-covers-start'), send: async a => { calls.push(a); return { ok: false, error: 'boom' }; }, log: quiet });
  const r0 = at(9, 0);
  assert.strictEqual(r.tick({ settings, accounts: ['personal'], limits: { personal: running(at(7, 0), r0) }, now: at(7, 0) }).length, 0);
  await Promise.all(r.tick({ settings, accounts: ['personal'], limits: { personal: justReset(r0 + 2 * MIN, r0) }, now: r0 + 2 * MIN }));
  assert.strictEqual(r.tick({ settings, accounts: ['personal'], limits: { personal: idle(at(9, 10)) }, now: at(9, 10) }).length, 0);
  assert.deepStrictEqual(calls, ['personal']);
});

test('a reset the next fetch has already wiped is still recognised from the reset time seen before', async () => {
  const calls = [];
  const r = ws.create({ file: fileOf('seen-reset'), send: async a => { calls.push(a); return { ok: true }; }, log: quiet });
  const r0 = at(12, 0);
  await Promise.all(r.tick({ settings, accounts: ['personal'], limits: { personal: idle(at(7, 0)) }, now: at(7, 0) }));
  assert.strictEqual(r.tick({ settings, accounts: ['personal'], limits: { personal: running(at(11, 50), r0) }, now: at(11, 50) }).length, 0);
  const sent = await Promise.all(r.tick({ settings, accounts: ['personal'], limits: { personal: idle(r0 + 3 * MIN, { fetchedAt: r0 + 30e3 }) }, now: r0 + 3 * MIN }));
  assert.deepStrictEqual(sent.map(x => x.key), [`reset:${r0}`]);
  assert.deepStrictEqual(calls, ['personal', 'personal']);
});

test('the ping drops every ANTHROPIC_ variable so it cannot bill an API key', () => {
  const keep = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'http://x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1' });
  try {
    const env = ws.childEnv('personal');
    assert.deepStrictEqual(Object.keys(env).filter(k => k.startsWith('ANTHROPIC_') || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')), ['CLAUDE_CODE_AUTO_COMPACT_WINDOW']);
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
});
