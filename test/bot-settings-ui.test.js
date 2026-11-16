const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-bot-settings.js'), 'utf8');

const node = (tag, attrs, kids) => {
  const n = { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k != null && k !== false), nodeType: 1, hiddenSet: new Set() };
  n.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  n.querySelector = () => null;
  n.replaceChildren = (...k) => { if (k.some(x => x == null || x === false)) throw new Error('replaceChildren got ' + k.find(x => x == null || x === false)); n.kids = k.flat(Infinity).filter(x => x != null && x !== false); };
  n.append = (...k) => { n.kids.push(...k); };
  n.setAttribute = () => {};
  n.focus = () => {};
  if (n.attrs.value !== undefined) n.value = n.attrs.value;
  else if (tag === 'input' || tag === 'textarea') n.value = '';
  return n;
};
const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n == null ? '' : (n.kids || []).map(text).join(' ');
const walk = (n, fn) => { if (n && typeof n === 'object') { fn(n); (n.kids || []).forEach(k => walk(k, fn)); } };
const find = (n, pred) => { const out = []; walk(n, x => { if (pred(x)) out.push(x); }); return out; };
const section = (box, id) => find(box, n => n.attrs['data-section'] === id && n.attrs.role === 'tabpanel')[0];
const buttonByText = (root, label) => find(root, n => n.tag === 'button' && text(n).trim() === label)[0];
const press = n => (n.onclick || n.attrs.onclick)();
const settle = async () => { for (const _ of Array(8)) await new Promise(r => setImmediate(r)); };

const profile = (o = {}) => ({ name: 'db', title: 'Db', description: 'reads the db', icon: 'auto', color: null, provider: 'claude', model: 'sonnet', effort: null, account: 'personal', permissionMode: 'dontAsk', use: 'skill', updatedAt: 'T1', instructions: 'be brief', iconKey: 'database', iconGlyph: null, iconColor: '#123456', ...o });

const build = (p, extra = {}) => {
  const calls = [];
  const modal = node('div', {}, []);
  const sandbox = {
    FEAT: {}, calls, modal, toasts: [], shown: null, TERM: {}, closeTermPanel() {},
    h: (tag, attrs, ...kids) => node(tag, attrs, kids),
    ico: n => ({ nodeType: 1, tag: 'svg', attrs: { n }, kids: [] }),
    $: () => modal, acct: a => a, window: {},
    toast(m, k) { sandbox.toasts.push([m, k]); },
    document: { addEventListener() {}, removeEventListener() {} },
    api: async (path, body) => {
      calls.push([path, body]);
      if (path === 'specialists') return { ok: true, iconKeys: ['database', 'chat', 'mail'], palette: ['#4f7cff', '#64748b'] };
      if (path === 'specialist/db') return { ok: true, specialist: p };
      if (path === 'specialist/db/accesses' && !body) return { ok: true, usedByRuns: true, accesses: [{ name: 'DB_URL', note: 'replica', bytes: 12, updatedAt: 'x' }] };
      if (path.startsWith('specialist/db/train/history')) return { ok: true, more: false, commits: [
        { id: 'a'.repeat(40), short: 'aaaaaaa', message: 'Use the replica', source: 'chat', at: 1762850040000, undone: false, files: [{ path: 'knowledge/replica.md', change: 'added' }] },
        { id: 'b'.repeat(40), short: 'bbbbbbb', message: 'Starting point', source: 'start', at: 1762850000000, undone: false, files: [] },
        { id: 'c'.repeat(40), short: 'ccccccc', message: 'Dashboard preamble', source: 'preamble', at: 1762850001000, undone: false, files: [] }] };
      return { ok: true };
    },
  };
  modal.replaceChildren = (...k) => { sandbox.shown = k[0]; };
  Object.assign(sandbox, extra);
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
};

const opened = async (p, sec, extra) => {
  const sb = build(p, extra);
  await sb.FEAT.botSettings.open('db', sec);
  await settle();
  return sb;
};
const posts = sb => JSON.parse(JSON.stringify(sb.calls.filter(([, b]) => b)));
const updates = sb => posts(sb).filter(([p]) => p === 'specialist/db');

test('credential values are never rendered or prefilled and the list shows names and notes only', async () => {
  const sb = await opened(profile(), 'credentials');
  const pane = section(sb.shown, 'credentials');
  const inputs = find(pane, n => n.tag === 'input');
  const value = inputs.find(n => n.attrs.type === 'password');
  assert.ok(value);
  assert.strictEqual(value.value, '');
  assert.strictEqual(value.attrs.value, undefined);
  assert.match(text(pane), /DB_URL/);
  assert.match(text(pane), /replica/);
  assert.match(text(pane), /stay on this machine/);
  assert.match(text(pane), /never committed/);
  assert.ok(!JSON.stringify(sb.shown, (k, v) => typeof v === 'function' ? undefined : v).includes('"value":"s3cret'));
});

test('replace prefills the name and note but never the value', async () => {
  const sb = await opened(profile(), 'credentials');
  const pane = section(sb.shown, 'credentials');
  const inputs = find(pane, n => n.tag === 'input');
  press(buttonByText(pane, 'Replace'));
  assert.strictEqual(inputs[0].value, 'DB_URL');
  assert.strictEqual(inputs[2].value, 'replica');
  assert.strictEqual(inputs[1].value, '');
});

test('saving a credential posts it and clears the value input', async () => {
  const sb = await opened(profile(), 'credentials');
  const pane = section(sb.shown, 'credentials');
  const [name, value, note] = find(pane, n => n.tag === 'input');
  name.value = 'API_KEY'; value.value = 's3cret-value-1'; note.value = 'main';
  press(buttonByText(pane, 'Save'));
  await settle();
  assert.deepStrictEqual(posts(sb).find(([p]) => p === 'specialist/db/accesses'), ['specialist/db/accesses', { name: 'API_KEY', value: 's3cret-value-1', note: 'main' }]);
  assert.strictEqual(value.value, '');
  assert.strictEqual(name.value, '');
  assert.strictEqual(note.value, '');
});

test('a bad credential name or empty value is refused before any request', async () => {
  const sb = await opened(profile(), 'credentials');
  const pane = section(sb.shown, 'credentials');
  const [name, value] = find(pane, n => n.tag === 'input');
  name.value = 'bad name'; value.value = 'x';
  press(buttonByText(pane, 'Save'));
  await settle();
  assert.strictEqual(posts(sb).length, 0);
});

test('removing a credential asks first and posts the delete', async () => {
  const sb = await opened(profile(), 'credentials');
  const pane = section(sb.shown, 'credentials');
  press(buttonByText(pane, 'Remove'));
  press(buttonByText(pane, 'Remove'));
  await settle();
  assert.ok(posts(sb).some(([p]) => p === 'specialist/db/accesses/DB_URL/delete'));
});

test('About sends only the changed fields with ifUpdatedAt', async () => {
  const sb = await opened(profile(), 'about');
  const pane = section(sb.shown, 'about');
  const [, title] = find(pane, n => n.tag === 'input');
  title.value = 'Database';
  press(buttonByText(pane, 'Save'));
  await settle();
  assert.deepStrictEqual(updates(sb)[0], ['specialist/db', { title: 'Database', ifUpdatedAt: 'T1' }]);
});

test('picking an icon sends its key and Auto sends auto; a swatch sends its colour and Auto clears it', async () => {
  const sb = await opened(profile({ icon: 'chat', color: '#4f7cff' }), 'about');
  const pane = section(sb.shown, 'about');
  press(find(pane, n => n.attrs['data-icon'] === 'mail')[0]);
  press(find(pane, n => n.attrs['data-color'] === '#64748b')[0]);
  press(buttonByText(pane, 'Save'));
  await settle();
  assert.deepStrictEqual(updates(sb)[0][1], { icon: 'mail', color: '#64748b', ifUpdatedAt: 'T1' });
  const sb2 = await opened(profile({ icon: 'chat', color: '#4f7cff' }), 'about');
  const pane2 = section(sb2.shown, 'about');
  press(find(pane2, n => n.attrs['data-icon'] === 'auto')[0]);
  press(find(pane2, n => n.attrs['data-color'] === 'auto')[0]);
  press(buttonByText(pane2, 'Save'));
  await settle();
  assert.deepStrictEqual(updates(sb2)[0][1], { icon: 'auto', color: null, ifUpdatedAt: 'T1' });
});

test('icon choices use BOT_ICON when present and the key name otherwise', async () => {
  const plain = await opened(profile(), 'about');
  assert.match(text(section(plain.shown, 'about')), /mail/);
  const sb = await opened(profile(), 'about', { window: { BOT_ICON: { svg: k => ({ nodeType: 1, tag: 'svg', attrs: { k }, kids: [] }) } } });
  assert.ok(find(section(sb.shown, 'about'), n => n.tag === 'svg').length >= 3);
});

test('Model sends provider with a model id when switching to OpenAI', async () => {
  const sb = await opened(profile(), 'model');
  const pane = section(sb.shown, 'model');
  const [provider] = find(pane, n => n.tag === 'select');
  const id = find(pane, n => n.tag === 'input')[0];
  provider.value = 'openai'; provider.onchange();
  id.value = 'gpt-5';
  press(buttonByText(pane, 'Save'));
  await settle();
  assert.deepStrictEqual(updates(sb)[0][1], { provider: 'openai', model: 'gpt-5', ifUpdatedAt: 'T1' });
});

test('Model sends effort and account changes for a Claude bot', async () => {
  const sb = await opened(profile(), 'model');
  const pane = section(sb.shown, 'model');
  const [, model, effort, account] = find(pane, n => n.tag === 'select');
  model.value = 'opus'; effort.value = 'high'; account.value = 'company';
  press(buttonByText(pane, 'Save'));
  await settle();
  assert.deepStrictEqual(updates(sb)[0][1], { model: 'opus', effort: 'high', account: 'company', ifUpdatedAt: 'T1' });
});

test('Advanced sends use and permission mode for a Claude bot and has no instructions editor', async () => {
  const sb = await opened(profile(), 'advanced');
  const pane = section(sb.shown, 'advanced');
  assert.strictEqual(find(pane, n => n.tag === 'textarea').length, 0);
  const [use, perm] = find(pane, n => n.tag === 'select');
  use.value = 'both'; perm.value = 'plan';
  press(buttonByText(pane, 'Save'));
  await settle();
  assert.deepStrictEqual(updates(sb)[0][1], { use: 'both', permissionMode: 'plan', ifUpdatedAt: 'T1' });
});

test('the instructions editor exists only for openai and xai bots and sends the new text', async () => {
  for (const provider of ['openai', 'xai']) {
    const sb = await opened(profile({ provider, model: 'gpt-5', use: 'agent' }), 'advanced');
    const pane = section(sb.shown, 'advanced');
    const [ins] = find(pane, n => n.tag === 'textarea');
    assert.ok(ins);
    assert.strictEqual(ins.value, 'be brief');
    ins.value = 'be very brief';
    press(buttonByText(pane, 'Save'));
    await settle();
    assert.deepStrictEqual(updates(sb)[0][1], { instructions: 'be very brief', ifUpdatedAt: 'T1' });
  }
});

test('archive asks first, then ends an idle chat and archives', async () => {
  const sb = await opened(profile(), 'advanced');
  const pane = section(sb.shown, 'advanced');
  press(buttonByText(pane, 'Archive bot'));
  assert.strictEqual(posts(sb).length, 0);
  press(buttonByText(pane, 'Archive'));
  await settle();
  assert.deepStrictEqual(posts(sb)[0], ['specialist/db/archive', { endChat: true }]);
});

test('archive closes the open chat panel of this bot and leaves another chat alone', async () => {
  const closed = [];
  const mine = await opened(profile(), 'advanced', { TERM: { active: 'claude-spec-db' }, closeTermPanel: () => closed.push('x') });
  press(buttonByText(section(mine.shown, 'advanced'), 'Archive bot'));
  press(buttonByText(section(mine.shown, 'advanced'), 'Archive'));
  await settle();
  assert.strictEqual(closed.length, 1);
  const other = await opened(profile(), 'advanced', { TERM: { active: 'claude-spec-db-2' }, closeTermPanel: () => closed.push('y') });
  press(buttonByText(section(other.shown, 'advanced'), 'Archive bot'));
  press(buttonByText(section(other.shown, 'advanced'), 'Archive'));
  await settle();
  assert.strictEqual(closed.length, 1);
});

test('Memory lists learned changes without start and preamble commits and undoes one', async () => {
  const sb = await opened(profile(), 'memory');
  const pane = section(sb.shown, 'memory');
  assert.match(text(pane), /Use the replica/);
  assert.match(text(pane), /knowledge\/replica\.md/);
  assert.doesNotMatch(text(pane), /Starting point|preamble/);
  press(buttonByText(pane, 'Undo'));
  press(buttonByText(pane, 'Undo'));
  await settle();
  assert.deepStrictEqual(posts(sb).find(([p]) => p.endsWith('/train/undo')), ['specialist/db/train/undo', { commit: 'a'.repeat(40) }]);
});

test('an undo refusal shows as a readable message', async () => {
  const sb = await opened(profile(), 'memory');
  const prior = sb.api;
  sb.api = async (p, b) => { if (p.endsWith('/train/undo')) throw Object.assign(new Error('the bot is busy'), { status: 409 }); return prior(p, b); };
  const pane = section(sb.shown, 'memory');
  press(buttonByText(pane, 'Undo'));
  press(buttonByText(pane, 'Undo'));
  await settle();
  assert.match(text(pane), /working right now/);
});

test('there is no feedback or train section', async () => {
  const sb = await opened(profile(), 'about');
  const tabs = find(sb.shown, n => n.attrs.role === 'tab').map(text);
  assert.deepStrictEqual(tabs, ['About', 'Model', 'Credentials', 'Memory', 'Advanced']);
});

test('a source with no secrets in storage: nothing writes values to storage or URLs', () => {
  assert.doesNotMatch(src, /localStorage|sessionStorage|console\./);
  assert.doesNotMatch(src, /\/\/ |\/\*/);
});
