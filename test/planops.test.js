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
    [{ id: ID, q: 'q99', text: 'x' }, 409], [{ id: ID, q: { toString: 1, valueOf: 1 }, text: 'x' }, 409],
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

const pf = require('../lib/planfile');

const REL = 'demo-docs/release-notes';
const ARCHIVED = 'demo-app/_archive/2026-10-28-onboarding';

function lifecycle(t) {
  const s = setup(t);
  const store = createPlanStore({ root: s.root });
  const ops = createPlanOps({ store, root: s.root });
  const dir = id => path.join(s.root, id);
  const meta = id => pf.readPlan(dir(id)).doc.meta;
  const events = id => pf.readEvents(dir(id)).events;
  return { ...s, ops, store, dir, meta, events };
}

test('plan-finish, plan-archive and plan-restore refuse bad ids and write nothing', async t => {
  const e = lifecycle(t);
  const snapshot = () => e.store.summaries({ archived: true }).map(p => [p.id, p.status, p.mtime]);
  const before = snapshot();
  for (const op of ['finish', 'archive', 'restore']) {
    for (const body of [null, [], {}, { id: 5 }, { id: 'demo-app/nope' }, { id: '../../etc' }, { id: 'demo-app' }, { id: 'demo-app/_archive/../search-v2' }]) {
      const r = await e.ops[op](body);
      assert.deepStrictEqual(r, { status: 404, body: { ok: false, error: 'no such plan' } }, `${op} ${JSON.stringify(body)}`);
    }
  }
  assert.strictEqual((await e.ops.finish({ id: ARCHIVED })).status, 400);
  assert.strictEqual((await e.ops.archive({ id: ARCHIVED })).status, 400);
  assert.strictEqual((await e.ops.restore({ id: ID })).status, 400);
  assert.deepStrictEqual(snapshot(), before);
  fs.rmSync(path.join(e.root, 'demo-app', '.repo'));
  assert.strictEqual((await e.ops.finish({ id: ID })).status, 409);
  assert.strictEqual((await e.ops.archive({ id: ID })).status, 409);
  assert.strictEqual((await e.ops.restore({ id: ARCHIVED })).status, 409);
});

test('plan-finish marks the plan and answers the same id, twice', async t => {
  const e = lifecycle(t);
  assert.deepStrictEqual(await e.ops.finish({ id: ID }), { status: 200, body: { ok: true, id: ID } });
  assert.strictEqual(e.meta(ID).status, 'finished');
  assert.deepStrictEqual(e.events(ID).pop().text, 'marked finished');
  const n = e.events(ID).length;
  assert.deepStrictEqual(await e.ops.finish({ id: ID }), { status: 200, body: { ok: true, id: ID } });
  assert.strictEqual(e.events(ID).length, n);
});

test('plan-archive answers the archived id, plan-restore brings it back under its topic', async t => {
  const e = lifecycle(t);
  const folder = `${pf.iso().slice(0, 10)}-release-notes`;
  const a = await e.ops.archive({ id: REL });
  assert.deepStrictEqual(a, { status: 200, body: { ok: true, id: `demo-docs/_archive/${folder}` } });
  assert.strictEqual(e.store.find(REL), null);
  assert.strictEqual(e.store.find(a.body.id).archived, true);
  const r = await e.ops.restore({ id: a.body.id });
  assert.deepStrictEqual(r, { status: 200, body: { ok: true, id: REL } });
  assert.strictEqual(e.meta(REL).status, 'finished');
  assert.strictEqual(e.events(REL).pop().type, 'restore');
  assert.strictEqual(e.store.find(a.body.id), null);
});

test('plan-restore of an archived folder with another name uses the frontmatter topic for the id', async t => {
  const e = lifecycle(t);
  const r = await e.ops.restore({ id: ARCHIVED });
  assert.deepStrictEqual(r, { status: 200, body: { ok: true, id: 'demo-app/onboarding' } });
  assert.strictEqual(e.meta('demo-app/onboarding').status, 'finished');
});

test('plan-restore answers 409 when the topic is taken, and the error is one clean line', async t => {
  const e = lifecycle(t);
  const a = await e.ops.archive({ id: REL });
  pf.writePlan(e.dir(REL), pf.newPlan({ topic: 'release-notes', title: 'Again', repo: '/srv/demo-docs' }));
  const r = await e.ops.restore({ id: a.body.id });
  assert.deepStrictEqual(r, { status: 409, body: { ok: false, error: 'plan release-notes already exists for /srv/demo-docs' } });
  assert.ok(e.store.find(a.body.id));
});

test('plan-archive refuses a plan with errors and the plan stays', async t => {
  const e = lifecycle(t);
  const file = path.join(e.dir(REL), 'plan.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- [x] T1', '- [z] T1'));
  const r = await e.ops.archive({ id: REL });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /^plan\.md has errors/);
  assert.ok(!r.body.error.includes('\n'));
  assert.ok(fs.existsSync(file));
});

test('a q that cannot become a string is a clean 409', async t => {
  const { ops } = setup(t);
  assert.deepStrictEqual(await ops.answer({ id: ID, q: JSON.parse('{"toString":1,"valueOf":1}'), text: 'x' }), { status: 409, body: { ok: false, error: 'no open question' } });
  assert.deepStrictEqual(await ops.answer({ id: ID, text: 'x' }), { status: 409, body: { ok: false, error: 'no open question' } });
});

const NO_STORE = { status: 403, body: { ok: false, error: 'test copy has no plan store' } };
const REAL_STORE = path.join(os.userInfo().homedir, '.beast', 'plans');

const guardAnswer = env => createPlanOps({ store: { find: () => null }, root: '/nonexistent', env }).finish({ id: 'demo/x' }).then(r => r.status);

test('a test copy only reaches its own BEAST_PLANS_DIR, never the real store', async () => {
  assert.strictEqual(await guardAnswer({}), 404);
  assert.strictEqual(await guardAnswer({ BEAST_PLANS_DIR: '/tmp/x' }), 404);
  assert.strictEqual(await guardAnswer({ BD_TEST: '1' }), 403);
  assert.strictEqual(await guardAnswer({ BD_TEST: '1', HOME: '/tmp/fake-home' }), 403);
  assert.strictEqual(await guardAnswer({ BD_TEST: '1', BEAST_PLANS_DIR: REAL_STORE }), 403);
  assert.strictEqual(await guardAnswer({ BD_TEST: '1', BEAST_PLANS_DIR: REAL_STORE + '/' }), 403);
  assert.strictEqual(await guardAnswer({ BD_TEST: '1', BEAST_PLANS_DIR: path.join(REAL_STORE, 'demo') }), 403);
  assert.strictEqual(await guardAnswer({ BD_TEST: '1', BEAST_PLANS_DIR: path.relative(process.cwd(), REAL_STORE) }), 403);
  assert.strictEqual(await guardAnswer({ BD_TEST: '1', BEAST_PLANS_DIR: REAL_STORE + '-copy' }), 404);
  assert.strictEqual(await guardAnswer({ BD_TEST: '1', BEAST_PLANS_DIR: path.join(os.tmpdir(), 'bd-gate-x', 'plans-store') }), 404);
});

test('a symlink to the real store does not get past the guard', { skip: !fs.existsSync(REAL_STORE) }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-planops-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'plans');
  fs.symlinkSync(REAL_STORE, link);
  assert.strictEqual(await guardAnswer({ BD_TEST: '1', BEAST_PLANS_DIR: link }), 403);
});

const ENDPOINTS = { answer: { id: ID, q: 'q1', text: 'x' }, finish: { id: ID }, archive: { id: ID }, restore: { id: ARCHIVED } };

for (const [op, body] of Object.entries(ENDPOINTS)) {
  test(`plan-${op}: a test copy without its own store gets 403 and nothing is written; with its own store it runs`, async t => {
    const e = lifecycle(t);
    const stateOf = () => e.store.summaries({ archived: true }).map(p => [p.id, p.status, p.mtime]);
    const before = stateOf();
    const refused = createPlanOps({ store: e.store, root: e.root, env: { BD_TEST: '1' } });
    assert.deepStrictEqual(await refused[op](body), NO_STORE);
    assert.deepStrictEqual(await refused[op](null), NO_STORE);
    const real = createPlanOps({ store: e.store, root: e.root, env: { BD_TEST: '1', BEAST_PLANS_DIR: REAL_STORE } });
    assert.deepStrictEqual(await real[op](body), NO_STORE);
    assert.deepStrictEqual(stateOf(), before);
    const own = createPlanOps({ store: e.store, root: e.root, env: { BD_TEST: '1', BEAST_PLANS_DIR: e.root } });
    assert.strictEqual((await own[op](body)).status, 200);
  });
}
