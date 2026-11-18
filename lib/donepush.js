'use strict';
const SETTLE = 60000;
const MAX_WAIT = 15 * 60000;
const NOTE = /^\s*<task-notification>/;

const fromNotification = prompt => NOTE.test(String(prompt || ''));

function createDonePush({ settle = SETTLE, maxWait = MAX_WAIT, ready, send, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const waiting = new Map();
  const sentFor = new Map();
  const cancel = name => { const w = waiting.get(name); if (!w) return; clearTimer(w.timer); waiting.delete(name); };
  const arm = (name, w) => { w.timer = setTimer(() => fire(name, w).catch(() => false), settle); };
  async function fire(name, w) {
    const verdict = await Promise.resolve().then(() => ready(name, w.mark)).catch(() => false);
    if (waiting.get(name) !== w) return false;
    if (verdict === 'wait' && now() - w.at < maxWait) { arm(name, w); return false; }
    waiting.delete(name);
    if (!verdict) return false;
    const pushed = (() => { try { return send(name) !== false; } catch { return false; } })();
    if (pushed && w.askedAt != null) sentFor.set(name, w.askedAt);
    return pushed;
  }
  return {
    schedule(name, mark, askedAt = null) {
      cancel(name);
      if (askedAt != null && sentFor.get(name) === askedAt) return false;
      const w = { mark, askedAt, at: now(), timer: null };
      waiting.set(name, w);
      arm(name, w);
      return true;
    },
    cancel,
  };
}

module.exports = { createDonePush, fromNotification, SETTLE, MAX_WAIT };
