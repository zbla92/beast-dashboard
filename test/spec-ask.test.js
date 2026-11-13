const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-spec-ask.js'), 'utf8');

const build = (api, extra = {}) => {
  const store = new Map();
  const sandbox = {
    FEAT: { quotes: { blockquote: q => q.split('\n').map(l => '> ' + l).join('\n') } },
    h: (tag, attrs, ...kids) => ({ isConnected: true, tag, attrs: attrs || {}, kids: kids.flat(Infinity), querySelector: () => null, contains: () => false, replaceChildren() {}, remove() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }),
    ico: () => null, toast() {}, mdLite: t => t, api,
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    document: { addEventListener() {}, body: { classList: { toggle() {} } }, querySelectorAll: () => [] },
    setTimeout, store,
    ...extra,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
};

test('fromRun maps run states to card states', () => {
  const { FEAT } = build(async () => ({}));
  const f = FEAT.specAsk.fromRun;
  assert.strictEqual(f({ state: 'working' }).state, 'working');
  assert.strictEqual(f({ state: 'starting' }).state, 'working');
  assert.strictEqual(f({ state: 'waiting' }).state, 'waiting');
  assert.deepStrictEqual({ ...f({ state: 'done', text: 'hi' }) }, { state: 'done', text: 'hi', error: '' });
  assert.strictEqual(f({ state: 'error', error: 'boom' }).error, 'boom');
  assert.match(f({ state: 'stopped' }).error, /stopped/);
});

test('parseCards keeps the last ten, drops junk and fails unsent asks', () => {
  const { FEAT } = build(async () => ({}));
  const many = Array.from({ length: 14 }, (_, i) => ({ id: 'c' + i, session: 's', specialist: 'w', task: 't', state: 'done', text: 'x' }));
  const got = FEAT.specAsk.parseCards(JSON.stringify([...many, null, { id: 1 }, { id: 'u', session: 's', specialist: 'w', task: 't', state: 'asking' }]));
  assert.strictEqual(got.length, 10);
  assert.strictEqual(got[9].state, 'error');
  assert.strictEqual(FEAT.specAsk.parseCards('not json').length, 0);
});

test('messageText joins assistant text steps and taskFor quotes it', () => {
  const { FEAT } = build(async () => ({}));
  assert.strictEqual(FEAT.specAsk.messageText({ role: 'assistant', steps: [{ k: 'text', text: 'a' }, { k: 'tool' }, { k: 'text', text: 'b' }] }), 'a\n\nb');
  assert.strictEqual(FEAT.specAsk.messageText({ role: 'user', text: ' hi ' }), 'hi');
  assert.strictEqual(FEAT.specAsk.taskFor('one\ntwo'), '> one\n> two\n\n');
  assert.strictEqual(FEAT.specAsk.taskFor(''), '');
});

test('ask posts without wait, re-polls on timeout and stores the final text', async () => {
  const calls = [];
  const polls = [{ ok: true, state: 'working', timedOut: true }, { ok: true, state: 'done', text: 'answer', mode: 'run' }];
  const sb = build(async (p, body) => {
    calls.push([p, body]);
    if (p.endsWith('/ask')) return { ok: true, runId: 'claude-spec-w-1', mode: 'run', state: 'working' };
    if (p.startsWith('specialist/run/')) return polls.shift();
    return { ok: true, specialists: [{ name: 'w', title: 'W' }] };
  });
  await sb.FEAT.specAsk.ask({ session: 'claude-x', specialist: 'w', task: '> q' });
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(JSON.stringify(calls[0]), JSON.stringify(['specialist/w/ask', { text: '> q', from: 'claude-x', wait: false }]));
  assert.match(calls[1][0], /^specialist\/run\/claude-spec-w-1\?wait=1&timeoutSec=\d+$/);
  assert.strictEqual(calls.length, 3);
  const saved = JSON.parse(sb.store.get('bd.specask.claude-x'));
  assert.strictEqual(saved[0].state, 'done');
  assert.strictEqual(saved[0].text, 'answer');
  assert.ok(!calls.some(c => c[0] === 'send'));
});

const seenSpy = () => { const marked = []; return { marked, FEAT: { quotes: { blockquote: q => q }, specialists: { markSeen: (id, at) => marked.push([id, at]) } } }; };
const runAsk = async (sb, session = 'claude-x') => {
  await sb.FEAT.specAsk.ask({ session, specialist: 'w', task: '> q' });
  await new Promise(r => setTimeout(r, 50));
};

test('a card whose chat is visible marks its run seen when it ends', async () => {
  const spy = seenSpy();
  const sb = build(async p => p.endsWith('/ask') ? { ok: true, runId: 'r1', mode: 'run', state: 'working' } : p.startsWith('specialist/run/') ? { ok: true, state: 'done', text: 'a', endedAt: 77 } : { ok: true, specialists: [] }, { FEAT: spy.FEAT });
  sb.FEAT.specAsk.convTail('claude-x');
  await runAsk(sb);
  sb.FEAT.specAsk.convTail('claude-x');
  assert.ok(spy.marked.some(m => m[0] === 'r1' && m[1] === 77));
});

test('a card whose chat is not on screen leaves the run for the Inbox', async () => {
  const spy = seenSpy();
  const sb = build(async p => p.endsWith('/ask') ? { ok: true, runId: 'r1', mode: 'run', state: 'working' } : p.startsWith('specialist/run/') ? { ok: true, state: 'done', text: 'a', endedAt: 77 } : { ok: true, specialists: [] }, { FEAT: spy.FEAT });
  sb.h = (tag, attrs, ...kids) => ({ isConnected: false, tag, attrs: attrs || {}, kids: kids.flat(Infinity), querySelector: () => null, contains: () => false, replaceChildren() {}, remove() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
  await runAsk(sb);
  assert.strictEqual(spy.marked.length, 0);
});

test('the poll limiter allows one long poll at a time and frees it on release', () => {
  const { FEAT } = build(async () => ({}));
  const l = FEAT.specAsk.createLimiter(1);
  assert.strictEqual(l.acquire('a'), true);
  assert.strictEqual(l.acquire('a'), true);
  assert.strictEqual(l.acquire('b'), false);
  l.release('a');
  assert.strictEqual(l.acquire('b'), true);
  assert.strictEqual(l.size(), 1);
});

test('with several cards only one request uses wait=1', async () => {
  const waits = [];
  const st = { open: 0, peak: 0 };
  const sb = build(async p => {
    if (p.endsWith('/ask')) return { ok: true, runId: 'r' + waits.length + Math.random(), mode: 'run', state: 'working' };
    if (p.startsWith('specialist/run/')) {
      const long = p.includes('wait=1');
      if (long) { st.open += 1; st.peak = Math.max(st.peak, st.open); await new Promise(r => setTimeout(r, 30)); st.open -= 1; }
      waits.push(long);
      return { ok: true, state: waits.length > 8 ? 'done' : 'working', text: '' };
    }
    return { ok: true, specialists: [] };
  });
  await Promise.all(['a', 'b', 'c'].map(n => sb.FEAT.specAsk.ask({ session: 'claude-' + n, specialist: 'w', task: 'q' })));
  await new Promise(r => setTimeout(r, 200));
  assert.ok(st.peak <= 1);
  assert.ok(waits.some(w => w));
});

test('backoff grows from two seconds to thirty and index keeps the newest sessions', () => {
  const { FEAT } = build(async () => ({}));
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 20].map(FEAT.specAsk.backoff), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  const t = FEAT.specAsk.touchIndex(['a', 'b', 'c'], 'a', 3);
  assert.deepStrictEqual(Array.from(t.index), ['b', 'c', 'a']);
  const u = FEAT.specAsk.touchIndex(['a', 'b', 'c'], 'd', 3);
  assert.deepStrictEqual(Array.from(u.dropped), ['a']);
});

test('stored cards are slimmed, truncated text is flagged and the session index is capped', async () => {
  const sb = build(async p => p.endsWith('/ask') ? { ok: true, runId: 'r1', mode: 'run', state: 'done', text: 'x'.repeat(70000) } : { ok: true, specialists: [] });
  await sb.FEAT.specAsk.ask({ session: 'claude-big', specialist: 'w', task: 't'.repeat(9000) });
  const saved = JSON.parse(sb.store.get('bd.specask.claude-big'));
  assert.strictEqual(saved[0].task.length, 4000);
  assert.strictEqual(saved[0].text.length, 60000);
  assert.strictEqual(saved[0].truncated, true);
  for (const n of Array.from({ length: 35 }, (_, i) => 'claude-s' + i)) await sb.FEAT.specAsk.ask({ session: n, specialist: 'w', task: 't' });
  assert.strictEqual(JSON.parse(sb.store.get('bd.specask.index')).length, 30);
  assert.ok(!sb.store.has('bd.specask.claude-big'));
});

test('a done card has no Improve action and Open run points at the call chat', async () => {
  const opened = [];
  const feat = { quotes: { blockquote: q => q }, specialists: { markSeen() {}, openRun: r => opened.push(r) } };
  const sb = build(async p => p.endsWith('/ask') ? { ok: true, runId: 'claude-spec-w-261111-0930', mode: 'run', state: 'done', text: 'answer', endedAt: 5 } : { ok: true, specialists: [{ name: 'w', title: 'W' }] }, { FEAT: feat });
  const nodes = [];
  sb.h = (tag, attrs, ...kids) => { const n = { isConnected: true, tag, attrs: attrs || {}, kids: kids.flat(Infinity), querySelector: () => null, contains: () => false, replaceChildren(...k) { n.kids = k.flat(Infinity); }, remove() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }; nodes.push(n); return n; };
  await sb.FEAT.specAsk.ask({ session: 'claude-x', specialist: 'w', task: 'q' });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!nodes.some(n => n.tag === 'button' && n.kids.includes('Improve')));
  const open = nodes.filter(n => n.tag === 'button' && n.kids.includes('Open run')).pop();
  assert.ok(open);
  open.attrs.onclick();
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(opened[0].runId, 'claude-spec-w-261111-0930');
  assert.strictEqual(opened[0].specialist, 'w');
});

test('the ask request names the calling session', async () => {
  const calls = [];
  const sb = build(async (p, body) => { calls.push([p, body]); return p.endsWith('/ask') ? { ok: true, runId: 'r1', mode: 'run', state: 'done', text: 'a' } : { ok: true, specialists: [] }; });
  await sb.FEAT.specAsk.ask({ session: 'claude-x', specialist: 'w', task: 'q' });
  assert.strictEqual(calls[0][1].from, 'claude-x');
});



const chatTurns = () => [
  { role: 'user', text: 'first question' },
  { role: 'assistant', steps: [{ k: 'text', text: 'first answer' }, { k: 'tool', file: '/repo/a.js' }, { k: 'tool', file: 'rel.js' }] },
  { role: 'user', text: 'second question' },
  { role: 'assistant', steps: [{ k: 'tool', file: '/repo/b.js' }, { k: 'tool', file: '/repo/a.js' }, { k: 'text', text: 'the message' }] },
];

test('buildContext keeps the turns up to the message verbatim, marks it and lists absolute files newest first', () => {
  const { FEAT } = build(async () => ({}));
  const c = FEAT.specAsk.buildContext(chatTurns(), 3, 60000);
  assert.strictEqual(c.count, 4);
  assert.strictEqual(c.text, '[User]\nfirst question\n\n[Assistant]\nfirst answer\n\n[User]\nsecond question\n\n[Assistant, the message this task is about]\nthe message');
  assert.deepStrictEqual([...c.files], ['/repo/a.js', '/repo/b.js']);
});

test('buildContext keeps the newest turns when the budget is small and the end of an over-long message', () => {
  const { FEAT } = build(async () => ({}));
  const turns = chatTurns();
  const small = FEAT.specAsk.buildContext(turns, 3, 90);
  assert.ok(small.count < 4 && small.text.endsWith('the message') && small.text.length <= 90);
  const long = [{ role: 'assistant', steps: [{ k: 'text', text: 'x'.repeat(500) + 'END' }] }];
  const cut = FEAT.specAsk.buildContext(long, 0, 100);
  assert.ok(cut.text.length <= 100 && cut.text.endsWith('END') && cut.text.includes('[cut'));
  assert.strictEqual(FEAT.specAsk.buildContext(turns, 3, 0), null);
  assert.strictEqual(FEAT.specAsk.buildContext(turns, 9, 1000), null);
});

test('buildContext looks back at most six turns and caps files at twenty', () => {
  const { FEAT } = build(async () => ({}));
  const many = Array.from({ length: 10 }, (_, i) => ({ role: 'user', text: 'u' + i }));
  assert.strictEqual(FEAT.specAsk.buildContext(many, 9, 60000).count, 6);
  const files = [{ role: 'assistant', steps: [...Array.from({ length: 30 }, (_, i) => ({ k: 'tool', file: '/f' + i })), { k: 'text', text: 'm' }] }];
  assert.strictEqual(FEAT.specAsk.buildContext(files, 0, 60000).files.length, 20);
});

test('ask sends the task, the original material and the files; without them the text is unchanged', async () => {
  const calls = [];
  const sb = build(async (p, body) => {
    calls.push([p, body]);
    if (p.endsWith('/ask')) return { ok: true, runId: 'r1', mode: 'run', state: 'done', text: 'a' };
    return { ok: true, specialists: [] };
  });
  await sb.FEAT.specAsk.ask({ session: 's', specialist: 'w', task: 'Do it', material: '[User]\nhi', files: ['/a'] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0])), ['specialist/w/ask', { text: 'Task:\nDo it\n\nOriginal material (verbatim, from the chat):\n[User]\nhi', from: 's', wait: false, files: ['/a'] }]);
  await sb.FEAT.specAsk.ask({ session: 's', specialist: 'w', task: 'Plain', material: '', files: [] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[1])), ['specialist/w/ask', { text: 'Plain', from: 's', wait: false }]);
});

test('materialBudget uses the real length of the file list and the whole text stays within 100000', () => {
  const { FEAT } = build(async () => ({}));
  const a = FEAT.specAsk;
  const task = 'x'.repeat(10000);
  const none = a.materialBudget(task, []);
  const longFiles = Array.from({ length: 20 }, (_, i) => '/' + String(i).padStart(2, '0') + 'a'.repeat(4000));
  const many = a.materialBudget(task, longFiles);
  assert.ok(many > 0 && many < none);
  assert.strictEqual(a.fileSuffix([]), '');
  assert.strictEqual(a.fileSuffix(['/a', '/b']), '\n\nFiles for this task:\n- /a\n- /b');
  const material = 'm'.repeat(Math.max(0, many));
  assert.ok((a.composeTask(task, material) + a.fileSuffix(longFiles)).length <= 100000);
  assert.ok(a.materialBudget('t', ['/a']) <= 60000);
  assert.ok(a.materialBudget('x'.repeat(99990), ['/a']) <= 0);
});

test('openai and xai specialists take no files', () => {
  const { FEAT } = build(async () => ({}));
  const a = FEAT.specAsk;
  assert.strictEqual(a.takesFiles({ provider: 'openai' }), false);
  assert.strictEqual(a.takesFiles({ provider: 'xai' }), false);
  assert.strictEqual(a.takesFiles({ provider: 'claude' }), true);
  assert.strictEqual(a.takesFiles(undefined), true);
});
