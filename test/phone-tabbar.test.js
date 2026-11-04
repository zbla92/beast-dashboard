const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const app = read('app.js'), css = read('style.css'), pinCss = read('f-pin.css'), inboxCss = read('f-inbox.css'), inboxJs = read('f-inbox.js');
const markTabSrc = app.slice(app.indexOf('function markTab'), app.indexOf("for (const b of document.querySelectorAll('#tabbar .tb')) b.onclick"));
const tabHandler = app.slice(app.indexOf("for (const b of document.querySelectorAll('#tabbar .tb')) b.onclick"), app.indexOf("$('#btn-shell').onclick"));

const marked = (term, view, inbox = false) => {
  const tabs = [{ dataset: { view: 'home' } }, { dataset: { act: 'inbox' } }, { dataset: { act: 'sessions' } }, { dataset: { view: 'code' } }, { dataset: { view: 'tasks' } }];
  const on = new Set();
  for (const t of tabs) t.classList = { toggle: (_, yes) => { if (yes) on.add(t.dataset.view || t.dataset.act); } };
  const ctx = vm.createContext({ TERM: term, UI: { view }, document: { querySelectorAll: () => tabs, body: { classList: { contains: c => inbox && c === 'ibx-open' } } } });
  vm.runInContext(markTabSrc + ';markTab();', ctx);
  return [...on];
};

test('Sessions is the active tab only while the session list shows', () => {
  assert.deepStrictEqual(marked({ open: true, showList: true }, 'code'), ['sessions']);
  assert.deepStrictEqual(marked({ open: true, showList: false }, 'code'), ['code']);
  assert.deepStrictEqual(marked({ open: false, showList: true }, 'code'), ['code']);
});

test('Inbox is the active tab while it is open, also over the session list', () => {
  assert.deepStrictEqual(marked({ open: false, showList: false }, 'home', true), ['inbox']);
  assert.deepStrictEqual(marked({ open: true, showList: true }, 'code', true), ['inbox']);
});

test('the tab bar stays over the session list and stays hidden inside a chat', () => {
  assert.match(css, /body\.term-open:not\(\.sess-list\):not\(\.ibx-open\) \.tabbar \{ display: none; \}/);
  assert.match(css, /body\.sess-list \.tabbar \{ z-index: 46; \}/);
  assert.doesNotMatch(css, /body\.term-open \.tabbar/);
});

test('the session list ends above the tab bar', () => {
  assert.match(css, /\.termpanel\.showlist \.termside \{[^}]*inset: 0 0 calc\(var\(--tab-h\) \+ env\(safe-area-inset-bottom\)\) 0;/);
});

test('a page tab leaves the session list', () => {
  assert.match(tabHandler, /if \(TERM\.open\) closeTermPanel\(false\);/);
});

test('the session list head has no Dashboard button', () => {
  const head = app.slice(app.indexOf("h('div', { class: 'termside-head' }"), app.indexOf("h('div', { id: 'term-list' })"));
  assert.doesNotMatch(head, /Dashboard|closeTermPanel|setFocus/);
  assert.match(head, /'Sessions'/);
});

test('the Inbox keeps the tab bar, without its close button, and gives way to the keyboard', () => {
  assert.match(inboxCss, /body\.ibx-open \.tabbar \{ display: grid; z-index: 81; background: var\(--bg2\); \}/);
  assert.match(inboxCss, /body\.ibx-open #modal \{ bottom: calc\(var\(--tab-h\) \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.match(inboxCss, /body\.ibx-open\.ibx-kb \.tabbar \{ display: none; \}/);
  assert.match(inboxJs, /class: 'box ibx', onmousedown: e => \{ if \(e\.target\.closest\('button'\)\) e\.preventDefault\(\); \}/);
  assert.match(app, /classList\.toggle\('ibx-kb', keyboardUp\(/);
  assert.match(inboxCss, /\.box\.ibx \.sh \.btn\.icon \{ display: none; \}/);
});

test('another tab closes the Inbox, and the Inbox tab keeps it open', () => {
  assert.match(tabHandler, /if \(b\.dataset\.act === 'inbox'\) \{ FEAT\.inbox\?\.open\?\.\(\); return; \}\n  FEAT\.inbox\?\.close\?\.\(\);/);
  assert.match(inboxJs, /open: openInbox,\n    close,/);
});

test('the pinned question hides while the phone keyboard is open', () => {
  assert.match(pinCss, /body\.kb-open \.qpin \{ display: none; \}/);
});
