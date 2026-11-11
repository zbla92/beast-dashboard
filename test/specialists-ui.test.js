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
  n.remove = () => {};
  n.focus = () => {};
  n.addEventListener = () => {};
  if (n.attrs.value !== undefined) n.value = n.attrs.value;
  else if (tag === 'input' || tag === 'textarea') n.value = '';
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

test('an api provider shows its model id as given, a provider chip and the missing-key message', async () => {
  const sb = build([P('scout', { provider: 'xai', model: 'grok-4', keyError: 'no key for xai: see the docs' })], []);
  await sb.FEAT.specialists.refresh(true);
  assert.match(text(railRows(sb.FEAT.specialists.railSection('rail'))[0]), /grok-4/);
  sb.FEAT.specialists.open('scout');
  await new Promise(r => setTimeout(r, 10));
  const chips = find(sb.shown, n => n.attrs.class === 'sp-chips')[0];
  assert.match(text(chips), /xAI\s+grok-4/);
  assert.strictEqual(find(sb.shown, n => /sp-key/.test(n.attrs.class || ''))[0].textContent, 'no key for xai: see the docs');
});

test('switching the provider in the profile sends the provider with the typed model id', async () => {
  const sb = build([P('writer', { effort: null, permissionMode: 'default', account: 'personal', updatedAt: 5 })], []);
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.open('writer', { tab: 'profile' });
  await new Promise(r => setTimeout(r, 10));
  const provider = find(sb.shown, n => n.tag === 'select' && find(n, o => o.attrs.value === 'xai').length)[0];
  const id = find(sb.shown, n => n.tag === 'input' && n.attrs.maxlength === 128)[0];
  provider.value = 'xai'; provider.onchange(); id.value = ' grok-4 ';
  sb.calls.length = 0;
  await find(sb.shown, n => n.tag === 'button' && text(n) === 'Save')[0].onclick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.calls[0])), ['specialist/writer', { provider: 'xai', model: 'grok-4', ifUpdatedAt: 5 }]);
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

const commit = (id, o = {}) => ({ id: id.repeat(40).slice(0, 40), short: id.repeat(7), message: 'Shorter greetings', source: 'trainer', at: Date.now(), undoOf: null, undone: false, files: [{ path: 'style.md', change: 'modified' }], ...o });
const trainSetup = async (o = {}) => {
  const calls = []; const fetches = [];
  const overview = { ok: true, trainer: null, history: { ready: true, head: 'a', commits: [commit('a'), commit('b', { source: 'start', message: 'Starting point' })] }, feedback: [], accesses: [{ name: 'DB_URL', note: 'read replica', bytes: 5, updatedAt: 'x' }], uploads: { files: 0, bytes: 0 }, ...o.overview };
  const sb = build([P('writer')], [], false, {
    convTurn: t => ({ tag: 'div', attrs: {}, kids: [t.text] }),
    fetch: async (u, init) => { fetches.push([u, init]); return o.fetch ? o.fetch(u, init) : { ok: true, status: 201, json: async () => ({ ok: true, file: { path: 'knowledge/files/a.pdf', bytes: 3 } }) }; },
    api: async (p, body) => {
      calls.push([p, body]);
      if (o.api) { const r = await o.api(p, body); if (r !== undefined) return r; }
      if (p === 'specialist/writer/train') return overview;
      if (p.startsWith('transcript/')) return { total: 0, turns: [], sig: 's' };
      if (p === 'specialists') return { ok: true, specialists: [P('writer')], templates: [] };
      return { ok: true, specialist: { ...P('writer'), instructions: '' }, runs: [], thread: null };
    }
  });
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.open('writer', { tab: 'train' });
  await new Promise(r => setTimeout(r, 20));
  return { sb, calls, fetches, box: () => sb.shown };
};
const btn = (box, label) => find(box, n => n.tag === 'button' && text(n) === label)[0];
const fire = (n, ev = 'onclick') => (n[ev] || n.attrs[ev])();

test('the create dialog ends on the Train tab with the opening prompt', async () => {
  const sb = build([P('writer')], [], false);
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.create();
  const box = sb.shown;
  const nameIn = find(box, n => n.attrs.placeholder === 'name, e.g. writer')[0];
  nameIn.value = 'writer'; nameIn.oninput();
  await fire(btn(box, 'Create'));
  await new Promise(r => setTimeout(r, 20));
  assert.match(text(sb.shown), /What is this specialist for, and how should it behave\?/);
  assert.ok(sb.calls.some(c => c[0] === 'specialist/writer/train'));
});

test('train send posts text, uploaded files and fresh, and shows a busy trainer in plain words', async () => {
  const st = { busy: true };
  const t = await trainSetup({ api: (p) => { if (p.endsWith('/train/send')) { if (st.busy) throw Object.assign(new Error('trainer is busy'), { status: 409 }); return { ok: true, trainer: { live: true, state: 'working', turns: 1, tmux: 'claude-spec-writer_train' } }; } } });
  const box = t.box();
  find(box, n => n.tag === 'textarea')[0].value = 'Be brief';
  await fire(btn(box, 'Send'));
  assert.match(text(box), /The trainer is busy with a turn/);
  st.busy = false;
  fire(btn(box, 'New conversation: on') || btn(box, 'New conversation'));
  await fire(btn(box, 'Send'));
  const sends = t.calls.filter(c => c[0] === 'specialist/writer/train/send');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sends[1][1])), { text: 'Be brief', fresh: true });
});

test('uploads post raw bytes, name the files in the next message and explain 415 and 413', async () => {
  const net = { status: 201 };
  const t = await trainSetup({ fetch: async () => net.status === 201 ? { ok: true, status: 201, json: async () => ({ ok: true, file: { path: 'knowledge/files/a.pdf', bytes: 3 } }) }   : { ok: false, status: net.status, statusText: 'x', json: async () => ({ error: ".exe files can't be used for training: save it as PDF or text" }) } });
  const box = t.box();
  const input = find(box, n => n.tag === 'input' && n.attrs.type === 'file')[0];
  const drop = find(box, n => /sp-drop/.test(n.attrs.class || ''))[0];
  assert.ok(drop);
  const fileInput = input;
  fileInput.files = [{ name: 'a b.pdf', size: 3 }];
  await fire(fileInput, 'onchange');
  assert.match(t.fetches[0][0], /\/api\/specialist\/writer\/train\/upload\?filename=a%20b\.pdf$/);
  assert.match(text(box), /a\.pdf/);
  await fire(btn(box, 'Send'));
  const send = t.calls.find(c => c[0] === 'specialist/writer/train/send');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(send[1].files)), ['knowledge/files/a.pdf']);
  net.status = 415;
  fileInput.files = [{ name: 'x.exe', size: 3 }];
  await fire(fileInput, 'onchange');
  assert.match(text(box), /x\.exe: \.exe files can't be used/);
  fileInput.files = [{ name: 'big.pdf', size: 21 * 1024 * 1024 }];
  const before = t.fetches.length;
  await fire(fileInput, 'onchange');
  assert.strictEqual(t.fetches.length, before);
  assert.match(text(box), /big\.pdf: Too big/);
});

test('the change list shows source, loads a diff as text and undoes only after confirmation', async () => {
  const t = await trainSetup({ api: p => {
    if (p.startsWith('specialist/writer/train/commit/')) return { ok: true, commit: commit('a'), diff: '@@ -1 +1 @@\n-old <b>x</b>\n+new', truncated: false };
    if (p === 'specialist/writer/train/undo') return { ok: true, commit: commit('c', { source: 'undo' }) };
  } });
  const box = t.box();
  assert.match(text(box), /Shorter greetings/);
  assert.match(text(box), /trainer/);
  const views = find(box, n => n.tag === 'button' && text(n) === 'View');
  await fire(views[0]);
  await new Promise(r => setTimeout(r, 10));
  const lines = find(t.box(), n => /(^| )dl( |$)/.test(n.attrs.class || ''));
  assert.ok(lines.some(l => /del/.test(l.attrs.class) && text(l).includes('<b>x</b>')));
  assert.ok(find(t.box(), n => n.tag === 'button' && text(n) === 'Undo').length === 1);
  fire(find(t.box(), n => n.tag === 'button' && text(n) === 'Undo')[0]);
  assert.ok(!t.calls.some(c => c[0] === 'specialist/writer/train/undo'));
  await fire(find(t.box(), n => n.tag === 'button' && text(n) === 'Undo' && /solid/.test(n.attrs.class))[0]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.calls.find(c => c[0] === 'specialist/writer/train/undo')[1])), { commit: 'a'.repeat(40) });
});

test('accesses list names and notes, use a password field and never show a saved value', async () => {
  const t = await trainSetup();
  const box = t.box();
  assert.match(text(box), /DB_URL/);
  assert.match(text(box), /read replica/);
  assert.match(text(box), /never the values/);
  const pw = find(box, n => n.tag === 'input' && n.attrs.type === 'password')[0];
  assert.ok(pw);
  const nm = find(box, n => n.attrs.placeholder === 'NAME, e.g. DB_URL')[0];
  nm.value = 'API_TOKEN'; pw.value = 'sekret'; find(box, n => n.attrs.placeholder === 'Note, e.g. read replica')[0].value = 'prod';
  await fire(btn(box, 'Save access'));
  const post = t.calls.find(c => c[0] === 'specialist/writer/accesses');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(post[1])), { name: 'API_TOKEN', value: 'sekret', note: 'prod' });
  assert.strictEqual(pw.value, '');
  assert.ok(!text(t.box()).includes('sekret'));
  nm.value = 'bad name'; pw.value = 'v';
  await fire(btn(box, 'Save access'));
  assert.match(text(box), /Use a name like DB_URL/);
});

test('feedbackBody needs a changed answer or a note and omits an unchanged answer', () => {
  const sb = build([P('writer')], []);
  const f = sb.FEAT.specialists.feedbackBody;
  assert.ok(f({ runId: 'r1', original: 'Hi', better: 'Hi', note: '' }).error);
  assert.ok(f({ original: 'Hi', better: '  ', note: ' ' }).error);
  assert.deepStrictEqual({ ...f({ runId: 'r1', original: 'Hi', better: 'Hello', note: '' }).body }, { original: 'Hi', runId: 'r1', better: 'Hello' });
  assert.deepStrictEqual({ ...f({ original: 'Hi', better: 'Hi', note: ' Be warm ' }).body }, { original: 'Hi', note: 'Be warm' });
});

test('feedbackError gives plain words for 413, 429 and 404', () => {
  const f = build([P('writer')], []).FEAT.specialists.feedbackError;
  assert.match(f({ status: 413, message: 'x' }), /too long/);
  assert.match(f({ status: 429, message: 'x' }), /Too much feedback/);
  assert.match(f({ status: 404, message: 'x' }), /no longer exists/);
  assert.strictEqual(f({ status: 500, message: 'boom' }), 'boom');
});

test('tracked feedback is polled until applied or failed, then polling stops', async () => {
  const toasts = [], polls = [];
  const states = [['pending'], ['applied']];
  const host = { append: n => toasts.push(n) };
  const sb = build([P('writer')], [], false, {
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    $: sel => sel === '#toasts' ? host : null,
    toast: (m, k) => toasts.push({ m, k }),
    api: async p => { polls.push(p); return { ok: true, feedback: [{ id: 'fb-1', state: states.shift()[0] }] }; },
    setTimeout: (fn, ms) => { if (ms === 4000) sb.next = fn; return 1; },
  });
  sb.FEAT.specialists.trackFeedback('writer', 'Writer', 'fb-1');
  await sb.next();
  assert.strictEqual(toasts.length, 0);
  assert.ok(sb.next);
  const second = sb.next; sb.next = null;
  await second();
  assert.strictEqual(sb.next, null);
  assert.match(text(toasts[0]), /Writer learned from your note/);
  assert.match(polls[0], /^specialist\/writer\/train\/feedback\?ids=fb-1$/);
});

test('a failed feedback record shows a Retry that posts to the retry endpoint', async () => {
  const toasts = [], calls = [];
  const host = { append: n => toasts.push(n) };
  const sb = build([P('writer')], [], false, {
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    $: sel => sel === '#toasts' ? host : null,
    api: async (p, b) => { calls.push([p, b]); return p.includes('retry') ? { ok: true, feedback: { id: 'fb-2', state: 'pending' } } : { ok: true, feedback: [{ id: 'fb-2', state: 'failed', error: 'stopped' }] }; },
    setTimeout: (fn, ms) => { if (ms === 4000) sb.next = fn; return 1; },
  });
  sb.FEAT.specialists.trackFeedback('writer', 'Writer', 'fb-2');
  await sb.next();
  assert.match(text(toasts[0]), /stopped/);
  const retry = find(toasts[0], n => n.tag === 'button')[0];
  retry.attrs.onclick();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(calls[1][0], 'specialist/writer/train/feedback/fb-2/retry');
  assert.deepStrictEqual({ ...calls[1][1] }, {});
});
