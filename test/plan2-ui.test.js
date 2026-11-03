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

test('sinceText reports minutes then hours', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  assert.match(plan2.sinceText('2026-11-03T11:48:00Z', now), /\(12 min\)$/);
  assert.match(plan2.sinceText('2026-11-03T08:00:00Z', now), /\(4 h\)$/);
  assert.strictEqual(plan2.sinceText('', now), '');
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
