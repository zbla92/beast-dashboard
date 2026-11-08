const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-resume-')));
process.env.BD_TEST = '1';
process.env.BD_MIRROR = tmp;
fs.writeFileSync(path.join(tmp, 'claude-sessions.json'), '{}');
const claude = require('../lib/claude');
const schedule = require('../lib/schedule');
const ar = require('../lib/autoresume');
schedule.useFile(path.join(tmp, 'schedule.json'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 10, 8, 9, 0);
const H = 3600e3;
const limitRec = f => ({ tmux: 'claude-chat-a', mode: 'chat', account: 'personal', state: 'limit', since: NOW - 60e3, promptAt: NOW - 120e3, lastMessage: "You've hit your session limit · resets 11:40am (Europe/Sarajevo)", ...f });
const plan = f => ar.plan({ enabled: true, name: 'claude-chat-a', rec: limitRec(), limits: {}, jobs: [], now: NOW, ...f });
const idle = () => false; const exists = async () => true;
const okSend = calls => async (name, text) => { calls.push([name, text]); return { ok: true }; };

test('the reset time is read from the limit text in the zone it names, the next time that clock comes round', () => {
  assert.strictEqual(ar.parseResetText("You've hit your session limit · resets 11:40am (Europe/Sarajevo)", NOW), Date.UTC(2026, 10, 8, 10, 40));
  assert.strictEqual(ar.parseResetText("You've hit your 5-hour limit · resets 6pm (Europe/Sarajevo)", NOW), Date.UTC(2026, 10, 8, 17, 0));
  assert.strictEqual(ar.parseResetText('limit · resets 8am (UTC)', NOW), Date.UTC(2026, 10, 9, 8, 0));
  assert.strictEqual(ar.parseResetText('weekly limit · resets Nov 10, 3pm (UTC)', NOW), Date.UTC(2026, 10, 10, 15, 0));
  assert.strictEqual(ar.parseResetText('Claude AI usage limit reached|1762617600', NOW), 1762617600e3);
  assert.strictEqual(ar.parseResetText('limit hit · resets in 2h 30m', NOW), NOW + 2.5 * H);
});

test('limit text without a usable time gives no reset time', () => {
  for (const t of ['', null, "You've hit your limit", 'resets soon', 'resets 3', 'resets 13pm (UTC)', 'resets Foo 10, 3pm']) assert.strictEqual(ar.parseResetText(t, NOW), null, String(t));
});

test('the latest reset among the windows at 100 % wins over the text; a window below 100 % does not count', () => {
  const limits = { session: { pct: 100, resetsAt: NOW + 2 * H }, weekly: { pct: 100, resetsAt: NOW + 30 * H }, scoped: [{ pct: 99, resetsAt: NOW + 90 * H }] };
  assert.strictEqual(ar.resetsAtFor(limits, 'resets 11:40am (UTC)', NOW), NOW + 30 * H);
  assert.strictEqual(ar.resetsAtFor({ session: { pct: 97, resetsAt: NOW + 2 * H } }, 'resets 11:40am (UTC)', NOW), Date.UTC(2026, 10, 8, 11, 40));
  assert.strictEqual(ar.resetsAtFor({ session: { pct: 100, resetsAt: NOW + 2 * H + 1234 } }, '', NOW), NOW + 2 * H);
  assert.strictEqual(ar.resetsAtFor(null, 'no time here', NOW), null);
  assert.strictEqual(ar.resetsAtFor({ session: { pct: 100, resetsAt: NOW + 9 * 86400e3 } }, '', NOW), null);
});

test('a per-model weekly window counts only for a session on that model family', () => {
  const limits = { session: { pct: 100, resetsAt: NOW + 2 * H }, weekly: { pct: 40, resetsAt: NOW + 50 * H }, scoped: [{ name: 'Fable', pct: 100, resetsAt: NOW + 90 * H }] };
  assert.strictEqual(ar.resetsAtFor(limits, '', NOW, 'claude-opus-5-5[1m]'), NOW + 2 * H);
  assert.strictEqual(ar.resetsAtFor(limits, '', NOW, null), NOW + 2 * H);
  assert.strictEqual(ar.resetsAtFor(limits, '', NOW, 'claude-fable-1'), NOW + 90 * H);
  assert.strictEqual(plan({ rec: limitRec({ model: 'claude-opus-5-5', lastMessage: 'rate_limit' }), limits: { personal: { ...limits, session: { pct: 80, resetsAt: NOW + 2 * H } } } }), null);
});

test('a short 429 with no window at 100 % and no reset time in the message plans nothing', () => {
  const limits = { personal: { session: { pct: 62, resetsAt: NOW + 2 * H }, weekly: { pct: 30, resetsAt: NOW + 50 * H }, scoped: [] } };
  assert.strictEqual(plan({ rec: limitRec({ lastMessage: 'API Error: Rate limit reached' }), limits }), null);
  assert.strictEqual(plan({ rec: limitRec({ lastMessage: 'rate_limit' }), limits }), null);
});

test('a chat in limit is held back from an automatic restart; other chats and terminal sessions are not', () => {
  assert.strictEqual(ar.holdsChat({ mode: 'chat', state: 'limit' }), true);
  assert.strictEqual(ar.holdsChat({ mode: 'chat', state: 'idle' }), false);
  assert.strictEqual(ar.holdsChat({ state: 'limit' }), false);
});

test('a chat in limit with a known reset gets one job a minute after the reset, keyed by session and reset time', () => {
  const p = plan({ limits: { personal: { session: { pct: 100, resetsAt: NOW + 2 * H } } } });
  assert.deepStrictEqual(p, { session: 'claude-chat-a', at: NOW + 2 * H + 60e3, key: `resume:claude-chat-a:${NOW + 2 * H}`, limitAt: NOW - 60e3, resetsAt: NOW + 2 * H });
  assert.strictEqual(plan().resetsAt, Date.UTC(2026, 10, 8, 10, 40));
});

test('no job when the setting is off, for a terminal session, outside a limit, without a reset time, or when the key was used', () => {
  assert.strictEqual(plan({ enabled: false }), null);
  assert.strictEqual(plan({ rec: limitRec({ mode: undefined }) }), null);
  assert.strictEqual(plan({ rec: limitRec({ state: 'error' }) }), null);
  assert.strictEqual(plan({ rec: limitRec({ lastMessage: "You've hit your limit" }) }), null);
  const key = plan().key;
  assert.strictEqual(plan({ jobs: [{ key, state: 'failed', error: 'cancelled' }] }), null);
  assert.strictEqual(plan({ jobs: [{ key, state: 'done' }] }), null);
});

test('at fire time it goes out only while the chat is still in the same limit and nothing was sent since', () => {
  const job = { id: 'j1', session: 'claude-chat-a', limitAt: NOW - 60e3, resume: true };
  const fire = f => ar.shouldFire({ enabled: true, job, rec: limitRec(), jobs: [job], ...f });
  assert.strictEqual(fire(), true);
  assert.strictEqual(fire({ enabled: false }), false);
  assert.strictEqual(fire({ rec: limitRec({ state: 'needs-you' }) }), false);
  assert.strictEqual(fire({ rec: limitRec({ state: 'working' }) }), false);
  assert.strictEqual(fire({ rec: limitRec({ promptAt: NOW }) }), false);
  assert.strictEqual(fire({ rec: null }), false);
  assert.strictEqual(fire({ jobs: [job, { id: 'j2', session: 'claude-chat-a', lastSentAt: NOW }] }), false);
  assert.strictEqual(fire({ jobs: [job, { id: 'j2', session: 'claude-chat-b', lastSentAt: NOW }] }), true);
});

test('a keyed job is added once per key, also after a cancel', () => {
  const opts = { key: 'resume:claude-chat-k:1', resume: { limitAt: 5, resetsAt: 1 } };
  const a = schedule.add('claude-chat-k', Date.now() + H, [ar.PROMPT], opts);
  assert.ok(a.ok && !a.existed);
  assert.deepStrictEqual([a.job.key, a.job.resume, a.job.limitAt, a.job.resetsAt, a.job.prompts], ['resume:claude-chat-k:1', true, 5, 1, ['continue']]);
  const b = schedule.add('claude-chat-k', Date.now() + H, [ar.PROMPT], opts);
  assert.ok(b.existed); assert.strictEqual(b.job.id, a.job.id);
  schedule.remove(a.job.id);
  assert.deepStrictEqual([a.job.state, a.job.error], ['failed', 'cancelled']);
  assert.ok(schedule.add('claude-chat-k', Date.now() + H, [ar.PROMPT], opts).existed);
  assert.strictEqual(schedule.all().filter(j => j.key === opts.key).length, 1);
});

test('an unkeyed job is removed as before and gets no resume fields', () => {
  const { job } = schedule.add('claude-plain', Date.now() + H, ['hi']);
  assert.ok(!('key' in job) && !('resume' in job));
  schedule.remove(job.id);
  assert.ok(!schedule.all().includes(job));
});

test('a due resume job that is not needed any more is dropped without sending or a push', async () => {
  const { job } = schedule.add('claude-chat-d', Date.now() - 1000, [ar.PROMPT], { key: 'resume:claude-chat-d:1', resume: { limitAt: 1, resetsAt: 1 } });
  const calls = [];
  const done = await schedule.runOnce(idle, okSend(calls), exists, j => !j.resume);
  assert.deepStrictEqual(calls, []); assert.deepStrictEqual(done, []);
  assert.strictEqual(job.state, 'failed');
  await schedule.runOnce(idle, okSend(calls), exists, () => true);
  assert.deepStrictEqual(calls, []);
});

test('a due resume job that is still needed sends "continue" once; a failed send is not retried', async () => {
  const { job } = schedule.add('claude-chat-s', Date.now() - 1000, [ar.PROMPT], { key: 'resume:claude-chat-s:1', resume: { limitAt: 1, resetsAt: 1 } });
  const calls = [];
  await schedule.runOnce(idle, okSend(calls), exists, () => true);
  assert.deepStrictEqual(calls, [['claude-chat-s', 'continue']]);
  assert.strictEqual(job.state, 'sent');
  const f = schedule.add('claude-chat-f', Date.now() - 1000, [ar.PROMPT], { key: 'resume:claude-chat-f:1', resume: { limitAt: 1, resetsAt: 1 } }).job;
  const tries = []; const bad = async () => { tries.push(1); return { ok: false, error: 'runner went away' }; };
  const done = await schedule.runOnce(idle, bad, exists, () => true);
  assert.ok(done.includes(f)); assert.strictEqual(f.state, 'failed');
  await schedule.runOnce(idle, bad, exists, () => true);
  assert.strictEqual(tries.length, 1);
});

test('without an allow check every job runs as before', async () => {
  const { job } = schedule.add('claude-old', Date.now() - 1000, ['one']);
  const calls = [];
  await schedule.runOnce(idle, okSend(calls), exists);
  assert.deepStrictEqual(calls, [['claude-old', 'one']]);
  schedule.remove(job.id);
});

test('a finished resume job is kept until a day after its time, so its key is not used again', async () => {
  const old = Date.now() - 2 * 86400e3;
  const k = schedule.add('claude-chat-r', Date.now() + 3 * 86400e3, [ar.PROMPT], { key: 'resume:claude-chat-r:1', resume: { limitAt: 1, resetsAt: 1 } }).job;
  Object.assign(k, { state: 'failed', error: 'cancelled', doneAt: old });
  const g = schedule.add('claude-chat-g', old, [ar.PROMPT], { key: 'resume:claude-chat-g:1', resume: { limitAt: 1, resetsAt: 1 } }).job;
  Object.assign(g, { state: 'failed', error: 'cancelled', doneAt: old });
  const p = schedule.add('claude-plain-old', old, ['x']).job;
  Object.assign(p, { state: 'failed', doneAt: old });
  await schedule.runOnce(idle, okSend([]), exists);
  const ids = schedule.all().map(j => j.id);
  assert.ok(ids.includes(k.id)); assert.ok(!ids.includes(g.id)); assert.ok(!ids.includes(p.id));
});

test('a chat whose turn fails on a rate limit goes to limit with the limit text; a terminal session still goes to error', () => {
  claude.all()['claude-chat-h'] = { tmux: 'claude-chat-h', mode: 'chat', account: 'personal', state: 'working', since: 1, lastEventAt: 0 };
  claude.all()['claude-term-h'] = { tmux: 'claude-term-h', account: 'personal', state: 'working', since: 1, lastEventAt: 0 };
  const seen = []; claude.onChange((ev, r, prev) => seen.push([r.tmux, prev.state, r.state]));
  const body = { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your session limit · resets 11:40am (Europe/Sarajevo)" };
  claude.onHook({ 'x-tmux-session': 'claude-chat-h', 'x-ts': String(NOW) }, body);
  claude.onHook({ 'x-tmux-session': 'claude-term-h', 'x-ts': String(NOW) }, body);
  const c = claude.get('claude-chat-h');
  assert.deepStrictEqual([c.state, c.since, c.lastMessage], ['limit', NOW, body.last_assistant_message]);
  assert.deepStrictEqual([claude.get('claude-term-h').state, claude.get('claude-term-h').lastMessage], ['error', 'rate_limit']);
  assert.deepStrictEqual(seen, [['claude-chat-h', 'working', 'limit'], ['claude-term-h', 'working', 'error']]);
  claude.onHook({ 'x-tmux-session': 'claude-chat-h', 'x-ts': String(NOW + 1) }, { hook_event_name: 'StopFailure', error: 'server_error' });
  assert.strictEqual(claude.get('claude-chat-h').state, 'error');
});

test('send now refuses a resume job and still takes a plain one out of the queue', () => {
  const r = schedule.add('claude-chat-n', Date.now() + H, [ar.PROMPT], { key: 'resume:claude-chat-n:1', resume: { limitAt: 1, resetsAt: 1 } }).job;
  const t = schedule.take(r.id);
  assert.deepStrictEqual([t.ok, t.status], [false, 409]);
  assert.strictEqual(r.state, 'waiting');
  const p = schedule.add('claude-plain-n', Date.now() + H, ['hi']).job;
  const u = schedule.take(p.id);
  assert.ok(u.ok); assert.strictEqual(u.job, p); assert.ok(!schedule.all().includes(p));
  assert.deepStrictEqual(schedule.take('nope'), { ok: false, status: 404, error: 'gone' });
});

test('cancelling a resume job that is already being sent changes nothing and says so', () => {
  const j = schedule.add('claude-chat-m', Date.now() - 1000, [ar.PROMPT], { key: 'resume:claude-chat-m:1', resume: { limitAt: 1, resetsAt: 1 } }).job;
  Object.assign(j, { state: 'sent', idx: 1, lastSentAt: Date.now() });
  assert.deepStrictEqual(schedule.remove(j.id), { ok: false, error: 'already sent' });
  assert.strictEqual(j.state, 'sent');
});

test('a handoff cancels only the waiting resume jobs of that session', () => {
  const opts = n => ({ key: `resume:${n}:7`, resume: { limitAt: 1, resetsAt: 7 } });
  const a = schedule.add('claude-chat-x', Date.now() + H, [ar.PROMPT], opts('claude-chat-x')).job;
  const b = schedule.add('claude-chat-y', Date.now() + H, [ar.PROMPT], opts('claude-chat-y')).job;
  const c = schedule.add('claude-chat-x', Date.now() + H, ['plain']).job;
  assert.strictEqual(schedule.cancelResume('claude-chat-x'), 1);
  assert.deepStrictEqual([a.state, a.error, b.state, c.state], ['failed', 'cancelled', 'waiting', 'waiting']);
  assert.ok(schedule.cancelResume() >= 1);
  assert.ok(!schedule.all().some(j => j.resume && j.state === 'waiting'));
  assert.strictEqual(b.state, 'failed');
  schedule.remove(c.id);
});
