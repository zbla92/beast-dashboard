'use strict';
// Which chat someone is looking at right now. Every open dashboard tab reports it (POST /api/watching) every 10 s
// while the tab is visible, focused and was used in the last 10 min, and null when it stops. A report older than
// TTL no longer counts: a closed lid or a killed tab never says goodbye.
const TTL = 25000;
const MAX = 100;   // tabs remembered at once
const ID = /^[A-Za-z0-9_-]{6,40}$/;
const NAME = /^[\w.-]{1,64}$/;

function createWatching(ttl = TTL) {
  const tabs = new Map();   // tab id -> { session, at }
  const prune = now => { for (const [id, w] of tabs) if (now - w.at > ttl) tabs.delete(id); };
  return {
    report(id, session, now = Date.now()) {
      if (typeof id !== 'string' || !ID.test(id)) return { ok: false, error: 'bad id' };
      if (session == null) { tabs.delete(id); return { ok: true }; }
      if (typeof session !== 'string' || !NAME.test(session)) return { ok: false, error: 'bad session' };
      prune(now);
      if (tabs.size >= MAX && !tabs.has(id)) return { ok: false, error: 'too many tabs' };
      tabs.set(id, { session, at: now });
      return { ok: true };
    },
    watched(session, now = Date.now()) {
      prune(now);
      for (const w of tabs.values()) if (w.session === session) return true;
      return false;
    },
  };
}

module.exports = { createWatching, TTL };
