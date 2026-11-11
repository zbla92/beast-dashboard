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

const build = (list, sessions, phone = false, extra = {}) => {
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
  Object.assign(sandbox, extra);
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

const memStore = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), m }; };
const finished = (id, over = {}) => ({ runId: id, specialist: 'writer', tmux: id, mode: 'run', state: 'done', task: 'Reply to Ana\nmore', preview: 'Hi Ana', startedAt: Date.now(), endedAt: Date.now() + 5000, ...over });

test('finished unwatched runs become inbox entries, dismiss and open mark them seen', async () => {
  const localStorage = memStore();
  const r1 = finished('claude-spec-writer-1'); const r2 = finished('claude-spec-writer-2', { state: 'error', error: 'boom', endedAt: Date.now() + 9000 });
  const old = finished('claude-spec-writer-0', { endedAt: Date.now() - 60000 });
  const sb = build([P('writer', { lastRun: r1 })], [], false, { localStorage });
  sb.api = async p => p === 'specialists' ? { ok: true, specialists: [P('writer', { lastRun: r1 })], templates: [] } : { ok: true, runs: [r1, r2, old] };
  await sb.FEAT.specialists.refresh(true);
  const list = sb.FEAT.specialists.unseenRuns();
  assert.deepStrictEqual(Array.from(list, r => r.runId), ['claude-spec-writer-2', 'claude-spec-writer-1']);
  assert.ok(!list.some(r => r.runId === old.runId));
  sb.FEAT.specialists.dismissRun(r1.runId);
  assert.deepStrictEqual(Array.from(sb.FEAT.specialists.unseenRuns(), r => r.runId), [r2.runId]);
  assert.ok(JSON.parse(localStorage.m.get('bd.spec.seen')).some(e => e.id === r1.runId));
});

test('runs finished while their terminal is open are not queued', async () => {
  const localStorage = memStore();
  const r1 = finished('claude-spec-writer-1');
  const sb = build([P('writer', { lastRun: r1 })], [], false, { localStorage, TERM: { open: true, active: 'claude-spec-writer-1', showList: false } });
  await sb.FEAT.specialists.refresh(true);
  assert.strictEqual(sb.FEAT.specialists.unseenRuns().length, 0);
});

test('the seen set is capped and moves since past the dropped runs', async () => {
  const localStorage = memStore();
  const sb = build([P('writer')], [], false, { localStorage });
  Array.from({ length: 260 }, (_, i) => i).forEach(i => sb.FEAT.specialists.dismissRun('r' + i));
  const stored = JSON.parse(localStorage.m.get('bd.spec.seen'));
  assert.strictEqual(stored.length, 200);
  assert.strictEqual(stored[0].id, 'r60');
  assert.ok(Number(localStorage.m.get('bd.spec.since')) >= Math.min(...stored.map(e => e.endedAt)));
});

test('trimSeen keeps the newest entries and raises since to the newest dropped endedAt', () => {
  const { trimSeen } = build([P('writer')], []).FEAT.specialists;
  const entries = [{ id: 'a', endedAt: 100 }, { id: 'b', endedAt: 300 }, { id: 'c', endedAt: 200 }, { id: 'd', endedAt: 400 }];
  const t = trimSeen(entries, 50, 2);
  assert.deepStrictEqual(t.kept.map(e => e.id), ['c', 'd']);
  assert.strictEqual(t.since, 300);
  const same = trimSeen(entries, 50, 10);
  assert.strictEqual(same.kept.length, 4);
  assert.strictEqual(same.since, 50);
  assert.strictEqual(trimSeen(entries, 900, 2).since, 900);
});

test('legacy string ids in storage are still read as seen', async () => {
  const localStorage = memStore();
  localStorage.setItem('bd.spec.seen', JSON.stringify(['claude-spec-writer-1']));
  localStorage.setItem('bd.spec.since', '1');
  const r1 = finished('claude-spec-writer-1');
  const sb = build([P('writer', { lastRun: r1 })], [], false, { localStorage });
  await sb.FEAT.specialists.refresh(true);
  assert.strictEqual(sb.FEAT.specialists.unseenRuns().length, 0);
});

test('a stopped run reaches the inbox like a finished one', async () => {
  const localStorage = memStore();
  const r1 = finished('claude-spec-writer-1', { state: 'stopped' });
  const sb = build([P('writer', { lastRun: r1 })], [], false, { localStorage });
  await sb.FEAT.specialists.refresh(true);
  assert.deepStrictEqual(Array.from(sb.FEAT.specialists.unseenRuns(), r => r.runId), [r1.runId]);
});

test('markSeen takes a run out of the inbox queue and keeps it out', async () => {
  const localStorage = memStore();
  const r1 = finished('claude-spec-writer-1');
  const sb = build([P('writer', { lastRun: r1 })], [], false, { localStorage });
  sb.FEAT.specialists.markSeen(r1.runId, r1.endedAt);
  await sb.FEAT.specialists.refresh(true);
  assert.strictEqual(sb.FEAT.specialists.unseenRuns().length, 0);
  const sb2 = build([P('writer', { lastRun: r1 })], [], false, { localStorage });
  await sb2.FEAT.specialists.refresh(true);
  assert.strictEqual(sb2.FEAT.specialists.unseenRuns().length, 0);
});

test('the inbox count leaves out specialist sessions in error and needs-you', () => {
  const sess = (name, claude) => ({ name, claude, project: null });
  const items = [sess('claude-a', { state: 'error', since: 1 }), sess('claude-spec-x', { state: 'error', specialist: 'x', since: 1 }), sess('claude-spec-y', { state: 'needs-you', specialist: 'x', since: 1 }), sess('claude-spec-z', { state: 'permission', specialist: 'x', since: 1 })];
  const sandbox = { FEAT: {}, termSessions: () => ({ claude: items }), h: () => ({}), $: () => null, markTab() {}, document: { addEventListener() {}, body: { classList: { toggle() {} } } }, setInterval: () => 0 };
  vm.createContext(sandbox);
  vm.runInContext(read('f-inbox.js'), sandbox);
  assert.strictEqual(sandbox.FEAT.inbox.count(), 2);
});

test('the home tile lists active runs and is hidden without them', async () => {
  const none = build([P('writer')], []);
  await none.FEAT.specialists.refresh(true);
  assert.strictEqual(none.FEAT.specialists.homeTiles(), null);
  const sessions = [{ name: 'claude-spec-writer-1', claude: { specialist: 'writer', state: 'working', since: Date.now(), firstPrompt: 'Reply to Ana' } }, { name: 'claude-spec-writer-2', claude: { specialist: 'writer', state: 'idle', firstPrompt: 'old' } }];
  const sb = build([P('writer')], sessions);
  await sb.FEAT.specialists.refresh(true);
  const tileEl = sb.FEAT.specialists.homeTiles();
  const rows = find(tileEl, n => /sp-home-row/.test(n.attrs.class || ''));
  assert.strictEqual(rows.length, 1);
  assert.match(text(rows[0]), /Reply to Ana/);
  rows[0].attrs.onclick();
  assert.strictEqual(sb.opened, 'claude-spec-writer-1');
});

test('the palette ask entry opens the ask dialog and posts without waiting in notify mode', async () => {
  const sb = build([P('writer')], []);
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.paletteItems()[1].run();
  const box = sb.shown;
  const ta = find(box, n => n.tag === 'textarea')[0]; ta.value = 'Do it';
  find(box, n => n.tag === 'button' && text(n) === 'Notify me')[0].attrs.onclick();
  const go = find(box, n => n.tag === 'button' && text(n) === 'Ask')[0];
  await go.onclick();
  const call = sb.calls.find(c => c[0] === 'specialist/writer/ask');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(call[1])), { text: 'Do it', wait: false });
});
