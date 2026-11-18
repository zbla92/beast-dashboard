const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-railflat.js'), 'utf8');

const boot = () => {
  const FEAT = {};
  vm.runInNewContext(src, {
    FEAT,
    isNewChat: name => /^claude-chat-/.test(name),
    chatTitle: cl => cl.label || cl.title || 'New chat',
    withoutLeadingPaths: s => s,
    shortPrompt: s => s,
  });
  return FEAT.railflat;
};

const item = (name, claude) => ({ name, claude });

test('strip drops a title equal to the project name', () => {
  assert.strictEqual(boot().strip('beast', 'Beast'), '');
});

test('strip removes the project prefix before whitespace or a separator', () => {
  const { strip } = boot();
  assert.strictEqual(strip('beast', 'beast fixes'), 'fixes');
  assert.strictEqual(strip('beast', 'beast: fixes'), 'fixes');
  assert.strictEqual(strip('beast', 'beast - fixes'), 'fixes');
  assert.strictEqual(strip('beast', 'beast | fixes'), 'fixes');
});

test('strip leaves hyphenated words and other titles alone', () => {
  const { strip } = boot();
  assert.strictEqual(strip('beast', 'beast-dashboard fixes'), 'beast-dashboard fixes');
  assert.strictEqual(strip('beast', 'beasts'), 'beasts');
  assert.strictEqual(strip('beast', 'other'), 'other');
});

test('single row: project is the bold name, title the second line', () => {
  const r = boot().names(item('claude-a', { label: 'Report' }), 'proj', false, 'fb', 'plain');
  assert.deepStrictEqual({ ...r }, { name: 'proj', line: 'Report' });
});

test('single row with a title equal to the project falls back to the last prompt', () => {
  const r = boot().names(item('claude-a', { label: 'proj', lastPrompt: 'do research' }), 'proj', false, 'fb', 'plain');
  assert.deepStrictEqual({ ...r }, { name: 'proj', line: 'do research' });
});

test('row without a project keeps the title, then the fallback, as the bold name', () => {
  const { names } = boot();
  assert.strictEqual(names(item('claude-chat-1', { title: 'Chat' }), null, false, 'fb', 'plain').name, 'Chat');
  assert.strictEqual(names(item('sh-1', {}), null, false, 'sh-1', 'plain').name, 'sh-1');
});

test('indented row: stripped title, else the non-label fallback', () => {
  const { names } = boot();
  assert.strictEqual(names(item('claude-a', { title: 'proj: Scaling' }), 'proj', true, 'proj', '#2').name, 'Scaling');
  assert.strictEqual(names(item('claude-a', { label: 'proj' }), 'proj', true, 'proj', '#2').name, '#2');
});
