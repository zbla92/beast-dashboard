'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { iconFor, fnv1a32, KEYS, PALETTE } = require('../lib/bot-icons');

const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'guide', 'bots.md'), 'utf8');
const tableRows = doc.split('\n').filter(l => /^\| \d+ \| `[a-z]+` \|/.test(l)).map(l => {
  const cells = l.split('|').map(c => c.trim());
  const words = cells[3].replace(/\(.*\)/, '').split(',').map(w => w.trim()).filter(Boolean);
  return { key: cells[2].replace(/`/g, ''), words };
});

test('the key list has 24 keys in table order and ends with robot', () => {
  assert.equal(KEYS.length, 24);
  assert.deepEqual(KEYS, tableRows.map(r => r.key));
  assert.equal(KEYS.at(-1), 'robot');
  assert.equal(PALETTE.length, 12);
});

test('every keyword maps to its own key, none is listed twice', () => {
  const seen = new Set();
  for (const { key, words } of tableRows) {
    assert.ok(words.length > 0, key);
    for (const w of words) {
      assert.ok(!seen.has(w), `duplicate keyword ${w}`);
      seen.add(w);
      assert.equal(iconFor({ name: w, icon: 'auto' }).key, key, w);
    }
  }
});

test('plural keywords match and partial words do not', () => {
  assert.equal(iconFor({ name: 'tickets' }).key, 'support');
  assert.equal(iconFor({ name: 'dbx' }).key, 'robot');
  assert.equal(iconFor({ name: 'code-review' }).key, 'review');
  assert.equal(iconFor({ name: 'Ünit_tester' }).key, 'test');
});

test('title is read only when the name matches nothing', () => {
  assert.equal(iconFor({ name: 'a', title: 'Release notes' }).key, 'deploy');
  assert.equal(iconFor({ name: 'db', title: 'Release notes' }).key, 'database');
});

test('an explicit key wins and an unknown key falls back to auto', () => {
  assert.deepEqual(iconFor({ name: 'db', title: 'db', icon: 'chart' }), { key: 'chart', color: '#84cc16', glyph: null });
  assert.deepEqual(iconFor({ name: 'db', title: 'db', icon: 'nope' }), { key: 'database', color: '#84cc16', glyph: null });
});

test('missing, empty, auto and the old default give no glyph', () => {
  for (const icon of [undefined, null, '', 'auto', '◆']) assert.equal(iconFor({ name: 'helper', icon }).glyph, null);
  assert.equal(iconFor({ name: 'xyz', title: 'Xyz', icon: 'auto' }).key, 'robot');
  assert.equal(iconFor({ name: 'helper', title: 'Helper', icon: 'auto' }).key, 'robot');
});

test('a legacy glyph is passed through and the key stays automatic', () => {
  assert.deepEqual(iconFor({ name: 'writer', title: 'Writer', icon: '✎' }), { key: 'write', color: '#eab308', glyph: '✎' });
  assert.equal(iconFor({ name: 'writer', icon: 'Hi there' }).glyph, 'Hi there');
});

test('colour: a stored value wins, otherwise the name hash picks the palette entry', () => {
  assert.equal(iconFor({ name: 'db', color: '#abc' }).color, '#abc');
  assert.equal(iconFor({ name: 'db', color: 'red' }).color, '#84cc16');
  assert.equal(iconFor({ name: 'db', title: 'One' }).color, iconFor({ name: 'db', title: 'Two' }).color);
});

test('test vectors', () => {
  const vectors = [
    ['db', 'db', 'auto', 'database', null, '571cc6c3', '#84cc16'],
    ['reviewer', 'Reviewer', '◆', 'review', null, '3178ca1a', '#06b6d4'],
    ['writer', 'Writer', '✎', 'write', '✎', '84cc956a', '#eab308'],
    ['code-review', 'Code review', undefined, 'review', null, '7ba86b63', '#64748b'],
    ['a', 'Release notes', 'auto', 'deploy', null, 'e40c292c', '#ef4444']
  ];
  for (const [name, title, icon, key, glyph, hash, color] of vectors) {
    assert.equal(fnv1a32(name).toString(16).padStart(8, '0'), hash, name);
    assert.deepEqual(iconFor({ name, title, icon }), { key, color, glyph }, name);
  }
});
