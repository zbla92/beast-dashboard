'use strict';
const SETTLE = 60000;
const QUICK = 5000;
const MAX_WAIT = 15 * 60000;
const NOTE = /^\s*<task-notification>/;

const fromNotification = prompt => NOTE.test(String(prompt || ''));

const liveRoster = live => !!(live && !live.stale && Array.isArray(live.tasks));
const liveItem = t => ({ id: t.id || null, description: t.description || t.id || t.kind, kind: t.kind, startedAt: t.startedAt == null ? null : t.startedAt, progress: t.progress == null ? null : t.progress });

function fromRoster(r, tasks, now, maxWait) {
  const askedAt = (r && r.askedAt) || 0;
  const expired = !!(r && r.stopAt && r.stopAt >= askedAt && now - r.stopAt > maxWait);
  const agents = tasks.filter(t => t && (t.kind === 'agent' || t.kind === 'task')).map(liveItem);
  const shells = tasks.filter(t => t && (t.kind === 'shell' || t.kind === 'monitor') && (t.awaited || (!expired && Number(t.startedAt) >= askedAt))).map(liveItem);
  return { agents, shells };
}

function waitingOn(r, live, now = Date.now(), maxWait = MAX_WAIT) {
  const queued = live && !live.stale ? (live.inbox || []).length : 0;
  const busy = !!(live && !live.stale && (live.state !== 'idle' || live.turn || (live.pending || []).length));
  if (liveRoster(live)) return { ...fromRoster(r, live.tasks, now, maxWait), queued, busy, source: 'live' };
  const agents = ((r && r.bgTasks) || []).map(t => ({ id: t.id || null, description: t.description || t.type || t.id || 'agent' }));
  const before = new Set((r && r.shellsAtAsk) || []);
  const fresh = r && r.stopAt && now - r.stopAt > maxWait ? [] : ((r && r.bgShells) || []).filter(id => !before.has(id));
  const info = new Map(((r && r.bgShellInfo) || []).map(t => [t.id, t.description]));
  const shells = fresh.map(id => ({ id, description: info.get(id) || id }));
  return { agents, shells, queued, busy, source: 'hook' };
}

function liveVerdict(live, updatedAt, now = Date.now(), owed = false) {
  if (!liveRoster(live)) return true;
  const last = live.lastResult;
  if (last && (last.interrupted || (!owed && last.end === 'wake' && last.wakeOutcome === 'updated'))) return false;
  const lastAt = (last && last.at) || 0;
  const wake = live.wake;
  if (wake && wake.at > lastAt && now - wake.at < SETTLE) return 'soon';
  const final = last && last.end === 'wake' && wake && wake.outcome !== 'updated' ? wake : null;
  if (final && updatedAt != null && final.at >= updatedAt && final.at - updatedAt < QUICK && now - lastAt < 2 * QUICK) return 'soon';
  return true;
}

function createRosterWatch() {
  const seen = new Map();
  const check = (name, held, present, askedAt) => {
    const asked = askedAt || 0;
    const prev = seen.get(name);
    const same = !!prev && prev.asked === asked;
    const ended = same && prev.held.some(id => !present.includes(id));
    const emptied = !same || held.length ? false : ended || prev.emptied;
    seen.set(name, { asked, held: [...held], emptied });
    return emptied;
  };
  return { check, forget: name => seen.delete(name), names: () => [...seen.keys()] };
}

const holds = w => !!(w && (w.agents.length || w.shells.length || w.queued || w.busy));

function createDonePush({ settle = SETTLE, quick = QUICK, maxWait = MAX_WAIT, ready, send, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const waiting = new Map();
  const sentFor = new Map();
  const owed = new Map();
  const owes = (name, askedAt) => { const o = owed.get(name); return !!(o && o.askedAt === askedAt && o.real); };
  const settled = (name, askedAt) => { const o = owed.get(name); if (o && o.askedAt === askedAt) o.real = false; };
  const cancel = name => { const w = waiting.get(name); if (!w) return; clearTimer(w.timer); waiting.delete(name); };
  const arm = (name, w, ms) => { w.due = now() + ms; w.timer = setTimer(() => fire(name, w).catch(() => false), ms); };
  async function fire(name, w) {
    w.checking = true;
    const verdict = await Promise.resolve().then(() => ready(name, w.mark, owes(name, w.askedAt))).catch(() => false);
    w.checking = false;
    if (waiting.get(name) !== w) return false;
    const hurry = w.hurry;
    w.hurry = false;
    if ((verdict === 'wait' || verdict === 'soon' || verdict === 'hold') && now() - w.at < maxWait) { arm(name, w, verdict === 'soon' || hurry ? quick : settle); return false; }
    waiting.delete(name);
    settled(name, w.askedAt);
    if (!verdict || verdict === 'hold') return false;
    const pushed = (() => { try { return send(name) !== false; } catch { return false; } })();
    if (pushed && w.askedAt != null) sentFor.set(name, w.askedAt);
    return pushed;
  }
  return {
    schedule(name, mark, askedAt = null, real = false) {
      cancel(name);
      if (askedAt != null && sentFor.get(name) === askedAt) return false;
      const o = owed.get(name);
      if (!o || o.askedAt !== askedAt) owed.set(name, { askedAt, real: !!real, forgone: false });
      else if (real && !o.forgone) o.real = true;
      const w = { mark, askedAt, at: now(), timer: null, due: 0, checking: false, hurry: false };
      waiting.set(name, w);
      arm(name, w, settle);
      return true;
    },
    soon(name) {
      const w = waiting.get(name);
      if (!w) return false;
      if (w.checking) { w.hurry = true; return true; }
      if (w.due - now() <= quick) return true;
      clearTimer(w.timer);
      arm(name, w, quick);
      return true;
    },
    forgo(name, askedAt = null) { owed.set(name, { askedAt, real: false, forgone: true }); },
    forget(name) { cancel(name); sentFor.delete(name); owed.delete(name); },
    names() { return [...new Set([...waiting.keys(), ...sentFor.keys(), ...owed.keys()])]; },
    cancel,
  };
}

module.exports = { createDonePush, createRosterWatch, fromNotification, waitingOn, liveRoster, liveVerdict, holds, SETTLE, QUICK, MAX_WAIT };
