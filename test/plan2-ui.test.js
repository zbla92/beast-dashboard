const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-plan2.js'), 'utf8');
const boot = (extra = {}) => {
  const FEAT = {};
  vm.runInNewContext(src, {
    FEAT, S: { settings: { plans: true }, runtime: { sessions: [] } }, TERM: { open: false },
    localStorage: { getItem: () => null, setItem() {} },
    document: { addEventListener() {}, getElementById: () => null },
    addEventListener() {}, setInterval() {}, matchMedia: () => ({ matches: false }), $: () => null,
    ...extra,
  });
  return FEAT.plan2;
};
const plan2 = boot();

test('planFor maps a tmux session to its active plan and ignores archived ones', () => {
  const sums = [
    { id: 'a/old', archived: '2026-11-01', sessions: ['claude-x'] },
    { id: 'a/new', archived: null, sessions: ['claude-x', 'claude-y'] },
  ];
  assert.strictEqual(plan2.planFor(sums, 'claude-x').id, 'a/new');
  assert.strictEqual(plan2.planFor(sums, 'claude-z'), null);
});

const ev = (type, o = {}) => ({ ts: '2026-11-03T10:00:00.000Z', type, ...o });
const phases = [
  { n: 1, name: 'A', tasks: [{ id: 'T1' }, { id: 'T2' }] },
  { n: 2, name: 'B', tasks: [{ id: 'T3' }] },
];

test('bucketEvents puts task events on their task and phase events on the phase', () => {
  const b = plan2.bucketEvents([
    ev('create', { text: 'x' }), ev('start', { task: 'T1' }), ev('done', { task: 'T1' }),
    ev('phase', { phase: 1, text: 'A' }), ev('note', { task: 'T2', text: 'n' }),
  ], phases);
  assert.strictEqual(b.created.text, 'x');
  assert.deepStrictEqual([...b.task.T1.map(e => e.type)], ['start', 'done']);
  assert.deepStrictEqual([...b.task.T2.map(e => e.type)], ['note']);
  assert.deepStrictEqual([...b.phase[1].map(e => e.type)], ['phase']);
});

test('bucketEvents places a task-less note under the task being worked on, else under the phase', () => {
  const b = plan2.bucketEvents([
    ev('note', { text: 'early' }), ev('start', { task: 'T3' }), ev('note', { text: 'mid' }),
    ev('done', { task: 'T3' }), ev('note', { text: 'late' }),
  ], phases);
  assert.deepStrictEqual([...b.phase[1].map(e => e.text)], ['early']);
  assert.deepStrictEqual([...b.task.T3.map(e => e.text || e.type)], ['start', 'mid', 'done']);
  assert.deepStrictEqual([...b.phase[2].map(e => e.text)], ['late']);
});

test('bucketEvents keeps ask and answer under the task in progress when the question was asked', () => {
  const b = plan2.bucketEvents([
    ev('start', { task: 'T1' }), ev('ask', { q: 'q1', text: 'why' }), ev('start', { task: 'T2' }), ev('answer', { q: 'q1', text: 'because' }),
  ], phases);
  assert.deepStrictEqual([...b.task.T1.map(e => e.type)], ['start', 'ask', 'answer']);
  assert.deepStrictEqual([...b.task.T2.map(e => e.type)], ['start']);
  const c = plan2.bucketEvents([ev('ask', { q: 'q2', text: 'w' }), ev('start', { task: 'T3' }), ev('answer', { q: 'q2' })], phases);
  assert.deepStrictEqual([...c.phase[1].map(e => e.type)], ['ask']);
  assert.deepStrictEqual([...c.task.T3.map(e => e.type)], ['start', 'answer']);
});

test('bucketEvents files events of a task missing from the plan under the last phase', () => {
  const b = plan2.bucketEvents([ev('start', { task: 'T3' }), ev('done', { task: 'T3' }), ev('start', { task: 'T9' }), ev('note', { text: 'x' })], phases);
  assert.deepStrictEqual([...b.phase[2].map(e => e.type)], ['start', 'note']);
  assert.strictEqual(b.task.T9, undefined);
});

test('ringMarkup clamps the arc between empty and full', () => {
  const circ = 2 * Math.PI * 11;
  assert.match(plan2.ringMarkup(0, 26), /stroke-dasharray="0\.0 /);
  assert.ok(plan2.ringMarkup(250, 26).includes(`stroke-dasharray="${circ.toFixed(1)} ${circ.toFixed(1)}"`));
  assert.ok(plan2.ringMarkup(50, 26).includes(`stroke-dasharray="${(circ / 2).toFixed(1)} `));
});

test('readOpen accepts only a plain object from localStorage', () => {
  const read = raw => boot({ localStorage: { getItem: () => raw, setItem() {} } }).readOpen();
  assert.deepStrictEqual({ ...read('{"claude-x":false}') }, { 'claude-x': false });
  for (const bad of ['5', '[1,2]', 'null', '"s"', '{oops']) assert.deepStrictEqual({ ...read(bad) }, {}, bad);
});

test('a load requested while one is in flight runs again afterwards', async () => {
  const gates = [];
  let calls = 0;
  const S = { settings: { plans: true }, runtime: { sessions: [] } };
  const api = () => { calls++; return new Promise(res => gates.push(res)); };
  const p = boot({ S, api });
  p.onState();
  assert.strictEqual(calls, 1);
  S.runtime.sessions = [{ name: 'claude-new', cwd: '/x' }];
  p.onState();
  p.onState();
  assert.strictEqual(calls, 1);
  gates[0]({ plans: [] });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(calls, 2);
  gates[1]({ plans: [] });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(calls, 2);
});

test('a new session name or cwd triggers a reload, an unchanged list does not', async () => {
  let calls = 0;
  const S = { settings: { plans: true }, runtime: { sessions: [{ name: 'a', cwd: '/r' }] } };
  const p = boot({ S, api: async () => { calls++; return { plans: [] }; } });
  p.onState();
  await new Promise(r => setImmediate(r));
  p.onState();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(calls, 1);
  S.runtime.sessions = [{ name: 'a', cwd: '/other' }];
  p.onState();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(calls, 2);
});

const projects = [
  { id: 'api', name: 'storefront-api', org: 'acme' },
  { id: 'web', name: 'storefront-web', org: 'acme' },
  { id: 'solo', name: 'solo', org: '' },
  { id: 'other', name: 'other', org: 'zed' },
];
const mk = (id, projectId, extra = {}) => ({ id, topic: id.split('/')[1], projectId, archived: null, sessions: [], ...extra });

test('orgPlans lists the own plan first, then the other active plans of the same org by topic', () => {
  const own = mk('web/checkout', 'web');
  const sums = [mk('api/zeta', 'api'), own, mk('api/alpha', 'api'), mk('api/old', 'api', { archived: '2026-11-01' }), mk('other/x', 'other'), mk('solo/s', 'solo')];
  assert.deepStrictEqual([...plan2.orgPlans(sums, projects, own, 'web').map(p => p.id)], ['web/checkout', 'api/alpha', 'api/zeta']);
});

test('orgPlans without an own plan uses the session project org, and groups project-less plans by repo dir', () => {
  const sums = [mk('api/a', 'api'), mk('web/b', 'web'), mk('other/x', 'other')];
  assert.deepStrictEqual([...plan2.orgPlans(sums, projects, null, 'web').map(p => p.id)], ['api/a', 'web/b']);
  assert.strictEqual(plan2.orgPlans(sums, projects, null, 'nope').length, 0);
  const loose = [mk('dir/a', null), mk('dir/b', null), mk('else/c', null)];
  assert.deepStrictEqual([...plan2.orgPlans(loose, projects, loose[0], undefined).map(p => p.id)], ['dir/a', 'dir/b']);
  const solo = [mk('solo/s', 'solo'), mk('solo/t', 'solo'), mk('api/a', 'api')];
  assert.deepStrictEqual([...plan2.orgPlans(solo, projects, solo[0], 'solo').map(p => p.id)], ['solo/s', 'solo/t']);
});

test('planNames uses the topic, or the project name when topics clash', () => {
  const list = [mk('api/auth', 'api'), mk('web/auth', 'web'), mk('web/ui', 'web')];
  assert.deepStrictEqual([...plan2.planNames(list, projects)], ['storefront-api', 'storefront-web', 'ui']);
});

const W = { id: 'q3', q: 'Pin the SDK to v14 or v15?', blocks: ['T9'] };

test('answerMsg builds the one-line message of the contract', () => {
  assert.strictEqual(plan2.answerMsg('checkout-v2', W, 'Pin v14 for now.'),
    'Plan checkout-v2, answer to q3 ("Pin the SDK to v14 or v15?"): Pin v14 for now. — record it with plan answer q3 "<this answer>" --plan checkout-v2, then carry on with the plan.');
});

test('answerMsg collapses every whitespace run, newlines included, and trims', () => {
  const m = plan2.answerMsg('t', { id: 'q1', q: '  Two\n lines?  ' }, '  first line\n\n  second\tline  ');
  assert.strictEqual(m, 'Plan t, answer to q1 ("Two lines?"): first line second line — record it with plan answer q1 "<this answer>" --plan t, then carry on with the plan.');
  assert.ok(!/[\r\n\t]/.test(m));
});

test('answerMsg clips the question to 160 chars with an ellipsis', () => {
  const m = plan2.answerMsg('t', { id: 'q1', q: 'x'.repeat(200) }, 'ok');
  assert.ok(m.includes(`("${'x'.repeat(159)}…")`));
  assert.ok(plan2.answerMsg('t', { id: 'q1', q: 'y'.repeat(160) }, 'ok').includes(`("${'y'.repeat(160)}")`));
});

test('answerMsg refuses an empty or too long answer after collapsing', () => {
  assert.strictEqual(plan2.answerMsg('t', W, ''), null);
  assert.strictEqual(plan2.answerMsg('t', W, ' \n\t '), null);
  assert.strictEqual(plan2.answerMsg('t', W, null), null);
  assert.ok(plan2.answerMsg('t', W, 'a'.repeat(2000)));
  assert.strictEqual(plan2.answerMsg('t', W, 'a'.repeat(2001)), null);
  assert.ok(plan2.answerMsg('t', W, 'a'.repeat(1000) + '\n\n\n' + 'b'.repeat(999)));
});

const fakeDom = () => {
  const listeners = [];
  const body = [];
  const node = (tag, attrs, kids) => {
    const n = { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k != null && k !== false), classList: { toggle() {} } };
    n.remove = () => { const i = body.indexOf(n); if (i >= 0) body.splice(i, 1); };
    n.append = (...k) => n.kids.push(...k);
    n.replaceChildren = (...k) => { n.kids = k.flat(Infinity).filter(x => x != null && x !== false); };
    return n;
  };
  const text = n => n == null ? '' : typeof n === 'object' ? n.kids.map(text).join('') : String(n);
  const document = {
    addEventListener(type, fn, cap) { listeners.push({ type, fn, cap }); },
    removeEventListener(type, fn, cap) { const i = listeners.findIndex(l => l.type === type && l.fn === fn && l.cap === cap); if (i >= 0) listeners.splice(i, 1); },
    getElementById: () => null,
    body: { append: (...k) => body.push(...k) },
  };
  const key = k => { const ev = { key: k, preventDefault() {}, stopPropagation() {} }; for (const l of listeners.filter(x => x.type === 'keydown')) l.fn(ev); };
  return { document, body, listeners, key, text, h: (tag, attrs, ...kids) => node(tag, attrs, kids), ico: () => null };
};

test('sheet keeps one open at a time and closes on Escape, once', () => {
  const dom = fakeDom();
  const p = boot({ document: dom.document, h: dom.h, ico: dom.ico });
  const closed = [];
  const close1 = p.sheet({ title: 'A', body: 'a', onClose: () => closed.push('A') });
  assert.strictEqual(dom.body.length, 2);
  p.sheet({ title: 'B', body: 'b', onClose: () => closed.push('B') });
  assert.deepStrictEqual(closed, ['A']);
  assert.strictEqual(dom.body.length, 2);
  close1();
  assert.deepStrictEqual(closed, ['A']);
  dom.key('Escape');
  assert.deepStrictEqual(closed, ['A', 'B']);
  assert.strictEqual(dom.body.length, 0);
  assert.strictEqual(dom.listeners.filter(l => l.type === 'keydown').length, 0);
});

test('the panel shows one quiet questions row with the count and what the questions block', () => {
  const dom = fakeDom();
  const p = boot({ document: dom.document, h: dom.h, ico: dom.ico });
  const row = p.questionsRow({ id: 'a/b', waiting: [{ id: 'q1', q: 'x', blocks: ['T9'] }, { id: 'q2', q: 'y', blocks: ['T9', 'T10'] }, { id: 'q3', q: 'z', blocks: [] }] });
  assert.strictEqual(row.attrs.class, 'fp2-qrow');
  assert.strictEqual(dom.text(row), '3 open questionsblocks T9 · T10');
  assert.strictEqual(dom.text(p.questionsRow({ id: 'a/b', waiting: [{ id: 'q1', q: 'x', blocks: [] }] })), '1 open question');
});

const sendBoot = (sessions, active, extra = {}) => {
  const calls = { api: [], toast: [] };
  const p = boot({
    S: { settings: { plans: true }, runtime: { sessions } }, TERM: { open: false, active },
    claudeOf: name => (sessions.find(s => s.name === name) || {}).claude || null,
    sessTitle: s => 'L:' + s.name,
    api: async (path, body) => { calls.api.push([path, body]); if (extra.fail) throw new Error(extra.fail); return { ok: true }; },
    toast: (msg, kind) => calls.toast.push([msg, kind]),
  });
  return { p, calls };
};
const sess = (name, claude) => ({ name, claude });

test('sendToSession sends to the active session when it runs the plan, else to the first plan session', async () => {
  const sessions = [sess('claude-a', { state: 'idle' }), sess('claude-b', { state: 'working' })];
  const one = sendBoot(sessions, 'claude-b');
  assert.strictEqual(await one.p.sendToSession({ sessions: ['claude-a', 'claude-b'] }, 'hi'), true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(one.calls.api)), [['send', { session: 'claude-b', text: 'hi' }]]);
  assert.deepStrictEqual(one.calls.toast, [['Sent to L:claude-b', 'ok']]);
  const two = sendBoot(sessions, 'claude-x');
  await two.p.sendToSession({ sessions: ['claude-a', 'claude-b'] }, 'hi');
  assert.strictEqual(two.calls.api[0][1].session, 'claude-a');
});

test('sendToSession refuses with a toast when nothing live runs the plan, at a permission prompt, or with a typed draft', async () => {
  const cases = [
    [[], { sessions: [] }, 'No live session runs this plan'],
    [[sess('claude-a', { state: 'ended' })], { sessions: ['claude-a'] }, 'No live session runs this plan'],
    [[sess('claude-a', null)], { sessions: ['claude-a'] }, 'No live session runs this plan'],
    [[sess('claude-a', { state: 'permission' })], { sessions: ['claude-a'] }, 'Claude is at a permission prompt — answer it first'],
    [[sess('claude-a', { state: 'idle', draft: 'half typed' })], { sessions: ['claude-a'] }, 'Something is typed in the terminal — send or clear it first'],
  ];
  for (const [sessions, plan, msg] of cases) {
    const { p, calls } = sendBoot(sessions, 'claude-a');
    assert.strictEqual(await p.sendToSession(plan, 'hi'), false, msg);
    assert.deepStrictEqual(calls.api, []);
    assert.deepStrictEqual(calls.toast, [[msg, 'err']]);
  }
  const chat = sendBoot([sess('claude-c', { state: 'idle', mode: 'chat', draft: 'x' })], 'claude-c');
  assert.strictEqual(await chat.p.sendToSession({ sessions: ['claude-c'] }, 'hi'), true);
});

test('sendToSession and saveAnswer toast the server error and report failure', async () => {
  const { p, calls } = sendBoot([sess('claude-a', { state: 'idle' })], 'claude-a', { fail: 'busy' });
  assert.strictEqual(await p.sendToSession({ sessions: ['claude-a'] }, 'hi'), false);
  assert.strictEqual(await p.saveAnswer('a/b', 'q1', 'yes'), false);
  assert.deepStrictEqual(calls.toast, [['busy', 'err'], ['busy', 'err']]);
});

test('saveAnswer posts to plan-answer and reloads the plans', async () => {
  const { p, calls } = sendBoot([], null);
  assert.strictEqual(await p.saveAnswer('demo-app/search-v2', 'q1', 'copy them'), true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.api[0])), ['plan-answer', { id: 'demo-app/search-v2', q: 'q1', text: 'copy them' }]);
  assert.deepStrictEqual(calls.api[1], ['plans?v=2', undefined]);
});
