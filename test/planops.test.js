const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPlanStore } = require('../lib/plans2');
const { createPlanOps } = require('../lib/planops');

const FIX = path.join(__dirname, 'fixtures', 'plans', 'store');
const ID = 'demo-app/search-v2';

function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-planops-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'plans');
  fs.cpSync(FIX, root, { recursive: true });
  const ops = createPlanOps({ store: createPlanStore({ root }), root });
  const answers = () => fs.readFileSync(path.join(root, 'demo-app', 'search-v2', 'events.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'answer');
  return { root, ops, answers };
}

test('plan-answer refuses bad input with the contract status and writes nothing', async t => {
  const { root, ops, answers } = setup(t);
  const before = answers().length;
  const cases = [
    [null, 404], [[], 404], [{ id: 5, q: 'q1', text: 'x' }, 404], [{ id: 'demo-app/nope', q: 'q1', text: 'x' }, 404],
    [{ id: '../../etc', q: 'q1', text: 'x' }, 404],
    [{ id: 'demo-app/_archive/2026-10-28-onboarding', q: 'q1', text: 'x' }, 400],
    [{ id: ID, q: '1;rm', text: 'x' }, 409], [{ id: ID, q: 'q1234567', text: 'x' }, 409],
    [{ id: ID, q: 'q1', text: 7 }, 400], [{ id: ID, q: 'q1', text: '   ' }, 400],
    [{ id: ID, q: 'q1', text: 'a'.repeat(2001) }, 400], [{ id: ID, q: 'q1', text: 'a\nb' }, 400],
    [{ id: ID, q: 'q99', text: 'x' }, 409],
  ];
  for (const [body, status] of cases) {
    const r = await ops.answer(body);
    assert.strictEqual(r.status, status, JSON.stringify(body));
    assert.strictEqual(r.body.ok, false);
    assert.ok(r.body.error);
  }
  assert.strictEqual(answers().length, before);
  fs.rmSync(path.join(root, 'demo-app', '.repo'));
  assert.strictEqual((await ops.answer({ id: ID, q: 'q1', text: 'x' })).status, 409);
});

test('plan-answer records the answer through bin/plan, keeps flag-like text, then refuses a second answer', async t => {
  const { ops, answers } = setup(t);
  const r = await ops.answer({ id: ID, q: 'q1', text: '  --plan=x copy them  ' });
  assert.deepStrictEqual(r, { status: 200, body: { ok: true, id: ID } });
  assert.deepStrictEqual(answers().map(e => [e.q, e.text]).pop(), ['q1', '--plan=x copy them']);
  const again = await ops.answer({ id: ID, q: 'q1', text: 'other' });
  assert.deepStrictEqual(again, { status: 409, body: { ok: false, error: 'no open question q1' } });
});

test('plan-answer runs one at a time and maps the plan exit code', async t => {
  const { ops, answers } = setup(t);
  const [a, b] = await Promise.all([
    ops.answer({ id: ID, q: 'q1', text: 'first' }),
    ops.answer({ id: ID, q: 'q1', text: 'second' }),
  ]);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 409);
  assert.match(b.body.error, /^no open question q1$/);
  assert.deepStrictEqual(answers().filter(e => e.q === 'q1').map(e => e.text), ['first']);
});

test('a plan run that cannot start answers 500 and the queue keeps running the next one', async t => {
  const { root, answers } = setup(t);
  const store = createPlanStore({ root });
  const bad = { find: id => ({ ...store.find(id), repo: 'demo\0app' }) };
  const broken = createPlanOps({ store: bad, root });
  const r = await broken.answer({ id: ID, q: 'q1', text: 'x' });
  assert.strictEqual(r.status, 500);
  assert.match(r.body.error, /^plan did not start/);
  bad.find = store.find;
  const ok = await broken.answer({ id: ID, q: 'q1', text: 'after' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(answers().map(e => e.text).pop(), 'after');
});
