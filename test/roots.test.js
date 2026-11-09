const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const roots = require('../lib/roots');
const { assignSets } = require('../lib/discovery');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString();

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-roots-')));
  const repo = path.join(root, 'dev', 'org', 'app');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  const wt1 = path.join(root, 'dev', 'org', 'wt-one', 'app');
  const wt2 = path.join(root, 'dev', 'org', 'wt-two', 'app');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/one', wt1);
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/two', wt2);
  const projects = [{ id: 'org--app', name: 'app', path: repo, isGit: true, org: 'org' }, { id: 'org--plain', name: 'plain', path: path.join(root, 'dev', 'org', 'plain'), isGit: false, org: 'org' }];
  roots.init({ projects: () => projects });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, wt1, wt2, projects };
}

test('worktrees with the same basename get different ids that resolve to their own path', async t => {
  const { wt1, wt2, projects } = setup(t);
  const list = await roots.worktreesOf(projects[0]);
  assert.strictEqual(list.length, 2);
  const [a, b] = list;
  assert.notStrictEqual(a.id, b.id);
  for (const w of list) assert.match(w.id, roots.ID_RE);
  const ra = await roots.rootOf(a.id); const rb = await roots.rootOf(b.id);
  assert.deepStrictEqual([ra.path, rb.path].sort(), [wt1, wt2].sort());
  assert.strictEqual(ra.worktree, true);
  assert.strictEqual(ra.repoPath, projects[0].path);
  assert.strictEqual(ra.isGit, true);
});

test('plain ids return the project, forged or malformed ids return null', async t => {
  const { projects } = setup(t);
  assert.strictEqual(await roots.rootOf('org--app'), projects[0]);
  assert.strictEqual(await roots.rootOf('org--plain'), projects[1]);
  assert.strictEqual(await roots.rootOf('org--app~deadbeef'), null);
  assert.strictEqual(await roots.rootOf('org--plain~deadbeef'), null);
  assert.strictEqual(await roots.rootOf('nope'), null);
  for (const bad of ['../etc', 'org--app~../../x', 'org--app~DEADBEEF', 'a/b', '', null, 'org--app~1234567']) assert.strictEqual(await roots.rootOf(bad), null);
});

test('locate maps files to the main checkout or the worktree root', async t => {
  const { root, repo, wt1 } = setup(t);
  const m = roots.locate(path.join(repo, 'src', 'a.js'));
  assert.deepStrictEqual({ id: m.rootId, rel: m.rel, wt: m.worktree }, { id: 'org--app', rel: 'src/a.js', wt: false });
  const w = roots.locate(path.join(wt1, 'src', 'new', 'b.js'));
  assert.strictEqual(w.worktree, true);
  assert.strictEqual(w.project, 'org--app');
  assert.strictEqual(w.rel, 'src/new/b.js');
  assert.strictEqual(w.rootId, 'org--app~' + roots.hashOf(wt1));
  assert.ok(await roots.rootOf(w.rootId));
  assert.strictEqual(roots.locate(path.join(root, 'elsewhere', 'x.txt')), null);
  assert.strictEqual(roots.locate('relative/path.js'), null);
});

test('a removed worktree stops resolving after the cache expires', async t => {
  const { repo, wt2, projects } = setup(t);
  const id = 'org--app~' + roots.hashOf(wt2);
  assert.ok(await roots.rootOf(id));
  git(repo, 'worktree', 'remove', '--force', wt2);
  roots.init({ projects: () => projects });
  assert.strictEqual(await roots.rootOf(id), null);
});

test('sets: a container with two or more git repos groups them; sub-projects of a repo follow the repo', () => {
  const ps = [
    { id: 'h--tm', name: 'tm', isGit: false, parent: null, org: 'h', group: null },
    { id: 'h--tm--web', name: 'web', isGit: true, parent: 'h--tm', org: 'h', group: null },
    { id: 'h--tm--api', name: 'api', isGit: true, parent: 'h--tm', org: 'h', group: null },
    { id: 'h--tm--sdk', name: 'sdk', isGit: true, parent: 'h--tm', org: 'h', group: null },
    { id: 'p--gym--ios', name: 'ios', isGit: true, parent: null, org: 'p', group: 'gym' },
    { id: 'p--gym--web', name: 'web', isGit: true, parent: null, org: 'p', group: 'gym' },
    { id: 'p--solo--app', name: 'app', isGit: true, parent: null, org: 'p', group: 'solo' },
    { id: 'n--sp', name: 'sp', isGit: true, parent: null, org: 'n', group: null },
    { id: 'n--sp--infra', name: 'infra', isGit: false, parent: 'n--sp', org: 'n', group: null },
  ];
  assignSets(ps, '/x');
  const set = Object.fromEntries(ps.map(p => [p.id, p.set]));
  assert.strictEqual(set['h--tm--web'], 'h--tm');
  assert.strictEqual(set['h--tm--sdk'], 'h--tm');
  assert.strictEqual(set['h--tm'], 'h--tm');
  assert.strictEqual(set['p--gym--ios'], 'p--gym');
  assert.strictEqual(ps.find(p => p.id === 'p--gym--web').setName, 'gym');
  assert.strictEqual(set['p--solo--app'], 'p--solo--app');
  assert.strictEqual(set['n--sp'], 'n--sp');
  assert.strictEqual(set['n--sp--infra'], 'n--sp');
});

test('chatFolder: a folder inside devRoot or a project, given as an absolute path, keeps the path as given', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-chatfolder-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dev = path.join(base, 'dev'), repo = path.join(dev, 'org', 'repo'), wt = path.join(repo, '.claude', 'worktrees', 'a');
  const elsewhere = path.join(base, 'elsewhere'), dev2 = path.join(base, 'dev2'), link = path.join(base, 'devlink');
  for (const d of [wt, path.join(dev, '.pasted', 'repo'), elsewhere, dev2]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(dev, link);
  fs.symlinkSync(elsewhere, path.join(dev, 'out'));
  fs.writeFileSync(path.join(dev, 'file.txt'), 'x');
  const pick = d => roots.chatFolder(d, dev, [repo, path.join(base, 'gone')]);
  assert.equal(pick(dev), dev);
  assert.equal(pick(repo + '/'), repo);
  assert.equal(pick(wt), wt);
  assert.equal(pick(path.join(link, 'org', 'repo')), path.join(link, 'org', 'repo'));
  assert.equal(roots.chatFolder(elsewhere, dev, [elsewhere]), elsewhere);
  for (const bad of [elsewhere, dev2, path.join(dev, 'out'), path.join(dev, '.pasted'), path.join(dev, '.pasted', 'repo'), path.join(dev, 'file.txt'), path.join(dev, 'nope'), 'org/repo', '', null, 7, ['x']]) {
    assert.equal(pick(bad), null, String(bad));
  }
  assert.equal(roots.chatFolder(repo, null, []), null);
});
