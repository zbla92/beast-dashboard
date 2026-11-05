'use strict';
// Plan limits per account (what `/usage` shows inside Claude Code): 5-hour session window, 7-day window, the
// per-model weekly windows (Fable) and extra-usage credits. Read from the same OAuth endpoint Claude Code uses,
// with the token Claude Code keeps in <config>/.credentials.json.
//
// We never refresh the token ourselves: Claude Code rotates it while it runs and a second refresher would
// invalidate its copy. If the token has expired and no session has refreshed it, the account shows "token
// expired" until the user runs claude once.
const fs = require('fs');
const path = require('path');
const { HOME, STATE, readJson, writeJson } = require('./util');
const FILE = path.join(STATE, 'limits.json');   // persisted so a dashboard restart does NOT mean another request

const ACCOUNTS = { personal: path.join(HOME, '.claude'), company: path.join(HOME, '.claude-company') };
const URL = 'https://api.anthropic.com/api/oauth/usage';
const EVERY = 15 * 60000;          // every 15 min (was 30) — this endpoint is rate limited together with the account and undocumented; reports of 429s at 5 min, never go below this
const EXPIRED = 'token expired — run claude once to refresh it';
const MIN_GAP = 10 * 60000;        // an on-demand refresh (a session hit its limit) at most this often
const saved = readJson(FILE, {});
const state = saved.accounts || {};   // account -> normalized record
let timer = null; let inflight = null; let lastFetch = saved.lastFetch || 0; let backoffUntil = saved.backoffUntil || 0;
function persist() { try { writeJson(FILE, { accounts: state, lastFetch, backoffUntil }); } catch {} }

function creds(dir) {
  try { const o = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth; return o && o.accessToken ? o : null; } catch { return null; }
}
const pct = v => v == null ? null : Math.round(Number(v));
function normalize(j, c) {
  const win = (w, extra) => w ? { pct: pct(w.percent != null ? w.percent : w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) : null, severity: w.severity || null, active: !!w.is_active, ...extra } : null;
  const lim = Array.isArray(j.limits) ? j.limits : [];
  const byKind = k => lim.find(l => l.kind === k);
  // per-model weekly windows ("Fable"): everything scoped, keyed by the display name the API gives
  const scoped = lim.filter(l => l.kind === 'weekly_scoped' && l.scope).map(l => win(l, { name: l.scope.model?.display_name || l.scope.surface || 'scoped' }));
  const sp = j.spend || {}; const money = m => m && m.amount_minor != null ? m.amount_minor / Math.pow(10, m.exponent ?? 2) : null;
  return {
    plan: c.subscriptionType || null, tier: c.rateLimitTier || null,
    session: win(byKind('session') || j.five_hour), weekly: win(byKind('weekly_all') || j.seven_day), scoped,
    extra: { enabled: !!(sp.enabled || j.extra_usage?.is_enabled), used: money(sp.used), limit: money(sp.limit), pct: pct(sp.percent), currency: sp.used?.currency || 'USD' },
    breakdown: j.seven_day_breakdown?.rows?.map(r => ({ name: r.display_name, pct: pct(r.percent) })) || null,
    fetchedAt: Date.now(), triedAt: Date.now(), error: null,
  };
}

async function fetchOne(account, dir) {
  const prev = state[account] || {}; const c = creds(dir);
  const failed = error => { state[account] = { ...prev, error, triedAt: Date.now() }; };
  if (Date.now() < backoffUntil) return;
  if (!c) return failed('no credentials');
  if (c.expiresAt && c.expiresAt < Date.now()) return failed(EXPIRED);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(URL, { headers: { authorization: 'Bearer ' + c.accessToken, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' }, signal: ctl.signal });
    clearTimeout(t);
    console.log(`limits: ${account} -> HTTP ${r.status}`);
    if (r.status === 429) {   // back off for what Retry-After says (at least an hour) and keep showing the last numbers
      const ra = +r.headers.get('retry-after'); backoffUntil = Date.now() + Math.max(3600000, ra > 0 ? ra * 1000 : 0);
      return failed('rate limited — next try ' + new Date(backoffUntil).toLocaleTimeString());
    }
    if (r.status === 401 || r.status === 403) return failed(c.expiresAt && c.expiresAt < Date.now() ? EXPIRED : 'HTTP ' + r.status);
    if (!r.ok) return failed('HTTP ' + r.status);
    state[account] = normalize(await r.json(), c);
  } catch (e) { failed(e.name === 'AbortError' ? 'timeout' : (e.message || String(e))); }
}
// force: the scheduled tick. Otherwise (on-demand, e.g. a session just hit its limit) only if the last fetch is old enough.
function refresh(force, only) {
  if (inflight) return inflight;
  if (Date.now() < backoffUntil) return Promise.resolve();
  if (!force && Date.now() - lastFetch < MIN_GAP) return Promise.resolve();
  lastFetch = Date.now();
  inflight = Object.entries(ACCOUNTS).filter(([a]) => !only || only.includes(a)).reduce((p, [a, d]) => p.then(() => fetchOne(a, d)), Promise.resolve()).finally(() => { inflight = null; persist(); });   // one account at a time
  return inflight;
}
function start(onUpdate) {
  if (timer) return;
  const done = () => { try { onUpdate && onUpdate(); } catch {} };
  // first fetch only when the persisted one is older than the interval — restarts must not add requests
  const next = () => {
    clearTimeout(timer); const wait = Math.max(0, lastFetch + EVERY - Date.now(), backoffUntil - Date.now());
    timer = setTimeout(() => Date.now() - lastFetch < EVERY - 1000 ? next() : refresh(true).then(done).finally(next), wait);
    return wait;
  };
  console.log(`limits: next fetch in ${Math.round(next() / 60000)} min, then every ${EVERY / 60000} min`);
  const seen = {}; for (const [a, d] of Object.entries(ACCOUNTS)) seen[a] = creds(d)?.expiresAt;
  const pending = new Set();
  setInterval(() => {
    for (const [a, d] of Object.entries(ACCOUNTS)) { const e = creds(d)?.expiresAt; if (e !== seen[a]) { seen[a] = e; if (state[a]?.error) pending.add(a); } }
    if (pending.size && !inflight && Date.now() >= backoffUntil && Date.now() - lastFetch >= MIN_GAP) { const only = [...pending]; pending.clear(); refresh(true, only).then(done).finally(next); }
  }, 60000).unref();
}
function view(rec, now) {
  const fix = w => w && w.resetsAt && w.resetsAt <= now ? { ...w, pct: 0, resetsAt: null, severity: null, reset: true, resetAt: w.resetsAt } : w;
  return { ...rec, session: fix(rec.session), weekly: fix(rec.weekly), scoped: (rec.scoped || []).map(fix), stale: !!rec.error || !rec.fetchedAt || now - rec.fetchedAt > 2 * EVERY };
}
function all(now = Date.now()) { const out = {}; for (const [a, r] of Object.entries(state)) out[a] = view(r, now); return out; }

module.exports = { start, refresh, all, view };
