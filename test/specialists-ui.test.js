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
    window: {}, sessTitle: s => s.name, renderChatPane() {}, openMenu() {}, closeMenu() {}, openSession() {}, toast() {}, renderRail() {}, renderTermPanel() {}, openTerm(n) { sandbox.opened = n; }, claudeOf: () => null, PENDING: {}, uploadFile: async f => '/pasted/' + f.name, closeTermPanel() { sandbox.left = true; },
    document: { hidden: true, addEventListener() {}, removeEventListener() {} }, setInterval: () => 0, clearInterval() {}, setTimeout,
  };
  modal.replaceChildren = (...k) => { sandbox.shown = k[0]; };
  Object.assign(sandbox, extra);
  vm.createContext(sandbox);
  vm.runInContext(read('f-specialists.js'), sandbox);
  return sandbox;
};

const P = (name, o = {}) => ({ name, title: name[0].toUpperCase() + name.slice(1), icon: '✎', description: 'does ' + name, model: 'sonnet', mode: 'run', active: 0, lastRun: null, thread: null, ...o });

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
const TMUX = 'claude-spec-writer-261111-0930';
const call = (id, o = {}) => ({ runId: id, specialist: 'writer', tmux: id, mode: 'run', state: 'done', task: 'Reply to Ana\nmore', caller: null, startedAt: Date.now(), endedAt: Date.now() + 5000, ...o });
const callRows = els => railRows(els).filter(r => /k-spec-run/.test(r.attrs.class));
const botRows = els => railRows(els).filter(r => !/k-spec-run/.test(r.attrs.class));
const rowTitle = r => text(r.kids.find(k => k.attrs.class === 'rtx').kids[0].kids[0]);
const withSession = (sessions, extra = {}) => ({ sessTitle: s => 'Title of ' + s.name, ...extra, S: { runtime: { sessions } } });

test('the rail section is Bots, alphabetical by name whatever the state, with model chip and open call count', async () => {
  const sb = build([P('writer', { active: 2, model: 'opus', thread: { tmux: 'claude-spec-writer', state: 'working' } }), P('editor'), P('arch', { thread: { tmux: 'claude-spec-arch', state: 'idle' } })], []);
  await sb.FEAT.specialists.refresh(true);
  const els = sb.FEAT.specialists.railSection('rail');
  const rows = botRows(els);
  assert.deepStrictEqual(rows.map(rowTitle), ['Arch', 'Editor', 'Writer']);
  assert.match(text(rows[2]), /opus/);
  assert.strictEqual(find(rows[2], n => n.attrs.class === 'rage').length, 1);
  assert.strictEqual(find(rows[0], n => n.attrs.class === 'rage').length, 0);
  assert.match(text(els[0]), /Bots\s+3/);
  assert.doesNotMatch(text(els[0]), /Specialists/);
});

test('a bot row opens its chat through the bots feature and falls back to the chat route', async () => {
  const opened = [];
  const withBots = build([P('writer')], [], false, { FEAT: { bots: { openChat: n => opened.push(n) } } });
  await withBots.FEAT.specialists.refresh(true);
  botRows(withBots.FEAT.specialists.railSection('rail'))[0].attrs.onclick();
  assert.deepStrictEqual(opened, ['writer']);
  const sb = build([P('writer')], [], false, { openTerm: n => { sb.session = n; } });
  sb.api = async (p, body) => { sb.calls.push([p, body]); return p === 'specialists' ? { ok: true, specialists: [P('writer')], templates: [] } : { ok: true, started: true, thread: { tmux: 'claude-spec-writer' } }; };
  await sb.FEAT.specialists.refresh(true);
  botRows(sb.FEAT.specialists.railSection('rail'))[0].attrs.onclick();
  await new Promise(r => setTimeout(r, 10));
  assert.ok(sb.calls.some(c => c[0] === 'specialist/writer/chat'));
  assert.strictEqual(sb.session, 'claude-spec-writer');
});

test('under a bot the rail shows at most 5 live calls from recentCalls in the given order, as two-line rows, and no finished ones', async () => {
  const recent = Array.from({ length: 8 }, (_, i) => call('claude-spec-writer-26111' + i + '-0930', { task: 'Task number ' + i, state: i === 0 ? 'starting' : 'working' }));
  const finishedCall = call('claude-spec-writer-261119-0930', { task: 'Finished', state: 'done' });
  const sb = build([P('writer', { recentCalls: [finishedCall, ...recent, call('claude-spec-writer', { mode: 'thread', state: 'working' })] }), P('arch', { recentCalls: [call('claude-spec-arch-261111-0930', { specialist: 'arch', task: 'Other', state: 'working' }), call('claude-spec-arch-261111-0931', { specialist: 'arch', task: 'Old' })] })], []);
  await sb.FEAT.specialists.refresh(true);
  const rows = railRows(sb.FEAT.specialists.railSection('rail'));
  assert.deepStrictEqual(rows.map(r => /k-spec-run/.test(r.attrs.class) ? 'call' : 'bot'), ['bot', 'call', 'bot', 'call', 'call', 'call', 'call', 'call']);
  const writerCalls = rows.slice(3).map(r => text(r.kids.find(k => k.attrs.class === 'rtx').kids[0]).trim());
  assert.deepStrictEqual(writerCalls, ['Task number 0', 'Task number 1', 'Task number 2', 'Task number 3', 'Task number 4']);
  assert.match(rows[3].attrs.class, /st-working/);
  assert.match(rows[4].attrs.class, /st-working/);
  assert.strictEqual(find(rows[3], n => n.attrs.class === 'rln2').length, 1);
});

test('a call row opens the call as a chat under its run id', async () => {
  const sb = build([P('writer', { recentCalls: [call(TMUX, { state: 'working' })] })], []);
  await sb.FEAT.specialists.refresh(true);
  callRows(sb.FEAT.specialists.railSection('rail'))[0].attrs.onclick();
  assert.strictEqual(sb.opened, TMUX);
});

test('the called from line uses the caller title, falls back to the tmux name and says outside the dashboard for no caller', async () => {
  const list = [P('writer', { recentCalls: [call(TMUX, { caller: 'claude-ana', state: 'working' }), call('claude-spec-writer-261111-0931', { caller: 'claude-gone', state: 'working' }), call('claude-spec-writer-261111-0932', { state: 'working' })] })];
  const sb = build(list, [], false, withSession([{ name: 'claude-ana' }]));
  await sb.FEAT.specialists.refresh(true);
  const subs = callRows(sb.FEAT.specialists.railSection('rail')).map(r => text(find(r, n => n.attrs.class === 'rsub')[0]));
  assert.deepStrictEqual(subs, ['called from Title of claude-ana', 'called from claude-gone', 'called from outside the dashboard']);
  const bar = name => text(sb.FEAT.specialists.chatBar(name));
  assert.strictEqual(bar(TMUX), 'called from Title of claude-ana');
  assert.strictEqual(bar('claude-spec-writer-261111-0931'), 'called from claude-gone');
  assert.strictEqual(bar('claude-spec-writer-261111-0932'), 'called from outside the dashboard');
});

test('the chat bar belongs to calls only and loads a call it does not know yet', async () => {
  const fetched = [];
  const sb = build([P('writer')], [], false, withSession([], { api: async p => { fetched.push(p); return p === 'specialists' ? { ok: true, specialists: [P('writer')], templates: [] } : { ok: true, ...call(TMUX, { caller: null }) }; } }));
  await sb.FEAT.specialists.refresh(true);
  assert.strictEqual(sb.FEAT.specialists.chatBar('claude-spec-writer'), null);
  assert.strictEqual(sb.FEAT.specialists.chatBar('claude-x'), null);
  assert.strictEqual(sb.FEAT.specialists.chatBar(TMUX), null);
  await new Promise(r => setTimeout(r, 10));
  assert.ok(fetched.includes('specialist/run/' + TMUX));
  assert.strictEqual(text(sb.FEAT.specialists.chatBar(TMUX)), 'called from outside the dashboard');
});

const composer = tmux => {
  const reply = { placeholder: 'message', disabled: false, dataset: {} };
  const send = { disabled: false };
  return { reply, send, box: { dataset: { chat: tmux }, querySelector: sel => sel === '.creply' ? reply : null, querySelectorAll: sel => sel === '.csend' ? [send] : [] } };
};

test('the composer of a live call is disabled until it has a result', async () => {
  const live = build([P('writer', { recentCalls: [call(TMUX, { state: 'working' })] })], []);
  await live.FEAT.specialists.refresh(true);
  const c = composer(TMUX);
  live.FEAT.specialists.composerShown(c.box);
  assert.strictEqual(c.reply.disabled, true);
  assert.strictEqual(c.send.disabled, true);
  assert.match(c.reply.placeholder, /still working/);
  const done = build([P('writer', { recentCalls: [call(TMUX, { state: 'done' })] })], []);
  await done.FEAT.specialists.refresh(true);
  const d = composer(TMUX);
  done.FEAT.specialists.composerShown(d.box);
  assert.strictEqual(d.reply.disabled, false);
  assert.strictEqual(d.send.disabled, false);
  assert.strictEqual(d.reply.placeholder, 'message');
  const own = composer('claude-spec-writer');
  live.FEAT.specialists.composerShown(own.box);
  assert.strictEqual(own.reply.disabled, false);
});

test('a composer locked for a live call opens again once the call has a result', async () => {
  const sb = build([P('writer', { recentCalls: [call(TMUX, { state: 'working' })] })], []);
  await sb.FEAT.specialists.refresh(true);
  const c = composer(TMUX);
  sb.FEAT.specialists.composerShown(c.box);
  assert.strictEqual(c.reply.disabled, true);
  sb.api = async p => p === 'specialists' ? { ok: true, specialists: [P('writer', { recentCalls: [call(TMUX, { state: 'done' })] })], templates: [] } : { ok: true };
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.composerShown(c.box);
  assert.strictEqual(c.reply.disabled, false);
  assert.strictEqual(c.reply.placeholder, 'message');
});

test('the chat pane is repainted when a call turns final while a chat is open', async () => {
  const painted = [];
  const sb = build([P('writer', { recentCalls: [call(TMUX, { state: 'working' })] })], [], false, { renderChatPane: f => painted.push(f) });
  sb.TERM.open = true;
  await sb.FEAT.specialists.refresh(true);
  painted.length = 0;
  sb.api = async p => p === 'specialists' ? { ok: true, specialists: [P('writer', { recentCalls: [call(TMUX, { state: 'done' })] })], templates: [] } : { ok: true };
  await sb.FEAT.specialists.refresh(true);
  assert.deepStrictEqual(painted, [false]);
  await sb.FEAT.specialists.refresh(true);
  assert.deepStrictEqual(painted, [false]);
});

test('continuing a call posts to its send route without waiting and other chats are left to the normal send', async () => {
  const sb = build([P('writer', { recentCalls: [call(TMUX)] })], []);
  await sb.FEAT.specialists.refresh(true);
  sb.calls.length = 0;
  await sb.FEAT.specialists.sendCall(TMUX, 'and also this');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.calls[0])), ['specialist/run/' + TMUX + '/send', { text: 'and also this', wait: false }]);
  assert.strictEqual(sb.FEAT.specialists.sendCall('claude-spec-writer', 'hi'), null);
  assert.strictEqual(sb.FEAT.specialists.sendCall('claude-x', 'hi'), null);
});

test('a finished call is a phantom chat and the thread chat is not', async () => {
  const sb = build([P('writer', { recentCalls: [call(TMUX)] })], []);
  await sb.FEAT.specialists.refresh(true);
  assert.strictEqual(sb.FEAT.specialists.phantom(TMUX).mode, 'chat');
  assert.strictEqual(sb.FEAT.specialists.phantom('claude-spec-writer'), null);
  assert.strictEqual(sb.FEAT.specialists.termTitle(TMUX), 'Reply to Ana');
  assert.strictEqual(sb.FEAT.specialists.termTitle('claude-spec-writer'), 'Writer');
  assert.strictEqual(sb.FEAT.specialists.termTitle('claude-x'), null);
});

test('the bot chat header has the icon and name, a Calls menu and a settings gear, and a call header has no menu', async () => {
  const settings = [];
  const sb = build([P('writer', { iconColor: '#336699', iconGlyph: 'W' })], [], false, { FEAT: { botSettings: { open: n => settings.push(n) } } });
  await sb.FEAT.specialists.refresh(true);
  const bar = sb.FEAT.specialists.termBar('claude-spec-writer');
  assert.strictEqual(bar.length, 3);
  assert.match(text(bar[0]), /Writer/);
  assert.strictEqual(find(bar[0], n => n.attrs.class === 'sp-tile').length, 1);
  assert.match(text(bar[1]), /Calls/);
  bar[2].attrs.onclick();
  assert.deepStrictEqual(settings, ['writer']);
  assert.strictEqual(sb.FEAT.specialists.termBar(TMUX).length, 1);
  assert.strictEqual(sb.FEAT.specialists.termBar('claude-x'), null);
});

test('the bot icon comes from BOT_ICON when it is there', async () => {
  const sizes = [];
  const sb = build([P('writer')], [], false, { window: { BOT_ICON: { tile: (p, px) => { sizes.push([p.name, px]); return { nodeType: 1, tag: 'svg', attrs: { class: 'bot-tile' }, kids: [] }; } } } });
  await sb.FEAT.specialists.refresh(true);
  const bar = sb.FEAT.specialists.termBar('claude-spec-writer');
  assert.strictEqual(find(bar[0], n => n.attrs.class === 'bot-tile').length, 1);
  assert.deepStrictEqual(sizes, [['writer', 24]]);
});

test('the Calls menu lists the calls of the bot newest first, runs only, as their own chats', async () => {
  const menus = [];
  const runs = [call('claude-spec-writer-261111-0900', { startedAt: 1, task: 'Oldest' }), call('claude-spec-writer-261111-1000', { startedAt: 3, task: 'Newest', state: 'working', caller: 'claude-ana' }), call('claude-spec-writer', { mode: 'thread', startedAt: 9 }), call('claude-spec-writer-261111-0930', { startedAt: 2, task: 'Middle' })];
  const sb = build([P('writer')], [], false, withSession([{ name: 'claude-ana' }], { openMenu: (ev, items) => menus.push([ev, items]) }));
  sb.api = async p => p === 'specialists' ? { ok: true, specialists: [P('writer')], templates: [] } : { ok: true, runs };
  await sb.FEAT.specialists.refresh(true);
  const bar = sb.FEAT.specialists.termBar('claude-spec-writer');
  bar[1].attrs.onclick({ currentTarget: 'anchor' });
  await new Promise(r => setTimeout(r, 10));
  const items = menus[0][1];
  assert.strictEqual(menus[0][0].currentTarget, 'anchor');
  assert.deepStrictEqual(items.map(i => text(find(i.el, n => n.attrs.class === 'sp-callmi-t')[0])), ['Newest', 'Middle', 'Oldest']);
  assert.strictEqual(text(find(items[0].el, n => /sp-callmi-s/.test(n.attrs.class))[0]), 'called from Title of claude-ana');
  assert.match(find(items[0].el, n => /sp-dot/.test(n.attrs.class || ''))[0].attrs.class, /rs-working/);
  items[0].el.attrs.onclick();
  assert.strictEqual(sb.opened, 'claude-spec-writer-261111-1000');
});

test('the Calls menu says so when there are no calls', async () => {
  const menus = [];
  const sb = build([P('writer')], [], false, withSession([], { openMenu: (ev, items) => menus.push(items) }));
  await sb.FEAT.specialists.refresh(true);
  sb.FEAT.specialists.termBar('claude-spec-writer')[1].attrs.onclick({ currentTarget: 'a' });
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(menus[0][0].label, 'No calls yet');
});

test('the main bot view has no Train panel, Profile tab, upload chips or Used as select', () => {
  const src = read('f-specialists.js');
  for (const gone of ['sptr', 'Train', 'Profile', 'trainSend', 'attachFile', 'sp-drop']) assert.ok(!src.includes(gone), gone);
  assert.ok(!/'[^']*Specialist[^']*'/.test(src));
});

test('new bot always goes through the bots create dialog; there is no old create form', () => {
  const src = read('f-specialists.js');
  for (const gone of ['openCreate', 'Used as', 'USE_NOTE', 'Fresh run per task', 'spcreate']) assert.ok(!src.includes(gone), gone);
  const css = read('f-specialists.css');
  for (const gone of ['spcreate', 'sp-usebox', 'sp-row', 'sp-body']) assert.ok(!css.includes(gone), gone);
  const sb = build([P('writer')], []);
  assert.doesNotThrow(() => sb.FEAT.specialists.create());
  assert.strictEqual(sb.shown, null);
  const made = [];
  sb.FEAT.bots = { create: () => made.push('bots') };
  sb.FEAT.specialists.create();
  assert.deepStrictEqual(made, ['bots']);
  assert.strictEqual(sb.shown, null);
});

test('the palette offers one bot entry per valid bot', async () => {
  const sb = build([P('writer'), { name: 'broken', error: 'x' }], []);
  await sb.FEAT.specialists.refresh(true);
  assert.deepStrictEqual(Array.from(sb.FEAT.specialists.paletteItems(), i => i.label), ['Bot: Writer']);
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
  const before = Number(localStorage.m.get('bd.spec.since'));
  Array.from({ length: 260 }, (_, i) => i).forEach(i => sb.FEAT.specialists.dismissRun('r' + i));
  const stored = JSON.parse(localStorage.m.get('bd.spec.seen'));
  assert.strictEqual(stored.length, 200);
  assert.strictEqual(stored[0].id, 'r60');
  const since = Number(localStorage.m.get('bd.spec.since'));
  assert.ok(since >= before);
  assert.ok(since <= Math.min(...stored.map(e => e.endedAt)));
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

