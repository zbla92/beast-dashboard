'use strict';
FEAT.conn = (() => {
  const SHOW_CONNECTING = 700, SHOW_RECONNECTING = 2000, UNREACHABLE = 8000, CONNECTED_FOR = 1200, TICK = 250;
  const PROBLEMS = ['connecting', 'reconnecting', 'unreachable', 'offline'];
  let base = typeof LIVE !== 'undefined' && LIVE.connected ? null : 'connecting';
  let since = Date.now() - (typeof performance !== 'undefined' ? performance.now() : 0);
  let until = 0, shown = false, kind = 'hidden', label = '';
  const text = h('span', { class: 'conn-t' });
  const retry = h('button', { type: 'button', class: 'conn-r', onclick: () => retryNow() }, 'Retry');
  const bar = h('div', { id: 'conn', class: 'conn', role: 'status', 'aria-live': 'polite' }, text, retry);
  document.body.append(bar);

  const STALE_NOTE = ' · showing last known state';
  const mark = { stale: typeof SAVED !== 'undefined' && SAVED.stale };
  const compute = t => {
    const v = measure(t);
    return mark.stale && v.label && v.kind !== 'connected' ? { kind: v.kind, label: v.label + STALE_NOTE } : v;
  };
  const measure = t => {
    if (navigator.onLine === false) return { kind: 'offline', label: "You're offline" };
    if (!base) return t < until ? { kind: 'connected', label: 'Connected' } : { kind: 'hidden', label: '' };
    const ms = t - since;
    if (ms >= UNREACHABLE) return { kind: 'unreachable', label: "Can't reach beast — is Tailscale on?" };
    if (ms < (base === 'connecting' ? SHOW_CONNECTING : SHOW_RECONNECTING)) return { kind: 'hidden', label: '' };
    const s = Math.floor(ms / 1000);
    return base === 'connecting' ? { kind: 'connecting', label: `Connecting to beast… ${s}s` } : { kind: 'reconnecting', label: `Reconnecting… ${s}s` };
  };

  function update() {
    const t = Date.now();
    let v = compute(t);
    if (v.kind === 'hidden' && !base && shown) { until = t + CONNECTED_FOR; v = compute(t); }
    shown = PROBLEMS.includes(v.kind);
    if (v.label !== label) { label = v.label; if (label) text.textContent = label; }
    if (v.kind !== kind) {
      kind = v.kind;
      bar.dataset.kind = kind;
      bar.classList.toggle('on', kind !== 'hidden');
      retry.hidden = kind !== 'unreachable' && kind !== 'offline';
    }
  }

  function retryNow() {
    if (!base) base = 'connecting';
    since = Date.now() - (base === 'connecting' ? SHOW_CONNECTING : SHOW_RECONNECTING);
    update();
    reconnect();
  }

  setInterval(() => { if (!document.hidden) update(); }, TICK);
  document.addEventListener('visibilitychange', () => { if (document.hidden) return; since = Date.now(); update(); });
  addEventListener('online', update);
  addEventListener('offline', update);
  update();

  return {
    stale(on) { mark.stale = !!on; update(); },
    live() { base = null; update(); },
    liveDown() { if (base) return; base = 'reconnecting'; since = Date.now(); update(); },
    reconnect() { if (base) return; base = 'connecting'; since = Date.now(); update(); },
    retryNow,
  };
})();
