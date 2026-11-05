const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-code.js'), 'utf8');
const fnSource = name => {
  const start = src.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  return src.slice(start, src.indexOf('\n  }\n', start) + 4);
};
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sandbox = {
  plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`,
  esc,
  hlLines: (text, lang) => text.split('\n').map(l => (lang ? `<b>${esc(l)}</b>` : esc(l))),
};
vm.runInNewContext(['parseDiff', 'highlight', 'smartAction'].map(fnSource).join('\n'), sandbox);
const { parseDiff, highlight, smartAction } = sandbox;

const DIFF = '@@ -1,2 +1,2 @@\n ctx line\n-old <line>\n+new line';

test('a diff of a file with no known language still shows its text', () => {
  const p = parseDiff(DIFF);
  highlight(p, null);
  const rows = p.hunks[0].rows;
  assert.strictEqual(rows[0].html, 'ctx line');
  assert.strictEqual(rows[1].html, 'old &lt;line>');
  assert.strictEqual(rows[2].html, 'new line');
});

test('a diff is highlighted once per language and again when the language changes', () => {
  const p = parseDiff(DIFF);
  highlight(p, 'js');
  assert.strictEqual(p.hunks[0].rows[2].html, '<b>new line</b>');
  p.hunks[0].rows[2].html = 'kept';
  highlight(p, 'js');
  assert.strictEqual(p.hunks[0].rows[2].html, 'kept');
  highlight(p, null);
  assert.strictEqual(p.hunks[0].rows[2].html, 'new line');
});

const branch = { branch: 'x', upstream: 'origin/x', ahead: 0, behind: 0, detached: false };

test('the main button never commits on a detached HEAD', () => {
  const r = { ...branch, detached: true, upstream: null };
  for (const n of [{ staged: 2, changes: 0 }, { staged: 0, changes: 2 }, { staged: 0, changes: 0 }]) {
    const a = smartAction(r, { conflicts: 0, ...n }, 'message');
    assert.strictEqual(a.off, true);
    assert.match(a.label, /Detached HEAD/);
  }
});

test('the main button follows conflicts, staged, changes, then the branch state', () => {
  const act = (r, n, msg = 'm') => smartAction({ ...branch, ...r }, { conflicts: 0, staged: 0, changes: 0, ...n }, msg);
  assert.match(act({}, { conflicts: 1, staged: 1 }).label, /Resolve 1 conflict/);
  assert.strictEqual(act({}, { staged: 1 }).run, 'commit');
  assert.strictEqual(act({}, { changes: 3 }).run, 'commitAll');
  assert.strictEqual(act({}, { staged: 1 }, '').off, true);
  assert.strictEqual(act({ upstream: null }, {}).run, 'push');
  assert.strictEqual(act({ ahead: 1 }, {}).run, 'push');
  assert.strictEqual(act({ behind: 1 }, {}).run, 'pull');
  assert.strictEqual(act({ ahead: 1, behind: 1 }, {}).off, true);
  assert.strictEqual(act({}, {}).off, true);
});

test('discard keeps the repo it asked about', () => {
  const discard = src.slice(src.indexOf('async function discard(f)'), src.indexOf('function hotFile()'));
  assert.ok(discard.indexOf('const id = C.root') < discard.indexOf('await confirmBox'));
  assert.match(discard, /rowOp\(id, f, 'changes'/);
  assert.doesNotMatch(discard.slice(discard.indexOf('await confirmBox')), /C\.root/);
});
