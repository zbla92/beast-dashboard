const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pf = require('../lib/planfile');

const FIX = path.join(__dirname, 'fixtures', 'plans');
const STORE = path.join(FIX, 'store');
const MID = path.join(STORE, 'demo-app', 'search-v2');
const ARCH = path.join(STORE, 'demo-app', '_archive', '2026-10-28-onboarding');
const read = f => fs.readFileSync(f, 'utf8');
const midText = () => read(path.join(MID, 'plan.md'));
const mid = () => pf.parse(midText());
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function tmp(t, prefix = 'bd-plans-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repo(t, name = 'demo-app') {
  const dir = path.join(tmp(t, 'bd-plans-repo-'), name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

function makePlan(root, main, topic, status = 'active') {
  const repoDir = pf.repoDirFor(root, main, { create: true });
  const doc = pf.newPlan({ topic, title: topic, repo: main, created: '2026-11-03T08:00:00Z' });
  if (status === 'done') pf.archive(doc, new Date('2026-11-03T09:00:00Z'));
  pf.writePlan(pf.planDir(root, repoDir, topic), doc);
  return repoDir;
}

test('parse: frontmatter, preamble and the fixed sections of a mid-progress plan', () => {
  const d = mid();
  assert.deepStrictEqual(d.errors, []);
  assert.deepStrictEqual(d.warnings, []);
  assert.deepStrictEqual(d.meta, { topic: 'search-v2', title: 'Search v2', repo: '/srv/demo-app', status: 'active', created: '2026-11-03T07:58:00Z' });
  assert.match(d.preamble.text, /^Goal: replace the LIKE-based/);
  assert.deepStrictEqual(d.sections.map(s => s.kind), ['next', 'waiting', 'phase', 'phase', 'phase', 'raw']);
  assert.strictEqual(d.sections[0].body.text, 'T6 Query endpoint: finish cursor pagination (`after` param), then run the gate.\nIf the gate is red, fix it before starting T7.');
  const raw = d.sections[5];
  assert.strictEqual(raw.heading, 'Decisions');
  assert.match(raw.body.text, /## Not a heading \(inside a fence\)/);
});

test('parse: every task status, model, gate and task-card body', () => {
  const d = mid();
  const t = id => pf.findTask(d, id);
  assert.deepStrictEqual(pf.tasks(d).map(x => x.status), ['done', 'done', 'done', 'done', 'failed', 'doing', 'todo', 'todo', 'blocked', 'todo']);
  assert.deepStrictEqual([t('T1').model, t('T8').model, t('T9').model, t('T10').model], ['Opus', 'Haiku', 'Opus', null]);
  assert.deepStrictEqual(t('T1').gate, { ok: true, text: '12 tests' });
  assert.deepStrictEqual(t('T5').gate, { ok: false, text: 'lint · 2 errors' });
  assert.strictEqual(t('T6').gate, null);
  assert.strictEqual(t('T1').body, 'Goal: freeze the search_documents table and its tsvector column.\nOwns: db/migrations/0042_search.sql, lib/search/schema.js\nGate: npm test -- search/schema');
  assert.strictEqual(t('T6').body.split('\n')[3], '');
  assert.strictEqual(t('T6').body.split('\n')[4], 'Gate: npm test && npm run lint');
  assert.strictEqual(t('T2').body, '');
  assert.deepStrictEqual(pf.phases(d).map(p => [p.n, p.name, p.tasks.length]), [[1, 'Index', 3], [2, 'API', 4], [3, 'Rollout', 3]]);
});

test('parse: a title may contain the separator until a model or gate starts the fields', () => {
  const d = pf.parse(midText().replace('- [ ] T10 Runbook', '- [ ] T10 Runbook · on-call · Haiku'));
  assert.deepStrictEqual(d.errors, []);
  assert.strictEqual(pf.findTask(d, 'T10').title, 'Runbook · on-call');
  assert.strictEqual(pf.findTask(d, 'T10').model, 'Haiku');
});

test('parse: waiting-on-you question with blocks, asked time and detail', () => {
  const [q] = pf.questions(mid());
  assert.strictEqual(q.id, 'q1');
  assert.strictEqual(q.q, 'Re-index the legacy synonym lists, or only copy them?');
  assert.deepStrictEqual(q.blocks, ['T9']);
  assert.strictEqual(q.asked, '2026-11-03T10:41:00Z');
  assert.match(q.body, /^The repo has 4 synonym lists[^\n]*\nexisting queries;/);
});

test('round-trip: parse -> serialize is byte-identical for every valid fixture', () => {
  for (const f of [path.join(MID, 'plan.md'), path.join(ARCH, 'plan.md')]) {
    const text = read(f);
    const d = pf.parse(text);
    assert.deepStrictEqual(d.errors, [], f);
    assert.strictEqual(pf.serialize(d), text, f);
  }
});

test('round-trip: blank-line layout and a missing preamble survive', () => {
  const text = '---\ntopic: a\ntitle: A\nrepo: /r\nstatus: active\ncreated: 2026-11-03T08:00:00Z\n---\n## Next\nDo it.\n\n\n## Waiting on you\n## Phase 1 — X\nIntro line.\n\n- [ ] T1 One\n\n- [ ] T2 Two\n  card\n\n  more\n\n\n## Notes\n\nfree\n\n';
  const d = pf.parse(text);
  assert.deepStrictEqual(d.errors, []);
  assert.deepStrictEqual(d.warnings, []);
  assert.strictEqual(pf.serialize(d), text);
  assert.strictEqual(pf.findTask(d, 'T2').body, 'card\n\nmore');
});

test('non-canonical input: warnings, canonical output, then stable', () => {
  const d = pf.parse(read(path.join(FIX, 'noncanonical.md')));
  assert.deepStrictEqual(d.errors, []);
  const msgs = d.warnings.map(w => `${w.line}: ${w.msg}`);
  assert.deepStrictEqual(msgs, [
    "9: write the heading as '## Next'",
    "11: write the heading as '## Waiting on you'",
    "13: write the list as 'blocks T2, T3'",
    "15: write the heading as '## Phase 1 — Cleanup'",
    "17: write the done marker as '[x]'",
    "17: write the model as 'Sonnet'",
  ]);
  const out = pf.serialize(d);
  assert.match(out, /## Phase 1 — Cleanup\n\n- \[x\] T1 Remove dead code · Sonnet\n/);
  assert.match(out, /blocks T2, T3 · asked/);
  const again = pf.parse(out);
  assert.deepStrictEqual(again.warnings, []);
  assert.strictEqual(pf.serialize(again), out);
});

test('non-canonical input: CRLF, no final newline and whitespace-only lines', () => {
  const d = pf.parse('---\r\ntopic: a\r\ntitle: A\r\nrepo: /r\r\nstatus: active\r\ncreated: 2026-11-03T08:00:00Z\r\n---\r\n  \r\n## Next\r\n\r\n## Waiting on you');
  assert.deepStrictEqual(d.errors, []);
  assert.deepStrictEqual(d.warnings.map(w => w.msg), ['Windows line endings; written back with \\n', 'no newline at the end of the file', 'line has only spaces; it is written back empty']);
  assert.strictEqual(pf.serialize(d), '---\ntopic: a\ntitle: A\nrepo: /r\nstatus: active\ncreated: 2026-11-03T08:00:00Z\n---\n\n## Next\n\n## Waiting on you\n');
});

test('validation: the malformed fixture reports each problem with its line', () => {
  const d = pf.parse(read(path.join(FIX, 'malformed.md')));
  const got = d.errors.map(e => `${e.line}: ${e.msg}`);
  const want = [
    "1: missing the '## Next' section (it may be empty)",
    '2: topic must be 1-64 letters',
    '3: title is empty',
    '4: repo must be the absolute path of the main worktree: "relative/path"',
    '5: status must be active, finished or done: "paused"',
    '6: created needs an ISO time',
    "7: frontmatter line must be 'key: value': \"owner jane\"",
    "13: unknown status marker '[y]'",
    '14: task needs an id like T3 right after the checkbox',
    '15: duplicate task id T1 (first used on line 12)',
    '16: unknown task field "Gpt"',
    '17: indent task-card lines with two spaces, not tabs',
    "18: gate must be 'gate ✓ <text>' or 'gate ✗ <text>': \"gate passed\"",
    '19: unexpected text; indent task-card lines by two spaces: "Loose text between tasks"',
    '21: phases must be numbered 1, 2, 3… in order; expected Phase 2, found Phase 3',
    "25: question q1 needs '· asked <time>' at the end",
    '25: q1 blocks T99, but there is no task T99',
    '26: duplicate question id q1',
  ];
  assert.strictEqual(got.length, want.length, got.join('\n'));
  want.forEach((w, i) => assert.ok(got[i].startsWith(w), `expected "${w}", got "${got[i]}"`));
  assert.match(pf.formatErrors(d.errors.slice(0, 1), '/x/plan.md'), /^\/x\/plan\.md:1: missing/);
});

test('validation: no frontmatter, unclosed frontmatter, bad phase heading, duplicate Next', () => {
  assert.match(pf.parse('# hi\n').errors[0].msg, /must start with a '---' frontmatter/);
  assert.match(pf.parse('---\ntopic: a\n').errors[0].msg, /not closed/);
  const base = '---\ntopic: a\ntitle: A\nrepo: /r\nstatus: active\ncreated: 2026-11-03T08:00:00Z\n---\n\n## Next\n\n## Waiting on you\n\n';
  assert.match(pf.parse(base + '## Phase one\n').errors[0].msg, /phase heading must be '## Phase N — Name'/);
  assert.match(pf.parse(base + '## Phase 1 —\n').errors[0].msg, /phase needs a name/);
  assert.match(pf.parse(base + '## Next\n').errors[0].msg, /'## Next' appears more than once/);
  assert.match(pf.parse(base + '## Phase 1 — X\n\n- [ ] T1\n').errors[0].msg, /task T1 needs a title/);
  assert.match(pf.parse(base.replace('## Waiting on you\n', '## Waiting on you\n\n- Q1 what?\n')).errors[0].msg, /question line must look like/);
});

test('newPlan: canonical skeleton that validates and round-trips', () => {
  const d = pf.newPlan({ topic: 'search-v2', title: 'Search v2', repo: '/srv/demo-app', created: '2026-11-03T07:58:00Z', goal: 'Goal: ranked search.' });
  const text = pf.serialize(d);
  assert.strictEqual(text, '---\ntopic: search-v2\ntitle: Search v2\nrepo: /srv/demo-app\nstatus: active\ncreated: 2026-11-03T07:58:00Z\n---\n\nGoal: ranked search.\n\n## Next\n\n## Waiting on you\n');
  assert.deepStrictEqual(d.errors, []);
  assert.throws(() => pf.newPlan({ topic: '../x', title: 'x', repo: '/r' }), e => e.code === 2);
  assert.throws(() => pf.newPlan({ topic: 'x', title: 'x', repo: 'rel' }), /absolute/);
});

test('ops: start, done (+ phase event), fail, with refusals', () => {
  const d = mid();
  assert.deepStrictEqual(pf.start(d, 'T7'), [{ type: 'start', task: 'T7' }]);
  assert.strictEqual(pf.findTask(d, 'T7').status, 'doing');
  assert.throws(() => pf.start(d, 'T1'), /T1 is already done/);
  assert.throws(() => pf.start(d, 'T9'), /T9 is blocked by q1/);
  assert.throws(() => pf.start(d, 'T99'), /no task T99/);
  assert.throws(() => pf.start(d, 'nope'), e => e.code === 2);
  assert.deepStrictEqual(pf.fail(d, 'T6', '3 tests'), [{ type: 'fail', task: 'T6', gate: { ok: false, text: '3 tests' } }]);
  assert.throws(() => pf.fail(d, 'T6'), e => e.code === 2);
  assert.deepStrictEqual(pf.finish(d, 'T5', '40 tests'), [{ type: 'done', task: 'T5', gate: { ok: true, text: '40 tests' } }]);
  pf.finish(d, 'T6', '41 tests');
  assert.deepStrictEqual(pf.finish(d, 'T7'), [{ type: 'done', task: 'T7' }, { type: 'phase', phase: 2, text: 'API' }]);
  assert.strictEqual(pf.findTask(d, 'T7').gate, null);
  const out = pf.serialize(d);
  assert.match(out, /- \[x\] T5 Contract tests · Sonnet · gate ✓ 40 tests\n  Fix the two/);
  assert.match(out, /- \[x\] T7 Rate limits · Sonnet\n/);
  assert.deepStrictEqual(pf.parse(out).errors, []);
});

test('ops: ask blocks tasks, answer unblocks only when no other question blocks them', () => {
  const d = mid();
  const events = pf.readEvents(MID).events;
  assert.strictEqual(pf.nextQuestionId(d, events), 'q2');
  assert.deepStrictEqual(pf.ask(d, { q: 'Flag name?', blocks: ['T8', 'T9'], asked: '2026-11-03T11:00:00Z', detail: 'search_v2 or new_search' }), [{ type: 'ask', q: 'q2', text: 'Flag name?' }]);
  assert.strictEqual(pf.findTask(d, 'T8').status, 'blocked');
  assert.throws(() => pf.ask(d, { q: 'x', blocks: ['T1'] }), /T1 is already done/);
  assert.throws(() => pf.ask(d, { q: 'two\nlines' }), e => e.code === 2);
  const text = pf.serialize(d);
  assert.match(text, /\n- q2 Flag name\? · blocks T8, T9 · asked 2026-11-03T11:00:00Z\n  search_v2 or new_search\n\n## Phase 1/);
  assert.deepStrictEqual(pf.answer(d, 'q2', 'search_v2'), [{ type: 'answer', q: 'q2', text: 'search_v2' }]);
  assert.strictEqual(pf.findTask(d, 'T8').status, 'todo');
  assert.strictEqual(pf.findTask(d, 'T9').status, 'blocked');
  pf.answer(d, 'q1', 'copy only');
  assert.strictEqual(pf.findTask(d, 'T9').status, 'todo');
  assert.throws(() => pf.answer(d, 'q1', 'again'), /no open question q1/);
  assert.match(pf.serialize(d), /## Waiting on you\n\n## Phase 1 — Index/);
  assert.strictEqual(pf.nextQuestionId(d, events.concat({ q: 'q2' })), 'q3');
});

test('ops: setNext replaces the Next text, archive marks the plan done', () => {
  const d = mid();
  pf.setNext(d, 'T7 Rate limits next.\n');
  assert.match(pf.serialize(d), /## Next\n\nT7 Rate limits next\.\n\n## Waiting on you/);
  pf.setNext(d, '');
  assert.match(pf.serialize(d), /## Next\n\n## Waiting on you/);
  assert.deepStrictEqual(pf.archive(d, new Date('2026-11-04T12:00:00Z')), [{ type: 'archive' }]);
  assert.strictEqual(d.meta.status, 'done');
  assert.strictEqual(d.meta.archived, '2026-11-04T12:00:00Z');
  assert.deepStrictEqual(pf.parse(pf.serialize(d)).errors, []);
});

test('ops: missing sections are created where the canonical layout puts them', () => {
  const d = pf.parse('---\ntopic: a\ntitle: A\nrepo: /r\nstatus: active\ncreated: 2026-11-03T08:00:00Z\n---\n\n## Phase 1 — X\n\n- [ ] T1 One\n');
  pf.setNext(d, 'T1');
  pf.ask(d, { q: 'Why?', asked: '2026-11-03T09:00:00Z' });
  const text = pf.serialize(d);
  assert.strictEqual(text, '---\ntopic: a\ntitle: A\nrepo: /r\nstatus: active\ncreated: 2026-11-03T08:00:00Z\n---\n\n## Next\n\nT1\n\n## Waiting on you\n\n- q1 Why? · asked 2026-11-03T09:00:00Z\n\n## Phase 1 — X\n\n- [ ] T1 One\n');
  assert.deepStrictEqual(pf.parse(text).errors, []);
});

test('summarize / detail: now, next, phase, gate and task times from events', () => {
  const d = mid();
  const { events } = pf.readEvents(MID);
  const s = pf.summarize(d, events);
  assert.deepStrictEqual({ done: s.done, total: s.total, pct: s.pct, complete: s.complete }, { done: 4, total: 10, pct: 40, complete: false });
  assert.deepStrictEqual(s.phase, { n: 2, of: 3, name: 'API', done: 1, total: 4 });
  assert.deepStrictEqual(s.now, { id: 'T6', title: 'Query endpoint', status: 'doing', model: 'Sonnet', gate: null, since: '2026-11-03T10:34:00.000Z' });
  assert.deepStrictEqual(s.next, { id: 'T7', title: 'Rate limits', status: 'todo', model: 'Sonnet', gate: null });
  assert.deepStrictEqual(s.waiting, [{ id: 'q1', q: 'Re-index the legacy synonym lists, or only copy them?', blocks: ['T9'], asked: '2026-11-03T10:41:00Z' }]);
  assert.deepStrictEqual(s.lastGate, { ok: false, text: 'lint · 2 errors', task: 'T5', at: '2026-11-03T10:21:00.000Z' });
  assert.strictEqual(s.updated, '2026-11-03T10:41:00.000Z');
  assert.strictEqual(s.errors, 0);
  const det = pf.detail(d, events, { timeline: 5 });
  assert.strictEqual(det.timeline.length, 5);
  const t3 = det.phases[0].tasks[2];
  assert.deepStrictEqual([t3.started, t3.finished], ['2026-11-03T09:10:00.000Z', '2026-11-03T09:41:00.000Z']);
  const t9 = det.phases[2].tasks[1];
  assert.deepStrictEqual(t9.by, ['q1']);
  assert.strictEqual(det.phases[1].tasks[2].finished, null);
  assert.match(det.waiting[0].detail, /^The repo has 4/);
  assert.deepStrictEqual(det.sections.map(x => x.heading), ['Decisions']);
  assert.match(det.nextNote, /If the gate is red/);
  d.sections.find(x => x.kind === 'phase').tasks[0].status = 'todo';
  assert.strictEqual(pf.summarize(d).now.id, 'T6');
});

test('summarize: a finished plan points at its last phase and is complete', () => {
  const r = pf.readPlan(ARCH);
  const s = pf.summarize(r.doc, pf.readEvents(ARCH).events);
  assert.deepStrictEqual([s.complete, s.pct, s.status, s.archived, s.now, s.next], [true, 100, 'done', '2026-10-28T16:05:00Z', null, null]);
  assert.deepStrictEqual(s.phase, { n: 2, of: 2, name: 'Build', done: 2, total: 2 });
  assert.deepStrictEqual(s.lastGate, { ok: true, text: '20 tests', task: 'T3', at: '2026-10-28T15:20:00.000Z' });
});

test('events: makeEvent orders keys and drops empties; append and read back; bad lines skipped', t => {
  const dir = tmp(t);
  const e = pf.makeEvent({ gate: { ok: true, text: '5 tests' }, task: 'T1', type: 'done', session: undefined, text: null }, new Date('2026-11-03T10:00:00Z'));
  assert.deepStrictEqual(Object.keys(e), ['ts', 'type', 'task', 'gate']);
  assert.strictEqual(e.ts, '2026-11-03T10:00:00.000Z');
  pf.appendEvent(dir, e);
  pf.appendEvent(dir, pf.makeEvent({ type: 'phase', phase: 1, text: 'Index' }));
  fs.appendFileSync(path.join(dir, 'events.jsonl'), 'not json\n{"ts":"x","type":"start"}\n\n');
  pf.appendEvent(dir, pf.makeEvent({ type: 'note', text: 'hi' }));
  const r = pf.readEvents(dir);
  assert.deepStrictEqual(r.events.map(x => x.type), ['done', 'phase', 'note']);
  assert.strictEqual(r.bad, 2);
  assert.deepStrictEqual(pf.readEvents(dir, { limit: 1 }).events.map(x => x.type), ['note']);
  assert.deepStrictEqual(pf.readEvents(path.join(dir, 'none')), { events: [], bad: 0 });
  for (const [bad, why] of [[{ type: 'start' }, /ts/], [{ ts: e.ts, type: 'edit' }, /type must be one of/], [{ ts: e.ts, type: 'start' }, /start needs task/],
    [{ ts: e.ts, type: 'fail', task: 'T1', gate: { ok: true, text: '' } }, /fail needs a failed gate/], [{ ts: e.ts, type: 'ask' }, /ask needs q/], [{ ts: e.ts, type: 'note', phase: 0 }, /phase/]]) {
    assert.throws(() => pf.appendEvent(dir, bad), why);
  }
  for (const f of ['search-v2', '_archive/2026-10-28-onboarding']) assert.strictEqual(pf.readEvents(path.join(STORE, 'demo-app', f)).bad, 0, f);
});

test('repoDirName: basename, unsafe characters replaced', () => {
  assert.strictEqual(pf.repoDirName('/srv/demo-app'), 'demo-app');
  assert.strictEqual(pf.repoDirName('/srv/My App (v2)'), 'My-App-v2-');
  assert.strictEqual(pf.repoDirName('/srv/.hidden'), 'hidden');
  assert.strictEqual(pf.repoDirName('/srv/___'), 'repo');
  assert.strictEqual(pf.repoDirName('/srv/' + 'x'.repeat(80)).length, 48);
});

test('repoDirFor: marker file decides ownership, same-name repos get -2, -3', t => {
  const root = tmp(t);
  assert.strictEqual(pf.repoDirFor(root, '/a/demo-app'), null);
  assert.strictEqual(pf.repoDirFor(root, '/a/demo-app', { create: true }), 'demo-app');
  assert.strictEqual(read(path.join(root, 'demo-app', '.repo')), '/a/demo-app\n');
  assert.strictEqual(pf.repoDirFor(root, '/b/demo-app'), null);
  assert.strictEqual(pf.repoDirFor(root, '/b/demo-app', { create: true }), 'demo-app-2');
  assert.strictEqual(pf.repoDirFor(root, '/c/demo-app', { create: true }), 'demo-app-3');
  assert.strictEqual(pf.repoDirFor(root, '/a/demo-app'), 'demo-app');
  assert.strictEqual(pf.repoDirFor(root, '/b/demo-app'), 'demo-app-2');
  fs.mkdirSync(path.join(root, 'other'));
  assert.strictEqual(pf.repoDirFor(root, '/d/other'), null);
  assert.strictEqual(pf.repoDirFor(root, '/d/other', { create: true }), 'other');
});

test('mainWorktree: repo root, subfolder and a linked worktree resolve to the main worktree', t => {
  const main = repo(t);
  fs.mkdirSync(path.join(main, 'src', 'deep'), { recursive: true });
  const wt = path.join(path.dirname(main), 'demo-app-feat');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  fs.mkdirSync(path.join(wt, 'lib'));
  assert.strictEqual(pf.mainWorktree(main), main);
  assert.strictEqual(pf.mainWorktree(path.join(main, 'src', 'deep')), main);
  assert.strictEqual(pf.mainWorktree(wt), main);
  assert.strictEqual(pf.mainWorktree(path.join(wt, 'lib')), main);
  assert.strictEqual(pf.mainWorktree(tmp(t)), null);
});

test('resolvePlan: --plan, then claim, then the single active plan, else candidates', t => {
  const root = tmp(t);
  const main = repo(t);
  const wt = path.join(path.dirname(main), 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'wt', wt);
  assert.deepStrictEqual(pf.resolvePlan({ root, cwd: wt }), { error: `no active plan for ${main}`, code: 3, repo: main, repoDir: null, candidates: [] });
  const repoDir = makePlan(root, main, 'search-v2');
  makePlan(root, main, 'old', 'done');
  const one = pf.resolvePlan({ root, cwd: wt, session: 'claude-x' });
  assert.deepStrictEqual(one, { repo: main, repoDir: 'demo-app', topic: 'search-v2', dir: path.join(root, 'demo-app', 'search-v2'), source: 'single' });
  makePlan(root, main, 'billing');
  const two = pf.resolvePlan({ root, cwd: main, session: 'claude-x' });
  assert.strictEqual(two.code, 3);
  assert.deepStrictEqual(two.candidates, ['billing', 'search-v2']);
  assert.match(two.error, /2 active plans .*: billing, search-v2; pass --plan <topic> or run 'plan use <topic>'/);
  pf.writeClaim(root, 'claude-x', repoDir, 'billing');
  assert.strictEqual(pf.resolvePlan({ root, cwd: wt, session: 'claude-x' }).source, 'claim');
  assert.strictEqual(pf.resolvePlan({ root, cwd: wt, session: 'claude-x' }).topic, 'billing');
  assert.strictEqual(pf.resolvePlan({ root, cwd: wt, session: 'claude-y' }).code, 3);
  assert.strictEqual(pf.resolvePlan({ root, cwd: wt, session: 'claude-x', topic: 'search-v2' }).source, 'flag');
  assert.strictEqual(pf.resolvePlan({ root, cwd: wt, topic: 'old' }).source, 'flag');
  assert.match(pf.resolvePlan({ root, cwd: wt, topic: 'nope' }).error, /no plan "nope"/);
  pf.writeClaim(root, 'claude-x', repoDir, 'old');
  assert.strictEqual(pf.resolvePlan({ root, cwd: wt, session: 'claude-x' }).code, 3);
  pf.clearClaim(root, 'claude-x');
  assert.strictEqual(pf.readClaim(root, 'claude-x'), null);
  assert.strictEqual(pf.resolvePlan({ root, repo: main, topic: 'billing' }).topic, 'billing');
  assert.strictEqual(pf.resolvePlan({ root, cwd: tmp(t) }).code, 3);
});

test('claims: file name is the url-encoded session, odd names are safe', t => {
  const root = tmp(t);
  pf.writeClaim(root, '../x/y', 'demo-app', 'search-v2', new Date('2026-11-03T10:00:00Z'));
  assert.ok(fs.existsSync(path.join(root, '.claims', '..%2Fx%2Fy.json')));
  assert.deepStrictEqual(pf.readClaim(root, '../x/y'), { repoDir: 'demo-app', topic: 'search-v2', at: '2026-11-03T10:00:00Z' });
  assert.strictEqual(pf.claimFile(root, ''), null);
  assert.throws(() => pf.writeClaim(root, undefined, 'a', 'b'), e => e.code === 2);
});

test('store: listPlans finds live and archived plans, skips symlinks and junk', t => {
  const root = tmp(t);
  fs.cpSync(STORE, root, { recursive: true });
  fs.symlinkSync(path.join(root, 'demo-app', 'search-v2'), path.join(root, 'demo-app', 'linked'));
  fs.mkdirSync(path.join(root, 'demo-app', 'empty'));
  fs.mkdirSync(path.join(root, '.claims'));
  const list = pf.listPlans(root);
  assert.deepStrictEqual(list.map(p => [p.id, p.repo, p.topic, p.archived]), [
    ['demo-app/search-v2', '/srv/demo-app', 'search-v2', false],
    ['demo-app/_archive/2026-10-28-onboarding', '/srv/demo-app', '2026-10-28-onboarding', true],
    ['demo-docs/old-cleanup', '/srv/demo-docs', 'old-cleanup', false],
    ['demo-docs/release-notes', '/srv/demo-docs', 'release-notes', false],
    ['demo-docs/style-guide', '/srv/demo-docs', 'style-guide', false],
  ]);
  assert.deepStrictEqual(pf.activeTopics(root, 'demo-app'), ['search-v2']);
  assert.deepStrictEqual(pf.activeTopics(root, 'demo-docs'), ['old-cleanup', 'release-notes', 'style-guide']);
});

test('store: readPlan flags a topic that does not match its folder; writePlan refuses invalid docs', t => {
  const root = tmp(t);
  const dir = path.join(root, 'demo-app', 'renamed');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.md'), midText());
  assert.match(pf.readPlan(dir).doc.errors[0].msg, /topic "search-v2" does not match the plan folder "renamed"/);
  assert.deepStrictEqual(pf.readPlan(ARCH).doc.errors, []);
  assert.strictEqual(pf.readPlan(path.join(root, 'none')), null);
  const d = mid();
  d.meta.status = 'paused';
  assert.throws(() => pf.writePlan(dir, d), /plan\.md:5: status must be active, finished or done/);
  const ok = mid();
  pf.writePlan(dir, ok);
  assert.strictEqual(read(path.join(dir, 'plan.md')), midText());
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['plan.md']);
});

test('store: archiveTarget picks a dated folder and a free suffix', t => {
  const root = tmp(t);
  const now = new Date('2026-11-04T12:00:00Z');
  const a = pf.archiveTarget(root, 'demo-app', 'search-v2', now);
  assert.strictEqual(a, path.join(root, 'demo-app', '_archive', '2026-11-04-search-v2'));
  fs.mkdirSync(a, { recursive: true });
  assert.strictEqual(path.basename(pf.archiveTarget(root, 'demo-app', 'search-v2', now)), '2026-11-04-search-v2-2');
});

test('withLock: exclusive, released after errors, stale locks are taken over', t => {
  const dir = tmp(t);
  assert.strictEqual(pf.withLock(dir, () => 7), 7);
  assert.throws(() => pf.withLock(dir, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(path.join(dir, '.lock')));
  fs.writeFileSync(path.join(dir, '.lock'), '');
  assert.throws(() => pf.withLock(dir, () => 1, { wait: 60 }), /locked by another plan command/);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(dir, '.lock'), old, old);
  assert.strictEqual(pf.withLock(dir, () => 2), 2);
});

test('storeRoot: BEAST_PLANS_DIR wins, else ~/.beast/plans', () => {
  assert.strictEqual(pf.storeRoot({ BEAST_PLANS_DIR: '/tmp/p', HOME: '/h' }), '/tmp/p');
  assert.strictEqual(pf.storeRoot({ HOME: '/h' }), '/h/.beast/plans');
});

test('fromLegacy: PROGRESS sections become phases, ids and models are kept, output is valid', () => {
  const planText = '# Checkout rework\n\n## Goal\n\nFaster checkout.\n';
  const progressText = [
    '# Checkout rework — progress', '', '## Phase 1 — Foundation',
    '- [x] T1 Cart schema (Opus)', '- [ ] T2 Price rules (Sonnet)', '  - [x] tax table', '  - [ ] discounts',
    '', '## Phase 2 — UI', '- [ ] Checkout page', '- [X] T1 duplicate id', '```', '- [ ] fenced', '```',
  ].join('\n');
  const d = pf.fromLegacy({ planText, progressText, topic: 'checkout', repo: '/srv/demo-app', created: '2026-10-01T08:00:00Z', now: new Date('2026-11-03T12:00:00Z') });
  assert.deepStrictEqual(d.errors, []);
  assert.deepStrictEqual(d.warnings, []);
  assert.strictEqual(d.meta.title, 'Checkout rework');
  assert.deepStrictEqual(pf.phases(d).map(p => p.name), ['Foundation', 'UI']);
  assert.deepStrictEqual(pf.tasks(d).map(x => [x.id, x.title, x.status, x.model]), [
    ['T1', 'Cart schema', 'done', 'Opus'], ['T2', 'Price rules', 'todo', 'Sonnet'],
    ['T3', 'Checkout page', 'todo', null], ['T4', 'duplicate id', 'done', null],
  ]);
  assert.strictEqual(pf.findTask(d, 'T2').body, '- [x] tax table\n- [ ] discounts');
  assert.strictEqual(d.sections.find(s => s.kind === 'next').body.text, 'T2 Price rules');
  assert.match(d.preamble.text, /^Imported from docs\/checkout\/ on 2026-11-03\./);
  assert.strictEqual(pf.serialize(pf.parse(pf.serialize(d))), pf.serialize(d));
});

test('writePlan refuses a change that would not read back the same and leaves the file alone', t => {
  const dir = path.join(tmp(t), 'demo-app', 'search-v2');
  pf.writePlan(dir, mid());
  const before = read(path.join(dir, 'plan.md'));
  const q = mid();
  pf.questions(q)[0].q = 'Option A · blocks everything?';
  assert.throws(() => pf.writePlan(dir, q), /would not read back|errors/);
  const n = mid();
  n.sections.find(s => s.kind === 'next').body.text = 'go\n## Phase 9 — Evil';
  assert.throws(() => pf.writePlan(dir, n), /refused/);
  const f = mid();
  f.sections.find(s => s.kind === 'next').body.text = '```\nopen';
  assert.throws(() => pf.writePlan(dir, f), /refused/);
  assert.strictEqual(read(path.join(dir, 'plan.md')), before);
  assert.deepStrictEqual(fs.readdirSync(dir), ['plan.md']);
});

test('withLock: releases only its own lock, refuses a vanished folder, moveTo carries the lock along', t => {
  const dir = path.join(tmp(t), 'p');
  assert.throws(() => pf.withLock(dir, () => 1), /gone/);
  assert.ok(!fs.existsSync(dir));
  assert.strictEqual(pf.withLock(dir, () => 1, { create: true }), 1);
  const lock = path.join(dir, '.lock');
  pf.withLock(dir, () => fs.writeFileSync(lock, 'someone else'));
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), 'someone else');
  fs.rmSync(lock);
  const target = path.join(path.dirname(dir), '_archive', 'p');
  pf.withLock(dir, moveTo => moveTo(target));
  assert.ok(!fs.existsSync(dir));
  assert.deepStrictEqual(fs.readdirSync(target), []);
});

test('withLock: a stale lock is broken once; a fresh lock that replaced it is kept', t => {
  const dir = tmp(t);
  const lock = path.join(dir, '.lock');
  fs.writeFileSync(lock, 'dead');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.strictEqual(pf.withLock(dir, () => fs.readFileSync(lock, 'utf8') !== 'dead'), true);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  fs.writeFileSync(lock, 'dead');
  fs.utimesSync(lock, old, old);
  const realRename = fs.renameSync;
  fs.renameSync = (a, b) => {
    fs.renameSync = realRename;
    fs.rmSync(lock);
    fs.writeFileSync(lock, 'fresh holder');
    return realRename(a, b);
  };
  t.after(() => { fs.renameSync = realRename; });
  assert.throws(() => pf.withLock(dir, () => 1, { wait: 100 }), /locked by another plan command/);
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), 'fresh holder');
  assert.deepStrictEqual(fs.readdirSync(dir), ['.lock']);
});

const DOCS = path.join(STORE, 'demo-docs');
const docsPlan = topic => ({ doc: pf.readPlan(path.join(DOCS, topic)).doc, events: pf.readEvents(path.join(DOCS, topic)).events });

test('lifecycle fixtures are canonical and their events valid', () => {
  for (const topic of ['release-notes', 'style-guide', 'old-cleanup']) {
    const r = pf.readPlan(path.join(DOCS, topic));
    assert.deepStrictEqual(r.doc.errors, [], topic);
    assert.deepStrictEqual(r.doc.warnings, [], topic);
    assert.strictEqual(pf.serialize(r.doc), r.text, topic);
    assert.strictEqual(pf.readEvents(path.join(DOCS, topic)).bad, 0, topic);
  }
});

test('lifecycle: status finished is valid, the new event types pass, a finish carries its text', () => {
  const d = pf.parse(midText().replace('status: active', 'status: finished'));
  assert.deepStrictEqual(d.errors, []);
  for (const type of ['finish', 'reopen', 'restore']) assert.strictEqual(pf.eventError(pf.makeEvent({ type })), null, type);
  assert.deepStrictEqual(pf.markFinished(d), [{ type: 'finish', text: 'marked finished' }]);
  assert.strictEqual(d.meta.status, 'finished');
});

test('lifecycle: reopen only acts on a finished plan', () => {
  const d = mid();
  assert.deepStrictEqual(pf.reopen(d), []);
  assert.strictEqual(d.meta.status, 'active');
  d.meta.status = 'finished';
  assert.deepStrictEqual(pf.reopen(d), [{ type: 'reopen' }]);
  assert.strictEqual(d.meta.status, 'active');
});

test('lifecycle: settleAfterDone finishes a complete active plan and reopens an incomplete finished one', () => {
  const all = docsPlan('old-cleanup').doc;
  assert.deepStrictEqual(pf.settleAfterDone(all), [{ type: 'finish', text: 'all tasks done' }]);
  assert.strictEqual(all.meta.status, 'finished');
  assert.deepStrictEqual(pf.settleAfterDone(all), []);
  assert.strictEqual(all.meta.status, 'finished');
  const open = docsPlan('style-guide').doc;
  assert.deepStrictEqual(pf.settleAfterDone(open), [{ type: 'reopen' }]);
  assert.strictEqual(open.meta.status, 'active');
  const midway = mid();
  assert.deepStrictEqual(pf.settleAfterDone(midway), []);
  assert.strictEqual(midway.meta.status, 'active');
});

test('lifecycle: restore drops archived, finished when complete, active otherwise', () => {
  const complete = pf.readPlan(ARCH).doc;
  assert.deepStrictEqual(pf.restore(complete), [{ type: 'restore' }]);
  assert.strictEqual(complete.meta.status, 'finished');
  assert.ok(!Object.hasOwn(complete.meta, 'archived'));
  const empty = pf.newPlan({ topic: 'x', title: 'X', repo: '/srv/x' });
  pf.archive(empty);
  pf.restore(empty);
  assert.strictEqual(empty.meta.status, 'active');
  const open = docsPlan('style-guide').doc;
  pf.archive(open);
  pf.restore(open);
  assert.strictEqual(open.meta.status, 'active');
});

test('summarize: finished and finishedAt', () => {
  const rn = docsPlan('release-notes');
  const s1 = pf.summarize(rn.doc, rn.events);
  assert.deepStrictEqual([s1.status, s1.finished, s1.finishedAt], ['finished', true, '2026-11-02T10:00:00.000Z']);
  const sg = docsPlan('style-guide');
  const s2 = pf.summarize(sg.doc, sg.events);
  assert.deepStrictEqual([s2.finished, s2.complete, s2.finishedAt], [true, false, '2026-10-12T08:00:00.000Z']);
  const old = docsPlan('old-cleanup');
  const s3 = pf.summarize(old.doc, old.events);
  assert.deepStrictEqual([s3.status, s3.finished, s3.finishedAt], ['active', true, '2026-10-02T12:00:00.000Z']);
  assert.deepStrictEqual([pf.summarize(old.doc).finished, pf.summarize(old.doc).finishedAt], [true, null]);
  const live = pf.summarize(mid(), pf.readEvents(MID).events);
  assert.deepStrictEqual([live.finished, live.finishedAt], [false, null]);
  const arch = pf.summarize(pf.readPlan(ARCH).doc, pf.readEvents(ARCH).events);
  assert.deepStrictEqual([arch.status, arch.complete, arch.finished, arch.finishedAt], ['done', true, false, null]);
  const bare = pf.summarize(pf.newPlan({ topic: 'x', title: 'X', repo: '/srv/x' }));
  assert.deepStrictEqual([bare.finished, bare.finishedAt], [false, null]);
  const handEdited = pf.parse(pf.serialize(rn.doc));
  assert.strictEqual(pf.summarize(handEdited, []).finishedAt, null);
  const reopened = pf.summarize(sg.doc, [...sg.events, { ts: '2026-10-13T08:00:00.000Z', type: 'reopen' }]);
  assert.strictEqual(reopened.finishedAt, '2026-10-12T08:00:00.000Z');
});

test('detail carries the summary lifecycle fields', () => {
  const rn = docsPlan('release-notes');
  const d = pf.detail(rn.doc, rn.events);
  assert.deepStrictEqual([d.finished, d.finishedAt], [true, '2026-11-02T10:00:00.000Z']);
  assert.ok(d.timeline.some(e => e.type === 'finish'));
});
