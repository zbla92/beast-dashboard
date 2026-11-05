'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const pasted = require('../lib/pasted');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-pasted-')));
const dev = path.join(tmp, 'dev');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
const makeRepo = dir => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
};
makeRepo(path.join(dev, 'acme', 'alpha'));
makeRepo(path.join(dev, 'acme', 'grouped', 'backend'));
makeRepo(path.join(dev, 'solo'));
makeRepo(path.join(dev, 'acme', 'same'));
makeRepo(path.join(dev, 'other', 'same'));
fs.mkdirSync(path.join(dev, 'acme', 'plain', 'deep'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'elsewhere'));
git(path.join(dev, 'acme', 'alpha'), 'worktree', 'add', '-q', path.join(dev, 'acme', 'alpha-wt'));
git(path.join(dev, 'acme', 'grouped', 'backend'), 'worktree', 'add', '-q', path.join(dev, 'acme', 'grouped', 'worktrees', 'one'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const folderOf = (...rel) => pasted.projectFolder(path.join(dev, ...rel), dev);

test('a project and everything under it share one folder', () => {
  assert.strictEqual(folderOf('acme', 'alpha'), 'alpha');
  assert.strictEqual(folderOf('acme', 'grouped'), 'grouped');
  assert.strictEqual(folderOf('acme', 'grouped', 'backend'), 'grouped');
  assert.strictEqual(folderOf('acme', 'grouped', 'worktrees', 'one'), 'grouped');
  assert.strictEqual(folderOf('acme', 'plain', 'deep'), 'plain');
});

test('a worktree beside its repo counts as that repo', () => {
  assert.strictEqual(folderOf('acme', 'alpha-wt'), 'alpha');
});

test('a repo directly in the dev root keeps its own name', () => {
  assert.strictEqual(folderOf('solo'), 'solo');
});

test('no project means unsorted', () => {
  assert.strictEqual(pasted.projectFolder(dev, dev), pasted.UNSORTED);
  assert.strictEqual(folderOf('acme'), pasted.UNSORTED);
  assert.strictEqual(pasted.projectFolder(path.join(tmp, 'elsewhere'), dev), pasted.UNSORTED);
  assert.strictEqual(pasted.projectFolder('', dev), pasted.UNSORTED);
  assert.strictEqual(pasted.projectFolder(null, dev), pasted.UNSORTED);
});

test('two organisations with the same project name never share a folder', () => {
  assert.strictEqual(folderOf('acme', 'same'), 'acme-same');
  assert.strictEqual(folderOf('other', 'same'), 'other-same');
});

test('a repo in the dev root and a project of the same name stay apart', () => {
  makeRepo(path.join(dev, 'twin'));
  makeRepo(path.join(dev, 'acme', 'twin'));
  assert.strictEqual(folderOf('twin'), 'root-twin');
  assert.strictEqual(folderOf('acme', 'twin'), 'acme-twin');
});

test('names that clean up to the same text stay apart', () => {
  fs.mkdirSync(path.join(dev, 'acme', 'foo bar'));
  fs.mkdirSync(path.join(dev, 'acme', 'foo-bar'));
  assert.strictEqual(folderOf('acme', 'foo-bar'), 'foo-bar');
  assert.match(folderOf('acme', 'foo bar'), /^foo-bar-[0-9a-f]{6}$/);
});

test('a project cannot take a reserved folder', () => {
  fs.mkdirSync(path.join(dev, 'acme', 'keep'));
  fs.mkdirSync(path.join(dev, 'acme', '_unsorted'));
  assert.strictEqual(folderOf('acme', 'keep'), pasted.UNSORTED);
  assert.strictEqual(folderOf('acme', '_unsorted'), pasted.UNSORTED);
});

test('task attachments go under keep', () => {
  assert.strictEqual(pasted.uploadDir('/b', 'alpha', false), path.join('/b', 'alpha'));
  assert.strictEqual(pasted.uploadDir('/b', 'alpha', true), path.join('/b', 'keep', 'alpha'));
});

test('sweep removes by age per folder and never touches keep', () => {
  const base = path.join(tmp, 'sweep');
  const now = Date.now();
  const place = (rel, days) => {
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, (now - days * 86400e3) / 1000, (now - days * 86400e3) / 1000);
    return file;
  };
  const gone = [place('loose-old.jpg', 8), place('_unsorted/old.jpg', 8), place('alpha/old.jpg', 31)];
  const kept = [place('loose-new.jpg', 6), place('_unsorted/new.jpg', 6), place('alpha/recent.jpg', 29), place('keep/ancient.jpg', 900), place('keep/alpha/ancient.jpg', 900)];
  pasted.sweep(base, now);
  for (const f of gone) assert.ok(!fs.existsSync(f), f);
  for (const f of kept) assert.ok(fs.existsSync(f), f);
});

test('sweep survives a missing folder', () => {
  assert.doesNotThrow(() => pasted.sweep(path.join(tmp, 'nothing-here')));
});

const cwd = path.join(dev, 'acme', 'alpha');
const box = path.join(dev, '.pasted');
const bash = command => pasted.blockedUse({ tool_name: 'Bash', tool_input: { command }, cwd });
const tool = (tool_name, tool_input) => pasted.blockedUse({ tool_name, tool_input, cwd });

test('guard refuses searching the whole folder', () => {
  for (const c of [`grep -r foo ${box}`, `rg foo ${box}/`, `ls ${box}`, `ls -la "${box}"`, `find ${box} -name '*.csv'`, `cat ${box}/*.csv`, `for f in ${box}/*; do cat "$f"; done`, `x=$(ls ${box})`, `cd ${box} && ls`, `python3 -c "import os; os.walk('${box}')"`, `ls ${box}/keep`]) {
    assert.ok(bash(c), c);
  }
  assert.ok(tool('Grep', { pattern: 'x', path: box }));
  assert.ok(tool('Glob', { pattern: '**/*.csv', path: box }));
  assert.ok(tool('Glob', { pattern: `${box}/**` }));
});

test('guard refuses listing another project or unsorted', () => {
  for (const c of [`ls ${box}/beta`, `grep -r x ${box}/_unsorted`, `cat ${box}/beta/*`, `find ${box}/keep/beta`, `ls ${box}/alpha/../beta`]) assert.ok(bash(c), c);
  assert.ok(tool('Grep', { pattern: 'x', path: `${box}/beta` }));
});

test('guard allows the own folder and any file named in full', () => {
  for (const c of [`ls ${box}/alpha`, `grep -r x ${box}/alpha/`, `cat ${box}/alpha/*.csv`, `ls ${box}/keep/alpha`, `cat ${box}/beta/report.csv`, `file ${box}/paste-2026-01-01.jpg`, `cp ${box}/keep/old.pdf /tmp/`]) {
    assert.strictEqual(bash(c), null, c);
  }
  assert.strictEqual(tool('Grep', { pattern: 'x', path: `${box}/alpha` }), null);
  assert.strictEqual(tool('Read', { file_path: `${box}/beta/report.csv` }), null);
});

test('guard checks the disk for a folder that looks like a file, and a file with no extension', () => {
  fs.mkdirSync(path.join(box, 'my.app'), { recursive: true });
  fs.mkdirSync(path.join(box, 'beta'), { recursive: true });
  fs.writeFileSync(path.join(box, 'beta', 'README'), 'x');
  assert.ok(bash(`ls ${box}/my.app`));
  assert.strictEqual(bash(`cat ${box}/beta/README`), null);
});

test('guard leaves commands that exclude the folder alone', () => {
  for (const c of [`grep -r x ${dev} --exclude-dir=.pasted`, `grep -r x --exclude-dir .pasted ${dev}`, `find ${dev} -not -path '*/.pasted/*'`, `find . -path ./.pasted -prune -o -name a`, `rsync -a --exclude .pasted a b`, `tar --exclude=.pasted -c .`, `rg x --glob '!**/.pasted/**'`]) {
    assert.strictEqual(bash(c), null, c);
  }
});

test('guard leaves commit and PR text alone', () => {
  const heredoc = `git commit -F - <<'EOF'\neach file goes in ${box}\nfor ls in ${box}/*\nEOF`;
  for (const c of [heredoc, 'git commit -m "uploads; each file goes in .pasted"', `git commit -m "a; ls ${box}"`, `gh pr create --body "find ${box}"`]) {
    assert.strictEqual(bash(c), null, c);
  }
});

test('guard: a bare .pasted is a search word unless the folder is right here', () => {
  for (const c of ['grep -rn ".pasted" lib/', "rg '.pasted' server.js", 'git log | grep .pasted']) assert.strictEqual(bash(c), null, c);
  assert.ok(pasted.blockedUse({ tool_name: 'Bash', tool_input: { command: 'grep -r x .pasted' }, cwd: dev }));
});

test('guard names the folder to use', () => {
  assert.match(bash(`ls ${box}`), /\.pasted\/alpha\//);
});

test('guard ignores text that only mentions the folder', () => {
  for (const c of ['grep -n "\\.pasted" lib/files.js', 'rg pastedDir server.js', `git log --grep ${box}`, `echo ${box}`, 'cat foo.pasted', 'ls /x/.pasted_old']) {
    assert.strictEqual(bash(c), null, c);
  }
  assert.strictEqual(pasted.blockedUse({ tool_name: 'Bash', tool_input: {}, cwd }), null);
});

test('guard script: exit 2 blocks, anything else passes', () => {
  const script = path.join(__dirname, '..', 'bin', 'pasted-guard.sh');
  const run = input => spawnSync(script, { input, encoding: 'utf8' });
  const blocked = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: `ls ${box}` }, cwd }));
  assert.strictEqual(blocked.status, 2);
  assert.match(blocked.stderr, /\.pasted\/alpha\//);
  assert.strictEqual(run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls /tmp' }, cwd })).status, 0);
  assert.strictEqual(run('not json .pasted').status, 0);
});
