'use strict';
// Which chat someone is looking at right now. Every open dashboard tab reports it (POST /api/watching) every 10 s
// while the tab is visible, focused and was used in the last 10 min, and null when it stops. A report older than
// TTL no longer counts: a closed lid or a killed tab never says goodbye.
const TTL = 25000;
const LONG_TTL = 150000;
const MAX = 100;   // tabs remembered at once
const ID = /^[A-Za-z0-9_-]{6,40}$/;
const NAME = /^[\w.-]{1,64}$/;

function createWatching(ttl = TTL, longTtl = LONG_TTL) {
  const tabs = new Map();   // tab id -> { session, active, detector, at }
  const subs = [];
  const live = w => (w.active && w.detector ? longTtl : ttl);
  const prune = now => { for (const [id, w] of tabs) if (now - w.at > live(w)) tabs.delete(id); };
  const anyActive = now => { prune(now); for (const w of tabs.values()) if (w.active) return true; return false; };
  const state = { was: false };
  const check = now => {
    const is = anyActive(now);
    if (is === state.was) return is;
    state.was = is;
    for (const fn of subs) { try { fn(is, now); } catch {} }
    return is;
  };
  return {
    report(id, session, now = Date.now(), active = false, detector = false) {
      if (typeof id !== 'string' || !ID.test(id)) return { ok: false, error: 'bad id' };
      if (session == null && !active) { tabs.delete(id); check(now); return { ok: true }; }
      if (session != null && (typeof session !== 'string' || !NAME.test(session))) return { ok: false, error: 'bad session' };
      prune(now);
      if (tabs.size >= MAX && !tabs.has(id)) return { ok: false, error: 'too many tabs' };
      tabs.set(id, { session: session ?? null, active: !!active, detector: !!detector, at: now });
      check(now);
      return { ok: true };
    },
    watched(session, now = Date.now()) {
      prune(now);
      for (const w of tabs.values()) if (w.session === session && now - w.at <= ttl) return true;
      return false;
    },
    active: (now = Date.now()) => anyActive(now),
    check: (now = Date.now()) => check(now),
    onChange(fn) { subs.push(fn); },
  };
}

module.exports = { createWatching, TTL, LONG_TTL };
