'use strict';
const MAX_AGE = 12 * 3600e3;
const MAX_HELD = 50;

function combined(items, now) {
  const names = [...new Set(items.map(x => x.who))];
  const title = names.length > 1 ? `${names.length} sessions need you` : `${names[0]} · ${items.length} updates`;
  const body = names.slice(0, 3).join(' · ') + (names.length > 3 ? ` +${names.length - 3}` : '');
  return { title, body, url: '/', tag: 'held-' + now };
}

function createStillDue({ get, live, tasks, watched }) {
  const unseen = (name, since) => { const r = get(name); return !watched(name) && (!r || (r.seenAt || 0) < since); };
  return item => {
    const c = item.check || {};
    if (c.type === 'state') { const r = get(c.session); return !!r && !r.gone && r.state === c.state && r.since === c.since && unseen(c.session, c.since); }
    if (c.type === 'ask') { const L = live(c.session); return !!(L && (L.pending || []).some(p => p.rid === c.rid)) && unseen(c.session, c.at || 0); }
    if (c.type === 'task') return tasks().some(t => t.id === c.id && t.status !== 'done' && t.result && t.result.at === c.at);
    if (c.type === 'seen') return unseen(c.session, c.at);
    return false;
  };
}

function createHeldPush({ still = () => true, allowed = () => true, deliver, now = Date.now }) {
  const held = new Map();
  const due = (x, t) => { try { return t - x.at <= MAX_AGE && still(x) && allowed(x); } catch { return false; } };
  const hold = (key, item) => {
    held.delete(key);
    held.set(key, { ...item, at: item.at ?? now() });
    while (held.size > MAX_HELD) held.delete(held.keys().next().value);
  };
  return {
    hold,
    release(extra = []) {
      const t = now();
      const items = [...extra, ...[...held.values()].filter(x => due(x, t))];
      held.clear();
      if (items.length) deliver(items.length === 1 ? items[0].push : combined(items, t), items);
      return items.length;
    },
    list: () => [...held],
    load(entries) { for (const e of Array.isArray(entries) ? entries : []) if (Array.isArray(e) && typeof e[0] === 'string' && e[1] && e[1].push) hold(e[0], e[1]); },
  };
}

module.exports = { createHeldPush, createStillDue, MAX_AGE, MAX_HELD };
