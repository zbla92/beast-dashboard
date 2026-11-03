const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://beast.test';
const plain = m => JSON.parse(JSON.stringify(m));
const href = r => new URL(typeof r === 'string' ? r : r.url, ORIGIN).href;

function respond(body, { status = 200, type = 'basic', redirected = false, ct = 'text/plain', headers = {} } = {}) {
  const r = new Response(status === 304 ? null : body, { status: status === 304 || status === 0 ? 200 : status, headers: { 'content-type': ct, ...headers } });
  Object.defineProperty(r, 'type', { value: type });
  Object.defineProperty(r, 'redirected', { value: redirected });
  if (status === 304 || status === 0) Object.defineProperty(r, 'status', { value: status });
  return r;
}

function fakeCaches(log) {
  const store = new Map();
  const cacheFor = name => ({
    entries: new Map(),
    async put(req, res) { log.push(`${name} ${new URL(href(req)).pathname}${new URL(href(req)).search}`); this.entries.set(href(req), res); },
    async match(req, opts = {}) {
      const want = new URL(href(req));
      for (const [k, res] of this.entries) { const u = new URL(k); if (u.origin + u.pathname === want.origin + want.pathname && (opts.ignoreSearch || u.search === want.search)) return res.clone(); }
      return undefined;
    },
    keys() { return [...this.entries.keys()]; }
  });
  return {
    store,
    async open(name) { if (!store.has(name)) store.set(name, cacheFor(name)); return store.get(name); },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async match(req, opts = {}) {
      if (opts.cacheName) return store.has(opts.cacheName) ? store.get(opts.cacheName).match(req, opts) : undefined;
      for (const c of store.values()) { const r = await c.match(req, opts); if (r) return r; }
      return undefined;
    }
  };
}

const page = (v, extra = '') => `<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="preconnect" href="https://fonts.elsewhere.example"><link rel="stylesheet" href="/vendor/plex-1.css"><link rel="stylesheet" href="/style.css?v=${v}"><meta name="bd-ver" content="${v}"></head><body><img src="/icon.svg"><a href="/api/state">state</a><iframe src="/term/"></iframe><script src="/app.js?v=${v}"></script><script src="/f-a.js?v=${v}"></script>${extra}</body></html>`;

function server() {
  const srv = { v: 'v1', off: false, broken: {}, calls: [] };
  srv.handle = (url, init = {}) => {
    const u = new URL(url, ORIGIN); const key = u.pathname + u.search;
    srv.calls.push({ key, cache: init.cache });
    if (srv.broken[u.pathname]) return srv.broken[u.pathname]();
    if (u.origin !== ORIGIN) return respond('remote', { type: 'opaque', status: 0 });
    if (u.pathname === '/' || u.pathname === '/index.html') return respond(page(srv.v), { ct: 'text/html; charset=utf-8', headers: srv.off ? { 'x-bd-shell': 'off' } : {} });
    if (u.pathname === '/style.css') return respond(`body{background:url(/icons/bg.svg)}.x{background:url("data:image/png;base64,AA==")}`, { ct: 'text/css; charset=utf-8' });
    if (u.pathname === '/vendor/plex-1.css') return respond(`@font-face{src:url(/vendor/fonts/plex-400.woff2) format('woff2')}@font-face{src:url('fonts/plex-500.woff2')}@font-face{src:url(https://cdn.example/x.woff2)}`, { ct: 'text/css; charset=utf-8' });
    if (u.pathname.endsWith('.woff2')) return respond('font', { ct: 'font/woff2' });
    if (u.pathname.endsWith('.js')) return respond(`js ${key}`, { ct: 'text/javascript; charset=utf-8' });
    if (u.pathname.endsWith('.svg')) return respond('<svg/>', { ct: 'image/svg+xml' });
    if (u.pathname === '/manifest.webmanifest') return respond('{}', { ct: 'application/manifest+json' });
    return respond('404', { status: 404 });
  };
  return srv;
}

function boot({ net } = {}) {
  const log = [], listeners = {}, posted = [], deletedDbs = [];
  const srv = server();
  const clock = { t: 1_000_000 };
  const caches = fakeCaches(log);
  const fetches = [];
  const fetch = async (input, init) => { fetches.push({ url: href(input), init }); return net ? net(input, init) : srv.handle(href(input), init); };
  const clients = { claim: async () => {}, matchAll: async () => [{ url: ORIGIN + '/', postMessage: m => posted.push(plain(m)) }] };
  const self = { location: { origin: ORIGIN }, clients, registration: {}, skipWaiting: () => {}, addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); } };
  const indexedDB = { deleteDatabase: name => { deletedDbs.push(name); const r = {}; setImmediate(() => r.onsuccess && r.onsuccess()); return r; } };
  class FakeDate extends Date { static now() { return clock.t; } }
  const ctx = vm.createContext({ self, caches, fetch, Response, URL, indexedDB, setTimeout, clearTimeout, console, Date: FakeDate });
  vm.runInContext(SRC, ctx);
  const env = { ctx, srv, clock, caches, log, posted, deletedDbs, fetches, listeners };
  env.call = expr => vm.runInContext(expr, ctx);
  env.dispatch = (type, init) => {
    const ev = { ...init, waits: [], responded: null, waitUntil(p) { this.waits.push(Promise.resolve(p)); }, respondWith(p) { this.responded = Promise.resolve(p); } };
    for (const f of listeners[type] || []) f(ev);
    return ev;
  };
  env.fetchEvent = (url, { mode = 'no-cors', destination = 'script', method = 'GET' } = {}) => env.dispatch('fetch', { request: { url: new URL(url, ORIGIN).href, mode, destination, method } });
  env.nav = url => env.fetchEvent(url, { mode: 'navigate', destination: 'document' });
  env.names = async () => (await caches.keys()).sort();
  env.keysOf = name => caches.store.has(name) ? caches.store.get(name).keys().map(k => { const u = new URL(k); return u.pathname + u.search; }).sort() : null;
  env.current = async () => { const r = await caches.match('/__current', { cacheName: 'bd-meta' }); return r ? (await r.json()).v : null; };
  return env;
}

test('C4: only the shell navigation and listed same-origin GET assets get a respondWith', () => {
  const env = boot({ net: () => new Promise(() => {}) });
  const yes = [['/', 'nav'], ['/index.html?x=1', 'nav'], ['/?term=claude-x', 'nav'], ['/style.css?v=k2a'], ['/f-conn.js?v=1'], ['/app.js?v=abc'], ['/f-a-b.css?v=9z'],
    ['/vendor/plex-1.css'], ['/vendor/fonts/plex-400.woff2'], ['/icons/folder.svg'], ['/icon-192.png'], ['/icon.svg'], ['/manifest.webmanifest']];
  for (const [u, kind] of yes) { const ev = kind ? env.nav(u) : env.fetchEvent(u); assert.ok(ev.responded, `${u} should be answered by the SW`); }
  const no = [
    ['/api/state'], ['/api/events'], ['/api/hl-live?session=x'], ['/api/download?p=a.png'], ['/api/file?p=icon.svg'], ['/api/version'], ['/sw.js'], ['/term/'], ['/term/ws'],
    ['/app.js'], ['/app.js?v=ABC'], ['/app.js?v=1&x=2'], ['/style.css?x=1'], ['/other.js?v=1'], ['/icons/a.png'], ['/icons/sub/a.svg'], ['/vendor/x%20y.css'], ['/index.html'],
    ['https://other.example/app.js?v=1'], ['https://other.example/', 'nav']
  ];
  for (const [u, kind] of no) { const ev = kind ? env.nav(u) : env.fetchEvent(u); assert.strictEqual(ev.responded, null, `${u} must go to the network untouched`); }
  assert.strictEqual(env.fetchEvent('/term/', { mode: 'navigate', destination: 'iframe' }).responded, null, 'terminal iframe');
  assert.strictEqual(env.fetchEvent('/', { mode: 'navigate', destination: 'iframe' }).responded, null, 'iframe of the shell');
  assert.strictEqual(env.nav('/term/').responded, null, 'top-level /term/');
  assert.strictEqual(env.fetchEvent('/', { mode: 'navigate', destination: 'document', method: 'POST' }).responded, null, 'non-GET navigation');
  assert.strictEqual(env.fetchEvent('/style.css?v=1', { method: 'HEAD' }).responded, null, 'non-GET asset');
});

test('refresh fills bd-app-<ver> with the shell and every referenced asset, shell last, then flips /__current', async () => {
  const env = boot();
  assert.strictEqual(await env.call('refresh()'), 'v1');
  assert.deepStrictEqual(await env.names(), ['bd-app-v1', 'bd-meta']);
  assert.deepStrictEqual(env.keysOf('bd-app-v1'), ['/', '/app.js?v=v1', '/f-a.js?v=v1', '/icon.svg', '/icons/bg.svg', '/manifest.webmanifest', '/style.css?v=v1', '/vendor/fonts/plex-400.woff2', '/vendor/fonts/plex-500.woff2', '/vendor/plex-1.css']);
  assert.strictEqual(env.log.at(-2), 'bd-app-v1 /');
  assert.strictEqual(env.log.at(-1), 'bd-meta /__current');
  assert.strictEqual(await env.current(), 'v1');
  const shell = env.srv.calls.find(c => c.key === '/');
  assert.strictEqual(shell.cache, 'no-store');
  assert.strictEqual(env.srv.calls.find(c => c.key === '/vendor/plex-1.css').cache, 'no-cache');
  assert.strictEqual(env.srv.calls.find(c => c.key === '/app.js?v=v1').cache, undefined);
  assert.ok(!env.srv.calls.some(c => c.key.startsWith('/api/') || c.key.startsWith('/term')), 'never fetches api or terminal');
  assert.deepStrictEqual(env.posted, [{ bdShell: 'v1' }]);
});

test('refresh dedupes while one runs and skips for 30 s after a success', async () => {
  const env = boot();
  const [a, b] = await Promise.all([env.call('refresh()'), env.call('refresh()')]);
  assert.deepStrictEqual([a, b], ['v1', 'v1']);
  const shells = () => env.srv.calls.filter(c => c.key === '/').length;
  assert.strictEqual(shells(), 1);
  env.clock.t += 29000; await env.call('refresh()'); assert.strictEqual(shells(), 1);
  env.clock.t += 2000; await env.call('refresh()'); assert.strictEqual(shells(), 2);
  env.srv.calls.length = 0; await env.call('refresh()');
  assert.deepStrictEqual(env.srv.calls, [], 'same version within 30 s: nothing fetched');
});

for (const [what, path, broken] of [
  ['an asset 404', '/f-a.js', () => respond('nope', { status: 404, ct: 'text/javascript' })],
  ['an asset 304', '/app.js', () => respond(null, { status: 304, ct: 'text/javascript' })],
  ['a redirected asset', '/style.css', () => respond('x', { redirected: true, ct: 'text/css' })],
  ['an opaque asset', '/icon.svg', () => respond('x', { type: 'opaque', status: 0, ct: 'image/svg+xml' })],
  ['an asset with the wrong content-type', '/manifest.webmanifest', () => respond('<html>', { ct: 'text/html' })],
  ['a font 403', '/vendor/fonts/plex-500.woff2', () => respond('no', { status: 403, ct: 'font/woff2' })],
  ['a shell 500', '/', () => respond('down', { status: 500, ct: 'text/html' })],
  ['a redirected shell', '/', () => respond(page('v2'), { redirected: true, ct: 'text/html' })],
  ['a shell without bd-ver', '/', () => respond('<html><head></head></html>', { ct: 'text/html' })],
  ['a shell that is not html', '/', () => respond(page('v2'), { ct: 'application/json' })],
  ['a network error', '/app.js', () => { throw new TypeError('Failed to fetch'); }]
]) {
  test(`refresh with ${what} stores nothing and keeps the old current`, async () => {
    const env = boot();
    await env.call('refresh()');
    env.srv.v = 'v2'; env.srv.broken[path] = broken;
    await assert.rejects(env.call('refresh(true)'));
    assert.deepStrictEqual(await env.names(), ['bd-app-v1', 'bd-meta']);
    assert.strictEqual(await env.current(), 'v1');
    assert.strictEqual(env.keysOf('bd-app-v1').length, 10);
  });
}

test('a failed first fill leaves no cache and the navigation goes to the network', async () => {
  const env = boot();
  env.srv.broken['/f-a.js'] = () => respond('nope', { status: 404, ct: 'text/javascript' });
  await assert.rejects(env.call('refresh()'));
  assert.deepStrictEqual(await env.names(), []);
  const ev = env.nav('/');
  assert.match(await (await ev.responded).text(), /bd-ver" content="v1"/);
  assert.ok(env.fetches.some(f => f.url === ORIGIN + '/' && !f.init));
});

test('a new build switches current and prunes to current + previous, never touching bd-nav', async () => {
  const env = boot();
  const nav = await env.caches.open('bd-nav'); await nav.put('/__pending-open', respond('{"url":"/"}', { ct: 'application/json' }));
  await env.call('refresh()');
  env.srv.v = 'v2'; await env.call('refresh(true)');
  assert.deepStrictEqual(await env.names(), ['bd-app-v1', 'bd-app-v2', 'bd-meta', 'bd-nav']);
  env.srv.v = 'v3'; await env.call('refresh(true)');
  assert.deepStrictEqual(await env.names(), ['bd-app-v2', 'bd-app-v3', 'bd-meta', 'bd-nav']);
  assert.strictEqual(await env.current(), 'v3');
  assert.deepStrictEqual(env.keysOf('bd-nav'), ['/__pending-open']);
  assert.deepStrictEqual(env.posted.map(m => m.bdShell), ['v1', 'v2', 'v3']);
});

test('activate deletes every bd-app-* except current and the one before it', async () => {
  const env = boot();
  for (const n of ['bd-app-a', 'bd-app-b', 'bd-app-c']) await (await env.caches.open(n)).put('/', respond('x'));
  await (await env.caches.open('bd-nav')).put('/__pending-open', respond('{}'));
  await (await env.caches.open('bd-meta')).put('/__current', respond(JSON.stringify({ v: 'a', at: 1 }), { ct: 'application/json' }));
  const ev = env.dispatch('activate', {}); await Promise.all(ev.waits);
  assert.deepStrictEqual(await env.names(), ['bd-app-a', 'bd-app-c', 'bd-meta', 'bd-nav']);
});

test('x-bd-shell: off wipes bd-app-*, bd-meta and bd-local, keeps bd-nav, then navigations go to the network', async () => {
  const env = boot();
  await (await env.caches.open('bd-nav')).put('/__pending-open', respond('{}'));
  await env.call('refresh()');
  env.srv.off = true;
  assert.strictEqual(await env.call('refresh(true)'), null);
  assert.deepStrictEqual(await env.names(), ['bd-nav']);
  assert.deepStrictEqual(env.deletedDbs, ['bd-local']);
  env.fetches.length = 0;
  const ev = env.nav('/');
  await (await ev.responded).text();
  assert.ok(env.fetches.some(f => f.url === ORIGIN + '/' && !f.init), 'served from the network');
  assert.deepStrictEqual(await env.names(), ['bd-nav']);
});

test('a cached shell is served without waiting for the network, and the navigation starts a refresh', async () => {
  const env = boot();
  await env.call('refresh()');
  env.clock.t += 60000;
  const hang = []; env.ctx.fetch = (input, init) => new Promise(() => { hang.push({ url: href(input), init }); });
  const ev = env.nav('/?term=claude-x');
  const res = await Promise.race([ev.responded, new Promise((_, no) => setTimeout(() => no(new Error('navigation waited for the network')), 500))]);
  assert.match(await res.text(), /bd-ver" content="v1"/);
  assert.strictEqual(ev.waits.length, 1, 'refresh() runs in waitUntil');
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(hang.map(h => [new URL(h.url).pathname, h.init && h.init.cache]), [['/', 'no-store']]);
});

test('/?reset-cache wipes before answering that navigation from the network', async () => {
  const env = boot();
  await env.call('refresh()');
  env.srv.v = 'v2';
  env.fetches.length = 0;
  const ev = env.nav('/?reset-cache');
  const res = await ev.responded;
  assert.match(await res.text(), /bd-ver" content="v2"/);
  assert.ok(env.fetches.some(f => f.url === ORIGIN + '/?reset-cache' && !f.init), 'the navigation itself went to the network');
  assert.deepStrictEqual(env.deletedDbs, ['bd-local']);
  await Promise.all(ev.waits);
  assert.deepStrictEqual(await env.names(), ['bd-app-v2', 'bd-meta']);
});

test('{ bdRefresh } runs refresh past the 30 s skip and answers the current version', async () => {
  const env = boot();
  await env.call('refresh()');
  env.srv.v = 'v2';
  const got = [];
  const ev = env.dispatch('message', { data: { bdRefresh: 'v2' }, ports: [{ postMessage: m => got.push(plain(m)) }] });
  await Promise.all(ev.waits);
  assert.deepStrictEqual(got, [{ v: 'v2' }]);
  assert.strictEqual(await env.current(), 'v2');
  env.srv.broken['/'] = () => respond('down', { status: 502, ct: 'text/html' });
  const ev2 = env.dispatch('message', { data: { bdRefresh: 'v3' }, ports: [{ postMessage: m => got.push(plain(m)) }] });
  await Promise.all(ev2.waits);
  assert.deepStrictEqual(got[1], { v: 'v2' }, 'a failed refresh answers the old current, so the page does not reload');
  assert.strictEqual(env.dispatch('message', { data: { open: '/' }, ports: [] }).waits.length, 0);
});

test('{ bdRefresh } answers { v: null } at once when the server turned the cache off', async () => {
  const env = boot();
  await env.call('refresh()');
  env.srv.v = 'v2'; env.srv.off = true;
  const got = [];
  const ev = env.dispatch('message', { data: { bdRefresh: 'v2' }, ports: [{ postMessage: m => got.push(plain(m)) }] });
  await Promise.all(ev.waits);
  assert.deepStrictEqual(got, [{ v: null }]);
  assert.strictEqual(env.srv.calls.filter(c => c.key === '/').length, 2, 'one refresh after the first fill, not a second one');
  assert.deepStrictEqual(await env.names(), []);
});

test('{ bdWipe } stops a running refresh from flipping /__current and answers after the wipe', async () => {
  const env = boot();
  await env.call('refresh()');
  env.srv.v = 'v2';
  const gate = {}; const held = new Promise(r => { gate.open = r; });
  const handle = env.srv.handle;
  env.srv.handle = (url, init) => new URL(url, ORIGIN).pathname === '/app.js' ? held.then(() => handle(url, init)) : handle(url, init);
  const running = env.call('refresh(true)');
  await new Promise(r => setImmediate(r));
  const got = [];
  const ev = env.dispatch('message', { data: { bdWipe: true }, ports: [{ postMessage: m => got.push(plain(m)) }] });
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(got, [], 'waits for the running refresh');
  gate.open();
  await assert.rejects(running);
  await Promise.all(ev.waits);
  assert.deepStrictEqual(got, [{ wiped: true }]);
  assert.deepStrictEqual(await env.names(), []);
  assert.strictEqual(await env.current(), null);
  assert.ok(!env.posted.some(m => m.bdShell === 'v2'));
});

test('versioned assets: any bd-app-* hit first, else network, stored only for the current version', async () => {
  const env = boot();
  await env.call('refresh()');
  env.srv.v = 'v2'; await env.call('refresh(true)');
  env.fetches.length = 0;
  const old = env.fetchEvent('/app.js?v=v1');
  assert.strictEqual(await (await old.responded).text(), 'js /app.js?v=v1');
  assert.strictEqual(env.fetches.length, 0, 'previous build served from its cache');
  const miss = env.fetchEvent('/f-late.js?v=v2');
  assert.strictEqual(await (await miss.responded).text(), 'js /f-late.js?v=v2');
  await Promise.all(miss.waits);
  assert.ok(env.keysOf('bd-app-v2').includes('/f-late.js?v=v2'));
  const other = env.fetchEvent('/f-late.js?v=v9');
  await (await other.responded).text(); await Promise.all(other.waits);
  assert.ok(!(await env.names()).includes('bd-app-v9'));
  assert.ok(!env.keysOf('bd-app-v2').includes('/f-late.js?v=v9'));
  env.srv.broken['/f-gone.js'] = () => respond('nope', { status: 404, ct: 'text/javascript' });
  const gone = env.fetchEvent('/f-gone.js?v=v2');
  assert.strictEqual((await gone.responded).status, 404);
  await Promise.all(gone.waits);
  assert.ok(!env.keysOf('bd-app-v2').includes('/f-gone.js?v=v2'));
});

test('unversioned statics come from the current cache, else the network, and are never stored outside refresh()', async () => {
  const env = boot();
  await env.call('refresh()');
  env.fetches.length = 0;
  assert.strictEqual(await (await env.fetchEvent('/vendor/fonts/plex-400.woff2').responded).text(), 'font');
  assert.strictEqual(env.fetches.length, 0);
  const ev = env.fetchEvent('/icons/new.svg');
  assert.strictEqual(await (await ev.responded).text(), '<svg/>');
  await Promise.all(ev.waits);
  assert.strictEqual(env.fetches.length, 1);
  assert.ok(!env.keysOf('bd-app-v1').includes('/icons/new.svg'));
});

test('install fills the cache and a failing fill does not fail the install', async () => {
  const env = boot();
  const ev = env.dispatch('install', {});
  await Promise.all(ev.waits);
  assert.strictEqual(await env.current(), 'v1');
  const bad = boot();
  bad.srv.broken['/'] = () => { throw new TypeError('offline'); };
  const ev2 = bad.dispatch('install', {});
  await assert.doesNotReject(Promise.all(ev2.waits));
  assert.deepStrictEqual(await bad.names(), []);
});
