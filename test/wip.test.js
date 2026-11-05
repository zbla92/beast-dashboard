const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const roots = require('../lib/roots');
const edits = require('../lib/edits');
const wip = require('../lib/wip');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString();
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const toolUse = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name, input }] } }) + '\n';

function repo(dir, files = { 'a.txt': 'one\n' }) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [f, s] of Object.entries(files)) write(path.join(dir, f), s);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}

function setup(t, sessions = []) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-wip-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const set = path.join(root, 'dev', 'h', 'tm');
  const web = repo(path.join(set, 'web'), { 'a.txt': 'one\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  const api = repo(path.join(set, 'api'));
  const sdk = repo(path.join(set, 'sdk'));
  const solo = repo(path.join(root, 'dev', 'p', 'solo'));
  const projects = [
    { id: 'h--tm', name: 'tm', path: set, isGit: false, org: 'h', set: 'h--tm' },
    { id: 'h--tm--web', name: 'web', path: web, isGit: true, org: 'h', set: 'h--tm', parent: 'h--tm' },
    { id: 'h--tm--api', name: 'api', path: api, isGit: true, org: 'h', set: 'h--tm', parent: 'h--tm' },
    { id: 'h--tm--sdk', name: 'sdk', path: sdk, isGit: true, org: 'h', set: 'h--tm', parent: 'h--tm' },
    { id: 'p--solo', name: 'solo', path: solo, isGit: true, org: 'p', set: 'p--solo' },
  ];
  roots.init({ projects: () => projects });
  edits.init({});
  wip.init({ projects: () => projects, sessions: () => sessions });
  return { root, set, web, api, sdk, solo, projects };
}

test('counts staged, unstaged, untracked, numstat and stashes; secrets, staleness and fixed order', async t => {
  const { web, api } = setup(t);
  write(path.join(web, 'a.txt'), 'one\ntwo\nthree\n'); git(web, 'add', 'a.txt');
  write(path.join(web, 'b.txt'), 'changed\n');
  write(path.join(web, 'new.txt'), 'n\n');
  write(path.join(web, '.env.local'), 'SECRET=1\n');
  fs.unlinkSync(path.join(web, 'c.txt'));
  const old = (Date.now() - 5 * 864e5) / 1000; fs.utimesSync(path.join(web, 'b.txt'), old, old);
  write(path.join(api, 'a.txt'), 'stash me\n'); git(api, 'stash', '-q');
  await wip.sweep();
  const s = wip.state();
  const w = s.roots.find(r => r.id === 'h--tm--web');
  assert.deepStrictEqual({ staged: w.staged, unstaged: w.unstaged, untracked: w.untracked, conflicts: w.conflicts }, { staged: 1, unstaged: 2, untracked: 2, conflicts: 0 });
  assert.strictEqual(w.add, 2 + 1);
  assert.strictEqual(w.del, 1 + 1);
  assert.ok(w.flags.includes('env'));
  assert.ok(w.flags.includes('stale'));
  assert.ok(!w.flags.includes('no-upstream'));
  assert.ok(w.oldest < w.newest);
  assert.strictEqual(w.branch, 'main');
  assert.strictEqual(w.set, 'h--tm');
  assert.strictEqual(w.files, undefined);
  assert.ok(!s.roots.some(r => r.id === 'h--tm--api'), 'stash only is not pending');
  assert.ok(!s.roots.some(r => r.id === 'p--solo'));
  const g = wip.gitStatus();
  assert.strictEqual(g['h--tm--api'].stashes, 1);
  assert.strictEqual(g['h--tm--web'].dirty, 3);
  assert.strictEqual(g['h--tm--web'].staged, 1);
  assert.strictEqual(g['h--tm--web'].untracked, 2);
  assert.strictEqual(g['h--tm--web'].last.subject, 'init');
  assert.ok(!('h--tm' in g));
});

test('rebase in progress and conflicts are reported', async t => {
  const { solo } = setup(t);
  git(solo, 'checkout', '-qb', 'side'); write(path.join(solo, 'a.txt'), 'side\n'); git(solo, 'commit', '-qam', 'side');
  git(solo, 'checkout', '-q', 'main'); write(path.join(solo, 'a.txt'), 'main\n'); git(solo, 'commit', '-qam', 'main');
  git(solo, 'checkout', '-q', 'side');
  assert.throws(() => git(solo, 'rebase', 'main'));
  await wip.sweep();
  const r = wip.state().roots.find(x => x.id === 'p--solo');
  assert.strictEqual(r.op, 'rebase');
  assert.strictEqual(r.conflicts, 1);
  assert.ok(r.flags.includes('conflict'));
});

test('worktrees join the sweep and the same branch over two repos forms a group', async t => {
  const { root, web, api, sdk } = setup(t);
  const wa = path.join(root, 'dev', 'wt-X', 'web'); const wb = path.join(root, 'dev', 'wt-X', 'api');
  git(web, 'worktree', 'add', '-q', '-b', 'X-1/feature', wa);
  git(api, 'worktree', 'add', '-q', '-b', 'X-1/feature', wb);
  git(sdk, 'worktree', 'add', '-q', '-b', 'lonely', path.join(root, 'dev', 'wt-L', 'sdk'));
  write(path.join(wa, 'a.txt'), 'wt edit\n');
  await wip.sweep();
  const s = wip.state();
  const idA = 'h--tm--web~' + roots.hashOf(wa); const idB = 'h--tm--api~' + roots.hashOf(wb);
  assert.deepStrictEqual(s.groups, [{ branch: 'X-1/feature', roots: [idB, idA].sort() }]);
  const a = s.roots.find(r => r.id === idA);
  assert.strictEqual(a.worktree, true);
  assert.strictEqual(a.unstaged, 1);
  assert.ok(s.roots.some(r => r.id === idB), 'clean group member is shown with its group');
  assert.ok(!s.roots.some(r => r.id.startsWith('h--tm--sdk~')));
  assert.ok(!('h--tm--web~' + roots.hashOf(wa) in wip.gitStatus()));
  const d = await wip.detail(idA);
  assert.strictEqual(d.files[0].rel, 'a.txt');
  assert.deepStrictEqual(d.worktrees.map(w => w.id).sort(), ['h--tm--web', idA].sort());
});

test('detail lists files with editors, unpushed and recent commits, stashes', async t => {
  const { root, web } = setup(t);
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', remote);
  git(web, 'remote', 'add', 'origin', remote); git(web, 'push', '-qu', 'origin', 'main');
  write(path.join(web, 'a.txt'), 'local\n'); git(web, 'commit', '-qam', 'local only');
  write(path.join(web, 'b.txt'), 'x\n'); git(web, 'stash', '-q');
  write(path.join(web, 'b.txt'), 'edited by claude\n');
  const tr = path.join(root, 's1.jsonl'); write(tr, toolUse('Edit', { file_path: path.join(web, 'b.txt') }));
  edits.init({ entries: () => [{ id: 's1', file: tr, lastAt: Date.now(), title: 'web work' }], live: id => id === 's1' ? 'bd-x' : null, label: () => null });
  await edits.refreshIndex(true);
  const d = await wip.detail('h--tm--web');
  assert.strictEqual(d.root.ahead, 1);
  assert.deepStrictEqual(d.commits.unpushed.map(c => c.subject), ['local only']);
  assert.deepStrictEqual(d.commits.recent.map(c => c.subject), ['init']);
  assert.strictEqual(d.stashes.length, 1);
  assert.match(d.stashes[0].ref, /^stash@\{0\}$/);
  const f = d.files.find(x => x.rel === 'b.txt');
  assert.deepStrictEqual(f.editors.map(e => [e.sessionId, e.live, e.label]), [['s1', 'bd-x', 'web work']]);
  assert.deepStrictEqual(d.root.editors.map(e => [e.sessionId, e.files]), [['s1', 1]]);
  assert.strictEqual(await wip.detail('h--tm--web~deadbeef'), null);
  assert.strictEqual(await wip.detail('h--tm'), null);
});

test('workspace of a session that edited two repos of a set returns the set, live roots follow the session', async t => {
  const sessions = [];
  const { root, set, web, api } = setup(t, sessions);
  const tr = path.join(root, 's.jsonl');
  write(tr, toolUse('Edit', { file_path: path.join(web, 'a.txt') }) + toolUse('Write', { file_path: path.join(api, 'n.txt') }) + toolUse('Write', { file_path: '/tmp/outside-x.md' }));
  const old = path.join(root, 'old.jsonl');
  write(old, toolUse('Edit', { replace_all: true, file_path: path.join(web, 'a.txt') }));
  const ws = await wip.workspace({ session: 'bd-1', cwd: set, transcripts: [tr, old] });
  assert.deepStrictEqual(ws.sets, ['h--tm']);
  assert.deepStrictEqual(ws.roots, ['h--tm--api', 'h--tm--web']);
  assert.deepStrictEqual(ws.edited['h--tm--web'].map(e => [e.rel, e.count]), [['a.txt', 2]]);
  assert.deepStrictEqual(ws.outside.map(o => o.path), ['/tmp/outside-x.md']);
  sessions.push({ tmux: 'bd-1', cwd: set, transcriptPath: tr, state: 'working' });
  await wip.sweep();
  const s = wip.state();
  assert.deepStrictEqual(s.roots.map(r => r.id), ['h--tm--api', 'h--tm--web']);
  assert.deepStrictEqual(s.roots[0].live, ['bd-1']);
  assert.deepStrictEqual(wip.rootsOfSet('h--tm').sort(), ['h--tm--api', 'h--tm--sdk', 'h--tm--web']);
  const solo = await wip.workspace({ cwd: path.join(root, 'dev', 'p', 'solo'), transcripts: [] });
  assert.deepStrictEqual(solo.sets, ['p--solo']);
});

test('workspace ranks the repos a chat worked in by how long it stayed there, without any file edits', async t => {
  const { root, set, web, api } = setup(t, []);
  const line = cwd => JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'x' } }) + '\n';
  const tr = path.join(root, 'bash-only.jsonl');
  write(tr, line(set) + line(api) + line(web) + line(web) + line(web) + line('/tmp/not-a-repo'));
  const ws = await wip.workspace({ session: 'bd-3', cwd: set, transcripts: [tr] });
  assert.deepStrictEqual(ws.worked, ['h--tm--web', 'h--tm--api']);
  assert.deepStrictEqual(ws.roots, ['h--tm--api', 'h--tm--web']);
  assert.deepStrictEqual(ws.edited, {});
  assert.deepStrictEqual(ws.sets, ['h--tm']);
});

test('workspace seq ranks edits across transcripts by write time, not by byte offset', async t => {
  const { root, set, web } = setup(t);
  const old = path.join(root, 'old.jsonl');
  write(old, 'x'.repeat(5000) + '\n' + toolUse('Edit', { file_path: path.join(web, 'b.txt') }));
  const now = path.join(root, 'new.jsonl');
  write(now, toolUse('Edit', { file_path: path.join(web, 'c.txt') }));
  const past = new Date(Date.now() - 3600e3); fs.utimesSync(old, past, past);
  const ws = await wip.workspace({ session: 'bd-2', cwd: set, transcripts: [now, old] });
  const seq = Object.fromEntries(ws.edited['h--tm--web'].map(e => [e.rel, e.seq]));
  assert.ok(seq['c.txt'] > seq['b.txt']);
  assert.ok(ws.edited['h--tm--web'].every(e => !('at' in e)));
});

test('brief stays under 3 kB and lists pending files per repo', async t => {
  const { web } = setup(t);
  for (let i = 0; i < 60; i++) write(path.join(web, `dir${i}`, `file-with-a-long-name-${i}.txt`), 'x\n');
  write(path.join(web, 'a.txt'), 'changed\n');
  await wip.sweep();
  const text = await wip.brief({ set: 'h--tm' });
  assert.ok(Buffer.byteLength(text) <= 3072 + 20);
  assert.match(text, /## web/);
  assert.match(text, / M a\.txt/);
  assert.match(text, /… 36 more/);
  assert.match(text, /2 other repos clean/);
  assert.match(await wip.brief({ root: 'h--tm--web' }), /branch main/);
});

test('a PostToolUse edit hook re-reads that root', async t => {
  const { solo } = setup(t);
  let changed = 0;
  wip.init({ projects: () => [{ id: 'p--solo', name: 'solo', path: solo, isGit: true, org: 'p', set: 'p--solo' }], sessions: () => [], onChange: () => changed++ });
  await wip.sweep();
  assert.strictEqual(wip.state().roots.length, 0);
  write(path.join(solo, 'a.txt'), 'hook edit\n');
  wip.onHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(solo, 'a.txt') } });
  wip.onHook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(solo, 'a.txt') } });
  await new Promise(r => setTimeout(r, 2300));
  assert.strictEqual(changed, 1);
  assert.strictEqual(wip.state().roots[0].unstaged, 1);
});

test('porcelain and numstat parsers handle renames and odd names', () => {
  const st = wip.parseStatus(['# branch.oid abc', '# branch.head (detached)', '2 R. N... 100644 100644 100644 a b R100 new name.txt', 'old name.txt', 'u UU N... 1 1 1 1 a b c both.txt', '? un tracked', ''].join('\0'));
  assert.strictEqual(st.branch, '(detached)');
  assert.deepStrictEqual(st.files.map(f => [f.rel, f.status, f.from]), [['new name.txt', 'R', 'old name.txt'], ['both.txt', 'U', null], ['un tracked', '?', null]]);
  const ns = wip.parseNumstat(['3\t1\tsrc/a b.js', '-\t-\timg.png', '2\t2\t', 'old.txt', 'new.txt', ''].join('\0'));
  assert.deepStrictEqual(ns.get('src/a b.js'), { add: 3, del: 1, binary: false });
  assert.strictEqual(ns.get('img.png').binary, true);
  assert.deepStrictEqual(ns.get('new.txt'), { add: 2, del: 2, binary: false });
  for (const p of ['.env', 'app/.env.production', 'certs/server.pem', 'config/credentials.json', 'id_rsa']) assert.ok(wip.SECRET_RE.test(p), p);
  for (const p of ['src/env.ts', 'README.md', 'environment.md']) assert.ok(!wip.SECRET_RE.test(p), p);
});

test('gitStatus dirty counts a staged-then-edited file once, like the old status sweep', async t => {
  const { web } = setup(t);
  write(path.join(web, 'a.txt'), 'two\n'); git(web, 'add', 'a.txt');
  write(path.join(web, 'a.txt'), 'three\n');
  write(path.join(web, 'u.txt'), 'u\n');
  await wip.sweep();
  const g = wip.gitStatus()['h--tm--web'];
  assert.deepStrictEqual({ dirty: g.dirty, untracked: g.untracked, staged: g.staged }, { dirty: 1, untracked: 1, staged: 1 });
});

test('a slow sweep keeps a newer per-root read', async t => {
  const { web } = setup(t);
  await wip.sweep();
  write(path.join(web, 'z.txt'), 'z\n');
  const slow = wip.sweep();
  await wip.refreshOne('h--tm--web');
  await slow;
  assert.strictEqual(wip.state().roots.find(r => r.id === 'h--tm--web').untracked, 1);
});

test('worktreeGitDir resolves a relative gitdir against the worktree metadata folder', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-wtgd-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meta = path.join(dir, 'repo', '.git', 'worktrees', 'feat');
  write(path.join(meta, 'gitdir'), '../../../../feat/.git\n');
  assert.strictEqual(wip.worktreeGitDir(path.join(dir, 'repo'), 'feat'), path.join(dir, 'feat'));
});
