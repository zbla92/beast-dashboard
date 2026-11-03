'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const pf = require('../lib/planfile');

const SRC = path.join(__dirname, '..');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function tmp(t, prefix = 'bd-plancli-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(t, name = 'demo-app') {
  const dir = path.join(tmp(t, 'bd-plancli-repo-'), name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

function install(t) {
  const dir = tmp(t, 'bd-plancli-app-');
  for (const f of ['bin/plan', 'lib/planfile.js']) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  }
  fs.mkdirSync(path.join(dir, 'state'));
  const setPlans = on => fs.writeFileSync(path.join(dir, 'state', 'settings.json'), JSON.stringify({ plans: on }));
  setPlans(true);
  return { bin: path.join(dir, 'bin', 'plan'), settings: path.join(dir, 'state', 'settings.json'), setPlans };
}

function env(t) {
  const root = path.join(tmp(t), 'plans');
  const repo = makeRepo(t);
  const app = install(t);
  const run = (args, opts = {}) => {
    const r = spawnSync(process.execPath, [app.bin, ...args], {
      cwd: opts.cwd || repo,
      input: opts.input,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: os.tmpdir(), BEAST_PLANS_DIR: root },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const planDir = topic => path.join(root, 'demo-app', topic);
  const planText = topic => fs.readFileSync(path.join(planDir(topic), 'plan.md'), 'utf8');
  const events = topic => fs.readFileSync(path.join(planDir(topic), 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { root, repo, run, planDir, planText, events, ...app };
}

const SESSION = ['--session', 'claude-test'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function spawnPlan(e, args) {
  const { spawn } = require('node:child_process');
  return new Promise(resolve => {
    const c = spawn(process.execPath, [e.bin, ...args], { cwd: e.repo, env: { PATH: process.env.PATH, HOME: os.tmpdir(), BEAST_PLANS_DIR: e.root } });
    const out = { err: '' };
    c.stderr.on('data', d => { out.err += d; });
    c.on('close', code => resolve({ code, err: out.err }));
  });
}

function seed(e, topic = 'search-v2') {
  assert.equal(e.run(['new', topic, '--title', 'Search v2', '--goal', 'Ranked search', ...SESSION]).code, 0);
  const file = path.join(e.planDir(topic), 'plan.md');
  const text = fs.readFileSync(file, 'utf8').replace(/\n$/, '') + `

## Phase 1 — Index

- [ ] T1 Index schema · Opus
  Goal: freeze the table.
- [ ] T2 Contract tests · Sonnet
- [ ] T3 Query endpoint · Sonnet

## Phase 2 — API

- [ ] T4 Rate limits · Haiku
- [ ] T5 Runbook
`;
  fs.writeFileSync(file, text);
  return file;
}

test('no arguments prints usage and exits 2; help exits 0', t => {
  const e = env(t);
  assert.equal(e.run([]).code, 2);
  const h = e.run(['help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /usage: plan/);
});

test('usage errors exit 2', t => {
  const e = env(t);
  seed(e);
  for (const args of [['bogus'], ['list', '--nope'], ['new'], ['new', 'x y', '--title', 't'], ['new', 'ok'], ['start'], ['start', 'x1'],
    ['done', 'T1', '--gate'], ['fail', 'T1'], ['answer', 'q1'], ['answer', 'x', 'y'], ['list', '--gate', 'x'], ['use'], ['ask', '', ],
    ['ask', 'q?', '--blocks', 'bad']]) {
    const r = e.run(args);
    assert.equal(r.code, 2, `${args.join(' ')} -> ${r.code} ${r.err}`);
    assert.match(r.err, /^plan: /);
  }
});

test('outside a git repo and without a plan exit 3', t => {
  const e = env(t);
  const nogit = tmp(t);
  assert.equal(e.run(['list'], { cwd: nogit }).code, 3);
  assert.equal(e.run(['show'], { cwd: nogit }).code, 3);
  assert.equal(e.run(['new', 'x', '--title', 't'], { cwd: nogit }).code, 3);
  const r = e.run(['show']);
  assert.equal(r.code, 3);
  assert.match(r.err, /no active plan/);
  assert.equal(e.run(['show', '--plan', 'ghost']).code, 3);
});

test('new creates the plan, claim, create event, and path prints it', t => {
  const e = env(t);
  const r = e.run(['new', 'search-v2', '--title', 'Search v2', '--goal', 'Ranked search', ...SESSION]);
  assert.equal(r.code, 0);
  const file = path.join(e.root, 'demo-app', 'search-v2', 'plan.md');
  assert.equal(r.out.trim(), file);
  assert.equal(fs.readFileSync(path.join(e.root, 'demo-app', '.repo'), 'utf8'), e.repo + '\n');
  const doc = pf.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(doc.errors, []);
  assert.equal(doc.meta.repo, e.repo);
  assert.match(fs.readFileSync(file, 'utf8'), /Ranked search/);
  const ev = e.events('search-v2');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'create');
  assert.equal(ev[0].text, 'Search v2');
  assert.equal(ev[0].session, 'claude-test');
  assert.deepEqual(pf.readClaim(e.root, 'claude-test'), { repoDir: 'demo-app', topic: 'search-v2', at: pf.readClaim(e.root, 'claude-test').at });
  assert.equal(e.run(['path']).out.trim(), file);
  const again = e.run(['new', 'search-v2', '--title', 'Again']);
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists/);
});

test('new without a session still works and writes no claim', t => {
  const e = env(t);
  assert.equal(e.run(['new', 'a', '--title', 'A']).code, 0);
  assert.ok(!fs.existsSync(path.join(e.root, '.claims')));
  assert.equal(e.events('a')[0].session, undefined);
});

test('start, done, fail with events and canonical output', t => {
  const e = env(t);
  seed(e);
  const r = e.run(['start', 'T1', ...SESSION]);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'T1 doing · Index schema');
  assert.match(e.planText('search-v2'), /- \[~\] T1 Index schema · Opus/);
  const r2 = e.run(['fail', 'T1', '--gate', 'lint · 2 errors']);
  assert.equal(r2.code, 0);
  assert.match(e.planText('search-v2'), /- \[!\] T1 Index schema · Opus · gate ✗ lint · 2 errors/);
  const r3 = e.run(['done', 'T1', '--gate', '12 tests']);
  assert.equal(r3.code, 0);
  assert.match(e.planText('search-v2'), /- \[x\] T1 Index schema · Opus · gate ✓ 12 tests/);
  assert.match(e.planText('search-v2'), /Goal: freeze the table\./);
  const r4 = e.run(['done', 'T2']);
  assert.match(e.planText('search-v2'), /- \[x\] T2 Contract tests · Sonnet\n/);
  const r5 = e.run(['done', 'T3']);
  assert.match(r5.out, /phase 1 complete/);
  const ev = e.events('search-v2');
  assert.deepEqual(ev.map(x => x.type), ['create', 'start', 'fail', 'done', 'done', 'done', 'phase']);
  assert.deepEqual(ev[2].gate, { ok: false, text: 'lint · 2 errors' });
  assert.deepEqual(ev[3].gate, { ok: true, text: '12 tests' });
  assert.equal(ev[1].session, 'claude-test');
  assert.equal(ev[6].phase, 1);
  assert.equal(ev[6].text, 'Index');
  assert.equal(e.run(['done', 'T1']).code, 0);
  assert.doesNotMatch(e.planText('search-v2'), /T1 Index schema · Opus · gate/);
});

test('refused changes exit 1 and leave the file untouched', t => {
  const e = env(t);
  seed(e);
  const before = e.planText('search-v2');
  assert.equal(e.run(['start', 'T99']).code, 1);
  assert.equal(e.run(['done', 'T99']).code, 1);
  e.run(['done', 'T1']);
  const r = e.run(['start', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.err, /already done/);
  e.run(['ask', 'Which?', '--blocks', 'T2']);
  const blocked = e.run(['start', 'T2']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /blocked by q1/);
  assert.equal(e.run(['done', 'T2']).code, 1);
  assert.equal(e.run(['ask', 'Why?', '--blocks', 'T1']).code, 1);
  assert.equal(e.run(['answer', 'q9', 'x']).code, 1);
  assert.notEqual(before, e.planText('search-v2'));
});

test('ask and answer: blocking, numbering, events', t => {
  const e = env(t);
  seed(e);
  const r = e.run(['ask', 'Re-index or copy?', '--blocks', 'T4,T5', '--detail', 'Ranking changes.', ...SESSION]);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'q1 asked · blocks T4, T5');
  const text = e.planText('search-v2');
  assert.match(text, /- \[\?\] T4 Rate limits/);
  assert.match(text, /- q1 Re-index or copy\? · blocks T4, T5 · asked \d{4}-/);
  assert.match(text, /\n {2}Ranking changes\./);
  e.run(['ask', 'Second?', '--blocks', 'T5']);
  const r2 = e.run(['answer', 'q1', 'copy']);
  assert.equal(r2.code, 0);
  const text2 = e.planText('search-v2');
  assert.match(text2, /- \[ \] T4 Rate limits/);
  assert.match(text2, /- \[\?\] T5 Runbook/);
  e.run(['answer', 'q2', 'yes']);
  assert.match(e.planText('search-v2'), /- \[ \] T5 Runbook/);
  const r3 = e.run(['ask', 'Third?']);
  assert.equal(r3.out.trim(), 'q3 asked');
  const ev = e.events('search-v2').filter(x => x.q);
  assert.deepEqual(ev.map(x => `${x.type}:${x.q}`), ['ask:q1', 'ask:q2', 'answer:q1', 'answer:q2', 'ask:q3']);
  assert.equal(ev[2].text, 'copy');
});

test('question numbering continues past answered questions that left the file', t => {
  const e = env(t);
  seed(e);
  e.run(['ask', 'One?']);
  e.run(['answer', 'q1', 'a']);
  assert.equal(e.run(['ask', 'Two?']).out.trim(), 'q2 asked');
});

test('next replaces the text and writes no event; empty clears it', t => {
  const e = env(t);
  seed(e);
  const n = e.events('search-v2').length;
  assert.equal(e.run(['next', 'T1 first, then T2.']).code, 0);
  assert.match(e.planText('search-v2'), /## Next\n\nT1 first, then T2\.\n\n## Waiting on you/);
  assert.equal(e.events('search-v2').length, n);
  assert.equal(e.run(['next', '']).code, 0);
  assert.match(e.planText('search-v2'), /## Next\n\n## Waiting on you/);
});

test('note logs an event only and leaves plan.md bytes alone', t => {
  const e = env(t);
  const file = seed(e);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(e.run(['note', 'ran the migration', '--task', 'T1', ...SESSION]).code, 0);
  assert.equal(e.run(['note', 'general']).code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const ev = e.events('search-v2').slice(-2);
  assert.deepEqual(ev.map(x => [x.type, x.task, x.text]), [['note', 'T1', 'ran the migration'], ['note', undefined, 'general']]);
  assert.equal(e.run(['note', 'x', '--task', 'T99']).code, 1);
  assert.equal(e.run(['note', 'x', '--task', 'nope']).code, 2);
});

test('list and show, text and json', t => {
  const e = env(t);
  seed(e, 'search-v2');
  seed(e, 'other');
  e.run(['done', 'T1', '--plan', 'search-v2']);
  const r = e.run(['list']);
  assert.match(r.out, /^other {2}0\/5 {2}active {2}Search v2$/m);
  assert.match(r.out, /^search-v2 {2}1\/5 {2}active/m);
  const rows = JSON.parse(e.run(['list', '--json']).out);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id.startsWith('demo-app/'), true);
  const r2 = e.run(['show']);
  assert.equal(r2.code, 3);
  assert.match(r2.err, /2 active plans/);
  const r3 = e.run(['show', '--plan', 'search-v2']);
  assert.equal(r3.code, 0);
  assert.match(r3.out, /Search v2 \(demo-app\/search-v2\) · active/);
  assert.match(r3.out, /1\/5 done \(20%\) · phase 1\/2 Index/);
  assert.match(r3.out, /\[x\] T1 Index schema/);
  const j = JSON.parse(e.run(['show', '--plan', 'search-v2', '--json']).out);
  assert.equal(j.id, 'demo-app/search-v2');
  assert.equal(j.done, 1);
  assert.equal(j.phases.length, 2);
  assert.ok(Array.isArray(j.timeline));
});

test('list --all spans repos and includes archived', t => {
  const e = env(t);
  seed(e, 'one');
  e.run(['archive']);
  const other = makeRepo(t, 'second');
  assert.equal(e.run(['new', 'two', '--title', 'Two'], { cwd: other }).code, 0);
  assert.doesNotMatch(e.run(['list']).out, /one/);
  const all = e.run(['list', '--all']).out;
  assert.match(all, /demo-app\/_archive\/\d{4}-\d\d-\d\d-one/);
  assert.match(all, /second\/two/);
});

test('plan selection: single, claim, --plan, several without claim', t => {
  const e = env(t);
  seed(e, 'a');
  assert.equal(e.run(['start', 'T1']).code, 0);
  seed(e, 'b');
  const r = e.run(['start', 'T2']);
  assert.equal(r.code, 3);
  assert.match(r.err, /a, b/);
  assert.equal(e.run(['start', 'T2', '--plan', 'b']).code, 0);
  assert.equal(e.run(['use', 'a', '--session', 'claude-x']).code, 0);
  assert.equal(e.run(['done', 'T1', '--session', 'claude-x']).code, 0);
  assert.match(e.planText('a'), /\[x\] T1/);
  assert.equal(e.run(['use', 'ghost', '--session', 'claude-x']).code, 3);
  assert.equal(e.run(['use', '--clear', '--session', 'claude-x']).code, 0);
  assert.equal(pf.readClaim(e.root, 'claude-x'), null);
  assert.equal(e.run(['use', 'a']).code, 2);
});

test('plans are found from a linked worktree of the repo', t => {
  const e = env(t);
  seed(e);
  const wt = path.join(tmp(t), 'wt');
  git(e.repo, 'worktree', 'add', '-q', wt, '-b', 'side');
  const r = e.run(['start', 'T1'], { cwd: wt });
  assert.equal(r.code, 0, r.err);
  assert.equal(e.run(['path'], { cwd: wt }).out.trim(), path.join(e.planDir('search-v2'), 'plan.md'));
});

test('--repo picks the repo from another directory', t => {
  const e = env(t);
  seed(e);
  const elsewhere = tmp(t);
  assert.equal(e.run(['path', '--repo', e.repo], { cwd: elsewhere }).code, 0);
  assert.equal(e.run(['path'], { cwd: elsewhere }).code, 3);
});

test('validate: plan, file, errors, warnings', t => {
  const e = env(t);
  seed(e);
  const r = e.run(['validate']);
  assert.equal(r.code, 0);
  assert.match(r.out, /ok/);
  const bad = path.join(tmp(t), 'bad.md');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'plans', 'malformed.md'), bad);
  const r2 = e.run(['validate', bad]);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /bad\.md:\d+: /);
  const warn = path.join(tmp(t), 'w.md');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'plans', 'noncanonical.md'), warn);
  const r3 = e.run(['validate', warn]);
  assert.equal(r3.code, 0);
  assert.match(r3.out, /warning: /);
  assert.equal(e.run(['validate', path.join(tmp(t), 'missing.md')]).code, 1);
});

test('a plan with validation errors is refused and left alone', t => {
  const e = env(t);
  const file = seed(e);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- [ ] T2 Contract tests · Sonnet', '- [ ] T1 Duplicate'));
  const before = fs.readFileSync(file, 'utf8');
  const r = e.run(['start', 'T3']);
  assert.equal(r.code, 1);
  assert.match(r.err, /duplicate task id T1/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(e.run(['validate']).code, 1);
  assert.equal(e.run(['show']).code, 0);
});

test('archive moves the plan, logs the event and frees the topic', t => {
  const e = env(t);
  seed(e);
  const r = e.run(['archive', ...SESSION]);
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(e.planDir('search-v2')));
  const date = pf.iso().slice(0, 10);
  const dir = path.join(e.root, 'demo-app', '_archive', `${date}-search-v2`);
  const doc = pf.parse(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'));
  assert.equal(doc.meta.status, 'done');
  assert.ok(pf.isIso(doc.meta.archived));
  assert.ok(!fs.existsSync(path.join(dir, '.lock')));
  const ev = pf.readEvents(dir).events;
  assert.equal(ev[ev.length - 1].type, 'archive');
  assert.equal(e.run(['show']).code, 3);
  seed(e);
  assert.equal(e.run(['archive']).code, 0);
  assert.ok(fs.existsSync(path.join(e.root, 'demo-app', '_archive', `${date}-search-v2-2`, 'plan.md')));
});

test('import copies a legacy plan and never writes to the repo', t => {
  const e = env(t);
  const docs = path.join(e.repo, 'docs', 'old-thing');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'PLAN.md'), '# Old thing\n\nBody.\n');
  fs.writeFileSync(path.join(docs, 'PROGRESS.md'), '## Phase 1 — Build\n- [x] T1 First (Opus)\n- [ ] Second\n  - [ ] sub\n');
  const before = git(e.repo, 'status', '--porcelain');
  const r = e.run(['import', docs]);
  assert.equal(r.code, 0, r.err);
  const dir = e.planDir('old-thing');
  assert.equal(r.out.trim(), path.join(dir, 'plan.md'));
  const doc = pf.parse(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'));
  assert.deepEqual(doc.errors, []);
  assert.equal(doc.meta.title, 'Old thing');
  assert.deepEqual(pf.tasks(doc).map(x => [x.id, x.status, x.model]), [['T1', 'done', 'Opus'], ['T2', 'todo', null]]);
  assert.equal(fs.readFileSync(path.join(dir, 'legacy-PLAN.md'), 'utf8'), '# Old thing\n\nBody.\n');
  assert.ok(fs.existsSync(path.join(dir, 'legacy-PROGRESS.md')));
  assert.equal(e.events('old-thing')[0].type, 'create');
  assert.equal(git(e.repo, 'status', '--porcelain'), before);
  assert.equal(e.run(['import', docs]).code, 1);
  assert.equal(e.run(['import', docs, '--topic', 'renamed']).code, 0);
  assert.equal(e.run(['import', path.join(e.repo, 'docs')]).code, 1);
  assert.equal(e.run(['import', path.join(e.repo, 'nope')]).code, 1);
});

test('round trip: a long command series leaves a canonical, valid plan', t => {
  const e = env(t);
  seed(e);
  const steps = [['start', 'T1'], ['ask', 'Q one?', '--blocks', 'T3', '--detail', 'detail'], ['done', 'T1', '--gate', 'ok · fine'], ['start', 'T2'],
    ['fail', 'T2', '--gate', 'lint'], ['done', 'T2'], ['answer', 'q1', 'go'], ['next', 'T3 now'], ['note', 'n'], ['done', 'T3', '--gate', ''], ['start', 'T4']];
  for (const s of steps) assert.equal(e.run(s).code, 0, s.join(' '));
  const text = e.planText('search-v2');
  const doc = pf.parse(text);
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.warnings, []);
  assert.equal(pf.serialize(doc), text);
  assert.equal(fs.readdirSync(e.planDir('search-v2')).filter(f => f.includes('tmp') || f === '.lock').length, 0);
  for (const ev of e.events('search-v2')) assert.equal(pf.eventError(ev), null);
});

test('concurrent commands do not lose updates', async t => {
  const e = env(t);
  seed(e);
  const { spawn } = require('node:child_process');
  const runs = ['T1', 'T2', 'T3', 'T4', 'T5'].map(id => new Promise(resolve => {
    const c = spawn(process.execPath, [e.bin, 'done', id], { cwd: e.repo, env: { PATH: process.env.PATH, HOME: os.tmpdir(), BEAST_PLANS_DIR: e.root } });
    c.on('close', resolve);
  }));
  const codes = await Promise.all(runs);
  assert.deepEqual(codes, [0, 0, 0, 0, 0]);
  assert.equal(pf.tasks(pf.parse(e.planText('search-v2'))).filter(x => x.status === 'done').length, 5);
});

test('context: empty cases print nothing and exit 0', t => {
  const e = env(t);
  const hook = cwd => JSON.stringify({ session_id: 's', cwd, hook_event_name: 'SessionStart', source: 'startup' });
  const r = e.run(['context'], { input: hook(e.repo) });
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  const r2 = e.run(['context'], { input: hook(tmp(t)) });
  assert.deepEqual([r2.code, r2.out], [0, '']);
  const r3 = e.run(['context'], { input: 'not json' });
  assert.deepEqual([r3.code, r3.out], [0, '']);
  const r4 = e.run(['context'], { input: '' });
  assert.deepEqual([r4.code, r4.out], [0, '']);
  const r5 = e.run(['context', '--bogus'], { input: '{}' });
  assert.equal(r5.out, '');
});

test('context outside a git repo lists the active plans of repos under that folder', t => {
  const e = env(t);
  seed(e);
  e.run(['start', 'T1']);
  const hook = cwd => JSON.stringify({ session_id: 's', cwd, hook_event_name: 'SessionStart', source: 'startup' });
  const r = e.run(['context'], { cwd: tmp(t), input: hook(path.dirname(e.repo)) });
  assert.equal(r.code, 0);
  assert.match(r.out, /^Not a git repository\. Active plans in repos under .+:$/m);
  assert.match(r.out, /^demo-app\/search-v2 "Search v2" 0\/5, now T1 \(.+demo-app\)$/m);
  assert.match(r.out, /--repo <path>/);
  const other = e.run(['context'], { cwd: tmp(t), input: hook(tmp(t)) });
  assert.deepEqual([other.code, other.out], [0, '']);
  fs.writeFileSync(path.join(e.planDir('search-v2'), 'plan.md'), e.planText('search-v2').replace('status: active', 'status: done'));
  const done = e.run(['context'], { cwd: tmp(t), input: hook(path.dirname(e.repo)) });
  assert.deepEqual([done.code, done.out], [0, '']);
});

test('context: summary of the active plan, from a hook cwd', t => {
  const e = env(t);
  seed(e);
  e.run(['next', 'T2 Contract tests: write them, then run the gate.']);
  e.run(['done', 'T1', '--gate', '12 tests']);
  e.run(['start', 'T2']);
  e.run(['fail', 'T3', '--gate', 'lint · 2 errors']);
  e.run(['ask', 'Re-index or copy?', '--blocks', 'T5']);
  const r = e.run(['context'], { cwd: tmp(t), input: JSON.stringify({ cwd: e.repo, hook_event_name: 'SessionStart', source: 'clear' }) });
  assert.equal(r.code, 0);
  const lines = r.out.trimEnd().split('\n');
  assert.match(lines[0], /^Plan search-v2 "Search v2" \(demo-app\): 1\/5 tasks done, phase 1\/2 Index\. File: .*plan\.md$/);
  assert.match(r.out, /^Status changes go through the plan CLI/m);
  assert.match(r.out, /^Now: T2 Contract tests \(Sonnet\), doing since \d\d:\d\d UTC\.$/m);
  assert.match(r.out, /^Failed: T3 Query endpoint, gate ✗ lint · 2 errors\.$/m);
  assert.match(r.out, /^Waiting on the user: q1 Re-index or copy\? \(blocks T5\)$/m);
  assert.match(r.out, /^Next: T2 Contract tests: write them, then run the gate\.$/m);
  assert.match(r.out, /^Then: T4 Rate limits \(Haiku\)\.$/m);
  assert.ok(r.out.length <= 1601);
});

test('context stays within the size budget with huge content', t => {
  const e = env(t);
  const file = seed(e);
  const long = 'word '.repeat(400);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Next\n', `## Next\n\n${long}\n`));
  for (const i of [0, 1, 2, 3]) e.run(['ask', `question ${i} ${'x'.repeat(300)}`]);
  e.run(['start', 'T1']);
  const r = e.run(['context'], { input: '{}' });
  assert.equal(r.code, 0);
  assert.ok(r.out.length > 0 && r.out.length <= 1601, String(r.out.length));
  assert.match(r.out, /Next: word/);
});

test('context with several active plans lists them and uses a claim when present', t => {
  const e = env(t);
  seed(e, 'a');
  seed(e, 'b');
  e.run(['start', 'T1', '--plan', 'a']);
  const r = e.run(['context'], { input: '{}' });
  assert.match(r.out, /^Active plans for demo-app/);
  assert.match(r.out, /^a 0\/5, now T1$/m);
  assert.match(r.out, /^b 0\/5, next T1$/m);
  assert.match(r.out, /Pick one with: plan use <topic>/);
  const r2 = e.run(['context', '--session', 'claude-test'], { input: '{}' });
  assert.match(r2.out, /^Plan b "Search v2"/);
});

test('context never fails the session on a broken plan', t => {
  const e = env(t);
  const file = seed(e);
  fs.writeFileSync(file, '\u0000garbage');
  const r = e.run(['context'], { input: '{}' });
  assert.equal(r.code, 0);
});

test('every mutation leaves a plan that passes validate; hostile text is refused and changes nothing', t => {
  const e = env(t);
  const valid = () => { const r = e.run(['validate']); assert.equal(r.code, 0, r.out + r.err); };
  const refused = (args, re) => {
    const before = e.planText('search-v2');
    const r = e.run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, re);
    assert.equal(e.planText('search-v2'), before);
    valid();
  };
  for (const goal of ['## Notes', 'x\n```\nopen', 'a\n## Next']) {
    const r = e.run(['new', 'bad', '--title', 'B', '--goal', goal]);
    assert.equal(r.code, 2, goal);
    assert.ok(!fs.existsSync(e.planDir('bad')));
  }
  assert.equal(e.run(['new', 'search-v2', '--title', 'Search v2', '--goal', 'Run:\n```\n## inside a fence\n```\nend', ...SESSION]).code, 0);
  valid();
  const file = path.join(e.planDir('search-v2'), 'plan.md');
  fs.writeFileSync(file, e.planText('search-v2') + '\n## Phase 1 — Index\n\n- [ ] T1 Index schema · Opus\n- [ ] T2 Contract tests\n- [ ] T3 Query endpoint\n');
  valid();
  const steps = [
    ['start', 'T1'],
    ['ask', 'Plain?', '--blocks', 'T3', '--detail', 'line one\n   \n```\n## not a heading\n\tend'],
    ['ask', 'Q · blocks? no · asked? also no'],
    ['done', 'T1', '--gate', 'a · b'],
    ['fail', 'T2', '--gate', 'x · gate ✓ y'],
    ['answer', 'q1', 'yes · blocks T2'],
    ['next', 'Run this:\n```\n## inside a fence\n```\nthen go'],
    ['note', 'n · asked now'],
    ['done', 'T2'],
    ['next', ''],
  ];
  for (const s of steps) { const r = e.run(s); assert.equal(r.code, 0, `${s.join(' ')}: ${r.err}`); valid(); }
  refused(['ask', 'Option A · blocks everything?'], /blocks/);
  refused(['ask', 'When · asked 2026-11-03T10:41:00Z'], /asked/);
  refused(['next', 'first\n```\nnever closed'], /fence/);
  refused(['next', 'first\n## Phase 2 — Sneaky'], /## /);
  refused(['next', '## Waiting on you'], /## /);
  const doc = pf.parse(e.planText('search-v2'));
  assert.deepEqual(pf.questions(doc).map(q => [q.id, q.q, q.blocks]), [['q2', 'Q · blocks? no · asked? also no', []]]);
  assert.deepEqual(pf.tasks(doc).map(x => [x.id, x.status]), [['T1', 'done'], ['T2', 'done'], ['T3', 'todo']]);
  assert.equal(e.run(['archive']).code, 0);
  const archived = path.join(e.root, 'demo-app', '_archive', `${pf.iso().slice(0, 10)}-search-v2`, 'plan.md');
  assert.equal(e.run(['validate', archived]).code, 0);
});

test('archive moves the folder while it holds the lock; a waiting command is refused and never recreates it', async t => {
  const e = env(t);
  seed(e);
  const dir = e.planDir('search-v2');
  fs.writeFileSync(path.join(dir, '.lock'), 'held by archive');
  const waiting = spawnPlan(e, ['start', 'T1']);
  await sleep(300);
  const target = path.join(e.root, 'demo-app', '_archive', 'moved-search-v2');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(dir, target);
  fs.rmSync(path.join(target, '.lock'));
  const r = await waiting;
  assert.equal(r.code, 1);
  assert.match(r.err, /gone/);
  assert.ok(!fs.existsSync(dir));
  assert.equal(pf.findTask(pf.parse(fs.readFileSync(path.join(target, 'plan.md'), 'utf8')), 'T1').status, 'todo');
});

test('archive racing other commands leaves only the archived folder', async t => {
  const e = env(t);
  seed(e);
  const runs = await Promise.all([spawnPlan(e, ['archive']), spawnPlan(e, ['start', 'T1']), spawnPlan(e, ['done', 'T2']), spawnPlan(e, ['note', 'x'])]);
  assert.equal(runs[0].code, 0, runs[0].err);
  for (const r of runs.slice(1)) assert.ok(r.code === 0 || r.code === 1 || r.code === 3, r.err);
  assert.ok(!fs.existsSync(e.planDir('search-v2')));
  const arch = path.join(e.root, 'demo-app', '_archive', `${pf.iso().slice(0, 10)}-search-v2`);
  assert.equal(pf.parse(fs.readFileSync(path.join(arch, 'plan.md'), 'utf8')).meta.status, 'done');
  assert.ok(!fs.existsSync(path.join(arch, '.lock')));
});

test('a plan with status done is refused by every mutation', t => {
  const e = env(t);
  const file = seed(e);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: active', 'status: done'));
  const before = fs.readFileSync(file, 'utf8');
  for (const args of [['start', 'T1'], ['done', 'T1'], ['fail', 'T1', '--gate', 'x'], ['ask', 'Q?'], ['next', 'n'], ['note', 'n'], ['archive']]) {
    const r = e.run([...args, '--plan', 'search-v2']);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /archived/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('context prints nothing when the plans setting is off, broken or missing', t => {
  const e = env(t);
  seed(e);
  assert.match(e.run(['context'], { input: '{}' }).out, /^Plan search-v2/);
  e.setPlans(false);
  assert.deepEqual(Object.values(e.run(['context'], { input: '{}' })), [0, '', '']);
  fs.writeFileSync(e.settings, '{broken');
  assert.deepEqual(Object.values(e.run(['context'], { input: '{}' })), [0, '', '']);
  fs.rmSync(e.settings);
  assert.deepEqual(Object.values(e.run(['context'], { input: '{}' })), [0, '', '']);
});

test('context Then: lists todo tasks after the current one', t => {
  const e = env(t);
  seed(e);
  e.run(['start', 'T3']);
  const r = e.run(['context'], { input: '{}' });
  assert.match(r.out, /^Now: T3 Query endpoint/m);
  assert.match(r.out, /^Then: T4 Rate limits \(Haiku\), T5 Runbook\.$/m);
});

test('a symlinked plan.md is not read', t => {
  const e = env(t);
  const file = seed(e);
  const dir = path.join(e.root, 'demo-app', 'linked');
  fs.mkdirSync(dir);
  fs.symlinkSync(file, path.join(dir, 'plan.md'));
  assert.equal(e.run(['show', '--plan', 'linked']).code, 3);
  assert.doesNotMatch(e.run(['list']).out, /linked/);
  assert.match(e.run(['show']).out, /Search v2/);
});
