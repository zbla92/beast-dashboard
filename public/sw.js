// Beast Dash service worker: push notifications only (no caching — without the server there is nothing to show).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Beast Dash', body: e.data ? e.data.text() : '' }; }
  // quick replies straight from the notification (Chrome/Android/macOS show them; iOS ignores `actions` and just opens)
  const actions = d.kind === 'permission' ? [{ action: 'allow', title: '✓ Allow' }, { action: 'deny', title: '✕ Deny' }, { action: 'open', title: 'Open' }]
    : d.kind === 'done' ? [{ action: 'go', title: '👍 Yes, go on' }, { action: 'open', title: 'Open' }]
    : d.session ? [{ action: 'open', title: 'Open' }] : [];
  e.waitUntil(self.registration.showNotification(d.title || 'Beast Dash', { body: d.body || '', tag: d.tag || 'beast', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', actions, data: { url: d.url || '/', session: d.session || null } }));
});
const post = (path, body) => fetch('/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const sess = e.notification.data?.session;
  if (sess && e.action && e.action !== 'open') {   // reply without opening the app
    const p = e.action === 'allow' ? post('key', { session: sess, key: 'enter' }) : e.action === 'deny' ? post('key', { session: sess, key: 'esc' }) : post('send', { session: sess, text: 'Yes, go on.' });
    e.waitUntil(p.catch(() => {})); return;
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
