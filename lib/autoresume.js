'use strict';
const { family } = require('./usage');

const PROMPT = 'continue';
const DELAY = 60000;
const HORIZON = 8 * 86400e3;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const keyOf = (session, resetsAt) => `resume:${session}:${resetsAt}`;
const toMinute = ms => Math.round(ms / 60000) * 60000;

function zone(tz) {
  if (!tz) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return undefined; }
}
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const o = {}; for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = +p.value;
  return o;
}
function offsetOf(ms, tz) {
  const p = partsIn(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
function wallToMs(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  return guess - offsetOf(guess - offsetOf(guess, tz), tz);
}

function parseResetText(text, now) {
  const s = String(text || '');
  const epoch = s.match(/\|(\d{10})(?!\d)/);
  if (epoch) return +epoch[1] * 1000;
  const rel = s.match(/resets?\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?/i);
  if (rel && (rel[1] || rel[2])) return now + ((+rel[1] || 0) * 60 + (+rel[2] || 0)) * 60000;
  const m = s.match(/resets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i);
  if (!m || (!m[4] && !m[5])) return null;
  const ap = (m[5] || '').toLowerCase();
  const hour = ap ? (+m[3] % 12) + (ap === 'pm' ? 12 : 0) : +m[3], min = +(m[4] || 0);
  if (hour > 23 || min > 59 || (ap && +m[3] > 12)) return null;
  const tz = zone(m[6] && m[6].trim());
  const today = partsIn(now, tz);
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()); if (mo < 0) return null;
    const at = wallToMs(today.year, mo, +m[2], hour, min, tz);
    return at < now - 86400e3 ? wallToMs(today.year + 1, mo, +m[2], hour, min, tz) : at;
  }
  const at = wallToMs(today.year, today.month - 1, today.day, hour, min, tz);
  return at > now ? at : wallToMs(today.year, today.month - 1, today.day + 1, hour, min, tz);
}

function resetsAtFor(limits, limitText, now, model) {
  const fam = family(model);
  const scoped = fam === 'other' ? [] : ((limits && limits.scoped) || []).filter(w => w && family(w.name) === fam);
  const wins = limits ? [limits.session, limits.weekly, ...scoped] : [];
  const full = wins.filter(w => w && w.pct >= 100 && w.resetsAt > now).map(w => w.resetsAt);
  const at = full.length ? Math.max(...full) : parseResetText(limitText, now);
  return at && at > now && at - now <= HORIZON ? toMinute(at) : null;
}

const inLimit = rec => !!rec && rec.mode === 'chat' && rec.state === 'limit';
const holdsChat = inLimit;

function plan({ enabled, name, rec, limits, jobs, now }) {
  if (!enabled || !inLimit(rec)) return null;
  const resetsAt = resetsAtFor(limits && limits[rec.account], rec.limitText || rec.lastMessage, now, rec.model);
  if (!resetsAt) return null;
  const key = keyOf(name, resetsAt);
  if ((jobs || []).some(j => j.key === key)) return null;
  return { session: name, at: resetsAt + DELAY, key, limitAt: rec.since || now, resetsAt };
}

function shouldFire({ enabled, job, rec, jobs }) {
  if (!enabled || !inLimit(rec)) return false;
  if ((rec.promptAt || 0) > job.limitAt) return false;
  return !(jobs || []).some(o => o.id !== job.id && o.session === job.session && (o.lastSentAt || 0) > job.limitAt);
}

module.exports = { PROMPT, DELAY, keyOf, parseResetText, resetsAtFor, plan, shouldFire, holdsChat };
