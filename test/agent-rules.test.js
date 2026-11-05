'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { rulesBlock, stateOf, withRules, withoutRules, status, install, remove, ask, START, END } = require('../bin/agent-rules');

const SCRIPT = path.join(__dirname, '..', 'bin', 'agent-rules.js');
const rules = rulesBlock();

function home(t, { company = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-rules-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude'));
  if (company) fs.mkdirSync(path.join(dir, '.claude-company'));
  return dir;
}
const file = (h, d = '.claude') => path.join(h, d, 'CLAUDE.md');
const base = (h, logs = []) => ({ home: h, rules, log: m => logs.push(m) });

test('the block in the guide starts and ends with the markers and has no code fence inside', () => {
  assert.ok(rules.startsWith(START));
  assert.ok(rules.endsWith(END));
  assert.ok(!rules.includes('```'));
  for (const topic of ['.pasted', 'plan new', 'model', 'Stop and ask']) assert.ok(rules.includes(topic), topic);
});

test('stateOf tells absent, current, outdated and broken apart', () => {
  assert.equal(stateOf('# mine\n', rules), 'absent');
  assert.equal(stateOf(`# mine\n\n${rules}\n`, rules), 'current');
  assert.equal(stateOf(`${START}\nold\n${END}\n`, rules), 'outdated');
  assert.equal(stateOf(`${START}\nno end\n`, rules), 'broken');
  assert.equal(stateOf(`${END}\n${START}\n`, rules), 'broken');
  assert.equal(stateOf(`${rules}\n${rules}\n`, rules), 'broken');
});

test('adding keeps every byte of the file above the block, removing brings it back', () => {
  const mine = '# My rules\n\n- keep this\n  exactly   as it is\n';
  const added = withRules(mine, rules);
  assert.ok(added.startsWith(mine));
  assert.ok(added.endsWith(`${rules}\n`));
  assert.equal(withoutRules(added), mine);
});

test('adding keeps trailing blank lines and a whitespace-only file', () => {
  assert.equal(withRules('mine\n\n\n', rules), `mine\n\n\n\n${rules}\n`);
  assert.equal(withRules('  \n', rules), `  \n\n${rules}\n`);
});

test('removing from a CRLF file keeps its line endings', () => {
  assert.equal(withoutRules(`above\r\n\r\n${rules}\r\n\r\nbelow\r\n`), 'above\r\n\r\nbelow\r\n');
});

test('a yes uses the file as it is after the answer, not as it was before the question', async t => {
  const h = home(t, { company: false });
  fs.writeFileSync(file(h), '# mine\n');
  await ask({ ...base(h), prompt: async () => { fs.appendFileSync(file(h), 'added while asking\n'); return 'y'; } });
  const after = fs.readFileSync(file(h), 'utf8');
  assert.ok(after.startsWith('# mine\nadded while asking\n'));
  assert.ok(after.includes(START));
});

test('a block added or broken while asking is left alone', async t => {
  const h = home(t, { company: false });
  fs.writeFileSync(file(h), '# mine\n');
  await ask({ ...base(h), prompt: async () => { fs.writeFileSync(file(h), `${START}\nno end\n`); return 'y'; } });
  assert.equal(fs.readFileSync(file(h), 'utf8'), `${START}\nno end\n`);
});

test('a file that is not UTF-8 is skipped and keeps its bytes', t => {
  const h = home(t, { company: false });
  const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  fs.writeFileSync(file(h), latin);
  const logs = [];
  install(base(h, logs));
  assert.deepEqual(fs.readFileSync(file(h)), latin);
  assert.ok(logs.some(l => l.includes('not UTF-8')));
});

test('a read-only file is not rewritten', t => {
  const h = home(t, { company: false });
  fs.writeFileSync(file(h), '# mine\n', { mode: 0o444 });
  const logs = [];
  install(base(h, logs));
  assert.equal(fs.readFileSync(file(h), 'utf8'), '# mine\n');
  assert.ok(logs.some(l => l.includes('read-only')));
});

test('adding to a file with no last newline and to an empty file', () => {
  assert.equal(withRules('mine', rules), `mine\n\n${rules}\n`);
  assert.equal(withRules('', rules), `${rules}\n`);
  assert.equal(withoutRules(`${rules}\n`), '');
});

test('an update only replaces what is between the markers', () => {
  const text = `above\n\n${START}\nold rules\n${END}\n\nbelow\n`;
  assert.equal(withRules(text, rules), `above\n\n${rules}\n\nbelow\n`);
});

test('removing keeps text on both sides', () => {
  assert.equal(withoutRules(`above\n\n${rules}\n\nbelow\n`), 'above\n\nbelow\n');
});

test('install adds the block to both logins, a second run changes nothing', t => {
  const h = home(t);
  fs.writeFileSync(file(h), '# mine\n');
  install(base(h));
  assert.equal(fs.readFileSync(file(h), 'utf8'), `# mine\n\n${rules}\n`);
  assert.equal(fs.readFileSync(file(h, '.claude-company'), 'utf8'), `${rules}\n`);
  const before = fs.statSync(file(h)).mtimeMs;
  const logs = [];
  install(base(h, logs));
  assert.equal(fs.statSync(file(h)).mtimeMs, before);
  assert.ok(logs.every(m => m.startsWith('current ')));
});

test('nothing is created for a login that does not exist', t => {
  const h = home(t, { company: false });
  install(base(h));
  assert.ok(!fs.existsSync(path.join(h, '.claude-company')));
  fs.rmSync(path.join(h, '.claude'), { recursive: true });
  install(base(h));
  assert.ok(!fs.existsSync(path.join(h, '.claude')));
});

test('a file with broken markers is left alone by install, remove and ask', async t => {
  const h = home(t, { company: false });
  const broken = `# mine\n${START}\nno end\n`;
  fs.writeFileSync(file(h), broken);
  for (const action of [install, remove]) {
    const logs = [];
    action(base(h, logs));
    assert.equal(fs.readFileSync(file(h), 'utf8'), broken);
    assert.ok(logs.some(m => m.startsWith('left alone ')));
  }
  await ask({ ...base(h), prompt: async () => { throw new Error('must not ask'); } });
  assert.equal(fs.readFileSync(file(h), 'utf8'), broken);
});

test('a symlinked CLAUDE.md stays a link and keeps its mode', t => {
  const h = home(t, { company: false });
  const real = path.join(h, 'dotfiles-claude.md');
  fs.writeFileSync(real, '# mine\n', { mode: 0o600 });
  fs.chmodSync(real, 0o600);
  fs.symlinkSync(real, file(h));
  install(base(h));
  assert.ok(fs.lstatSync(file(h)).isSymbolicLink());
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(real, 'utf8').startsWith('# mine\n'));
});

test('ask writes only after a yes, and no is the default', async t => {
  const h = home(t);
  fs.writeFileSync(file(h), '# mine\n');
  const answers = { [file(h)]: '', [file(h, '.claude-company')]: 'y' };
  const asked = [];
  await ask({ ...base(h), prompt: async q => {
    asked.push(q);
    return answers[Object.keys(answers).find(f => q.includes(f))];
  } });
  assert.equal(asked.length, 2);
  assert.ok(asked.every(q => q.includes('[y/N]')));
  assert.equal(fs.readFileSync(file(h), 'utf8'), '# mine\n');
  assert.equal(fs.readFileSync(file(h, '.claude-company'), 'utf8'), `${rules}\n`);
});

test('ask without a terminal only prints a hint', async t => {
  const h = home(t);
  fs.writeFileSync(file(h), '# mine\n');
  const logs = [];
  await ask(base(h, logs));
  assert.equal(fs.readFileSync(file(h), 'utf8'), '# mine\n');
  assert.ok(!fs.existsSync(file(h, '.claude-company')));
  assert.equal(logs.length, 2);
  assert.ok(logs.every(m => m.includes('--install')));
});

test('ask stays quiet when the block is current and offers an update when it changed', async t => {
  const h = home(t, { company: false });
  install(base(h));
  const asked = [];
  const prompt = async q => { asked.push(q); return 'yes'; };
  await ask({ ...base(h), prompt });
  assert.equal(asked.length, 0);
  fs.writeFileSync(file(h), `# mine\n${START}\nold\n${END}\n`);
  await ask({ ...base(h), prompt });
  assert.ok(asked[0].startsWith('Update '));
  assert.equal(fs.readFileSync(file(h), 'utf8'), `# mine\n${rules}\n`);
});

test('status reports each file without changing it', t => {
  const h = home(t);
  fs.writeFileSync(file(h), '# mine\n');
  const logs = [];
  status(base(h, logs));
  assert.deepEqual(logs, [`absent ${file(h)}`, `absent ${file(h, '.claude-company')}`]);
  assert.equal(fs.readFileSync(file(h), 'utf8'), '# mine\n');
  assert.ok(!fs.existsSync(file(h, '.claude-company')));
});

test('the command line: --ask without a terminal writes nothing, --install and --remove work, a wrong flag exits 2', t => {
  const h = home(t, { company: false });
  const env = { ...process.env, HOME: h };
  const cli = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(cli('--ask'), /--install/);
  assert.ok(!fs.existsSync(file(h)));
  assert.equal(cli('--print').trim(), rules);
  cli('--install');
  assert.match(cli('--status'), /^current /);
  cli('--remove');
  assert.match(cli('--status'), /^absent /);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--nope'], { env }).status, 2);
});
