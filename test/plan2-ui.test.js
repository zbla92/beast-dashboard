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
