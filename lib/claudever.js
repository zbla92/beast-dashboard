'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { HOME, readJson, writeJson, sleep } = require('./util');

const INHERITED = ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PID'];
const KEEP = ['CLAUDE_CODE_AUTO_COMPACT_WINDOW'];
const VER = /^\d+\.\d+\.\d+$/;
const POLL = 5 * 60e3, TIMEOUT = 15e3, RETRY = 5e3, KEEP_LKG = 2;
const ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio',
  '--dangerously-skip-permissions', '--no-session-persistence', '--setting-sources', ''];

let cfg = null, data = null, cur = null, checking = false, checkedAt = 0, timer = null, lastUsing, retryMs = RETRY;

const empty = () => ({ good: {}, bad: {}, lkg: null, pin: null });
const file = () => path.join(cfg.stateDir, 'claude-version.json');
const lkgDir = () => path.join(cfg.stateDir, 'claude-lkg');
const save = () => { try { writeJson(file(), data); } catch (e) { console.error('claude-version save failed', e); } };
const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const runnable = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

function init(opts) {
  cfg = { stateDir: opts.stateDir, versionsDir: opts.versionsDir || path.join(HOME, '.local', 'share', 'claude', 'versions'), link: opts.link || null, fake: opts.fake || null, onChange: opts.onChange || (() => {}) };
  if (opts.retryMs != null) retryMs = opts.retryMs;
  if (timer) { clearInterval(timer); timer = null; }
  cur = null; checking = false; checkedAt = 0; lastUsing = undefined;
  if (cfg.fake) { data = empty(); return; }
  data = { ...empty(), ...readJson(file(), empty()) };
  lastUsing = usingVer();
  if (opts.poll !== false) { refresh(); timer = setInterval(refresh, POLL); timer.unref(); }
}

function which() {
  const dirs = cfg.link ? [] : [...(process.env.PATH || '').split(':').filter(Boolean), path.join(HOME, '.local', 'bin')];
  for (const p of cfg.link ? [cfg.link] : dirs.map(d => path.join(d, 'claude'))) if (runnable(p)) { try { return fs.realpathSync(p); } catch {} }
  return null;
}

function currentVer() {
  const real = which(); if (!real) return null;
  let dir; try { dir = fs.realpathSync(cfg.versionsDir); } catch { return null; }
  const v = path.basename(real);
  return path.dirname(real) === dir && VER.test(v) ? v : null;
}

function verFile(v) {
  if (!v || !VER.test(v)) return null;
  for (const p of [path.join(cfg.versionsDir, v), path.join(lkgDir(), v)]) if (runnable(p)) return p;
  return null;
}

function usingVer() {
  if (data.pin && verFile(data.pin)) return data.pin;
  if (!cur) return null;
  if (data.good[cur] && verFile(cur)) return cur;
  if (data.lkg && verFile(data.lkg)) return data.lkg;
  return Object.keys(data.good).filter(verFile).sort(cmpVer).pop() || null;
}

function status() {
  if (cfg.fake) return { current: null, using: null, bin: cfg.fake, fallback: false, error: null, pin: null, checking: false, checkedAt: 0 };
  const using = usingVer();
  return { current: cur, using, bin: using ? verFile(using) : 'claude', fallback: !!(using && cur && using !== cur), error: cur && data.bad[cur] ? data.bad[cur].error : null, pin: data.pin, checking, checkedAt };
}

function changed() {
  const using = usingVer(); const prev = lastUsing; lastUsing = using;
  try { cfg.onChange(status(), prev); } catch (e) { console.error('claude-version listener', e); }
}

function refresh() {
  if (cfg.fake) return;
  const v = currentVer();
  const moved = v !== cur; cur = v;
  if (cur && !data.good[cur] && !data.bad[cur] && !checking) { runCheck(cur); return; }
  if (moved || usingVer() !== lastUsing) changed();
}

function bin() {
  if (cfg.fake) return cfg.fake;
  refresh();
  return status().bin;
}

function chatBin() {
  if (cfg.fake) return cfg.fake;
  refresh();
  const s = status();
  return s.fallback ? s.bin : 'claude';
}

function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (INHERITED.includes(k) || (k.startsWith('CLAUDE_CODE_') && !KEEP.includes(k))) delete env[k];
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function check(binPath) {
  return new Promise(resolve => {
    const t0 = Date.now(); let settled = false, buf = '', errTail = '', p;
    const finish = r => {
      if (settled) return; settled = true; clearTimeout(to);
      if (p) { try { p.stdin.end(); } catch {} try { p.kill('SIGTERM'); } catch {} setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 2000).unref(); }
      resolve({ ms: Date.now() - t0, ...r });
    };
    const to = setTimeout(() => finish({ ok: false, error: `no answer in ${TIMEOUT / 1000} s` }), TIMEOUT);
    try { p = spawn(binPath, ARGS, { cwd: os.tmpdir(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return finish({ ok: false, error: e.message }); }
    p.on('error', e => finish({ ok: false, error: e.message }));
    p.on('exit', (code, sig) => finish({ ok: false, error: `exited ${sig || code}${errTail.trim() ? ': ' + errTail.trim().split('\n').pop().slice(0, 200) : ''}` }));
    p.stdin.on('error', () => {});
    p.stderr.setEncoding('utf8'); p.stderr.on('data', d => { errTail = (errTail + d).slice(-600); });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (o.type !== 'control_response' || o.response?.request_id !== 'hc1') continue;
        return finish(o.response.subtype === 'success' ? { ok: true } : { ok: false, error: String(o.response.error || 'initialize failed').slice(0, 200) });
      }
      if (buf.length > 4 * 1024 * 1024) finish({ ok: false, error: 'output too large' });
    });
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'hc1', request: { subtype: 'initialize' } }) + '\n');
  });
}

function keepLkg(v) {
  const src = path.join(cfg.versionsDir, v), dir = lkgDir(), dst = path.join(dir, v);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(dst)) {
      try { fs.linkSync(src, dst); }
      catch { const tmp = dst + '.tmp'; try { fs.copyFileSync(src, tmp); fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, dst); } finally { fs.rmSync(tmp, { force: true }); } }
    }
    const keep = new Set([data.pin, v].filter(Boolean));
    const vers = fs.readdirSync(dir).filter(f => VER.test(f)).sort(cmpVer).reverse();
    vers.slice(0, KEEP_LKG).forEach(x => keep.add(x));
    for (const f of vers) if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  } catch (e) { console.error('claude-lkg keep failed', e.message); }
}

async function runCheck(v) {
  const p = path.join(cfg.versionsDir, v);
  checking = true; changed();
  let r = await check(p);
  if (!r.ok) { await sleep(retryMs); r = await check(p); }
  checking = false; checkedAt = Date.now();
  if (r.ok) { delete data.bad[v]; data.good[v] = checkedAt; if (!data.lkg || cmpVer(v, data.lkg) >= 0) data.lkg = v; keepLkg(v); }
  else {
    delete data.good[v]; data.bad[v] = { at: checkedAt, error: r.error };
    if (data.lkg === v) data.lkg = Object.keys(data.good).filter(verFile).sort(cmpVer).pop() || null;
    console.error(`claude ${v} failed the health check: ${r.error}`);
  }
  save(); changed();
  return r;
}

async function recheck() {
  if (cfg.fake) return status();
  cur = currentVer();
  if (!cur || checking) { changed(); return status(); }
  delete data.good[cur]; delete data.bad[cur];
  await runCheck(cur);
  return status();
}

function pin(v) {
  if (cfg.fake) return { ok: false, error: 'test mode' };
  if (v != null && !verFile(v)) return { ok: false, error: `claude ${v} is not installed` };
  data.pin = v == null ? null : v; save(); changed();
  return { ok: true, ...status() };
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { init, status, bin, chatBin, check, recheck, pin, refresh, stop };
