const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-empty-')));
process.env.BD_TEST = '1';
process.env.BD_MIRROR = tmp;
process.env.XDG_RUNTIME_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'claude-sessions.json'), '{}');
const PORT = 8795, socks = path.join(tmp, `beast-dash-test-${PORT}`), log = path.join(tmp, 'tmux.log'), bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
case "$1" in
  has-session) exit 1 ;;
  new-session) while [ $# -gt 0 ]; do [ "$1" = "-s" ] && : > ${JSON.stringify(socks)}/"$2".sock; shift; done; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
const PATH0 = process.env.PATH; process.env.PATH = bin + ':' + PATH0;
const claude = require('../lib/claude');
const headless = require('../lib/headless');
headless.init({ port: PORT, test: true });
test.after(() => { process.env.PATH = PATH0; fs.rmSync(tmp, { recursive: true, force: true }); });

test('startEmptyChat: starts a chat with no first message, in the folder and account asked for', async () => {
  const dir = path.join(tmp, 'proj'); fs.mkdirSync(dir);
  const r = await headless.startEmptyChat(dir, 'company');
  assert.strictEqual(r.ok, true, r.error);
  assert.match(r.name, /^claude-chat-\d{6}-\d{4}(-\d+)?-company$/);
  assert.strictEqual(r.empty, true); assert.strictEqual(r.cwd, dir); assert.strictEqual(r.account, 'company');
  const rec = claude.get(r.name);
  assert.strictEqual(rec.mode, 'chat'); assert.strictEqual(rec.cwd, dir); assert.strictEqual(rec.sessionId, r.sessionId);
  assert.ok(!rec.firstPrompt, 'no first prompt recorded');
  const started = fs.readFileSync(log, 'utf8').split('\n').find(l => l.startsWith('new-session') && l.includes(r.name));
  assert.ok(started && /--start'?\W+'?new\b/.test(started) && started.includes(r.sessionId), 'launched as a new conversation: ' + started);
});

test('startEmptyChat: anything but company is personal; a missing folder fails', async () => {
  const dir = path.join(tmp, 'proj2'); fs.mkdirSync(dir);
  const r = await headless.startEmptyChat(dir, 'nope');
  assert.strictEqual(r.ok, true, r.error); assert.strictEqual(r.account, 'personal'); assert.ok(!r.name.endsWith('-company'));
  assert.strictEqual((await headless.startEmptyChat(path.join(tmp, 'gone'), 'personal')).ok, false);
});

test('startChat still refuses an empty message (a blank prompt sent by mistake must not leave an idle chat behind)', async () => {
  for (const t of ['', '   ', null, undefined]) assert.deepStrictEqual(await headless.startChat(tmp, 'personal', t), { ok: false, error: 'empty message' });
});

test('a chat title shows what was typed, or the file names, never the upload paths', () => {
  const { titleFromPrompt } = require('../lib/util');
  assert.strictEqual(titleFromPrompt('fix this\n\n/home/u/dev/.pasted/a.jpg\n/home/u/dev/.pasted/b.pdf'), 'fix this');
  assert.strictEqual(titleFromPrompt('📎 /home/u/dev/.pasted/a.jpg /home/u/dev/.pasted/keep/b.pdf'), '📎 a.jpg b.pdf');
  assert.strictEqual(titleFromPrompt('look at   /etc/hosts please'), 'look at /etc/hosts please');
});

test('startEmptyChat: fails when the runner never comes up', async () => {
  const tmuxFile = path.join(bin, 'tmux'); const working = fs.readFileSync(tmuxFile, 'utf8');
  fs.writeFileSync(tmuxFile, '#!/bin/sh\ncase "$1" in has-session) exit 1 ;; esac\nexit 0\n', { mode: 0o755 });
  try {
    const dir = path.join(tmp, 'proj3'); fs.mkdirSync(dir);
    const r = await headless.startEmptyChat(dir, 'personal');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'the chat did not start');
    assert.ok(!Object.values(claude.all()).some(record => record.cwd === dir), 'no record left behind');
  } finally { fs.writeFileSync(tmuxFile, working, { mode: 0o755 }); }
});

test('startEmptyChat: a runner still starting is not reported as a failure', async () => {
  const tmuxFile = path.join(bin, 'tmux'); const working = fs.readFileSync(tmuxFile, 'utf8');
  fs.writeFileSync(tmuxFile, `#!/bin/sh
marker=${JSON.stringify(path.join(tmp, 'alive'))}
case "$1" in
  has-session) [ -e "$marker" ] ;;
  new-session) : > "$marker" ;;
esac
`, { mode: 0o755 });
  try {
    const dir = path.join(tmp, 'proj5'); fs.mkdirSync(dir);
    const r = await headless.startEmptyChat(dir, 'personal');
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(claude.get(r.name).cwd, dir);
  } finally { fs.writeFileSync(tmuxFile, working, { mode: 0o755 }); }
});

test('forkChat: a chat with no conversation yet is refused, with the reason', async () => {
  const dir = path.join(tmp, 'proj4'); fs.mkdirSync(dir);
  const r = await headless.forkChat({ sessionId: '11111111-1111-4111-8111-111111111111', cwd: dir, account: 'personal' });
  assert.deepStrictEqual(r, { ok: false, error: 'no conversation to fork was found for this session' });
});

test('an empty chat takes its title from the first message it gets', () => {
  const name = 'claude-chat-title-test';
  claude.markChat(name, { cwd: tmp, account: 'personal', sessionId: '22222222-2222-4222-8222-222222222222' });
  assert.ok(!claude.get(name).firstPrompt);
  claude.onHook({ 'x-tmux-session': name }, { hook_event_name: 'UserPromptSubmit', prompt: 'fix the login\n\n/home/u/dev/.pasted/a.jpg' });
  assert.strictEqual(claude.get(name).firstPrompt, 'fix the login');
  claude.onHook({ 'x-tmux-session': name }, { hook_event_name: 'UserPromptSubmit', prompt: 'second message' });
  assert.strictEqual(claude.get(name).firstPrompt, 'fix the login');
});
