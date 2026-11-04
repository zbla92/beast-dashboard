const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const roots = require('../lib/roots');
const gitinfo = require('../lib/gitinfo');
const gitops = require('../lib/gitops');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const read = f => fs.readFileSync(f, 'utf8');
const exists = f => { try { fs.lstatSync(f); return true; } catch { return false; } };
const staged = dir => git(dir, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).sort();
const status = dir => git(dir, 'status', '--porcelain');
const head = dir => git(dir, 'rev-parse', 'HEAD').trim();
const branchOf = dir => git(dir, 'branch', '--show-current').trim();
const hook = (dir, name, body) => { const f = path.join(dir, '.git', 'hooks', name); write(f, `#!/bin/sh\n${body}\n`); fs.chmodSync(f, 0o755); };

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-gitops-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function identify(dir) { git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'user.email', 't@t'); }

function setup(t, extra = []) {
  const base = tmp(t);
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(work, 'init', '-q', '-b', 'main');
  identify(work);
  git(work, 'remote', 'add', 'origin', origin);
  write(path.join(work, 'a.txt'), 'one\n');
  write(path.join(work, 'src/b.txt'), 'bee\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  const projects = [{ id: 'p', name: 'p', path: work, isGit: true }, ...extra.map(e => e(base))];
  roots.init({ projects: () => projects });
  const op = body => gitops.op('p', body);
  return { base, origin, work, op, f: rel => path.join(work, rel) };
}

function peer(env) {
  const dir = path.join(env.base, 'peer' + Math.random().toString(36).slice(2, 8));
  git(env.base, 'clone', '-q', env.origin, dir);
  identify(dir);
  return dir;
}

async function okBody(promise) {
  const r = await promise;
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(r.body.ok, true, JSON.stringify(r));
  return r.body;
}
async function refused(promise, re) {
  const r = await promise;
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(r.body.ok, false, JSON.stringify(r));
  assert.strictEqual(typeof r.body.error, 'string');
  if (re) assert.match(r.body.error, re);
  return r.body;
}
async function rejected(promise, code = 400) {
  const r = await promise;
  assert.strictEqual(r.status, code, JSON.stringify(r));
  assert.strictEqual(r.body.ok, false);
  assert.ok(r.body.error);
}

test('stage and unstage: named files and all', async t => {
  const e = setup(t);
  write(e.f('a.txt'), 'two\n');
  write(e.f('new.txt'), 'n\n');
  fs.rmSync(e.f('src/b.txt'));
  await okBody(e.op({ op: 'stage', files: ['a.txt'] }));
  assert.deepStrictEqual(staged(e.work), ['a.txt']);
  await okBody(e.op({ op: 'stage', files: ['src/b.txt'] }));
  assert.deepStrictEqual(staged(e.work), ['a.txt', 'src/b.txt']);
  await okBody(e.op({ op: 'unstage', files: ['a.txt'] }));
  assert.deepStrictEqual(staged(e.work), ['src/b.txt']);
  await okBody(e.op({ op: 'stage', all: true }));
  assert.deepStrictEqual(staged(e.work), ['a.txt', 'new.txt', 'src/b.txt']);
  await okBody(e.op({ op: 'unstage', all: true }));
  assert.deepStrictEqual(staged(e.work), []);
  assert.strictEqual(read(e.f('a.txt')), 'two\n');
  assert.ok(exists(e.f('new.txt')));
});

test('stage and unstage: bad selectors are refused', async t => {
  const e = setup(t);
  write(e.f('a.txt'), 'two\n');
  await rejected(e.op({ op: 'stage' }));
  await rejected(e.op({ op: 'stage', files: [] }));
  await rejected(e.op({ op: 'stage', files: 'a.txt' }));
  await rejected(e.op({ op: 'stage', all: 'yes' }));
  await rejected(e.op({ op: 'stage', all: true, files: ['a.txt'] }));
  await rejected(e.op({ op: 'unstage', all: 1 }));
  assert.deepStrictEqual(staged(e.work), []);
  await refused(e.op({ op: 'stage', files: ['missing.txt'] }), /did not match/);
});

test('an ignored file can not be staged', async t => {
  const e = setup(t);
  write(e.f('.gitignore'), 'secret.env\n');
  write(e.f('secret.env'), 'x\n');
  await refused(e.op({ op: 'stage', files: ['secret.env'] }), /ignored/);
  assert.deepStrictEqual(staged(e.work), []);
});

test('a repo with no commits: stage, unstage, read, first commit, push', async t => {
  const base = tmp(t);
  const work = path.join(base, 'empty');
  const origin = path.join(base, 'o.git');
  fs.mkdirSync(work);
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(work, 'init', '-q', '-b', 'main');
  identify(work);
  git(work, 'remote', 'add', 'origin', origin);
  const projects = [{ id: 'e', name: 'e', path: work, isGit: true }];
  roots.init({ projects: () => projects });
  const op = body => gitops.op('e', body);
  write(path.join(work, 'f.txt'), 'x\n');
  write(path.join(work, 'g.txt'), 'y\n');
  await okBody(op({ op: 'stage', all: true }));
  assert.deepStrictEqual(staged(work), ['f.txt', 'g.txt']);
  await okBody(op({ op: 'unstage', files: ['f.txt'] }));
  assert.deepStrictEqual(staged(work), ['g.txt']);
  await okBody(op({ op: 'unstage', all: true }));
  assert.deepStrictEqual(staged(work), []);
  assert.ok(exists(path.join(work, 'f.txt')));
  await refused(op({ op: 'commit', message: 'first' }), /Nothing is staged/);
  await refused(op({ op: 'commit', message: 'first', amend: true }), /nothing to amend/i);
  assert.deepStrictEqual(await gitops.log(work, {}), { commits: [], more: false });
  const br = await gitops.branches(work);
  assert.strictEqual(br.current, 'main');
  assert.deepStrictEqual(br.branches, []);
  await okBody(op({ op: 'stage', all: true }));
  const c = await okBody(op({ op: 'commit', message: 'first' }));
  assert.ok(c.hash);
  assert.strictEqual(git(work, 'log', '--format=%s').trim(), 'first');
  await okBody(op({ op: 'push' }));
  assert.strictEqual(git(origin, 'rev-parse', 'main').trim(), head(work));
});

test('a branch can be created on a repo with no commits', async t => {
  const base = tmp(t);
  git(base, 'init', '-q', '-b', 'main');
  roots.init({ projects: () => [{ id: 'e', name: 'e', path: base, isGit: true }] });
  await okBody(gitops.op('e', { op: 'branch', name: 'first' }));
  assert.strictEqual(branchOf(base), 'first');
});

test('discard: unstaged changes go, staged content stays', async t => {
  const e = setup(t);
  write(e.f('a.txt'), 'staged\n');
  await okBody(e.op({ op: 'stage', files: ['a.txt'] }));
  write(e.f('a.txt'), 'staged and more\n');
  write(e.f('src/b.txt'), 'other edit\n');
  await okBody(e.op({ op: 'discard', files: ['a.txt'] }));
  assert.strictEqual(read(e.f('a.txt')), 'staged\n');
  assert.deepStrictEqual(staged(e.work), ['a.txt']);
  assert.strictEqual(read(e.f('src/b.txt')), 'other edit\n');
  fs.rmSync(e.f('src/b.txt'));
  await okBody(e.op({ op: 'discard', files: ['src/b.txt'] }));
  assert.strictEqual(read(e.f('src/b.txt')), 'bee\n');
});

test('discard: a new file that is staged keeps its staged content', async t => {
  const e = setup(t);
  write(e.f('n.txt'), 'v1\n');
  await okBody(e.op({ op: 'stage', files: ['n.txt'] }));
  write(e.f('n.txt'), 'v2\n');
  await okBody(e.op({ op: 'discard', files: ['n.txt'] }));
  assert.strictEqual(read(e.f('n.txt')), 'v1\n');
  assert.deepStrictEqual(staged(e.work), ['n.txt']);
});

test('discard: an untracked file needs the flag, exactly true', async t => {
  const e = setup(t);
  write(e.f('u.txt'), 'keep me\n');
  write(e.f('a.txt'), 'edit\n');
  await refused(e.op({ op: 'discard', files: ['u.txt'] }), /untracked/);
  assert.ok(exists(e.f('u.txt')));
  await refused(e.op({ op: 'discard', files: ['a.txt', 'u.txt'] }), /untracked/);
  assert.strictEqual(read(e.f('a.txt')), 'edit\n');
  await rejected(e.op({ op: 'discard', files: ['u.txt'], untracked: 'true' }));
  assert.ok(exists(e.f('u.txt')));
  const r = await okBody(e.op({ op: 'discard', files: ['u.txt'], untracked: true }));
  assert.strictEqual(r.deleted, 1);
  assert.ok(!exists(e.f('u.txt')));
  assert.strictEqual(read(e.f('a.txt')), 'edit\n');
});

test('discard: an ignored file is never treated as untracked', async t => {
  const e = setup(t);
  write(e.f('.gitignore'), '*.env\nkeep/\n');
  write(e.f('x.env'), 'secret\n');
  await refused(e.op({ op: 'discard', files: ['x.env'], untracked: true }), /nothing to discard/);
  assert.ok(exists(e.f('x.env')));
});

test('discard: an untracked folder loses its untracked files, ignored files inside stay', async t => {
  const e = setup(t);
  write(e.f('.gitignore'), '*.env\n');
  write(e.f('pkg/one.txt'), '1\n');
  write(e.f('pkg/deep/two.txt'), '2\n');
  write(e.f('pkg2/deep/three.txt'), '3\n');
  write(e.f('pkg2/deep/x.env'), 'secret\n');
  await okBody(e.op({ op: 'discard', files: ['pkg/'], untracked: true }));
  assert.ok(!exists(e.f('pkg')));
  await okBody(e.op({ op: 'discard', files: ['pkg2'], untracked: true }));
  assert.ok(!exists(e.f('pkg2/deep/three.txt')));
  assert.strictEqual(read(e.f('pkg2/deep/x.env')), 'secret\n');
});

test('discard: a folder holding a nested repo is refused and left whole', async t => {
  const e = setup(t);
  const nested = e.f('vendor/inner');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, 'init', '-q', '-b', 'main');
  write(path.join(nested, 'work.txt'), 'nested work\n');
  write(e.f('vendor/loose.txt'), 'l\n');
  await refused(e.op({ op: 'discard', files: ['vendor'], untracked: true }), /nested repository/);
  await refused(e.op({ op: 'discard', files: ['vendor/inner'], untracked: true }), /nested repository/);
  assert.strictEqual(read(path.join(nested, 'work.txt')), 'nested work\n');
  assert.ok(exists(e.f('vendor/loose.txt')));
  fs.mkdirSync(e.f('broken/.git'), { recursive: true });
  write(e.f('broken/file.txt'), 'b\n');
  await refused(e.op({ op: 'discard', files: ['broken'], untracked: true }), /nested repository/);
  assert.ok(exists(e.f('broken/file.txt')));
});

test('discard: a folder with tracked files is refused, nothing widens to the whole tree', async t => {
  const e = setup(t);
  write(e.f('src/b.txt'), 'edit\n');
  write(e.f('src/new.txt'), 'n\n');
  await refused(e.op({ op: 'discard', files: ['src'] }), /folder/);
  await refused(e.op({ op: 'discard', files: ['src'], untracked: true }), /folder/);
  await rejected(e.op({ op: 'discard', files: ['.'] }));
  await rejected(e.op({ op: 'discard', files: ['./'] }));
  assert.strictEqual(read(e.f('src/b.txt')), 'edit\n');
  assert.ok(exists(e.f('src/new.txt')));
});

test('discard: a tracked file replaced by a folder or a file in place of its folder is refused', async t => {
  const e = setup(t);
  fs.rmSync(e.f('a.txt'));
  write(e.f('a.txt/mine.txt'), 'mine\n');
  await refused(e.op({ op: 'discard', files: ['a.txt'] }), /folder/);
  assert.strictEqual(read(e.f('a.txt/mine.txt')), 'mine\n');
  fs.rmSync(e.f('src'), { recursive: true });
  write(e.f('src'), 'now a file\n');
  await refused(e.op({ op: 'discard', files: ['src/b.txt'] }), /replaced by a file/);
  assert.strictEqual(read(e.f('src')), 'now a file\n');
});

test('symlinks: nothing follows a link out of the root', async t => {
  const e = setup(t);
  const outside = path.join(e.base, 'outside');
  write(path.join(outside, 'secret.txt'), 'outside\n');
  fs.symlinkSync(outside, e.f('dirlink'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), e.f('filelink'));
  for (const body of [
    { op: 'discard', files: ['dirlink/secret.txt'], untracked: true },
    { op: 'stage', files: ['dirlink/secret.txt'] },
    { op: 'unstage', files: ['dirlink/secret.txt'] },
  ]) await rejected(e.op(body));
  assert.strictEqual(read(path.join(outside, 'secret.txt')), 'outside\n');
  await okBody(e.op({ op: 'discard', files: ['filelink', 'dirlink/'], untracked: true }));
  assert.ok(!exists(e.f('filelink')));
  assert.ok(!exists(e.f('dirlink')));
  assert.strictEqual(read(path.join(outside, 'secret.txt')), 'outside\n');
});

test('symlinks: a tracked file swapped for a link is restored without writing through it', async t => {
  const e = setup(t);
  const outside = path.join(e.base, 'target.txt');
  write(outside, 'outside\n');
  fs.rmSync(e.f('a.txt'));
  fs.symlinkSync(outside, e.f('a.txt'));
  await okBody(e.op({ op: 'discard', files: ['a.txt'] }));
  assert.ok(!fs.lstatSync(e.f('a.txt')).isSymbolicLink());
  assert.strictEqual(read(e.f('a.txt')), 'one\n');
  assert.strictEqual(read(outside), 'outside\n');
});

test('symlinks: a tracked folder swapped for a link refuses the files behind it', async t => {
  const e = setup(t);
  const outside = path.join(e.base, 'outdir');
  write(path.join(outside, 'b.txt'), 'outside\n');
  fs.rmSync(e.f('src'), { recursive: true });
  fs.symlinkSync(outside, e.f('src'));
  await rejected(e.op({ op: 'discard', files: ['src/b.txt'] }));
  assert.strictEqual(read(path.join(outside, 'b.txt')), 'outside\n');
});

test('commit: refuses empty messages and nothing staged, commits what is staged only', async t => {
  const e = setup(t);
  write(e.f('a.txt'), 'two\n');
  write(e.f('src/b.txt'), 'left out\n');
  const before = head(e.work);
  await refused(e.op({ op: 'commit', message: 'x' }), /Nothing is staged/);
  await okBody(e.op({ op: 'stage', files: ['a.txt'] }));
  for (const message of ['', '   \n ', undefined, 5, null]) await rejected(e.op({ op: 'commit', message }));
  await rejected(e.op({ op: 'commit', message: 'x'.repeat(64 * 1024 + 1) }));
  await rejected(e.op({ op: 'commit', message: 'a\0b' }));
  await rejected(e.op({ op: 'commit', message: 'x', amend: 'yes' }));
  assert.strictEqual(head(e.work), before);
  const c = await okBody(e.op({ op: 'commit', message: 'second' }));
  assert.strictEqual(git(e.work, 'rev-parse', '--short', 'HEAD').trim(), c.hash);
  assert.strictEqual(git(e.work, 'show', '--format=', '--name-only', 'HEAD').trim(), 'a.txt');
  assert.strictEqual(read(e.f('src/b.txt')), 'left out\n');
});

test('commit: the message is data, never a flag or a shell string', async t => {
  const e = setup(t);
  const canary = e.f('canary');
  for (const message of ['--amend', `$(touch ${canary})`, `; touch ${canary}`, '-m', '#not a comment']) {
    write(e.f('a.txt'), message + '\n');
    await okBody(e.op({ op: 'stage', files: ['a.txt'] }));
    await okBody(e.op({ op: 'commit', message }));
    assert.strictEqual(git(e.work, 'log', '-1', '--format=%B').trim(), message);
  }
  assert.ok(!exists(canary));
  assert.strictEqual(git(e.work, 'rev-list', '--count', 'HEAD').trim(), '6');
});

test('commit: a failing hook returns its output and commits nothing', async t => {
  const e = setup(t);
  hook(e.work, 'pre-commit', 'echo "lint says no on stdout"\necho "lint says no on stderr" >&2\nexit 1');
  write(e.f('a.txt'), 'two\n');
  await okBody(e.op({ op: 'stage', all: true }));
  const before = head(e.work);
  const r = await refused(e.op({ op: 'commit', message: 'x' }));
  assert.match(r.error, /lint says no on stdout/);
  assert.match(r.error, /lint says no on stderr/);
  assert.strictEqual(head(e.work), before);
  assert.deepStrictEqual(staged(e.work), ['a.txt']);
});

test('commit: amend rewrites an unpushed commit and refuses a pushed one', async t => {
  const e = setup(t);
  await refused(e.op({ op: 'commit', message: 'rewrite', amend: true }), /already pushed/);
  assert.strictEqual(git(e.work, 'log', '-1', '--format=%s').trim(), 'init');
  write(e.f('a.txt'), 'two\n');
  await okBody(e.op({ op: 'stage', all: true }));
  await okBody(e.op({ op: 'commit', message: 'typo' }));
  await okBody(e.op({ op: 'commit', message: 'fixed', amend: true }));
  assert.strictEqual(git(e.work, 'log', '-1', '--format=%s').trim(), 'fixed');
  assert.strictEqual(git(e.work, 'rev-list', '--count', 'HEAD').trim(), '2');
  await rejected(e.op({ op: 'commit', message: ' ', amend: true }));
});

test('push: sets the upstream the first time, then plain, and never forces', async t => {
  const e = setup(t);
  git(e.work, 'switch', '-q', '-c', 'feature');
  write(e.f('a.txt'), 'two\n');
  git(e.work, 'commit', '-qam', 'feature work');
  await okBody(e.op({ op: 'push', force: true, refspec: '+main:main' }));
  assert.strictEqual(git(e.work, 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/feature');
  assert.strictEqual(git(e.origin, 'rev-parse', 'feature').trim(), head(e.work));
  write(e.f('a.txt'), 'three\n');
  git(e.work, 'commit', '-qam', 'more');
  await okBody(e.op({ op: 'push' }));
  assert.strictEqual(git(e.origin, 'rev-parse', 'feature').trim(), head(e.work));
  git(e.work, 'switch', '-q', 'main');
  const other = peer(e);
  write(path.join(other, 'p.txt'), 'p\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'peer');
  git(other, 'push', '-q');
  const remote = git(e.origin, 'rev-parse', 'main').trim();
  write(e.f('a.txt'), 'local\n');
  git(e.work, 'commit', '-qam', 'local');
  await refused(e.op({ op: 'push' }), /rejected|fetch first|non-fast-forward/);
  assert.strictEqual(git(e.origin, 'rev-parse', 'main').trim(), remote);
});

test('push: detached HEAD is refused', async t => {
  const e = setup(t);
  git(e.work, 'switch', '-q', '--detach');
  await refused(e.op({ op: 'push' }), /detached/);
});

test('push: runs with terminal prompts off, and times out without blocking the queue', async t => {
  const e = setup(t);
  const seen = e.f('.git/prompt-seen');
  hook(e.work, 'pre-push', `echo "$GIT_TERMINAL_PROMPT" > "${seen}"`);
  write(e.f('a.txt'), 'two\n');
  git(e.work, 'commit', '-qam', 'two');
  await okBody(e.op({ op: 'push' }));
  assert.strictEqual(read(seen).trim(), '0');
  hook(e.work, 'pre-push', 'sleep 5');
  write(e.f('a.txt'), 'three\n');
  git(e.work, 'commit', '-qam', 'three');
  gitops.init({ netMs: 300 });
  t.after(() => gitops.init({ netMs: 300000 }));
  const remote = git(e.origin, 'rev-parse', 'main').trim();
  const started = Date.now();
  const [slow, next] = await Promise.all([e.op({ op: 'push' }), e.op({ op: 'stage', all: true })]);
  assert.match(slow.body.error, /timed out/);
  assert.ok(Date.now() - started < 4000);
  assert.strictEqual(next.body.ok, true);
  assert.strictEqual(git(e.origin, 'rev-parse', 'main').trim(), remote);
});

test('pull: fast-forward works, a diverged branch is refused and left untouched', async t => {
  const e = setup(t);
  const other = peer(e);
  write(path.join(other, 'p.txt'), 'p\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'peer one');
  git(other, 'push', '-q');
  await okBody(e.op({ op: 'pull' }));
  assert.ok(exists(e.f('p.txt')));
  write(path.join(other, 'p.txt'), 'pp\n');
  git(other, 'commit', '-qam', 'peer two');
  git(other, 'push', '-q');
  write(e.f('a.txt'), 'local\n');
  git(e.work, 'commit', '-qam', 'local');
  const before = head(e.work);
  await refused(e.op({ op: 'pull' }), /fast-forward|diverg/i);
  assert.strictEqual(head(e.work), before);
  git(e.work, 'config', 'pull.rebase', 'true');
  await refused(e.op({ op: 'pull' }), /fast-forward|diverg/i);
  assert.strictEqual(head(e.work), before);
  assert.strictEqual(git(e.work, 'log', '-1', '--format=%s').trim(), 'local');
  assert.ok(!exists(e.f('.git/rebase-merge')));
  assert.ok(!exists(e.f('.git/MERGE_HEAD')));
});

test('pull: uncommitted work in the way stops it, and stays', async t => {
  const e = setup(t);
  const other = peer(e);
  write(path.join(other, 'a.txt'), 'peer\n');
  git(other, 'commit', '-qam', 'peer');
  git(other, 'push', '-q');
  write(e.f('a.txt'), 'uncommitted\n');
  await refused(e.op({ op: 'pull' }));
  assert.strictEqual(read(e.f('a.txt')), 'uncommitted\n');
});

test('checkout: switches, tracks a remote branch, never creates on a typo', async t => {
  const e = setup(t);
  git(e.work, 'branch', 'feature');
  await okBody(e.op({ op: 'checkout', branch: 'feature' }));
  assert.strictEqual(branchOf(e.work), 'feature');
  await okBody(e.op({ op: 'checkout', branch: 'feature' }));
  const other = peer(e);
  git(other, 'switch', '-q', '-c', 'from-peer');
  git(other, 'push', '-q', '-u', 'origin', 'from-peer');
  git(e.work, 'fetch', '-q');
  const r = await okBody(e.op({ op: 'checkout', branch: 'origin/from-peer' }));
  assert.strictEqual(r.branch, 'from-peer');
  assert.strictEqual(branchOf(e.work), 'from-peer');
  assert.strictEqual(git(e.work, 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/from-peer');
  await okBody(e.op({ op: 'checkout', branch: 'main' }));
  await okBody(e.op({ op: 'checkout', branch: 'origin/from-peer' }));
  assert.strictEqual(branchOf(e.work), 'from-peer');
  await refused(e.op({ op: 'checkout', branch: 'no-such-branch' }), /No branch/);
  assert.strictEqual(branchOf(e.work), 'from-peer');
  assert.ok(!git(e.work, 'branch', '--list', 'no-such-branch').trim());
});

test('checkout: a branch held by another worktree is refused with its path', async t => {
  const e = setup(t);
  const wt = path.join(e.base, 'wt');
  git(e.work, 'worktree', 'add', '-q', '-b', 'taken', wt);
  await refused(e.op({ op: 'checkout', branch: 'taken' }), new RegExp('another worktree.*' + wt));
  assert.strictEqual(branchOf(e.work), 'main');
});

test('checkout: uncommitted work that would be overwritten stops the switch', async t => {
  const e = setup(t);
  git(e.work, 'switch', '-q', '-c', 'other');
  write(e.f('a.txt'), 'other side\n');
  git(e.work, 'commit', '-qam', 'other');
  git(e.work, 'switch', '-q', 'main');
  write(e.f('a.txt'), 'uncommitted\n');
  await refused(e.op({ op: 'checkout', branch: 'other' }));
  assert.strictEqual(branchOf(e.work), 'main');
  assert.strictEqual(read(e.f('a.txt')), 'uncommitted\n');
});

test('branch names: flags and ref tricks are refused', async t => {
  const e = setup(t);
  git(e.work, 'switch', '-q', '-c', 'prev');
  git(e.work, 'switch', '-q', 'main');
  const canary = e.f('canary');
  for (const name of ['-x', '--force', '-D', '', 'a..b', 'a b', '@{-1}', 'HEAD', 'x.lock', `$(touch ${canary})`, 'a\nb', 'a\0b', 5, null, undefined, 'x'.repeat(300)]) {
    await rejected(e.op({ op: 'branch', name }));
    await rejected(e.op({ op: 'checkout', branch: name }));
  }
  assert.strictEqual(branchOf(e.work), 'main');
  assert.ok(!exists(canary));
  assert.strictEqual(git(e.work, 'branch', '--format=%(refname:short)').trim().split('\n').sort().join(), 'main,prev');
});

test('branch: creates and switches, from a start point without tracking it', async t => {
  const e = setup(t);
  write(e.f('a.txt'), 'two\n');
  git(e.work, 'commit', '-qam', 'two');
  const tip = head(e.work);
  const first = git(e.work, 'rev-parse', 'origin/main').trim();
  await okBody(e.op({ op: 'branch', name: 'one' }));
  assert.strictEqual(branchOf(e.work), 'one');
  assert.strictEqual(head(e.work), tip);
  await okBody(e.op({ op: 'branch', name: 'two', from: 'origin/main' }));
  assert.strictEqual(branchOf(e.work), 'two');
  assert.strictEqual(head(e.work), first);
  assert.throws(() => git(e.work, 'rev-parse', '--abbrev-ref', '@{u}'));
  await okBody(e.op({ op: 'branch', name: 'three', from: tip.slice(0, 8) }));
  assert.strictEqual(head(e.work), tip);
  await okBody(e.op({ op: 'branch', name: 'four', from: 'main' }));
  assert.strictEqual(head(e.work), tip);
  await refused(e.op({ op: 'branch', name: 'one' }), /already exists/);
  await refused(e.op({ op: 'branch', name: 'five', from: 'nope' }), /No branch, tag or commit/);
  for (const from of ['main~1', '-x', ':/two', 5, 'HEAD']) await rejected(e.op({ op: 'branch', name: 'six', from }));
  assert.strictEqual(branchOf(e.work), 'four');
});

test('a rename: commit, unstaging one side brings back both, discard keeps the staged rename', async t => {
  const e = setup(t);
  git(e.work, 'mv', 'a.txt', 'renamed.txt');
  await okBody(e.op({ op: 'unstage', files: ['renamed.txt'] }));
  assert.deepStrictEqual(staged(e.work), []);
  assert.ok(exists(e.f('renamed.txt')));
  await okBody(e.op({ op: 'stage', files: ['a.txt', 'renamed.txt'] }));
  assert.match(status(e.work), /^R {2}a\.txt -> renamed\.txt/m);
  write(e.f('renamed.txt'), 'edited after rename\n');
  await okBody(e.op({ op: 'discard', files: ['renamed.txt'] }));
  assert.strictEqual(read(e.f('renamed.txt')), 'one\n');
  assert.match(status(e.work), /^R {2}a\.txt -> renamed\.txt/m);
  await okBody(e.op({ op: 'commit', message: 'rename' }));
  assert.match(git(e.work, 'show', '--format=', '--name-status', '-M', 'HEAD'), /^R100\ta\.txt\trenamed\.txt/m);
});

test('names with spaces and glob characters only touch that one file', async t => {
  const e = setup(t);
  const weird = ['my file.txt', '*.txt', '[a].txt', '?.txt', ':(glob)**', ':/x', 'back\\slash', '-dash.txt', 'new\nline.txt'];
  for (const w of weird) write(e.f(w), 'v1\n');
  write(e.f('z.txt'), 'plain\n');
  git(e.work, 'add', '-A');
  git(e.work, 'commit', '-qm', 'weird names');
  for (const w of weird) {
    write(e.f(w), 'v2\n');
    write(e.f('a.txt'), 'edit\n');
    write(e.f('z.txt'), 'edit\n');
    await okBody(e.op({ op: 'stage', files: [w] }));
    assert.deepStrictEqual(staged(e.work), [w]);
    await okBody(e.op({ op: 'unstage', files: [w] }));
    assert.deepStrictEqual(staged(e.work), []);
    await okBody(e.op({ op: 'discard', files: [w] }));
    assert.strictEqual(read(e.f(w)), 'v1\n');
    assert.strictEqual(read(e.f('a.txt')), 'edit\n');
    assert.strictEqual(read(e.f('z.txt')), 'edit\n');
  }
  write(e.f('*.new'), 'n\n');
  write(e.f('other.new'), 'n\n');
  await okBody(e.op({ op: 'discard', files: ['*.new'], untracked: true }));
  assert.ok(!exists(e.f('*.new')));
  assert.ok(exists(e.f('other.new')));
  await refused(e.op({ op: 'stage', files: ['*.txtx'] }), /did not match/);
  await refused(e.op({ op: 'stage', files: ['*.new'] }), /did not match/);
  assert.deepStrictEqual(staged(e.work), []);
});

test('traversal and malformed paths are refused for every path-taking op', async t => {
  const e = setup(t);
  write(e.f('a.txt'), 'edit\n');
  const victim = path.join(e.base, 'victim.txt');
  write(victim, 'keep\n');
  const badPaths = ['../victim.txt', 'src/../../victim.txt', victim, '/etc/passwd', '', '.', './', './a.txt', 'a//b', 'src/.', 'src/..', '..', '.git/config', '.GIT/config', 'src/.git/x', '.git', 'a\0b', 5, null, {}, [], 'x'.repeat(5000)];
  for (const f of badPaths) {
    for (const body of [{ op: 'stage', files: [f] }, { op: 'unstage', files: [f] }, { op: 'discard', files: [f], untracked: true }]) await rejected(e.op(body));
    await rejected(e.op({ op: 'discard', files: ['a.txt', f] }));
  }
  assert.strictEqual(read(victim), 'keep\n');
  assert.strictEqual(read(e.f('a.txt')), 'edit\n');
  assert.deepStrictEqual(staged(e.work), []);
  await rejected(e.op({ op: 'stage', files: Array.from({ length: 1001 }, (_, i) => `f${i}`) }));
  assert.deepStrictEqual(staged(e.work), []);
});

test('a file name with dots that is not a traversal is fine', async t => {
  const e = setup(t);
  write(e.f('a..b.txt'), 'x\n');
  await okBody(e.op({ op: 'stage', files: ['a..b.txt'] }));
  assert.deepStrictEqual(staged(e.work), ['a..b.txt']);
});

test('roots: only known ids resolve, anything else is a 404', async t => {
  const notGit = o => { const d = path.join(o, 'plain'); fs.mkdirSync(d); return { id: 'plain', name: 'plain', path: d, isGit: false }; };
  const e = setup(t, [notGit]);
  for (const id of ['nope', '..', '../p', 'p/..', 'p~deadbeef', 'plain', '', null, undefined, 5, e.work]) {
    await rejected(gitops.op(id, { op: 'stage', all: true }), 404);
    assert.strictEqual(await gitops.rootDir(id), null);
  }
  const elsewhere = path.join(e.base, 'elsewhere');
  git(e.base, 'init', '-q', '-b', 'main', elsewhere);
  write(path.join(elsewhere, 'x.txt'), 'x\n');
  write(e.f('a.txt'), 'edit\n');
  await okBody(gitops.op('p', { op: 'stage', all: true, path: elsewhere, dir: elsewhere, cwd: elsewhere, root: elsewhere }));
  assert.deepStrictEqual(staged(e.work), ['a.txt']);
  assert.deepStrictEqual(staged(elsewhere), []);
});

test('ops: unknown op names and bodies are bad requests', async t => {
  const e = setup(t);
  for (const op of ['nope', 'constructor', '__proto__', 'toString', '', 5, null, undefined, ['stage']]) await rejected(gitops.op('p', { op }));
  for (const body of [null, [], 'stage', 5]) await rejected(gitops.op('p', body));
  assert.strictEqual(status(e.work), '');
});

test('a project whose .git is broken never falls through to a parent repo', async t => {
  const e = setup(t);
  const inner = e.f('sub');
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
  write(path.join(inner, 'x.txt'), 'x\n');
  write(e.f('a.txt'), 'edit\n');
  roots.init({ projects: () => [{ id: 'sub', name: 'sub', path: inner, isGit: true }] });
  await refused(gitops.op('sub', { op: 'stage', all: true }));
  await refused(gitops.op('sub', { op: 'commit', message: 'x' }));
  assert.deepStrictEqual(staged(e.work), []);
  assert.deepStrictEqual(await gitops.log(inner, {}), { commits: [], more: false });
});

test('a worktree root works on its own checkout only', async t => {
  const e = setup(t);
  const wt = path.join(e.base, 'wt');
  git(e.work, 'worktree', 'add', '-q', '-b', 'feat', wt);
  const id = 'p~' + roots.hashOf(wt);
  write(path.join(wt, 'w.txt'), 'w\n');
  write(e.f('a.txt'), 'main edit\n');
  await okBody(gitops.op(id, { op: 'stage', all: true }));
  assert.deepStrictEqual(staged(wt), ['w.txt']);
  assert.deepStrictEqual(staged(e.work), []);
  await okBody(gitops.op(id, { op: 'commit', message: 'in worktree' }));
  assert.strictEqual(git(wt, 'log', '-1', '--format=%s').trim(), 'in worktree');
  assert.strictEqual(git(e.work, 'log', '-1', '--format=%s').trim(), 'init');
  await refused(gitops.op(id, { op: 'checkout', branch: 'main' }), new RegExp('another worktree.*' + e.work));
  assert.strictEqual(branchOf(wt), 'feat');
  await okBody(gitops.op(id, { op: 'branch', name: 'feat2' }));
  assert.strictEqual(branchOf(wt), 'feat2');
});

test('double click: parallel ops queue up on the index, the second commit finds nothing', async t => {
  const e = setup(t);
  for (const i of [1, 2, 3, 4, 5, 6]) write(e.f(`r${i}.txt`), 'x\n');
  const stages = await Promise.all([1, 2, 3, 4, 5, 6].map(i => e.op({ op: 'stage', files: [`r${i}.txt`] })));
  for (const r of stages) assert.strictEqual(r.body.ok, true, JSON.stringify(r));
  assert.strictEqual(staged(e.work).length, 6);
  const before = +git(e.work, 'rev-list', '--count', 'HEAD').trim();
  const [one, two] = await Promise.all([e.op({ op: 'commit', message: 'once' }), e.op({ op: 'commit', message: 'once' })]);
  assert.strictEqual(one.body.ok, true);
  assert.strictEqual(two.body.ok, false);
  assert.match(two.body.error, /Nothing is staged/);
  assert.ok(!/index\.lock/.test(JSON.stringify([one, two])));
  assert.strictEqual(+git(e.work, 'rev-list', '--count', 'HEAD').trim(), before + 1);
  assert.ok(!exists(e.f('.git/index.lock')));
});

test('a queued op still runs after a failing one', async t => {
  const e = setup(t);
  write(e.f('a.txt'), 'edit\n');
  const [one, two, three] = await Promise.all([
    e.op({ op: 'stage', files: ['nope.txt'] }),
    e.op({ op: 'stage', files: ['../x'] }),
    e.op({ op: 'stage', files: ['a.txt'] }),
  ]);
  assert.strictEqual(one.body.ok, false);
  assert.strictEqual(two.status, 400);
  assert.strictEqual(three.body.ok, true);
});

test('reads do not wait for a running op', async t => {
  const e = setup(t);
  const marker = e.f('.git/hook-started');
  hook(e.work, 'pre-commit', `touch "${marker}"\nsleep 2`);
  write(e.f('a.txt'), 'edit\n');
  await okBody(e.op({ op: 'stage', all: true }));
  const committing = e.op({ op: 'commit', message: 'slow' });
  while (!exists(marker)) await new Promise(r => setTimeout(r, 20));
  const started = Date.now();
  const [log, br] = await Promise.all([gitops.log(e.work, {}), gitops.branches(e.work)]);
  assert.ok(Date.now() - started < 1500);
  assert.strictEqual(log.commits[0].subject, 'init');
  assert.strictEqual(br.current, 'main');
  assert.strictEqual((await committing).body.ok, true);
});

test('branches: local first, with upstream, ahead and behind, worktree and default', async t => {
  const e = setup(t);
  const wt = path.join(e.base, 'wt');
  git(e.work, 'branch', 'plain');
  git(e.work, 'worktree', 'add', '-q', '-b', 'held', wt);
  const other = peer(e);
  git(other, 'switch', '-q', '-c', 'remote-only');
  git(other, 'push', '-q', '-u', 'origin', 'remote-only');
  git(other, 'switch', '-q', 'main');
  write(path.join(other, 'p.txt'), 'p\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'peer');
  git(other, 'push', '-q');
  git(e.work, 'fetch', '-q');
  write(e.f('a.txt'), 'local\n');
  git(e.work, 'commit', '-qam', 'local');
  const d = await gitops.branches(e.work);
  assert.strictEqual(d.current, 'main');
  assert.strictEqual(d.default, 'main');
  assert.strictEqual(d.truncated, false);
  const by = Object.fromEntries(d.branches.map(b => [b.name, b]));
  assert.deepStrictEqual(by.main, { name: 'main', remote: false, current: true, worktree: e.work, upstream: 'origin/main', ahead: 1, behind: 1, at: by.main.at });
  assert.ok(by.main.at > 1e12);
  assert.strictEqual(by.plain.worktree, null);
  assert.strictEqual(by.plain.upstream, null);
  assert.strictEqual(by.held.worktree, wt);
  assert.strictEqual(by.held.current, false);
  assert.deepStrictEqual(by['origin/remote-only'], { name: 'origin/remote-only', remote: true, current: false, worktree: null, upstream: null, ahead: 0, behind: 0, at: by['origin/remote-only'].at });
  assert.ok(!by['origin/main'] && !by['origin/HEAD']);
  const flags = d.branches.map(b => b.remote);
  assert.deepStrictEqual(flags, [...flags].sort());
  git(e.work, 'switch', '-q', '--detach');
  assert.strictEqual((await gitops.branches(e.work)).current, null);
});

test('log: paging, limit cap, unpushed flag, parents of a merge', async t => {
  const e = setup(t);
  git(e.work, 'switch', '-q', '-c', 'side');
  write(e.f('s.txt'), 's\n');
  git(e.work, 'add', '-A');
  git(e.work, 'commit', '-qm', 'side work');
  git(e.work, 'switch', '-q', 'main');
  write(e.f('a.txt'), 'two\n');
  git(e.work, 'commit', '-qam', 'main work');
  git(e.work, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const all = await gitops.log(e.work, {});
  assert.strictEqual(all.more, false);
  assert.strictEqual(all.commits.length, 4);
  const top = all.commits[0];
  assert.strictEqual(top.subject, 'merge side');
  assert.strictEqual(top.parents.length, 2);
  assert.strictEqual(top.hash, head(e.work));
  assert.strictEqual(top.author, 't');
  assert.ok(top.at > 1e12);
  const bySubject = Object.fromEntries(all.commits.map(c => [c.subject, c]));
  assert.strictEqual(bySubject.init.unpushed, false);
  assert.deepStrictEqual(bySubject.init.parents, []);
  assert.strictEqual(bySubject['side work'].unpushed, true);
  assert.strictEqual(bySubject['main work'].unpushed, true);
  const page = await gitops.log(e.work, { skip: '1', limit: '2' });
  assert.strictEqual(page.commits.length, 2);
  assert.strictEqual(page.more, true);
  assert.strictEqual(page.commits[0].hash, all.commits[1].hash);
  const last = await gitops.log(e.work, { skip: '3', limit: '2' });
  assert.strictEqual(last.commits.length, 1);
  assert.strictEqual(last.more, false);
  assert.strictEqual(last.commits[0].unpushed, false);
  assert.strictEqual((await gitops.log(e.work, { skip: 'x; rm', limit: '-5' })).commits.length, 4);
  for (const i of Array.from({ length: 210 }, (_, n) => n)) git(e.work, 'commit', '-q', '--allow-empty', '-m', `c${i}`);
  const capped = await gitops.log(e.work, { limit: '100000' });
  assert.strictEqual(capped.commits.length, 200);
  assert.strictEqual(capped.more, true);
  assert.strictEqual(capped.commits.every(c => c.unpushed), true);
});

test('log: a branch with no upstream counts as unpushed against the remotes', async t => {
  const e = setup(t);
  git(e.work, 'switch', '-q', '-c', 'fresh');
  git(e.work, 'commit', '-q', '--allow-empty', '-m', 'fresh');
  const d = await gitops.log(e.work, {});
  assert.deepStrictEqual(d.commits.map(c => [c.subject, c.unpushed]), [['fresh', true], ['init', false]]);
  git(e.work, 'remote', 'remove', 'origin');
  const none = await gitops.log(e.work, {});
  assert.deepStrictEqual(none.commits.map(c => c.unpushed), [false, false]);
});

test('diffs: ws=1 ignores whitespace, the default stays as it was, names are literal', async t => {
  const e = setup(t);
  write(e.f('a.txt'), '  one\n');
  assert.match((await gitinfo.fileDiff(e.work, 'a.txt', 'unstaged')).text, /^\+ {2}one$/m);
  assert.strictEqual((await gitinfo.fileDiff(e.work, 'a.txt', 'unstaged', true)).text, '');
  assert.match((await gitinfo.headDiff(e.work, 'a.txt', false)).text, /^\+ {2}one$/m);
  assert.strictEqual((await gitinfo.headDiff(e.work, 'a.txt', false, true)).text, '');
  git(e.work, 'add', 'a.txt');
  assert.match((await gitinfo.fileDiff(e.work, 'a.txt', 'staged')).text, /^\+ {2}one$/m);
  assert.strictEqual((await gitinfo.fileDiff(e.work, 'a.txt', 'staged', true)).text, '');
  git(e.work, 'commit', '-qm', 'indent');
  const hash = head(e.work);
  assert.match((await gitinfo.commitFileDiff(e.work, hash, 'a.txt')).text, /^\+ {2}one$/m);
  assert.strictEqual((await gitinfo.commitFileDiff(e.work, hash, 'a.txt', true)).text, '');
  write(e.f('u.txt'), 'u\n');
  assert.match((await gitinfo.fileDiff(e.work, 'u.txt', 'untracked', true)).text, /^\+u$/m);
  write(e.f('*.txt'), 'star\n');
  git(e.work, 'add', '*.txt');
  git(e.work, 'reset', '-q', '--', 'u.txt');
  git(e.work, 'commit', '-qm', 'star');
  write(e.f('*.txt'), 'star 2\n');
  write(e.f('a.txt'), 'other\n');
  const star = (await gitinfo.fileDiff(e.work, '*.txt', 'unstaged')).text;
  assert.match(star, /star 2/);
  assert.ok(!star.includes('a.txt'));
});

test('safeFile and cleanRel: what the diff routes accept', async t => {
  const e = setup(t);
  fs.symlinkSync(e.base, e.f('link'));
  assert.strictEqual(gitops.safeFile(e.work, 'a.txt'), 'a.txt');
  assert.strictEqual(gitops.safeFile(e.work, 'gone/deleted.txt'), 'gone/deleted.txt');
  assert.strictEqual(gitops.safeFile(e.work, 'dir/'), 'dir');
  assert.strictEqual(gitops.safeFile(e.work, 'link'), 'link');
  for (const f of ['link/x', '../x', '/etc/passwd', '', null, '.git/config']) assert.strictEqual(gitops.safeFile(e.work, f), null, String(f));
  assert.strictEqual(gitops.safeFile(path.join(e.base, 'nope'), 'a.txt'), null);
  assert.strictEqual(gitops.cleanRel('link/x'), 'link/x');
  for (const f of ['../x', 'a/../b', '/x', '', null, 'a\0b']) assert.strictEqual(gitops.cleanRel(f), null, String(f));
});
