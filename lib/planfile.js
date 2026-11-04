'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const MARK = { ' ': 'todo', '~': 'doing', x: 'done', '?': 'blocked', '!': 'failed' };
const MARKER = { todo: ' ', doing: '~', done: 'x', blocked: '?', failed: '!' };
const MODELS = ['Opus', 'Sonnet', 'Haiku', 'Fable', 'main'];
const EVENT_TYPES = ['create', 'start', 'done', 'fail', 'ask', 'answer', 'note', 'phase', 'archive', 'finish', 'reopen', 'restore'];
const EVENT_KEYS = ['ts', 'type', 'task', 'q', 'phase', 'session', 'text', 'gate'];
const PLAN_STATUSES = ['active', 'finished', 'done'];
const REQUIRED_META = ['topic', 'title', 'repo', 'status', 'created'];
const SEP = ' · ';
const OK = '✓';
const BAD = '✗';
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_ID_RE = /^T\d+[a-z]?$/;
const QUESTION_ID_RE = /^q\d+$/;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/;
const FENCE_RE = /^(```|~~~)/;
const QUESTION_FIELD_RE = /^(blocks|asked) /;
const MAX_PLAN = 1024 * 1024;

class PlanError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

const isTopic = s => typeof s === 'string' && TOPIC_RE.test(s);
const isTaskId = s => typeof s === 'string' && TASK_ID_RE.test(s);
const isQuestionId = s => typeof s === 'string' && QUESTION_ID_RE.test(s);
const isIso = s => typeof s === 'string' && ISO_RE.test(s) && !Number.isNaN(Date.parse(s));
const iso = (d = new Date()) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const clip = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const modelName = s => MODELS.find(m => m.toLowerCase() === s.toLowerCase()) || null;
const isGateSeg = s => /^gate(?: |$)/.test(s);

function parse(input) {
  const errors = [];
  const warnings = [];
  const err = (line, msg) => errors.push({ line, msg });
  const warn = (line, msg) => warnings.push({ line, msg });
  const raw = String(input);
  const hasCr = raw.includes('\r');
  if (hasCr) warn(1, 'Windows line endings; written back with \\n');
  const text = hasCr ? raw.replace(/\r\n?/g, '\n') : raw;
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  else if (text) warn(lines.length, 'no newline at the end of the file');
  lines.forEach((l, n) => { if (/^\s+$/.test(l)) warn(n + 1, 'line has only spaces; it is written back empty'); });
  const blank = n => lines[n].trim() === '';
  const doc = { meta: {}, metaLine: {}, preamble: { gap: 0, text: '' }, sections: [], trail: 0, errors, warnings };

  const readFrontmatter = () => {
    if (lines[0] !== '---') { err(1, "plan.md must start with a '---' frontmatter block"); return 0; }
    const end = lines.indexOf('---', 1);
    if (end < 0) { err(1, "frontmatter is not closed with '---'"); return lines.length; }
    for (const [j, l] of lines.slice(1, end).entries()) {
      const k = j + 1;
      const m = /^([A-Za-z][\w-]*):( ?)(.*)$/.exec(l);
      if (!m) { err(k + 1, `frontmatter line must be 'key: value': "${clip(l)}"`); continue; }
      if (Object.hasOwn(doc.meta, m[1])) { err(k + 1, `duplicate frontmatter key '${m[1]}'`); continue; }
      if (!m[2] && m[3]) warn(k + 1, `write '${m[1]}: ${clip(m[3])}' with a space after the colon`);
      if (m[2] && !m[3]) warn(k + 1, `'${m[1]}:' has a trailing space`);
      doc.meta[m[1]] = m[3];
      doc.metaLine[m[1]] = k + 1;
    }
    return end + 1;
  };
  const bodyStart = readFrontmatter();

  const chunks = [{ head: -1, idx: [] }];
  const fence = { open: false };
  for (const i of lines.keys()) {
    if (i < bodyStart) continue;
    if (FENCE_RE.test(lines[i])) fence.open = !fence.open;
    else if (!fence.open && lines[i].startsWith('## ')) { chunks.push({ head: i, idx: [] }); continue; }
    chunks[chunks.length - 1].idx.push(i);
  }

  const leadingBlanks = idx => {
    const first = idx.findIndex(n => !blank(n));
    return first < 0 ? idx.length : first;
  };
  const trailingBlanks = idx => leadingBlanks([...idx].reverse());

  const textBlock = idx => {
    const gap = leadingBlanks(idx);
    return { gap, text: idx.slice(gap).map(n => (blank(n) ? '' : lines[n])).join('\n') };
  };

  const listSection = (idx, kind) => {
    const start = idx.findIndex(n => lines[n].startsWith('- '));
    const head = idx.slice(0, start < 0 ? idx.length : start);
    const headGap = trailingBlanks(head);
    const intro = textBlock(head.slice(0, head.length - headGap));
    const items = [];
    const cur = { k: start < 0 ? idx.length : start, gap: headGap };
    while (cur.k < idx.length) {
      const n = idx[cur.k];
      const t = lines[n];
      if (blank(n)) { cur.gap++; cur.k++; continue; }
      if (!t.startsWith('- ')) {
        err(n + 1, /^\t/.test(t) ? 'indent task-card lines with two spaces, not tabs' : `unexpected text; indent task-card lines by two spaces: "${clip(t)}"`);
        cur.k++; cur.gap = 0; continue;
      }
      const rawBody = [];
      cur.k++;
      while (cur.k < idx.length && (blank(idx[cur.k]) || lines[idx[cur.k]].startsWith('  '))) rawBody.push(idx[cur.k++]);
      const after = trailingBlanks(rawBody);
      const body = rawBody.slice(0, rawBody.length - after);
      const item = kind === 'task' ? taskLine(t, n + 1) : questionLine(t, n + 1);
      if (item) {
        item.gap = cur.gap;
        item.body = body.map(b => (blank(b) ? '' : lines[b].slice(2))).join('\n');
        items.push(item);
      }
      cur.gap = after;
    }
    return { intro, items, gap: cur.gap };
  };

  const taskLine = (t, line) => {
    const m = /^- \[(.)\] (.*)$/.exec(t);
    if (!m) { err(line, `task line must look like '- [ ] T3 Title': "${clip(t)}"`); return null; }
    const status = m[1] === 'X' ? 'done' : MARK[m[1]];
    if (m[1] === 'X') warn(line, "write the done marker as '[x]'");
    if (!status) { err(line, `unknown status marker '[${m[1]}]'; use [ ] todo, [~] doing, [x] done, [?] blocked, [!] failed`); return null; }
    const im = /^(\S+)(?: (.*))?$/.exec(m[2]);
    if (!im || !isTaskId(im[1])) { err(line, `task needs an id like T3 right after the checkbox: "${clip(t)}"`); return null; }
    const segs = (im[2] || '').split(SEP);
    const firstField = segs.findIndex((x, j) => j > 0 && (modelName(x) || isGateSeg(x)));
    const fieldStart = firstField < 0 ? segs.length : firstField;
    const tt = segs.slice(0, fieldStart).join(SEP);
    const fields = { model: null, gate: null };
    const fieldSegs = segs.slice(fieldStart);
    for (const [j, seg] of fieldSegs.entries()) {
      if (isGateSeg(seg)) { fields.gate = gateField(fieldSegs.slice(j).join(SEP), line); break; }
      const mm = modelName(seg);
      if (mm && !fields.model) { fields.model = mm; if (mm !== seg) warn(line, `write the model as '${mm}'`); continue; }
      err(line, `unknown task field "${clip(seg)}"; after the title come an optional model (${MODELS.join(', ')}) and then 'gate ${OK}|${BAD} <text>'`);
    }
    if (!tt.trim()) err(line, `task ${im[1]} needs a title`);
    return { line, id: im[1], status, title: tt, model: fields.model, gate: fields.gate };
  };

  const gateField = (s, line) => {
    const m = new RegExp(`^gate ([${OK}${BAD}])(?: (.*))?$`).exec(s);
    if (!m) { err(line, `gate must be 'gate ${OK} <text>' or 'gate ${BAD} <text>': "${clip(s)}"`); return null; }
    return { ok: m[1] === OK, text: m[2] || '' };
  };

  const questionLine = (t, line) => {
    const m = /^- (\S+)(?: (.*))?$/.exec(t);
    if (!m || !isQuestionId(m[1])) { err(line, `question line must look like '- q1 Question? · blocks T5 · asked <time>': "${clip(t)}"`); return null; }
    const segs = (m[2] || '').split(SEP);
    const firstField = segs.findIndex((x, j) => j > 0 && QUESTION_FIELD_RE.test(x));
    const fieldStart = firstField < 0 ? segs.length : firstField;
    const q = segs.slice(0, fieldStart).join(SEP);
    const fields = { blocks: null, asked: null };
    for (const s of segs.slice(fieldStart)) {
      if (s.startsWith('blocks ') && !fields.blocks && !fields.asked) {
        fields.blocks = s.slice(7).split(',').map(x => x.trim());
        if (fields.blocks.join(', ') !== s.slice(7)) warn(line, `write the list as 'blocks ${fields.blocks.join(', ')}'`);
        const bad = fields.blocks.filter(x => !isTaskId(x));
        if (bad.length) err(line, `'blocks' takes task ids like T5, T6: "${clip(s)}"`);
      } else if (s.startsWith('asked ') && !fields.asked) {
        fields.asked = s.slice(6);
        if (!isIso(fields.asked)) err(line, `'asked' needs an ISO time like 2026-11-03T10:41:00Z: "${clip(s)}"`);
      } else err(line, `unexpected question field "${clip(s)}"; fields are 'blocks T5, T6' then 'asked <time>'`);
    }
    if (!q.trim()) err(line, `question ${m[1]} needs the question text`);
    if (!fields.asked) err(line, `question ${m[1]} needs '${SEP.trim()} asked <time>' at the end`);
    return { line, id: m[1], q, blocks: fields.blocks || [], asked: fields.asked };
  };

  const buildSection = (h, line, idx, carry) => {
    const pm = /^Phase (\d+)(\s*)(—|–|-|:)(\s*)(.*)$/.exec(h);
    if (pm) {
      const name = pm[5].trim();
      if (!name) err(line, "phase needs a name: '## Phase N — Name'");
      else if (pm[2] !== ' ' || pm[3] !== '—' || pm[4] !== ' ' || pm[5] !== name) warn(line, `write the heading as '## Phase ${+pm[1]} — ${name}'`);
      const l = listSection(idx, 'task');
      return { s: { kind: 'phase', gap: carry, line, n: +pm[1], name, intro: l.intro, tasks: l.items }, extra: l.gap };
    }
    if (h.trim().toLowerCase() === 'next') {
      if (h !== 'Next') warn(line, "write the heading as '## Next'");
      return { s: { kind: 'next', gap: carry, line, body: textBlock(idx) }, extra: 0 };
    }
    if (h.trim().toLowerCase() === 'waiting on you') {
      if (h !== 'Waiting on you') warn(line, "write the heading as '## Waiting on you'");
      const l = listSection(idx, 'question');
      return { s: { kind: 'waiting', gap: carry, line, intro: l.intro, items: l.items }, extra: l.gap };
    }
    if (/^phase\b/i.test(h)) err(line, `phase heading must be '## Phase N — Name': "${clip(h)}"`);
    return { s: { kind: 'raw', gap: carry, line, heading: h, body: textBlock(idx) }, extra: 0 };
  };

  const state = { carry: 0 };
  for (const c of chunks) {
    const tail = trailingBlanks(c.idx);
    const idx = c.idx.slice(0, c.idx.length - tail);
    if (c.head < 0) { doc.preamble = textBlock(idx); state.carry = tail; continue; }
    const built = buildSection(lines[c.head].slice(3), c.head + 1, idx, state.carry);
    doc.sections.push(built.s);
    state.carry = tail + built.extra;
  }
  doc.trail = state.carry;
  errors.push(...validate(doc));
  errors.sort((a, b) => a.line - b.line);
  return doc;
}

function validate(doc) {
  const out = [];
  const e = (line, msg) => out.push({ line: line || 0, msg });
  const m = doc.meta;
  const ml = doc.metaLine || {};
  for (const k of REQUIRED_META) if (!Object.hasOwn(m, k)) e(1, `frontmatter needs '${k}:'`);
  if (Object.hasOwn(m, 'topic') && !isTopic(m.topic)) e(ml.topic, `topic must be 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit: "${clip(m.topic)}"`);
  if (Object.hasOwn(m, 'title') && !m.title.trim()) e(ml.title, 'title is empty');
  if (Object.hasOwn(m, 'repo') && !path.isAbsolute(m.repo)) e(ml.repo, `repo must be the absolute path of the main worktree: "${clip(m.repo)}"`);
  if (Object.hasOwn(m, 'status') && !PLAN_STATUSES.includes(m.status)) e(ml.status, `status must be active, finished or done: "${clip(m.status)}"`);
  for (const k of ['created', 'archived']) if (Object.hasOwn(m, k) && !isIso(m[k])) e(ml[k], `${k} needs an ISO time like 2026-11-03T07:58:00Z: "${clip(m[k])}"`);
  const ph = phases(doc);
  ph.forEach((p, i) => { if (p.n !== i + 1) e(p.line, `phases must be numbered 1, 2, 3… in order; expected Phase ${i + 1}, found Phase ${p.n}`); });
  for (const kind of ['next', 'waiting']) {
    const list = doc.sections.filter(s => s.kind === kind);
    const name = kind === 'next' ? '## Next' : '## Waiting on you';
    if (!list.length) e(1, `missing the '${name}' section (it may be empty)`);
    list.slice(1).forEach(s => e(s.line, `'${name}' appears more than once`));
  }
  const ids = new Map();
  for (const p of ph) for (const t of p.tasks) {
    if (ids.has(t.id)) e(t.line, `duplicate task id ${t.id} (first used on line ${ids.get(t.id)})`);
    else ids.set(t.id, t.line || 0);
  }
  const qids = new Set();
  for (const q of questions(doc)) {
    if (qids.has(q.id)) e(q.line, `duplicate question id ${q.id}`);
    qids.add(q.id);
    for (const b of q.blocks) if (isTaskId(b) && !ids.has(b)) e(q.line, `${q.id} blocks ${b}, but there is no task ${b}`);
  }
  return out;
}

function pushGap(out, n) { out.push(...Array.from({ length: n }, () => '')); }
function pushText(out, block) { pushGap(out, block.gap); if (block.text) out.push(...block.text.split('\n')); }
function pushBody(out, body) { if (body) for (const l of body.split('\n')) out.push(l ? '  ' + l : ''); }

function taskText(t) {
  const model = t.model ? SEP + t.model : '';
  const gate = t.gate ? `${SEP}gate ${t.gate.ok ? OK : BAD}${t.gate.text ? ' ' + t.gate.text : ''}` : '';
  return `- [${MARKER[t.status]}] ${t.id} ${t.title}${model}${gate}`;
}

function questionText(q) {
  const blocks = q.blocks && q.blocks.length ? `${SEP}blocks ${q.blocks.join(', ')}` : '';
  const asked = q.asked ? `${SEP}asked ${q.asked}` : '';
  return `- ${q.id} ${q.q}${blocks}${asked}`;
}

function serialize(doc) {
  const out = ['---'];
  for (const [k, v] of Object.entries(doc.meta)) out.push(v === '' ? `${k}:` : `${k}: ${v}`);
  out.push('---');
  pushText(out, doc.preamble);
  for (const s of doc.sections) {
    pushGap(out, s.gap);
    if (s.kind === 'phase') out.push(`## Phase ${s.n} — ${s.name}`);
    else if (s.kind === 'next') out.push('## Next');
    else if (s.kind === 'waiting') out.push('## Waiting on you');
    else out.push('## ' + s.heading);
    if (s.kind === 'phase' || s.kind === 'waiting') {
      pushText(out, s.intro);
      for (const it of s.kind === 'phase' ? s.tasks : s.items) {
        pushGap(out, it.gap);
        out.push(s.kind === 'phase' ? taskText(it) : questionText(it));
        pushBody(out, it.body);
      }
    } else pushText(out, s.body);
  }
  pushGap(out, doc.trail);
  return out.join('\n') + '\n';
}

function formatErrors(list, file = 'plan.md') { return list.map(x => `${file}:${x.line}: ${x.msg}`).join('\n'); }

const phases = doc => doc.sections.filter(s => s.kind === 'phase');
const tasks = doc => phases(doc).flatMap(p => p.tasks);
const questions = doc => doc.sections.filter(s => s.kind === 'waiting').flatMap(s => s.items);
const findTask = (doc, id) => tasks(doc).find(t => t.id === id) || null;
const blockersOf = (doc, id) => questions(doc).filter(q => q.blocks.includes(id)).map(q => q.id);

function needTask(doc, id) {
  if (!isTaskId(id)) throw new PlanError(`"${id}" is not a task id (like T3)`, 2);
  const t = findTask(doc, id);
  if (!t) throw new PlanError(`no task ${id} in this plan`);
  return t;
}

function oneLine(s, what) {
  if (typeof s !== 'string' || !s.trim()) throw new PlanError(`${what} is empty`, 2);
  if (/[\r\n]/.test(s)) throw new PlanError(`${what} must be one line`, 2);
  return s.trim();
}

function freeText(s, what) {
  const fence = { open: false };
  for (const l of s.split('\n')) {
    if (FENCE_RE.test(l)) fence.open = !fence.open;
    else if (!fence.open && l.startsWith('## ')) throw new PlanError(`${what} can't have a line starting with '## ': it would start a new section`, 2);
  }
  if (fence.open) throw new PlanError(`${what} opens a code fence (\`\`\` or ~~~) and does not close it`, 2);
  return s;
}

function questionArg(s) {
  const text = oneLine(s, 'question');
  if (text.split(SEP).slice(1).some(x => QUESTION_FIELD_RE.test(x))) throw new PlanError(`question can't contain '${SEP}blocks ' or '${SEP}asked ': they start the question's fields`, 2);
  return text;
}

function cardText(s) {
  return String(s).replace(/\r\n?/g, '\n').split('\n').map(l => (l.trim() ? l : '')).join('\n').replace(/\s+$/, '');
}

function phaseEvent(doc, id) {
  const p = phases(doc).find(x => x.tasks.some(t => t.id === id));
  return p && p.tasks.every(t => t.status === 'done') ? [{ type: 'phase', phase: p.n, text: p.name }] : [];
}

function start(doc, id) {
  const t = needTask(doc, id);
  if (t.status === 'done') throw new PlanError(`${id} is already done`);
  const by = blockersOf(doc, id);
  if (by.length) throw new PlanError(`${id} is blocked by ${by.join(', ')}; the user has to answer first`);
  t.status = 'doing';
  return [{ type: 'start', task: id }];
}

function finish(doc, id, gate) {
  const t = needTask(doc, id);
  const by = blockersOf(doc, id);
  if (by.length) throw new PlanError(`${id} is blocked by ${by.join(', ')}; the user has to answer first`);
  const wasDone = t.status === 'done';
  t.status = 'done';
  t.gate = gate === undefined || gate === null ? null : { ok: true, text: gate === '' ? '' : oneLine(gate, 'gate text') };
  const ev = { type: 'done', task: id };
  if (t.gate) ev.gate = { ...t.gate };
  return wasDone ? [ev] : [ev, ...phaseEvent(doc, id)];
}

function fail(doc, id, gate) {
  const t = needTask(doc, id);
  t.status = 'failed';
  t.gate = { ok: false, text: oneLine(gate, 'gate text (what failed)') };
  return [{ type: 'fail', task: id, gate: { ...t.gate } }];
}

function nextQuestionId(doc, events = []) {
  const nums = [...questions(doc).map(q => q.id), ...events.map(e => e.q)].filter(isQuestionId).map(x => +x.slice(1));
  return 'q' + (nums.length ? Math.max(...nums) + 1 : 1);
}

function ensureSection(doc, kind) {
  const s = doc.sections.find(x => x.kind === kind);
  if (s) return s;
  const n = kind === 'next'
    ? { kind, gap: 1, body: { gap: 0, text: '' } }
    : { kind, gap: 1, intro: { gap: 0, text: '' }, items: [] };
  const at = kind === 'waiting' ? doc.sections.findIndex(x => x.kind === 'next') + 1 : 0;
  doc.sections.splice(at, 0, n);
  return n;
}

function ask(doc, { q, detail = '', blocks = [], asked, id }) {
  const text = questionArg(q);
  const qid = id || nextQuestionId(doc);
  if (!isQuestionId(qid)) throw new PlanError(`"${qid}" is not a question id (like q2)`, 2);
  if (questions(doc).some(x => x.id === qid)) throw new PlanError(`question ${qid} already exists`);
  for (const b of blocks) { const t = needTask(doc, b); if (t.status === 'done') throw new PlanError(`${b} is already done; a question can't block it`); }
  const sec = ensureSection(doc, 'waiting');
  sec.items.push({ gap: sec.items.length ? 0 : 1, id: qid, q: text, blocks: [...blocks], asked: asked || iso(), body: cardText(detail) });
  for (const b of blocks) findTask(doc, b).status = 'blocked';
  return [{ type: 'ask', q: qid, text }];
}

function answer(doc, qid, text) {
  const sec = doc.sections.find(s => s.kind === 'waiting' && s.items.some(x => x.id === qid));
  if (!sec) throw new PlanError(`no open question ${qid}`);
  const i = sec.items.findIndex(x => x.id === qid);
  const [q] = sec.items.splice(i, 1);
  if (sec.items[i]) sec.items[i].gap = q.gap;
  for (const b of q.blocks) { const t = findTask(doc, b); if (t && t.status === 'blocked' && !blockersOf(doc, b).length) t.status = 'todo'; }
  return [{ type: 'answer', q: qid, text: oneLine(text, 'answer') }];
}

function setNext(doc, text) {
  const s = ensureSection(doc, 'next');
  const body = freeText(String(text || '').replace(/\r/g, '').replace(/^\s*\n|\s+$/g, ''), 'next text');
  s.body = { gap: body ? 1 : 0, text: body.split('\n').map(l => (/^\s+$/.test(l) ? '' : l)).join('\n') };
  return [];
}

function archive(doc, now = new Date()) {
  doc.meta.status = 'done';
  doc.meta.archived = iso(now);
  return [{ type: 'archive' }];
}

function allTasksDone(doc) {
  const all = tasks(doc);
  return all.length > 0 && all.every(t => t.status === 'done');
}

function markFinished(doc, text = 'marked finished') {
  doc.meta.status = 'finished';
  return [{ type: 'finish', text }];
}

function reopen(doc) {
  if (doc.meta.status !== 'finished') return [];
  doc.meta.status = 'active';
  return [{ type: 'reopen' }];
}

function settleAfterDone(doc) {
  if (!allTasksDone(doc)) return reopen(doc);
  return doc.meta.status === 'active' ? markFinished(doc, 'all tasks done') : [];
}

function restore(doc) {
  delete doc.meta.archived;
  doc.meta.status = allTasksDone(doc) ? 'finished' : 'active';
  return [{ type: 'restore' }];
}

function newPlan({ topic, title, repo, created, goal }) {
  if (!isTopic(topic)) throw new PlanError(`bad topic "${topic}": use 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit`, 2);
  if (!path.isAbsolute(String(repo || ''))) throw new PlanError('repo must be an absolute path', 2);
  const head = ['---', `topic: ${topic}`, `title: ${oneLine(title, 'title')}`, `repo: ${repo}`, 'status: active', `created: ${created || iso()}`, '---', ''];
  const g = goal ? [freeText(String(goal).replace(/\r/g, '').trim(), 'goal'), ''] : [];
  return parse([...head, ...g, '## Next', '', '## Waiting on you', ''].join('\n'));
}

function makeEvent(fields, now = new Date()) {
  const e = { ts: new Date(now).toISOString(), ...fields };
  const out = {};
  for (const k of EVENT_KEYS) if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
  return out;
}

function eventError(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'event is not an object';
  if (!isIso(e.ts)) return 'ts must be an ISO time';
  if (!EVENT_TYPES.includes(e.type)) return `type must be one of ${EVENT_TYPES.join(', ')}`;
  if (e.task !== undefined && !isTaskId(e.task)) return 'task must be a task id like T3';
  if (e.q !== undefined && !isQuestionId(e.q)) return 'q must be a question id like q1';
  if (e.phase !== undefined && !(Number.isInteger(e.phase) && e.phase > 0)) return 'phase must be a phase number';
  for (const k of ['session', 'text']) if (e[k] !== undefined && typeof e[k] !== 'string') return `${k} must be a string`;
  if (e.gate !== undefined && !(e.gate && typeof e.gate.ok === 'boolean' && typeof e.gate.text === 'string')) return 'gate must be {ok, text}';
  if (['start', 'done', 'fail'].includes(e.type) && e.task === undefined) return `${e.type} needs task`;
  if (['ask', 'answer'].includes(e.type) && e.q === undefined) return `${e.type} needs q`;
  if (e.type === 'fail' && !(e.gate && e.gate.ok === false)) return 'fail needs a failed gate';
  return null;
}

function brief(t) { return { id: t.id, title: t.title, status: t.status, model: t.model, gate: t.gate }; }

function taskTimes(events) {
  const out = {};
  for (const e of events) {
    if (!e.task) continue;
    const t = out[e.task] || (out[e.task] = { started: null, finished: null });
    if (e.type === 'start') { t.started = e.ts; t.finished = null; } else if (e.type === 'done') t.finished = e.ts;
  }
  return out;
}

function finishedTime(status, events, times) {
  const ev = status === 'finished' ? events.filter(e => e.type === 'finish').pop() : null;
  if (ev) return ev.ts;
  const stamps = Object.values(times).map(t => t.finished).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  return stamps.length ? stamps[stamps.length - 1] : null;
}

function summarize(doc, events = []) {
  const ph = phases(doc);
  const all = ph.flatMap((p, pi) => p.tasks.map(t => ({ t, pi })));
  const done = all.filter(x => x.t.status === 'done').length;
  const total = all.length;
  const now = all.find(x => x.t.status === 'doing') || all.find(x => x.t.status === 'failed') || null;
  const next = all.find(x => x.t.status === 'todo') || null;
  const cur = now || next || all.find(x => x.t.status !== 'done') || null;
  const pi = cur ? cur.pi : ph.length - 1;
  const p = ph[pi];
  const gateEv = events.filter(e => e.gate).pop();
  const times = taskTimes(events);
  const nextSec = doc.sections.find(s => s.kind === 'next');
  const m = doc.meta;
  const complete = total > 0 && done === total;
  const finished = m.status === 'finished' || (m.status === 'active' && complete);
  return {
    topic: m.topic || null, title: m.title || null, repo: m.repo || null, status: m.status || null,
    created: m.created || null, archived: m.archived || null,
    updated: events.length ? events[events.length - 1].ts : m.created || null,
    done, total, pct: total ? Math.round(done / total * 100) : 0, complete,
    finished, finishedAt: finished ? finishedTime(m.status, events, times) : null,
    phase: p ? { n: p.n, of: ph.length, name: p.name, done: p.tasks.filter(t => t.status === 'done').length, total: p.tasks.length } : null,
    now: now ? { ...brief(now.t), since: (times[now.t.id] || {}).started || null } : null,
    next: next ? brief(next.t) : null,
    nextNote: nextSec ? clip(nextSec.body.text, 300) : '',
    waiting: questions(doc).map(q => ({ id: q.id, q: q.q, blocks: q.blocks, asked: q.asked })),
    lastGate: gateEv ? { ok: gateEv.gate.ok, text: gateEv.gate.text, task: gateEv.task || null, at: gateEv.ts } : null,
    errors: (doc.errors || []).length,
  };
}

function detail(doc, events = [], { timeline = 200 } = {}) {
  const times = taskTimes(events);
  const qs = questions(doc);
  const nextSec = doc.sections.find(s => s.kind === 'next');
  return {
    ...summarize(doc, events),
    preamble: doc.preamble.text,
    nextNote: nextSec ? nextSec.body.text : '',
    phases: phases(doc).map(p => ({
      n: p.n, name: p.name, intro: p.intro.text,
      done: p.tasks.filter(t => t.status === 'done').length, total: p.tasks.length,
      tasks: p.tasks.map(t => ({
        ...brief(t), body: t.body,
        by: qs.filter(q => q.blocks.includes(t.id)).map(q => q.id),
        started: (times[t.id] || {}).started || null,
        finished: t.status === 'done' ? (times[t.id] || {}).finished || null : null,
      })),
    })),
    waiting: qs.map(q => ({ id: q.id, q: q.q, detail: q.body, blocks: q.blocks, asked: q.asked })),
    sections: doc.sections.filter(s => s.kind === 'raw').map(s => ({ heading: s.heading, text: s.body.text })),
    timeline: events.slice(-timeline),
    errors: (doc.errors || []).map(x => ({ line: x.line, msg: x.msg })),
  };
}

function fromLegacy({ planText = '', progressText = '', topic, repo, created, now = new Date() }) {
  const h1 = /^# (.+)$/m.exec(planText) || /^# (.+)$/m.exec(progressText);
  const title = (h1 ? h1[1] : topic).replace(/\s+[—–-]\s+progress$/i, '').trim() || topic;
  const groups = [];
  const used = new Set();
  const all = [];
  const fence = { open: false };
  for (const raw of progressText.replace(/\r/g, '').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fence.open = !fence.open; continue; }
    if (fence.open) continue;
    const hm = /^#{2,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (hm) { groups.push({ name: hm[1].replace(/^Phase\s+\d+\s*[—–:-]\s*/i, '').trim() || hm[1], items: [] }); continue; }
    const m = /^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(raw);
    if (!m) continue;
    if (!groups.length) groups.push({ name: 'Tasks', items: [] });
    const g = groups[groups.length - 1];
    const text = m[3].trim().replace(/\s+/g, ' ');
    if (m[1].replace(/\t/g, '  ').length >= 2 && g.items.length) { g.items[g.items.length - 1].sub.push(`- [${m[2] === ' ' ? ' ' : 'x'}] ${text}`); continue; }
    const im = /^(T\d+[a-z]?)\b[\s:.)-]*(.*)$/.exec(text);
    const mm = /\s*\((Opus|Sonnet|Haiku|Fable|main)\)\s*$/i.exec(im ? im[2] : text);
    const body = (im ? im[2] : text).slice(0, mm ? mm.index : undefined).trim();
    const item = { want: im && !used.has(im[1]) ? im[1] : null, title: body || '(untitled)', model: mm ? modelName(mm[1]) : null, done: m[2] !== ' ', sub: [] };
    if (item.want) used.add(item.want);
    g.items.push(item);
    all.push(item);
  }
  const counter = { n: 0 };
  for (const it of all) if (!it.want) { do counter.n++; while (used.has('T' + counter.n)); it.want = 'T' + counter.n; used.add(it.want); }
  const next = all.find(x => !x.done);
  const lines = ['---', `topic: ${topic}`, `title: ${title}`, `repo: ${repo}`, 'status: active', `created: ${created || iso(now)}`, '---', '',
    `Imported from docs/${topic}/ on ${iso(now).slice(0, 10)}. The original files are kept next to this plan as legacy-PLAN.md and legacy-PROGRESS.md.`, '',
    '## Next', '', ...(next ? [`${next.want} ${next.title}`, ''] : []), '## Waiting on you', ''];
  groups.filter(g => g.items.length).forEach((g, i) => {
    lines.push(`## Phase ${i + 1} — ${g.name}`, '');
    for (const it of g.items) {
      lines.push(taskText({ status: it.done ? 'done' : 'todo', id: it.want, title: it.title, model: it.model, gate: null }));
      for (const s of it.sub) lines.push('  ' + s);
    }
    lines.push('');
  });
  return parse(lines.join('\n'));
}

function storeRoot(env = process.env) {
  return env.BEAST_PLANS_DIR ? path.resolve(env.BEAST_PLANS_DIR) : path.join(env.HOME || os.homedir(), '.beast', 'plans');
}

function real(p) { try { return fs.realpathSync(p); } catch { return p; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function isFile(p) { try { return fs.lstatSync(p).isFile(); } catch { return false; } }
function dirs(p) { try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; } }

const GIT_COMMON = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
const GIT_WORKTREES = ['worktree', 'list', '--porcelain'];

function gitEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[k];
  return env;
}

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return null; }
}

function gitAsync(cwd, args) {
  return new Promise(resolve => {
    try { execFile('git', args, { cwd, env: gitEnv(), encoding: 'utf8', timeout: 5000 }, (err, out) => resolve(err ? null : String(out).trim())); } catch { resolve(null); }
  });
}

const commonIsMain = common => path.basename(common) === '.git';
const firstWorktree = list => {
  const m = list && /^worktree (.+)$/m.exec(list);
  return m ? real(m[1]) : null;
};

function mainWorktree(cwd) {
  const common = git(cwd, GIT_COMMON);
  if (!common) return null;
  return commonIsMain(common) ? real(path.dirname(common)) : firstWorktree(git(cwd, GIT_WORKTREES));
}

async function mainWorktreeAsync(cwd) {
  const common = await gitAsync(cwd, GIT_COMMON);
  if (!common) return null;
  return commonIsMain(common) ? real(path.dirname(common)) : firstWorktree(await gitAsync(cwd, GIT_WORKTREES));
}

function repoDirName(main) {
  return path.basename(String(main)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+/, '').slice(0, 48) || 'repo';
}

function repoDirFor(root, main, { create = false } = {}) {
  const base = repoDirName(main);
  const claimFrom = k => {
    if (k >= 1000) throw new PlanError(`too many repos named ${base} in ${root}`);
    const name = k === 1 ? base : `${base}-${k}`;
    const dir = path.join(root, name);
    const marker = path.join(dir, '.repo');
    const owner = (readText(marker) || '').trim();
    if (owner === main) return name;
    if (owner) return claimFrom(k + 1);
    if (!create) return fs.existsSync(dir) ? claimFrom(k + 1) : null;
    fs.mkdirSync(dir, { recursive: true });
    try { fs.writeFileSync(marker, main + '\n', { flag: 'wx' }); return name; } catch (e) { if (e.code !== 'EEXIST') throw e; return claimFrom(k); }
  };
  return claimFrom(1);
}

function planDir(root, repoDir, topic) { return path.join(root, repoDir, topic); }
function planFiles(dir) { return { plan: path.join(dir, 'plan.md'), events: path.join(dir, 'events.jsonl') }; }

function listPlans(root) {
  const out = [];
  for (const d of dirs(root)) {
    if (!isTopic(d)) continue;
    const repo = (readText(path.join(root, d, '.repo')) || '').trim() || null;
    for (const t of dirs(path.join(root, d))) {
      const dir = path.join(root, d, t);
      if (isTopic(t) && isFile(path.join(dir, 'plan.md'))) out.push({ id: `${d}/${t}`, repoDir: d, repo, topic: t, dir, archived: false });
    }
    for (const a of dirs(path.join(root, d, '_archive'))) {
      const dir = path.join(root, d, '_archive', a);
      if (isTopic(a) && isFile(path.join(dir, 'plan.md'))) out.push({ id: `${d}/_archive/${a}`, repoDir: d, repo, topic: a, dir, archived: true });
    }
  }
  return out;
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch { return null; }
}

function readPlan(dir) {
  const f = planFiles(dir).plan;
  const st = lstatOrNull(f);
  if (!st || !st.isFile()) return null;
  if (st.size > MAX_PLAN) throw new PlanError(`${f} is larger than 1 MB`);
  const text = fs.readFileSync(f, 'utf8');
  const doc = parse(text);
  const folder = path.basename(dir);
  if (path.basename(path.dirname(dir)) !== '_archive' && Object.hasOwn(doc.meta, 'topic') && doc.meta.topic !== folder) {
    doc.errors.push({ line: doc.metaLine.topic || 1, msg: `topic "${clip(doc.meta.topic)}" does not match the plan folder "${folder}"` });
  }
  return { text, doc, mtimeMs: st.mtimeMs };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

function shapeOf(doc) {
  return JSON.stringify({
    meta: doc.meta,
    preamble: doc.preamble.text,
    sections: doc.sections.map(s => ({
      kind: s.kind, n: s.n, name: s.name, heading: s.heading,
      intro: s.intro ? s.intro.text : null, body: s.body ? s.body.text : null,
      items: (s.tasks || s.items || []).map(it => without(it, ['line', 'gap'])),
    })),
  });
}

function checkedPlanText(doc) {
  const text = serialize(doc);
  const back = parse(text);
  if (back.errors.length) throw new PlanError(`refused: the new plan.md would have errors; nothing was written\n${formatErrors(back.errors)}`);
  if (shapeOf(back) !== shapeOf(doc)) throw new PlanError('refused: the new plan.md would not read back as the intended change; nothing was written');
  return text;
}

function writePlan(dir, doc) {
  writeAtomic(planFiles(dir).plan, checkedPlanText(doc));
}

function appendEvent(dir, ev) {
  const why = eventError(ev);
  if (why) throw new PlanError(`bad event: ${why}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(planFiles(dir).events, JSON.stringify(ev) + '\n');
}

function readEvents(dir, { limit = Infinity } = {}) {
  const text = readText(planFiles(dir).events) || '';
  const results = text.split('\n').filter(l => l.trim()).map(l => {
    try { const e = JSON.parse(l); return eventError(e) ? { ok: false } : { ok: true, e }; } catch { return { ok: false }; }
  });
  const events = results.filter(x => x.ok).map(x => x.e);
  const bad = results.length - events.length;
  return { events: Number.isFinite(limit) ? events.slice(-limit) : events, bad };
}

function breakStale(lock, st, token) {
  const aside = `${lock}.stale-${token}`;
  try { fs.renameSync(lock, aside); } catch { return; }
  const moved = lstatOrNull(aside);
  if (moved && moved.ino === st.ino && moved.mtimeMs === st.mtimeMs) { fs.rmSync(aside, { force: true }); return; }
  try { fs.linkSync(aside, lock); } catch {}
  fs.rmSync(aside, { force: true });
}

function release(held) {
  try { if (fs.readFileSync(held.file, 'utf8') === held.token) fs.unlinkSync(held.file); } catch {}
}

function withLock(dir, fn, { wait = 3000, stale = 15000, create = false } = {}) {
  if (create) fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const held = { file: lock, token: `${process.pid}-${crypto.randomBytes(8).toString('hex')}` };
  const until = Date.now() + wait;
  for (;;) {
    try { fs.writeFileSync(lock, held.token, { flag: 'wx' }); break; } catch (e) {
      if (e.code === 'ENOENT') throw new PlanError('the plan is gone (archived or removed by another plan command)');
      if (e.code !== 'EEXIST') throw e;
      const st = lstatOrNull(lock);
      if (st && Date.now() - st.mtimeMs > stale) { breakStale(lock, st, held.token); continue; }
      if (Date.now() > until) throw new PlanError('the plan is locked by another plan command; try again');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  const at = { dir };
  const moveTo = target => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(at.dir, target);
    at.dir = target;
    held.file = path.join(target, '.lock');
  };
  try { return fn(moveTo); } finally { release(held); }
}

function claimFile(root, session) {
  if (typeof session !== 'string' || !session || session.length > 128 || session.includes('\0')) return null;
  return path.join(root, '.claims', encodeURIComponent(session) + '.json');
}

function readClaim(root, session) {
  const f = claimFile(root, session);
  const j = f && readText(f);
  if (!j) return null;
  try {
    const c = JSON.parse(j);
    const [repoDir, topic] = String(c.plan || '').split('/');
    return isTopic(repoDir) && isTopic(topic) ? { repoDir, topic, at: c.at || null } : null;
  } catch { return null; }
}

function writeClaim(root, session, repoDir, topic, now = new Date()) {
  const f = claimFile(root, session);
  if (!f) throw new PlanError('no session to claim for (not in tmux; pass --session)', 2);
  writeAtomic(f, JSON.stringify({ plan: `${repoDir}/${topic}`, at: iso(now) }) + '\n');
}

function clearClaim(root, session) {
  const f = claimFile(root, session);
  if (f) try { fs.unlinkSync(f); } catch {}
}

function activeTopics(root, repoDir) {
  return dirs(path.join(root, repoDir)).filter(t => {
    if (!isTopic(t)) return false;
    try { const r = readPlan(path.join(root, repoDir, t)); return !!r && r.doc.meta.status !== 'done'; } catch { return false; }
  });
}

function resolvePlan({ root, cwd, repo, session, topic }) {
  const main = repo ? real(path.resolve(repo)) : mainWorktree(cwd || process.cwd());
  if (!main) return { error: 'not inside a git repository (pass --repo <path>)', code: 3 };
  const repoDir = repoDirFor(root, main);
  const active = repoDir ? activeTopics(root, repoDir) : [];
  const hit = (t, source) => ({ repo: main, repoDir, topic: t, dir: planDir(root, repoDir, t), source });
  if (topic) {
    if (repoDir && isTopic(topic) && isFile(planFiles(planDir(root, repoDir, topic)).plan)) return hit(topic, 'flag');
    return { error: `no plan "${topic}" for ${main}`, code: 3, repo: main, repoDir, candidates: active };
  }
  const claim = session ? readClaim(root, session) : null;
  if (claim && claim.repoDir === repoDir && active.includes(claim.topic)) return hit(claim.topic, 'claim');
  if (active.length === 1) return hit(active[0], 'single');
  const error = active.length
    ? `${active.length} active plans for ${main}: ${active.join(', ')}; pass --plan <topic> or run 'plan use <topic>'`
    : `no active plan for ${main}`;
  return { error, code: 3, repo: main, repoDir, candidates: active };
}

function archiveTarget(root, repoDir, topic, now = new Date()) {
  const base = `${iso(now).slice(0, 10)}-${topic}`.slice(0, 64);
  const dir = path.join(root, repoDir, '_archive');
  const pick = k => {
    const name = k === 1 ? base : `${base.slice(0, 60)}-${k}`;
    return fs.existsSync(path.join(dir, name)) ? pick(k + 1) : path.join(dir, name);
  };
  return pick(1);
}

module.exports = {
  PlanError,
  isTopic, isTaskId, isQuestionId, isIso, iso,
  parse, validate, serialize, formatErrors,
  phases, tasks, questions, findTask,
  start, finish, fail, ask, answer, setNext, archive, markFinished, reopen, settleAfterDone, restore, nextQuestionId, newPlan, fromLegacy,
  makeEvent, eventError, summarize, detail,
  storeRoot, mainWorktree, mainWorktreeAsync, repoDirName, repoDirFor, planDir, planFiles, listPlans, readPlan, writeAtomic, checkedPlanText, writePlan,
  appendEvent, readEvents, withLock, claimFile, readClaim, writeClaim, clearClaim, activeTopics, resolvePlan, archiveTarget,
};
