'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const AUTH_ERROR = /Please run \/login|Login expired|OAuth token has expired|authentication_error|API Error: 401|Invalid API key|Not logged in/i;
const CODE = /^[\x21-\x7e]{8,4096}$/;
const SESSION = /^[A-Za-z0-9_.-]{1,200}$/;
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b\s]+)(?:\x07|\x1b\\)/g;
const PLAIN = /https:\/\/[^\s/]+\/\S*oauth\/authorize\?\S+(?=\s)/g;
const HOST = /(?:^|\.)(?:claude\.com|claude\.ai|anthropic\.com)$/;
const INHERITED = ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PID'];
const OUT_MAX = 64 * 1024, LINE_MAX = 300, TEXT_MAX = 100000;
const EXPIRED = 'Login expired, start again';
const INNER = 'stty cols 4000 rows 40; exec "$BD_AUTH_CLAUDE" auth login';

const strip = s => s.replace(ANSI, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const secretsOf = code => [code, ...code.split('#').filter(p => p.length >= 4 && p !== code)];
const redact = (s, code) => code ? secretsOf(code).reduce((v, p) => v.split(p).join('[code]'), s) : s;
function signInUrl(u) {
  if (typeof u !== 'string' || !u.includes('/oauth/authorize?')) return null;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && !x.username && !x.password && !x.port && HOST.test(x.hostname) && x.pathname.endsWith('/oauth/authorize') ? u : null;
  } catch { return null; }
}
function urlOf(out) {
  const found = [...out.matchAll(OSC8)].map(m => m[1]).concat([...out.replace(ANSI, '').matchAll(PLAIN)].map(m => m[0]));
  for (const u of found) { const ok = signInUrl(u); if (ok) return ok; }
  return null;
}
function failLine(out) {
  const lines = out.split(/\r\n|\r|\n/).map(strip).filter(l => /Login failed:/.test(l));
  if (!lines.length) return null;
  const l = lines.pop();
  return l.slice(l.indexOf('Login failed:')).trim().slice(0, LINE_MAX);
}
function treeOf(pid) {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const ppid = +s.slice(s.lastIndexOf(')') + 2).split(' ')[1]; if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(+d); } catch {}
  }
  const out = [pid];
  for (const p of out) out.push(...(kids.get(p) || []));
  return out;
}
function safeTree(pid) {
  try { return treeOf(pid); } catch { return [pid]; }
}
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const pids = process.platform === 'linux' ? safeTree(pid) : [pid];
  try { process.kill(-pid, 'SIGKILL'); } catch {}
  for (const p of pids) { try { process.kill(-p, 'SIGKILL'); } catch {} try { process.kill(p, 'SIGKILL'); } catch {} }
}

function parseStatus(s) {
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { return null; }
}

function createAuthLogin(opts) {
  const o = { home: os.homedir(), timeoutMs: 15 * 60e3, okHoldMs: 120e3, checkGapMs: 10e3, statusTimeoutMs: 10e3, idle: async () => true, onChange: () => {}, ...opts };
  const recs = new Map(), lastText = new Map(), exitText = new Map(), failedText = new Map(), seenMsgs = new Map(), exited = new Set(), retrying = new Set();
  const guard = { on: false };

  const known = account => typeof account === 'string' && o.accounts().includes(account);
  const rec = account => {
    if (!recs.has(account)) recs.set(account, { loggedIn: null, expiresAt: null, checkedAt: null, authMethod: null, failed: null, retry: [], login: null, checking: null, lastCheck: 0 });
    return recs.get(account);
  };
  const changed = () => { try { o.onChange(); } catch {} };
  const fail = (status, error) => ({ status, body: { ok: false, error } });
  const pub = L => ({ id: L.id, state: L.state, url: L.url, startedAt: L.startedAt, endsAt: L.endsAt, message: L.message });
  const expired = r => r.expiresAt != null && r.expiresAt < Date.now();

  function view(account) {
    const r = rec(account);
    return { loggedIn: r.loggedIn, expiresAt: r.expiresAt, checkedAt: r.checkedAt, failed: r.failed && { at: r.failed.at, sessions: [...r.failed.sessions] },
      needsLogin: r.loggedIn === false || expired(r) || r.failed != null, retry: [...r.retry], login: r.login && pub(r.login) };
  }
  const state = () => Object.fromEntries(o.accounts().map(a => [a, view(a)]));

  function accountEnv(account) {
    const env = { ...process.env, HOME: o.home };
    for (const k of Object.keys(env)) if (INHERITED.includes(k) || k.startsWith('CLAUDE_CODE_')) delete env[k];
    if (account === 'company') env.CLAUDE_CONFIG_DIR = path.join(o.home, '.claude-company'); else delete env.CLAUDE_CONFIG_DIR;
    return env;
  }

  function statusOf(account) {
    return new Promise(resolve => {
      execFile(o.claudeBin(), ['auth', 'status', '--json'], { env: accountEnv(account), timeout: o.statusTimeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
        const s = String(stdout || '');
        const j = parseStatus(s);
        resolve(j && typeof j.loggedIn === 'boolean' ? j : null);
      });
    });
  }

  function check(account, force) {
    const r = rec(account);
    if (r.checking) return force ? r.checking.then(() => check(account, true)) : r.checking;
    if (!force && Date.now() - r.lastCheck < o.checkGapMs) return Promise.resolve(view(account));
    r.lastCheck = Date.now();
    r.checking = statusOf(account).then(j => {
      r.checking = null; r.checkedAt = Date.now();
      r.loggedIn = j ? j.loggedIn : null;
      r.expiresAt = j && j.loginExpiresAt ? Date.parse(j.loginExpiresAt) || null : null;
      r.authMethod = j && typeof j.authMethod === 'string' ? j.authMethod : null;
      changed();
      return view(account);
    });
    return r.checking;
  }

  function killAll() { for (const r of recs.values()) if (r.login && r.login.proc) { killTree(r.login.proc.pid); r.login.proc = null; } }
  function guardExit() {
    if (guard.on) return;
    guard.on = true;
    process.once('exit', killAll);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => { killAll(); process.kill(process.pid, sig); });
  }

  function end(L, st, message) {
    clearTimeout(L.timer);
    if (L.proc) { killTree(L.proc.pid); L.proc = null; }
    L.state = st; L.message = message; L.code = null; L.out = '';
  }
  function drop(r) {
    const L = r.login;
    if (!L) return;
    end(L, L.state, L.message); clearTimeout(L.hold);
    r.login = null;
  }

  function finished(account, r, L, code, sig) {
    if (r.login !== L || !L.proc) return;
    L.proc = null; clearTimeout(L.timer);
    const line = failLine(L.out);
    if (code !== 0 || line) { end(L, 'error', redact(line || `claude auth login stopped (${sig || 'exit ' + code})`, L.code)); changed(); return; }
    L.state = 'checking'; L.message = 'Checking the new login…'; L.code = null; L.out = ''; changed();
    check(account, true).then(v => {
      if (r.login !== L) return;
      if (!v.loggedIn) { end(L, 'error', 'claude auth login finished, but Claude still reports no login'); changed(); return; }
      end(L, 'ok', 'Signed in');
      r.failed = null;
      L.hold = setTimeout(() => { if (r.login === L) { r.login = null; changed(); } }, o.okHoldMs);
      L.hold.unref();
      changed();
    });
  }

  function start(account) {
    if (!known(account)) return fail(400, 'unknown account');
    const r = rec(account);
    drop(r);
    const now = Date.now();
    const L = { id: crypto.randomBytes(12).toString('base64url'), state: 'starting', url: null, startedAt: now, endsAt: now + o.timeoutMs, message: 'Starting claude auth login…', out: '', code: null, proc: null, timer: null, hold: null };
    r.login = L;
    const env = { ...accountEnv(account), BD_AUTH_CLAUDE: o.claudeBin(), BROWSER: 'true', TERM: 'xterm-256color', SHELL: '/bin/sh' };
    const args = process.platform === 'darwin' ? ['-q', '/dev/null', '/bin/sh', '-c', INNER] : ['-qfec', INNER, '/dev/null'];
    const p = (() => { try { return spawn('script', args, { env, cwd: o.home, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch { return null; } })();
    if (!p) { end(L, 'error', 'Could not start claude auth login'); changed(); return { status: 200, body: { ok: true, login: pub(L) } }; }
    L.proc = p;
    guardExit();
    p.on('error', e => { if (r.login !== L || !L.proc) return; end(L, 'error', e.code === 'ENOENT' ? 'The script command (util-linux) is missing: install it to sign in from here' : 'Could not start claude auth login'); changed(); });
    const take = d => {
      if (r.login !== L || !L.proc) return;
      L.out = redact(L.out + d, L.code).slice(-OUT_MAX);
      if (L.url) return;
      const u = urlOf(L.out);
      if (!u) return;
      L.url = u;
      if (L.state === 'starting') { L.state = 'waiting'; L.message = 'Open the sign-in page, then paste the code here'; }
      changed();
    };
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.stdin.on('error', () => {});
    p.on('exit', (code, sig) => finished(account, r, L, code, sig));
    L.timer = setTimeout(() => { if (r.login === L && L.proc) { end(L, 'expired', EXPIRED); changed(); } }, o.timeoutMs);
    L.timer.unref();
    changed();
    return { status: 200, body: { ok: true, login: pub(L) } };
  }

  function sendCode(account, id, code) {
    if (!known(account)) return fail(400, 'unknown account');
    const c = typeof code === 'string' ? code.trim() : '';
    if (!CODE.test(c)) return fail(400, 'The code must be 8–4096 characters with no spaces');
    const r = rec(account), L = r.login;
    if (!L || typeof id !== 'string' || L.id !== id || L.state !== 'waiting' || !L.proc) return fail(409, EXPIRED);
    L.code = c; L.out = redact(L.out, c);
    L.state = 'checking'; L.message = 'Checking the code…';
    try { L.proc.stdin.write(c + '\r'); } catch { end(L, 'error', 'Could not send the code, start again'); }
    changed();
    return { status: 200, body: { ok: true } };
  }

  function cancel(account) {
    if (!known(account)) return fail(400, 'unknown account');
    drop(rec(account)); changed();
    return { status: 200, body: { ok: true } };
  }

  async function checkOne(account) {
    if (!known(account)) return fail(400, 'unknown account');
    return { status: 200, body: { ok: true, auth: await check(account, false) } };
  }

  const owner = session => [...recs.entries()].find(([a, r]) => known(a) && r.retry.includes(session));
  function forgetRetry(session) {
    failedText.delete(session);
    for (const r of recs.values()) r.retry = r.retry.filter(n => n !== session);
  }

  async function retry(session, dismiss) {
    if (typeof session !== 'string' || !SESSION.test(session)) return fail(400, 'bad session');
    const hit = owner(session);
    if (!hit) return fail(409, 'Nothing to retry in this chat');
    if (dismiss) { forgetRetry(session); changed(); return { status: 200, body: { ok: true } }; }
    if (retrying.has(session)) return fail(409, 'Already retrying this chat');
    const [account, r] = hit;
    const text = failedText.get(session);
    if (!text) { forgetRetry(session); changed(); return fail(409, 'Nothing to retry in this chat'); }
    retrying.add(session);
    try {
      await check(account, false);
      if (r.loggedIn === false || expired(r)) return fail(409, 'Authenticate first');
      if (failedText.get(session) !== text) return fail(409, 'Nothing to retry in this chat');
      if (!(await idle(session))) return fail(409, 'The chat is busy, wait until it is idle');
      if (failedText.get(session) !== text) return fail(409, 'Nothing to retry in this chat');
      const rs = await o.restart(session);
      if (!rs || !rs.ok) return fail(409, (rs && rs.error) || 'Could not restart the chat');
      const s = await o.send(session, text);
      if (!s || !s.ok) return fail(s && s.status ? s.status : 409, (s && s.error) || 'Could not send the message again');
      forgetRetry(session); changed();
      return { status: 200, body: { ok: true } };
    } finally { retrying.delete(session); }
  }

  async function idle(session) {
    try { return (await o.idle(session)) === true; } catch { return false; }
  }

  function authFailed(name, text) {
    const account = o.sessionAccount(name);
    if (!known(account)) return;
    const r = rec(account);
    if (/api.?key/i.test(r.authMethod || '')) return;
    r.failed = { at: r.failed ? r.failed.at : Date.now(), sessions: [...new Set([...(r.failed ? r.failed.sessions : []), name])] };
    if (text) { failedText.set(name, text); if (!r.retry.includes(name)) r.retry.push(name); }
    changed();
    check(account, true);
  }

  function newMessage(name) {
    if (!failedText.has(name) && ![...recs.values()].some(r => r.retry.includes(name))) return;
    forgetRetry(name); changed();
  }

  function goodResult(name) {
    const hadRetry = failedText.has(name) || [...recs.values()].some(r => r.retry.includes(name));
    forgetRetry(name);
    const account = o.sessionAccount(name);
    const r = known(account) ? rec(account) : null;
    if (r && r.failed) r.failed = null;
    else if (!hadRetry) return;
    changed();
  }

  function inbox(name, ev) {
    const ids = ev.inbox.map(m => m && m.id).filter(id => typeof id === 'string');
    const seen = seenMsgs.get(name);
    seenMsgs.set(name, new Set(ids));
    const last = ev.inbox[ev.inbox.length - 1];
    if (last && typeof last.text === 'string' && last.text.trim()) lastText.set(name, last.text.slice(0, TEXT_MAX));
    if (ev.ev === 'inbox' && ids.some(id => !seen || !seen.has(id))) newMessage(name);
  }

  function onEvent(name, ev) {
    if (typeof name !== 'string' || !ev || typeof ev !== 'object') return;
    if ((ev.ev === 'inbox' || ev.ev === 'snapshot') && Array.isArray(ev.inbox)) inbox(name, ev);
    if (ev.ev === 'state') { if (ev.state === 'exited') exited.add(name); else { exited.delete(name); exitText.delete(name); } return; }
    if (ev.ev === 'snapshot') {
      const text = exitText.get(name);
      exitText.delete(name);
      if (exited.delete(name) && ev.state === 'exited' && AUTH_ERROR.test(String(ev.error || ''))) authFailed(name, text);
      return;
    }
    if (ev.ev !== 'result') return;
    const text = lastText.get(name);
    lastText.delete(name);
    if (ev.subtype === 'exited') exitText.set(name, text); else exitText.delete(name);
    if (ev.isError === true && AUTH_ERROR.test(String(ev.text || ''))) authFailed(name, text);
    else if (ev.isError === false) goodResult(name);
  }

  async function api(op, b) {
    const body = b && typeof b === 'object' ? b : {};
    switch (op) {
      case 'start': return start(body.account);
      case 'code': return sendCode(body.account, body.id, body.code);
      case 'cancel': return cancel(body.account);
      case 'check': return checkOne(body.account);
      case 'retry': return retry(body.session, !!body.dismiss);
      default: return fail(404, 'not found');
    }
  }

  function stop() {
    for (const r of recs.values()) drop(r);
  }

  return { state, api, onEvent, stop };
}

module.exports = { createAuthLogin, urlOf, redact };
