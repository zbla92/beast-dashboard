'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-auth.js'), 'utf8');

const node = (tag, attrs, kids) => {
  const n = { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k != null && k !== false), nodeType: 1, value: '', hidden: !!(attrs && attrs.hidden), dataset: {}, listeners: {} };
  n.className = (attrs && attrs.class) || '';
  n.replaceChildren = (...k) => { n.kids = k.flat(Infinity); n.firstChild = n.kids[0]; };
  n.append = (...k) => { n.kids.push(...k); };
  n.addEventListener = (ev, fn) => { n.listeners[ev] = fn; };
  n.focus = () => {};
  Object.defineProperty(n, 'children', { get: () => n.kids });
  n.remove = () => {};
  n.select = () => {};
  return n;
};
const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n == null ? '' : (n.kids || []).map(text).join(' ');
const find = (n, pred, out = []) => { if (n && typeof n === 'object') { if (pred(n)) out.push(n); (n.kids || []).forEach(k => find(k, pred, out)); } return out; };
const plain = v => JSON.parse(JSON.stringify(v));
const byClass = (root, c) => find(root, n => (n.attrs && n.attrs.class || '').split(' ').includes(c))[0];

const login = (o = {}) => ({ id: 'L1', state: 'waiting', url: 'https://claude.ai/oauth/authorize?x=1', startedAt: Date.now(), endsAt: Date.now() + 600000, message: null, ...o });
const rec = (o = {}) => ({ loggedIn: false, expiresAt: null, checkedAt: 1, failed: null, needsLogin: true, retry: [], login: null, ...o });

const build = (auth, extra = {}) => {
  const calls = [];
  const modal = node('div', {}, []);
  modal.classList = { add() { modal.hiddenCls = true; }, remove() { modal.hiddenCls = false; }, contains: () => !!modal.hiddenCls };
  const top = { parentElement: null, inserted: [], querySelector: () => null, insertBefore(el) { top.inserted.push(el); el.parentElement = top; } };
  const intervals = [];
  const sandbox = {
    FEAT: {}, URL, calls, modal, top, intervals, toasts: [], boxes: [],
    h: (tag, attrs, ...kids) => node(tag, attrs, kids),
    ico: n => ({ nodeType: 1, tag: 'svg', attrs: { n }, kids: [] }),
    $: () => modal,
    S: { claude: { auth } }, IS_PHONE: false,
    acct: a => ({ personal: 'Personal', company: 'Work' })[a] || a,
    claudeOf: n => sandbox.sessions[n] || null, sessions: {},
    api: async (p, body) => { calls.push([p, body]); return sandbox.reply ? sandbox.reply(p, body) : { ok: true }; },
    toast: (m, k) => sandbox.toasts.push([m, k]),
    document: { querySelector: s => s === '.top' ? top : null, querySelectorAll: s => s === '[data-chat]' ? sandbox.boxes : [], body: node('body', {}, []), execCommand: () => true },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {}, setTimeout, clearTimeout,
    navigator: { clipboard: { writeText: async () => {}, readText: async () => '' } },
  };
  Object.assign(sandbox, extra);
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
};

test('the header button shows only for an account that needs a login or has a live login', () => {
  const sb = build({ personal: rec({ needsLogin: false, loggedIn: true }), company: rec() });
  sb.FEAT.auth.onState();
  assert.deepStrictEqual(plain(sb.FEAT.auth.buttons().map(text)), ['Authenticate (Work)']);
  sb.S.claude.auth.company = rec({ needsLogin: false, login: login({ state: 'ok' }) });
  sb.FEAT.auth.onState();
  assert.strictEqual(sb.FEAT.auth.buttons().length, 0);
  sb.S.claude.auth.personal = rec({ needsLogin: false, loggedIn: true, login: login() });
  sb.FEAT.auth.onState();
  assert.deepStrictEqual(plain(sb.FEAT.auth.buttons().map(text)), ['Authenticate (Personal)']);
});

test('the sheet for a waiting login has the link, copy, code field and submit, and does not start a new login', () => {
  const sb = build({ company: rec({ login: login() }) });
  sb.FEAT.auth.open('company');
  const box = sb.modal.firstChild;
  assert.deepStrictEqual(plain(sb.calls), []);
  const link = byClass(box, 'au-open');
  assert.strictEqual(link.hidden, false);
  assert.strictEqual(link.href, 'https://claude.ai/oauth/authorize?x=1');
  assert.strictEqual(link.attrs.target, '_blank');
  assert.strictEqual(link.attrs.rel, 'noopener noreferrer');
  assert.strictEqual(byClass(box, 'au-copy').hidden, false);
  const input = byClass(box, 'au-code');
  for (const [k, v] of Object.entries({ autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', placeholder: 'code#state' })) assert.strictEqual(input.attrs[k], v);
  assert.strictEqual(byClass(box, 'au-state').textContent, 'Waiting for the code');
  assert.match(byClass(box, 'au-count').textContent, /^expires in \d+:\d\d$/);
  assert.ok(byClass(box, 'au-paste'));
  assert.strictEqual(byClass(box, 'au-submit').disabled, true);
  input.value = 'abcdefgh#state';
  input.listeners.input();
  assert.strictEqual(byClass(box, 'au-submit').disabled, false);
});

test('the paste button is left out where the clipboard cannot be read', () => {
  const sb = build({ company: rec({ login: login() }) }, { navigator: {} });
  sb.FEAT.auth.open('company');
  assert.strictEqual(byClass(sb.modal.firstChild, 'au-paste'), undefined);
});

test('submit posts account, id and the trimmed code once, and clears the field', async () => {
  const sb = build({ company: rec({ login: login() }) });
  sb.FEAT.auth.open('company');
  const box = sb.modal.firstChild, input = byClass(box, 'au-code'), submit = byClass(box, 'au-submit');
  input.value = '  abcdefgh#state ';
  input.listeners.input();
  const a = submit.attrs.onclick(), b = submit.attrs.onclick();
  await Promise.all([a, b]);
  assert.deepStrictEqual(plain(sb.calls), [['auth/code', { account: 'company', id: 'L1', code: 'abcdefgh#state' }]]);
  assert.strictEqual(input.value, '');
  assert.strictEqual(byClass(box, 'au-state').textContent, 'Checking the code…');
});

test('an expired login says so and offers Start again, which posts start', async () => {
  const sb = build({ personal: rec({ login: login() }) });
  sb.FEAT.auth.open('personal');
  const box = sb.modal.firstChild;
  sb.S.claude.auth.personal.login = login({ state: 'expired', message: 'Login expired, start again' });
  sb.FEAT.auth.onState();
  assert.deepStrictEqual(plain(sb.calls), []);
  assert.strictEqual(byClass(box, 'au-state').textContent, 'Login expired, start again');
  assert.strictEqual(byClass(box, 'au-again').hidden, false);
  await byClass(box, 'au-again').attrs.onclick();
  assert.deepStrictEqual(plain(sb.calls), [['auth/start', { account: 'personal' }]]);
});

test('opening without a running login starts one', async () => {
  const sb = build({ personal: rec() });
  sb.reply = () => ({ ok: true, login: login({ state: 'starting', url: null }) });
  sb.FEAT.auth.open('personal');
  assert.deepStrictEqual(plain(sb.calls), [['auth/start', { account: 'personal' }]]);
  assert.strictEqual(byClass(sb.modal.firstChild, 'au-state').textContent, 'Starting the login…');
});

test('an error login shows the server message', () => {
  const sb = build({ personal: rec({ login: login({ state: 'error', message: 'Login failed: invalid code' }) }) });
  sb.FEAT.auth.open('personal');
  assert.strictEqual(byClass(sb.modal.firstChild, 'au-state').textContent, 'Login failed: invalid code');
});

test('the chat banner asks to authenticate, then offers Retry and dismiss', async () => {
  const sb = build({ company: rec() });
  sb.sessions['claude-a'] = { mode: 'chat', account: 'company' };
  const placed = { el: null };
  const box = { dataset: { chat: 'claude-a' }, querySelector: s => s === ':scope > .cscroll' ? { scrollHeight: 1, scrollTop: 1, clientHeight: 1, after: el => { placed.el = el; } } : placed.el };
  sb.FEAT.auth.composerShown(box);
  assert.match(text(placed.el), /Work login expired\s+Authenticate/);

  sb.S.claude.auth.company = rec({ needsLogin: false, loggedIn: true, retry: ['claude-a'] });
  placed.el = null;
  box.querySelector = s => s === ':scope > .cscroll' ? { scrollHeight: 1, scrollTop: 1, clientHeight: 1, after: el => { placed.el = el; } } : null;
  sb.FEAT.auth.composerShown(box);
  assert.match(text(placed.el), /Signed in again\s+Retry/);
  const [retry, dismiss] = find(placed.el, n => n.tag === 'button');
  await retry.attrs.onclick();
  await dismiss.attrs.onclick();
  assert.deepStrictEqual(plain(sb.calls), [['auth/retry', { session: 'claude-a' }], ['auth/retry', { session: 'claude-a', dismiss: true }]]);
});

test('no banner for a healthy account or a terminal session', () => {
  const sb = build({ personal: rec({ needsLogin: false }), company: rec() });
  sb.sessions['claude-a'] = { mode: 'chat', account: 'personal' };
  sb.sessions['claude-t'] = { mode: 'terminal', account: 'company' };
  const placed = { el: null };
  const mk = n => ({ dataset: { chat: n }, querySelector: s => s === ':scope > .cscroll' ? { scrollHeight: 1, scrollTop: 1, clientHeight: 1, after: el => { placed.el = el; } } : null });
  sb.FEAT.auth.composerShown(mk('claude-a'));
  sb.FEAT.auth.composerShown(mk('claude-t'));
  assert.strictEqual(placed.el, null);
});

test('a login that ended in error or expired keeps no header button, and the sheet offers Cancel that clears it', async () => {
  for (const state of ['error', 'expired']) {
    const sb = build({ personal: rec({ needsLogin: false, loggedIn: true, login: login() }) });
    sb.FEAT.auth.open('personal');
    sb.S.claude.auth.personal.login = login({ state, message: 'Login failed: x' });
    sb.FEAT.auth.onState();
    assert.strictEqual(sb.FEAT.auth.buttons().length, 0, state);
    const cancel = byClass(sb.modal.firstChild, 'au-cancel');
    assert.strictEqual(cancel.hidden, false, state);
    await cancel.attrs.onclick();
    assert.deepStrictEqual(plain(sb.calls), [['auth/cancel', { account: 'personal' }]]);
  }
  for (const state of ['starting', 'checking']) {
    const sb = build({ personal: rec({ needsLogin: false, loggedIn: true, login: login({ state }) }) });
    sb.FEAT.auth.onState();
    assert.strictEqual(sb.FEAT.auth.buttons().length, 1, state);
  }
});

test('the sign-in link is used only for an https oauth/authorize url on a Claude or Anthropic host', () => {
  const ok = ['https://claude.ai/oauth/authorize?x=1', 'https://claude.com/cai/oauth/authorize?code=true', 'https://console.anthropic.com/oauth/authorize?a=b'];
  const bad = ['http://claude.ai/oauth/authorize?x=1', 'https://evil.example/oauth/authorize?x=1', 'https://claude.ai.evil.example/oauth/authorize?x=1', 'https://notclaude.ai/oauth/authorize?x=1', 'https://claude.ai/login?next=/oauth/authorize?x', 'https://claude.ai@evil.example/oauth/authorize?x=1', 'https://claude.ai:8443/oauth/authorize?x=1', 'javascript:alert(1)//oauth/authorize?', 'https://claude.ai/oauth/authorize'];
  for (const url of [...ok, ...bad]) {
    const sb = build({ personal: rec({ login: login({ url }) }) });
    sb.FEAT.auth.open('personal');
    const link = byClass(sb.modal.firstChild, 'au-open');
    assert.strictEqual(link.hidden, !ok.includes(url), url);
    assert.strictEqual(byClass(sb.modal.firstChild, 'au-copy').hidden, !ok.includes(url), url);
  }
});

test('no login banner in an API-key provider chat', () => {
  const sb = build({ personal: rec() });
  sb.sessions['claude-x'] = { mode: 'chat', account: 'personal', apiProvider: 'openai' };
  const placed = { el: null };
  sb.FEAT.auth.composerShown({ dataset: { chat: 'claude-x' }, querySelector: s => s === ':scope > .cscroll' ? { scrollHeight: 1, scrollTop: 1, clientHeight: 1, after: el => { placed.el = el; } } : null });
  assert.strictEqual(placed.el, null);
});
