const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { KEYS } = require('../lib/bot-icons');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

const el = tag => {
  const n = { tag, attrs: {}, kids: [], style: { setProperty() {} }, className: '', textContent: '', innerHTML: '', nodeType: 1 };
  n.classList = { list: new Set(), add(c) { this.list.add(c); }, remove(c) { this.list.delete(c); }, contains(c) { return this.list.has(c); } };
  n.setAttribute = (k, v) => { n.attrs[k] = String(v); };
  n.append = (...k) => { n.kids.push(...k); };
  return n;
};

const node = (tag, attrs, kids) => {
  const n = el(tag);
  n.attrs = attrs || {};
  n.kids = kids.flat(Infinity).filter(k => k != null && k !== false);
  n.querySelector = () => null;
  n.querySelectorAll = () => [];
  n.addEventListener = () => {};
  n.focus = () => {};
  n.contains = () => false;
  return n;
};
const walk = (n, fn) => { if (n && typeof n === 'object') { fn(n); (n.kids || []).forEach(k => walk(k, fn)); } };
const find = (n, pred) => { const out = []; walk(n, x => { if (pred(x)) out.push(x); }); return out; };
const text = n => typeof n === 'string' ? n : n && n.kids ? n.kids.map(text).join(' ') : '';

const build = (store = {}) => {
  const modal = el('div');
  modal.classList.add('hidden');
  modal.replaceChildren = (...k) => { modal.kids = k; };
  const listeners = [];
  const sandbox = {
    FEAT: {}, modal, listeners,
    h: (tag, attrs, ...kids) => node(tag, attrs, kids),
    $: () => modal,
    document: {
      createElementNS: (_, tag) => el(tag), createElement: tag => el(tag),
      addEventListener: (t, f) => listeners.push([t, f]),
      removeEventListener: (t, f) => { const i = listeners.findIndex(l => l[1] === f); if (i >= 0) listeners.splice(i, 1); },
      activeElement: null
    },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    store
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('bot-icons.js'), sandbox);
  vm.runInContext(read('f-bots-intro.js'), sandbox);
  return sandbox;
};

const press = (sb, key) => sb.listeners.filter(l => l[0] === 'keydown').forEach(l => l[1]({ key, target: { tagName: 'BODY' }, preventDefault() {}, stopPropagation() {} }));
const nextButton = sb => find(sb.modal, n => /bi-next/.test(n.attrs.class || ''))[0];

test('every icon key from the server table has a drawing, in the same order', () => {
  const sb = build();
  assert.deepStrictEqual([...sb.BOT_ICON.keys], KEYS);
  for (const k of KEYS) {
    const s = sb.BOT_ICON.svg(k, 16);
    assert.ok(s.innerHTML.length > 20, k);
    assert.strictEqual(s.attrs.width, '16');
    assert.strictEqual(s.attrs['stroke-width'], '1.6');
    assert.strictEqual(s.attrs.viewBox, '0 0 24 24');
  }
});

test('an unknown key draws the robot', () => {
  const sb = build();
  assert.strictEqual(sb.BOT_ICON.svg('nope', 24).innerHTML, sb.BOT_ICON.svg('robot', 24).innerHTML);
  assert.strictEqual(sb.BOT_ICON.svg(undefined, 24).innerHTML, sb.BOT_ICON.svg('robot', 24).innerHTML);
});

test('a tile draws the key on the bot colour and is labelled with the name', () => {
  const sb = build();
  const t = sb.BOT_ICON.tile({ name: 'db', iconKey: 'database', iconColor: '#84cc16', iconGlyph: null }, 48);
  assert.strictEqual(t.attrs['aria-label'], 'db');
  assert.strictEqual(t.style.width, '48px');
  assert.ok(t.style.background.includes('#84cc16'));
  assert.strictEqual(t.kids.length, 1);
  assert.strictEqual(t.kids[0].innerHTML, sb.BOT_ICON.svg('database', 1).innerHTML);
});

test('a single-character glyph is shown as text and longer text is not', () => {
  const sb = build();
  const g = sb.BOT_ICON.tile({ name: 'writer', iconKey: 'write', iconColor: '#eab308', iconGlyph: '✎' }, 32);
  assert.strictEqual(g.textContent, '✎');
  assert.strictEqual(g.kids.length, 0);
  const long = sb.BOT_ICON.tile({ name: 'writer', iconKey: 'write', iconColor: '#eab308', iconGlyph: 'Ab' }, 32);
  assert.strictEqual(long.kids.length, 1);
});

test('a tile without data still renders the robot on a neutral colour', () => {
  const sb = build();
  const t = sb.BOT_ICON.tile({ name: 'x', iconColor: 'red' }, 32);
  assert.ok(t.style.background.includes('#64748b'));
  assert.strictEqual(t.kids[0].innerHTML, sb.BOT_ICON.svg('robot', 1).innerHTML);
});

test('maybeOpen opens only when the stored version is missing, not an integer or lower than 1', () => {
  for (const [value, opens] of [[undefined, true], ['', true], ['abc', true], ['1.5', true], ['0', true], ['-1', true], ['1', false], ['2', false]]) {
    const sb = build(value === undefined ? {} : { 'bd.bots.intro': value });
    assert.strictEqual(sb.FEAT.botsIntro.maybeOpen(), opens, String(value));
    assert.strictEqual(sb.modal.classList.contains('hidden'), !opens, String(value));
  }
});

test('maybeOpen does not replace a dialog that is already open', () => {
  const sb = build();
  sb.modal.classList.remove('hidden');
  assert.strictEqual(sb.FEAT.botsIntro.maybeOpen(), false);
  assert.strictEqual(sb.modal.kids.length, 0);
});

test('open ignores the stored version and shows four steps', () => {
  const sb = build({ 'bd.bots.intro': '1' });
  sb.FEAT.botsIntro.open();
  assert.strictEqual(sb.modal.classList.contains('hidden'), false);
  assert.strictEqual(find(sb.modal, n => /(^| )bi-dot( |$)/.test(n.attrs.class || '')).length, 4);
  assert.ok(find(sb.modal, n => /bot-tile/.test(n.className)).length >= 1);
});

test('walking to Done stores version 1, closes and removes the key handler', () => {
  const sb = build();
  sb.FEAT.botsIntro.maybeOpen();
  press(sb, 'ArrowRight');
  assert.ok(text(sb.modal).includes('Passwords and keys'));
  press(sb, 'ArrowLeft');
  assert.ok(text(sb.modal).includes('own chat'));
  nextButton(sb).attrs.onclick();
  nextButton(sb).attrs.onclick();
  nextButton(sb).attrs.onclick();
  assert.strictEqual(nextButton(sb).kids[0], 'Done');
  assert.strictEqual(sb.store['bd.bots.intro'], undefined);
  nextButton(sb).attrs.onclick();
  assert.strictEqual(sb.store['bd.bots.intro'], '1');
  assert.strictEqual(sb.modal.classList.contains('hidden'), true);
  assert.strictEqual(sb.listeners.filter(l => l[0] === 'keydown').length, 0);
});

test('Escape closes and stores the current version', () => {
  const sb = build({ 'bd.bots.intro': '0' });
  sb.FEAT.botsIntro.maybeOpen();
  press(sb, 'Escape');
  assert.strictEqual(sb.store['bd.bots.intro'], '1');
  assert.strictEqual(sb.modal.classList.contains('hidden'), true);
});
