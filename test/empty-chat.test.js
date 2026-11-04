const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// a fake tmux first on PATH: no real tmux session is ever made. has-session says "no such session";
// new-session logs its args and creates the runner's socket file, as the runner would.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-empty-')));
process.env.BD_TEST = '1';
process.env.BD_MIRROR = tmp;   // the session store is read-only: nothing is written to state/
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
