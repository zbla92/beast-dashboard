const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-seen-')));
process.env.BD_TEST = '1';
process.env.BD_MIRROR = tmp;
process.env.XDG_RUNTIME_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'claude-sessions.json'), '{}');
const claude = require('../lib/claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const hookOf = name => (body, ts) => claude.onHook({ 'x-tmux-session': name, 'x-ts': String(ts) }, body);
const finish = (name, at) => { const hook = hookOf(name); hook({ hook_event_name: 'UserPromptSubmit', prompt: 'do it' }, at - 500); hook({ hook_event_name: 'Stop' }, at); };

test('a finished turn stays needs-you and unseen until seen, then needs-you but no longer unseen', () => {
  const name = 'claude-seen-a';
  finish(name, 10000);
  let i = claude.info(name);
  assert.strictEqual(i.state, 'needs-you');
  assert.strictEqual(i.unseen, true);
  assert.strictEqual(i.needsYou, true);
  assert.strictEqual(i.doneAt, 10000);
  claude.seen(name, 11000);
  i = claude.info(name);
  assert.strictEqual(i.state, 'needs-you');
  assert.strictEqual(i.unseen, false);
  assert.strictEqual(i.needsYou, false);
  assert.strictEqual(i.seenAt, 11000);
  finish(name, 20000);
  assert.strictEqual(claude.info(name).unseen, true);
});

test('seen never moves the watermark back', () => {
  const name = 'claude-seen-b';
  finish(name, 10000);
  claude.seen(name, 15000);
  claude.seen(name, 12000);
  assert.strictEqual(claude.info(name).seenAt, 15000);
});

test('an error is unseen until seen; permission and limit stay needs-you regardless', () => {
  const name = 'claude-seen-c';
  const hook = hookOf(name);
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 1000);
  hook({ hook_event_name: 'StopFailure', error: 'boom' }, 2000);
  assert.strictEqual(claude.info(name).state, 'error');
  assert.strictEqual(claude.info(name).unseen, true);
  claude.seen(name, 3000);
  assert.strictEqual(claude.info(name).state, 'error');
  assert.strictEqual(claude.info(name).unseen, false);
  assert.strictEqual(claude.info(name).needsYou, false);
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'again' }, 4000);
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, 5000);
  claude.seen(name, 6000);
  const i = claude.info(name);
  assert.strictEqual(i.state, 'permission');
  assert.strictEqual(i.unseen, false);
  assert.strictEqual(i.needsYou, true);
});

test('a wake Stop after the user looked at a holding session makes it unseen again', () => {
  const name = 'claude-seen-d';
  finish(name, 10000);
  claude.seen(name, 12000);
  hookOf(name)({ hook_event_name: 'Stop' }, 30000);
  const i = claude.info(name);
  assert.strictEqual(i.since, 10000);
  assert.strictEqual(i.doneAt, 30000);
  assert.strictEqual(i.unseen, true);
});

test('autoSeen marks an unseen completion seen, and does nothing when there is none', () => {
  const name = 'claude-seen-e';
  finish(name, 10000);
  assert.strictEqual(claude.autoSeen(name, 11000), true);
  assert.strictEqual(claude.info(name).seenAt, 11000);
  assert.strictEqual(claude.autoSeen(name, 12000), false);
  assert.strictEqual(claude.info(name).seenAt, 11000);
  assert.strictEqual(claude.autoSeen('claude-seen-nope', 12000), false);
});

test('mark unread rewinds the watermark and sticks against watching until a new completion or an explicit open', () => {
  const name = 'claude-seen-f';
  finish(name, 10000);
  claude.seen(name, 11000);
  assert.deepStrictEqual(claude.markUnread(name), { ok: true, seenAt: 9999 });
  assert.strictEqual(claude.info(name).unseen, true);
  assert.strictEqual(claude.info(name).needsYou, true);
  assert.strictEqual(claude.autoSeen(name, 12000), false);
  assert.strictEqual(claude.info(name).unseen, true);
  claude.seen(name, 13000);
  assert.strictEqual(claude.info(name).unseen, false);
  assert.strictEqual(claude.autoSeen(name, 14000), false);
  claude.markUnread(name);
  finish(name, 20000);
  assert.strictEqual(claude.autoSeen(name, 21000), true);
  assert.strictEqual(claude.info(name).unseen, false);
});

test('mark unread needs a completion to rewind to', () => {
  const name = 'claude-seen-g';
  hookOf(name)({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 1000);
  assert.strictEqual(claude.info(name).state, 'working');
  assert.strictEqual(claude.markUnread(name).ok, false);
  assert.strictEqual(claude.markUnread('claude-seen-nope').ok, false);
});

test('seen, autoSeen and mark unread ignore names that are not own records', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    claude.seen(name, 50000);
    claude.autoSeen(name, 50000);
    assert.strictEqual(claude.markUnread(name).ok, false);
  }
  assert.strictEqual(({}).seenAt, undefined);
  assert.strictEqual(Object.prototype.unreadAt, undefined);
});
