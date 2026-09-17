'use strict';
// Queued prompts: "send this to that session at 23:30", optionally a chain (next one goes when the previous turn
// finishes). Stored in state/schedule.json; the server checks every tick. A push goes out when a chain ends.
const path = require('path');
const { readJson, writeJson, STATE } = require('./util');

const FILE = path.join(STATE, 'schedule.json');
let list = null;
function load() { if (!list) list = readJson(FILE, []); return list; }
function save() { writeJson(FILE, list); }
const id = () => Math.random().toString(36).slice(2, 10);

function all() { return load(); }
// { session, at (ms), prompts: [text, ...] }  -> one job; prompts after the first wait for the session to finish the previous one
function add(session, at, prompts) {
  if (!/^[A-Za-z0-9_.-]+$/.test(session || '')) return { ok: false, error: 'bad session' };
  const ps = (Array.isArray(prompts) ? prompts : [prompts]).map(p => String(p || '').trim()).filter(Boolean).slice(0, 20);
  if (!ps.length) return { ok: false, error: 'no prompt' };
  const when = +at || Date.now();
  const job = { id: id(), session, at: when, prompts: ps, idx: 0, createdAt: Date.now(), state: 'waiting', sentAt: null, lastSentAt: null };
  load().push(job); save(); return { ok: true, job };
}
function remove(jobId) { const l = load(); const i = l.findIndex(j => j.id === jobId); if (i >= 0) { l.splice(i, 1); save(); } return { ok: true }; }

// Called every tick with a function that says whether a session is busy (working) and a sender. Returns finished jobs.
let running = false;
async function run(isBusy, send, exists) {
  if (running) return [];   // ticks overlap (hooks trigger extra ones): never send the same prompt twice
  running = true;
  try { return await runOnce(isBusy, send, exists); } finally { running = false; }
}
async function runOnce(isBusy, send, exists) {
  const now = Date.now(); const done = []; let dirty = false;
  for (const j of load()) {
    if (j.state === 'done' || j.state === 'failed') continue;
    if (now < j.at) continue;
    if (!(await exists(j.session))) { j.state = 'failed'; j.error = 'session gone'; dirty = true; done.push(j); continue; }
    if (isBusy(j.session)) continue;                                   // wait for the previous prompt (or whatever it is doing) to finish
    if (j.lastSentAt && now - j.lastSentAt < 8000) continue;           // give the hooks a moment to flip the state to working
    if (j.idx >= j.prompts.length) continue;
    const text = j.prompts[j.idx];
    j.idx++; j.lastSentAt = now; j.sentAt = j.sentAt || now; j.state = j.idx >= j.prompts.length ? 'sent' : 'running'; dirty = true; save();
    const r = await send(j.session, text);
    if (!r.ok) { j.state = 'failed'; j.error = r.error; dirty = true; done.push(j); continue; }
  }
  // a job whose last prompt was sent is "done" once the session is idle again -> that is when we notify
  for (const j of load()) if (j.state === 'sent' && !isBusy(j.session) && now - j.lastSentAt > 8000) { j.state = 'done'; j.doneAt = now; dirty = true; done.push(j); }
  if (dirty) save();
  // keep the list short: drop finished jobs older than a day
  const keep = load().filter(j => !(j.state === 'done' || j.state === 'failed') || now - (j.doneAt || j.lastSentAt || j.createdAt) < 86400e3);
  if (keep.length !== load().length) { list = keep; save(); }
  return done;
}

module.exports = { all, add, remove, run };
