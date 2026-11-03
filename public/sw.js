self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(refresh().catch(() => {})); });
self.addEventListener('activate', e => e.waitUntil(Promise.all([self.clients.claim(), current().then(c => prune(c && c.v)).catch(() => {})])));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Beast Dash', body: e.data ? e.data.text() : '' }; }
  // quick replies straight from the notification (Chrome/Android/macOS show them; iOS ignores `actions` and just opens)
  const actions = d.kind === 'permission' ? [{ action: 'allow', title: '✓ Allow' }, { action: 'deny', title: '✕ Deny' }, { action: 'open', title: 'Open' }]
    : d.kind === 'done' ? [{ action: 'go', title: '👍 Yes, go on' }, { action: 'open', title: 'Open' }]
    : d.session ? [{ action: 'open', title: 'Open' }] : [];
  e.waitUntil(self.registration.showNotification(d.title || 'Beast Dash', { body: d.body || '', tag: d.tag || 'beast', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', actions, data: { url: d.url || '/', session: d.session || null, since: d.since ?? null } }));
});
const post = (path, body) => fetch('/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const sess = e.notification.data?.session;
  if (sess && e.action && e.action !== 'open') {   // reply without opening the app
    const since = e.notification.data?.since ?? null;
    const p = e.action === 'allow' || e.action === 'deny' ? post('answer', { session: sess, since, choice: e.action }) : post('send', { session: sess, text: 'Yes, go on.' });
    const failed = msg => self.registration.showNotification("Couldn't answer — open the app", { body: msg || '', tag: 'bd-answer-' + sess, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: e.notification.data?.url || '/', session: sess } });
    e.waitUntil(p.then(async r => { if (!r.ok) { let j = {}; try { j = await r.json(); } catch {} await failed(j.error); } }).catch(() => failed('no connection to the server'))); return;
  }
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  // Also park the target in Cache Storage: iOS often resumes a frozen PWA *after* our postMessage was sent (or reloads it),
  // so the page checks this on load / when it becomes visible and goes there itself. Consumed once, ignored after 2 min.
  const park = caches.open('bd-nav').then(c => c.put('/__pending-open', new Response(JSON.stringify({ url, at: Date.now() }), { headers: { 'content-type': 'application/json' } }))).catch(() => {});
  // Safari (iOS PWA) has no WindowClient.navigate(): tell the open page where to go and focus it; open a window only
  // when nothing is open. The page handles {open: url} (app.js) by opening that session's chat.
  e.waitUntil(park.then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true })).then(cs => {
    const c = cs.find(x => x.url.startsWith(self.location.origin));
    // BroadcastChannel reaches every open page of the app even when matchAll misses it (iOS resuming a suspended PWA)
    try { const bc = new BroadcastChannel('bd-nav'); bc.postMessage({ open: url }); bc.close(); } catch {}
    if (c) { try { c.postMessage({ open: url }); } catch {} return (c.focus ? c.focus() : Promise.resolve()).catch(() => self.clients.openWindow(url)); }
    return self.clients.openWindow(url);
  }));
});

const APP = 'bd-app-', META = 'bd-meta', CURRENT = '/__current', LOCAL_DB = 'bd-local', REFRESH_GAP = 30000;
const VERSIONED = /^\/(app|style|f-[\w-]+)\.(js|css)$/, VERSION_QUERY = /^\?v=[0-9a-z]+$/;
const UNVERSIONED = [/^\/vendor\/[\w./-]+$/, /^\/icons\/[\w.-]+\.svg$/, /^\/icon[\w-]*\.(png|svg)$/, /^\/manifest\.webmanifest$/];
const HTML_TYPE = /^text\/html\b/, ASSET_TYPE = /javascript|css|svg|png|woff2|manifest/;
const isShell = (req, url) => req.mode === 'navigate' && req.destination === 'document' && (url.pathname === '/' || url.pathname === '/index.html');
const isVersioned = url => VERSIONED.test(url.pathname) && VERSION_QUERY.test(url.search);
const isUnversioned = url => UNVERSIONED.some(r => r.test(url.pathname));
const isAsset = url => url.origin === self.location.origin && (isVersioned(url) || isUnversioned(url));
const storable = (res, type) => !!res && res.status === 200 && res.type === 'basic' && !res.redirected && type.test(res.headers.get('content-type') || '');
const versionOf = html => (html.match(/<meta name="bd-ver" content="([0-9a-z]+)"/) || [])[1] || null;
const MATCH = { ignoreVary: true };

async function current() {
  const r = await caches.match(CURRENT, { cacheName: META });
  const c = r ? await r.json() : null;
  return c && typeof c.v === 'string' ? c : null;
}
const dropLocal = () => new Promise(done => { try { const r = indexedDB.deleteDatabase(LOCAL_DB); r.onsuccess = r.onerror = r.onblocked = () => done(); } catch { done(); } });
const run = { busy: null, at: 0, gen: 0 };
async function wipe() {
  run.gen++;
  run.at = 0;
  const names = await caches.keys();
  await Promise.all(names.filter(n => n.startsWith(APP) || n === META).map(n => caches.delete(n)));
  await dropLocal();
}
async function prune(cur, prev) {
  const names = (await caches.keys()).filter(n => n.startsWith(APP));
  const keep = new Set(cur ? [APP + cur, prev ? APP + prev : names.filter(n => n !== APP + cur).pop()] : []);
  await Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)));
}
function refs(text, base, pattern) {
  const out = new Map();
  for (const m of text.matchAll(pattern)) { try { const u = new URL(m[1], base); if (isAsset(u)) out.set(u.href, u); } catch {} }
  return [...out.values()];
}
async function fetchAssets(urls) {
  const got = new Map();
  const grab = async url => {
    if (got.has(url.href)) return;
    got.set(url.href, null);
    const res = await fetch(url.href, isVersioned(url) ? {} : { cache: 'no-cache' });
    if (!storable(res, ASSET_TYPE)) throw new Error(`asset ${url.pathname} ${res.status}`);
    got.set(url.href, res);
    if (/css/.test(res.headers.get('content-type'))) await Promise.all(refs(await res.clone().text(), url, /url\(\s*['"]?([^'")]+)['"]?\s*\)/g).map(grab));
  };
  await Promise.all(urls.map(grab));
  return got;
}
async function fill() {
  const gen = run.gen;
  const shell = await fetch('/', { cache: 'no-store' });
  if (shell.headers.get('x-bd-shell') === 'off') { await wipe(); return null; }
  if (!storable(shell, HTML_TYPE)) throw new Error(`shell ${shell.status}`);
  const html = await shell.clone().text();
  const v = versionOf(html);
  if (!v) throw new Error('shell without bd-ver');
  const cur = await current();
  const name = APP + v;
  if (cur && cur.v === v && await caches.match('/', { cacheName: name })) return v;
  try {
    const assets = await fetchAssets(refs(html, self.location.origin + '/', /\s(?:src|href)="([^"]+)"/g));
    const cache = await caches.open(name);
    await Promise.all([...assets].map(([url, res]) => cache.put(url, res)));
    await cache.put('/', shell);
    if (gen !== run.gen) throw new Error('wiped during refresh');
    await (await caches.open(META)).put(CURRENT, new Response(JSON.stringify({ v, at: Date.now() }), { headers: { 'content-type': 'application/json' } }));
  } catch (e) {
    if (!cur || cur.v !== v) await caches.delete(name).catch(() => {});
    throw e;
  }
  await prune(v, cur && cur.v !== v ? cur.v : null);
  for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ bdShell: v });
  return v;
}
function refresh(force = false) {
  if (run.busy) return run.busy;
  if (!force && Date.now() - run.at < REFRESH_GAP) return current().then(c => c && c.v);
  run.busy = fill().then(v => { run.at = Date.now(); return v; }).finally(() => { run.busy = null; });
  return run.busy;
}
async function cachedShell() {
  const c = await current();
  return c ? caches.match('/', { cacheName: APP + c.v, ignoreSearch: true, ...MATCH }) : null;
}
function navigate(e, url) {
  const reset = url.searchParams.has('reset-cache');
  const ready = reset ? wipe().catch(() => {}) : Promise.resolve();
  e.respondWith(ready.then(() => reset ? null : cachedShell()).catch(() => null).then(r => r || fetch(e.request)));
  e.waitUntil(ready.then(() => refresh()).catch(() => {}));
}
async function versioned(e, url) {
  const req = e.request;
  const hit = await caches.match(req, MATCH).catch(() => null);
  if (hit) return hit;
  const res = await fetch(req);
  if (storable(res, ASSET_TYPE)) {
    const copy = res.clone(), v = url.searchParams.get('v');
    e.waitUntil(current().then(c => c && c.v === v ? caches.open(APP + v).then(cache => cache.put(req, copy)) : null).catch(() => {}));
  }
  return res;
}
async function unversioned(req) {
  const c = await current().catch(() => null);
  const hit = c ? await caches.match(req, { cacheName: APP + c.v, ...MATCH }).catch(() => null) : null;
  return hit || fetch(req);
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isShell(req, url)) return navigate(e, url);
  if (isVersioned(url)) return e.respondWith(versioned(e, url));
  if (isUnversioned(url)) return e.respondWith(unversioned(req));
});
async function wipeAll() {
  const busy = run.busy;
  await wipe();
  if (busy) { await busy.catch(() => {}); await wipe(); }
}
self.addEventListener('message', e => {
  const port = e.ports && e.ports[0];
  if (!e.data || !port) return;
  if (e.data.bdWipe) return e.waitUntil(wipeAll().catch(() => {}).then(() => port.postMessage({ wiped: true })));
  const want = e.data.bdRefresh;
  if (!want) return;
  e.waitUntil(refresh(true).then(v => v === want || v === null ? v : refresh(true)).catch(() => current().then(c => c && c.v)).catch(() => null).then(v => port.postMessage({ v: v || null })));
});
