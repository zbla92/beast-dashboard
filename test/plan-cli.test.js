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
      env: { PATH: process.env.PATH, HOME: os.tmpdir(), BEAST_PLANS_DIR: root, ...opts.env },
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
  const r = e.run(['context', ...SESSION], { cwd: tmp(t), input: JSON.stringify({ cwd: e.repo, hook_event_name: 'SessionStart', source: 'clear' }) });
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
  const r = e.run(['context', ...SESSION], { input: '{}' });
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
  assert.match(e.run(['context', ...SESSION], { input: '{}' }).out, /^Plan search-v2/);
  e.setPlans(false);
  assert.deepEqual(Object.values(e.run(['context', ...SESSION], { input: '{}' })), [0, '', '']);
  fs.writeFileSync(e.settings, '{broken');
  assert.deepEqual(Object.values(e.run(['context', ...SESSION], { input: '{}' })), [0, '', '']);
  fs.rmSync(e.settings);
  assert.deepEqual(Object.values(e.run(['context', ...SESSION], { input: '{}' })), [0, '', '']);
});

test('context Then: lists todo tasks after the current one', t => {
  const e = env(t);
  seed(e);
  e.run(['start', 'T3']);
  const r = e.run(['context', ...SESSION], { input: '{}' });
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

test('-- ends the flags: the rest is text even when it looks like a flag', t => {
  const e = env(t);
  seed(e);
  e.run(['ask', 'Re-index or copy?']);
  const r = e.run(['answer', '--plan', 'search-v2', '--', 'q1', '--plan=x copy them']);
  assert.equal(r.code, 0, r.err);
  const ev = e.events('search-v2').filter(x => x.type === 'answer');
  assert.deepEqual(ev.map(x => [x.q, x.text]), [['q1', '--plan=x copy them']]);
  e.run(['ask', 'Second?']);
  assert.equal(e.run(['answer', '--', 'q2', '--blocks', 'T4']).code, 2);
  assert.equal(e.run(['answer', '--', 'q2', '--blocks T4']).code, 0);
  assert.equal(e.events('search-v2').filter(x => x.type === 'answer').pop().text, '--blocks T4');
  assert.equal(e.run(['answer', '--', 'q1', 'again']).code, 1);
});

test('context Answered: the last three answers since the last start, clipped', t => {
  const e = env(t);
  seed(e);
  e.run(['ask', 'Before start?']);
  e.run(['answer', 'q1', 'old answer']);
  e.run(['start', 'T1']);
  assert.doesNotMatch(e.run(['context', ...SESSION], { input: '{}' }).out, /^Answered:/m);
  e.run(['ask', `Long ${'q'.repeat(100)}?`]);
  for (const n of [3, 4, 5]) e.run(['ask', `Question ${n}?`]);
  e.run(['answer', 'q2', 'a'.repeat(200)]);
  e.run(['answer', 'q3', 'three']);
  const two = e.run(['context', ...SESSION], { input: '{}' }).out;
  assert.match(two, new RegExp(`^Answered: q2 "Long ${'q'.repeat(74)}…" → ${'a'.repeat(159)}…; q3 "Question 3\\?" → three$`, 'm'));
  e.run(['answer', 'q4', 'four']);
  e.run(['answer', 'q5', 'five']);
  const r = e.run(['context', ...SESSION], { input: '{}' });
  assert.equal(r.code, 0);
  assert.match(r.out, /^Answered: q3 "Question 3\?" → three; q4 "Question 4\?" → four; q5 "Question 5\?" → five$/m);
  assert.ok(r.out.length <= 1601);
  e.run(['done', 'T1']);
  e.run(['start', 'T2']);
  assert.doesNotMatch(e.run(['context', ...SESSION], { input: '{}' }).out, /^Answered:/m);
});

const statusOf = (e, topic = 'search-v2') => pf.parse(e.planText(topic)).meta.status;
const lifecycleEvents = (e, topic = 'search-v2') => e.events(topic).filter(x => ['finish', 'reopen', 'restore'].includes(x.type));
const finishAll = (e, ids = ['T1', 'T2', 'T3', 'T4', 'T5']) => { for (const id of ids) assert.equal(e.run(['done', id]).code, 0); };

test('done on the last task finishes the plan, in the same line and log', t => {
  const e = env(t);
  seed(e);
  finishAll(e, ['T1', 'T2', 'T3', 'T4']);
  assert.equal(statusOf(e), 'active');
  assert.deepStrictEqual(lifecycleEvents(e), []);
  const r = e.run(['done', 'T5']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'T5 done · Runbook · phase 2 complete · plan finished. Ask the user whether to archive it; do not archive without asking.\n');
  assert.equal(statusOf(e), 'finished');
  const last = e.events('search-v2').slice(-3).map(x => x.type);
  assert.deepStrictEqual(last, ['done', 'phase', 'finish']);
  assert.equal(lifecycleEvents(e)[0].text, 'all tasks done');
  assert.doesNotMatch(e.run(['done', 'T5']).out, /plan finished/);
  assert.equal(lifecycleEvents(e).length, 1);
});

test('parallel done commands write exactly one finish event', async t => {
  const e = env(t);
  seed(e);
  const rs = await Promise.all(['T1', 'T2', 'T3', 'T4', 'T5'].map(id => spawnPlan(e, ['done', id])));
  assert.deepStrictEqual(rs.map(r => r.code), [0, 0, 0, 0, 0], rs.map(r => r.err).join());
  assert.equal(statusOf(e), 'finished');
  assert.equal(lifecycleEvents(e).filter(x => x.type === 'finish').length, 1);
});

test('undo sends a done task back to open, drops the gate and logs it', t => {
  const e = env(t);
  const file = seed(e);
  assert.equal(e.run(['done', 'T1', '--gate', '12 tests']).code, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /- \[x\] T1 Index schema · Opus · gate ✓ 12 tests/);
  const r = e.run(['undo', 'T1']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'T1 open · Index schema\n');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^- \[ \] T1 Index schema · Opus$/m);
  assert.equal(e.events('search-v2').pop().type, 'undo');
  assert.equal(e.events('search-v2').pop().task, 'T1');
  assert.equal(statusOf(e), 'active');
});

test('undo on an open task says already open and writes nothing', t => {
  const e = env(t);
  const file = seed(e);
  const before = fs.readFileSync(file, 'utf8');
  const n = e.events('search-v2').length;
  const r = e.run(['undo', 'T2']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'already open\n');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(e.events('search-v2').length, n);
});

test('undo on a finished plan makes it active in the same log, and the next done finishes it again', t => {
  const e = env(t);
  seed(e);
  finishAll(e);
  assert.equal(statusOf(e), 'finished');
  assert.equal(e.run(['undo', 'T5']).code, 0);
  assert.equal(statusOf(e), 'active');
  assert.deepStrictEqual(e.events('search-v2').slice(-2).map(x => x.type), ['undo', 'reopen']);
  assert.equal(e.run(['done', 'T5']).code, 0);
  assert.equal(statusOf(e), 'finished');
});

test('undo on a plan marked finished with open tasks leaves it alone when the task is open', t => {
  const e = env(t);
  seed(e);
  assert.equal(e.run(['finish']).code, 0);
  assert.equal(e.run(['undo', 'T1']).out, 'already open\n');
  assert.equal(statusOf(e), 'finished');
});

test('undo takes doing and failed tasks back to open; a blocked task stays blocked', t => {
  const e = env(t);
  const file = seed(e);
  assert.equal(e.run(['start', 'T1']).code, 0);
  assert.equal(e.run(['undo', 'T1']).code, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /^- \[ \] T1 /m);
  assert.equal(e.run(['fail', 'T2', '--gate', 'red']).code, 0);
  assert.equal(e.run(['undo', 'T2']).code, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /^- \[ \] T2 Contract tests · Sonnet$/m);
  assert.equal(e.run(['ask', 'why?', '--blocks', 'T3']).code, 0);
  assert.equal(e.run(['undo', 'T3']).out, 'already open\n');
  assert.match(fs.readFileSync(file, 'utf8'), /^- \[\?\] T3 /m);
});

test('undo refuses a bad or unknown task id and a -- keeps the argument positional', t => {
  const e = env(t);
  seed(e);
  assert.equal(e.run(['undo']).code, 2);
  assert.equal(e.run(['undo', 'x1']).code, 2);
  assert.notEqual(e.run(['undo', 'T99']).code, 0);
  assert.equal(e.run(['done', 'T1']).code, 0);
  assert.equal(e.run(['undo', '--', 'T1']).code, 0);
  assert.equal(e.events('search-v2').pop().type, 'undo');
});

test('help names undo', t => {
  assert.match(env(t).run(['help']).out, /^ {2}undo <T> /m);
});

test('start, fail and ask --blocks reopen a finished plan', t => {
  for (const [name, args, status] of [
    ['start', ['start', 'T1'], 'doing'],
    ['fail', ['fail', 'T1', '--gate', 'red'], 'failed'],
    ['ask', ['ask', 'Why?', '--blocks', 'T1'], 'blocked'],
  ]) {
    const e = env(t);
    seed(e);
    assert.equal(e.run(['finish']).code, 0, name);
    const r = e.run(args);
    assert.equal(r.code, 0, r.err);
    assert.equal(statusOf(e), 'active', name);
    assert.equal(pf.findTask(pf.parse(e.planText('search-v2')), 'T1').status, status, name);
    assert.deepStrictEqual(lifecycleEvents(e).map(x => x.type), ['finish', 'reopen'], name);
    assert.equal(e.events('search-v2').pop().type, 'reopen', name);
    assert.equal(e.events('search-v2').pop().text, undefined, name);
  }
});

test('done that leaves an open task reopens a finished plan; done that leaves none stays finished', t => {
  const e = env(t);
  seed(e);
  e.run(['finish']);
  assert.equal(e.run(['done', 'T1']).code, 0);
  assert.equal(statusOf(e), 'active');
  assert.deepStrictEqual(lifecycleEvents(e).map(x => x.type), ['finish', 'reopen']);
  finishAll(e, ['T2', 'T3', 'T4', 'T5']);
  assert.equal(statusOf(e), 'finished');
  assert.equal(e.run(['done', 'T1']).code, 0);
  assert.equal(statusOf(e), 'finished');
  assert.deepStrictEqual(lifecycleEvents(e).map(x => x.type), ['finish', 'reopen', 'finish']);
});

test('a refused command does not reopen; ask without blocks, answer, note, next and a hand-added task do not either', t => {
  const e = env(t);
  seed(e);
  finishAll(e);
  assert.equal(e.run(['start', 'T1']).code, 1);
  assert.equal(statusOf(e), 'finished');
  assert.equal(e.run(['ask', 'Plain question?']).code, 0);
  assert.equal(e.run(['answer', 'q1', 'fine']).code, 0);
  assert.equal(e.run(['note', 'hello']).code, 0);
  assert.equal(e.run(['next', 'later']).code, 0);
  assert.equal(statusOf(e), 'finished');
  const file = path.join(e.planDir('search-v2'), 'plan.md');
  fs.appendFileSync(file, '- [ ] T6 Added by hand\n');
  assert.equal(e.run(['validate']).code, 0);
  assert.equal(e.run(['note', 'still finished']).code, 0);
  assert.equal(statusOf(e), 'finished');
  assert.equal(e.run(['start', 'T6']).code, 0);
  assert.equal(statusOf(e), 'active');
  assert.deepStrictEqual(lifecycleEvents(e).map(x => x.type), ['finish', 'reopen']);
});

test('finish marks an active plan with open tasks; a second finish writes nothing', t => {
  const e = env(t);
  seed(e);
  const r = e.run(['finish']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'search-v2 · plan finished. Ask the user whether to archive it; do not archive without asking.\n');
  assert.equal(statusOf(e), 'finished');
  assert.deepStrictEqual(lifecycleEvents(e).map(x => [x.type, x.text]), [['finish', 'marked finished']]);
  const file = path.join(e.planDir('search-v2'), 'plan.md');
  const events = path.join(e.planDir('search-v2'), 'events.jsonl');
  const past = new Date(Date.now() - 86400000);
  fs.utimesSync(file, past, past);
  fs.utimesSync(events, past, past);
  const before = [fs.statSync(file).mtimeMs, fs.statSync(events).mtimeMs, fs.readFileSync(events, 'utf8')];
  const again = e.run(['finish']);
  assert.equal(again.code, 0);
  assert.equal(again.out, 'already finished\n');
  assert.deepStrictEqual([fs.statSync(file).mtimeMs, fs.statSync(events).mtimeMs, fs.readFileSync(events, 'utf8')], before);
  assert.equal(e.run(['finish', 'extra']).code, 2);
});

test('a finished plan stays live: resolved, claimable, mutable, in plan context, in plan list', t => {
  const e = env(t);
  seed(e);
  finishAll(e);
  assert.equal(e.run(['validate']).code, 0);
  assert.equal(e.run(['show']).code, 0);
  assert.match(e.run(['show']).out, /· finished$/m);
  assert.equal(e.run(['path']).code, 0);
  assert.match(e.run(['list']).out, /search-v2 {2}5\/5 {2}finished/);
  assert.equal(e.run(['use', 'search-v2', '--session', 'claude-other']).code, 0);
  assert.equal(e.run(['note', 'done and dusted']).code, 0);
  assert.match(e.run(['context', ...SESSION], { input: '{}' }).out, /^Plan search-v2 "Search v2" \(demo-app\): 5\/5 tasks done/);
  const j = JSON.parse(e.run(['show', '--json']).out);
  assert.equal(j.finished, true);
  assert.ok(pf.isIso(j.finishedAt));
  assert.equal(e.run(['archive']).code, 0);
  assert.equal(e.run(['show']).code, 3);
});

test('restore brings a complete plan back as finished, with the lock gone and the event logged', t => {
  const e = env(t);
  seed(e);
  finishAll(e);
  assert.equal(e.run(['archive']).code, 0);
  const folder = `${pf.iso().slice(0, 10)}-search-v2`;
  const r = e.run(['restore', folder]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'restored search-v2 -> demo-app/search-v2\n');
  assert.ok(!fs.existsSync(path.join(e.root, 'demo-app', '_archive', folder)));
  assert.ok(!fs.existsSync(path.join(e.planDir('search-v2'), '.lock')));
  const doc = pf.parse(e.planText('search-v2'));
  assert.equal(doc.meta.status, 'finished');
  assert.ok(!Object.hasOwn(doc.meta, 'archived'));
  assert.equal(e.events('search-v2').pop().type, 'restore');
  assert.equal(e.run(['note', 'back again']).code, 0);
});

const failingRestore = (t, hookCode) => {
  const e = env(t);
  seed(e);
  finishAll(e);
  assert.equal(e.run(['archive']).code, 0);
  const folder = `${pf.iso().slice(0, 10)}-search-v2`;
  const archived = path.join(e.root, 'demo-app', '_archive', folder);
  const planBefore = fs.readFileSync(path.join(archived, 'plan.md'), 'utf8');
  const eventsBefore = fs.readFileSync(path.join(archived, 'events.jsonl'), 'utf8');
  const hook = path.join(tmp(t, 'bd-plancli-hook-'), 'fail.js');
  fs.writeFileSync(hook, hookCode);
  const r = e.run(['restore', folder], { env: { NODE_OPTIONS: `--require ${hook}` } });
  assert.equal(r.code, 1);
  assert.match(r.err, /disk full/);
  assert.ok(!fs.existsSync(e.planDir('search-v2')));
  assert.deepStrictEqual(fs.readdirSync(archived).sort(), ['events.jsonl', 'plan.md']);
  assert.equal(fs.readFileSync(path.join(archived, 'plan.md'), 'utf8'), planBefore);
  assert.equal(fs.readFileSync(path.join(archived, 'events.jsonl'), 'utf8'), eventsBefore);
  const again = e.run(['restore', folder]);
  assert.equal(again.code, 0, again.err);
  assert.equal(statusOf(e), 'finished');
  assert.deepStrictEqual(e.events('search-v2').filter(x => x.type === 'restore').length, 1);
};

test('restore moves the plan back to the archive when writing plan.md fails, and can be run again', t => {
  failingRestore(t, `const fs = require('fs');
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).endsWith('plan.md')) throw new Error('disk full');
  return rename(from, to);
};
`);
});

test('restore moves the plan back and undoes the write when logging the event fails', t => {
  failingRestore(t, `const fs = require('fs');
fs.appendFileSync = () => { throw new Error('disk full'); };
`);
});

const FINISHED_LINE = 'This plan is finished. Ask the user whether to archive it; do not archive without asking.';
const contextOf = e => e.run(['context', ...SESSION], { input: JSON.stringify({ session_id: 's', cwd: e.repo, hook_event_name: 'SessionStart', source: 'startup' }) }).out;

test('plan context tells Claude to ask before archiving a finished plan, and only then', t => {
  const e = env(t);
  seed(e);
  assert.ok(!contextOf(e).includes(FINISHED_LINE));
  assert.equal(e.run(['finish']).code, 0);
  assert.ok(contextOf(e).split('\n').includes(FINISHED_LINE));
  assert.equal(e.run(['start', 'T1']).code, 0);
  assert.ok(!contextOf(e).includes(FINISHED_LINE));
});

test('a plan with every task done but status active stays active, and context still says it is finished', t => {
  const e = env(t);
  seed(e);
  const file = path.join(e.planDir('search-v2'), 'plan.md');
  fs.writeFileSync(file, e.planText('search-v2').replace(/^(\s*- )\[.\]/gm, '$1[x]'));
  assert.ok(contextOf(e).split('\n').includes(FINISHED_LINE));
  assert.equal(statusOf(e), 'active');
  assert.deepStrictEqual(lifecycleEvents(e), []);
});

test('restore brings an unfinished plan back as active', t => {
  const e = env(t);
  seed(e);
  assert.equal(e.run(['archive']).code, 0);
  assert.equal(e.run(['restore', `${pf.iso().slice(0, 10)}-search-v2`]).code, 0);
  assert.equal(statusOf(e), 'active');
  assert.equal(e.run(['start', 'T1']).code, 0);
});

test('restore refuses a taken topic and leaves the archive as it was', t => {
  const e = env(t);
  seed(e);
  assert.equal(e.run(['archive']).code, 0);
  seed(e);
  const folder = `${pf.iso().slice(0, 10)}-search-v2`;
  const dir = path.join(e.root, 'demo-app', '_archive', folder);
  const before = fs.readFileSync(path.join(dir, 'plan.md'), 'utf8');
  const r = e.run(['restore', folder]);
  assert.equal(r.code, 1);
  assert.equal(r.err, `plan: plan search-v2 already exists for ${e.repo}\n`);
  assert.equal(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(dir, '.lock')));
  assert.equal(pf.readEvents(dir).events.pop().type, 'archive');
});

test('restore takes the topic from the frontmatter, not the folder name', t => {
  const e = env(t);
  seed(e);
  assert.equal(e.run(['archive']).code, 0);
  const archive = path.join(e.root, 'demo-app', '_archive');
  fs.renameSync(path.join(archive, `${pf.iso().slice(0, 10)}-search-v2`), path.join(archive, 'renamed'));
  assert.equal(e.run(['restore', 'renamed']).code, 0);
  assert.ok(fs.existsSync(path.join(e.planDir('search-v2'), 'plan.md')));
});

test('restore refuses bad folders, unknown repos, symlinks and an archived plan with errors', t => {
  const e = env(t);
  seed(e);
  assert.equal(e.run(['restore']).code, 2);
  for (const bad of ['../search-v2', '..', 'a/b', '_x']) assert.equal(e.run(['restore', '--', bad]).code, 2, bad);
  assert.equal(e.run(['restore', 'nope']).code, 3);
  assert.equal(e.run(['restore', 'x', '--repo', path.join(e.repo, 'not-here')]).code, 3);
  assert.equal(e.run(['archive']).code, 0);
  const archive = path.join(e.root, 'demo-app', '_archive');
  const folder = `${pf.iso().slice(0, 10)}-search-v2`;
  const outside = path.join(tmp(t), 'outside');
  fs.cpSync(path.join(archive, folder), outside, { recursive: true });
  fs.symlinkSync(outside, path.join(archive, 'linked'));
  assert.equal(e.run(['restore', 'linked']).code, 3);
  const file = path.join(archive, folder, 'plan.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: done', 'status: paused'));
  const r = e.run(['restore', folder]);
  assert.equal(r.code, 1);
  assert.match(r.err, /plan\.md has errors/);
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(e.planDir('search-v2')));
});

test('finish and restore act through --repo and -- from outside the repo, like the server', t => {
  const e = env(t);
  seed(e);
  const outside = { cwd: e.root };
  assert.equal(e.run(['finish', '--repo', e.repo, '--plan', 'search-v2'], outside).code, 0);
  const a = e.run(['archive', '--repo', e.repo, '--plan', 'search-v2'], outside);
  assert.equal(a.code, 0);
  const folder = /_archive\/(\S+)$/m.exec(a.out)[1];
  assert.equal(e.run(['restore', '--repo', e.repo, '--', folder], outside).code, 0);
  assert.equal(statusOf(e), 'active');
});

test('help lists finish and restore', t => {
  const out = env(t).run(['help']).out;
  assert.match(out, /^ {2}finish\b/m);
  assert.match(out, /^ {2}restore <folder>/m);
});

const NEW_SESSION = ['--session', 'claude-new'];
const claimOf = (e, session = 'claude-new') => pf.readClaim(e.root, session);
const openPlanLine = (topic, done = 0, total = 5) => `Open plan in this repo, not picked by this session: ${topic} "Search v2" ${done}/${total}. If the user wants to continue it: plan use ${topic}. Do not work on it otherwise.\n`;

test('context with no claim: one unfinished plan gets the exact offer line, nothing else', t => {
  const e = env(t);
  seed(e);
  e.run(['start', 'T1']);
  assert.equal(e.run(['context'], { input: '{}' }).out, openPlanLine('search-v2'));
  assert.equal(e.run(['context', ...NEW_SESSION], { input: '{}' }).out, openPlanLine('search-v2'));
  assert.equal(claimOf(e), null);
  assert.match(e.run(['context', ...SESSION], { input: '{}' }).out, /^Plan search-v2/);
  assert.match(e.run(['context', '--plan', 'search-v2'], { input: '{}' }).out, /^Plan search-v2/);
});

test('context with no claim never offers a finished plan; a session that claimed it still gets the archive line', t => {
  const e = env(t);
  seed(e);
  assert.equal(e.run(['finish']).code, 0);
  assert.equal(e.run(['context'], { input: '{}' }).out, '');
  assert.ok(contextOf(e).split('\n').includes(FINISHED_LINE));
  seed(e, 'open-one');
  assert.equal(e.run(['context'], { input: '{}' }).out, openPlanLine('open-one'));
  seed(e, 'open-two');
  const many = e.run(['context'], { input: '{}' }).out;
  assert.match(many, /^Active plans for demo-app/);
  assert.match(many, /^open-one 0\/5, next T1$/m);
  assert.match(many, /^open-two 0\/5, next T1$/m);
  assert.doesNotMatch(many, /search-v2/);
  assert.match(many, /^Pick one with: plan use <topic>$/m);
});

test('context with no claim counts a plan with every task done as finished', t => {
  const e = env(t);
  seed(e);
  fs.writeFileSync(path.join(e.planDir('search-v2'), 'plan.md'), e.planText('search-v2').replace(/^(\s*- )\[.\]/gm, '$1[x]'));
  assert.equal(e.run(['context'], { input: '{}' }).out, '');
});

test('context outside a git repo leaves finished plans out of its list', t => {
  const e = env(t);
  seed(e);
  seed(e, 'open-one');
  assert.equal(e.run(['finish', '--plan', 'search-v2']).code, 0);
  const r = e.run(['context'], { cwd: tmp(t), input: JSON.stringify({ cwd: path.dirname(e.repo) }) });
  assert.match(r.out, /^demo-app\/open-one /m);
  assert.doesNotMatch(r.out, /search-v2/);
});

for (const [name, args] of Object.entries({
  start: ['start', 'T1'],
  done: ['done', 'T1'],
  fail: ['fail', 'T1', '--gate', 'lint'],
  ask: ['ask', 'Which?'],
  next: ['next', 'carry on'],
  note: ['note', 'a note'],
  finish: ['finish'],
})) {
  test(`${name} from a session with no claim claims the plan it acted on`, t => {
    const e = env(t);
    seed(e);
    assert.equal(claimOf(e), null);
    const r = e.run([...args, ...NEW_SESSION]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([claimOf(e).repoDir, claimOf(e).topic], ['demo-app', 'search-v2']);
  });
}

test('answer from a session with no claim claims the plan it acted on', t => {
  const e = env(t);
  seed(e);
  e.run(['ask', 'Which?']);
  assert.equal(claimOf(e), null);
  assert.equal(e.run(['answer', 'q1', 'this one', ...NEW_SESSION]).code, 0);
  assert.equal(claimOf(e).topic, 'search-v2');
});

test('read-only commands and refused commands do not claim', t => {
  const e = env(t);
  seed(e);
  for (const args of [['show'], ['show', '--json'], ['list'], ['path'], ['validate']]) {
    assert.equal(e.run([...args, ...NEW_SESSION]).code, 0, args.join(' '));
    assert.equal(claimOf(e), null, args.join(' '));
  }
  assert.notEqual(e.run(['start', 'T99', ...NEW_SESSION]).code, 0);
  assert.equal(e.run(['done', 'T1', '--plan', 'nope', ...NEW_SESSION]).code, 3);
  assert.equal(e.run(['answer', 'q9', 'nope', ...NEW_SESSION]).code, 1);
  assert.equal(claimOf(e), null);
});

test('a command on another plan keeps a live claim, and replaces one whose plan is gone', t => {
  const e = env(t);
  seed(e, 'a');
  seed(e, 'b');
  assert.equal(e.run(['use', 'a', ...NEW_SESSION]).code, 0);
  assert.equal(e.run(['note', 'on b', '--plan', 'b', ...NEW_SESSION]).code, 0);
  assert.equal(claimOf(e).topic, 'a');
  assert.equal(e.run(['archive', '--plan', 'a']).code, 0);
  assert.equal(e.run(['note', 'still on b', '--plan', 'b', ...NEW_SESSION]).code, 0);
  assert.equal(claimOf(e).topic, 'b');
});

test('a chat moved to another repo claims that repo\'s only plan, and a live claim in the same repo stays', t => {
  const e = env(t);
  seed(e, 'a');
  seed(e, 'b');
  assert.equal(e.run(['use', 'a', ...NEW_SESSION]).code, 0);
  const other = makeRepo(t, 'other-app');
  assert.equal(e.run(['new', 'solo', '--title', 'Solo'], { cwd: other }).code, 0);
  assert.equal(e.run(['note', 'moved', ...NEW_SESSION], { cwd: other }).code, 0);
  assert.deepEqual([claimOf(e).repoDir, claimOf(e).topic], ['other-app', 'solo']);
  assert.equal(e.run(['note', 'back', '--plan', 'a', ...NEW_SESSION]).code, 0);
  assert.equal(claimOf(e).topic, 'solo');
  assert.equal(e.run(['use', 'a', ...NEW_SESSION]).code, 0);
  assert.equal(e.run(['note', 'again', '--repo', other, ...NEW_SESSION]).code, 0);
  assert.equal(claimOf(e).topic, 'a');
});

test('use keeps its behaviour: --clear stays cleared until a command runs again, and no session writes no claim', t => {
  const e = env(t);
  seed(e);
  assert.equal(e.run(['use', 'search-v2', ...NEW_SESSION]).code, 0);
  assert.equal(e.run(['use', '--clear', ...NEW_SESSION]).code, 0);
  assert.equal(claimOf(e), null);
  assert.equal(e.run(['context', ...NEW_SESSION], { input: '{}' }).out, openPlanLine('search-v2'));
  assert.equal(e.run(['note', 'no session']).code, 0);
  assert.deepEqual(fs.readdirSync(path.join(e.root, '.claims')), ['claude-test.json']);
  assert.equal(e.run(['note', 'again', ...NEW_SESSION]).code, 0);
  assert.equal(claimOf(e).topic, 'search-v2');
});

test('a claim that cannot be written does not fail a command that already took effect', t => {
  const e = env(t);
  assert.equal(e.run(['new', 'search-v2', '--title', 'Search v2']).code, 0);
  fs.writeFileSync(path.join(e.root, '.claims'), '');
  assert.equal(e.run(['note', 'kept', ...NEW_SESSION]).code, 0);
  assert.equal(e.events('search-v2').filter(x => x.type === 'note').length, 1);
});

const failingArchive = (t, hookCode) => {
  const e = env(t);
  seed(e);
  e.run(['start', 'T1']);
  const dir = e.planDir('search-v2');
  const planBefore = e.planText('search-v2');
  const eventsBefore = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  const hook = path.join(tmp(t, 'bd-plancli-hook-'), 'fail.js');
  fs.writeFileSync(hook, hookCode);
  const r = e.run(['archive'], { env: { NODE_OPTIONS: `--require ${hook}` } });
  assert.equal(r.code, 1);
  assert.match(r.err, /disk full/);
  assert.equal(e.planText('search-v2'), planBefore);
  assert.equal(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), eventsBefore);
  assert.equal(statusOf(e), 'active');
  assert.ok(!fs.existsSync(path.join(dir, '.lock')));
  assert.equal(e.run(['note', 'still live']).code, 0);
  const again = e.run(['archive']);
  assert.equal(again.code, 0, again.err);
  assert.ok(!fs.existsSync(dir));
  assert.equal(pf.listPlans(e.root).filter(p => p.archived).length, 1);
};

test('archive puts plan.md and events.jsonl back when the move fails, and can be run again', t => {
  failingArchive(t, `const fs = require('fs');
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).includes('_archive')) throw new Error('disk full');
  return rename(from, to);
};
`);
});

test('archive puts plan.md back when logging the event fails', t => {
  failingArchive(t, `const fs = require('fs');
fs.appendFileSync = () => { throw new Error('disk full'); };
`);
});

test('archive leaves no events file behind when the plan had none and the move fails', t => {
  const e = env(t);
  seed(e);
  const events = path.join(e.planDir('search-v2'), 'events.jsonl');
  fs.rmSync(events);
  const hook = path.join(tmp(t, 'bd-plancli-hook-'), 'fail.js');
  fs.writeFileSync(hook, `const fs = require('fs');
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).includes('_archive')) throw new Error('disk full');
  return rename(from, to);
};
`);
  assert.equal(e.run(['archive'], { env: { NODE_OPTIONS: `--require ${hook}` } }).code, 1);
  assert.ok(!fs.existsSync(events));
  assert.equal(statusOf(e), 'active');
});
