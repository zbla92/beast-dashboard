const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-plan2.js'), 'utf8');
const boot = (extra = {}) => {
  const FEAT = extra.FEAT || {};
  vm.runInNewContext(src, {
    FEAT, ICONS: {}, S: { settings: { plans: true }, runtime: { sessions: [] } }, TERM: { open: false },
    localStorage: { getItem: () => null, setItem() {} },
    document: { addEventListener() {}, getElementById: () => null },
    addEventListener() {}, setInterval() {}, matchMedia: () => ({ matches: false }), $: () => null, renderTermPanel() {},
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
const mk = (id, projectId, extra = {}) => ({ id, topic: id.split('/')[1], projectId, archived: null, sessions: [], offered: [], ...extra });

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
    n.listeners = {};
    n.addEventListener = (type, fn) => { n.listeners[type] = fn; };
    n.replaceChildren = (...k) => { if (k.some(x => x == null || x === false || Array.isArray(x))) throw new Error('replaceChildren would print this as text'); n.kids = k; };
    n.querySelector = () => null;
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

const detail = {
  topic: 'checkout',
  phases: [
    { n: 1, name: 'Shell and connect with a very long phase title that gets cut off', done: 1, total: 2, tasks: [
      { id: 'T1', title: 'Build the shell', status: 'done', model: 'Opus', body: 'Card one', by: [], gate: { ok: true, text: 'npm test all green' } },
      { id: 'T2', title: 'Wire the stepper to the router', status: 'blocked', model: 'Sonnet', body: '', by: ['q1'], gate: null },
    ] },
    { n: 2, name: 'Polish', done: 0, total: 0, tasks: [] },
  ],
  timeline: [
    ev('start', { task: 'T1' }), ev('done', { task: 'T1', gate: { ok: true, text: 'npm test all green' } }),
    ev('ask', { q: 'q1', task: 'T2', text: 'Pin the SDK to v14 or v15 for the checkout flow?' }),
    ev('note', { text: 'phase level note' }),
  ],
};
const detailBoot = () => {
  const dom = fakeDom();
  return { dom, p: boot({ document: dom.document, h: dom.h, ico: dom.ico }) };
};
const find = (n, pred, out = []) => {
  if (n && typeof n === 'object') { if (pred(n)) out.push(n); for (const k of n.kids) find(k, pred, out); }
  return out;
};
const navStub = () => { const calls = []; return { calls, nav: { task: id => calls.push('task ' + id), phase: n => calls.push('phase ' + n) } }; };

test('phaseSheet shows the full title, every task with status and what it waits on, and the phase log in full', () => {
  const { dom, p } = detailBoot();
  const { calls, nav } = navStub();
  const s = p.phaseSheet({ topic: 'checkout' }, detail, 1, nav);
  const t = dom.text(s.body);
  assert.strictEqual(s.title, 'Phase 1');
  assert.ok(t.includes('Shell and connect with a very long phase title that gets cut off'));
  assert.ok(t.includes('Build the shell') && t.includes('Wire the stepper to the router'));
  assert.ok(t.includes('waits on q1'));
  assert.ok(t.includes('1/2 tasks done'));
  assert.ok(t.includes('phase level note') || t.includes('Pin the SDK'));
  const rows = find(s.body, n => n.tag === 'button' && n.attrs.class === 'fp2-dtr');
  assert.strictEqual(rows.length, 2);
  rows[1].attrs.onclick();
  assert.deepStrictEqual(calls, ['task T2']);
  assert.strictEqual(p.phaseSheet({ topic: 'checkout' }, detail, 9, nav), null);
});

test('taskSheet shows title, model, phase, gate with time, its log and the card body', () => {
  const { dom, p } = detailBoot();
  const { calls, nav } = navStub();
  const s = p.taskSheet({ topic: 'checkout' }, detail, 'T1', nav);
  const t = dom.text(s.body);
  assert.strictEqual(s.title, 'Task T1');
  for (const part of ['Build the shell', 'Opus', 'done', 'P1 Shell and connect', '✓ npm test all green', 'started', 'Card one']) assert.ok(t.includes(part), part);
  assert.ok(find(s.body, n => n.attrs.class === 'fp2-dgate ok').length === 1);
  find(s.body, n => n.attrs.class === 'fp2-dlink')[0].attrs.onclick();
  assert.deepStrictEqual(calls, ['phase 1']);
  const w = dom.text(p.taskSheet({ topic: 'checkout' }, detail, 'T2', nav).body);
  assert.ok(w.includes('waits on q1') && w.includes('Pin the SDK to v14 or v15 for the checkout flow?') && w.includes('No task card.'));
  assert.strictEqual(p.taskSheet({ topic: 'checkout' }, detail, 'T9', nav), null);
});

test('the plan head lets the phase name shrink and the panel lines are real buttons', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-plan2.css'), 'utf8');
  assert.ok(!/\.fp2-head \.dim\s*\{/.test(css));
  const rule = /\.fp2-phase \{([^}]*)\}/.exec(css)[1];
  for (const part of ['min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap']) assert.ok(rule.includes(part), part);
  for (const sel of ['fp2-ev', 'fp2-pn', 'fp2-task-t', 'fp2-gate']) assert.ok(src.includes(`h('button', { class: '${sel}`) || src.includes(`h('button', { class: 'fp2-gate`), sel);
});

const UPDATE_BASE = t => `Update the plan ${t} with the plan CLI: plan show --plan ${t}, edit plan.md at the path from plan path --plan ${t}, status changes only through plan start|done|fail|ask|answer|next|note. Do not change frozen contracts without asking me.`;
const MAKE_BASE = 'Make a plan for this session with the plan CLI (plan new <topic> --title "<title>", then phases and task cards as in plan help, contracts first). Show me the plan and wait for my go before starting work.';

test('updateMsg and makeMsg build the exact one-line messages, with or without a note', () => {
  assert.strictEqual(plan2.updateMsg('checkout-v2', ''), UPDATE_BASE('checkout-v2'));
  assert.strictEqual(plan2.updateMsg('checkout-v2', ' \n\t '), UPDATE_BASE('checkout-v2'));
  assert.strictEqual(plan2.updateMsg('checkout-v2', '  drop\n\nT4,   add  a task\t'), UPDATE_BASE('checkout-v2') + ' Note: drop T4, add a task');
  assert.strictEqual(plan2.makeMsg(''), MAKE_BASE);
  assert.strictEqual(plan2.makeMsg('  rate\nlimits '), MAKE_BASE + ' Note: rate limits');
  assert.ok(!/\n/.test(plan2.makeMsg('a\nb')));
});

test('updateMsg and makeMsg refuse a note over 2000 characters after collapsing', () => {
  assert.strictEqual(plan2.updateMsg('t', 'a'.repeat(2001)), null);
  assert.strictEqual(plan2.makeMsg('a'.repeat(2001)), null);
  assert.ok(plan2.makeMsg('a'.repeat(1000) + '\n\n\n' + 'b'.repeat(999)));
  assert.ok(plan2.updateMsg('t', 'a'.repeat(2000)));
});

const noteBoot = (sessions, active) => {
  const dom = fakeDom();
  const calls = { api: [] };
  const p = boot({
    document: dom.document, h: dom.h, ico: dom.ico, requestAnimationFrame() {},
    S: { settings: { plans: true }, runtime: { sessions } }, TERM: { open: false, active },
    claudeOf: name => (sessions.find(s => s.name === name) || {}).claude || null,
    sessTitle: s => 'L:' + s.name, toast() {},
    api: async (path, body) => { calls.api.push([path, JSON.parse(JSON.stringify(body))]); return { ok: true }; },
  });
  return { dom, p, calls };
};

test('Make a plan sheet previews exactly what is sent and sends it to the active session', async () => {
  const { dom, p, calls } = noteBoot([sess('claude-a', { state: 'idle' })], 'claude-a');
  p.openMake('claude-a');
  const body = dom.body[1];
  const ta = find(body, n => n.tag === 'textarea')[0];
  const pv = () => dom.text(find(body, n => n.attrs.class === 'fp2-sh-pv')[0]);
  const send = find(body, n => n.attrs.class && n.attrs.class.includes('fp2-sh-go'))[0];
  assert.ok(pv().endsWith(p.makeMsg('')));
  assert.strictEqual(send.disabled, false);
  ta.value = 'rate\nlimits';
  ta.listeners.input();
  assert.ok(pv().endsWith(p.makeMsg('rate limits')));
  await send.onclick();
  assert.deepStrictEqual(calls.api, [['send', { session: 'claude-a', text: MAKE_BASE + ' Note: rate limits' }]]);
  assert.strictEqual(dom.body.length, 0);
});

test('Make a plan sheet blocks Send over the limit and keeps the sheet when the send is refused', async () => {
  const { dom, p, calls } = noteBoot([sess('claude-a', { state: 'permission' })], 'claude-a');
  p.openMake('claude-a');
  const body = dom.body[1];
  const ta = find(body, n => n.tag === 'textarea')[0];
  const send = find(body, n => n.attrs.class && n.attrs.class.includes('fp2-sh-go'))[0];
  ta.value = 'x'.repeat(2001);
  ta.listeners.input();
  assert.strictEqual(send.disabled, true);
  assert.ok(dom.text(find(body, n => n.attrs.class === 'fp2-sh-pv')[0]).includes('Too long: 2001 of 2000'));
  ta.value = 'ok';
  ta.listeners.input();
  await send.onclick();
  assert.deepStrictEqual(calls.api, []);
  assert.strictEqual(dom.body.length, 2);
});

test('the Options menu offers Make a plan for a live Claude session and keeps the org count', async () => {
  const alone = await lifeBoot({ sums: [] });
  assert.deepStrictEqual(optItems(alone).map(i => i.label), ['Make a plan…', 'Archived plans…']);
  const org = await lifeBoot({ sums: [plan('web/a', 'web'), plan('web/b', 'web')] });
  assert.ok(optItem(org, '2 in acme').label);
  const ended = await lifeBoot({ sums: [], claude: { state: 'ended' } });
  const make = optItem(ended, 'Make a plan');
  assert.strictEqual(make.disabled, true);
  assert.strictEqual(make.sub, 'No live session runs this plan');
});

const FIN_AT = '2026-10-04T11:52:00.000Z';
const plan = (id, projectId, extra = {}) => ({
  id, topic: id.split('/').pop(), title: id, projectId, archived: null, sessions: [], offered: [], waiting: [], done: 1, total: 2, pct: 50, complete: false,
  phase: null, lastGate: null, now: null, next: null, mtime: 1, finished: false, finishedAt: null, ...extra,
});
const finishedPlan = (id, projectId, extra = {}) => plan(id, projectId, { done: 2, pct: 100, complete: true, finished: true, finishedAt: FIN_AT, ...extra });
const tick = () => Array.from({ length: 6 }).reduce(wait => wait.then(() => new Promise(r => setImmediate(r))), Promise.resolve());

const lifeBoot = async ({ sums, archived = [], files = false, stored = null, phone = false, active = 'claude-a', project = 'web', fail = null, failList = null, post = null, claude = { state: 'idle' }, detail = { phases: [], timeline: [], waiting: [], mtime: 1 } }) => {
  const dom = fakeDom();
  const reg = {};
  const h = (tag, attrs, ...kids) => {
    const n = dom.h(tag, attrs, ...kids);
    if (attrs && attrs.id) {
      reg[attrs.id] = n;
      const drop = n.remove;
      n.remove = () => { drop(); delete reg[attrs.id]; };
    }
    return n;
  };
  dom.document.getElementById = id => reg[id] || null;
  const main = { style: { setProperty() {} }, classList: { toggle() {}, remove() {} }, append() {}, prepend() {} };
  const calls = { api: [], toast: [], feat: [], saved: [] };
  const store = { sums, archived };
  const filesState = { on: files };
  const S = { settings: { plans: true }, projects, runtime: { sessions: [{ name: active, project, claude }] } };
  const TERM = { open: true, active };
  const p = boot({
    document: dom.document, h, ico: dom.ico, requestAnimationFrame() {}, S,
    FEAT: { code: { filesOn: () => filesState.on } },
    feat: (hook, ...a) => { calls.feat.push([hook, ...a]); return []; },
    localStorage: { getItem: () => stored, setItem: (k, v) => calls.saved.push(JSON.parse(v)) },
    TERM, matchMedia: () => ({ matches: phone }),
    window: { dispatchEvent() {} }, Event: class {}, setTimeout, clearTimeout,
    $: sel => sel === '.termmain' ? main : { after() {} },
    claudeOf: name => (S.runtime.sessions.find(x => x.name === name) || {}).claude || null,
    sessTitle: x => x.name, toast: (msg, kind) => calls.toast.push([msg, kind]),
    api: async (path, body) => {
      calls.api.push(body ? [path, JSON.parse(JSON.stringify(body))] : [path]);
      if (path === 'plans?v=2') return { plans: store.sums };
      if (path === 'plans?v=2&archived=1') {
        if (failList) throw new Error(failList);
        return { plans: [...store.sums, ...store.archived] };
      }
      if (path.startsWith('plan/')) return detail;
      if (fail) throw new Error(fail);
      return post(store, path, body);
    },
  });
  p.onState();
  await tick();
  const panel = () => reg['fp2-panel'] || null;
  const byClass = cls => find(panel(), n => n.attrs.class && n.attrs.class.split(' ').includes(cls));
  const button = label => find(panel(), n => n.tag === 'button' && dom.text(n).includes(label));
  const topic = () => dom.text(byClass('fp2-ptopic')[0]) || byClass('fp2-ptopic')[0].textContent;
  const paths = () => calls.api.map(c => c[0]);
  const openActions = () => byClass('fp2-act-b')[0].attrs.onclick();
  const menuItems = () => find(panel(), n => n.attrs.role === 'menuitem');
  const dialog = () => dom.body.find(n => n.attrs.role === 'dialog') || null;
  const dialogButton = label => find(dialog(), n => n.tag === 'button' && dom.text(n) === label)[0];
  const scrim = () => dom.body.find(n => n.attrs.class === 'fp2-sh-scrim');
  const openList = () => byClass('fp2-pname')[0].attrs.onclick();
  const listRow = label => byClass('fp2-it-b').find(n => dom.text(n).includes(label));
  const pressArchived = () => byClass('fp2-lk')[0].attrs.onclick();
  const footButton = () => find(byClass('fp2-foot')[0], n => n.tag === 'button')[0];
  const closeBtn = () => byClass('fp2-x').find(n => n.attrs['aria-label'] === 'close plan');
  const panelText = () => dom.text(panel());
  return { dom, p, S, TERM, filesState, calls, store, panel, byClass, button, topic, paths, openActions, menuItems, reg, dialog, dialogButton, scrim, openList, listRow, pressArchived, footButton, closeBtn, panelText };
};

const optItems = t => [].concat(t.p.sessMenu(t.TERM.active, {}, t.S.runtime.sessions[0].claude) || []);
const optItem = (t, label) => optItems(t).find(i => i.label.startsWith(label));
const planBtn = t => t.p.termBar(t.TERM.active);
const planBtnText = t => t.dom.text(planBtn(t));
const clockOf = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const dateOf = ts => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });

test('the actions menu has New plan, Leave this plan and Complete anyway, nothing else', async () => {
  const t = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'], done: 3, total: 7 })] });
  t.openActions();
  assert.deepStrictEqual(t.menuItems().map(n => t.dom.text(n)), ['New plan…Ask Claude to make a plan', 'Leave this planThis chat stops working on it; the plan stays', 'Complete anyway4 steps still open']);
  assert.deepStrictEqual(t.byClass('fp2-actm')[0].kids.map(k => k.attrs.class), ['mi', 'mi', 'sep', 'mi']);
});

test('Complete anyway says one step in the singular and is gone with nothing open', async () => {
  const one = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'], done: 1, total: 2 })] });
  one.openActions();
  assert.strictEqual(one.dom.text(one.menuItems()[2]), 'Complete anyway1 step still open');
  const done = await lifeBoot({ sums: [finishedPlan('web/one', 'web', { sessions: ['claude-a'] })] });
  done.openActions();
  assert.deepStrictEqual(done.menuItems().map(n => done.dom.text(n)), ['New plan…Ask Claude to make a plan', 'Leave this planThis chat stops working on it; the plan stays']);
  assert.deepStrictEqual(done.byClass('fp2-actm')[0].kids.map(k => k.attrs.class), ['mi', 'mi']);
});

test('a finished plan shows a green bar and All done, without a badge or a finished footer', async () => {
  const t = await lifeBoot({ sums: [finishedPlan('web/one', 'web', { sessions: ['claude-a'] })] });
  assert.strictEqual(t.byClass('fp2-bar')[0].attrs.class, 'fp2-bar full');
  assert.strictEqual(t.dom.text(t.byClass('fp2-pstate')[0]), 'All done');
  assert.strictEqual(t.byClass('fp2-badge-h').length, 0);
  assert.strictEqual(t.byClass('fp2-fin').length, 0);
  assert.ok(!t.panelText().includes('Finished'));
  assert.ok(!t.byClass('fp2-chip').length);
  const complete = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'], done: 2, total: 2, pct: 100, complete: true })] });
  assert.strictEqual(complete.byClass('fp2-bar')[0].attrs.class, 'fp2-bar full');
  assert.strictEqual(complete.dom.text(complete.byClass('fp2-pstate')[0]), 'All done');
});

test('an open plan shows its steps and phase, and no All done', async () => {
  const t = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'], done: 3, total: 7, pct: 43, phase: { n: 2, of: 4, name: 'Build' } })] });
  assert.strictEqual(t.byClass('fp2-bar')[0].attrs.class, 'fp2-bar');
  assert.strictEqual(t.dom.text(t.byClass('fp2-pmeta')[0]), '3/7 stepsPhase 2 of 4');
  assert.strictEqual(t.byClass('fp2-pstate').length, 0);
});

test('the bottom button is grey with the open steps under it, and green once every step is done', async () => {
  const many = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'], done: 3, total: 7 })] });
  assert.strictEqual(many.footButton().attrs.disabled, true);
  assert.ok(many.footButton().attrs.class.includes('off'));
  assert.strictEqual(many.dom.text(many.footButton()), 'Complete plan');
  assert.strictEqual(many.dom.text(many.byClass('fp2-fnote')[0]), '4 steps still open');
  const one = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'], done: 1, total: 2 })] });
  assert.strictEqual(one.dom.text(one.byClass('fp2-fnote')[0]), '1 step still open');
  const done = await lifeBoot({ sums: [finishedPlan('web/one', 'web', { sessions: ['claude-a'] })] });
  assert.ok(!done.footButton().attrs.disabled);
  assert.ok(done.footButton().attrs.class.includes('grn'));
  assert.strictEqual(done.dom.text(done.footButton()), '✓ Complete plan');
  assert.strictEqual(done.byClass('fp2-fnote').length, 0);
  const early = await lifeBoot({ sums: [finishedPlan('web/one', 'web', { sessions: ['claude-a'], done: 1, total: 2, pct: 50, complete: false })] });
  assert.ok(early.footButton().attrs.class.includes('grn'));
  assert.strictEqual(early.byClass('fp2-fnote').length, 0);
  const empty = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'], done: 0, total: 0, pct: 0 })] });
  assert.ok(empty.footButton().attrs.class.includes('grn'));
});

const archivePost = (store, path, body) => {
  store.sums = store.sums.filter(x => x.id !== body.id);
  return { ok: true, id: body.id.replace('/', '/_archive/2026-11-04-') };
};

test('Complete on the viewed plan falls back to the session plan and does not come back to the old id', async () => {
  const own = plan('web/own', 'web', { sessions: ['claude-a'] });
  const t = await lifeBoot({ sums: [own, finishedPlan('api/other', 'api')], post: archivePost });
  t.openList();
  t.listRow('other').attrs.onclick();
  await tick();
  assert.strictEqual(t.topic(), 'other');
  t.footButton().attrs.onclick();
  t.dialogButton('Complete').attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.api.find(c => c[0] === 'plan-complete'), ['plan-complete', { id: 'api/other' }]);
  assert.deepStrictEqual(t.calls.toast, [['other completed', 'ok']]);
  assert.strictEqual(t.topic(), 'own');
  t.store.sums = [own, finishedPlan('api/other', 'api')];
  t.p.live();
  await tick();
  assert.strictEqual(t.topic(), 'own');
});

test('Complete from a list row asks without switching the plan', async () => {
  const t = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] }), finishedPlan('api/other', 'api')], post: archivePost });
  t.openList();
  t.byClass('fp2-mini')[0].attrs.onclick();
  assert.strictEqual(t.topic(), 'own');
  assert.ok(t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-top')[0]).startsWith('Complete other?'));
  t.dialogButton('Complete').attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.api.find(c => c[0] === 'plan-complete'), ['plan-complete', { id: 'api/other' }]);
  assert.strictEqual(t.topic(), 'own');
  assert.strictEqual(t.byClass('fp2-drop').length, 0);
});

test('Complete on the only plan of the org closes the panel and leaves the no-plan row', async () => {
  const t = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] })], post: archivePost });
  t.openActions();
  t.menuItems()[2].attrs.onclick();
  t.dialogButton('Complete').attrs.onclick();
  await tick();
  assert.strictEqual(t.panel(), null);
  assert.strictEqual(planBtn(t), null);
  assert.ok(optItem(t, 'Make a plan'));
});

test('phone: Complete on the session plan closes the panel', async () => {
  const t = await lifeBoot({ phone: true, sums: [finishedPlan('web/own', 'web', { sessions: ['claude-a'] })], post: archivePost });
  t.p.sessMenu('claude-a', {}, { state: 'idle' }).onclick();
  await tick();
  t.footButton().attrs.onclick();
  t.dialogButton('Complete').attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.toast, [['own completed', 'ok']]);
  assert.strictEqual(t.panel(), null);
});

test('Complete refused by the server keeps the plan and shows the error as it is', async () => {
  const t = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] })], fail: 'no such plan' });
  t.openActions();
  t.menuItems()[2].attrs.onclick();
  t.dialogButton('Complete').attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.toast, [['no such plan', 'err']]);
  assert.strictEqual(t.topic(), 'own');
});

test('a second press while Complete is running sends nothing', async () => {
  const t = await lifeBoot({ sums: [finishedPlan('web/own', 'web', { sessions: ['claude-a'] })], post: archivePost });
  t.footButton().attrs.onclick();
  const btn = t.dialogButton('Complete');
  btn.attrs.onclick();
  btn.attrs.onclick();
  await tick();
  assert.strictEqual(t.paths().filter(x => x === 'plan-complete').length, 1);
});

const POSTS = ['plan-finish', 'plan-archive', 'plan-complete', 'plan-step', 'plan-restore', 'plan-answer'];
const posted = t => t.paths().filter(x => POSTS.includes(x));
const ENTRIES = {
  'bottom button': { sums: () => [finishedPlan('web/one', 'web', { sessions: ['claude-a'] })], open: t => t.footButton().attrs.onclick() },
  'list row': { sums: () => [plan('web/own', 'web', { sessions: ['claude-a'] }), finishedPlan('web/one', 'web')], open: t => { if (!t.byClass('fp2-drop').length) t.openList(); t.byClass('fp2-mini')[0].attrs.onclick(); } },
  'Complete anyway': { sums: () => [plan('web/one', 'web', { sessions: ['claude-a'] })], open: t => { t.openActions(); t.menuItems()[2].attrs.onclick(); } },
};
const okPost = (store, path, body) => ({ ok: true, id: body.id });

for (const [name, entry] of Object.entries(ENTRIES)) {
  test(`${name}: nothing is sent until Complete; Cancel, Esc and the scrim send nothing`, async () => {
    const t = await lifeBoot({ sums: entry.sums(), post: okPost });
    for (const dismiss of [() => t.dialogButton('Cancel').attrs.onclick(), () => t.dom.key('Escape'), () => t.scrim().attrs.onclick()]) {
      entry.open(t);
      await tick();
      assert.ok(t.dialog());
      assert.deepStrictEqual(posted(t), []);
      dismiss();
      await tick();
      assert.strictEqual(t.dialog(), null);
      assert.deepStrictEqual(posted(t), []);
      assert.deepStrictEqual(t.calls.toast, []);
    }
    entry.open(t);
    assert.deepStrictEqual(posted(t), []);
    t.dialogButton('Complete').attrs.onclick();
    await tick();
    assert.strictEqual(t.dialog(), null);
    assert.deepStrictEqual(t.calls.api.filter(c => POSTS.includes(c[0])), [['plan-complete', { id: 'web/one' }]]);
  });
}

const dialogTexts = t => [t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-top')[0]), t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-confirm')[0])];

test('every Complete asks with the same exact sheet', async () => {
  const want = ['Complete one?', 'It moves to Archived. You can open it there and restore it any time.CancelComplete'];
  for (const entry of Object.values(ENTRIES)) {
    const t = await lifeBoot({ sums: entry.sums() });
    entry.open(t);
    assert.deepStrictEqual(dialogTexts(t), want);
  }
});

test('New plan… is in the menu of every plan and opens the Make a plan sheet for the active session', async () => {
  const own = plan('web/own', 'web', { sessions: ['claude-a'] });
  const other = plan('api/other', 'api', { sessions: ['claude-other'] });
  for (const [sums, view] of [[[own], null], [[finishedPlan('web/one', 'web', { sessions: ['claude-a'] })], null], [[own, other], 'other']]) {
    const t = await lifeBoot({ sums });
    if (view) {
      t.openList();
      t.listRow(view).attrs.onclick();
      await tick();
      assert.strictEqual(t.topic(), view);
    }
    t.openActions();
    const item = t.menuItems().find(n => t.dom.text(n).startsWith('New plan…'));
    assert.strictEqual(item.attrs.class, 'mi');
    item.attrs.onclick();
    assert.strictEqual(t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-top')[0]), 'Make a plan');
    assert.strictEqual(t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-hint')[0]), 'Goes to claude-a as a message.');
    assert.strictEqual(find(t.dialog(), n => n.attrs.class === 'fp2-sh-tp').length, 0);
  }
});

test('New plan… is disabled with the hint when the active session is not live', async () => {
  const t = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'] })], claude: { state: 'ended' } });
  t.openActions();
  const item = t.menuItems().find(n => t.dom.text(n).startsWith('New plan…'));
  assert.strictEqual(item.attrs.class, 'mi dis');
  assert.strictEqual(t.dom.text(item), 'New plan…No live session runs this plan');
});

test('a shell session gets nothing without its own plan, even when its org has plans', async () => {
  const t = await lifeBoot({ active: 'sh-1', claude: null, sums: [plan('web/one', 'web', { sessions: ['claude-a'] }), plan('api/two', 'api')] });
  assert.strictEqual(planBtn(t), null);
  assert.strictEqual(t.panel(), null);
  const empty = await lifeBoot({ active: 'sh-1', claude: null, sums: [] });
  assert.strictEqual(planBtn(empty), null);
});

test('a shell session that a plan is mapped to keeps its Plan button; a Claude session with org plans gets the count button and no ring', async () => {
  const mapped = await lifeBoot({ active: 'sh-1', claude: null, sums: [plan('web/one', 'web', { sessions: ['sh-1'] })] });
  assert.ok(planBtn(mapped));
  assert.strictEqual(mapped.p.sessMenu('sh-1', {}, null), null);
  const claude = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-other'] })] });
  assert.strictEqual(planBtnText(claude), 'Plan1');
  assert.strictEqual(find(planBtn(claude), n => n.attrs.class && n.attrs.class.includes('fp2-ring')).length, 0);
});

test('the Plan button shows the ring and done/total, a state mark for open questions, and the pressed state of the panel', async () => {
  const q = id => ({ id, text: id, blocks: [] });
  const t = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'], done: 3, total: 7, waiting: [q('q1'), q('q2')] })], stored: JSON.stringify({ 'claude-a': false }) });
  const btn = planBtn(t);
  assert.strictEqual(t.dom.text(btn), 'Plan3/7');
  assert.strictEqual(find(btn, n => n.attrs.class && n.attrs.class.includes('fp2-ring')).length, 1);
  assert.strictEqual(find(btn, n => n.attrs.class === 'fp2-dot').length, 1);
  assert.ok(btn.attrs.title.includes('2 waiting on you'));
  assert.strictEqual(btn.attrs['aria-pressed'], 'false');
  assert.ok(!btn.attrs.class.split(' ').includes('on'));
  btn.attrs.onclick();
  await tick();
  const pressed = planBtn(t);
  assert.strictEqual(pressed.attrs['aria-pressed'], 'true');
  assert.ok(pressed.attrs.class.split(' ').includes('on'));
  pressed.attrs.onclick();
  await tick();
  assert.strictEqual(planBtn(t).attrs['aria-pressed'], 'false');
  assert.strictEqual(t.panel(), null);
});

test('the Plan button is not drawn on a phone, and the bar key follows the panel', async () => {
  const phone = await lifeBoot({ phone: true, sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  assert.strictEqual(planBtn(phone), null);
  const t = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'] })], stored: JSON.stringify({ 'claude-a': false }) });
  const closed = t.p.termBarKey();
  planBtn(t).attrs.onclick();
  await tick();
  assert.notStrictEqual(t.p.termBarKey(), closed);
});

test('openUpdate is not exported', () => {
  assert.strictEqual(plan2.openUpdate, undefined);
});

const arch = (id, projectId, at, extra = {}) => plan(id, projectId, { topic: id.split('/').pop().slice(11), archived: at, done: 5, total: 5, ...extra });

test('archivedOf keeps the archived plans of one org group, newest first', () => {
  const list = [
    plan('web/live', 'web'),
    arch('web/_archive/2026-10-12-old-web', 'web', '2026-10-12T09:00:00.000Z'),
    arch('api/_archive/2026-10-28-new-api', 'api', '2026-10-28T09:00:00.000Z'),
    arch('other/_archive/2026-11-01-zed-one', 'other', '2026-11-01T09:00:00.000Z'),
    arch('dir/_archive/2026-11-02-loose-one', null, '2026-11-02T09:00:00.000Z'),
  ];
  assert.deepStrictEqual([...plan2.archivedOf(list, projects, 'org:acme').map(x => x.topic)], ['new-api', 'old-web']);
  assert.deepStrictEqual([...plan2.archivedOf(list, projects, 'dir:dir').map(x => x.topic)], ['loose-one']);
});

const archRows = t => find(t.dialog(), n => n.attrs.class === 'fp2-arow');
const ARCHIVED_ONE = arch('web/_archive/2026-10-12-old-web', 'web', '2026-10-12T09:00:00.000Z');

test('desktop: Archived N loads the list only when the plan list opens, also with one plan, and its rows open a sheet', async () => {
  const at = '2026-10-28T09:00:00.000Z';
  const t = await lifeBoot({
    sums: [plan('web/own', 'web', { sessions: ['claude-a'] })],
    archived: [ARCHIVED_ONE, arch('api/_archive/2026-10-28-new-api', 'api', at, { done: 6, total: 8 }), arch('other/_archive/2026-11-01-zed-one', 'other', '2026-11-01T09:00:00.000Z')],
  });
  assert.ok(!t.paths().includes('plans?v=2&archived=1'));
  assert.strictEqual(t.byClass('fp2-drop').length, 0);
  t.openList();
  await tick();
  assert.strictEqual(t.paths().filter(x => x === 'plans?v=2&archived=1').length, 1);
  assert.strictEqual(t.dom.text(t.byClass('fp2-lk')[0]), 'Archived2 ›');
  t.pressArchived();
  await tick();
  assert.strictEqual(t.byClass('fp2-drop').length, 0);
  assert.deepStrictEqual(archRows(t).map(n => t.dom.text(n)), [
    `new-api 6/8archived ${dateOf(at)}`,
    `old-web 5/5archived ${dateOf('2026-10-12T09:00:00.000Z')}`,
  ]);
});

test('phone: the plan list groups this chat and other plans, and Archived says so when it is empty', async () => {
  const t = await lifeBoot({ phone: true, sums: [finishedPlan('web/own', 'web', { sessions: ['claude-a'] }), plan('web/two', 'web')] });
  t.p.sessMenu('claude-a', {}, { state: 'idle' }).onclick();
  await tick();
  assert.strictEqual(t.byClass('fp2-drop').length, 0);
  t.openList();
  await tick();
  assert.deepStrictEqual(t.byClass('fp2-gh').map(n => t.dom.text(n)), ['This chat', 'Other plans']);
  assert.strictEqual(t.dom.text(t.byClass('fp2-lk')[0]), 'Archived0 ›');
  t.pressArchived();
  await tick();
  assert.strictEqual(t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-body')[0]), 'No archived plans.');
});

test('a failed archived list shows the error instead of staying on loading', async () => {
  const t = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] })], failList: 'list failed' });
  t.openList();
  await tick();
  t.pressArchived();
  await tick();
  assert.ok(t.dom.text(t.dialog()).includes('list failed'));
});

const openArchivedRow = async t => {
  t.openList();
  await tick();
  t.pressArchived();
  await tick();
  archRows(t)[0].attrs.onclick();
  await tick();
};

test('Restore in the preview posts the archived id with no question and shows the restored plan under its returned id', async () => {
  const own = plan('web/own', 'web', { sessions: ['claude-a'] });
  const t = await lifeBoot({
    sums: [own], archived: [ARCHIVED_ONE],
    post: store => {
      store.archived = [];
      store.sums = [own, plan('web/old-web', 'web')];
      return { ok: true, id: 'web/old-web' };
    },
  });
  await openArchivedRow(t);
  assert.strictEqual(t.dom.text(t.footButton()), '↶ Restore this plan');
  t.footButton().attrs.onclick();
  await tick();
  assert.strictEqual(t.dialog(), null);
  assert.deepStrictEqual(t.calls.api.find(c => c[0] === 'plan-restore'), ['plan-restore', { id: 'web/_archive/2026-10-12-old-web' }]);
  assert.deepStrictEqual(t.calls.toast, [['old-web restored', 'ok']]);
  assert.strictEqual(t.topic(), 'old-web');
  assert.strictEqual(t.byClass('fp2-tag').length, 0);
  assert.strictEqual(t.byClass('fp2-edit').length, 1);
});

test('Restore refused by the server keeps the preview and shows the error as it is', async () => {
  const err = 'plan old-web already exists for /r/web';
  const t = await lifeBoot({ fail: err, sums: [plan('web/own', 'web', { sessions: ['claude-a'] })], archived: [ARCHIVED_ONE] });
  await openArchivedRow(t);
  t.footButton().attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.toast, [[err, 'err']]);
  assert.strictEqual(t.topic(), 'old-web');
  assert.ok(t.panelText().includes('read only'));
  assert.ok(!t.footButton().attrs.disabled);
});

const noPlanArchived = t => optItem(t, 'Archived plans');
const ARCHIVED_ORG = [
  arch('web/_archive/2026-10-12-old-web', 'web', '2026-10-12T09:00:00.000Z'),
  arch('api/_archive/2026-10-28-new-api', 'api', '2026-10-28T09:00:00.000Z', { done: 6, total: 8 }),
  arch('other/_archive/2026-11-01-zed-one', 'other', '2026-11-01T09:00:00.000Z'),
];

test('no-plan row: Archived loads the list only when pressed, in a sheet with the org plans, newest first', async () => {
  const t = await lifeBoot({ sums: [], archived: ARCHIVED_ORG });
  assert.strictEqual(noPlanArchived(t).label, 'Archived plans…');
  assert.ok(!t.paths().includes('plans?v=2&archived=1'));
  noPlanArchived(t).onclick();
  assert.strictEqual(t.dom.text(t.dialog()).includes('loading…'), true);
  await tick();
  assert.strictEqual(t.paths().filter(x => x === 'plans?v=2&archived=1').length, 1);
  assert.ok(t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-top')[0]).startsWith('Archived'));
  assert.deepStrictEqual(archRows(t).map(n => t.dom.text(n)), [
    `new-api 6/8archived ${dateOf('2026-10-28T09:00:00.000Z')}`,
    `old-web 5/5archived ${dateOf('2026-10-12T09:00:00.000Z')}`,
  ]);
});

test('no-plan row: a session with no project lists every archived plan, newest first', async () => {
  const t = await lifeBoot({ sums: [], archived: ARCHIVED_ORG, project: null });
  noPlanArchived(t).onclick();
  await tick();
  assert.deepStrictEqual(archRows(t).map(n => t.dom.text(find(n, x => x.attrs.class === 'fp2-cn')[0])), ['zed-one', 'new-api', 'old-web']);
});

test('no-plan row: the sheet says so when nothing is archived, and shows a failed list as its error', async () => {
  const empty = await lifeBoot({ sums: [], archived: [ARCHIVED_ORG[2]] });
  noPlanArchived(empty).onclick();
  await tick();
  assert.strictEqual(archRows(empty).length, 0);
  assert.strictEqual(empty.dom.text(find(empty.dialog(), n => n.attrs.class === 'fp2-sh-body')[0]), 'No archived plans.');
  const failed = await lifeBoot({ sums: [], failList: 'list failed' });
  noPlanArchived(failed).onclick();
  await tick();
  assert.ok(failed.dom.text(failed.dialog()).includes('list failed'));
});

test('no-plan row: Archived works on an ended session too, where Make a plan is disabled', async () => {
  const t = await lifeBoot({ sums: [], archived: ARCHIVED_ORG, claude: { state: 'ended' } });
  assert.strictEqual(optItem(t, 'Make a plan').disabled, true);
  assert.ok(!noPlanArchived(t).disabled);
  noPlanArchived(t).onclick();
  await tick();
  assert.strictEqual(archRows(t).length, 2);
});

test('no-plan row: a row opens the preview and Restore opens the panel on the restored plan', async () => {
  const t = await lifeBoot({
    sums: [], archived: [ARCHIVED_ORG[0]],
    post: store => {
      store.archived = [];
      store.sums = [plan('web/old-web', 'web')];
      return { ok: true, id: 'web/old-web' };
    },
  });
  noPlanArchived(t).onclick();
  await tick();
  archRows(t)[0].attrs.onclick();
  await tick();
  assert.strictEqual(t.dialog(), null);
  assert.ok(t.panelText().includes('read only'));
  t.footButton().attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.api.find(c => c[0] === 'plan-restore'), ['plan-restore', { id: 'web/_archive/2026-10-12-old-web' }]);
  assert.deepStrictEqual(t.calls.toast, [['old-web restored', 'ok']]);
  assert.ok(planBtn(t));
  assert.strictEqual(t.topic(), 'old-web');
  assert.ok(!t.panelText().includes('read only'));
});

test('no-plan row: a refused Restore keeps the preview and shows the error as it is', async () => {
  const err = 'plan old-web already exists for /r/web';
  const t = await lifeBoot({ fail: err, sums: [], archived: [ARCHIVED_ORG[0]] });
  noPlanArchived(t).onclick();
  await tick();
  archRows(t)[0].attrs.onclick();
  await tick();
  t.footButton().attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.toast, [[err, 'err']]);
  assert.ok(t.panelText().includes('read only'));
});

test('no-plan row: a late list after the sheet closed draws nothing and later plan events do not refetch it', async () => {
  const t = await lifeBoot({ sums: [], archived: ARCHIVED_ORG });
  noPlanArchived(t).onclick();
  t.scrim().attrs.onclick();
  await tick();
  assert.strictEqual(t.dialog(), null);
  const fetched = t.paths().filter(x => x === 'plans?v=2&archived=1').length;
  t.p.plan({ id: 'web/x', mtime: 2 });
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(t.paths().filter(x => x === 'plans?v=2&archived=1').length, fetched);
});

test('no-plan row: a plan event while the sheet is open refreshes the list in place', async () => {
  const t = await lifeBoot({ sums: [], archived: [ARCHIVED_ORG[0]] });
  noPlanArchived(t).onclick();
  await tick();
  assert.strictEqual(archRows(t).length, 1);
  t.store.archived = [ARCHIVED_ORG[0], ARCHIVED_ORG[1]];
  t.p.plan({ id: 'api/_archive/2026-10-28-new-api', mtime: 2 });
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(archRows(t).length, 2);
});

test('a shell session gets no Archived entry and no Plan button at all', async () => {
  const t = await lifeBoot({ sums: [], archived: ARCHIVED_ORG, active: 'sh-1', claude: null });
  assert.strictEqual(planBtn(t), null);
  assert.strictEqual(optItem(t, 'Archived plans'), undefined);
  assert.ok(!t.paths().includes('plans?v=2&archived=1'));
});

test('a click outside the plan list closes it, a click inside or on the name keeps it', async () => {
  const t = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] })] });
  t.openList();
  await tick();
  const click = t.dom.listeners.find(l => l.type === 'click').fn;
  click({ target: { closest: sel => sel === '.fp2-drop' ? {} : null } });
  assert.strictEqual(t.byClass('fp2-drop').length, 1);
  click({ target: { closest: sel => sel === '.fp2-pname' ? {} : null } });
  assert.strictEqual(t.byClass('fp2-drop').length, 1);
  click({ target: { closest: () => null } });
  assert.strictEqual(t.byClass('fp2-drop').length, 0);
});

test('the timeline names finish, reopen, restore and undo', () => {
  const { dom, p } = detailBoot();
  const { nav } = navStub();
  const d = { ...detail, timeline: [ev('finish', { text: 'marked finished' }), ev('reopen'), ev('restore'), ev('undo')] };
  const t = dom.text(p.phaseSheet({ topic: 'checkout' }, d, 1, nav).body);
  for (const part of ['finishedmarked finished', 'reopened', 'restored', 'unticked']) assert.ok(t.includes(part), part);
});

test('continueMsg and leaveMsg build the exact one-line messages', () => {
  const { p } = noteBoot([sess('claude-a', { state: 'idle' })], 'claude-a');
  assert.strictEqual(p.continueMsg('search-v2'), 'Continue the plan search-v2: run plan use search-v2, then plan show, and carry on with it.');
  assert.strictEqual(p.leaveMsg('search-v2'), 'This chat no longer works on the plan search-v2: run plan use --clear. The plan itself stays as it is. Do not work on it unless I ask.');
});

test('finishedWhen shows the clock on the same day and the date with the clock on any other day', () => {
  const { p } = noteBoot([sess('claude-a', { state: 'idle' })], 'claude-a');
  const at = new Date(2026, 10, 4, 13, 5);
  assert.strictEqual(p.finishedWhen(at.toISOString(), new Date(2026, 10, 4, 23, 59)), clockOf(at));
  assert.strictEqual(p.finishedWhen(at.toISOString(), new Date(2026, 10, 5, 0, 1)), `${dateOf(at)}, ${clockOf(at)}`);
  assert.strictEqual(p.finishedWhen(at.toISOString(), new Date(2025, 10, 4, 13, 5)), `${dateOf(at)}, ${clockOf(at)}`);
});

const noPlanLabels = t => optItems(t).map(i => i.label);
const continueButton = t => { const i = optItem(t, 'Continue'); return i && { attrs: i }; };
const sent = t => t.calls.api.filter(c => c[0] === 'send');

test('Options: an offered plan shows Continue after Make a plan and sends to this session, not to the plan claimers', async () => {
  const t = await lifeBoot({
    post: () => ({ ok: true }),
    sums: [plan('web/one', 'web', { offered: ['claude-a'], sessions: ['claude-z'], done: 3, total: 7 })],
  });
  assert.deepStrictEqual(noPlanLabels(t), ['Make a plan…', '1 in acme…', 'Continue one', 'Archived plans…']);
  assert.ok(!t.reg['fp2-panel']);
  await continueButton(t).attrs.onclick();
  assert.deepStrictEqual(sent(t), [['send', { session: 'claude-a', text: 'Continue the plan one: run plan use one, then plan show, and carry on with it.' }]]);
});

test('no-plan row: Continue is not shown without an offer, and is disabled with the hint on an ended session', async () => {
  const none = await lifeBoot({ sums: [plan('web/one', 'web', { offered: ['claude-other'] })] });
  assert.strictEqual(continueButton(none), undefined);
  const ended = await lifeBoot({ sums: [plan('web/one', 'web', { offered: ['claude-a'] })], claude: { state: 'ended' } });
  assert.strictEqual(continueButton(ended).attrs.disabled, true);
  assert.strictEqual(optItem(ended, 'Continue').sub, 'No live session runs this plan');
});

test('no-plan row: Continue refuses at a permission prompt and a second press while sending sends once', async () => {
  const perm = await lifeBoot({ sums: [plan('web/one', 'web', { offered: ['claude-a'] })], claude: { state: 'permission' } });
  await continueButton(perm).attrs.onclick();
  assert.deepStrictEqual(sent(perm), []);
  assert.ok(perm.calls.toast[0][0].includes('permission prompt'));
  const t = await lifeBoot({ post: () => ({ ok: true }), sums: [plan('web/one', 'web', { offered: ['claude-a'] })] });
  const btn = continueButton(t);
  await Promise.all([btn.attrs.onclick(), btn.attrs.onclick()]);
  assert.strictEqual(sent(t).length, 1);
});

test('Leave this plan sends without asking, and is only there for the plan of the active session', async () => {
  const t = await lifeBoot({ post: () => ({ ok: true }), sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  t.openActions();
  find(t.byClass('fp2-actm')[0], n => t.dom.text(n).startsWith('Leave this plan') && n.attrs.role === 'menuitem')[0].attrs.onclick();
  await tick();
  assert.strictEqual(t.dialog(), null);
  assert.deepStrictEqual(sent(t), [['send', { session: 'claude-a', text: 'This chat no longer works on the plan one: run plan use --clear. The plan itself stays as it is. Do not work on it unless I ask.' }]]);
  const other = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-z'] })] });
  optItem(other, '1 in').onclick();
  await tick();
  other.openActions();
  assert.ok(!other.menuItems().some(n => other.dom.text(n).startsWith('Leave this plan')));
});

test('phone: no Plan button at the top of a session, ever', async () => {
  for (const sums of [[], [plan('web/one', 'web', { sessions: ['claude-a'] })], [plan('web/one', 'web', { offered: ['claude-a'] })]]) {
    const t = await lifeBoot({ phone: true, sums });
    assert.strictEqual(planBtn(t), null);
    assert.strictEqual(t.panel(), null);
  }
});

test('session Options: nothing for the own plan on a desktop or for a shell session', async () => {
  const desk = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  assert.strictEqual(desk.p.sessMenu('claude-a', {}, { state: 'idle' }), null);
  const shell = await lifeBoot({ phone: true, sums: [], active: 'sh-1', claude: null });
  assert.strictEqual(shell.p.sessMenu('sh-1', {}, null), null);
});

test('session Options with a plan: the topic and count, the open questions as a sub line, and it opens the panel', async () => {
  const q = id => ({ id, text: id, blocks: [] });
  const none = await lifeBoot({ phone: true, sums: [plan('web/one', 'web', { sessions: ['claude-a'], done: 3, total: 7 })] });
  const item = none.p.sessMenu('claude-a', {}, { state: 'idle' });
  assert.strictEqual(item.label, 'Plan · one 3/7');
  assert.strictEqual(item.sub, '');
  item.onclick();
  await tick();
  assert.strictEqual(none.topic(), 'one');
  item.onclick();
  assert.ok(none.panel());
  const single = await lifeBoot({ phone: true, sums: [plan('web/one', 'web', { sessions: ['claude-a'], waiting: [q('q1')] })] });
  assert.strictEqual(single.p.sessMenu('claude-a', {}, { state: 'idle' }).sub, '1 open question');
  const two = await lifeBoot({ phone: true, sums: [plan('web/one', 'web', { sessions: ['claude-a'], waiting: [q('q1'), q('q2')] })] });
  assert.strictEqual(two.p.sessMenu('claude-a', {}, { state: 'idle' }).sub, '2 open questions');
});

test('session Options without a plan: Make a plan, Continue when offered, Archived plans', async () => {
  const labels = t => [...t.p.sessMenu('claude-a', {}, { state: 'idle' })].map(i => i.label);
  const plain = await lifeBoot({ phone: true, sums: [plan('web/one', 'web', { offered: ['claude-other'] })] });
  assert.deepStrictEqual(labels(plain), ['Make a plan…', '1 in acme…', 'Archived plans…']);
  const noOrg = await lifeBoot({ phone: true, project: null, sums: [plan('web/one', 'web')] });
  assert.deepStrictEqual(labels(noOrg), ['Make a plan…', 'Archived plans…']);
  plain.p.sessMenu('claude-a', {}, { state: 'idle' })[0].onclick();
  assert.ok(plain.dialog());
  const t = await lifeBoot({ phone: true, post: () => ({ ok: true }), archived: ARCHIVED_ORG, sums: [plan('web/one', 'web', { offered: ['claude-a'], done: 3, total: 7 })] });
  assert.deepStrictEqual(labels(t), ['Make a plan…', '1 in acme…', 'Continue one', 'Archived plans…']);
  const items = t.p.sessMenu('claude-a', {}, { state: 'idle' });
  await items[2].onclick();
  assert.deepStrictEqual(sent(t), [['send', { session: 'claude-a', text: 'Continue the plan one: run plan use one, then plan show, and carry on with it.' }]]);
  items[3].onclick();
  await tick();
  assert.deepStrictEqual(archRows(t).map(n => t.dom.text(find(n, x => x.attrs.class === 'fp2-cn')[0])), ['new-api', 'old-web']);
});

test('session Options on an ended session: Make a plan and Continue are disabled with the hint, Archived plans still works', async () => {
  const t = await lifeBoot({ phone: true, claude: { state: 'ended' }, sums: [plan('web/one', 'web', { offered: ['claude-a'] })] });
  const items = t.p.sessMenu('claude-a', {}, { state: 'ended' });
  assert.deepStrictEqual([...items].map(i => [!!i.disabled, i.sub || '']), [[true, 'No live session runs this plan'], [false, ''], [true, 'No live session runs this plan'], [false, '']]);
});

test('session Options without a plan: the org item opens the panel on an org plan', async () => {
  const t = await lifeBoot({ phone: true, sums: [plan('web/one', 'web')] });
  t.p.sessMenu('claude-a', {}, { state: 'idle' })[1].onclick();
  await tick();
  assert.ok(t.panel());
  assert.strictEqual(t.topic(), 'one');
});

test('phone: a panel whose plan is gone does not come back by itself', async () => {
  const t = await lifeBoot({ phone: true, sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  t.p.sessMenu('claude-a', {}, { state: 'idle' }).onclick();
  await tick();
  assert.ok(t.panel());
  t.store.sums = [];
  t.p.plan({ id: 'web/one', mtime: 2, removed: true });
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(t.panel(), null);
  t.store.sums = [plan('web/two', 'web', { sessions: ['claude-a'] })];
  t.p.plan({ id: 'web/two', mtime: 3 });
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(t.panel(), null);
});

const TWO = { phases: [{ n: 1, name: 'A', done: 0, total: 2, tasks: [
  { id: 'T1', title: 'One', status: 'done', model: null, body: '', by: [], gate: null },
  { id: 'T2', title: 'Two', status: 'todo', model: null, body: '', by: [], gate: null },
] }], timeline: [{ ts: '2026-10-04T11:00:00.000Z', type: 'create', text: 'x' }], waiting: [], mtime: 1 };
const NEXT2 = { id: 'T2', title: 'Two', model: null };

test('a finished plan with open tasks shows no next chip; an unfinished one shows it', async () => {
  const open = await lifeBoot({ detail: TWO, sums: [plan('web/one', 'web', { sessions: ['claude-a'], next: NEXT2 })] });
  assert.strictEqual(open.byClass('fp2-nx').length, 1);
  const fin = await lifeBoot({ detail: TWO, sums: [finishedPlan('web/one', 'web', { sessions: ['claude-a'], next: NEXT2 })] });
  assert.strictEqual(fin.byClass('fp2-nx').length, 0);
});

test('the Steps header shows the date of an old plan start, and only the clock for today', async () => {
  const old = await lifeBoot({ detail: TWO, sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  assert.ok(old.dom.text(old.panel()).includes(`started ${dateOf('2026-10-04T11:00:00.000Z')}, ${clockOf('2026-10-04T11:00:00.000Z')}`));
  const now = new Date().toISOString();
  const today = await lifeBoot({ detail: { ...TWO, timeline: [{ ts: now, type: 'create', text: 'x' }] }, sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  assert.ok(today.dom.text(today.panel()).includes(`started ${clockOf(now)}`));
  assert.ok(!today.dom.text(today.panel()).includes(`started ${dateOf(now)}`));
});

test('oneLine drops control characters from a message', () => {
  const m = plan2.answerMsg('t', { id: 'q1', q: 'a\u0007b\u001b[31m?' }, 'x\u0000y\u007fz');
  assert.ok(!/[\u0000-\u001f\u007f]/.test(m));
  assert.ok(m.includes('xyz') && m.includes('("ab[31m?")'));
  assert.ok(!/[\u0000-\u001f\u007f]/.test(plan2.makeMsg('n\u0008ote')));
});

test('phone: closing the terminal clears the open panel, so it does not reopen with the session', async () => {
  const t = await lifeBoot({ phone: true, sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  t.p.sessMenu('claude-a', {}, { state: 'idle' }).onclick();
  await tick();
  assert.ok(t.panel());
  t.TERM.open = false;
  t.p.onState();
  assert.strictEqual(t.panel(), null);
  t.TERM.open = true;
  t.p.onState();
  assert.strictEqual(t.panel(), null);
});

test('phone: Claude going away clears the open panel, so it does not reopen when Claude is back', async () => {
  const t = await lifeBoot({ phone: true, sums: [plan('web/one', 'web')] });
  t.p.sessMenu('claude-a', {}, { state: 'idle' })[1].onclick();
  await tick();
  assert.ok(t.panel());
  const claude = t.S.runtime.sessions[0].claude;
  t.S.runtime.sessions[0].claude = null;
  t.p.onState();
  assert.strictEqual(t.panel(), null);
  t.S.runtime.sessions[0].claude = claude;
  t.p.onState();
  assert.strictEqual(t.panel(), null);
});

test('phone: a sheet opened from session Options goes away with the terminal', async () => {
  const t = await lifeBoot({ phone: true, sums: [plan('web/one', 'web', { offered: ['claude-a'] })] });
  t.p.sessMenu('claude-a', {}, { state: 'idle' })[0].onclick();
  await tick();
  assert.ok(t.dialog());
  t.TERM.open = false;
  t.p.onState();
  assert.strictEqual(t.dialog(), null);
});

test('phone: turning plans off closes an open panel', async () => {
  const t = await lifeBoot({ phone: true, sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  t.p.sessMenu('claude-a', {}, { state: 'idle' }).onclick();
  await tick();
  assert.ok(t.panel());
  t.S.settings.plans = false;
  t.p.onState();
  assert.strictEqual(t.panel(), null);
  assert.strictEqual(t.p.sessMenu('claude-a', {}, { state: 'idle' }), null);
});

const editOf = t => t.byClass('fp2-edit')[0];

test('Edit plan opens the Edit sheet with Cancel and Send to Claude and sends the update message', async () => {
  const t = await lifeBoot({ post: () => ({ ok: true }), sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  assert.strictEqual(editOf(t).attrs.class, 'btn fp2-edit');
  assert.ok(!editOf(t).attrs['aria-disabled']);
  assert.strictEqual(t.dom.text(editOf(t)), 'Edit plan');
  editOf(t).attrs.onclick();
  assert.strictEqual(t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-top')[0]), 'Edit one');
  assert.ok(t.dialogButton('Cancel'));
  await t.dialogButton('Send to Claude').onclick();
  assert.deepStrictEqual(t.calls.api.filter(c => c[0] === 'send'), [['send', { session: 'claude-a', text: UPDATE_BASE('one') }]]);
});

test('Edit plan with no live session stays visible, disabled with the hint, and opens nothing', async () => {
  const t = await lifeBoot({ claude: { state: 'ended' }, sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  assert.strictEqual(editOf(t).attrs.class, 'btn fp2-edit off');
  assert.strictEqual(editOf(t).attrs['aria-disabled'], 'true');
  assert.strictEqual(editOf(t).attrs.title, 'No live session runs this plan');
  editOf(t).attrs.onclick();
  assert.strictEqual(t.dialog(), null);
  assert.deepStrictEqual(t.calls.toast, [['No live session runs this plan', 'err']]);
});

test('the header shows the plan name with the number of other plans', async () => {
  const one = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] })] });
  assert.strictEqual(one.dom.text(one.byClass('fp2-pname')[0]), 'own▾');
  const three = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] }), plan('web/two', 'web'), plan('api/three', 'api')] });
  assert.strictEqual(three.dom.text(three.byClass('fp2-pname')[0]), 'own▾ +2');
  three.openList();
  assert.strictEqual(three.dom.text(three.byClass('fp2-pname')[0]), 'own▴ +2');
});

test('the plan list has its groups, row states, All done rows with Complete, and Archived N', async () => {
  const t = await lifeBoot({
    archived: [ARCHIVED_ONE],
    sums: [
      plan('web/own', 'web', { sessions: ['claude-a'], done: 6, total: 12, pct: 50, now: { id: 'T7', title: 'x', steps: [] } }),
      plan('web/wait', 'web', { done: 2, total: 5, waiting: [{ id: 'q1', q: 'x', blocks: [] }] }),
      plan('web/chat', 'web', { sessions: ['claude-z'], done: 1, total: 2 }),
      plan('web/idle', 'web', { done: 0, total: 3 }),
      finishedPlan('web/fin', 'web'),
    ],
  });
  t.openList();
  await tick();
  assert.deepStrictEqual(t.byClass('fp2-gh').map(n => t.dom.text(n)), ['This chat', 'Other plans']);
  assert.strictEqual(t.dom.text(t.byClass('fp2-drop')[0].kids[1]).startsWith('own6/12 · now T7'), true);
  assert.ok(t.dom.text(t.listRow('wait')).includes('2/5 · waiting on you'));
  assert.strictEqual(find(t.listRow('wait'), n => n.attrs.class === 'fp2-wd').length, 1);
  assert.ok(t.dom.text(t.listRow('chat')).includes('1/2 · other chat'));
  assert.ok(t.dom.text(t.listRow('idle')).endsWith('0/3'));
  assert.ok(t.dom.text(t.listRow('fin')).includes('all done'));
  assert.strictEqual(t.byClass('fp2-mini').length, 1);
  assert.strictEqual(t.dom.text(t.byClass('fp2-mini')[0]), 'Complete');
  assert.strictEqual(t.byClass('fp2-wd').length, 1);
  assert.strictEqual(t.byClass('sel').length, 1);
  assert.strictEqual(t.dom.text(t.byClass('fp2-lk')[0]), 'Archived1 ›');
});

test('picking another plan closes the list and offers the way back to this session plan', async () => {
  const t = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] }), plan('web/two', 'web')] });
  t.openList();
  t.listRow('two').attrs.onclick();
  await tick();
  assert.strictEqual(t.topic(), 'two');
  assert.strictEqual(t.byClass('fp2-drop').length, 0);
  const back = t.button('this session')[0];
  back.attrs.onclick();
  await tick();
  assert.strictEqual(t.topic(), 'own');
  assert.strictEqual(t.button('this session').length, 0);
});

const stepDetail = () => JSON.parse(JSON.stringify(TWO));
const ticks = t => t.byClass('fp2-tick');
const markOf = (t, i) => find(ticks(t)[i], n => n.attrs.class && n.attrs.class.startsWith('fp2-si'))[0];

test('a tick posts plan-step with done true, an untick with done false, with no confirm', async () => {
  const t = await lifeBoot({ detail: stepDetail(), post: okPost, sums: [plan('web/one', 'web', { sessions: ['claude-a'], next: NEXT2 })] });
  assert.deepStrictEqual(ticks(t).map(n => n.attrs['aria-checked']), ['true', 'false']);
  await ticks(t)[1].attrs.onclick();
  assert.strictEqual(t.dialog(), null);
  await ticks(t)[0].attrs.onclick();
  assert.strictEqual(t.dialog(), null);
  assert.deepStrictEqual(t.calls.api.filter(c => c[0] === 'plan-step'), [
    ['plan-step', { id: 'web/one', task: 'T2', done: true }],
    ['plan-step', { id: 'web/one', task: 'T1', done: false }],
  ]);
});

test('a pressed box shows its new state and takes no second press until the reply, then the row updates', async () => {
  const d = stepDetail();
  const gate = {};
  const t = await lifeBoot({ detail: d, sums: [plan('web/one', 'web', { sessions: ['claude-a'], next: NEXT2 })], post: (store, path, body) => new Promise(resolve => {
    gate.release = () => {
      d.phases[0].tasks[1].status = 'done';
      store.sums = [plan('web/one', 'web', { sessions: ['claude-a'], done: 2, pct: 100, complete: true, mtime: 2 })];
      resolve({ ok: true, id: body.id });
    };
  }) });
  const box = ticks(t)[1];
  const press = box.attrs.onclick();
  assert.strictEqual(ticks(t)[1].attrs.disabled, true);
  assert.strictEqual(ticks(t)[1].attrs['aria-checked'], 'true');
  assert.ok(ticks(t)[1].attrs.class.includes('busy'));
  assert.ok(markOf(t, 1).attrs.class.split(' ').includes('done'));
  await box.attrs.onclick();
  assert.strictEqual(t.paths().filter(x => x === 'plan-step').length, 1);
  gate.release();
  await press;
  await tick();
  assert.ok(!ticks(t)[1].attrs.disabled);
  assert.ok(!ticks(t)[1].attrs.class.includes('busy'));
  assert.strictEqual(ticks(t)[1].attrs['aria-checked'], 'true');
  assert.ok(t.footButton().attrs.class.includes('grn'));
});

test('a refused tick shows the error as it is and the box goes back', async () => {
  const t = await lifeBoot({ detail: stepDetail(), fail: 'plan has no repo marker', sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  await ticks(t)[1].attrs.onclick();
  assert.deepStrictEqual(t.calls.toast, [['plan has no repo marker', 'err']]);
  assert.strictEqual(ticks(t)[1].attrs['aria-checked'], 'false');
  assert.ok(!ticks(t)[1].attrs.disabled);
  assert.ok(!ticks(t)[1].attrs.class.includes('busy'));
  assert.ok(!markOf(t, 1).attrs.class.split(' ').includes('done'));
});

test('the current task is highlighted and its text opens the task sheet', async () => {
  const t = await lifeBoot({ detail: stepDetail(), sums: [plan('web/one', 'web', { sessions: ['claude-a'], next: NEXT2 })] });
  assert.strictEqual(t.byClass('cur').length, 1);
  assert.ok(t.dom.text(t.byClass('cur')[0]).startsWith('T2'));
  await t.byClass('fp2-task-t')[1].attrs.onclick();
  await tick();
  assert.strictEqual(t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-top')[0]).startsWith('Task T2'), true);
});

test('a finished plan has no current task to highlight', async () => {
  const t = await lifeBoot({ detail: stepDetail(), sums: [finishedPlan('web/one', 'web', { sessions: ['claude-a'], next: NEXT2 })] });
  assert.strictEqual(t.byClass('cur').length, 0);
});

const FOLD = { phases: [
  { n: 1, name: 'Old', done: 1, total: 1, tasks: [{ id: 'T1', title: 'One', status: 'done', model: null, body: '', by: [], gate: null }] },
  { n: 2, name: 'New', done: 0, total: 1, tasks: [{ id: 'T2', title: 'Two', status: 'todo', model: null, body: '', by: [], gate: null }] },
], timeline: [], waiting: [], mtime: 1 };

test('a finished phase folds unless it holds the current task, and its chevron opens it', async () => {
  const t = await lifeBoot({ detail: FOLD, sums: [plan('web/one', 'web', { sessions: ['claude-a'], next: NEXT2 })] });
  assert.deepStrictEqual(t.byClass('fp2-task-t').map(n => t.dom.text(n)), ['Two']);
  t.byClass('fp2-ph-tg')[0].attrs.onclick();
  assert.deepStrictEqual(t.byClass('fp2-task-t').map(n => t.dom.text(n)), ['One', 'Two']);
});

test('the step id opens its card and the round mark only flags the step', async () => {
  const t = await lifeBoot({ detail: stepDetail(), sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  assert.strictEqual(t.byClass('fp2-task-b').length, 0);
  t.byClass('fp2-task-tg')[1].attrs.onclick();
  assert.strictEqual(t.byClass('fp2-task-b').length, 1);
  assert.strictEqual(t.paths().filter(x => x === 'plan-step').length, 0);
  await ticks(t)[1].attrs.onclick();
  assert.strictEqual(t.paths().filter(x => x === 'plan-step').length, 1);
});

const previewAt = '2026-10-12T09:00:00.000Z';

const expectReadOnly = (t, date) => {
  assert.strictEqual(t.topic(), 'old-web');
  assert.strictEqual(t.dom.text(t.byClass('fp2-tag')[0]), 'read only');
  assert.strictEqual(t.dom.text(t.byClass('fp2-pname')[0]), '‹ Archived');
  assert.ok(t.dom.text(t.byClass('fp2-pmeta')[0]).startsWith('5/5 steps'));
  assert.ok(t.dom.text(t.byClass('fp2-pstate')[0]) === `Archived ${date}`);
  assert.strictEqual(ticks(t).length, 0);
  assert.strictEqual(t.byClass('fp2-edit').length, 0);
  assert.strictEqual(t.byClass('fp2-act-b').length, 0);
  assert.strictEqual(t.byClass('fp2-si').length, 2);
  assert.strictEqual(t.byClass('fp2-si').filter(n => n.attrs.class.includes('done')).length, 1);
  assert.strictEqual(t.byClass('fp2-tick').length, 0);
  assert.strictEqual(t.dom.text(t.footButton()), '↶ Restore this plan');
  assert.ok(t.paths().includes('plan/web/_archive/2026-10-12-old-web'));
};

test('desktop list: an archived row opens the read-only preview; the back link returns to the sheet', async () => {
  const t = await lifeBoot({ detail: stepDetail(), sums: [plan('web/own', 'web', { sessions: ['claude-a'] })], archived: [ARCHIVED_ONE] });
  await openArchivedRow(t);
  assert.strictEqual(t.dialog(), null);
  expectReadOnly(t, dateOf(previewAt));
  t.byClass('fp2-pname')[0].attrs.onclick();
  assert.ok(t.dialog());
  assert.strictEqual(t.topic(), 'own');
  assert.strictEqual(t.byClass('fp2-edit').length, 1);
});

test('phone Options: Archived plans opens the preview with no plan, Restore needs no question and closing ends it', async () => {
  const t = await lifeBoot({ phone: true, detail: stepDetail(), sums: [], archived: [ARCHIVED_ONE], post: store => {
    store.archived = [];
    store.sums = [plan('web/old-web', 'web')];
    return { ok: true, id: 'web/old-web' };
  } });
  const options = () => t.p.sessMenu('claude-a', {}, { state: 'idle' });
  options().find(i => i.label === 'Archived plans…').onclick();
  await tick();
  archRows(t)[0].attrs.onclick();
  await tick();
  assert.ok(t.panel().attrs.class.includes('sheet'));
  expectReadOnly(t, dateOf(previewAt));
  t.closeBtn().attrs.onclick();
  await tick();
  assert.strictEqual(t.panel(), null);
  options().find(i => i.label === 'Archived plans…').onclick();
  await tick();
  archRows(t)[0].attrs.onclick();
  await tick();
  t.footButton().attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.toast, [['old-web restored', 'ok']]);
  assert.strictEqual(t.dialog(), null);
  assert.strictEqual(t.topic(), 'old-web');
  assert.strictEqual(t.byClass('fp2-edit').length, 1);
});

test('closing a preview closes the panel, and a plan that leaves Archived while previewed ends the preview', async () => {
  const t = await lifeBoot({ detail: stepDetail(), sums: [plan('web/own', 'web', { sessions: ['claude-a'] })], archived: [ARCHIVED_ONE] });
  await openArchivedRow(t);
  t.closeBtn().attrs.onclick();
  await tick();
  assert.strictEqual(t.panel(), null);
  const again = await lifeBoot({ detail: stepDetail(), sums: [plan('web/own', 'web', { sessions: ['claude-a'] })], archived: [ARCHIVED_ONE] });
  await openArchivedRow(again);
  again.store.archived = [];
  again.p.plan({ id: ARCHIVED_ONE.id, mtime: 2, removed: true });
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(again.topic(), 'own');
});

test('long plan names shrink with an ellipsis and never push the header buttons out', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-plan2.css'), 'utf8');
  const rule = sel => { const m = css.match(new RegExp(`^${sel} \\{([^}]*)\\}`, 'm')); return m ? m[1] : ''; };
  assert.ok(rule('\\.fp2-pname').includes('min-width: 0'));
  assert.ok(rule('\\.fp2-pname').includes('flex: 0 1 auto'));
  assert.ok(rule('\\.fp2-ptopic').includes('text-overflow: ellipsis'));
  assert.ok(rule('\\.btn\\.fp2-edit').includes('flex: none'));
  assert.ok(rule('\\.fp2-top \\.fp2-x').includes('flex: none'));
});

test('the detail sheet greys its row arrow, never the check inside a step mark', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-plan2.css'), 'utf8');
  assert.doesNotMatch(css, /\.fp2-dtr svg/);
  assert.match(css, /^\.fp2-dtr > svg \{ color: var\(--dim\); \}/m);
});

const ownPlan = () => [plan('web/own', 'web', { sessions: ['claude-a'] })];

test('opening the plan tells the other panels, closing it does not', async () => {
  const t = await lifeBoot({ sums: ownPlan(), stored: JSON.stringify({ 'claude-a': false }), detail: stepDetail() });
  assert.strictEqual(t.panel(), null);
  planBtn(t).attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.feat, [['rightOpen', 'plan']]);
  assert.ok(t.panel());
  t.closeBtn().attrs.onclick();
  await tick();
  assert.strictEqual(t.calls.feat.length, 1);
  assert.strictEqual(t.panel(), null);
});

test('when Files opens, the open plan closes for good and does not fire the hook again', async () => {
  const t = await lifeBoot({ sums: ownPlan(), detail: stepDetail() });
  assert.ok(t.panel());
  t.p.rightOpen('files');
  await tick();
  assert.strictEqual(t.panel(), null);
  assert.deepStrictEqual(t.calls.saved.at(-1), { 'claude-a': false });
  assert.deepStrictEqual(t.calls.feat, []);
});

test('Files winning: a plan open by flag or by auto-open stays closed while Files is on', async () => {
  const flagged = await lifeBoot({ sums: ownPlan(), files: true, stored: JSON.stringify({ 'claude-a': true }), detail: stepDetail() });
  assert.strictEqual(flagged.panel(), null);
  assert.deepStrictEqual(flagged.calls.saved.at(-1), { 'claude-a': false });
  const auto = await lifeBoot({ sums: ownPlan(), files: true, detail: stepDetail() });
  assert.strictEqual(auto.panel(), null);
  assert.deepStrictEqual(auto.calls.saved.at(-1), { 'claude-a': false });
  auto.filesState.on = false;
  auto.p.onState();
  await tick();
  assert.strictEqual(auto.panel(), null);
  assert.deepStrictEqual(auto.calls.feat, []);
});

test('the first Plan press with Files on opens the plan and closes Files', async () => {
  const t = await lifeBoot({ sums: ownPlan(), files: true, detail: stepDetail() });
  planBtn(t).attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.feat, [['rightOpen', 'plan']]);
  assert.ok(t.calls.saved.some(x => x['claude-a'] === true));
});

test('a phone ignores the right-panel hook', async () => {
  const t = await lifeBoot({ sums: ownPlan(), phone: true, detail: stepDetail() });
  t.p.rightOpen('files');
  assert.deepStrictEqual(t.calls.saved, []);
});
