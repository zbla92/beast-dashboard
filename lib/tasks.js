'use strict';
// Personal task backlog: prompt-style tasks (title + detailed body + attached files) linked to a project. Persisted in
// state/tasks.json until the user marks them done. "Run" hands a task to a Claude session on that project.
const path = require('path');
const { readJson, writeJson, STATE } = require('./util');

const FILE = path.join(STATE, 'tasks.json');
let list = null;
function load() { if (!list) list = readJson(FILE, []); return list; }
function save() { writeJson(FILE, list); }
const id = () => Math.random().toString(36).slice(2, 10);
const clean = s => String(s ?? '').trim();

function all() { return load(); }
function add(t) {
  const task = { id: id(), title: clean(t.title).slice(0, 200), body: clean(t.body).slice(0, 20000), project: clean(t.project) || null, files: Array.isArray(t.files) ? t.files.filter(f => typeof f === 'string').slice(0, 30) : [], status: 'todo', createdAt: Date.now(), updatedAt: Date.now(), doneAt: null, runs: [], order: load().length };
  if (!task.title) return { ok: false, error: 'title required' };
  load().unshift(task); save(); return { ok: true, task };
}
function update(tid, patch) {
  const t = load().find(x => x.id === tid); if (!t) return { ok: false, error: 'no such task' };
  if (patch.title != null) t.title = clean(patch.title).slice(0, 200) || t.title;
  if (patch.body != null) t.body = clean(patch.body).slice(0, 20000);
  if (patch.project !== undefined) t.project = clean(patch.project) || null;
  if (Array.isArray(patch.files)) t.files = patch.files.filter(f => typeof f === 'string').slice(0, 30);
  if (patch.status && ['todo', 'doing', 'done'].includes(patch.status)) { t.status = patch.status; t.doneAt = patch.status === 'done' ? Date.now() : null; }
  t.updatedAt = Date.now(); save(); return { ok: true, task: t };
}
function remove(tid) { const l = load(); const i = l.findIndex(x => x.id === tid); if (i >= 0) { l.splice(i, 1); save(); } return { ok: true }; }
function noteRun(tid, session, job) { const t = load().find(x => x.id === tid); if (!t) return; t.runs.push({ at: Date.now(), session, job: job || null }); if (t.status === 'todo') t.status = 'doing'; t.result = null; t.updatedAt = Date.now(); save(); }
// the scheduler finished the job that carried this task: keep Claude's closing summary on the task for review
function noteResult(job, res) { const t = load().find(x => x.runs.some(r => r.job === job)); if (!t) return null; t.result = { at: Date.now(), ok: !!res.ok, summary: String(res.summary || '').slice(0, 2000), session: res.session || null, error: res.error || null }; t.updatedAt = Date.now(); save(); return t; }
// what Claude receives
function prompt(t, projectName) {
  const parts = [`Task: ${t.title}`];
  if (projectName) parts.push(`Project: ${projectName}`);
  if (t.body) parts.push('', t.body);
  if (t.files.length) parts.push('', 'Attached files (read them first):', ...t.files.map(f => '  ' + f));
  parts.push('', 'When you are done, summarise what you changed in a few lines.');
  return parts.join('\n');
}

module.exports = { all, add, update, remove, noteRun, noteResult, prompt };
