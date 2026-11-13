'use strict';
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { run, shq, tdir, sleep } = require('./util');
const { interactive } = require('./mac/shell');
const claude = require('./claude');

const RUNNER = path.join(__dirname, '..', 'bin', 'headless-runner.js');
const NAME = /^[A-Za-z0-9_.-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let port = 8787, test = false, claudeBin = 'claude';
const SHELL_OUT = 64 * 1024, SHELL_ID = /^s-\d+$/;
const conns = new Map();
const listeners = [];

function init(opts) { port = opts.port; test = !!opts.test; if (opts.claudeBin) claudeBin = opts.claudeBin; }
function sockDir() {
  const base = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : path.join(os.tmpdir(), `beast-dash-${process.getuid()}`);
  const dir = path.join(base, test ? `beast-dash-test-${port}` : 'beast-dash');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  return dir;
}
const sockPath = name => path.join(sockDir(), name + '.sock');
const configDir = account => path.join(os.homedir(), account === 'company' ? '.claude-company' : '.claude');
const transcriptOf = (cwd, account, sid) => path.join(configDir(account), 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), sid + '.jsonl');

function runnerArgs(opts) {
  const extra = opts || {}, args = [];
  if (extra.permissionMode && extra.permissionMode !== 'bypassPermissions') args.push('--permission-mode', extra.permissionMode);
  for (const d of extra.addDirs || []) args.push('--add-dir', d);
  if (extra.model) args.push('--model', extra.model);
  if (extra.effort) args.push('--effort', extra.effort);
  if (extra.exitAfterResult) args.push('--exit-after-result');
  return args;
}

function runnerCmd(name, cwd, account, sessionId, start, forkFrom, extra) {
  const args = [process.execPath, RUNNER, '--sock', sockPath(name), '--cwd', cwd, '--session-id', sessionId, '--start', start, '--account', account, '--name', name];
  if (start === 'fork') args.push('--fork-from', forkFrom);
  args.push(...runnerArgs(extra));
  const bin = typeof claudeBin === 'function' ? claudeBin() : claudeBin;
  if (bin && bin !== 'claude') args.push('--claude', bin);
  return `${interactive()} ${shq('exec ' + args.map(shq).join(' '))}`;
}

function findTranscript(cwd, account, sessionId, known) {
  if (!UUID.test(sessionId || '')) return null;
  const root = path.join(configDir(account), 'projects');
  const dir = typeof cwd === 'string' && path.isAbsolute(cwd) && fs.existsSync(cwd) ? path.resolve(cwd) : null;
  const inConfig = typeof known === 'string' && path.basename(known) === sessionId + '.jsonl' && path.dirname(path.dirname(known)) === root;
  if (inConfig && fs.existsSync(known)) return { dir, file: known };
  for (let d = dir; d; d = d === path.dirname(d) ? null : path.dirname(d)) {
    if (fs.existsSync(transcriptOf(d, account, sessionId))) return { dir, file: transcriptOf(d, account, sessionId) };
  }
  let dirs = []; try { dirs = fs.readdirSync(root); } catch {}
  const file = dirs.map(d => path.join(root, d, sessionId + '.jsonl')).find(f => fs.existsSync(f));
  return file ? { dir, file } : null;
}

function locateTranscript(cwd, account, sessionId) {
  if (!UUID.test(sessionId || '') || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  for (const acc of account === 'company' || account === 'personal' ? [account] : ['personal', 'company']) {
    for (let d = path.resolve(cwd); d; d = d === path.dirname(d) ? null : path.dirname(d)) {
      const file = transcriptOf(d, acc, sessionId);
      if (fs.existsSync(file)) return { dir: d, file, account: acc };
    }
  }
  return null;
}

function recordAccount(rec) {
  if (rec && (rec.account === 'company' || rec.account === 'personal')) return rec.account;
  return rec && String(rec.tmux || '').endsWith('-company') ? 'company' : null;
}

async function respawn(name, cwd, account, sessionId, forkFrom, extra) {
  if (!NAME.test(name || '') || !UUID.test(sessionId || '') || (forkFrom && !UUID.test(forkFrom))) return { ok: false, error: 'bad session' };
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: `directory gone: ${cwd}` };
  account = account === 'company' ? 'company' : 'personal';
  const ino = () => { try { return fs.statSync(sockPath(name)).ino; } catch { return 0; } };
  const old = ino();
  const r = await run('tmux', ['respawn-pane', '-k', '-t', '=' + name + ':', '-c', tdir(cwd), '-e', `BEAST_DASH_PORT=${port}`, runnerCmd(name, cwd, account, sessionId, forkFrom ? 'fork' : 'resume', forkFrom, extra)]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || 'tmux failed' };
  for (let i = 0; i < 50 && (!ino() || ino() === old); i++) await sleep(200);
  forget(name);
  return { ok: true, name, account, sessionId };
}

async function launch(name, cwd, account, opts = {}) {
  if (!NAME.test(name || '')) return { ok: false, error: 'bad session name' };
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: `directory gone: ${cwd}` };
  if ((await run('tmux', ['has-session', '-t', '=' + name])).ok) return { ok: true, name, existed: true, mode: 'chat' };
  account = account === 'company' ? 'company' : 'personal';
  const start = opts.start === 'resume' || opts.start === 'fork' ? opts.start : 'new';
  if (start === 'fork' && !UUID.test(opts.forkFrom || '')) return { ok: false, error: 'no conversation id to fork' };
  const sessionId = UUID.test(opts.sessionId || '') ? opts.sessionId : start !== 'resume' ? crypto.randomUUID() : null;
  if (!sessionId) return { ok: false, error: 'no conversation id to resume' };
  const r = await run('tmux', ['new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-c', tdir(cwd), '-e', `BEAST_DASH_PORT=${port}`, runnerCmd(name, cwd, account, sessionId, start, opts.forkFrom, opts.runner)]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || 'tmux failed', name };
  const transcriptPath = (start === 'resume' && findTranscript(cwd, account, sessionId, opts.transcriptPath)?.file) || transcriptOf(cwd, account, sessionId);
  claude.markChat(name, { cwd, account, sessionId, transcriptPath, firstPrompt: opts.firstPrompt, forkFrom: start === 'fork' ? opts.forkFrom : null, ...(opts.specialist ? { specialist: opts.specialist, runner: opts.runner || null } : {}) });
  return { ok: true, name, existed: false, account, mode: 'chat', sessionId, transcriptPath };
}

const chatBase = s => String(s).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^spec-/, 'spec_');
async function start(project, account, opts = {}) {
  const base = chatBase(opts.base || project.dirName);
  const suffix = account === 'company' ? '-company' : '';
  let name = `claude-${base}${suffix}`, n = 2;
  while ((await run('tmux', ['has-session', '-t', '=' + name])).ok || claude.get(name)) name = `claude-${base}-${n++}${suffix}`;
  return launch(name, opts.cwd || project.path, account, { start: 'new' });
}

const pad = n => String(n).padStart(2, '0');
async function chatName(d, account, taken) {
  const base = `claude-chat-${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const suffix = account === 'company' ? '-company' : '';
  for (let n = 1; n < 100; n++) { const name = base + (n > 1 ? '-' + n : '') + suffix; if (!(await taken(name))) return name; }
  return null;
}

let chatQueue = Promise.resolve();
function launchChat(cwd, account, text, opts = { start: 'new' }) {
  const job = chatQueue.then(async () => {
    for (let tries = 0; tries < 3; tries++) {
      const name = await chatName(new Date(), account, async n => !!claude.get(n) || (await run('tmux', ['has-session', '-t', '=' + n])).ok);
      if (!name) return { ok: false, error: 'no free chat name' };
      const r = await launch(name, cwd, account, { ...opts, firstPrompt: text });
      if (!r.ok || !r.existed) return r;
    }
    return { ok: false, error: 'no free chat name' };
  });
  chatQueue = job.catch(() => {});
  return job;
}

async function waitForRunner(name) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (fs.existsSync(sockPath(name))) return { up: true }; await sleep(200); }
  if ((await run('tmux', ['has-session', '-t', '=' + name])).ok) return { up: false, starting: true };
  claude.forget(name);
  return { up: false, starting: false };
}

async function startChat(cwd, account, text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty message' };
  if (text.length > 100000) return { ok: false, error: 'message too long (100 000 chars max)' };
  account = account === 'company' ? 'company' : 'personal';
  const r = await launchChat(cwd, account, text);
  if (!r.ok) return r;
  const name = r.name;
  for (let i = 0; i < 50 && !fs.existsSync(sockPath(name)); i++) await sleep(200);
  let s = await send(name, text);
  if (!s.ok && s.error === 'chat runner is not reachable') { await sleep(1000); s = await send(name, text); }
  return { ok: true, name, sessionId: r.sessionId, cwd, sent: s.ok, ...(s.ok ? {} : { error: s.error }) };
}

async function startEmptyChat(cwd, account) {
  account = account === 'company' ? 'company' : 'personal';
  const r = await launchChat(cwd, account, null);
  if (!r.ok) return r;
  const runner = await waitForRunner(r.name);
  if (!runner.up && !runner.starting) return { ok: false, error: 'the chat did not start' };
  return { ok: true, name: r.name, sessionId: r.sessionId, cwd, account, empty: true };
}

async function forkChat(src) {
  if (!src || !UUID.test(src.sessionId || '')) return { ok: false, error: 'this session has no conversation to fork yet' };
  if (!src.cwd || !fs.existsSync(src.cwd)) return { ok: false, error: `directory gone: ${src.cwd}` };
  const account = src.account === 'company' ? 'company' : 'personal';
  let cwd = path.resolve(src.cwd);
  const found = locateTranscript(cwd, account, src.sessionId);
  if (!found) return { ok: false, error: 'no conversation to fork was found for this session' };
  cwd = found.dir;
  const r = await launchChat(cwd, account, src.firstPrompt || null, { start: 'fork', forkFrom: src.sessionId });
  if (!r.ok) return r;
  const runner = await waitForRunner(r.name);
  if (!runner.up && !runner.starting) return { ok: false, error: 'the chat did not start' };
  return { ok: true, name: r.name, sessionId: r.sessionId, cwd, account };
}

function apply(snap, o) {
  switch (o.ev) {
    case 'state': snap.state = o.state; snap.since = o.since; break;
    case 'delta': if (!snap.turn) snap.turn = { startedAt: Date.now(), text: '', tools: [] }; if (snap.turn.text.length < 200 * 1024) snap.turn.text += o.text; break;
    case 'block': if (snap.turn && snap.turn.text) snap.turn.text += '\n\n'; break;
    case 'tool': if (snap.turn) snap.turn.tools.push({ id: o.id, name: o.name, what: o.what, done: false }); break;
    case 'tool-done': { const t = snap.turn && snap.turn.tools.find(x => x.id === o.id); if (t) t.done = true; break; }
    case 'pending': snap.pending = [...snap.pending.filter(p => p.rid !== o.req.rid), o.req]; break;
    case 'resolved': snap.pending = snap.pending.filter(p => p.rid !== o.rid); break;
    case 'result': snap.turn = null; break;
    case 'rate': snap.rate = o.rate; break;
    case 'ctx': snap.ctx = o.ctx; break;
    case 'inbox': snap.inbox = o.inbox; break;
    case 'shell': { const l = snap.shells || (snap.shells = []), i = l.findIndex(x => x.id === o.shell.id); if (i >= 0) l[i] = { ...o.shell }; else l.push({ ...o.shell }); break; }
    case 'shell-out': { const e = (snap.shells || []).find(x => x.id === o.id); if (e) { const v = e.out + o.chunk; if (v.length > SHELL_OUT) e.cut = true; e.out = v.slice(-SHELL_OUT); } break; }
    case 'shells': snap.shells = o.shells.map(x => ({ ...x })); break;
  }
}

class Conn {
  constructor(name) { this.name = name; this.sock = null; this.snap = null; this.subs = new Set(); this.waiting = new Map(); this.seq = 0; this.ready = null; this.retry = null; this.wanted = Date.now(); }
  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise(resolve => {
      const s = net.connect(sockPath(this.name));
      let buf = '', done = false;
      const finish = ok => { if (!done) { done = true; resolve(ok); } };
      const timer = setTimeout(() => { s.destroy(); finish(false); }, 2000);
      s.setEncoding('utf8');
      s.on('connect', () => { this.sock = s; s.write('{"op":"hello"}\n'); });
      s.on('data', d => {
        buf += d;
        if (buf.length > 8 * 1024 * 1024) { s.destroy(); return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          let o; try { o = JSON.parse(l); } catch { continue; }
          if (o.ev === 'ack' || o.ev === 'error') { const w = this.waiting.get(o.cid); if (w) { this.waiting.delete(o.cid); w(o); } if (o.cid) continue; }
          if (o.ev === 'snapshot') { this.snap = o; clearTimeout(timer); finish(true); }
          else if (this.snap) apply(this.snap, o);
          for (const fn of this.subs) { try { fn(o); } catch {} }
          if (['state', 'pending', 'resolved', 'result', 'snapshot', 'inbox'].includes(o.ev)) for (const fn of listeners) { try { fn(this.name, o); } catch {} }
        }
      });
      s.on('error', () => {});
      s.on('close', () => {
        clearTimeout(timer); finish(false);
        if (this.sock === s) this.sock = null;
        this.ready = null;
        for (const [cid, w] of this.waiting) { this.waiting.delete(cid); w({ ev: 'error', cid, error: 'runner went away' }); }
        if (this.snap) { this.snap = { ...this.snap, stale: true }; for (const fn of this.subs) { try { fn({ ev: 'gone' }); } catch {} } }
        this.scheduleRetry();
      });
    });
    return this.ready;
  }
  scheduleRetry() {
    if (this.retry || (!this.subs.size && Date.now() - this.wanted > 60000)) return;
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 1000);
    this.retry.unref();
  }
  async request(op) {
    this.wanted = Date.now();
    if (!(await this.connect()) || !this.sock) return { ok: false, error: 'chat runner is not reachable' };
    const cid = 'h' + ++this.seq;
    const reply = new Promise(resolve => { this.waiting.set(cid, resolve); setTimeout(() => { if (this.waiting.delete(cid)) resolve({ ev: 'error', error: 'runner did not answer' }); }, 5000); });
    this.sock.write(JSON.stringify({ ...op, cid }) + '\n');
    const r = await reply;
    return r.ev === 'ack' ? { ok: true, ...(r.when ? { when: r.when } : {}), ...(r.id ? { id: r.id } : {}) } : { ok: false, error: r.error || 'failed' };
  }
  close() { clearTimeout(this.retry); this.retry = null; this.subs.clear(); this.wanted = 0; if (this.sock) this.sock.destroy(); }
}

function conn(name) { let c = conns.get(name); if (!c) { c = new Conn(name); conns.set(name, c); } return c; }
function watch(names) {
  const live = new Set(names);
  for (const n of live) { const c = conn(n); c.wanted = Date.now(); if (!c.sock && !c.retry) c.connect(); }
  for (const [n, c] of conns) if (!live.has(n) && !c.subs.size) { c.close(); conns.delete(n); }
}
function live(name) { const c = conns.get(name); return c && c.snap ? c.snap : null; }
function subscribe(name, fn) { const c = conn(name); c.subs.add(fn); c.wanted = Date.now(); c.connect(); return () => c.subs.delete(fn); }
function onEvent(fn) { listeners.push(fn); }

async function send(name, text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty message' };
  if (text.length > 100000) return { ok: false, error: 'message too long (100 000 chars max)' };
  return conn(name).request({ op: 'send', text });
}
const interrupt = name => conn(name).request({ op: 'interrupt' });
async function answer(name, rid, decision, answers, message) {
  if (typeof rid !== 'string' || !rid || rid.length > 200) return { ok: false, error: 'bad request id' };
  if (decision !== 'allow' && decision !== 'deny') return { ok: false, error: 'bad decision' };
  const op = { op: 'answer', rid, decision };
  if (answers && typeof answers === 'object' && !Array.isArray(answers)) op.answers = Object.fromEntries(Object.entries(answers).slice(0, 20).map(([k, v]) => [String(k).slice(0, 2000), String(v).slice(0, 2000)]));
  if (typeof message === 'string') op.message = message.slice(0, 2000);
  return conn(name).request(op);
}
async function shell(name, cmd) {
  if (typeof cmd !== 'string' || !cmd.trim() || cmd.trim().length > 10000) return { ok: false, error: 'command must be 1..10000 chars' };
  const r = await conn(name).request({ op: 'shell', cmd: cmd.trim() });
  return r.error === 'unknown op' ? { ok: false, error: 'this chat started before ! commands existed: use New chat here, or run it in a terminal' } : r;
}
const badShellId = id => typeof id !== 'string' || !SHELL_ID.test(id);
const shellStop = async (name, id) => badShellId(id) ? { ok: false, error: 'bad command id' } : conn(name).request({ op: 'shell-stop', id });
const shellDrop = async (name, id) => badShellId(id) ? { ok: false, error: 'bad command id' } : conn(name).request({ op: 'shell-drop', id });
const restart = name => conn(name).request({ op: 'restart' });
const setModel = (name, model) => conn(name).request({ op: 'model', model });
const setEffort = (name, effort) => conn(name).request({ op: 'effort', effort });
const upgrade = (name, bin) => conn(name).request({ op: 'upgrade', claude: bin });
const VER = /^\d+\.\d+\.\d+$/;
function liveVersion(L, onPath) {
  if (!L || L.stale) return null;
  if (L.version) return L.version;
  const bin = typeof L.claude === 'string' ? L.claude : '';
  if (path.isAbsolute(bin)) return VER.test(path.basename(bin)) ? path.basename(bin) : null;
  return bin === 'claude' && VER.test(onPath || '') ? onPath : null;
}

async function restartChat(name, rec, bin, addDirs) {
  if (!NAME.test(name || '') || rec?.mode !== 'chat') return { ok: false, error: 'not a chat session' };
  const L = await status(name);
  const t0 = Date.now();
  let sessionId;
  if (L && L.v >= 2) {
    const r = await conn(name).request({ op: 'restart', ...(bin ? { claude: bin } : {}), ...(addDirs ? { addDirs } : {}) });
    if (!r.ok) return r;
    sessionId = UUID.test(L.sessionId || '') ? L.sessionId : rec.sessionId;
  } else {
    sessionId = claude.conversationOf(rec);
    if (!UUID.test(sessionId || '')) return { ok: false, error: 'no conversation id to resume' };
    const account = recordAccount(rec) || 'personal';
    const tr = locateTranscript(rec.cwd, account, sessionId);
    const forkFrom = !tr && sessionId === rec.sessionId && UUID.test(rec.forkFrom || '') ? rec.forkFrom : null;
    const cwd = tr ? tr.dir : rec.cwd, acc = tr ? tr.account : account;
    const r = await respawn(name, cwd, acc, sessionId, forkFrom, rec.runner ? { ...rec.runner, ...(addDirs ? { addDirs } : {}) } : null);
    if (!r.ok) return r;
    claude.markChat(name, { cwd, account: acc, sessionId, transcriptPath: tr ? tr.file : transcriptOf(cwd, acc, sessionId), forkFrom });
  }
  if (addDirs) claude.setRunner(name, { ...(rec.runner || {}), addDirs });
  for (let i = 0; i < 60; i++) {
    const snap = await status(name);
    if (snap && snap.childAt >= t0) return snap.state === 'exited' ? { ok: false, error: snap.error || 'claude exited right after the restart' } : { ok: true, name, resumed: sessionId, live: snap };
    await sleep(250);
  }
  return { ok: false, error: 'claude did not start again within 15 s' };
}

async function status(name) { const c = conn(name); c.wanted = Date.now(); await c.connect(); return c.snap && !c.snap.stale ? c.snap : null; }
function forget(name) {
  const c = conns.get(name); if (!c) return;
  for (const fn of c.subs) { try { fn({ ev: 'gone', forgotten: true }); } catch {} }
  c.close(); conns.delete(name);
}

module.exports = { init, apply, chatBase, launch, runnerArgs, waitForRunner, respawn, restartChat, liveVersion, findTranscript, locateTranscript, recordAccount, start, startChat, startEmptyChat, forkChat, chatName, live, status, forget, watch, subscribe, onEvent, send, interrupt, answer, shell, shellStop, shellDrop, restart, upgrade, setModel, setEffort, sockPath, transcriptOf };
