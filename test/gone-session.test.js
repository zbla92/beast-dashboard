const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const src = appSrc.slice(appSrc.indexOf('function instOf(it)'), appSrc.indexOf('// Claude sessions grouped per project'));
const boot = () => {
  const ctx = { isNewChat: n => /^claude-chat-\d{6}-\d{4}/.test(n || ''), chatTitle: () => '' };
  vm.runInNewContext(src + '; this.instNum = instNum;', ctx);
  return ctx;
};

test('instNum: a vanished session (no list entry) is looked up by name without throwing', () => {
  const { instNum } = boot();
  assert.strictEqual(instNum(undefined, 'claude-proj-2'), 2);
  assert.strictEqual(instNum(undefined, 'claude-proj'), null);
  assert.strictEqual(instNum(undefined, undefined), null);
});

test('instNum: a present session is read from the entry', () => {
  const { instNum } = boot();
  assert.strictEqual(instNum({ name: 'claude-proj-3', claude: {} }, 'claude-proj-3'), 3);
});

test('the terminal bar uses the safe lookup and shows an ended line for a vanished session', () => {
  assert.ok(!/instOf\(act\)/.test(appSrc));
  assert.ok(/This session has ended\./.test(appSrc));
});
