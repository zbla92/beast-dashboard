const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const chatsSrc = pub('f-chats.js');
const appSrc = pub('app.js');
const apiSrc = appSrc.slice(appSrc.indexOf('async function api('), appSrc.indexOf('function toast('));
const cacheGlue = appSrc.slice(appSrc.indexOf('const CHAT_FIRST_N'), appSrc.indexOf('async function transcriptOf('));

const fakeLocal = () => {
  const data = new Map();
  const calls = { put: [], del: [] };
  return {
    data, calls,
    LOCAL: {
      get: async key => data.has(key) ? structuredClone(data.get(key)) : null,
      put: async (key, d, ver) => {
        if (JSON.stringify(d).length > 1048576) return false;
        calls.put.push(key);
        data.set(key, { f: 1, at: Date.now(), ver: ver || null, data: structuredClone(d) });
        return true;
      },
      del: async key => { calls.del.push(key); data.delete(key); },
      keys: async () => [...data.keys()],
    },
  };
};

const boot = () => {
  const fl = fakeLocal();
  const window = {};
  const ctx = { window, LOCAL: fl.LOCAL, structuredClone, JSON, Date, Promise, Map, Set, TextEncoder, setTimeout, clearTimeout, Array };
  vm.createContext(ctx);
  vm.runInContext(chatsSrc, ctx);
  return { CHATS: window.CHATS, ...fl };
};

const page = (n, extra = {}) => ({ sig: 's' + n, total: 3, turns: [{ role: 'user', text: 'hi ' + n }], ...extra });
const names = fl => fl.data.get('chats').data.map(e => e.name);

test('save stores the page as received and the name in the MRU list', async () => {
  const t = boot();
  const p = page(1);
  await t.CHATS.save('a', p, 'v1');
  assert.deepStrictEqual(t.data.get('chat:a').data, p);
  assert.strictEqual(t.data.get('chat:a').ver, 'v1');
  assert.deepStrictEqual(names(t), ['a']);
});

test('load returns the cached payload and null for unknown or malformed entries', async () => {
  const t = boot();
  await t.CHATS.save('a', page(1), 'v');
  assert.deepStrictEqual(await t.CHATS.load('a', 300), page(1));
  assert.strictEqual(await t.CHATS.load('zzz', 300), null);
  t.data.set('chat:bad', { f: 1, at: 1, ver: null, data: { nothing: true } });
  assert.strictEqual(await t.CHATS.load('bad', 300), null);
});

test('the 11th chat evicts the oldest and its chat key', async () => {
  const t = boot();
  for (const i of Array.from({ length: 11 }, (_, k) => k)) await t.CHATS.save('c' + i, page(i), 'v');
  assert.strictEqual(names(t).length, 10);
  assert.strictEqual(names(t)[0], 'c10');
  assert.ok(!names(t).includes('c0'));
  assert.ok(!t.data.has('chat:c0'));
  assert.ok(t.data.has('chat:c1'));
});

test('saving an existing chat moves it to the front without duplicating', async () => {
  const t = boot();
  for (const n of ['a', 'b', 'c']) await t.CHATS.save(n, page(n.charCodeAt(0)), 'v');
  await t.CHATS.save('a', page(99), 'v');
  assert.deepStrictEqual(names(t), ['a', 'c', 'b']);
});

test('an unchanged payload is not rewritten within a minute', async () => {
  const t = boot();
  await t.CHATS.save('a', page(1), 'v');
  const n = t.calls.put.length;
  await t.CHATS.save('a', page(1), 'v');
  assert.strictEqual(t.calls.put.length, n);
  await t.CHATS.save('a', page(2), 'v');
  assert.ok(t.calls.put.length > n);
});

test('a payload over 512 KB is not stored and removes the older copy', async () => {
  const t = boot();
  await t.CHATS.save('a', page(1), 'v');
  const big = page(2, { turns: [{ role: 'user', text: 'x'.repeat(524288) }] });
  assert.strictEqual(await t.CHATS.save('a', big, 'v'), false);
  assert.ok(!t.data.has('chat:a'));
  assert.deepStrictEqual(names(t), []);
});

test('the size limit counts bytes, not characters', async () => {
  const t = boot();
  const wide = page(1, { turns: [{ role: 'user', text: 'š'.repeat(300000) }] });
  await t.CHATS.save('a', wide, 'v');
  assert.ok(!t.data.has('chat:a'));
});

test('empty and failed payloads are never stored', async () => {
  const t = boot();
  await t.CHATS.save('a', { total: 0, turns: [], empty: true }, 'v');
  await t.CHATS.save('b', null, 'v');
  await t.CHATS.save('c', { sig: 1 }, 'v');
  assert.strictEqual(t.data.size, 0);
});

test('prune deletes entries whose session is gone and keeps the rest', async () => {
  const t = boot();
  for (const n of ['a', 'b', 'c']) await t.CHATS.save(n, page(n.charCodeAt(0)), 'v');
  await t.CHATS.prune(['a', 'c', 'other']);
  assert.deepStrictEqual(names(t).sort(), ['a', 'c']);
  assert.ok(!t.data.has('chat:b'));
  assert.ok(t.data.has('chat:a'));
});

test('drop removes the key and the list entry', async () => {
  const t = boot();
  await t.CHATS.save('a', page(1), 'v');
  await t.CHATS.save('b', page(2), 'v');
  await t.CHATS.drop('a');
  assert.ok(!t.data.has('chat:a'));
  assert.deepStrictEqual(names(t), ['b']);
});

const bootGlue = (over = {}) => {
  const log = { saved: [], painted: [], dropped: [], bars: [], off: 0 };
  const CHATS = {
    load: async () => over.cached === undefined ? { turns: [1] } : over.cached,
    save: (n, t, v) => log.saved.push([n, v]),
    drop: n => log.dropped.push(n),
    barOn: (b, text) => log.bars.push(text),
    barOff: () => log.off++,
  };
  const api = over.api || (async () => ({ turns: [] }));
  const box = { replaceChildren() {}, dataset: { chat: 'x' } };
  const ctx = { window: { CHATS }, CHATS, api, MY_VER: 'ver' };
  vm.createContext(ctx);
  vm.runInContext(cacheGlue, ctx);
  return { ctx, log, box };
};

test('fetchTranscript saves only the first page', async () => {
  const t = bootGlue();
  await t.ctx.fetchTranscript('a', 40);
  await t.ctx.fetchTranscript('a', 80);
  assert.deepStrictEqual(t.log.saved, [['a', 'ver']]);
});

test('cachedFirst paints the cached page and shows the updating bar', async () => {
  const t = bootGlue();
  const run = t.ctx.cachedFirst(t.box, 'a', 40, () => true, ct => t.log.painted.push(ct));
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(run.shown, true);
  assert.deepStrictEqual(t.log.painted, [{ turns: [1] }]);
  assert.deepStrictEqual(t.log.bars, ['updating…']);
});

test('cachedFirst ignores the cache once the network answered', async () => {
  const t = bootGlue();
  const run = t.ctx.cachedFirst(t.box, 'a', 40, () => true, ct => t.log.painted.push(ct));
  run.open = false;
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(run.shown, false);
  assert.deepStrictEqual(t.log.painted, []);
});

test('cachedFirst skips pages other than the first and a changed view', async () => {
  const t = bootGlue();
  const later = t.ctx.cachedFirst(t.box, 'a', 80, () => true, ct => t.log.painted.push(ct));
  const moved = t.ctx.cachedFirst(t.box, 'a', 40, () => false, ct => t.log.painted.push(ct));
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(later.open, false);
  assert.strictEqual(moved.shown, false);
  assert.deepStrictEqual(t.log.painted, []);
});

test('a cached payload whose render throws is deleted and not marked shown', async () => {
  const t = bootGlue();
  const run = t.ctx.cachedFirst(t.box, 'a', 40, () => true, () => { throw new Error('old build'); });
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(run.shown, false);
  assert.deepStrictEqual(t.log.dropped, ['a']);
  assert.deepStrictEqual(t.log.bars, []);
});

test('a missing cache entry paints nothing', async () => {
  const t = bootGlue({ cached: null });
  const run = t.ctx.cachedFirst(t.box, 'a', 40, () => true, ct => t.log.painted.push(ct));
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(run.shown, false);
  assert.deepStrictEqual(t.log.bars, []);
});

test('prune also removes chat keys that are not in the list', async () => {
  const t = boot();
  await t.CHATS.save('a', page(1), 'v1');
  t.data.set('chat:orphan', { f: 1, at: 1, ver: 'v1', data: page(2) });
  t.data.set('other', { f: 1, at: 1, ver: 'v1', data: {} });
  await t.CHATS.prune(['a', 'orphan']);
  assert.ok(t.data.has('chat:a'));
  assert.ok(!t.data.has('chat:orphan'));
  assert.ok(t.data.has('other'));
});

test('cachedFirst skips the paint when the box already holds a live render of that chat', async () => {
  const t = bootGlue();
  t.box.dataset.chat = 'a';
  const run = t.ctx.cachedFirst(t.box, 'a', 40, () => true, ct => t.log.painted.push(ct));
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(run.shown, false);
  assert.deepStrictEqual(t.log.painted, []);
  assert.deepStrictEqual(t.log.bars, []);
});

const bootApi = stale => {
  const calls = [];
  const ctx = { SAVED: { stale }, fetch: async (u, o) => { calls.push([u, o && o.method]); return { ok: true, json: async () => ({ ok: true }) }; }, AbortSignal, JSON, Object, Error };
  vm.createContext(ctx);
  vm.runInContext(apiSrc, ctx);
  return { ctx, calls };
};

test('while the state is a cached one, api writes except typed replies are refused and reads still work', async () => {
  const t = bootApi(true);
  await assert.rejects(t.ctx.api('settings', { a: 1 }), /Still connecting/);
  await assert.rejects(t.ctx.api('key', { session: 's', key: '1' }), /Still connecting/);
  await t.ctx.api('state');
  await t.ctx.api('send', { session: 's', text: 'hi' });
  assert.deepStrictEqual(t.calls, [['/api/state', undefined], ['/api/send', 'POST']]);
});

test('once live state arrived, api writes go through', async () => {
  const t = bootApi(false);
  await t.ctx.api('settings', { a: 1 });
  assert.deepStrictEqual(t.calls, [['/api/settings', 'POST']]);
});
