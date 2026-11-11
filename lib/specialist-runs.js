'use strict';
const fs = require('fs');
const path = require('path');
const { SpecialistError } = require('./specialists');

const MAX_ACTIVE = 4, MAX_FILES = 20, TIMEOUT_DEFAULT = 300, TIMEOUT_MAX = 1800;
const TAIL_BYTES = 16 * 1024 * 1024;
const ASK_KEYS = ['text', 'files', 'wait', 'timeoutSec'], SEND_KEYS = ['text', 'wait', 'timeoutSec'];
const STOPPED_REASONS = /abort|interrupt|cancel/i;
const fail = (status, msg) => { throw new SpecialistError(status, msg); };
const delay = ms => new Promise(r => setTimeout(r, ms));

function checkKeys(b, keys) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'body must be a JSON object');
  const bad = Object.keys(b).filter(k => !keys.includes(k));
  if (bad.length) fail(400, `unknown field ${bad.map(k => `"${k}"`).join(', ')}`);
}

function waitOpts(b) {
  if (b.wait !== undefined && typeof b.wait !== 'boolean') fail(400, 'wait must be true or false');
  const t = b.timeoutSec === undefined ? TIMEOUT_DEFAULT : b.timeoutSec;
  if (!Number.isInteger(t) || t < 1 || t > TIMEOUT_MAX) fail(400, `timeoutSec must be a whole number 1-${TIMEOUT_MAX}`);
  return { wait: b.wait === true, timeoutSec: t };
}

function taskText(b, max) {
  if (typeof b.text !== 'string' || !b.text.trim()) fail(400, 'text must be a non-empty string');
  const files = b.files === undefined ? [] : b.files;
  if (!Array.isArray(files) || files.length > MAX_FILES) fail(400, `files must be a list of at most ${MAX_FILES} paths`);
  for (const f of files) {
    if (typeof f !== 'string' || !path.isAbsolute(f) || f.length > 4096 || /[\r\n]/.test(f)) fail(400, 'files must be absolute paths');
    const st = (() => { try { return fs.statSync(f); } catch { return null; } })();
    if (!st || !st.isFile()) fail(400, `not a regular file: ${f}`);
  }
  const list = [...new Set(files.map(f => path.resolve(f)))];
  const text = list.length ? `${b.text}\n\nFiles for this task:\n${list.map(f => '- ' + f).join('\n')}` : b.text;
  if (text.length > max) fail(413, `the task is longer than ${max} characters`);
  return { text, addDirs: [...new Set(list.map(f => path.dirname(f)))] };
}

function blocksText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
}

function isPrompt(e) {
  if (!e || e.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary) return false;
  const c = e.message && e.message.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some(b => b && b.type === 'text') && !c.some(b => b && b.type === 'tool_result');
}

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}

function readEntries(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const raw = (() => { try { return readTail(file); } catch { return null; } })();
  return raw ? raw.split('\n').map(l => { try { return l.trim() ? JSON.parse(l) : null; } catch { return null; } }).filter(Boolean) : null;
}

function transcriptText(file) {
  return lastText(readEntries(file));
}

function lastText(entries) {
  if (!entries) return null;
  const main = e => e.type === 'assistant' && !e.isSidechain && e.message && blocksText(e.message.content).trim();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (isPrompt(e)) return null;
    if (!main(e)) continue;
    const id = e.message.id;
    const parts = [];
    for (let j = i; j >= 0; j--) {
      const x = entries[j];
      if (isPrompt(x)) break;
      if (x.type !== 'assistant' || x.isSidechain || !x.message) continue;
      if (id ? x.message.id !== id : j !== i) { if (parts.length) break; continue; }
      const t = blocksText(x.message.content);
      if (t.trim()) parts.unshift(t);
    }
    return parts.join('\n') || null;
  }
  return null;
}

function answeredText(file, run) {
  const entries = readEntries(file);
  if (!entries) return null;
  const prompts = entries.map((e, i) => isPrompt(e) ? i : -1).filter(i => i >= 0);
  if (!prompts.length) return null;
  const last = prompts[prompts.length - 1];
  const asked = run.mode === 'thread' ? blocksText(entries[last].message.content).includes(String(run.task || '').trim()) : prompts.length >= run.turns;
  if (!asked) return null;
  const after = entries.slice(last + 1).filter(e => !e.isSidechain && (e.type === 'assistant' || e.type === 'user'));
  const end = after[after.length - 1];
  if (!end || end.type !== 'assistant' || !end.message) return null;
  const msg = after.filter(e => e.type === 'assistant' && e.message && e.message.id === end.message.id);
  if (msg.some(e => Array.isArray(e.message.content) && e.message.content.some(b => b && b.type === 'tool_use'))) return null;
  return lastText(entries);
}

function filesDirs(task) {
  const i = typeof task === 'string' ? task.lastIndexOf('\n\nFiles for this task:\n') : -1;
  if (i < 0) return [];
  const files = task.slice(i).split('\n').filter(l => l.startsWith('- /')).map(l => l.slice(2));
  return [...new Set(files.map(f => path.dirname(f)))];
}

function finalOf(o) {
  const reason = o.reason || '';
  if (o.subtype === 'success' && !o.isError) return { state: 'done', error: null };
  if (o.subtype === 'exited') return { state: 'error', error: `claude exited (${reason || 'unknown'})` };
  if (STOPPED_REASONS.test(reason)) return { state: 'stopped', error: null };
  return { state: 'error', error: [o.subtype || 'error', reason].filter(Boolean).join(': ') };
}

const isDir = d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
const busyLive = (L, atResult) => !!(L && !L.stale && ((L.pending && L.pending.length) || (L.inbox && L.inbox.length) || (!atResult && (L.state === 'working' || L.turn))));

function createRuns({ store, headless, tmuxHas, claudeGet = () => null, liveSessions = null, now = Date.now, goneMs = 300, settleMs = 500, maxActive = MAX_ACTIVE }) {
  const watched = new Map();
  const waiters = new Map();
  const launching = new Set();
  let queue = Promise.resolve();
  const serial = fn => { const job = queue.then(fn); queue = job.catch(() => {}); return job; };

  function notify(run) {
    const set = waiters.get(run.runId);
    if (!set) return;
    waiters.delete(run.runId);
    for (const fn of set) fn(run);
  }

  function update(runId, patch) {
    const cur = store.getRun(runId);
    if (!cur || store.isFinal(cur.state)) return cur;
    const run = store.patchRun(runId, patch);
    if (store.isFinal(run.state)) notify(run);
    return run;
  }

  function unwatch(tmux) {
    const w = watched.get(tmux);
    if (!w) return;
    watched.delete(tmux);
    clearTimeout(w.timer);
    w.unsub();
  }

  function finalize(runId, state, { text, truncated, error } = {}) {
    const cur = store.getRun(runId);
    if (!cur || store.isFinal(cur.state)) return cur;
    const body = typeof text === 'string' && text.trim() ? text : transcriptText(cur.transcriptPath);
    const run = update(runId, { state, text: body || null, truncated: !!(body && body === text && truncated), error: error || null, endedAt: now() });
    const w = watched.get(cur.tmux);
    if (w && w.runId === runId) unwatch(cur.tmux);
    return run;
  }

  function followSession(run, sessionId) {
    if (!sessionId || sessionId === run.sessionId) return;
    const transcriptPath = run.transcriptPath ? path.join(path.dirname(run.transcriptPath), sessionId + '.jsonl') : null;
    update(run.runId, { sessionId, ...(transcriptPath ? { transcriptPath } : {}) });
    if (run.mode === 'thread') {
      const t = store.getThread(run.specialist);
      if (t && t.tmux === run.tmux) store.setThread(run.specialist, { ...t, sessionId, ...(transcriptPath ? { transcriptPath } : {}) });
    }
  }

  function recoverEnd(runId, error) {
    const run = store.getRun(runId);
    if (!run || store.isFinal(run.state)) return run;
    const text = answeredText(run.transcriptPath, run);
    return text ? finalize(runId, 'done', { text }) : finalize(runId, 'stopped', { error });
  }

  function settle(tmux, atResult) {
    const w = watched.get(tmux);
    if (!w || !w.held) return;
    clearTimeout(w.timer);
    if (!busyLive(headless.live(tmux), atResult)) { const h = w.held; finalize(w.runId, h.state, h); return; }
    w.timer = setTimeout(() => settle(tmux, false), settleMs);
    w.timer.unref();
  }

  async function onGone(tmux, runId) {
    for (let i = 0; i < 10; i++) {
      await delay(goneMs);
      const w = watched.get(tmux);
      if (!w || w.runId !== runId || launching.has(runId)) return;
      if (!(await tmuxHas(tmux))) {
        if (w.held) finalize(runId, w.held.state, w.held);
        else recoverEnd(runId, 'the session ended without a result');
        return;
      }
    }
  }

  function resubscribe(tmux, w) {
    if (watched.get(tmux) !== w) return;
    w.recover = true;
    w.unsub = headless.subscribe(tmux, o => onEvent(tmux, o));
  }

  function onEvent(tmux, o) {
    const w = watched.get(tmux);
    if (!w) return;
    const run = store.getRun(w.runId);
    if (!run || store.isFinal(run.state)) { unwatch(tmux); return; }
    const live = headless.live(tmux);
    switch (o.ev) {
      case 'snapshot': {
        followSession(run, o.sessionId);
        const recover = w.recover; w.recover = false;
        if (o.pending && o.pending.length) update(run.runId, { state: 'waiting' });
        else if (o.state === 'working' || o.turn) { if (run.state !== 'starting' || w.sent) update(run.runId, { state: 'working' }); }
        else if (recover && !w.held) recoverEnd(run.runId, 'the turn ended while the dashboard was not watching');
        return;
      }
      case 'state': if (o.state === 'working' && (run.state === 'waiting' || (run.state === 'starting' && w.sent)) && !(live && live.pending && live.pending.length)) update(run.runId, { state: 'working' }); return;
      case 'pending': update(run.runId, { state: 'waiting' }); return;
      case 'resolved': if (run.state === 'waiting' && !(live && live.pending && live.pending.length)) update(run.runId, { state: 'working' }); return;
      case 'result': {
        if (o.subtype === 'restarted') return;
        if (run.state === 'starting' && !w.sent) return;
        const f = finalOf(o);
        w.held = { state: f.state, text: o.text, truncated: o.truncated, error: f.error || (live && live.error) || null };
        settle(tmux, true);
        return;
      }
      case 'gone': if (o.forgotten) setTimeout(() => resubscribe(tmux, w), 0); else onGone(tmux, w.runId); return;
    }
  }

  function watch(run, { recover = false } = {}) {
    const old = watched.get(run.tmux);
    if (old && old.runId === run.runId) return old;
    if (old) unwatch(run.tmux);
    const w = { runId: run.runId, recover, sent: recover, held: null, timer: null, unsub: () => {} };
    watched.set(run.tmux, w);
    w.unsub = headless.subscribe(run.tmux, o => onEvent(run.tmux, o));
    const L = recover ? headless.live(run.tmux) : null;
    if (L && L.stale) onGone(run.tmux, run.runId);
    else if (L) onEvent(run.tmux, { ...L, ev: 'snapshot' });
    return w;
  }

  async function reconcile(run) {
    if (!run || store.isFinal(run.state) || launching.has(run.runId)) return run;
    const w = watched.get(run.tmux);
    if (w && w.runId === run.runId) return run;
    if (!(await tmuxHas(run.tmux))) return recoverEnd(run.runId, 'the session ended without a result');
    watch(run, { recover: true });
    return store.getRun(run.runId);
  }

  async function activeRuns(name) {
    const open = store.listRuns(name, { limit: 500 }).filter(r => !store.isFinal(r.state));
    const out = [];
    for (const r of open) { const run = await reconcile(store.getRun(r.runId)); if (run && !store.isFinal(run.state)) out.push(run); }
    return out;
  }

  function waitFor(runId, timeoutSec) {
    const run = store.getRun(runId);
    if (!run) return Promise.resolve(null);
    if (store.isFinal(run.state)) return Promise.resolve(run);
    return new Promise(resolve => {
      const set = waiters.get(runId) || new Set();
      waiters.set(runId, set);
      const done = r => { clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => { set.delete(done); if (!set.size && waiters.get(runId) === set) waiters.delete(runId); resolve({ ...store.getRun(runId), timedOut: true }); }, timeoutSec * 1000);
      set.add(done);
    });
  }

  async function answer(runId, { wait, timeoutSec }) {
    const run = wait ? await waitFor(runId, timeoutSec) : store.getRun(runId);
    if (!run) fail(404, `no run "${runId}"`);
    return run;
  }

  function runnerOpts(p, addDirs, exitAfterResult) {
    return { permissionMode: p.permissionMode, model: p.model, effort: p.effort, addDirs, exitAfterResult };
  }

  async function deliver(runId, tmux, text) {
    const w = watched.get(tmux);
    const up = await headless.waitForRunner(tmux);
    if (!up.up && !up.starting) return { ok: false, error: 'the runner did not start' };
    if (w) w.sent = true;
    let s = await headless.send(tmux, text);
    if (!s.ok && /not reachable/.test(s.error || '')) { await delay(1000); s = await headless.send(tmux, text); }
    if (!s.ok) { if (w) w.sent = false; return s; }
    const cur = store.getRun(runId);
    if (cur && cur.state === 'starting') update(runId, { state: 'working' });
    return s;
  }

  async function freeRunName(name, account) {
    const d = new Date(now());
    for (let n = 1; n < 100; n++) {
      const tmux = store.runName(name, account, d, n);
      if (!store.getRun(tmux) && !claudeGet(tmux) && !(await tmuxHas(tmux))) return tmux;
    }
    fail(409, 'no free run name this minute');
  }

  async function launchFailed(runId, error) {
    finalize(runId, 'error', { error });
    fail(500, error);
  }

  async function askRun(p, task, opts) {
    const run = await serial(async () => {
      const active = await activeRuns(p.name);
      if (active.length >= maxActive) fail(429, `${maxActive} runs of "${p.name}" are already active`);
      const tmux = await freeRunName(p.name, p.account);
      launching.add(tmux);
      try {
        store.saveRun({ runId: tmux, specialist: p.name, mode: 'run', tmux, account: p.account, sessionId: null, cwd: p.dir, transcriptPath: null, state: 'starting', task: task.text, text: null, startedAt: now(), endedAt: null, turns: 1 });
        const r = await headless.launch(tmux, p.dir, p.account, { start: 'new', firstPrompt: task.text, specialist: p.name, runner: runnerOpts(p, task.addDirs, true) });
        if (!r.ok || r.existed) return { runId: tmux, error: r.ok ? 'a session with this name already exists' : r.error || 'tmux failed' };
        const rec = update(tmux, { sessionId: r.sessionId, transcriptPath: r.transcriptPath || null });
        watch(rec);
        return { runId: tmux };
      } finally { launching.delete(tmux); }
    });
    if (run.error) await launchFailed(run.runId, run.error);
    const s = await deliver(run.runId, run.runId, task.text);
    if (!s.ok) await launchFailed(run.runId, s.error || 'the task could not be sent');
    return answer(run.runId, opts);
  }

  async function settled(tmux) {
    let snap = await headless.status(tmux);
    for (let i = 0; i < 10 && snap && snap.state === 'working' && !snap.turn; i++) { await delay(100); snap = headless.live(tmux); }
    return snap;
  }

  async function askThread(p, task, opts) {
    const job = await serial(async () => {
      const tmux = store.threadName(p.name, p.account);
      const thread = store.getThread(p.name);
      const same = !!thread && thread.account === p.account;
      if (same && thread.seq > 0) {
        const last = await reconcile(store.getRun(store.threadRunId(p.name, p.account, thread.seq)));
        if (last && !store.isFinal(last.state)) fail(409, 'thread is busy');
      }
      const isLive = await tmuxHas(tmux);
      const rec = claudeGet(tmux);
      if (isLive && (!rec || rec.specialist !== p.name || store.specialistOfTmux(tmux) !== p.name)) fail(409, `the session ${tmux} is not this specialist's thread`);
      const snap = isLive ? await settled(tmux) : null;
      if (snap && (snap.state === 'working' || snap.turn || (snap.pending && snap.pending.length))) fail(409, 'thread is busy');
      const had = (rec && rec.runner && Array.isArray(rec.runner.addDirs) ? rec.runner.addDirs : []).filter(isDir);
      const dirs = [...new Set([...had, ...task.addDirs])];
      const seq = (thread ? thread.seq : 0) + 1;
      const runId = store.threadRunId(p.name, p.account, seq);
      const sessionId = (snap && snap.sessionId) || (same ? thread.sessionId : null);
      const transcriptPath = sessionId ? (same && thread.sessionId === sessionId && thread.transcriptPath) || headless.transcriptOf(p.dir, p.account, sessionId) : null;
      const startedAt = isLive && same ? thread.startedAt : now();
      store.setThread(p.name, { account: p.account, sessionId, seq, cwd: p.dir, transcriptPath, startedAt });
      store.saveRun({ runId, specialist: p.name, mode: 'thread', tmux, account: p.account, sessionId, cwd: p.dir, transcriptPath, state: 'starting', task: task.text, text: null, startedAt: now(), endedAt: null, turns: 1 });
      launching.add(runId);
      try {
        if (isLive && dirs.length > had.length) {
          const r = await headless.restartChat(tmux, rec, null, dirs);
          if (!r.ok) return { runId, error: `the thread could not take the new folders: ${r.error || 'restart failed'}` };
        }
        if (!isLive) {
          const found = sessionId ? headless.locateTranscript(p.dir, p.account, sessionId) : null;
          const base = { firstPrompt: task.text, specialist: p.name, runner: runnerOpts(p, dirs, false) };
          const r = await headless.launch(tmux, p.dir, p.account, found ? { ...base, start: 'resume', sessionId, transcriptPath: found.file } : { ...base, start: 'new' });
          if (!r.ok) return { runId, error: r.error || 'tmux failed' };
          store.setThread(p.name, { account: p.account, sessionId: r.sessionId, seq, cwd: p.dir, transcriptPath: r.transcriptPath || null, startedAt });
          update(runId, { sessionId: r.sessionId, transcriptPath: r.transcriptPath || null });
        }
        watch(store.getRun(runId));
        return { runId, tmux };
      } finally { launching.delete(runId); }
    });
    if (job.error) await launchFailed(job.runId, job.error);
    const s = await deliver(job.runId, job.tmux, task.text);
    if (!s.ok) await launchFailed(job.runId, s.error || 'the task could not be sent');
    return answer(job.runId, opts);
  }

  async function ask(name, body) {
    const p = store.get(name);
    checkKeys(body, ASK_KEYS);
    const opts = waitOpts(body);
    const task = taskText(body, store.LIMITS.task);
    return p.mode === 'thread' ? askThread(p, task, opts) : askRun(p, task, opts);
  }

  async function get(runId, { wait = false, timeoutSec = TIMEOUT_DEFAULT } = {}) {
    if (!store.parseRunId(runId)) fail(400, 'bad runId');
    const run = await reconcile(store.getRun(runId));
    if (!run) fail(404, `no run "${runId}"`);
    return answer(runId, { wait, timeoutSec });
  }

  async function relaunch(run) {
    const p = store.get(run.specialist);
    const found = headless.locateTranscript(run.cwd || p.dir, run.account, run.sessionId);
    const r = await headless.launch(run.tmux, run.cwd || p.dir, run.account, { start: 'resume', sessionId: run.sessionId, transcriptPath: found ? found.file : run.transcriptPath, specialist: p.name, runner: runnerOpts(p, filesDirs(run.task), true) });
    if (!r.ok || r.existed) return { ok: false, error: r.ok ? 'the previous session of this run did not end' : r.error || 'tmux failed' };
    update(run.runId, { transcriptPath: r.transcriptPath || run.transcriptPath });
    return { ok: true };
  }

  async function send(runId, body) {
    const id = store.parseRunId(runId);
    if (!id) fail(400, 'bad runId');
    if (id.mode === 'thread') fail(400, 'this is a thread run: ask the specialist instead');
    checkKeys(body, SEND_KEYS);
    const opts = waitOpts(body);
    const task = taskText({ text: body.text }, store.LIMITS.task);
    const run = await serial(async () => {
      const cur = await reconcile(store.getRun(runId));
      if (!cur) fail(404, `no run "${runId}"`);
      if (!store.isFinal(cur.state)) fail(409, 'the run is still going; wait for its result');
      if (!cur.sessionId) fail(409, 'this run has no conversation to continue');
      store.get(cur.specialist);
      if ((await activeRuns(cur.specialist)).length >= maxActive) fail(429, `${maxActive} runs of "${cur.specialist}" are already active`);
      launching.add(runId);
      store.patchRun(runId, { state: 'starting', text: null, truncated: false, error: null, endedAt: null, turns: cur.turns + 1 });
      watch(store.getRun(runId));
      return cur;
    });
    try {
      let s = { ok: false, error: 'not reachable' };
      if (await tmuxHas(run.tmux)) s = await deliver(runId, run.tmux, task.text);
      if (!s.ok && /stopping|went away|not reachable|did not start/.test(s.error || '')) {
        for (let i = 0; i < 40 && (await tmuxHas(run.tmux)); i++) await delay(250);
        const r = await relaunch(run);
        s = r.ok ? await deliver(runId, run.tmux, task.text) : r;
      }
      if (!s.ok) await launchFailed(runId, s.error || 'the task could not be sent');
    } finally { launching.delete(runId); }
    return answer(runId, opts);
  }

  async function threadInfo(p) {
    const t = store.getThread(p.name);
    if (!t) return null;
    const live = await tmuxHas(t.tmux);
    const snap = live ? await headless.status(t.tmux) : null;
    return { tmux: t.tmux, live, state: snap ? snap.state : null };
  }

  async function summaryOf(p) {
    if (p.error) return p;
    const active = (await activeRuns(p.name)).length;
    const lastRun = store.listRuns(p.name, { limit: 1 })[0] || null;
    return { ...p, active, lastRun, thread: p.mode === 'thread' ? await threadInfo(p) : null };
  }

  async function list() {
    const out = [];
    for (const p of store.list()) out.push(await summaryOf(p));
    return out;
  }

  async function detail(name, limit) {
    const p = store.get(name);
    await activeRuns(name);
    return { specialist: { ...p, instructions: store.readInstructions(name) }, runs: store.listRuns(name, { limit }), thread: p.mode === 'thread' ? await threadInfo(p) : null };
  }

  async function archive(name) {
    return serial(async () => {
      const active = await activeRuns(name);
      if (active.length) fail(409, `"${name}" has ${active.length} active run${active.length > 1 ? 's' : ''}; wait for ${active.length > 1 ? 'them' : 'it'} to end`);
      for (const account of ['personal', 'company']) {
        const tmux = store.threadName(name, account);
        if (await tmuxHas(tmux)) fail(409, `"${name}" has a live thread session ${tmux}; end it first`);
      }
      const names = [...new Set(store.listRuns(name, { limit: 500 }).map(r => r.tmux))];
      const up = liveSessions ? new Set(await liveSessions()) : null;
      for (const tmux of names) if (up ? up.has(tmux) : await tmuxHas(tmux)) fail(409, `"${name}" still has a live run session ${tmux}; wait for it to end`);
      return store.archive(name);
    });
  }

  async function boot() {
    for (const p of store.list()) {
      if (p.error) continue;
      try { await activeRuns(p.name); } catch {}
    }
  }

  return { ask, get, send, list, detail, archive, boot, waitFor, watched };
}

module.exports = { createRuns, transcriptText, finalOf, taskText };
