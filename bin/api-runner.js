#!/usr/bin/env node
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const providers = require('../lib/providers');

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const SOCK = arg('sock'), CWD = path.resolve(arg('cwd') || process.cwd()), SID = arg('session-id'), START = arg('start');
const NAME = arg('name') || '', PROVIDER = arg('provider'), MODEL = arg('model'), KEYS = arg('keys');
const EXIT_AFTER_RESULT = process.argv.includes('--exit-after-result');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (!SOCK || !UUID.test(SID || '') || !['new', 'resume'].includes(START) || !providers.isApi(PROVIDER) || !/^[^\x00-\x1f\x7f]{1,128}$/.test(MODEL || '') || !path.isAbsolute(KEYS || '')) {
  process.stderr.write('usage: api-runner.js --sock <path> --cwd <dir> --session-id <uuid> --start new|resume --provider openai|xai --model <id> --keys <file> [--name <tmux name>] [--exit-after-result]\n');
  process.exit(2);
}

const MAX_LINE = 4 * 1024 * 1024, MAX_TEXT = 200 * 1024, MAX_SEND = 100000, TAIL_BYTES = 4 * 1024 * 1024;
const EXIT_MS = +process.env.BD_HL_EXIT_MS || 2000;
const TIMEOUT_MS = +process.env.BD_API_TIMEOUT_MS || undefined;
const TITLE = providers.titleOf(PROVIDER);
const FILE = providers.transcriptFile(CWD, SID);
const INTERRUPTED = '[Request interrupted by user]';

const S = { state: 'idle', since: Date.now(), turn: null, error: null };
const clients = new Set();
const run = { active: null, text: null, stopping: false, childAt: Date.now(), last: null, seq: 0, exitTimer: null, sockIno: 0 };

const dim = s => `\x1b[2m${s}\x1b[0m`;
const line = s => { try { process.stdout.write(s + '\n'); } catch {} };
const clock = () => new Date().toTimeString().slice(0, 8);
const brief = s => String(s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200);
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };

function snapshot() {
  return { ev: 'snapshot', v: 2, sessionId: SID, state: S.state, since: S.since, turn: S.turn, pending: [], inbox: [],
    rate: null, ctx: null, model: MODEL, effort: null, version: null, claude: null, provider: PROVIDER, childAt: run.childAt, caps: [], error: S.error, shells: [], addDirs: [] };
}
function emit(o) { const l = JSON.stringify(o) + '\n'; for (const c of clients) c.write(l); }
function setState(state) { if (S.state === state) return; S.state = state; S.since = Date.now(); emit({ ev: 'state', state, since: S.since }); }

function readTail() {
  const st = lstat(FILE);
  if (!st || !st.isFile()) return '';
  try {
    const fd = fs.openSync(FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const now = fs.fstatSync(fd);
      if (!now.isFile()) return '';
      const start = Math.max(0, now.size - TAIL_BYTES);
      const buf = Buffer.alloc(now.size - start);
      const got = fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.subarray(0, got).toString('utf8');
      return start ? text.slice(text.indexOf('\n') + 1) : text;
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function readEntries() {
  return readTail().split('\n').map(l => { try { return l.trim() ? JSON.parse(l) : null; } catch { return null; } }).filter(e => e && typeof e === 'object');
}

function history() {
  return readEntries().flatMap(e => {
    const m = e.message;
    if (!m) return [];
    if (e.type === 'user' && typeof m.content === 'string' && m.content.trim() && !m.content.startsWith(INTERRUPTED)) return [{ role: 'user', content: m.content }];
    if (e.type !== 'assistant' || !Array.isArray(m.content)) return [];
    const text = m.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
    return text.trim() ? [{ role: 'assistant', content: text }] : [];
  });
}

function conversationDir() {
  for (const d of [path.join(CWD, '.bd'), path.dirname(FILE)]) {
    const st = lstat(d);
    if (!st) fs.mkdirSync(d, { mode: 0o700 });
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new providers.ProviderError(`${path.relative(CWD, d)} in the profile folder is not a plain folder`);
  }
}

function append(entry) {
  conversationDir();
  const full = { ...entry, uuid: randomUUID(), parentUuid: run.last, sessionId: SID, cwd: CWD, timestamp: new Date().toISOString() };
  const fd = fs.openSync(FILE, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, JSON.stringify(full) + '\n'); } finally { fs.closeSync(fd); }
  run.last = full.uuid;
}

function endTurn(subtype, reason, text, isError) {
  const ms = S.turn ? Date.now() - S.turn.startedAt : 0;
  S.turn = null;
  line(dim(`[${clock()}] done (${isError ? brief(reason) : reason}, ${Math.round(ms / 100) / 10}s)`));
  emit({ ev: 'result', subtype, reason, ms, text: text === null ? null : text.slice(0, MAX_TEXT), truncated: !!text && text.length > MAX_TEXT, isError });
  setState('idle');
  if (EXIT_AFTER_RESULT) exitWhenQuiet();
}

function messagesFor(text) {
  const messages = history();
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || last.content !== text) throw new providers.ProviderError(`the conversation file ${path.relative(CWD, FILE)} could not be read back, so nothing was sent to ${TITLE}`);
  return messages;
}

async function turn(text, again = false) {
  const ctrl = new AbortController();
  run.active = ctrl;
  run.text = text;
  S.turn = { startedAt: Date.now(), text: '', tools: [] };
  S.error = null;
  setState('working');
  line(again ? dim(`[${clock()}] sending the task again`) : `> ${brief(text)}`);
  try {
    if (!again) append({ type: 'user', message: { role: 'user', content: text } });
    const r = await providers.chat({ provider: PROVIDER, model: MODEL, system: providers.systemPrompt(CWD), messages: messagesFor(text), signal: ctrl.signal, timeoutMs: TIMEOUT_MS, file: KEYS });
    if (ctrl.signal.aborted) throw new providers.ProviderError('interrupted', true);
    const ms = Date.now() - S.turn.startedAt;
    append({ type: 'assistant', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: r.model, content: [{ type: 'text', text: r.text }] } });
    append({ type: 'system', subtype: 'turn_duration', durationMs: ms });
    emit({ ev: 'delta', text: r.text.slice(0, MAX_TEXT) });
    endTurn('success', 'completed', r.text, false);
  } catch (e) {
    if (ctrl.restarted) return;
    if (ctrl.signal.aborted) {
      try { append({ type: 'user', message: { role: 'user', content: INTERRUPTED } }); } catch {}
      endTurn('error_during_execution', 'interrupted', null, true);
    } else {
      S.error = e instanceof providers.ProviderError ? e.message : `the ${TITLE} turn failed${e && e.code ? ` (${e.code})` : ''}`;
      endTurn('error_during_execution', S.error, null, true);
    }
  } finally { if (run.active === ctrl) run.active = null; }
}

function exitWhenQuiet() {
  clearTimeout(run.exitTimer);
  run.exitTimer = setTimeout(() => {
    run.exitTimer = null;
    if (run.stopping) return;
    if (S.turn) return exitWhenQuiet();
    line(dim(`[${clock()}] the run is done, ending this session`));
    shutdown();
  }, EXIT_MS);
}

function onClientOp(c, m) {
  const reply = o => c.write(JSON.stringify({ cid: m.cid, ...o }) + '\n');
  const ack = extra => reply({ ev: 'ack', ...extra });
  const fail = error => reply({ ev: 'error', error });
  switch (m.op) {
    case 'hello': c.write(JSON.stringify(snapshot()) + '\n'); return;
    case 'send': {
      if (run.stopping) return fail('runner is stopping');
      const text = typeof m.text === 'string' ? m.text : '';
      if (!text.trim() || text.length > MAX_SEND) return fail('text must be 1..100000 chars');
      if (S.turn) return fail(`${TITLE} is still answering; wait for the answer`);
      clearTimeout(run.exitTimer);
      ack({ id: `m-${++run.seq}` });
      turn(text);
      return;
    }
    case 'interrupt': if (run.active) { run.active.abort(); line(dim(`[${clock()}] interrupt`)); } return ack();
    case 'restart': {
      const cur = run.active;
      run.childAt = Date.now();
      if (cur) {
        cur.restarted = true; cur.abort(); run.active = null;
        emit({ ev: 'result', subtype: 'restarted', reason: 'restart', ms: Date.now() - S.turn.startedAt });
        S.turn = null;
        turn(run.text, true);
      }
      emit(snapshot());
      if (EXIT_AFTER_RESULT) exitWhenQuiet();
      return ack();
    }
    case 'upgrade': return ack({ when: 'next-start' });
    case 'model': return fail(`the model of ${TITLE} sessions is set in the specialist profile`);
    case 'effort': return fail(`effort does not apply to ${TITLE}`);
    case 'shell': case 'shell-stop': case 'shell-drop': return fail(`! commands are not available in ${TITLE} sessions`);
    case 'answer': return fail('no such request');
    default: return fail('unknown op');
  }
}

function serve() {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCK); } catch {}
  const server = net.createServer(c => {
    clients.add(c);
    c.setEncoding('utf8');
    const buf = { text: '' };
    c.on('data', d => {
      buf.text += d;
      if (buf.text.length > MAX_LINE) { c.destroy(); return; }
      for (;;) {
        const i = buf.text.indexOf('\n');
        if (i < 0) break;
        const l = buf.text.slice(0, i); buf.text = buf.text.slice(i + 1);
        if (!l.trim()) continue;
        const m = (() => { try { return JSON.parse(l); } catch { return undefined; } })();
        if (m === undefined) c.write(JSON.stringify({ ev: 'error', error: 'bad json' }) + '\n');
        else if (m && typeof m === 'object') onClientOp(c, m);
      }
    });
    c.on('error', () => {});
    c.on('close', () => clients.delete(c));
  });
  const mask = process.umask(0o077);
  try { server.listen(SOCK, () => { try { fs.chmodSync(SOCK, 0o600); run.sockIno = fs.statSync(SOCK).ino; } catch {} }); } finally { process.umask(mask); }
  server.on('error', e => { line(`socket ${SOCK}: ${e.message}`); process.exit(1); });
}
function keepSocket() {
  if (run.stopping || !run.sockIno || fs.existsSync(SOCK)) return;
  line(dim(`[${clock()}] socket was removed — listening again`));
  run.sockIno = 0; try { serve(); } catch (e) { line(`socket ${SOCK}: ${e.message}`); }
}

function finish() { try { if (fs.statSync(SOCK).ino === run.sockIno) fs.unlinkSync(SOCK); } catch {} process.exit(0); }
function shutdown() {
  if (run.stopping) return;
  run.stopping = true;
  if (!run.active) return finish();
  run.active.abort();
  setTimeout(finish, 200).unref();
}
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, shutdown);

function readOnlyPane() {
  if (!process.stdin.isTTY) return;
  const hinted = { at: 0 };
  try { process.stdin.setRawMode(true); } catch { return; }
  process.stdin.on('data', () => { const now = Date.now(); if (now - hinted.at > 10000) { hinted.at = now; line(dim('(this pane is only a log — type in the dashboard chat)')); } });
  process.stdin.on('error', () => {});
  process.stdin.resume();
}

if (START === 'resume') { const entries = readEntries(); const last = entries[entries.length - 1]; run.last = last && typeof last.uuid === 'string' ? last.uuid : null; }
line(dim(`beast-dash ${TITLE} session ${NAME} (${MODEL}) — type in the dashboard chat, this pane only shows a log`));
readOnlyPane();
serve();
setInterval(keepSocket, 1000);
