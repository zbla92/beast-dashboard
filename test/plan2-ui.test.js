const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-plan2.js'), 'utf8');
const boot = (extra = {}) => {
  const FEAT = {};
  vm.runInNewContext(src, {
    FEAT, ICONS: {}, S: { settings: { plans: true }, runtime: { sessions: [] } }, TERM: { open: false },
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
    n.listeners = {};
    n.addEventListener = (type, fn) => { n.listeners[type] = fn; };
    n.replaceChildren = (...k) => { n.kids = k.flat(Infinity).filter(x => x != null && x !== false); };
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

test('the actions menu offers Update plan, disabled with a hint when no live session runs the plan', () => {
  const plan = { id: 'a/t', topic: 't', sessions: ['claude-a'], finished: false, done: 0, total: 0 };
  const menuOf = state => {
    const { dom, p } = noteBoot([sess('claude-a', { state })], 'claude-a');
    find(p.actionsMenu(plan, () => {}), n => n.attrs.class && n.attrs.class.includes('fp2-act-b'))[0].attrs.onclick();
    const menu = find(p.actionsMenu(plan, () => {}), n => n.attrs.class === 'menu fp2-actm')[0];
    return { dom, menu, items: find(menu, n => n.attrs.role === 'menuitem') };
  };
  const live = menuOf('idle');
  assert.strictEqual(live.items[0].attrs.class, 'mi');
  assert.ok(live.dom.text(live.menu).includes('Update plan…'));
  const off = menuOf('ended');
  assert.strictEqual(off.items[0].attrs.class, 'mi dis');
  assert.ok(off.dom.text(off.menu).includes('No live session runs this plan'));
});

test('the no-plan row offers Make a plan for a live Claude session and keeps the org count with a chevron', () => {
  const { dom, p } = noteBoot([sess('claude-a', { state: 'idle' })], 'claude-a');
  const alone = p.quietStrip('claude-a', [], '', false);
  assert.strictEqual(dom.text(alone), 'No plan·Make a plan…Archived');
  assert.strictEqual(find(alone, n => n.attrs.class === 'fp2-np-org').length, 0);
  const org = p.quietStrip('claude-a', [{}, {}], 'acme', true);
  assert.ok(dom.text(org).endsWith('2 in acme'));
  assert.strictEqual(find(org, n => n.attrs.class === 'fp2-np-org').length, 1);
  const ended = noteBoot([sess('claude-a', { state: 'ended' })], 'claude-a');
  const btn = find(ended.p.quietStrip('claude-a', [], '', false), n => n.attrs.class === 'fp2-np-b')[0];
  assert.strictEqual(btn.attrs.disabled, true);
  assert.ok(!btn.attrs.title);
  assert.strictEqual(ended.dom.text(ended.p.quietStrip('claude-a', [], '', false)), 'No plan·Make a plan…No live session runs this planArchived');
});

const FIN_AT = '2026-11-04T11:52:00.000Z';
const plan = (id, projectId, extra = {}) => ({
  id, topic: id.split('/').pop(), title: id, projectId, archived: null, sessions: [], waiting: [], done: 1, total: 2, pct: 50, complete: false,
  phase: null, lastGate: null, now: null, next: null, mtime: 1, finished: false, finishedAt: null, ...extra,
});
const finishedPlan = (id, projectId, extra = {}) => plan(id, projectId, { done: 2, pct: 100, complete: true, finished: true, finishedAt: FIN_AT, ...extra });
const tick = () => Array.from({ length: 6 }).reduce(wait => wait.then(() => new Promise(r => setImmediate(r))), Promise.resolve());

const lifeBoot = async ({ sums, archived = [], phone = false, active = 'claude-a', project = 'web', fail = null, failList = null, post = null, claude = { state: 'idle' } }) => {
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
  const calls = { api: [], toast: [] };
  const store = { sums, archived };
  const S = { settings: { plans: true }, projects, runtime: { sessions: [{ name: active, project, claude }] } };
  const p = boot({
    document: dom.document, h, ico: dom.ico, requestAnimationFrame() {}, S,
    TERM: { open: true, active }, matchMedia: () => ({ matches: phone }),
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
      if (path.startsWith('plan/')) return { phases: [], timeline: [], waiting: [], mtime: 1 };
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
  const footerArchive = () => find(byClass('fp2-fin')[0], n => n.tag === 'button')[0];
  return { dom, p, calls, store, panel, byClass, button, topic, paths, openActions, menuItems, reg, dialog, dialogButton, scrim, footerArchive };
};
const clockOf = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const dateOf = ts => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });

test('the menu shows Mark finished with the open tasks as its sub-line, and always Archive', async () => {
  const t = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'], done: 3, total: 7 })] });
  t.openActions();
  const texts = t.menuItems().map(n => t.dom.text(n));
  assert.deepStrictEqual(texts, ['Update plan…Tell Claude what to change', 'New plan…Ask Claude to make a plan', 'Mark finished4 tasks still open', 'ArchiveHide it; restore any time from the plan list']);
  const menu = t.byClass('fp2-actm')[0];
  assert.deepStrictEqual(menu.kids.map(k => k.attrs.class), ['mi', 'mi', 'mi', 'sep', 'mi']);
});

test('Mark finished says one task in the singular, has no sub-line with nothing open, and is gone once finished', async () => {
  const one = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'], done: 1, total: 2 })] });
  one.openActions();
  assert.strictEqual(one.dom.text(one.menuItems()[2]), 'Mark finished1 task still open');
  const empty = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'], done: 0, total: 0 })] });
  empty.openActions();
  assert.strictEqual(empty.dom.text(empty.menuItems()[2]), 'Mark finished');
  const done = await lifeBoot({ sums: [finishedPlan('web/one', 'web', { sessions: ['claude-a'] })] });
  done.openActions();
  assert.deepStrictEqual(done.menuItems().map(n => done.dom.text(n)), ['Update plan…Tell Claude what to change', 'New plan…Ask Claude to make a plan', 'ArchiveHide it; restore any time from the plan list']);
});

test('Mark finished posts the plan id, toasts and reloads; a server error shows as it is and nothing reloads', async () => {
  const t = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'] })], post: (store, path, body) => {
    store.sums = [finishedPlan(body.id, 'web', { sessions: ['claude-a'] })];
    return { ok: true, id: body.id };
  } });
  t.openActions();
  const before = t.paths().filter(x => x === 'plans?v=2').length;
  t.menuItems()[2].attrs.onclick();
  t.dialogButton('Mark finished').attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.api.find(c => c[0] === 'plan-finish'), ['plan-finish', { id: 'web/one' }]);
  assert.strictEqual(t.paths().filter(x => x === 'plans?v=2').length, before + 1);
  assert.deepStrictEqual(t.calls.toast, [['one marked finished', 'ok']]);
  assert.strictEqual(t.byClass('fp2-fin').length, 1);

  const bad = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'] })], fail: 'plan has no repo marker' });
  bad.openActions();
  const was = bad.paths().filter(x => x === 'plans?v=2').length;
  bad.menuItems()[2].attrs.onclick();
  bad.dialogButton('Mark finished').attrs.onclick();
  await tick();
  assert.deepStrictEqual(bad.calls.toast, [['plan has no repo marker', 'err']]);
  assert.strictEqual(bad.paths().filter(x => x === 'plans?v=2').length, was);
});

test('a finished plan shows the badge and the exact footer with an Archive button', async () => {
  const t = await lifeBoot({ sums: [finishedPlan('web/one', 'web', { sessions: ['claude-a'] })] });
  assert.strictEqual(t.dom.text(t.byClass('fp2-badge-h')[0]), 'Finished');
  assert.strictEqual(t.dom.text(t.byClass('fp2-fin-t')[0]), `Finished ${clockOf(FIN_AT)}.`);
  assert.strictEqual(t.dom.text(find(t.byClass('fp2-fin')[0], n => n.tag === 'button')[0]), 'Archive');
  const active = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'] })] });
  assert.strictEqual(active.dom.text(active.byClass('fp2-badge-h')[0]), '');
  assert.strictEqual(active.byClass('fp2-fin').length, 0);
});

test('the footer leaves out a time it does not have', async () => {
  const t = await lifeBoot({ sums: [finishedPlan('web/one', 'web', { sessions: ['claude-a'], finishedAt: null })] });
  assert.strictEqual(t.dom.text(t.byClass('fp2-fin-t')[0]), 'Finished');
  assert.strictEqual(t.dom.text(t.byClass('fp2-badge-h')[0]), 'Finished');
  assert.strictEqual(t.dom.text(t.footerArchive()), 'Archive');
});

const archivePost = (store, path, body) => {
  store.sums = store.sums.filter(x => x.id !== body.id);
  return { ok: true, id: body.id.replace('/', '/_archive/2026-11-04-') };
};

test('Archive on the viewed plan falls back to the session plan and does not come back to the old id', async () => {
  const own = plan('web/own', 'web', { sessions: ['claude-a'] });
  const t = await lifeBoot({ sums: [own, finishedPlan('api/other', 'api')], post: archivePost });
  t.button('other')[0].attrs.onclick();
  await tick();
  assert.strictEqual(t.topic(), 'other');
  t.footerArchive().attrs.onclick();
  t.dialogButton('Archive').attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.api.find(c => c[0] === 'plan-archive'), ['plan-archive', { id: 'api/other' }]);
  assert.deepStrictEqual(t.calls.toast, [['other archived', 'ok']]);
  assert.strictEqual(t.topic(), 'own');
  t.store.sums = [own, finishedPlan('api/other', 'api')];
  t.p.live();
  await tick();
  assert.strictEqual(t.topic(), 'own');
});

test('Archive on the only plan of the org closes the panel and leaves the no-plan row', async () => {
  const t = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] })], post: archivePost });
  t.openActions();
  t.menuItems()[3].attrs.onclick();
  t.dialogButton('Archive').attrs.onclick();
  await tick();
  assert.strictEqual(t.panel(), null);
  assert.ok(t.dom.text(t.reg['fp2-strip']).startsWith('No plan'));
});

test('Archive refused by the server keeps the plan and shows the error as it is', async () => {
  const t = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] })], fail: 'no such plan' });
  t.openActions();
  t.menuItems()[3].attrs.onclick();
  t.dialogButton('Archive').attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.toast, [['no such plan', 'err']]);
  assert.strictEqual(t.topic(), 'own');
});

test('a second press while a lifecycle call is running sends nothing', async () => {
  const t = await lifeBoot({ sums: [finishedPlan('web/own', 'web', { sessions: ['claude-a'] })], post: archivePost });
  t.footerArchive().attrs.onclick();
  const btn = t.dialogButton('Archive');
  btn.attrs.onclick();
  btn.attrs.onclick();
  await tick();
  assert.strictEqual(t.paths().filter(x => x === 'plan-archive').length, 1);
});

const POSTS = ['plan-finish', 'plan-archive', 'plan-restore', 'plan-answer'];
const posted = t => t.paths().filter(x => POSTS.includes(x));
const ENTRIES = {
  'menu Mark finished': { sums: () => [plan('web/one', 'web', { sessions: ['claude-a'] })], open: t => { t.openActions(); t.menuItems()[2].attrs.onclick(); }, action: 'Mark finished', path: 'plan-finish' },
  'menu Archive': { sums: () => [plan('web/one', 'web', { sessions: ['claude-a'] })], open: t => { t.openActions(); t.menuItems()[3].attrs.onclick(); }, action: 'Archive', path: 'plan-archive' },
  'footer Archive': { sums: () => [finishedPlan('web/one', 'web', { sessions: ['claude-a'] })], open: t => t.footerArchive().attrs.onclick(), action: 'Archive', path: 'plan-archive' },
};
const okPost = (store, path, body) => ({ ok: true, id: body.id });

for (const [name, entry] of Object.entries(ENTRIES)) {
  test(`${name}: nothing is sent until the action button; Cancel, Esc and the scrim send nothing`, async () => {
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
    t.dialogButton(entry.action).attrs.onclick();
    await tick();
    assert.strictEqual(t.dialog(), null);
    assert.deepStrictEqual(t.calls.api.filter(c => POSTS.includes(c[0])), [[entry.path, { id: 'web/one' }]]);
  });
}

const dialogTexts = t => [t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-top')[0]), t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-confirm')[0])];

test('Mark finished asks with the exact text, plural, singular and with nothing open', async () => {
  const askFor = async extra => {
    const t = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-a'], ...extra })] });
    t.openActions();
    t.menuItems()[2].attrs.onclick();
    return dialogTexts(t);
  };
  assert.deepStrictEqual(await askFor({ done: 3, total: 7 }), ['Mark one as finished?', '4 tasks still open.CancelMark finished']);
  assert.deepStrictEqual(await askFor({ done: 1, total: 2 }), ['Mark one as finished?', '1 task still open.CancelMark finished']);
  assert.deepStrictEqual(await askFor({ done: 0, total: 0 }), ['Mark one as finished?', 'CancelMark finished']);
});

test('Archive asks with the same exact sheet from the menu and from the footer', async () => {
  const t = await lifeBoot({ sums: [finishedPlan('web/one', 'web', { sessions: ['claude-a'] })] });
  const want = ['Archive one?', 'It disappears from the panel. You can restore it from the plan list.CancelArchive'];
  t.footerArchive().attrs.onclick();
  assert.deepStrictEqual(dialogTexts(t), want);
  t.dialogButton('Cancel').attrs.onclick();
  t.openActions();
  t.menuItems()[2].attrs.onclick();
  assert.deepStrictEqual(dialogTexts(t), want);
});

test('New plan… is in the menu of every plan and opens the Make a plan sheet for the active session', async () => {
  const own = plan('web/own', 'web', { sessions: ['claude-a'] });
  const other = plan('api/other', 'api', { sessions: ['claude-other'] });
  for (const [sums, view] of [[[own], null], [[finishedPlan('web/one', 'web', { sessions: ['claude-a'] })], null], [[own, other], 'other']]) {
    const t = await lifeBoot({ sums });
    if (view) {
      t.button(view)[0].attrs.onclick();
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
  assert.strictEqual(t.reg['fp2-strip'], undefined);
  assert.strictEqual(t.panel(), null);
  const empty = await lifeBoot({ active: 'sh-1', claude: null, sums: [] });
  assert.strictEqual(empty.reg['fp2-strip'], undefined);
});

test('a shell session that a plan is mapped to keeps its strip; a Claude session with org plans keeps the no-plan row', async () => {
  const mapped = await lifeBoot({ active: 'sh-1', claude: null, sums: [plan('web/one', 'web', { sessions: ['sh-1'] })] });
  assert.ok(mapped.reg['fp2-strip']);
  assert.ok(!mapped.dom.text(mapped.reg['fp2-strip']).startsWith('No plan'));
  const claude = await lifeBoot({ sums: [plan('web/one', 'web', { sessions: ['claude-other'] })] });
  assert.ok(claude.dom.text(claude.reg['fp2-strip']).startsWith('No plan'));
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

test('desktop: the Archived chip loads the list only when it opens, also with one plan, with rows and Restore', async () => {
  const at = '2026-10-28T09:00:00.000Z';
  const t = await lifeBoot({
    sums: [plan('web/own', 'web', { sessions: ['claude-a'] })],
    archived: [arch('web/_archive/2026-10-12-old-web', 'web', '2026-10-12T09:00:00.000Z'), arch('api/_archive/2026-10-28-new-api', 'api', at, { done: 6, total: 8 }), arch('other/_archive/2026-11-01-zed-one', 'other', '2026-11-01T09:00:00.000Z')],
  });
  assert.ok(!t.paths().includes('plans?v=2&archived=1'));
  assert.strictEqual(t.byClass('fp2-aml').length, 0);
  t.byClass('fp2-archc')[0].attrs.onclick();
  await tick();
  assert.strictEqual(t.paths().filter(x => x === 'plans?v=2&archived=1').length, 1);
  const group = t.byClass('fp2-aml')[0];
  assert.strictEqual(t.dom.text(find(group, n => n.attrs.class === 'mh')[0]), 'Archived · 2');
  assert.deepStrictEqual(find(group, n => n.attrs.class === 'fp2-arow').map(n => t.dom.text(n)), [
    `new-api 6/8archived ${dateOf(at)}Restore`,
    `old-web 5/5archived ${dateOf('2026-10-12T09:00:00.000Z')}Restore`,
  ]);
});

test('phone: the menu lists this org with the Finished tag, then the Archived group, and says so when it is empty', async () => {
  const t = await lifeBoot({ phone: true, sums: [finishedPlan('web/own', 'web', { sessions: ['claude-a'] })] });
  find(t.reg['fp2-strip'], n => n.attrs.class === 'fp2-strip-b')[0].attrs.onclick();
  await tick();
  assert.strictEqual(t.byClass('fp2-archw').length, 0);
  assert.ok(t.dom.text(t.byClass('fp2-menu-b')[0]).endsWith('1 plan'));
  t.byClass('fp2-menu-b')[0].attrs.onclick();
  const loading = t.dom.text(t.byClass('fp2-aml')[0]);
  assert.ok(loading.includes('loading…'));
  await tick();
  const group = t.byClass('fp2-aml')[0];
  assert.deepStrictEqual(find(group, n => n.attrs.class === 'mh').map(n => t.dom.text(n)), ['This org', 'Archived']);
  assert.ok(t.dom.text(find(group, n => n.attrs.class && n.attrs.class.startsWith('fp2-chip'))[0]).endsWith('Finished'));
  assert.ok(t.dom.text(group).includes('No archived plans'));
});

test('a failed archived list shows the error instead of staying on loading', async () => {
  const t = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] })], failList: 'list failed' });
  t.byClass('fp2-archc')[0].attrs.onclick();
  await tick();
  assert.ok(t.dom.text(t.byClass('fp2-aml')[0]).includes('list failed'));
});

test('Restore posts the archived id, shows the restored plan under its returned id and closes the menu', async () => {
  const own = plan('web/own', 'web', { sessions: ['claude-a'] });
  const t = await lifeBoot({
    sums: [own], archived: [arch('web/_archive/2026-10-12-old-web', 'web', '2026-10-12T09:00:00.000Z')],
    post: store => {
      store.archived = [];
      store.sums = [own, plan('web/old-web', 'web')];
      return { ok: true, id: 'web/old-web' };
    },
  });
  t.byClass('fp2-archc')[0].attrs.onclick();
  await tick();
  find(t.byClass('fp2-arow')[0], n => n.tag === 'button')[0].attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.api.find(c => c[0] === 'plan-restore'), ['plan-restore', { id: 'web/_archive/2026-10-12-old-web' }]);
  assert.strictEqual(t.dialog(), null);
  assert.deepStrictEqual(t.calls.toast, [['old-web restored', 'ok']]);
  assert.strictEqual(t.topic(), 'old-web');
  assert.strictEqual(t.byClass('fp2-aml').length, 0);
});

test('Restore refused by the server keeps the row and shows the error as it is', async () => {
  const err = 'plan old-web already exists for /r/web';
  const t = await lifeBoot({ fail: err, sums: [plan('web/own', 'web', { sessions: ['claude-a'] })], archived: [arch('web/_archive/2026-10-12-old-web', 'web', '2026-10-12T09:00:00.000Z')] });
  t.byClass('fp2-archc')[0].attrs.onclick();
  await tick();
  find(t.byClass('fp2-arow')[0], n => n.tag === 'button')[0].attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.toast, [[err, 'err']]);
  assert.strictEqual(t.byClass('fp2-arow').length, 1);
  assert.strictEqual(t.topic(), 'own');
});

const noPlanArchived = t => find(t.reg['fp2-strip'], n => n.attrs.class === 'fp2-np-arch')[0];
const archRows = t => find(t.dialog(), n => n.attrs.class === 'fp2-arow');
const ARCHIVED_ORG = [
  arch('web/_archive/2026-10-12-old-web', 'web', '2026-10-12T09:00:00.000Z'),
  arch('api/_archive/2026-10-28-new-api', 'api', '2026-10-28T09:00:00.000Z', { done: 6, total: 8 }),
  arch('other/_archive/2026-11-01-zed-one', 'other', '2026-11-01T09:00:00.000Z'),
];

test('no-plan row: Archived loads the list only when pressed, in a sheet with the org plans, newest first', async () => {
  const t = await lifeBoot({ sums: [], archived: ARCHIVED_ORG });
  assert.strictEqual(t.dom.text(noPlanArchived(t)), 'Archived');
  assert.ok(!t.paths().includes('plans?v=2&archived=1'));
  noPlanArchived(t).attrs.onclick();
  assert.strictEqual(t.dom.text(t.dialog()).includes('loading…'), true);
  await tick();
  assert.strictEqual(t.paths().filter(x => x === 'plans?v=2&archived=1').length, 1);
  assert.ok(t.dom.text(find(t.dialog(), n => n.attrs.class === 'fp2-sh-top')[0]).startsWith('Archived'));
  assert.deepStrictEqual(archRows(t).map(n => t.dom.text(n)), [
    `new-api 6/8archived ${dateOf('2026-10-28T09:00:00.000Z')}Restore`,
    `old-web 5/5archived ${dateOf('2026-10-12T09:00:00.000Z')}Restore`,
  ]);
});

test('no-plan row: a session with no project lists every archived plan, newest first', async () => {
  const t = await lifeBoot({ sums: [], archived: ARCHIVED_ORG, project: null });
  noPlanArchived(t).attrs.onclick();
  await tick();
  assert.deepStrictEqual(archRows(t).map(n => t.dom.text(find(n, x => x.attrs.class === 'fp2-cn')[0])), ['zed-one', 'new-api', 'old-web']);
});

test('no-plan row: the sheet says so when nothing is archived, and shows a failed list as its error', async () => {
  const empty = await lifeBoot({ sums: [], archived: [ARCHIVED_ORG[2]] });
  noPlanArchived(empty).attrs.onclick();
  await tick();
  assert.strictEqual(archRows(empty).length, 0);
  assert.strictEqual(empty.dom.text(find(empty.dialog(), n => n.attrs.class === 'fp2-sh-body')[0]), 'No archived plans.');
  const failed = await lifeBoot({ sums: [], failList: 'list failed' });
  noPlanArchived(failed).attrs.onclick();
  await tick();
  assert.ok(failed.dom.text(failed.dialog()).includes('list failed'));
});

test('no-plan row: Archived works on an ended session too, where Make a plan is disabled', async () => {
  const t = await lifeBoot({ sums: [], archived: ARCHIVED_ORG, claude: { state: 'ended' } });
  assert.strictEqual(find(t.reg['fp2-strip'], n => n.attrs.class === 'fp2-np-b')[0].attrs.disabled, true);
  assert.ok(!noPlanArchived(t).attrs.disabled);
  noPlanArchived(t).attrs.onclick();
  await tick();
  assert.strictEqual(archRows(t).length, 2);
});

test('no-plan row: Restore in the sheet posts the archived id with no extra question and closes the sheet', async () => {
  const t = await lifeBoot({
    sums: [], archived: [ARCHIVED_ORG[0]],
    post: store => {
      store.archived = [];
      store.sums = [plan('web/old-web', 'web')];
      return { ok: true, id: 'web/old-web' };
    },
  });
  noPlanArchived(t).attrs.onclick();
  await tick();
  find(archRows(t)[0], n => n.tag === 'button')[0].attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.api.find(c => c[0] === 'plan-restore'), ['plan-restore', { id: 'web/_archive/2026-10-12-old-web' }]);
  assert.strictEqual(t.dialog(), null);
  assert.deepStrictEqual(t.calls.toast, [['old-web restored', 'ok']]);
  assert.ok(t.dom.text(t.reg['fp2-strip']).includes('1 in'));
});

test('no-plan row: a refused Restore keeps the sheet and its row and shows the error as it is', async () => {
  const err = 'plan old-web already exists for /r/web';
  const t = await lifeBoot({ fail: err, sums: [], archived: [ARCHIVED_ORG[0]] });
  noPlanArchived(t).attrs.onclick();
  await tick();
  find(archRows(t)[0], n => n.tag === 'button')[0].attrs.onclick();
  await tick();
  assert.deepStrictEqual(t.calls.toast, [[err, 'err']]);
  assert.strictEqual(archRows(t).length, 1);
});

test('no-plan row: a late list after the sheet closed draws nothing and later plan events do not refetch it', async () => {
  const t = await lifeBoot({ sums: [], archived: ARCHIVED_ORG });
  noPlanArchived(t).attrs.onclick();
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
  noPlanArchived(t).attrs.onclick();
  await tick();
  assert.strictEqual(archRows(t).length, 1);
  t.store.archived = [ARCHIVED_ORG[0], ARCHIVED_ORG[1]];
  t.p.plan({ id: 'api/_archive/2026-10-28-new-api', mtime: 2 });
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(archRows(t).length, 2);
});

test('a shell session gets no Archived entry and no strip at all', async () => {
  const t = await lifeBoot({ sums: [], archived: ARCHIVED_ORG, active: 'sh-1', claude: null });
  assert.strictEqual(t.reg['fp2-strip'], undefined);
  assert.ok(!t.paths().includes('plans?v=2&archived=1'));
});

test('a click outside the switcher closes the Archived list, a click inside keeps it', async () => {
  const t = await lifeBoot({ sums: [plan('web/own', 'web', { sessions: ['claude-a'] })] });
  t.byClass('fp2-archc')[0].attrs.onclick();
  await tick();
  const click = t.dom.listeners.find(l => l.type === 'click').fn;
  click({ target: { closest: sel => sel === '.fp2-swi' ? {} : null } });
  assert.strictEqual(t.byClass('fp2-aml').length, 1);
  click({ target: { closest: () => null } });
  assert.strictEqual(t.byClass('fp2-aml').length, 0);
});

test('the timeline names finish, reopen and restore', () => {
  const { dom, p } = detailBoot();
  const { nav } = navStub();
  const d = { ...detail, timeline: [ev('finish', { text: 'marked finished' }), ev('reopen'), ev('restore')] };
  const t = dom.text(p.phaseSheet({ topic: 'checkout' }, d, 1, nav).body);
  for (const part of ['finishedmarked finished', 'reopened', 'restored']) assert.ok(t.includes(part), part);
});
