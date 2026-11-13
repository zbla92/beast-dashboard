'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { HOME, readJson, writeJson } = require('./util');

const ACCOUNTS = ['personal', 'company'];
const DEFAULT = { on: false, start: '07:00', end: '22:00' };
const DELAY = 60000;
const GRACE = 10 * 60000;
const FRESH = 20 * 60000;
const KEEP = 20;
const TIMEOUT = 90000;
const PROMPT = 'Reply with just: hey';
const ARGS = ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json'];
const INHERITED = ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PID'];
const KEEP_ENV = ['CLAUDE_CODE_AUTO_COMPACT_WINDOW'];

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const minutesOf = s => { const m = HM.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
const hhmm = s => { const n = minutesOf(s); return n == null ? null : `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; };
const atMinute = (now, min) => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(min / 60), min % 60).getTime(); };
const dayKey = now => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const ordered = (start, end) => start != null && end != null && minutesOf(start) < minutesOf(end);
function clean(all, prev) {
  const src = all && typeof all === 'object' ? all : {};
  const old = prev && typeof prev === 'object' ? prev : {};
  return Object.fromEntries(ACCOUNTS.map(a => {
    const c = src[a] && typeof src[a] === 'object' ? src[a] : {};
    const p = old[a] && typeof old[a] === 'object' ? old[a] : {};
    const start = hhmm(c.start) || DEFAULT.start, end = hhmm(c.end) || DEFAULT.end;
    const keep = ordered(hhmm(p.start), hhmm(p.end)) ? { start: hhmm(p.start), end: hhmm(p.end) } : { start: DEFAULT.start, end: DEFAULT.end };
    return [a, { on: c.on === true, ...(ordered(start, end) ? { start, end } : keep) }];
  }));
}
function config(all, account) {
  const c = clean(all)[account] || DEFAULT;
  return { on: c.on, start: minutesOf(c.start), end: minutesOf(c.end) };
}

function windowActive(lim, now, lastActivity) {
  const s = lim.session;
  if (s && !s.reset && ((s.resetsAt && s.resetsAt > now) || s.active)) return true;
  const since = s && s.reset ? s.resetAt : lim.fetchedAt;
  const last = typeof lastActivity === 'function' ? lastActivity() : lastActivity;
  return !!last && last > since;
}

function withSeenReset(lim, seen, now) {
  const s = lim && lim.session;
  if (!s || s.reset || s.resetsAt || s.active || !seen || seen > now) return lim;
  return { ...lim, session: { ...s, reset: true, resetAt: seen } };
}

function decide({ cfg, limits, lastActivity, done, busy, now }) {
  if (!cfg || !cfg.on || busy) return null;
  if (cfg.start == null || cfg.end == null || cfg.start >= cfg.end) return null;
  const dayStart = atMinute(now, cfg.start), dayEnd = atMinute(now, cfg.end);
  if (now < dayStart || now > dayEnd + GRACE) return null;
  if (!limits || limits.error || !limits.fetchedAt || limits.stale || now - limits.fetchedAt > FRESH) return null;
  const s = limits.session;
  const resetAt = s && s.reset ? s.resetAt : null;
  if (resetAt && now < resetAt + DELAY) return null;
  const key = resetAt && resetAt >= dayStart && resetAt <= dayEnd ? `reset:${resetAt}` : now <= dayEnd ? `start:${dayKey(now)}` : null;
  if (!key || (done || []).includes(key)) return null;
  if (windowActive(limits, now, lastActivity)) return null;
  return { key, slot: key.startsWith('reset:') ? resetAt : dayStart };
}

function create({ file, send, log = console.log }) {
  const saved = readJson(file, {});
  const accounts = saved && typeof saved.accounts === 'object' && saved.accounts ? saved.accounts : {};
  for (const r of Object.values(accounts)) if (r && r.last && r.last.ok == null) r.last = { ...r.last, ok: false, error: 'interrupted by a restart' };
  const data = { accounts };
  const busy = new Set();
  const save = () => { try { writeJson(file, data); } catch (e) { console.error('window-start save failed', e.message); } };

  function tick({ settings, accounts: list, limits, lastActivity, now = Date.now() }) {
    const started = [];
    for (const a of list || []) {
      const rec = data.accounts[a] || { keys: [], last: null };
      const lim = (limits || {})[a];
      const next = lim && lim.session && !lim.session.reset && lim.session.resetsAt > now ? lim.session.resetsAt : null;
      if (next && next !== rec.seen) { data.accounts[a] = { ...rec, seen: next }; save(); }
      const d = decide({ cfg: config(settings, a), limits: withSeenReset(lim, rec.seen, now), lastActivity: () => lastActivity && lastActivity(a), done: rec.keys, busy: busy.has(a), now });
      if (!d) continue;
      busy.add(a);
      const keys = d.key.startsWith('reset:') ? [d.key, `start:${dayKey(d.slot)}`] : [d.key];
      data.accounts[a] = { ...data.accounts[a], keys: [...new Set([...(rec.keys || []), ...keys])].slice(-KEEP), last: { key: d.key, at: now, ok: null, error: null } };
      save();
      started.push(Promise.resolve().then(() => send(a)).catch(e => ({ ok: false, error: e && e.message ? e.message : String(e) })).then(r => {
        const ok = !!(r && r.ok);
        const error = ok ? null : String((r && r.error) || 'failed').slice(0, 200);
        data.accounts[a] = { ...data.accounts[a], last: { ...data.accounts[a].last, ok, error, doneAt: Date.now() } };
        save(); busy.delete(a);
        log(`window-start: ${a} ${ok ? 'started the 5-hour window' : 'failed: ' + error} (${d.key})`);
        return { account: a, key: d.key, ok, error };
      }));
    }
    return started;
  }
  function status() { return Object.fromEntries(Object.entries(data.accounts).filter(([, r]) => r && r.last).map(([a, r]) => [a, r.last])); }
  return { tick, status };
}

function childEnv(account) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (INHERITED.includes(k) || k.startsWith('ANTHROPIC_') || (k.startsWith('CLAUDE_CODE_') && !KEEP_ENV.includes(k))) delete env[k];
  if (account === 'company') env.CLAUDE_CONFIG_DIR = require('./accounts').companyDir(); else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function verdict(code, out, err) {
  const j = (() => { try { return JSON.parse(out.trim().split('\n').pop()); } catch { return null; } })();
  if (code === 0 && j && j.is_error === false) return { ok: true };
  const why = (j && (j.result || j.subtype)) || err.trim().split('\n').pop() || `exited ${code}`;
  return { ok: false, error: String(why).slice(0, 200) };
}

function ping(account, { bin = 'claude', cwd, timeout = TIMEOUT, spawnFn = spawn } = {}) {
  return new Promise(resolve => {
    const st = { out: '', err: '', done: false, proc: null };
    const finish = r => {
      if (st.done) return; st.done = true; clearTimeout(timer);
      if (st.proc && st.proc.exitCode == null) { try { st.proc.kill('SIGTERM'); } catch {} setTimeout(() => { try { st.proc.kill('SIGKILL'); } catch {} }, 2000).unref(); }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer in ${Math.round(timeout / 1000)} s` }), timeout);
    try {
      fs.mkdirSync(cwd, { recursive: true });
      st.proc = spawnFn(bin, ARGS, { cwd, env: childEnv(account), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return finish({ ok: false, error: e.message }); }
    st.proc.on('error', e => finish({ ok: false, error: e.message }));
    st.proc.stdout.setEncoding('utf8'); st.proc.stdout.on('data', d => { st.out = (st.out + d).slice(-65536); });
    st.proc.stderr.setEncoding('utf8'); st.proc.stderr.on('data', d => { st.err = (st.err + d).slice(-2000); });
    st.proc.on('close', code => finish(verdict(code, st.out, st.err)));
    st.proc.stdin.on('error', () => {});
    st.proc.stdin.end(PROMPT);
  });
}

module.exports = { DEFAULT, DELAY, GRACE, FRESH, PROMPT, ARGS, clean, config, decide, windowActive, withSeenReset, create, ping, childEnv };
