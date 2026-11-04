const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const localSrc = pub('f-local.js');
const appSrc = pub('app.js');
const glue = appSrc.slice(appSrc.indexOf('const STATE_KEEP_MS'), appSrc.indexOf("connect();\n$('#btn-palette')"));
const applyStateSrc = appSrc.slice(appSrc.indexOf('function applyState('), appSrc.indexOf('function applyOps('));

const fakeIndexedDB = () => {
  const data = new Map();
  const state = { versionchange: null, closed: false, failOpen: false, slow: 0 };
  const later = (f, ms = 0) => setTimeout(f, ms);
  const req = (result, tx) => { const r = { result }; later(() => { if (tx) tx.oncomplete && tx.oncomplete(); }, state.slow); return r; };
  const db = {
    objectStoreNames: { contains: () => true },
    close() { state.closed = true; },
    transaction() {
      const tx = {};
      return Object.assign(tx, {
        objectStore: () => ({
          get: k => req(data.get(k), tx),
          put: (v, k) => { data.set(k, structuredClone(v)); return req(k, tx); },
          delete: k => { data.delete(k); return req(undefined, tx); },
          getAllKeys: () => req([...data.keys()], tx),
        }),
      });
    },
  };
  state.db = db;
  return {
    state, data,
    indexedDB: {
      open() {
        const r = {};
        later(() => {
          if (state.failOpen) return r.onerror && r.onerror();
          r.result = db;
          Object.defineProperty(db, 'onversionchange', { set: f => { state.versionchange = f; }, configurable: true });
          r.onsuccess();
        });
        return r;
      },
    },
  };
};

const bootLocal = (opts = {}) => {
  const idb = fakeIndexedDB();
  Object.assign(idb.state, opts);
  const window = {};
  vm.runInNewContext(localSrc, { window, indexedDB: idb.indexedDB, setTimeout, structuredClone, JSON, Date, Promise });
  return { LOCAL: window.LOCAL, ...idb };
};

test('put wraps the value as { f:1, at, ver, data } and get returns it', async () => {
  const t = bootLocal();
  assert.strictEqual(await t.LOCAL.put('state', { projects: [1] }, 'abc'), true);
  const rec = await t.LOCAL.get('state');
  assert.strictEqual(rec.f, 1);
  assert.strictEqual(rec.ver, 'abc');
  assert.ok(Math.abs(rec.at - Date.now()) < 2000);
  assert.deepStrictEqual(rec.data, { projects: [1] });
});

test('a value with f !== 1 is deleted and ignored', async () => {
  const t = bootLocal();
  t.data.set('state', { f: 2, at: Date.now(), data: {} });
  assert.strictEqual(await t.LOCAL.get('state'), null);
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(t.data.has('state'), false);
});

test('values over 1 MB are not stored', async () => {
  const t = bootLocal();
  assert.strictEqual(await t.LOCAL.put('state', { big: 'x'.repeat(1048576) }, 'v'), false);
  assert.strictEqual(t.data.has('state'), false);
});

test('a missing key resolves to null', async () => {
  const t = bootLocal();
  assert.strictEqual(await t.LOCAL.get('nope'), null);
});

test('an unavailable IndexedDB resolves to null and false instead of throwing', async () => {
  const t = bootLocal({ failOpen: true });
  assert.strictEqual(await t.LOCAL.get('state'), null);
  assert.strictEqual(await t.LOCAL.put('state', {}, 'v'), false);
});

test('get gives up after the cap when IndexedDB is slow', async () => {
  const t = bootLocal({ slow: 400 });
  const t0 = Date.now();
  assert.strictEqual(await t.LOCAL.get('state', 50), null);
  assert.ok(Date.now() - t0 < 300);
});

test('the open connection closes on versionchange so deleteDatabase is never blocked', async () => {
  const t = bootLocal();
  await t.LOCAL.get('state');
  t.state.versionchange();
  assert.strictEqual(t.state.closed, true);
});

test('stop() closes the connection and later writes do nothing', async () => {
  const t = bootLocal();
  await t.LOCAL.put('state', {}, 'v');
  t.LOCAL.stop();
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(t.state.closed, true);
  assert.strictEqual(await t.LOCAL.put('state', { a: 1 }, 'v'), false);
});

test('after an external versionchange get, del, keys and put touch nothing and nothing reopens the db', async () => {
  const t = bootLocal();
  await t.LOCAL.put('state', { a: 1 }, 'v');
  const counts = { opens: 0 };
  const open = t.indexedDB.open;
  t.indexedDB.open = (...a) => { counts.opens++; return open(...a); };
  t.state.versionchange();
  assert.strictEqual(await t.LOCAL.get('state'), null);
  assert.strictEqual(await t.LOCAL.del('state'), undefined);
  assert.strictEqual((await t.LOCAL.keys()).length, 0);
  assert.strictEqual(await t.LOCAL.put('state', { b: 1 }, 'v'), false);
  assert.strictEqual(counts.opens, 0);
  assert.deepStrictEqual(t.data.get('state').data, { a: 1 });
});

test('pagehide after an external versionchange writes nothing', async () => {
  const t = bootGlue({ base: { projects: [1], runtime: { sessions: [{ name: 'a' }] } }, seq: 1 });
  const l = bootLocal();
  await l.LOCAL.put('state', { old: 1 }, 'v');
  l.state.versionchange();
  t.ctx.LOCAL.put = (k, d, v) => l.LOCAL.put(k, d, v);
  t.listeners.pagehide();
  await new Promise(r => setTimeout(r, 10));
  assert.deepStrictEqual(l.data.get('state').data, { old: 1 });
});

test('keys lists the stored keys', async () => {
  const t = bootLocal();
  await t.LOCAL.put('a', {}, 'v');
  assert.strictEqual(JSON.stringify(await t.LOCAL.keys()), '["a"]');
});

test('stop() makes get and del return without touching the store', async () => {
  const t = bootLocal();
  await t.LOCAL.put('state', { a: 1 }, 'v');
  t.LOCAL.stop();
  assert.strictEqual(await t.LOCAL.get('state'), null);
  await t.LOCAL.del('state');
  assert.ok(t.data.has('state'));
});

const bootGlue = (opts = {}) => {
  const gets = [], stops = [], pruned = [], puts = [], dels = [], feats = [], applied = [], listeners = {};
  const clock = { now: 10000000 };
  class FakeDate { static now() { return clock.now; } }
  const ctx = {
    LOCAL: { put: (k, d, v) => puts.push({ k, d, v }), del: k => dels.push(k), get: (...a) => { gets.push(a[0]); return Promise.resolve(null); }, stop: () => { stops.push(1); } },
    LIVE: { base: opts.base || null, seq: opts.seq ?? null, connected: true },
    MY_VER: 'v9', Date: FakeDate, URLSearchParams, location: { search: opts.search || '' },
    CHATS: { prune: n => pruned.push(n) }, S: { runtime: { sessions: opts.sessions || [] } },
    feat: (...a) => feats.push(a),
    applyState: (d, cached) => { if (opts.throwOnApply) throw new Error('boom'); applied.push({ d, cached }); },
    structuredClone, setInterval: () => 0,
    addEventListener: (n, f) => { listeners[n] = f; },
    document: { hidden: false, addEventListener: (n, f) => { listeners['d:' + n] = f; } },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(glue.replace(/^const /gm, 'var ') + '\nthis.api = { saveState, restoreState, clearStale, pruneChats, SAVED };', ctx);
  return { ctx, api: ctx.api, gets, stops, pruned, puts, dels, feats, applied, listeners, advance: ms => { clock.now += ms; } };
};

test('saveState strips stats and statsHistory and tags the build', () => {
  const t = bootGlue({ base: { projects: [1], stats: { cpu: 1 }, statsHistory: [1], host: { build: 'b' }, runtime: { sessions: [{ name: 'a' }] } }, seq: 3 });
  t.api.saveState();
  assert.strictEqual(t.puts.length, 1);
  assert.deepStrictEqual(Object.keys(t.puts[0].d).sort(), ['host', 'projects', 'runtime']);
  assert.strictEqual(t.puts[0].v, 'v9');
});

test('saveState writes at most every 30 s', () => {
  const t = bootGlue({ base: { projects: [], runtime: { sessions: [{ name: 'a' }] } }, seq: 1 });
  t.api.saveState();
  t.ctx.LIVE.seq = 2;
  t.advance(10000);
  t.api.saveState();
  assert.strictEqual(t.puts.length, 1);
  t.advance(20000);
  t.api.saveState();
  assert.strictEqual(t.puts.length, 2);
});

test('saveState skips when LIVE.seq has not changed since the last write, even when forced', () => {
  const t = bootGlue({ base: { projects: [], runtime: { sessions: [{ name: 'a' }] } }, seq: 1 });
  t.api.saveState();
  t.advance(60000);
  t.api.saveState(true);
  assert.strictEqual(t.puts.length, 1);
});

test('a forced save (pagehide / hidden) ignores the 30 s spacing when seq changed', () => {
  const t = bootGlue({ base: { projects: [], runtime: { sessions: [{ name: 'a' }] } }, seq: 1 });
  t.api.saveState();
  t.ctx.LIVE.seq = 2;
  t.advance(1000);
  t.api.saveState(true);
  assert.strictEqual(t.puts.length, 2);
});

test('saveState does nothing before the first live state', () => {
  const t = bootGlue();
  t.api.saveState(true);
  assert.strictEqual(t.puts.length, 0);
});

test('restoreState renders a fresh record as cached (no build check) and marks it stale', () => {
  const t = bootGlue();
  t.api.restoreState({ f: 1, at: 10000000 - 1000, data: { projects: [], host: { build: 'old' } } });
  assert.strictEqual(t.applied.length, 1);
  assert.strictEqual(t.applied[0].cached, true);
  assert.deepStrictEqual(t.feats, [['stale', true]]);
});

test('restoreState ignores and deletes a record older than 7 days', () => {
  const t = bootGlue();
  t.api.restoreState({ f: 1, at: 10000000 - 7 * 86400000, data: { projects: [] } });
  assert.strictEqual(t.applied.length, 0);
  assert.deepStrictEqual(t.dels, ['state']);
});

test('restoreState does nothing once live state has arrived', () => {
  const t = bootGlue({ base: { projects: [], runtime: { sessions: [{ name: 'a' }] } } });
  t.api.restoreState({ f: 1, at: 10000000, data: { projects: [] } });
  assert.strictEqual(t.applied.length, 0);
  assert.strictEqual(t.dels.length, 0);
});

test('a record whose render throws is deleted and never marked stale', () => {
  const t = bootGlue({ throwOnApply: true });
  t.api.restoreState({ f: 1, at: 10000000, data: { projects: [] } });
  assert.deepStrictEqual(t.dels, ['state']);
  assert.deepStrictEqual(t.feats, []);
});

test('clearStale clears the mark once and only once', () => {
  const t = bootGlue();
  t.api.restoreState({ f: 1, at: 10000000, data: { projects: [] } });
  t.api.clearStale();
  t.api.clearStale();
  assert.deepStrictEqual(t.feats, [['stale', true], ['stale', false]]);
});

test('applyState skips the host.build check for cached data and keeps S.build untouched', () => {
  const n = { newBuilds: 0, renders: 0 };
  const S = { build: null };
  const ctx = { S, newBuild: () => n.newBuilds++, render: () => n.renders++ };
  vm.createContext(ctx);
  vm.runInContext(applyStateSrc, ctx);
  const d = () => ({ projects: [], runtime: {}, settings: {}, host: { build: 'cached' } });
  ctx.applyState(d(), true);
  assert.strictEqual(S.build, null);
  assert.strictEqual(n.newBuilds, 0);
  assert.strictEqual(n.renders, 1);
  ctx.applyState({ ...d(), host: { build: 'live1' } });
  assert.strictEqual(S.build, 'live1');
  ctx.applyState({ ...d(), host: { build: 'live2' } });
  assert.strictEqual(n.newBuilds, 1);
});

test('reset-cache stops LOCAL first and never reads the saved state', () => {
  const t = bootGlue({ search: '?reset-cache' });
  assert.strictEqual(t.stops.length, 1);
  assert.deepStrictEqual(t.gets, []);
});

test('a normal load reads the saved state and does not stop LOCAL', () => {
  const t = bootGlue();
  assert.deepStrictEqual(t.gets, ['state']);
  assert.strictEqual(t.stops.length, 0);
});

test('state with no sessions yet is not saved', () => {
  const t = bootGlue({ base: { projects: [1], runtime: { sessions: [] } }, seq: 1 });
  t.api.saveState(true);
  assert.strictEqual(t.puts.length, 0);
  const u = bootGlue({ base: { projects: [1] }, seq: 1 });
  u.api.saveState(true);
  assert.strictEqual(u.puts.length, 0);
});

test('state with sessions is saved', () => {
  const t = bootGlue({ base: { projects: [1], runtime: { sessions: [{ name: 'a' }] } }, seq: 1 });
  t.api.saveState(true);
  assert.strictEqual(t.puts.length, 1);
});

test('chats are not pruned while the session list is empty', () => {
  const t = bootGlue();
  t.api.pruneChats();
  assert.deepStrictEqual(t.pruned, []);
});

test('chats are pruned when the set of sessions changes, including after a patch, and not otherwise', () => {
  const t = bootGlue({ sessions: [{ name: 'a' }, { name: 'b' }] });
  t.api.pruneChats();
  t.api.pruneChats();
  assert.deepStrictEqual(t.pruned, [['a', 'b']]);
  t.ctx.S.runtime.sessions = [{ name: 'a' }];
  t.api.pruneChats();
  assert.deepStrictEqual(t.pruned, [['a', 'b'], ['a']]);
});

test('the patch handler prunes after applying', () => {
  const at = appSrc.indexOf("es.addEventListener('patch'");
  assert.match(appSrc.slice(at, at + 500), /applyState\(structuredClone\(LIVE\.base\)\); pruneChats\(\)/);
});
