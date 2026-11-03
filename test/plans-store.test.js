const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pf = require('../lib/planfile');
const { createPlanStore } = require('../lib/plans2');

const FIX = path.join(__dirname, 'fixtures', 'plans', 'store');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-plans-store-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function storeCopy(t) {
  const root = path.join(tmp(t), 'plans');
  fs.cpSync(FIX, root, { recursive: true });
  return root;
}

function gitRepo(t, name = 'demo-app') {
  const dir = path.join(tmp(t), name);
  fs.mkdirSync(dir);
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); }
  return fn();
}

test('summaries list live and archived plans with server fields', t => {
  const store = createPlanStore({ root: storeCopy(t) });
  const list = store.summaries({ projects: [] });
  const live = list.find(p => p.id === 'demo-app/search-v2');
  assert.ok(live);
  assert.strictEqual(live.repoDir, 'demo-app');
  assert.strictEqual(live.projectId, null);
  assert.deepStrictEqual(live.sessions, []);
  assert.ok(live.mtime > 0);
  assert.strictEqual(live.topic, 'search-v2');
  assert.ok(live.total > 0);
});

test('archived plans older than 14 days are hidden unless archived=1', t => {
  const root = storeCopy(t);
  const store = createPlanStore({ root });
  const archived = pf.listPlans(root).filter(p => p.archived);
  assert.ok(archived.length > 0);
  const longAgo = new Date(Date.now() - 40 * 86400000);
  const file = path.join(archived[0].dir, 'plan.md');
  const doc = pf.parse(fs.readFileSync(file, 'utf8'));
  doc.meta.archived = pf.iso(longAgo);
  fs.writeFileSync(file, pf.serialize(doc));
  fs.utimesSync(file, longAgo, longAgo);
  assert.strictEqual(store.summaries({}).filter(p => p.id.includes('_archive')).length, archived.length - 1);
  assert.ok(store.summaries({ archived: true }).some(p => p.id === archived[0].id));
});

test('detail returns phases and timeline, an error shape for unknown ids', t => {
  const store = createPlanStore({ root: storeCopy(t) });
  const d = store.detail('demo-app/search-v2', {});
  assert.strictEqual(d.id, 'demo-app/search-v2');
  assert.ok(Array.isArray(d.phases) && d.phases.length > 0);
  assert.ok(Array.isArray(d.timeline));
  assert.ok(Array.isArray(d.errors));
  assert.deepStrictEqual(store.detail('demo-app/nope', {}), { error: 'no such plan' });
  const arch = pf.listPlans(FIX).find(p => p.archived);
  assert.ok(store.detail(arch.id, {}).phases);
});

test('ids outside the store are rejected', t => {
  const root = storeCopy(t);
  const secret = path.join(path.dirname(root), 'secret');
  fs.mkdirSync(secret);
  fs.copyFileSync(path.join(root, 'demo-app', 'search-v2', 'plan.md'), path.join(secret, 'plan.md'));
  const store = createPlanStore({ root });
  const ids = ['..', '../secret', 'demo-app/../../secret', '../secret/x', 'demo-app/search-v2/../..', '/etc/passwd', 'demo-app', 'a/b/c/d', 'demo-app/_x/search-v2', 'demo-app/.repo', '.claims/x', '', 'demo-app//search-v2', 'demo-app/search-v2\0'];
  for (const id of ids) assert.ok(store.detail(id, {}).error, `rejects ${JSON.stringify(id)}`);
});

test('symlinked plan folders and files are not served', t => {
  const root = storeCopy(t);
  const outside = path.join(path.dirname(root), 'outside');
  fs.cpSync(path.join(root, 'demo-app', 'search-v2'), outside, { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'demo-app', 'linked'));
  fs.mkdirSync(path.join(root, 'demo-app', 'filelink'));
  fs.symlinkSync(path.join(outside, 'plan.md'), path.join(root, 'demo-app', 'filelink', 'plan.md'));
  fs.symlinkSync(outside, path.join(root, 'link-repo'));
  const store = createPlanStore({ root });
  assert.ok(store.detail('demo-app/linked', {}).error);
  assert.ok(store.detail('demo-app/filelink', {}).error);
  assert.ok(store.detail('link-repo/search-v2', {}).error);
  assert.ok(!store.summaries({}).some(p => p.id === 'demo-app/linked' || p.id === 'demo-app/filelink'));
});

test('a symlinked events.jsonl is ignored, the plan still loads', t => {
  const root = storeCopy(t);
  const dir = path.join(root, 'demo-app', 'search-v2');
  const target = path.join(path.dirname(root), 'ev.jsonl');
  fs.copyFileSync(path.join(dir, 'events.jsonl'), target);
  fs.rmSync(path.join(dir, 'events.jsonl'));
  fs.symlinkSync(target, path.join(dir, 'events.jsonl'));
  const d = createPlanStore({ root }).detail('demo-app/search-v2', {});
  assert.deepStrictEqual(d.timeline, []);
  assert.ok(d.phases.length > 0);
});

test('parsed plans are cached by mtime and refreshed on change', t => {
  const root = storeCopy(t);
  const store = createPlanStore({ root });
  const before = store.detail('demo-app/search-v2', {});
  const file = path.join(root, 'demo-app', 'search-v2', 'plan.md');
  const doc = pf.parse(fs.readFileSync(file, 'utf8'));
  doc.meta.title = 'Renamed';
  fs.writeFileSync(file, pf.serialize(doc));
  const after = store.detail('demo-app/search-v2', {});
  assert.notStrictEqual(before.title, 'Renamed');
  assert.strictEqual(after.title, 'Renamed');
});

test('projectId follows the plan repo', t => {
  const root = storeCopy(t);
  const repo = gitRepo(t);
  const file = path.join(root, 'demo-app', 'search-v2', 'plan.md');
  const doc = pf.parse(fs.readFileSync(file, 'utf8'));
  doc.meta.repo = repo;
  fs.writeFileSync(file, pf.serialize(doc));
  const p = createPlanStore({ root }).summaries({ projects: [{ id: 'proj-1', path: repo }] }).find(x => x.id === 'demo-app/search-v2');
  assert.strictEqual(p.projectId, 'proj-1');
});

test('sessions map to the claimed plan, else the repo single active plan', async t => {
  const root = storeCopy(t);
  const repo = gitRepo(t);
  fs.writeFileSync(path.join(root, 'demo-app', '.repo'), repo + '\n');
  const worktree = path.join(repo, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', worktree, '-b', 'wt'], { cwd: repo, stdio: 'ignore' });
  const sessions = [{ name: 'claude-a', cwd: repo }, { name: 'claude-b', cwd: worktree }, { name: 'claude-c', cwd: os.tmpdir() }];
  const store = createPlanStore({ root });
  const mapped = () => store.summaries({ sessions }).find(p => p.id === 'demo-app/search-v2').sessions;
  assert.deepStrictEqual(mapped(), []);
  await waitFor(() => mapped().length === 2);
  assert.deepStrictEqual(mapped(), ['claude-a', 'claude-b']);

  const second = pf.newPlan({ topic: 'other', title: 'Other', repo, created: pf.iso(new Date()) });
  pf.writePlan(path.join(root, 'demo-app', 'other'), second);
  const none = store.summaries({ sessions });
  assert.deepStrictEqual(none.find(p => p.id === 'demo-app/search-v2').sessions, []);
  assert.deepStrictEqual(none.find(p => p.id === 'demo-app/other').sessions, []);

  pf.writeClaim(root, 'claude-b', 'demo-app', 'other');
  const claimed = store.summaries({ sessions });
  assert.deepStrictEqual(claimed.find(p => p.id === 'demo-app/other').sessions, ['claude-b']);
  assert.deepStrictEqual(store.detail('demo-app/other', { sessions }).sessions, ['claude-b']);

  pf.writeClaim(root, 'claude-b', 'demo-app', 'gone-topic');
  assert.deepStrictEqual(store.summaries({ sessions }).find(p => p.id === 'demo-app/other').sessions, []);
});

test('watch pushes one debounced event per plan change and reports removal', async t => {
  const root = storeCopy(t);
  const seen = [];
  const w = createPlanStore({ root }).watch(ev => seen.push(ev));
  t.after(() => w.close());
  const dir = path.join(root, 'demo-app', 'search-v2');
  for (const _ of Array(5)) fs.appendFileSync(path.join(dir, 'events.jsonl'), '\n');
  await waitFor(() => seen.length);
  await sleep(500);
  const mine = seen.filter(e => e.id === 'demo-app/search-v2');
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].removed, false);
  assert.ok(mine[0].mtime > 0);

  seen.length = 0;
  fs.renameSync(dir, path.join(root, 'demo-app', '_archive', '2026-11-03-search-v2'));
  await waitFor(() => seen.some(e => e.removed) && seen.some(e => !e.removed));
  assert.ok(seen.some(e => e.id === 'demo-app/search-v2' && e.removed));
  assert.ok(seen.some(e => e.id === 'demo-app/_archive/2026-11-03-search-v2' && !e.removed));
});

test('watch ignores lock and temp files', async t => {
  const root = storeCopy(t);
  const seen = [];
  const w = createPlanStore({ root }).watch(ev => seen.push(ev));
  t.after(() => w.close());
  const dir = path.join(root, 'demo-app', 'search-v2');
  fs.writeFileSync(path.join(dir, '.lock'), '');
  fs.writeFileSync(path.join(dir, 'plan.md.tmp-1'), 'x');
  fs.rmSync(path.join(dir, '.lock'));
  await sleep(700);
  assert.deepStrictEqual(seen, []);
});

test('watch survives a store that does not exist yet', async t => {
  const root = path.join(tmp(t), 'later', 'plans');
  const store = createPlanStore({ root });
  const seen = [];
  const w = store.watch(ev => seen.push(ev));
  t.after(() => w.close());
  assert.deepStrictEqual(store.summaries({}), []);
  assert.deepStrictEqual(store.detail('a/b', {}), { error: 'no such plan' });
  fs.cpSync(FIX, root, { recursive: true });
  await waitFor(() => seen.length, 9000);
  assert.ok(seen.some(e => e.id === 'demo-app/search-v2' && !e.removed));
  await sleep(500);
  seen.length = 0;
  fs.appendFileSync(path.join(root, 'demo-app', 'search-v2', 'events.jsonl'), '\n');
  await waitFor(() => seen.length);
  assert.ok(seen.some(e => e.id === 'demo-app/search-v2'));
});

test('watch falls back to polling when fs.watch fails with ENOSPC', async t => {
  const root = storeCopy(t);
  const realWatch = fs.watch;
  fs.watch = () => { const e = new Error('limit'); e.code = 'ENOSPC'; throw e; };
  const seen = [];
  const w = createPlanStore({ root }).watch(ev => seen.push(ev));
  fs.watch = realWatch;
  t.after(() => w.close());
  fs.appendFileSync(path.join(root, 'demo-app', 'search-v2', 'events.jsonl'), '\n');
  await waitFor(() => seen.length, 9000);
  assert.ok(seen.some(e => e.id === 'demo-app/search-v2'));
});

test('a new session cwd resolves in the background and a plan event follows', async t => {
  const root = storeCopy(t);
  const repo = gitRepo(t);
  fs.writeFileSync(path.join(root, 'demo-app', '.repo'), repo + '\n');
  const store = createPlanStore({ root });
  const seen = [];
  const w = store.watch(ev => seen.push(ev));
  t.after(() => w.close());
  const sessions = [{ name: 'claude-a', cwd: repo }];
  const t0 = Date.now();
  assert.deepStrictEqual(store.detail('demo-app/search-v2', { sessions }).sessions, []);
  assert.ok(Date.now() - t0 < 1000);
  await waitFor(() => seen.some(e => e.id === 'demo-app/search-v2'));
  assert.ok(!seen.some(e => e.id.includes('_archive')));
  assert.deepStrictEqual(store.detail('demo-app/search-v2', { sessions }).sessions, ['claude-a']);
});

test('a claim change sends a plan event for the old and the new plan, clearing it for the old one', async t => {
  const root = storeCopy(t);
  const repo = gitRepo(t);
  fs.writeFileSync(path.join(root, 'demo-app', '.repo'), repo + '\n');
  pf.writePlan(path.join(root, 'demo-app', 'other'), pf.newPlan({ topic: 'other', title: 'Other', repo, created: pf.iso(new Date()) }));
  pf.writeClaim(root, 'claude-b', 'demo-app', 'search-v2');
  const seen = [];
  const w = createPlanStore({ root }).watch(ev => seen.push(ev.id));
  t.after(() => w.close());
  await sleep(100);
  pf.writeClaim(root, 'claude-b', 'demo-app', 'other');
  await waitFor(() => seen.includes('demo-app/search-v2') && seen.includes('demo-app/other'));
  assert.ok(seen.includes('demo-app/search-v2') && seen.includes('demo-app/other'));
  await sleep(400);
  seen.length = 0;
  pf.clearClaim(root, 'claude-b');
  await waitFor(() => seen.includes('demo-app/other'));
  assert.deepStrictEqual([...new Set(seen)], ['demo-app/other']);
});
