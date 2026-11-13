#!/usr/bin/env node
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { describeTool } = require('../lib/tooldesc');

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const SOCK = arg('sock'), CWD = arg('cwd') || process.cwd(), SID = arg('session-id'), ACCOUNT = arg('account') || 'personal';
let CLAUDE = arg('claude') || 'claude';
const NAME = arg('name') || '';
const FORK = arg('start') === 'fork' ? arg('fork-from') : null;
const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'auto', 'manual', 'dontAsk', 'plan'];
const PERMISSION = arg('permission-mode') || 'bypassPermissions';
const ADD_DIRS = process.argv.flatMap((a, i) => a === '--add-dir' && process.argv[i + 1] ? [process.argv[i + 1]] : []);
const EXIT_AFTER_RESULT = process.argv.includes('--exit-after-result');
const START_MODEL = arg('model') || null, START_EFFORT = arg('effort') || null;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\[1m\])?$/;
if (!PERMISSION_MODES.includes(PERMISSION) || ADD_DIRS.some(d => !path.isAbsolute(d)) || (START_MODEL && !MODEL_ID.test(START_MODEL)) || (START_EFFORT && !['low', 'medium', 'high', 'xhigh', 'max'].includes(START_EFFORT))) {
  process.stderr.write('headless-runner.js: bad --permission-mode, --add-dir, --model or --effort\n');
  process.exit(2);
}
if (!SOCK || !/^[0-9a-f-]{36}$/.test(SID || '') || !['new', 'resume', 'fork'].includes(arg('start')) || (arg('start') === 'fork' && !/^[0-9a-f-]{36}$/.test(FORK || ''))) {
  process.stderr.write('usage: headless-runner.js --sock <path> --cwd <dir> --session-id <uuid> --start new|resume|fork [--fork-from <uuid>] [--account personal|company] [--claude <bin>] [--name <tmux name>] [--permission-mode <mode>] [--add-dir <dir>]... [--model <model>] [--effort <level>] [--exit-after-result]\n');
  process.exit(2);
}

const MAX_LINE = 4 * 1024 * 1024, MAX_TEXT = 200 * 1024, MAX_SEND = 100000;
const INHERITED = ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PID'];
const KEEP = ['CLAUDE_CODE_AUTO_COMPACT_WINDOW'];

const S = { state: 'starting', since: Date.now(), turn: null, rate: null, ctx: null, model: null, effort: null, version: null, caps: [], error: null };
const pending = new Map();
const clients = new Set();
let child = null, hasConversation = arg('start') === 'resume', stopping = false, seq = 0, stderrTail = '';
let restarting = false, heard = false, unheard = [], upgradeAfterTurn = false, upgradeTimer = null, sentWhileWorking = false;
const queued = [], inbox = [], tookIn = new Set(), mine = new Set();
let msgSeq = 0, dying = null, lastOut = 0, endAt = 0, sweepTimer = null;
const SWEEP_MS = +process.env.BD_HL_SWEEP_MS || 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let current = SID, childAt = 0;
const MODELS = ['default', 'opus', 'sonnet', 'haiku', 'fable'], EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
let chosenModel = START_MODEL, chosenEffort = START_EFFORT;
const ctlWait = new Map();

const dim = s => `\x1b[2m${s}\x1b[0m`;
const out = s => { try { process.stdout.write(s); } catch {} };
let midLine = false;
const line = s => { out((midLine ? '\n' : '') + s + '\n'); midLine = false; };
const strip = s => String(s).replace(/\r\n/g, '\n').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)?|\x1b.?/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '');
const clean = s => strip(s).replace(/(^|\n)(\s*[>❯])/g, '$1 $2');
const clock = () => new Date().toTimeString().slice(0, 8);

function snapshot() {
  return { ev: 'snapshot', v: 2, sessionId: current, state: S.state, since: S.since, turn: S.turn, pending: [...pending.values()].map(p => p.req), inbox: inboxList(),
    rate: S.rate, ctx: S.ctx, model: S.model, effort: S.effort, version: S.version, claude: CLAUDE, childAt, caps: S.caps, error: S.error, shells: shellList(), addDirs: [...ADD_DIRS] };
}
function inboxList() { return inbox.map(m => ({ id: m.id, text: m.text, at: m.at })); }
function emitInbox() { emit({ ev: 'inbox', inbox: inboxList() }); }
function emit(o) { const l = JSON.stringify(o) + '\n'; for (const c of clients) c.write(l); }
function setState(state) { if (S.state === state) return; S.state = state; S.since = Date.now(); emit({ ev: 'state', state, since: S.since }); }

function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (INHERITED.includes(k) || (k.startsWith('CLAUDE_CODE_') && !KEEP.includes(k))) delete env[k];
  if (ACCOUNT === 'company') env.CLAUDE_CONFIG_DIR = configDir(); else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

const configDir = () => ACCOUNT === 'company' ? arg('config-dir') || require('../lib/accounts').companyDir() : path.join(process.env.HOME || '', '.claude');
const forked = () => fs.existsSync(path.join(configDir(), 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'), SID + '.jsonl'));

function binVersion(bin) {
  let p = path.isAbsolute(bin) ? bin : (process.env.PATH || '').split(':').filter(Boolean).map(d => path.join(d, bin)).find(executable);
  if (!p) return null;
  try { p = fs.realpathSync(p); } catch { return null; }
  const m = path.basename(p).match(/^(\d+\.\d+\.\d+)$/);
  return m ? m[1] : null;
}

function follow(id) {
  if (!UUID.test(id || '') || id === current || id === FORK) return;
  line(dim(`[${clock()}] conversation is now ${id} (was ${current})`));
  current = id; hasConversation = true;
  emit(snapshot());
}

function startChild() {
  const fork = FORK && current === SID && !forked();
  if (FORK && !fork) hasConversation = true;
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
    '--permission-prompt-tool', 'stdio', ...(PERMISSION === 'bypassPermissions' ? ['--dangerously-skip-permissions'] : ['--permission-mode', PERMISSION]), ...ADD_DIRS.flatMap(d => ['--add-dir', d]), ...(fork ? ['--resume', FORK, '--fork-session', '--session-id', SID] : [hasConversation ? '--resume' : '--session-id', current]),
    ...(chosenModel ? ['--model', chosenModel] : []), ...(chosenEffort ? ['--effort', chosenEffort] : [])];
  line(dim(`[${clock()}] claude ${fork ? 'fork of ' + FORK + ' as' : hasConversation ? 'resume' : 'new session'} ${fork ? SID : current}  (${ACCOUNT}, ${CWD})`));
  stderrTail = ''; heard = false; unheard = []; S.version = binVersion(CLAUDE); S.error = null; childAt = Date.now(); upgradeAfterTurn = false; sentWhileWorking = false; clearTimeout(upgradeTimer);
  const resumed = hasConversation;
  const p = spawn(CLAUDE, args, { cwd: CWD, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  child = p;
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => {
    const old = child !== p;
    if (old && dying !== p) return;
    if (!old) { heard = true; unheard = []; }
    lastOut = Date.now();
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onChildLine(l, old); }
    if (buf.length > MAX_LINE * 4) buf = '';
  });
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-2000); });
  p.stdin.on('error', () => {});
  p.on('error', e => {
    if (child !== p) return;
    if (e.code === 'ENOENT' && CLAUDE !== 'claude') {
      const lost = unheard;
      line(dim(`[${clock()}] ${CLAUDE} is gone, using claude from PATH`));
      CLAUDE = 'claude'; child = null;
      startChild();
      for (const m of lost) deliver(m, true);
      return;
    }
    S.error = `cannot start ${CLAUDE}: ${e.message}`; ended(p, 'error');
  });
  p.on('exit', (code, sig) => {
    if (child !== p) return;
    if (code && stderrTail.trim()) S.error = clean(stderrTail.trim().split('\n').slice(-3).join(' ')).slice(0, 500);
    if (code && fork && !heard && /no conversation found/i.test(stderrTail)) { S.error = `cannot fork: conversation ${FORK} not found`; ended(p, String(code)); return; }
    if (code && resumed && !heard && /no conversation found/i.test(stderrTail)) {
      const lost = unheard;
      child = null; hasConversation = false;
      line(dim(`[${clock()}] no saved conversation ${current}, starting it new`));
      startChild();
      for (const m of lost) deliver(m, true);
      return;
    }
    ended(p, sig || String(code));
  });
  setState(S.turn ? 'working' : 'idle');
  emit(snapshot());
}

function ended(p, reason) {
  child = null;
  for (const [id, w] of ctlWait) { ctlWait.delete(id); w({ subtype: 'error', error: 'claude exited' }); }
  line(dim(`[${clock()}] claude exited (${reason})`) + (S.error ? '  ' + S.error : ''));
  dropUntaken('claude exited');
  endTurn('exited', reason);
  setState('exited');
  if (stopping) finish();
  else if (EXIT_AFTER_RESULT) exitWhenQuiet();
}

function endTurn(subtype, reason) {
  if (S.turn) emit({ ev: 'result', subtype, reason, ms: Date.now() - S.turn.startedAt });
  S.turn = null;
  for (const rid of pending.keys()) emit({ ev: 'resolved', rid });
  pending.clear();
}

function setCtx(c) {
  const next = { used: null, window: null, ...S.ctx, ...c };
  if (S.ctx && S.ctx.used === next.used && S.ctx.window === next.window) return;
  S.ctx = next;
  emit({ ev: 'ctx', ctx: S.ctx });
}

function write(o) { if (child) child.stdin.write(JSON.stringify(o) + '\n'); }

function beginTurn() {
  if (S.turn) return;
  S.turn = { startedAt: Date.now(), text: '', tools: [] };
  setState('working');
}

function appendText(t) {
  if (!t) return;
  beginTurn();
  if (S.turn.text.length < MAX_TEXT) S.turn.text += t.slice(0, MAX_TEXT - S.turn.text.length);
  emit({ ev: 'delta', text: t });
  const c = clean(t);
  out(!midLine && /^\s*[>❯]/.test(c) ? ' ' + c : c); midLine = !t.endsWith('\n');
}

const isEcho = o => o.type === 'user' && o.isReplay === true && !o.parent_tool_use_id && !(Array.isArray(o.message && o.message.content) && o.message.content.some(b => b && b.type === 'tool_result'));
function onChildLine(l, old) {
  let o; try { o = JSON.parse(l); } catch { return; }
  if (isEcho(o)) return takeIn(o);
  if (old) return;
  if (o.type === 'stream_event') return onStream(o);
  if (o.type === 'assistant' && !o.parent_tool_use_id) {
    const u = o.message && o.message.usage;
    const used = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) : 0;
    if (used) setCtx({ used });
    for (const b of (o.message && o.message.content) || []) {
      if (b.type !== 'tool_use' || !S.turn || S.turn.tools.some(t => t.id === b.id)) continue;
      const t = { id: b.id, name: b.name, what: describeTool(b.name, b.input), done: false, at: Date.now() };
      S.turn.tools.push(t);
      emit({ ev: 'tool', id: t.id, name: t.name, what: t.what, at: t.at });
      line(dim(`  · ${clean(t.what)}`));
    }
    return;
  }
  if (o.type === 'user' && !o.parent_tool_use_id && Array.isArray(o.message && o.message.content)) {
    for (const b of o.message.content) {
      if (b.type !== 'tool_result') continue;
      const t = S.turn && S.turn.tools.find(x => x.id === b.tool_use_id);
      if (t) t.done = true;
      emit({ ev: 'tool-done', id: b.tool_use_id, error: !!b.is_error });
    }
    return;
  }
  if (o.type === 'control_request') return onControl(o);
  if (o.type === 'control_response' && o.response) {
    const w = ctlWait.get(o.response.request_id);
    if (w) { ctlWait.delete(o.response.request_id); w(o.response); }
    return;
  }
  if (o.type === 'control_cancel_request') {
    if (pending.delete(o.request_id)) emit({ ev: 'resolved', rid: o.request_id });
    return;
  }
  if (o.type === 'result') {
    follow(o.session_id);
    const mu = o.modelUsage || {}; const m = mu[S.model] || Object.values(mu).sort((a, b) => (b.contextWindow || 0) - (a.contextWindow || 0))[0];
    if (m && m.contextWindow) setCtx({ window: m.contextWindow });
    const ms = S.turn ? Date.now() - S.turn.startedAt : o.duration_ms || 0;
    S.turn = null;
    for (const rid of pending.keys()) emit({ ev: 'resolved', rid });
    pending.clear();
    line(dim(`[${clock()}] done (${o.subtype}${o.terminal_reason && o.terminal_reason !== 'completed' ? ', ' + o.terminal_reason : ''}, ${Math.round(ms / 100) / 10}s)`));
    const text = typeof o.result === 'string' ? o.result : null;
    emit({ ev: 'result', subtype: o.subtype, reason: o.terminal_reason || null, ms, text: text === null ? null : text.slice(0, MAX_TEXT), truncated: !!text && text.length > MAX_TEXT, isError: !!o.is_error });
    setState('idle');
    endAt = Date.now(); clearTimeout(sweepTimer); sweepTimer = setTimeout(sweep, SWEEP_MS);
    const late = sentWhileWorking; sentWhileWorking = false;
    if (upgradeAfterTurn && !late && !EXIT_AFTER_RESULT) { clearTimeout(upgradeTimer); upgradeTimer = setTimeout(upgradeIfIdle, 1500); }
    if (EXIT_AFTER_RESULT) exitWhenQuiet();
    return;
  }
  if (o.type === 'rate_limit_event' && o.rate_limit_info) {
    const r = o.rate_limit_info, w = r.unifiedWindows || {};
    S.rate = { status: r.status || null, fiveHour: w.five_hour ? w.five_hour.utilization : null, sevenDay: w.seven_day ? w.seven_day.utilization : null, resetsAt: r.resetsAt || null };
    emit({ ev: 'rate', rate: S.rate });
    return;
  }
  if (o.type === 'system' && o.subtype === 'compact_boundary') {
    const n = o.compact_metadata && o.compact_metadata.post_tokens;
    if (Number.isFinite(n)) setCtx({ used: n });
    return;
  }
  if (o.type === 'system' && o.subtype === 'init') {
    follow(o.session_id);
    S.model = o.model || null; S.version = o.claude_code_version || null; S.caps = Array.isArray(o.capabilities) ? o.capabilities : [];
    S.error = S.caps.includes('interrupt_receipt_v1') ? null : `claude ${S.version || '?'} may not support the headless control protocol (no interrupt_receipt_v1)`;
    emit(snapshot());
    readApplied();
  }
}

function onStream(o) {
  if (o.parent_tool_use_id) return;
  const e = o.event || {};
  if (e.type === 'message_start') return beginTurn();
  if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'text') {
    beginTurn();
    if (S.turn.text) { S.turn.text += '\n\n'; emit({ ev: 'block' }); line(''); }
    return;
  }
  if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') appendText(e.delta.text);
}

function onControl(o) {
  const r = o.request || {};
  if (r.subtype !== 'can_use_tool') {
    write({ type: 'control_response', response: { subtype: 'error', request_id: o.request_id, error: `beast-dash runner does not handle ${r.subtype}` } });
    return;
  }
  beginTurn();
  const input = r.input || {};
  const question = r.tool_name === 'AskUserQuestion' || r.requires_user_interaction === true;
  const req = { rid: o.request_id, kind: question ? 'question' : 'permission', tool: r.tool_name, what: describeTool(r.tool_name, input), input,
    questions: question && Array.isArray(input.questions) ? input.questions : undefined,
    suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : undefined, at: Date.now() };
  pending.set(o.request_id, { req, input });
  emit({ ev: 'pending', req });
  if (question) for (const q of req.questions || []) line(clean(`? ${q.question}  [${(q.options || []).map(x => x.label).join(' | ')}]`));
  else line(clean(`? allow ${req.what}`));
}

function respond(rid, response) {
  write({ type: 'control_response', response: { subtype: 'success', request_id: rid, response } });
  pending.delete(rid);
  emit({ ev: 'resolved', rid });
}

function ctl(request) {
  if (!child) return Promise.resolve({ subtype: 'error', error: 'claude is not running' });
  const id = `bd-${++seq}`;
  return new Promise(resolve => {
    ctlWait.set(id, resolve);
    setTimeout(() => { if (ctlWait.delete(id)) resolve({ subtype: 'error', error: `no answer to ${request.subtype}` }); }, 4000).unref();
    write({ type: 'control_request', request_id: id, request });
  });
}

async function readApplied() {
  const r = await ctl({ subtype: 'get_settings' });
  const a = r.subtype === 'success' && r.response && r.response.applied;
  if (!a) return;
  if (a.model) S.model = a.model;
  S.effort = a.effort || null;
  emit(snapshot());
}

async function setModel(model) {
  chosenModel = model === 'default' ? null : model;
  if (!child) return null;
  const r = await ctl({ subtype: 'set_model', model });
  if (r.subtype !== 'success') return r.error || 'set_model failed';
  line(dim(`[${clock()}] model ${model}`));
  await readApplied();
  return null;
}

async function setEffort(level) {
  chosenEffort = level;
  if (!child) return null;
  const r = await ctl({ subtype: 'apply_flag_settings', settings: { effortLevel: level } });
  if (r.subtype !== 'success') return r.error || 'effort change failed';
  line(dim(`[${clock()}] effort ${level}`));
  await readApplied();
  return null;
}

function interrupt() {
  if (!child || S.state !== 'working') return;
  for (const rid of [...pending.keys()]) respond(rid, { behavior: 'deny', message: 'Interrupted by user' });
  write({ type: 'control_request', request_id: `int-${++seq}`, request: { subtype: 'interrupt' } });
  line(dim(`[${clock()}] interrupt`));
}

const flat = s => String(s).replace(/\s+/g, ' ').trim();
const short = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;
const bashBlock = b => /^<bash-(input|stdout)>/.test(b.text);
function replayText(c) { return typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string' && !bashBlock(b)).map(b => b.text).join('\n') : ''; }
function endingIn(open, e, t) {
  const cut = (r, x) => r === x ? '' : x && r.endsWith(' ' + x) ? r.slice(0, -x.length - 1) : null;
  const run = [open[e]];
  let rest = cut(t, flat(open[e].text));
  for (let i = e - 1; rest && i >= 0; i--) { const n = cut(rest, flat(open[i].text)); if (n !== null) { run.unshift(open[i]); rest = n; } }
  return rest === '' ? run : null;
}
function takeIn(o) {
  const t = flat(replayText(o.message && o.message.content)), open = inbox.filter(m => !queued.includes(m));
  if (!open.length) return;
  const own = o.uuid ? open.find(m => m.uuid === o.uuid) : null;
  if (!own && o.uuid && mine.has(o.uuid)) return;
  let run = own ? endingIn(open, open.indexOf(own), t) || [own] : null;
  for (let e = 0; !run && t && e < open.length; e++) run = endingIn(open, e, t);
  if (!run) return;
  for (const m of run) { inbox.splice(inbox.indexOf(m), 1); if (tookIn.delete(m.id)) line(dim(`  ↳ claude took in: ${clean(short(flat(m.text), 120))}`)); }
  emitInbox();
}
function dropUntaken(why, which = () => true) {
  const lost = inbox.filter(m => !queued.includes(m) && which(m));
  if (!lost.length) return;
  for (const m of lost) { inbox.splice(inbox.indexOf(m), 1); tookIn.delete(m.id); line(dim(`  ✗ not taken in (${why}): ${clean(short(flat(m.text), 120))}`)); }
  unheard = unheard.filter(m => inbox.includes(m));
  emitInbox();
}
const stale = m => m.at < endAt;
function sweep() {
  sweepTimer = null;
  if (!child || restarting || S.turn || S.state !== 'idle') return;
  const wait = lastOut + SWEEP_MS - Date.now();
  if (wait > 0) { sweepTimer = setTimeout(sweep, wait); return; }
  dropUntaken('no echo from claude', stale);
}

function send(text) {
  const done = text.startsWith('/') ? [] : shells.filter(e => e.state !== 'running');
  const m = { id: `m-${++msgSeq}`, uuid: randomUUID(), text, at: Date.now(), ...(done.length ? { blocks: done.slice(-SHELL_KEEP).flatMap(shellBlocks) } : {}) };
  mine.add(m.uuid);
  if (done.length) { for (const e of done) shells.splice(shells.indexOf(e), 1); emit({ ev: 'shells', shells: shellList() }); }
  inbox.push(m); emitInbox();
  deliver(m, false);
  return m.id;
}
function deliver(m, again) {
  if (restarting) { if (!queued.includes(m)) queued.push(m); beginTurn(); return; }
  if (!child) startChild();
  const injected = S.state === 'working' && !again;
  if (injected) { sentWhileWorking = true; tookIn.add(m.id); }
  write({ type: 'user', uuid: m.uuid, message: { role: 'user', content: m.blocks ? [...m.blocks, { type: 'text', text: m.text }] : m.text } });
  if (!heard) unheard.push(m);
  hasConversation = true;
  if (!again) { line(clean(`${injected ? 'you (while working)' : 'you'}: ${short(m.text, 400)}`)); beginTurn(); }
}

function restart() {
  if (restarting) return;
  if (!child) { startChild(); return; }
  const old = child;
  dropUntaken('no echo from claude', stale);
  dying = old; child = null; restarting = true;
  endTurn('restarted', 'restart');
  let done = false;
  const respawn = () => {
    if (done) return;
    done = true; restarting = false; dying = null;
    if (stopping) return finish();
    startChild();
    const again = inbox.filter(m => !queued.includes(m));
    if (again.length) line(dim(`[${clock()}] sending again ${again.length} message${again.length > 1 ? 's' : ''} claude had not taken in yet`));
    for (const m of again) deliver(m, true);
    for (const m of queued.splice(0)) deliver(m, false);
  };
  old.on('close', respawn);
  old.on('exit', () => setTimeout(respawn, 1000));
  old.on('error', respawn);
  try { old.stdin.end(); } catch {}
  old.kill('SIGTERM');
  setTimeout(() => { try { old.kill('SIGKILL'); } catch {} }, 3000).unref();
}

const EXIT_MS = +process.env.BD_HL_EXIT_MS || 2000;
let exitTimer = null;
function exitWhenQuiet() {
  clearTimeout(exitTimer);
  exitTimer = setTimeout(() => {
    exitTimer = null;
    if (stopping) return;
    const busy = restarting || S.turn || pending.size || inbox.length || queued.length || sentWhileWorking || shells.some(e => e.state === 'running') || (child && S.state !== 'idle') || Date.now() - lastOut < EXIT_MS;
    if (busy) return exitWhenQuiet();
    line(dim(`[${clock()}] the run is done, ending this session`));
    shutdown();
  }, EXIT_MS);
}
function quiet() { return child && !restarting && S.state === 'idle' && !S.turn && !pending.size; }
function upgradeIfIdle() {
  upgradeTimer = null;
  if (!upgradeAfterTurn || !quiet()) return;
  upgradeAfterTurn = false;
  line(dim(`[${clock()}] restarting on ${CLAUDE}`));
  restart();
}
function upgrade(bin) {
  CLAUDE = bin;
  emit(snapshot());
  if (restarting) { upgradeAfterTurn = false; return 'now'; }
  if (!child || EXIT_AFTER_RESULT) { upgradeAfterTurn = false; return 'next-start'; }
  if (!quiet()) { upgradeAfterTurn = true; return 'after-turn'; }
  upgradeAfterTurn = true; upgradeIfIdle();
  return 'now';
}
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const executable = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

const SHELL_MS = +process.env.BD_HL_SHELL_MS || 600000, SHELL_OUT = 64 * 1024, SHELL_PRIV = 30000, SHELL_KEEP = 5, MAX_CMD = 10000;
const shells = [];
let shellSeq = 0;
const pubShell = e => ({ id: e.id, cmd: e.cmd, state: e.state, code: e.code, at: e.at, end: e.end, out: e.out, cut: e.cut, signal: e.signal });
function shellList() { return shells.map(pubShell); }
const shellBin = () => { const s = process.env.SHELL; return s && path.isAbsolute(s) && executable(s) ? s : '/bin/bash'; };
const signalGroup = (e, sig) => { try { process.kill(-e.proc.pid, sig); } catch {} };
function shellBlocks(e) {
  const priv = st => (st.cut ? `[… ${st.cut} chars cut]\n` : '') + st.text;
  const note = e.state === 'stopped' ? '\nStopped by the user' : e.state === 'timeout' ? `\nTimed out after ${Math.round(SHELL_MS / 1000)} s` : e.signal ? `\nKilled by ${e.signal}` : e.code ? `\nExit code ${e.code}` : '';
  return [{ type: 'text', text: `<bash-input>${e.cmd}</bash-input>` }, { type: 'text', text: `<bash-stdout>${priv(e.stdout)}</bash-stdout><bash-stderr>${priv(e.stderr)}${note}</bash-stderr>` }];
}
function shellText(e, st, s) {
  if (!s) return;
  const v = st.text + s, o = e.out + s;
  st.cut += Math.max(0, v.length - SHELL_PRIV); st.text = v.slice(-SHELL_PRIV);
  if (o.length > SHELL_OUT) e.cut = true;
  e.out = o.slice(-SHELL_OUT); e.chunk = (e.chunk + s).slice(-SHELL_OUT);
  if (!e.flush) e.flush = setTimeout(() => { e.flush = null; const chunk = e.chunk; e.chunk = ''; if (chunk) emit({ ev: 'shell-out', id: e.id, chunk }); }, 250);
}
function shellData(e, k, d) {
  if (e.state !== 'running') return;
  const st = e[k], raw = st.held + d, j = raw.lastIndexOf('\x1b');
  st.held = j >= 0 && raw.length - j < 64 && !/[\x07@-~]/.test(raw.slice(j + 2)) ? raw.slice(j) : '';
  shellText(e, st, strip(st.held ? raw.slice(0, j) : raw));
}
function endShell(e, why) {
  if (e.state !== 'running') return;
  for (const k of ['stdout', 'stderr']) { const h = e[k].held; e[k].held = ''; shellText(e, e[k], strip(h)); }
  clearTimeout(e.timer); clearTimeout(e.kill); clearTimeout(e.flush); e.flush = null; e.chunk = '';
  e.state = why || e.why || 'done'; e.code = Number.isInteger(e.exit) ? e.exit : null; e.end = Date.now();
  e.signal = e.state === 'done' ? e.sig || null : null;
  if (e.proc) { try { e.proc.stdout.destroy(); e.proc.stderr.destroy(); } catch {} }
  line(dim(e.state === 'stopped' ? '[stopped]' : e.state === 'timeout' ? '[timed out]' : e.state === 'error' ? '[failed]' : e.signal ? `[killed ${e.signal}]` : `[exit ${e.code === null ? '?' : e.code}]`));
  emit({ ev: 'shell', shell: pubShell(e) });
  const done = shells.filter(x => x.state !== 'running');
  if (done.length > SHELL_KEEP) { for (const x of done.slice(0, -SHELL_KEEP)) shells.splice(shells.indexOf(x), 1); emit({ ev: 'shells', shells: shellList() }); }
}
function failShell(e, err) { if (e.state !== 'running') return; shellText(e, e.stderr, strip(`cannot run ${shellBin()}: ${err.message}`)); endShell(e, 'error'); }
function killShell(e, why) {
  if (e.state !== 'running' || e.why) return;
  e.why = why;
  signalGroup(e, 'SIGTERM');
  e.kill = setTimeout(() => signalGroup(e, 'SIGKILL'), 3000);
}
function startShell(cmd) {
  const e = { id: `s-${++shellSeq}`, cmd, state: 'running', code: null, at: Date.now(), end: null, out: '', cut: false, chunk: '', flush: null, why: null, exit: null, sig: null, signal: null, kill: null, proc: null, timer: null,
    stdout: { held: '', text: '', cut: 0 }, stderr: { held: '', text: '', cut: 0 } };
  shells.push(e);
  line(clean(`$ ${short(cmd, 400)}`));
  emit({ ev: 'shell', shell: pubShell(e) });
  try { e.proc = spawn(shellBin(), ['-lc', cmd], { cwd: CWD, env: { ...childEnv(), TERM: 'dumb', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); } catch (err) { failShell(e, err); return e.id; }
  const p = e.proc;
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
  p.stdout.on('data', d => shellData(e, 'stdout', d));
  p.stderr.on('data', d => shellData(e, 'stderr', d));
  p.on('error', err => failShell(e, err));
  p.on('exit', (code, sig) => { e.exit = code; e.sig = sig; setTimeout(() => endShell(e), 200); });
  p.on('close', () => endShell(e));
  e.timer = setTimeout(() => killShell(e, 'timeout'), SHELL_MS);
  return e.id;
}
process.on('exit', () => { for (const e of shells) if (e.state === 'running') signalGroup(e, 'SIGKILL'); });

function onClientOp(c, m) {
  const ack = () => c.write(JSON.stringify({ ev: 'ack', cid: m.cid }) + '\n');
  const fail = error => c.write(JSON.stringify({ ev: 'error', cid: m.cid, error }) + '\n');
  switch (m.op) {
    case 'hello': c.write(JSON.stringify(snapshot()) + '\n'); return;
    case 'send': {
      if (stopping) return fail('runner is stopping');
      const text = typeof m.text === 'string' ? m.text : '';
      if (!text.trim() || text.length > MAX_SEND) return fail('text must be 1..100000 chars');
      return c.write(JSON.stringify({ ev: 'ack', cid: m.cid, id: send(text) }) + '\n');
    }
    case 'interrupt': interrupt(); return ack();
    case 'shell': {
      if (stopping) return fail('runner is stopping');
      const cmd = typeof m.cmd === 'string' ? m.cmd.trim() : '';
      if (!cmd || cmd.length > MAX_CMD) return fail('cmd must be 1..10000 chars');
      if (shells.some(e => e.state === 'running')) return fail('a command is still running');
      return c.write(JSON.stringify({ ev: 'ack', cid: m.cid, id: startShell(cmd) }) + '\n');
    }
    case 'shell-stop': {
      const e = shells.find(x => x.id === m.id && x.state === 'running');
      if (!e) return fail('no such running command');
      killShell(e, 'stopped'); return ack();
    }
    case 'shell-drop': {
      const e = shells.find(x => x.id === m.id);
      if (!e) return fail('no such command');
      if (e.state === 'running') return fail('the command is still running');
      shells.splice(shells.indexOf(e), 1); emit({ ev: 'shells', shells: shellList() }); return ack();
    }
    case 'answer': {
      const p = pending.get(m.rid);
      if (!p) return fail('no such request');
      if (m.decision === 'deny') respond(m.rid, { behavior: 'deny', message: typeof m.message === 'string' && m.message ? m.message.slice(0, 2000) : 'The user declined this.' });
      else if (m.decision !== 'allow') return fail('decision must be allow or deny');
      else if (p.req.kind === 'question') {
        const answers = {};
        for (const [k, v] of Object.entries(m.answers && typeof m.answers === 'object' ? m.answers : {})) answers[String(k)] = String(v).slice(0, 2000);
        respond(m.rid, { behavior: 'allow', updatedInput: { ...p.input, answers } });
        line(dim(`  → ${Object.values(answers).join(', ')}`));
      } else respond(m.rid, { behavior: 'allow', updatedInput: p.input });
      return ack();
    }
    case 'restart': {
      if (m.claude !== undefined) {
        if (typeof m.claude !== 'string' || !path.isAbsolute(m.claude) || !executable(m.claude)) return fail('claude must be an absolute path to an executable file');
        CLAUDE = m.claude; upgradeAfterTurn = false; clearTimeout(upgradeTimer);
      }
      if (m.addDirs !== undefined) {
        if (!Array.isArray(m.addDirs) || m.addDirs.length > 40 || m.addDirs.some(d => typeof d !== 'string' || !path.isAbsolute(d) || !isDir(d))) return fail('addDirs must be a list of at most 40 existing absolute folders');
        ADD_DIRS.splice(0, ADD_DIRS.length, ...new Set(m.addDirs));
      }
      restart(); if (EXIT_AFTER_RESULT) exitWhenQuiet(); return ack();
    }
    case 'model': {
      if (!MODELS.includes(m.model)) return fail('model must be one of ' + MODELS.join(', '));
      setModel(m.model).then(e => e ? fail(e) : ack());
      return;
    }
    case 'effort': {
      if (!EFFORTS.includes(m.effort)) return fail('effort must be one of ' + EFFORTS.join(', '));
      setEffort(m.effort).then(e => e ? fail(e) : ack());
      return;
    }
    case 'upgrade': {
      if (typeof m.claude !== 'string' || !path.isAbsolute(m.claude) || !executable(m.claude)) return fail('claude must be an absolute path to an executable file');
      return c.write(JSON.stringify({ ev: 'ack', cid: m.cid, when: upgrade(m.claude) }) + '\n');
    }
    default: return fail('unknown op');
  }
}

let sockIno = 0;
function serve() {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCK); } catch {}
  const server = net.createServer(c => {
    clients.add(c);
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', d => {
      buf += d;
      if (buf.length > MAX_LINE) { c.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!l.trim()) continue;
        let m; try { m = JSON.parse(l); } catch { c.write(JSON.stringify({ ev: 'error', error: 'bad json' }) + '\n'); continue; }
        if (m && typeof m === 'object') onClientOp(c, m);
      }
    });
    c.on('error', () => {});
    c.on('close', () => clients.delete(c));
  });
  const mask = process.umask(0o077);
  try { server.listen(SOCK, () => { try { fs.chmodSync(SOCK, 0o600); sockIno = fs.statSync(SOCK).ino; } catch {} }); } finally { process.umask(mask); }
  server.on('error', e => { line(`socket ${SOCK}: ${e.message}`); process.exit(1); });
}
function keepSocket() {
  if (stopping || !sockIno || fs.existsSync(SOCK)) return;
  line(dim(`[${clock()}] socket was removed — listening again`));
  sockIno = 0; try { serve(); } catch (e) { line(`socket ${SOCK}: ${e.message}`); }
}
setInterval(keepSocket, 1000);

function finish() { try { if (fs.statSync(SOCK).ino === sockIno) fs.unlinkSync(SOCK); } catch {} process.exit(0); }
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const e of shells) killShell(e, 'stopped');
  if (!child) return restarting ? undefined : finish();
  interrupt();
  try { child.stdin.end(); } catch {}
  const c = child;
  setTimeout(() => { try { c.kill('SIGTERM'); } catch {} }, 3000).unref();
  setTimeout(() => { try { c.kill('SIGKILL'); } catch {} finish(); }, 6000).unref();
}
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, shutdown);

function readOnlyPane() {
  if (!process.stdin.isTTY) return;
  let hinted = 0;
  try { process.stdin.setRawMode(true); } catch { return; }
  process.stdin.on('data', () => { const now = Date.now(); if (now - hinted > 10000) { hinted = now; line(dim('(this pane is only a log — type in the dashboard chat)')); } });
  process.stdin.on('error', () => {});
  process.stdin.resume();
}

line(dim(`beast-dash chat session ${NAME}  — type in the dashboard chat, this pane only shows a log`));
readOnlyPane();
serve();
startChild();
