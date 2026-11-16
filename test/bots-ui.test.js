const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

const node = (tag, attrs, kids) => {
  const n = { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k != null && k !== false), classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
  n.replaceChildren = (...k) => { if (k.some(x => x == null || x === false)) throw new Error('replaceChildren got ' + k.find(x => x == null || x === false)); n.kids = k.flat(Infinity).filter(x => x != null && x !== false); };
  n.focus = () => {};
  if (tag === 'input') n.value = '';
  return n;
};
const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n == null ? '' : (n.kids || []).map(text).join(' ');
const walk = (n, fn) => { if (n && typeof n === 'object') { fn(n); (n.kids || []).forEach(k => walk(k, fn)); } };
const find = (n, pred) => { const out = []; walk(n, x => { if (pred(x)) out.push(x); }); return out; };
const cls = (n, c) => new RegExp('(^| )' + c + '( |$)').test(n.attrs.class || '');

const build = (list, extra = {}) => {
  const els = { '#bots': node('main', {}, []), '#bots-count': node('span', {}, []), '#modal': node('div', {}, []) };
  const sandbox = {
    FEAT: {}, calls: [], els, opened: null, toasts: [],
    h: (tag, attrs, ...kids) => node(tag, attrs, kids),
    ico: n => ({ tag: 'svg', attrs: { n }, kids: [] }),
    $: s => els[s],
    UI: { view: 'bots' }, S: { runtime: { sessions: [] } }, IS_PHONE: true, window: {},
    plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`,
    api: async (p, body) => {
      sandbox.calls.push([p, body]);
      if (p === 'specialists') return { ok: true, specialists: list };
      if (p === 'specialist') return { ok: true, specialist: { name: body.name } };
      return { ok: true, thread: { tmux: 'claude-spec-' + p.split('/')[1] } };
    },
    toast: (m, k) => sandbox.toasts.push([m, k]), openTerm(n) { sandbox.opened = n; },
    document: { hidden: true }, setInterval: () => 0,
  };
  Object.assign(sandbox, extra);
  vm.createContext(sandbox);
  vm.runInContext(read('f-bots.js'), sandbox);
  return sandbox;
};

const B = (name, o = {}) => ({ name, title: name, description: 'does ' + name, active: 0, recentCalls: [], thread: null, iconColor: '#4f7cff', iconGlyph: null, ...o });
const settle = () => new Promise(r => setImmediate(r));
const botCards = sb => find(sb.els['#bots'], n => cls(n, 'bt-card') && !cls(n, 'bt-new'));

test('cards are sorted by name and the count follows the list', async () => {
  const sb = build([B('writer'), B('db'), B('editor')]);
  await settle();
  assert.deepStrictEqual(botCards(sb).map(c => text(find(c, n => cls(n, 'bt-nm'))[0])), ['db', 'editor', 'writer']);
  assert.strictEqual(find(sb.els['#bots'], n => cls(n, 'bt-new')).length, 1);
  assert.strictEqual(sb.els['#bots-count'].textContent, 3);
  assert.strictEqual(sb.FEAT.bots.all().length, 3);
});

test('open calls and the state dot show on the card', async () => {
  const sb = build([B('a', { active: 2, thread: { state: 'working' } }), B('b', { recentCalls: [{ state: 'waiting' }] }), B('c'), { name: 'd', error: 'bad json' }]);
  await settle();
  const cards = botCards(sb);
  assert.match(text(cards[0]), /2 open calls/);
  assert.match(text(cards[2]), /no open calls/);
  assert.deepStrictEqual(cards.map(c => find(c, n => cls(n, 'bt-dot'))[0].attrs.class), ['bt-dot st-working', 'bt-dot st-waiting', 'bt-dot st-idle', 'bt-dot st-error']);
});

test('the fallback tile uses the glyph or the first letter, coloured from iconColor', async () => {
  const sb = build([B('mailer', { iconGlyph: '@', iconColor: '#ff0000' }), B('zed')]);
  await settle();
  const tiles = find(sb.els['#bots'], n => cls(n, 'bt-tile') && !cls(n, 'bt-plus'));
  assert.strictEqual(text(tiles[0]), '@');
  assert.match(tiles[0].attrs.style, /#ff0000/);
  assert.strictEqual(text(tiles[1]), 'Z');
});

test('BOT_ICON.tile is used when present', async () => {
  const mark = { tag: 'span', attrs: { class: 'mine' }, kids: [] };
  const sb = build([B('a')], { window: { BOT_ICON: { tile: () => mark } } });
  await settle();
  assert.strictEqual(find(sb.els['#bots'], n => n === mark).length, 1);
});

test('openChat posts to the chat endpoint and opens the thread session', async () => {
  const sb = build([B('db')]);
  await sb.FEAT.bots.openChat('db');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.calls.at(-1))), ['specialist/db/chat', {}]);
  assert.strictEqual(sb.opened, 'claude-spec-db');
});

test('create sends only what the user set and then opens the chat', async () => {
  const sb = build([]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.FEAT.bots.createBody({ name: ' My Bot ', description: ' x ', model: '', account: 'personal', use: 'skill', permissionMode: 'bypassPermissions' }))), { name: 'my-bot', template: 'blank', description: 'x' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.FEAT.bots.createBody({ name: 'a', description: '', model: 'opus', account: 'company', use: 'both', permissionMode: 'plan' }))), { name: 'a', template: 'blank', model: 'opus', account: 'company', use: 'both', permissionMode: 'plan' });
  sb.FEAT.bots.create();
  const box = sb.els['#modal'].kids[0];
  const inputs = find(box, n => n.tag === 'input');
  const go = find(box, n => cls(n, 'ns-send'))[0];
  assert.strictEqual(go.disabled, true);
  inputs[0].value = 'writer'; inputs[0].oninput(); inputs[1].value = 'drafts';
  assert.strictEqual(go.disabled, false);
  await go.onclick(); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.calls.find(c => c[0] === 'specialist'))), ['specialist', { name: 'writer', template: 'blank', description: 'drafts' }]);
  assert.strictEqual(sb.opened, 'claude-spec-writer');
});

test('a refused send removes its local echo from the transcript', () => {
  const appSrc = read('app.js');
  assert.match(appSrc, /conv\.append\(echo\)/);
  assert.match(appSrc, /catch \(e\) \{ toast\(e\.message, 'err'\); echo\.remove\(\);/);
});
