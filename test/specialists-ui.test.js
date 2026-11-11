const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const app = read('app.js');

const node = (tag, attrs, kids) => {
  const n = { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k != null && k !== false), nodeType: 1, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
  n.querySelector = () => null;
  n.replaceChildren = (...k) => { n.kids = k.flat(Infinity); };
  n.append = (...k) => { n.kids.push(...k); };
  n.contains = () => false;
  n.focus = () => {};
  return n;
};
const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n == null ? '' : (n.kids || []).map(text).join(' ');
const walk = (n, fn) => { if (n && typeof n === 'object') { fn(n); (n.kids || []).forEach(k => walk(k, fn)); } };
const find = (n, pred) => { const out = []; walk(n, x => { if (pred(x)) out.push(x); }); return out; };
const railRows = els => find({ attrs: {}, kids: els }, n => /(^| )rrow( |$)/.test(n.attrs.class || ''));

const build = (list, sessions, phone = false) => {
  const calls = [];
  const modal = node('div', {}, []);
  const sandbox = {
    FEAT: {}, calls, modal, opened: null, shown: null,
    h: (tag, attrs, ...kids) => node(tag, attrs, kids),
    gl: l => String(l), ico: n => ({ nodeType: 1, tag: 'svg', attrs: { n }, kids: [] }), gico: g => String(g),
    $: () => modal,
    S: { runtime: { sessions } }, IS_PHONE: phone, TERM: { open: false, active: null, showList: false },
    STATE_ICON: { working: '●' }, STATE_LABEL: { working: 'working' },
    modelName: m => m[0].toUpperCase() + m.slice(1), acct: a => a, plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`, ago: () => '1m',
    api: async (p, body) => {
      calls.push([p, body]);
      if (p === 'specialists') return { ok: true, specialists: list, templates: [] };
      if (p.endsWith('/ask')) return { ok: true, tmux: 'claude-spec-writer-261111-0930' };
      return { ok: true, specialist: { ...list[0], instructions: '' }, runs: [], thread: null };
    },
    toast() {}, renderRail() {}, renderTermPanel() {}, openTerm(n) { sandbox.opened = n; }, claudeOf: () => null,
    document: { hidden: true, addEventListener() {}, removeEventListener() {} }, setInterval: () => 0, clearInterval() {}, setTimeout,
  };
  modal.replaceChildren = (...k) => { sandbox.shown = k[0]; };
  vm.createContext(sandbox);
  vm.runInContext(read('f-specialists.js'), sandbox);
  return sandbox;
};

const P = (name, o = {}) => ({ name, title: name[0].toUpperCase() + name.slice(1), icon: '✎', description: 'does ' + name, model: 'sonnet', mode: 'run', active: 0, lastRun: null, thread: null, ...o });

test('the rail section lists specialists in the given order with model chip and active count', async () => {
  const sb = build([P('editor'), P('writer', { active: 2, model: 'opus' })], []);
  await sb.FEAT.specialists.refresh(true);
  const els = sb.FEAT.specialists.railSection('rail');
  const rows = railRows(els);
  assert.deepStrictEqual(rows.map(r => text(r.kids.find(k => k.attrs.class === 'rtx').kids[0].kids[0])), ['Editor', 'Writer']);
  assert.match(text(rows[1]), /opus/);
  assert.strictEqual(find(rows[1], n => n.attrs.class === 'rage').length, 1);
  assert.strictEqual(find(rows[0], n => n.attrs.class === 'rage').length, 0);
  assert.match(text(els[0]), /Specialists\s+2/);
});

test('live run sessions show under their specialist and the state follows them', async () => {
  const sessions = [{ name: 'claude-spec-writer-261111-0930', claude: { specialist: 'writer', state: 'permission', firstPrompt: 'Reply to Ana' } }];
  const sb = build([P('writer')], sessions);
  await sb.FEAT.specialists.refresh(true);
  const rows = railRows(sb.FEAT.specialists.railSection('rail'));
  assert.strictEqual(rows.length, 2);
  assert.match(rows[0].attrs.class, /st-permission/);
  assert.match(text(rows[1]), /Reply to Ana/);
});

test('the phone list section is only built on the phone', async () => {
  assert.strictEqual(build([P('writer')], [], false).FEAT.specialists.railSection('list'), null);
  const sb = build([P('writer')], [], true);
  await sb.FEAT.specialists.refresh(true);
  assert.ok(sb.FEAT.specialists.railSection('list').length > 1);
});

test('an invalid profile shows as an error row', async () => {
  const sb = build([{ name: 'broken', dir: '/x', error: 'bad json' }], []);
  await sb.FEAT.specialists.refresh(true);
  const rows = railRows(sb.FEAT.specialists.railSection('rail'));
  assert.match(rows[0].attrs.class, /st-error/);
  assert.strictEqual(rows[0].attrs.title, 'bad json');
});

test('the palette offers a page and an ask entry per valid specialist', async () => {
  const sb = build([P('writer'), { name: 'broken', error: 'x' }], []);
  await sb.FEAT.specialists.refresh(true);
  assert.deepStrictEqual(Array.from(sb.FEAT.specialists.paletteItems(), i => i.label), ['Specialist: Writer', 'Ask Writer…']);
});

test('the rail key changes with the data it renders', async () => {
  const keyOf = async (list, sessions) => { const sb = build(list, sessions); await sb.FEAT.specialists.refresh(true); return JSON.stringify(sb.FEAT.specialists.termBarKey()); };
  const base = await keyOf([P('writer')], []);
  assert.notStrictEqual(await keyOf([P('writer', { active: 1 })], []), base);
  assert.notStrictEqual(await keyOf([P('writer')], [{ name: 'claude-spec-writer-261111-0930', claude: { specialist: 'writer', state: 'working' } }]), base);
});

test('run sessions are kept out of the Sessions list and its count, by the specialist field only', () => {
  const src = app.slice(app.indexOf('const isSpecRun'), app.indexOf('const isClaudeSession'));
  const ctx = vm.createContext({ S: { runtime: { sessions: [{ name: 'claude-a' }, { name: 'claude-spec-kit' }, { name: 'claude-spec-x-261111-0930' }, { name: 'claude-b', claude: { specialist: 'x' } }, { name: 'sh-1' }] } } });
  vm.runInContext(src + ';this.n = sessCount();', ctx);
  assert.strictEqual(ctx.n, 4);
  assert.match(app, /for \(const s of S\.runtime\.sessions\) \{\n    if \(!withRuns && isSpecRun\(s\)\) continue;/);
});

test('the Inbox reads termSessions with runs so a waiting run reaches it and the badges', () => {
  assert.match(read('f-inbox.js'), /termSessions\(true\)\.claude\.filter/);
  assert.match(app, /FEAT\.inbox\?\.count \? FEAT\.inbox\.count\(\)/);
});

test('an idle run session looks idle and only a permission question is amber', async () => {
  const sessions = [
    { name: 'claude-spec-writer-a', claude: { specialist: 'writer', state: 'needs-you', needsYou: true, firstPrompt: 'idle one' } },
    { name: 'claude-spec-writer-b', claude: { specialist: 'writer', state: 'permission', needsYou: true, firstPrompt: 'asks' } },
  ];
  const sb = build([P('writer')], sessions);
  await sb.FEAT.specialists.refresh(true);
  const rows = railRows(sb.FEAT.specialists.railSection('rail'));
  assert.match(rows[0].attrs.class, /st-permission/);
  assert.match(rows[1].attrs.class, /st-idle/);
  assert.doesNotMatch(rows[1].attrs.class, /need/);
  assert.match(rows[2].attrs.class, /st-permission/);
  assert.match(rows[2].attrs.class, /need/);
});

test('the page poll stops once another dialog replaced the page', async () => {
  const sb = build([P('writer')], []);
  let tick = null; let cleared = 0;
  sb.setInterval = fn => { tick = fn; return 7; };
  sb.clearInterval = () => { cleared++; };
  sb.document.hidden = false;
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.open('writer');
  await new Promise(r => setTimeout(r, 10));
  sb.calls.length = 0; cleared = 0;
  sb.modal.contains = () => true;
  tick();
  assert.strictEqual(cleared, 0);
  sb.modal.contains = () => false;
  tick();
  assert.strictEqual(cleared, 1);
  const before = sb.calls.length;
  tick();
  assert.strictEqual(sb.calls.length, before);
});

test('the rail key includes the open page', async () => {
  const sb = build([P('writer')], []);
  await sb.FEAT.specialists.refresh(true);
  const closed = JSON.stringify(sb.FEAT.specialists.termBarKey());
  sb.modal.contains = () => true;
  sb.FEAT.specialists.open('writer');
  assert.notStrictEqual(JSON.stringify(sb.FEAT.specialists.termBarKey()), closed);
});

test('the page loads the specialist and asking posts without waiting, then opens the run', async () => {
  const sb = build([P('writer')], []);
  await sb.FEAT.specialists.refresh(true);
  sb.calls.length = 0;
  sb.FEAT.specialists.open('writer', { focus: true });
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(sb.calls[0][0], 'specialist/writer?runs=50');
  const ta = find(sb.shown, n => n.attrs.class === 'sp-ask')[0];
  const ask = find(sb.shown, n => n.tag === 'button' && text(n) === 'Ask')[0];
  ta.value = 'Reply to Ana';
  await ask.onclick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.calls.find(c => c[0].endsWith('/ask')))), ['specialist/writer/ask', { text: 'Reply to Ana', wait: false }]);
  assert.strictEqual(sb.opened, 'claude-spec-writer-261111-0930');
});
