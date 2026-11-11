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
    toast() {}, renderRail() {}, renderTermPanel() {}, openTerm(n) { sandbox.opened = n; }, claudeOf: () => null, PENDING: {}, uploadFile: async f => '/pasted/' + f.name, closeTermPanel() { sandbox.left = true; },
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

const PAGE = 'claude-spec-writer_page';
const pageSetup = async (o = {}) => {
  const calls = []; const toasts = []; const reply = node('textarea', { class: 'creply' }, []); const field = node('div', {}, []);
  field.insertBefore = c => field.kids.push(c);
  const sb = build(o.list || [P('writer')], o.sessions || [], !!o.phone, {
    TERM: { open: true, active: PAGE, showList: false },
    feat: (hook, ...a) => Object.values(sb.FEAT).flatMap(f => f[hook] ? [f[hook](...a)] : []).filter(x => x != null && x !== false).flat(),
    document: { hidden: false, body: node('body', {}, []), addEventListener() {}, removeEventListener() {} },
    claudeOf: n => o.live && o.live.includes(n) ? { mode: 'chat' } : sb.FEAT.specialists.phantom(n),
    toast: (m, k) => toasts.push([m, k]),
    api: async (p, body) => {
      calls.push([p, body]);
      if (o.api) { const r = await o.api(p, body); if (r !== undefined) return r; }
      if (p === 'specialists') return { ok: true, specialists: o.list || [P('writer')], templates: [] };
      if (p.endsWith('/ask')) return { ok: true, tmux: 'claude-spec-writer-261111-0930', runId: 'claude-spec-writer-261111-0930' };
      if (p.startsWith('specialist/run/')) return { ok: true, ...o.full };
      return { ok: true, specialist: { ...(o.list || [P('writer')])[0], instructions: 'Be kind', ...o.spec }, runs: o.runs || [], thread: o.thread || null };
    }
  });
  let tick = null; let cleared = 0;
  sb.setInterval = fn => { tick = fn; return 7; };
  sb.clearInterval = () => { cleared++; };
  sb.openTerm = n => { sb.opened = n; sb.TERM.active = n; sb.FEAT.specialists.termShown(); };
  sb.modal.style = { setProperty() {} };
  sb.modal.querySelector = sel => /cfield/.test(sel) ? field : sel === '.creply' ? reply : null;
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.termShown();
  await new Promise(r => setTimeout(r, 20));
  return { sb, calls, toasts, field, reply, tick: () => tick(), cleared: () => cleared, S: sb.FEAT.specialists, view: () => find(sb.FEAT.specialists.emptyChat(PAGE), () => true) };
};
const run = (id, o = {}) => ({ runId: id, specialist: 'writer', tmux: id, mode: 'run', state: 'done', task: 'Reply to ' + id + '\nmore', preview: 'Hi ' + id, startedAt: Date.now(), endedAt: Date.now() + 5000, ...o });

test('the page poll stops once another chat replaced the page', async () => {
  const w = run('w', { state: 'working' });
  const t = await pageSetup({ runs: [w], full: { ...w, text: null } });
  t.calls.length = 0;
  t.tick();
  assert.strictEqual(t.calls.filter(c => c[0] === 'specialist/writer?runs=50').length, 1);
  t.sb.TERM.active = 'claude-other';
  const before = t.cleared();
  t.tick();
  assert.strictEqual(t.cleared(), before + 1);
  assert.strictEqual(t.S.termBar(PAGE), null);
  assert.strictEqual(t.S.transcript(PAGE), null);
  const calls = t.calls.length;
  t.tick();
  assert.strictEqual(t.calls.length, calls);
});

test('the bar key includes the open page', async () => {
  const sb = build([P('writer')], []);
  await sb.FEAT.specialists.refresh(true);
  const closed = JSON.stringify(sb.FEAT.specialists.termBarKey(PAGE));
  const t = await pageSetup();
  assert.notStrictEqual(JSON.stringify(t.S.termBarKey(PAGE)), closed);
  const open = JSON.stringify(t.S.termBarKey(PAGE));
  fire(btn({ attrs: {}, kids: t.S.termBar(PAGE) }, 'Profile'));
  assert.notStrictEqual(JSON.stringify(t.S.termBarKey(PAGE)), open);
});

test('the specialist is a phantom chat with its title in the header', async () => {
  const t = await pageSetup();
  assert.strictEqual(t.S.phantom(PAGE).mode, 'chat');
  assert.strictEqual(t.S.phantom('claude-spec-ghost_page'), null);
  assert.strictEqual(t.S.trainTitle(PAGE), 'Writer');
  assert.ok(t.S.termTile(PAGE));
  assert.strictEqual(t.S.termTile('claude-other'), null);
  assert.strictEqual(t.S.noTranscript(PAGE), true);
  assert.strictEqual(t.S.noTranscript('claude-spec-writer_train'), false);
  assert.strictEqual(t.S.noTranscript('claude-other'), false);
  assert.strictEqual(t.S.emptyChat('claude-other'), null);
});

const done = (id, over = {}) => ({ ...run(id), text: 'Hi ' + id, turns: 1, ...over });
const turnTexts = t => Array.from(t.S.transcript(PAGE).turns, x => x.role === 'user' ? x.text : x.steps[0].text);

test('the page is one conversation: the latest run as a user turn and its answer, an invitation when empty', async () => {
  const t = await pageSetup({ runs: [run('r2'), run('r1')], full: done('r2', { task: 'Reply to Ana', text: 'Hi Ana, thanks.' }) });
  assert.strictEqual(t.calls.find(c => c[0].startsWith('specialist/writer?'))[0], 'specialist/writer?runs=50');
  assert.ok(t.calls.some(c => c[0] === 'specialist/run/r2'));
  assert.deepStrictEqual(turnTexts(t), ['Reply to Ana', 'Hi Ana, thanks.']);
  assert.strictEqual(t.S.transcript(PAGE).pending, null);
  const e = await pageSetup();
  assert.strictEqual(e.S.transcript(PAGE).turns.length, 0);
  assert.match(text(e.S.emptyChat(PAGE)), /does writer/);
  assert.match(text(e.S.emptyChat(PAGE)), /Ask Writer something/);
});

test('a working run shows as pending with the live transcript turns and a run that errored says so', async () => {
  const live = { turns: [{ role: 'user', text: 'Reply to Ana', h: 'a' }, { role: 'assistant', steps: [{ k: 'text', text: 'Drafting' }], h: 'b' }], sig: 'x1', since: 5 };
  const w = await pageSetup({ runs: [run('w', { state: 'working' })], full: { ...run('w', { state: 'working' }), text: null }, api: p => p.startsWith('transcript/') ? live : undefined });
  const t = w.S.transcript(PAGE);
  assert.strictEqual(t.pending, 'working');
  assert.strictEqual(t.since, 5);
  assert.deepStrictEqual(turnTexts(w), ['Reply to Ana', 'Drafting']);
  const e = await pageSetup({ runs: [run('e', { state: 'error' })], full: { ...run('e', { state: 'error' }), text: null, error: 'boom' } });
  assert.deepStrictEqual(turnTexts(e), ['Reply to e\nmore', 'It could not finish: boom']);
});

test('the answers carry Copy and Improve, once each', async () => {
  const t = await pageSetup({ runs: [run('r1')], full: done('r1', { task: 'Reply to Ana', text: 'Hi Ana, thanks.' }) });
  const turns = t.S.transcript(PAGE).turns;
  const user = node('div', {}, []); user._turn = turns[0];
  const answer = node('div', {}, []); answer._turn = turns[1];
  const conv = node('div', {}, []); conv.children = [user, answer];
  t.S.conversation(PAGE, conv);
  assert.strictEqual(user.kids.length, 0);
  assert.ok(btn(answer, 'Copy'));
  assert.ok(btn(answer, 'Improve'));
  t.S.conversation('claude-other', conv);
  assert.strictEqual(answer.kids.length, 1);
});

test('the composer continues the latest finished run in place and never opens another session', async () => {
  const t = await pageSetup({ runs: [run('r1')], full: done('r1', { task: 'Reply to Ana', text: 'Hi Ana, thanks.' }), api: p => p.endsWith('/send') ? { ok: true, ...done('r1', { state: 'working', text: null, turns: 2 }) } : undefined });
  t.S.composerShown(t.sb.modal);
  assert.strictEqual(t.reply.placeholder, 'Reply to Writer…');
  t.calls.length = 0;
  const r = await t.S.trainSend(PAGE, 'Make it shorter');
  assert.ok(r);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.calls.find(c => c[0].endsWith('/send')))), ['specialist/run/r1/send', { text: 'Make it shorter' }]);
  assert.strictEqual(t.sb.opened, null);
  assert.strictEqual(t.S.transcript(PAGE).pending, 'working');
});

test('a message while the run is still working is refused and nothing is sent', async () => {
  const t = await pageSetup({ runs: [run('w', { state: 'working' })], full: { ...run('w', { state: 'working' }), text: null } });
  t.calls.length = 0;
  await assert.rejects(t.S.trainSend(PAGE, 'More'), /Still working/);
  assert.strictEqual(t.calls.length, 0);
});

test('a run made with another provider falls back to a new ask', async () => {
  const t = await pageSetup({ runs: [run('r1')], full: done('r1'), api: p => { if (p.endsWith('/send')) throw Object.assign(new Error('this run was made with another provider; ask the specialist again instead'), { status: 409 }); } });
  await t.S.trainSend(PAGE, 'Again');
  assert.ok(t.calls.some(c => c[0] === 'specialist/writer/ask'));
});

test('New conversation empties the page, the next message asks, and Earlier switches back', async () => {
  const t = await pageSetup({ runs: [run('r2'), run('r1')], full: done('r2') });
  const bar = () => ({ attrs: {}, kids: t.S.termBar(PAGE) });
  assert.strictEqual(t.S.transcript(PAGE).turns.length, 2);
  fire(btn(bar(), 'New conversation'));
  assert.strictEqual(t.S.transcript(PAGE).turns.length, 0);
  assert.match(text(btn(bar(), 'New conversation: on')), /New conversation: on/);
  t.S.composerShown(t.sb.modal);
  assert.strictEqual(t.reply.placeholder, 'Ask Writer…');
  t.calls.length = 0;
  await t.S.trainSend(PAGE, 'Fresh task');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.calls.find(c => c[0].endsWith('/ask')))), ['specialist/writer/ask', { text: 'Fresh task', wait: false }]);
  assert.strictEqual(t.sb.opened, null);
  assert.ok(btn(bar(), 'New conversation'));
});

test('Earlier lists the runs in the side panel and picking one shows it as the conversation', async () => {
  const t = await pageSetup({ runs: [run('r2'), run('r1', { task: 'Old task' })], full: done('r2') });
  fire(btn({ attrs: {}, kids: t.S.termBar(PAGE) }, 'Earlier'));
  const cardsIn = find({ attrs: {}, kids: [t.sb.modal] }, n => /sppage-card/.test(n.attrs.class || ''));
  assert.strictEqual(cardsIn.length, 2);
  assert.match(text(cardsIn[1]), /Old task\s+done\s+1m ago/);
  t.calls.length = 0;
  fire(cardsIn[1]);
  await new Promise(r => setTimeout(r, 20));
  assert.ok(t.calls.some(c => c[0] === 'specialist/run/r1'));
  assert.strictEqual(t.sb.opened, null);
});

test('a thread specialist has no New conversation or Earlier and continues by asking', async () => {
  const t = await pageSetup({ list: [P('writer', { mode: 'thread' })], spec: { mode: 'thread' }, runs: [run('t_2', { mode: 'thread' })], full: done('t_2', { mode: 'thread' }) });
  const bar = { attrs: {}, kids: t.S.termBar(PAGE) };
  assert.strictEqual(btn(bar, 'New conversation'), undefined);
  assert.strictEqual(btn(bar, 'Earlier'), undefined);
  t.calls.length = 0;
  await t.S.trainSend(PAGE, 'Next');
  assert.ok(t.calls.some(c => c[0] === 'specialist/writer/ask'));
  assert.ok(!t.calls.some(c => c[0].endsWith('/send')));
});

test('openRun and open with a run show that run on the page', async () => {
  const t = await pageSetup({ runs: [run('r1')], full: done('r9', { runId: 'r9', tmux: 'r9', task: 'Old task', text: 'Old answer' }) });
  t.S.open('writer', { run: 'r9' });
  await new Promise(r => setTimeout(r, 20));
  assert.deepStrictEqual(turnTexts(t), ['Old task', 'Old answer']);
  assert.ok(t.calls.some(c => c[0] === 'specialist/run/r9'));
});

test('asking from the composer posts without waiting, sends attached files and stays on the page', async () => {
  const t = await pageSetup();
  assert.strictEqual(t.S.trainSend('claude-other', 'hi'), null);
  await t.S.attachFile(PAGE, { name: 'a.pdf', size: 3 });
  t.S.composerShown(t.sb.modal);
  assert.match(text(find(t.field, n => /sptr-chips/.test(n.attrs.class || ''))[0]), /a\.pdf/);
  assert.strictEqual(t.reply.placeholder, 'Ask Writer…');
  await t.S.trainSend(PAGE, 'Reply to Ana');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.calls.find(c => c[0].endsWith('/ask')))), ['specialist/writer/ask', { text: 'Reply to Ana', wait: false, files: ['/pasted/a.pdf'] }]);
  assert.strictEqual(t.sb.opened, null);
});

test('the stop button targets the working run and nothing when it is idle', async () => {
  const w = await pageSetup({ runs: [run('w', { state: 'working' })], full: { ...run('w', { state: 'working' }), text: null } });
  assert.strictEqual(w.S.keyTarget(PAGE), 'w');
  const d = await pageSetup({ runs: [run('r1')], full: done('r1') });
  assert.strictEqual(d.S.keyTarget(PAGE), null);
  assert.strictEqual(d.S.keyTarget('claude-other'), null);
});

test('a failed ask rejects so the composer keeps the text, and a plain ask has no files', async () => {
  const t = await pageSetup({ api: p => { if (p.endsWith('/ask')) throw Object.assign(new Error('4 runs of this specialist are already active'), { status: 429 }); } });
  await assert.rejects(t.S.trainSend(PAGE, 'Hi'), /already active/);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.calls.find(c => c[0].endsWith('/ask'))[1])), { text: 'Hi', wait: false });
  assert.strictEqual(t.sb.opened, null);
});

test('an api provider shows its model id as given, a provider chip and the missing-key message', async () => {
  const scout = P('scout', { provider: 'xai', model: 'grok-4', keyError: 'no key for xai: see the docs' });
  const sb = build([scout], []);
  await sb.FEAT.specialists.refresh(true);
  assert.match(text(railRows(sb.FEAT.specialists.railSection('rail'))[0]), /grok-4/);
  const t = await pageSetup({ list: [scout] });
  t.sb.TERM.active = 'claude-spec-scout_page';
  t.S.termShown();
  await new Promise(r => setTimeout(r, 20));
  const bar = { attrs: {}, kids: t.S.termBar('claude-spec-scout_page') };
  assert.match(text(find(bar, n => /sppage-chips/.test(n.attrs.class || ''))[0]), /xAI\s+grok-4/);
  assert.match(text(t.S.emptyChat('claude-spec-scout_page')), /no key for xai: see the docs/);
  await assert.rejects(t.S.attachFile('claude-spec-scout_page', { name: 'a.pdf', size: 3 }), /only get the text/);
});

test('the Profile button opens the profile in the side panel and switching the provider sends it with the typed model id', async () => {
  const t = await pageSetup({ list: [P('writer', { effort: null, permissionMode: 'default', account: 'personal', updatedAt: 5 })] });
  fire(btn({ attrs: {}, kids: t.S.termBar(PAGE) }, 'Profile'));
  const panel = find({ attrs: {}, kids: [t.sb.modal] }, () => true);
  assert.ok(panel);
  const body = t.sb.modal.kids;
  const provider = find({ attrs: {}, kids: body }, n => n.tag === 'select' && find(n, o => o.attrs.value === 'xai').length)[0];
  assert.ok(provider);
  const id = find({ attrs: {}, kids: body }, n => n.tag === 'input' && n.attrs.maxlength === 128)[0];
  provider.value = 'xai'; provider.onchange(); id.value = ' grok-4 ';
  t.calls.length = 0;
  await find({ attrs: {}, kids: body }, n => n.tag === 'button' && text(n) === 'Save')[0].onclick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.calls[0])), ['specialist/writer', { provider: 'xai', model: 'grok-4', ifUpdatedAt: 5 }]);
});

test('archiving from the profile leaves the page', async () => {
  const t = await pageSetup({ list: [P('writer', { updatedAt: 5 })] });
  const body = [t.sb.modal];
  const hold = find({ attrs: {}, kids: t.S.termBar(PAGE) }, () => false);
  assert.ok(Array.isArray(hold));
  fire(btn({ attrs: {}, kids: t.S.termBar(PAGE) }, 'Profile'));
  const ask = find({ attrs: {}, kids: body }, () => false);
  assert.ok(Array.isArray(ask));
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

test('the palette ask entry opens the specialist page with the composer focused', async () => {
  const sb = build([P('writer')], []);
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.paletteItems()[1].run();
  assert.strictEqual(sb.opened, PAGE);
});

const commit = (id, o = {}) => ({ id: id.repeat(40).slice(0, 40), short: id.repeat(7), message: 'Shorter greetings', source: 'trainer', at: Date.now(), undoOf: null, undone: false, files: [{ path: 'style.md', change: 'modified' }], ...o });
const TMUX = 'claude-spec-writer_train';
const trainSetup = async (o = {}) => {
  const calls = []; const fetches = []; const toasts = [];
  const overview = { ok: true, trainer: null, history: { ready: true, head: 'a', commits: [commit('a'), commit('b', { source: 'start', message: 'Starting point' })] }, feedback: [], accesses: [{ name: 'DB_URL', note: 'read replica', bytes: 5, updatedAt: 'x' }], uploads: { files: 0, bytes: 0, maxFiles: 500, maxBytes: 209715200 }, ...o.overview };
  const sb = build([P('writer')], o.sessions || [], false, {
    TERM: { open: true, active: TMUX, showList: false },
    feat: (hook, ...a) => Object.values(sb.FEAT).flatMap(f => f[hook] ? [f[hook](...a)] : []).filter(x => x != null && x !== false).flat(),
    document: { hidden: true, body: node('body', {}, []), addEventListener() {}, removeEventListener() {} },
    setTimeout: () => 0,
    toast: (m, k) => toasts.push([m, k]),
    fetch: async (u, init) => { fetches.push([u, init]); return o.fetch ? o.fetch(u, init) : { ok: true, status: 201, json: async () => ({ ok: true, file: { path: 'knowledge/files/a.pdf', bytes: 3 } }) }; },
    api: async (p, body) => {
      calls.push([p, body]);
      if (o.api) { const r = await o.api(p, body); if (r !== undefined) return r; }
      if (p === 'specialist/writer/train') return overview;
      if (p === 'specialists') return { ok: true, specialists: [P('writer')], templates: [] };
      return { ok: true, specialist: { ...P('writer'), instructions: '' }, runs: [], thread: null };
    }
  });
  const field = node('div', {}, []);
  field.insertBefore = c => field.kids.push(c);
  sb.modal.style = { setProperty() {} };
  sb.modal.querySelector = () => field;
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.termShown();
  await new Promise(r => setTimeout(r, 20));
  const tab = label => { fire(find(sb.modal, n => n.tag === 'button' && /segb/.test(n.attrs.class || '') && text(n).startsWith(label))[0]); return sb.modal; };
  return { sb, calls, fetches, toasts, field, tab, box: () => sb.modal };
};
const btn = (box, label) => find(box, n => n.tag === 'button' && text(n).trim() === label)[0];
const fire = (n, ev = 'onclick') => (n[ev] || n.attrs[ev])();
const sentBodies = t => t.calls.filter(c => c[0] === 'specialist/writer/train/send').map(c => JSON.parse(JSON.stringify(c[1])));

test('the create dialog ends in the trainer chat and the specialist dialog has a Train button', async () => {
  const sb = build([P('writer')], [], false);
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.create();
  const box = sb.shown;
  const nameIn = find(box, n => n.attrs.placeholder === 'name, e.g. writer')[0];
  nameIn.value = 'writer'; nameIn.oninput();
  await fire(btn(box, 'Create'));
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(sb.opened, TMUX);
  sb.opened = null;
  sb.FEAT.specialists.open('writer');
  assert.strictEqual(sb.opened, PAGE);
  sb.TERM = { open: true, active: PAGE, showList: false };
  sb.FEAT.specialists.termShown();
  fire(btn({ attrs: {}, kids: sb.FEAT.specialists.termBar(PAGE) }, 'Train'));
  assert.strictEqual(sb.opened, TMUX);
});

test('the company account gets its own trainer session', async () => {
  const sb = build([P('writer', { account: 'company' })], [], false);
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.openTrain('writer');
  assert.strictEqual(sb.opened, 'claude-spec-writer_train-company');
});

test('a trainer that is not running still opens as a chat, with the opening question', async () => {
  const t = await trainSetup();
  const ph = t.sb.FEAT.specialists.phantom(TMUX);
  assert.strictEqual(ph.mode, 'chat');
  assert.strictEqual(t.sb.FEAT.specialists.phantom('claude-spec-ghost_train'), null);
  assert.strictEqual(t.sb.FEAT.specialists.phantom('claude-other'), null);
  assert.match(text(t.sb.FEAT.specialists.emptyChat(TMUX)), /What is this specialist for, and how should it behave\?/);
  assert.strictEqual(t.sb.FEAT.specialists.emptyChat('claude-other'), null);
  assert.strictEqual(t.sb.FEAT.specialists.trainTitle(TMUX), 'Train Writer');
});

test('trainer sends go through train/send, other chats keep the normal path', async () => {
  const st = { busy: true };
  const t = await trainSetup({ api: p => { if (p.endsWith('/train/send')) { if (st.busy) throw Object.assign(new Error('trainer is busy'), { status: 409 }); return { ok: true, trainer: { live: true, state: 'working', turns: 1, tmux: TMUX } }; } } });
  const S = t.sb.FEAT.specialists;
  assert.strictEqual(S.trainSend('claude-other', 'hi'), null);
  await assert.rejects(S.trainSend(TMUX, 'Be brief'), /The trainer is busy with a turn/);
  st.busy = false;
  const bar = S.termBar(TMUX);
  fire(find({ attrs: {}, kids: bar }, n => n.tag === 'button' && /New conversation/.test(text(n)))[0]);
  await S.trainSend(TMUX, 'Be brief');
  await S.trainSend(TMUX, 'Again');
  assert.deepStrictEqual(sentBodies(t), [{ text: 'Be brief' }, { text: 'Be brief', fresh: true }, { text: 'Again' }]);
});

test('attaching in the chat uploads raw bytes, shows a chip and rides on the next send as files', async () => {
  const net = { status: 201 };
  const t = await trainSetup({ fetch: async () => net.status === 201 ? { ok: true, status: 201, json: async () => ({ ok: true, file: { path: 'knowledge/files/a.pdf', bytes: 3 } }) } : { ok: false, status: net.status, statusText: 'x', json: async () => ({ error: ".exe files can't be used for training: save it as PDF or text" }) } });
  const S = t.sb.FEAT.specialists;
  assert.strictEqual(S.attachFile('claude-other', { name: 'a.pdf', size: 3 }), null);
  await S.attachFile(TMUX, { name: 'a b.pdf', size: 3 });
  S.composerShown(t.sb.modal);
  assert.match(t.fetches[0][0], /\/api\/specialist\/writer\/train\/upload\?filename=a%20b\.pdf$/);
  assert.strictEqual(t.fetches[0][1].method, 'POST');
  const chips = find(t.field, n => /sptr-chips/.test(n.attrs.class || ''))[0];
  assert.match(text(chips), /a\.pdf/);
  await S.trainSend(TMUX, 'Read this');
  assert.deepStrictEqual(sentBodies(t), [{ text: 'Read this', files: ['knowledge/files/a.pdf'] }]);
  assert.ok(!text(chips).includes('a.pdf'));
  net.status = 415;
  await assert.rejects(S.attachFile(TMUX, { name: 'x.exe', size: 3 }), /\.exe files can't be used/);
  const before = t.fetches.length;
  await assert.rejects(S.attachFile(TMUX, { name: 'big.pdf', size: 21 * 1024 * 1024 }), /Too big/);
  assert.strictEqual(t.fetches.length, before);
});

test('the panel drop zone uploads through the same path and lists what was added', async () => {
  const t = await trainSetup();
  const box = t.tab('Files');
  const input = find(box, n => n.tag === 'input' && n.attrs.type === 'file')[0];
  assert.ok(find(box, n => /sp-drop/.test(n.attrs.class || '')).length);
  input.files = [{ name: 'notes.txt', size: 3 }];
  await fire(input, 'onchange');
  assert.match(text(t.tab('Files')), /Added in this chat/);
  assert.match(text(t.box()), /a\.pdf/);
});

test('the change list shows source, loads a diff as text and undoes only after confirmation', async () => {
  const t = await trainSetup({ api: p => {
    if (p.startsWith('specialist/writer/train/commit/')) return { ok: true, commit: commit('a'), diff: '@@ -1 +1 @@\n-old <b>x</b>\n+new', truncated: false };
    if (p === 'specialist/writer/train/undo') return { ok: true, commit: commit('c', { source: 'undo' }) };
  } });
  const box = t.tab('What changed');
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
  const box = t.tab('Accesses');
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

test('the chat header shows the trainer status and waiting notes, and the bar key follows them', async () => {
  const t = await trainSetup({ overview: { feedback: [{ id: 'f1', state: 'pending' }] } });
  const S = t.sb.FEAT.specialists;
  assert.match(text({ kids: S.termBar(TMUX) }), /Not started/);
  assert.match(text({ kids: S.termBar(TMUX) }), /1 note waiting/);
  assert.strictEqual(S.termBar('claude-other'), null);
  const before = JSON.stringify(S.termBarKey(TMUX));
  fire(find({ attrs: {}, kids: S.termBar(TMUX) }, n => n.tag === 'button' && /New conversation/.test(text(n)))[0]);
  assert.notStrictEqual(JSON.stringify(S.termBarKey(TMUX)), before);
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
