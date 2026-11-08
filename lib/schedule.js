'use strict';
// Queued prompts: "send this to that session at 23:30", optionally a chain (next one goes when the previous turn
// finishes). Stored in state/schedule.json; the server checks every tick. A push goes out when a chain ends.
const path = require('path');
const { readJson, writeJson, STATE } = require('./util');

let FILE = path.join(STATE, 'schedule.json');
let list = null;
function useFile(file) { FILE = file; list = null; }
function load() { if (!list) list = readJson(FILE, []); return list; }
function save() { writeJson(FILE, list); }
const STARTUP_GRACE = 90000;
const id = () => Math.random().toString(36).slice(2, 10);

function all() { return load(); }
// { session, at (ms), prompts: [text, ...] }  -> one job; prompts after the first wait for the session to finish the previous one
// opts.whenFree: "send when Claude is free" from the chat — goes out as soon as the session isn't busy; no push of its own
// (the normal "done" push covers it)
function add(session, at, prompts, opts = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(session || '')) return { ok: false, error: 'bad session' };
  const ps = (Array.isArray(prompts) ? prompts : [prompts]).map(p => String(p || '').trim()).filter(Boolean).slice(0, 20);
  if (!ps.length) return { ok: false, error: 'no prompt' };
  const when = +at || Date.now();
  if (opts.key) { const had = load().find(j => j.key === opts.key); if (had) return { ok: true, job: had, existed: true }; }
  const job = { id: id(), session, at: when, prompts: ps, idx: 0, createdAt: Date.now(), state: 'waiting', sentAt: null, lastSentAt: null, whenFree: !!opts.whenFree };
  if (opts.key) Object.assign(job, { key: String(opts.key) }, opts.resume ? { resume: true, limitAt: +opts.resume.limitAt || null, resetsAt: +opts.resume.resetsAt || null } : {});
  load().push(job); save(); return { ok: true, job };
}
const cancel = j => Object.assign(j, { state: 'failed', error: 'cancelled', doneAt: Date.now() });
function remove(jobId) {
  const l = load(); const i = l.findIndex(j => j.id === jobId); if (i < 0) return { ok: true };
  const j = l[i];
  if (j.key && j.state !== 'waiting') return { ok: false, error: 'already sent' };
  if (j.key) cancel(j); else l.splice(i, 1);
  save(); return { ok: true };
}
function cancelResume(session) {
  const hit = load().filter(j => j.resume && j.state === 'waiting' && (!session || j.session === session));
  hit.forEach(cancel); if (hit.length) save();
  return hit.length;
}
function take(jobId) {
  const j = load().find(x => x.id === jobId);
  if (!j) return { ok: false, status: 404, error: 'gone' };
  if (j.resume) return { ok: false, status: 409, error: 'an auto-resume sends itself when the limit resets' };
  remove(j.id); return { ok: true, job: j };
}

// Called every tick with a function that says whether a session is busy (working) and a sender. Returns finished jobs.
let running = false;
async function run(isBusy, send, exists, allow) {
  if (running) return [];   // ticks overlap (hooks trigger extra ones): never send the same prompt twice
  running = true;
  try { return await runOnce(isBusy, send, exists, allow); } finally { running = false; }
}
async function runOnce(isBusy, send, exists, allow) {
  const now = Date.now(); const done = []; let dirty = false;
  for (const j of load()) {
    if (j.state === 'done' || j.state === 'failed') continue;
    if (now < j.at) continue;
    if (!(await exists(j.session))) { j.state = 'failed'; j.error = 'session gone'; dirty = true; done.push(j); continue; }
    if (isBusy(j.session)) continue;                                   // wait for the previous prompt (or whatever it is doing) to finish
    if (j.lastSentAt && now - j.lastSentAt < 8000) continue;           // give the hooks a moment to flip the state to working
    if (j.idx >= j.prompts.length) continue;
    if (allow && j.idx === 0 && !allow(j)) { Object.assign(j, { state: 'failed', error: 'not needed any more', doneAt: now }); dirty = true; continue; }
    const text = j.prompts[j.idx]; const before = { idx: j.idx, state: j.state, sentAt: j.sentAt, lastSentAt: j.lastSentAt };
    j.idx++; j.lastSentAt = now; j.sentAt = j.sentAt || now; j.state = j.idx >= j.prompts.length ? 'sent' : 'running'; dirty = true; save();
    const r = await send(j.session, text);
    if (!r.ok && r.notRunning && before.idx === 0 && now - j.at < STARTUP_GRACE) { Object.assign(j, before); dirty = true; continue; }
    if (!r.ok) { j.state = 'failed'; j.error = r.error; dirty = true; done.push(j); continue; }
  }
  // a job whose last prompt was sent is "done" once the session is idle again -> that is when we notify
  for (const j of load()) if (j.state === 'sent' && !isBusy(j.session) && now - j.lastSentAt > 8000) { j.state = 'done'; j.doneAt = now; dirty = true; done.push(j); }
  if (dirty) save();
  // keep the list short: drop finished jobs older than a day
  const keep = load().filter(j => !(j.state === 'done' || j.state === 'failed') || now - (j.doneAt || j.lastSentAt || j.createdAt) < 86400e3 || (j.key && now < j.at + 86400e3));
  if (keep.length !== load().length) { list = keep; save(); }
  return done;
}

module.exports = { all, add, remove, cancelResume, take, run, runOnce, useFile };
