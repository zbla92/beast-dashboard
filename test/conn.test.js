const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-conn.js'), 'utf8');

const boot = (opts = {}) => {
  let now = 1000000;
  const FEAT = {}, listeners = {}, timers = [];
  const el = () => ({ children: [], dataset: {}, hidden: false, textContent: '', classList: { on: false, toggle(c, v) { this.on = v; } } });
  const bar = el(), text = el(), retry = el();
  const reconnects = [];
  const h = (tag, props, ...kids) => {
    if (props && props.id === 'conn') return bar;
    if (props && props.class === 'conn-t') return text;
    if (props && props.class === 'conn-r') { retry.onclick = props.onclick; return retry; }
    return el();
  };
  class FakeDate { static now() { return now; } }
  const nav = { onLine: true };
  const doc = { hidden: false, body: { append() {} }, addEventListener(n, f) { listeners[n] = f; } };
  vm.runInNewContext(src, {
    FEAT, h, Date: FakeDate, document: doc, navigator: nav,
    performance: { now: () => opts.sincePageStart || 0 },
    LIVE: { connected: !!opts.live },
    SAVED: opts.stale ? { stale: true } : undefined,
    reconnect: () => reconnects.push(now),
    setInterval: f => timers.push(f),
    addEventListener: (n, f) => { listeners['w:' + n] = f; },
  });
  const tick = () => timers.forEach(f => f());
  const advance = ms => { now += ms; tick(); };
  return { conn: FEAT.conn, bar, text, retry, doc, nav, advance, tick, listeners, reconnects, kind: () => bar.dataset.kind, visible: () => bar.classList.on };
};

test('connecting shows nothing for the first 700 ms, then counts seconds', () => {
  const t = boot();
  t.advance(600);
  assert.strictEqual(t.visible(), false);
  t.advance(200);
  assert.strictEqual(t.visible(), true);
  assert.strictEqual(t.kind(), 'connecting');
  assert.strictEqual(t.text.textContent, 'Connecting to beast… 0s');
  t.advance(2000);
  assert.strictEqual(t.text.textContent, 'Connecting to beast… 2s');
});

test('a fast connection never shows the bar', () => {
  const t = boot();
  t.advance(400);
  t.conn.live();
  t.advance(2000);
  assert.strictEqual(t.visible(), false);
});

test('time since page start counts toward the 700 ms', () => {
  const t = boot({ sincePageStart: 900 });
  assert.strictEqual(t.visible(), true);
});

test('after 8 s of connecting the bar says it cannot reach beast and offers Retry', () => {
  const t = boot();
  t.advance(7900);
  assert.strictEqual(t.kind(), 'connecting');
  assert.strictEqual(t.retry.hidden, true);
  t.advance(200);
  assert.strictEqual(t.kind(), 'unreachable');
  assert.strictEqual(t.text.textContent, "Can't reach beast — is Tailscale on?");
  assert.strictEqual(t.retry.hidden, false);
});

test('Retry restarts the clock and calls reconnect', () => {
  const t = boot();
  t.advance(9000);
  t.retry.onclick();
  assert.strictEqual(t.reconnects.length, 1);
  assert.strictEqual(t.kind(), 'connecting');
  assert.strictEqual(t.text.textContent, 'Connecting to beast… 0s');
  t.advance(1000);
  assert.strictEqual(t.text.textContent, 'Connecting to beast… 1s');
  t.conn.live();
  assert.strictEqual(t.kind(), 'connected');
});

test('liveDown before any live does not turn into reconnecting', () => {
  const t = boot();
  t.conn.liveDown();
  t.advance(1000);
  assert.strictEqual(t.kind(), 'connecting');
});

test('reconnecting appears only after a live stream drops, with a 2 s grace', () => {
  const t = boot();
  t.conn.live();
  t.advance(5000);
  t.conn.liveDown();
  t.advance(1900);
  assert.strictEqual(t.visible(), false);
  t.advance(200);
  assert.strictEqual(t.kind(), 'reconnecting');
  assert.strictEqual(t.text.textContent, 'Reconnecting… 2s');
  t.advance(6000);
  assert.strictEqual(t.kind(), 'unreachable');
});

test('app reconnect attempts while reconnecting keep the clock', () => {
  const t = boot();
  t.conn.live();
  t.conn.liveDown();
  t.advance(3000);
  t.conn.reconnect();
  t.advance(1000);
  assert.strictEqual(t.text.textContent, 'Reconnecting… 4s');
});

test('offline shows at once with Retry', () => {
  const t = boot();
  t.conn.live();
  t.nav.onLine = false;
  t.listeners['w:offline']();
  assert.strictEqual(t.kind(), 'offline');
  assert.strictEqual(t.text.textContent, "You're offline");
  assert.strictEqual(t.retry.hidden, false);
});

test('hidden tab pauses counting and visible restarts the clock', () => {
  const t = boot();
  t.advance(1500);
  t.doc.hidden = true;
  t.advance(20000);
  assert.strictEqual(t.kind(), 'connecting');
  t.doc.hidden = false;
  t.listeners.visibilitychange();
  assert.strictEqual(t.kind(), 'hidden');
  t.advance(1000);
  assert.strictEqual(t.text.textContent, 'Connecting to beast… 1s');
});

test('Connected shows for 1.2 s after a shown state, then hides', () => {
  const t = boot();
  t.advance(1500);
  assert.strictEqual(t.visible(), true);
  t.conn.live();
  assert.strictEqual(t.kind(), 'connected');
  assert.strictEqual(t.text.textContent, 'Connected');
  t.advance(1100);
  assert.strictEqual(t.kind(), 'connected');
  t.advance(200);
  assert.strictEqual(t.visible(), false);
});

test('coming back online while the stream is live shows Connected', () => {
  const t = boot();
  t.conn.live();
  t.nav.onLine = false;
  t.listeners['w:offline']();
  t.nav.onLine = true;
  t.listeners['w:online']();
  assert.strictEqual(t.kind(), 'connected');
});

test('app.js reconnect while the stream is live: the bar shows connecting, then Connected, then hides', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const pick = re => { const m = app.match(re); assert.ok(m, String(re)); return m[0]; };
  const glue = [/^const LIVE = .*$/m, /^function liveUp\(\) .*$/m, /^function liveDown\(\) .*$/m, /^function reconnect\(\) .*$/m].map(pick).join('\n');
  let now = 1000000;
  const FEAT = {}, timers = [], streams = [];
  const el = () => ({ dataset: {}, hidden: false, textContent: '', classList: { on: false, toggle(c, v) { this.on = v; } } });
  const bar = el(), text = el(), retry = el();
  const h = (tag, props) => props && props.id === 'conn' ? bar : props && props.class === 'conn-t' ? text : props && props.class === 'conn-r' ? retry : el();
  class FakeDate { static now() { return now; } }
  const ctx = vm.createContext({
    FEAT, h, Date: FakeDate, navigator: { onLine: true }, performance: { now: () => 0 },
    document: { hidden: false, body: { append() {} }, addEventListener() {} },
    setInterval: f => timers.push(f), addEventListener() {}, setTimeout() {}, clearTimeout() {},
    UI: { es: null }, renderHeader() {}, renderLiveDot() {}, connect: () => streams.push(now),
    feat: (hook, ...a) => { for (const f of Object.values(FEAT)) if (f && typeof f[hook] === 'function') f[hook](...a); },
  });
  vm.runInContext(glue, ctx);
  vm.runInContext(src, ctx);
  const advance = ms => { now += ms; timers.forEach(f => f()); };
  vm.runInContext('liveUp()', ctx);
  advance(5000);
  assert.strictEqual(bar.classList.on, false);
  vm.runInContext('reconnect()', ctx);
  assert.strictEqual(streams.length, 1);
  advance(1500);
  assert.strictEqual(bar.dataset.kind, 'connecting');
  vm.runInContext('liveUp()', ctx);
  assert.strictEqual(bar.dataset.kind, 'connected');
  advance(1300);
  assert.strictEqual(bar.classList.on, false);
  vm.runInContext('reconnect(); liveDown()', ctx);
  advance(9000);
  assert.strictEqual(bar.dataset.kind, 'unreachable');
  vm.runInContext('liveUp()', ctx);
  assert.strictEqual(bar.dataset.kind, 'connected');
});

test('stale appends the last-known note to connecting, unreachable and offline, never to Connected', () => {
  const t = boot();
  t.conn.stale(true);
  t.advance(1000);
  assert.strictEqual(t.text.textContent, 'Connecting to beast… 1s · showing last known state');
  t.advance(8000);
  assert.strictEqual(t.text.textContent, "Can't reach beast — is Tailscale on? · showing last known state");
  t.conn.stale(false);
  t.tick();
  assert.strictEqual(t.text.textContent, "Can't reach beast — is Tailscale on?");
  t.conn.stale(true);
  t.conn.live();
  assert.strictEqual(t.text.textContent, 'Connected');
});

test('a page that restored cached state before f-conn loaded starts out stale', () => {
  const t = boot({ stale: true });
  t.advance(1000);
  assert.strictEqual(t.text.textContent, 'Connecting to beast… 1s · showing last known state');
});
