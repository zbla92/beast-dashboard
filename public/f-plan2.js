'use strict';
(() => {
  ICONS.archive = '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>';
  const OPEN_KEY = 'bd.plan2.open';
  const readOpen = () => {
    try {
      const v = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  };
  const OPEN = readOpen();
  const EXP = { phases: {}, tasks: {}, menu: false, act: false };
  const APV = { name: null, plan: null, restored: null };
  const TICKING = new Set();
  const PV = { phone: false, ctx: null, rerender: null, seen: null };
  const VIEW = {};
  const PH = { name: null };
  const ST = { sums: [], busy: false, again: false, sig: '', skey: null, was: false, timer: 0 };
  const DET = {};
  const STALE = new Set();
  const FETCHING = new Set();
  const SENT = new Set();
  const SENDING = new Set();
  const DRAFT = {};
  const SH = { close: null };
  const QS = { id: null, pick: null, sig: '', render: null, close: null };
  const ARCH = { list: null, err: '', seq: 0, render: null };
  const TEXT_MAX = 2000;
  const RING_R = 11;
  const RING_C = 2 * Math.PI * RING_R;

  const enabled = () => !!(S.settings && S.settings.plans);
  const isPhone = () => matchMedia('(max-width: 900px)').matches;
  const planFor = (sums, name) => sums.find(p => !p.archived && p.sessions.includes(name)) || null;
  const offerFor = (sums, name) => sums.find(p => !p.archived && p.offered.includes(name)) || null;
  const clock = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const dayMonth = ts => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const finishedWhen = (iso, now = new Date()) => new Date(iso).toDateString() === now.toDateString() ? clock(iso) : `${dayMonth(iso)}, ${clock(iso)}`;
  const ringMarkup = (pct, size) => {
    const dash = (RING_C * Math.max(0, Math.min(100, pct)) / 100).toFixed(1);
    return `<svg viewBox="0 0 28 28" width="${size}" height="${size}"><circle class="t" cx="14" cy="14" r="${RING_R}"/><circle class="a" cx="14" cy="14" r="${RING_R}" stroke-dasharray="${dash} ${RING_C.toFixed(1)}" transform="rotate(-90 14 14)"/></svg>`;
  };
  const ring = (p, size) => h('span', { class: 'fp2-ring' + (p.complete ? ' full' : ''), html: ringMarkup(p.pct, size) }, p.waiting.length ? h('i', { class: 'fp2-dot' }) : null);
  const projectOf = (projects, id) => projects.find(x => x.id === id) || null;
  const groupKey = pr => pr ? (pr.org ? 'org:' + pr.org : 'proj:' + pr.id) : null;
  const planGroup = (p, projects) => groupKey(projectOf(projects, p.projectId)) || 'dir:' + p.id.split('/')[0];
  const orgPlans = (sums, projects, own, projectId) => {
    const key = own ? planGroup(own, projects) : groupKey(projectOf(projects, projectId));
    if (!key) return own ? [own] : [];
    const rest = sums.filter(p => !p.archived && !(own && p.id === own.id) && planGroup(p, projects) === key).sort((a, b) => a.topic.localeCompare(b.topic));
    return own ? [own, ...rest] : rest;
  };
  const planNames = (list, projects) => {
    const count = {};
    for (const p of list) count[p.topic] = (count[p.topic] || 0) + 1;
    return list.map(p => { if (count[p.topic] < 2) return p.topic; const pr = projectOf(projects, p.projectId); return pr ? pr.name : p.id.split('/')[0]; });
  };
  const archivedOf = (all, projects, key) => all.filter(p => p.archived && (!key || planGroup(p, projects) === key)).sort((a, b) => String(b.archived).localeCompare(String(a.archived)));
  const sessionProject = name => { const s = ((S.runtime && S.runtime.sessions) || []).find(x => x.name === name); return s ? s.project : null; };
  const orgLabel = (projects, projectId) => { const pr = projectOf(projects, projectId); return pr ? pr.org || pr.name : ''; };
  const isOpen = (name, hasOwn) => isPhone() ? PH.name === name : name in OPEN ? !!OPEN[name] : hasOwn;

  async function load() {
    if (!enabled()) return;
    if (ST.busy) { ST.again = true; return; }
    ST.busy = true;
    try {
      const d = await api('plans?v=2');
      ST.sums = d.plans || [];
      pruneSent();
      sync();
      if (TERM.open) renderTermPanel();
    } catch {
    } finally {
      ST.busy = false;
      if (ST.again) { ST.again = false; load(); }
    }
  }

  function onPlan(ev) {
    if (!enabled()) return;
    if (ev.removed) { delete DET[ev.id]; STALE.delete(ev.id); } else STALE.add(ev.id);
    clearTimeout(ST.timer);
    ST.timer = setTimeout(() => { load(); if (EXP.menu || ARCH.render || APV.plan) loadArchived(); }, 150);
  }

  async function loadArchived() {
    ARCH.seq += 1;
    const seq = ARCH.seq;
    try {
      const d = await api('plans?v=2&archived=1');
      if (seq !== ARCH.seq) return;
      ARCH.list = d.plans || [];
      ARCH.err = '';
      if (APV.plan && !APV.restored && !ARCH.list.some(p => p.id === APV.plan.id)) { clearPreview(); panelChanged(); }
    } catch (e) {
      if (seq !== ARCH.seq) return;
      ARCH.err = e.message;
    }
    if (ARCH.render) ARCH.render();
    if (EXP.menu && PV.rerender && document.getElementById('fp2-panel')) PV.rerender();
  }

  async function ensureDetail(p) {
    const have = DET[p.id];
    if (have && have.mtime === p.mtime && !STALE.has(p.id)) return;
    if (FETCHING.has(p.id)) return;
    FETCHING.add(p.id);
    try {
      STALE.delete(p.id);
      DET[p.id] = await api('plan/' + p.id);
      sync(true);
    } catch { STALE.add(p.id); }
    FETCHING.delete(p.id);
  }

  const planLabel = p => p.title || p.topic;

  const gateChip = (g, onOpen) => g ? h('button', { class: 'fp2-gate ' + (g.ok ? 'ok' : 'bad'), title: ['last gate', g.task, g.text, g.at ? clock(g.at) : ''].filter(Boolean).join(' · '), onclick: onOpen }, `${g.ok ? '✓' : '✗'} ${g.text || 'gate'}`) : null;
  const modelChip = m => m ? h('span', { class: 'fp2-model' }, m) : null;
  const spin = () => h('span', { class: 'fp2-spin' });

  const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const clipTo = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

  function answerMsg(topic, w, text) {
    const a = oneLine(text);
    if (!a || a.length > TEXT_MAX) return null;
    return `Plan ${topic}, answer to ${w.id} ("${clipTo(oneLine(w.q), 160)}"): ${a} — record it with plan answer ${w.id} "<this answer>" --plan ${topic}, then carry on with the plan.`;
  }

  const withNote = (base, note) => {
    const n = oneLine(note);
    if (n.length > TEXT_MAX) return null;
    return n ? `${base} Note: ${n}` : base;
  };

  const updateMsg = (topic, note) => withNote(`Update the plan ${topic} with the plan CLI: plan show --plan ${topic}, edit plan.md at the path from plan path --plan ${topic}, status changes only through plan start|done|fail|ask|answer|next|note. Do not change frozen contracts without asking me.`, note);

  const makeMsg = note => withNote('Make a plan for this session with the plan CLI (plan new <topic> --title "<title>", then phases and task cards as in plan help, contracts first). Show me the plan and wait for my go before starting work.', note);

  const continueMsg = topic => `Continue the plan ${topic}: run plan use ${topic}, then plan show, and carry on with it.`;

  const leaveMsg = topic => `This chat no longer works on the plan ${topic}: run plan use --clear. The plan itself stays as it is. Do not work on it unless I ask.`;

  const targetOf = p => p.sessions.includes(TERM.active) ? TERM.active : p.sessions[0] || null;
  const NOT_LIVE = 'No live session runs this plan';
  const isLive = name => { const cl = name ? claudeOf(name) : null; return !!cl && cl.state !== 'ended'; };
  const sessLabel = name => { const s = ((S.runtime && S.runtime.sessions) || []).find(x => x.name === name); return s ? sessTitle(s) : name; };

  async function sendToSession(p, text) {
    const target = targetOf(p);
    if (!isLive(target)) { toast(NOT_LIVE, 'err'); return false; }
    const cl = claudeOf(target);
    if (cl.state === 'permission') { toast('Claude is at a permission prompt — answer it first', 'err'); return false; }
    if (cl.mode !== 'chat' && cl.draft) { toast('Something is typed in the terminal — send or clear it first', 'err'); return false; }
    try { await api('send', { session: target, text }); } catch (e) { toast(e.message, 'err'); return false; }
    toast('Sent to ' + sessLabel(target), 'ok');
    return true;
  }

  async function sendOnce(name, text) {
    const key = name + '|' + text;
    if (SENDING.has(key)) return false;
    SENDING.add(key);
    try { return await sendToSession({ sessions: [name] }, text); } finally { SENDING.delete(key); }
  }

  async function saveAnswer(id, q, text) {
    try { await api('plan-answer', { id, q, text }); } catch (e) { toast(e.message, 'err'); return false; }
    toast(`${q} saved into the plan`, 'ok');
    load();
    return true;
  }

  function sheet({ title, sub, body, onClose }) {
    if (SH.close) SH.close();
    const phone = isPhone();
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    const scrim = h('div', { class: 'fp2-sh-scrim', onclick: () => close() });
    const box = h('div', { class: 'fp2-sh' + (phone ? ' phone' : ''), role: 'dialog', 'aria-modal': 'true' },
      phone ? h('div', { class: 'fp2-grab' }) : null,
      h('div', { class: 'fp2-sh-top' }, h('b', null, title), sub != null ? h('span', { class: 'fp2-sh-sub' }, sub) : null, h('span', { class: 'fp2-sp' }), h('button', { class: 'fp2-x', 'aria-label': 'close', onclick: () => close() }, ico('x', 16))),
      h('div', { class: 'fp2-sh-body' }, body));
    function close() {
      if (SH.close !== close) return;
      SH.close = null;
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      box.remove();
      if (onClose) onClose();
    }
    SH.close = close;
    document.addEventListener('keydown', onKey, true);
    document.body.append(scrim, box);
    return close;
  }

  const askedAt = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    if (d.toDateString() === new Date().toDateString()) return clock(iso);
    const opt = Date.now() - d < 6 * 86400000 ? { weekday: 'short' } : { day: 'numeric', month: 'short' };
    return d.toLocaleDateString([], opt) + ' ' + clock(iso);
  };

  const blocksOf = list => [...new Set(list.flatMap(w => w.blocks || []))];

  function questionsOf(p) {
    const d = DET[p.id];
    const full = {};
    for (const w of (d && d.waiting) || []) full[w.id] = w;
    return p.waiting.map(w => ({ ...w, detail: full[w.id] ? full[w.id].detail || '' : '' }));
  }

  function pruneSent() {
    for (const key of SENT) {
      const i = key.lastIndexOf('|');
      const p = ST.sums.find(x => x.id === key.slice(0, i));
      if (!p || !p.waiting.some(w => w.id === key.slice(i + 1))) SENT.delete(key);
    }
  }

  function questionsRow(p) {
    const n = p.waiting.length;
    const blocks = blocksOf(p.waiting);
    return h('button', { class: 'fp2-qrow', onclick: () => openQuestions(p.id) },
      h('i', { class: 'fp2-wdot' }), h('span', { class: 'fp2-qn' }, h('b', null, n), ` open question${n > 1 ? 's' : ''}`),
      blocks.length ? h('span', { class: 'fp2-qb' }, 'blocks ' + blocks.join(' · ')) : null,
      ico('chevronRight', 14));
  }

  function questionCard(p, w, live, target) {
    const key = p.id + '|' + w.id;
    const on = QS.pick === w.id;
    const small = !!QS.pick && !on;
    const meta = h('div', { class: 'fp2-sh-meta' }, w.id, w.asked ? ' · asked ' + askedAt(w.asked) : '', ...(w.blocks.length ? [' · blocks ', h('b', null, w.blocks.join(', '))] : []),
      SENT.has(key) ? h('span', { class: 'fp2-sh-sent' }, 'sent · waiting for Claude') : null);
    const card = h('div', { class: 'fp2-sh-q' + (on ? ' on' : '') + (small ? ' small' : '') },
      h('button', { class: 'fp2-sh-qh', onclick: () => { QS.pick = on ? null : w.id; QS.sig = ''; renderQuestions(); } },
        h('i', { class: 'fp2-wdot' }),
        h('span', { class: 'fp2-sh-qt' }, h('span', { class: 'fp2-sh-qq' }, w.q), !small && w.detail ? h('span', { class: 'fp2-sh-qd' }, w.detail) : null, meta)));
    if (on) card.append(answerBox(p, w, key, live, target));
    return card;
  }

  function answerBox(p, w, key, live, target) {
    const ta = h('textarea', { class: 'fp2-sh-ta', rows: 3, placeholder: 'Your answer…', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: true });
    ta.value = DRAFT[key] || '';
    const pv = h('div', { class: 'fp2-sh-pv' });
    const btn = h('button', { class: 'btn primary fp2-sh-go' }, ico(live ? 'send' : 'check', 14), live ? 'Send' : 'Save to plan');
    const update = () => {
      DRAFT[key] = ta.value;
      const a = oneLine(ta.value);
      const msg = answerMsg(p.topic, w, ta.value);
      btn.disabled = SENDING.has(key) || !msg;
      if (a.length > TEXT_MAX) pv.replaceChildren(h('span', { class: 'fp2-sh-over' }, `Too long: ${a.length} of ${TEXT_MAX} characters`));
      else if (live) pv.replaceChildren(...(msg ? [h('span', { class: 'fp2-sh-pvl' }, 'Message'), msg] : [h('span', { class: 'dim' }, 'The message to Claude shows here as you type.')]));
      else pv.replaceChildren();
      pv.classList.toggle('hidden', !pv.childNodes.length);
    };
    const go = async () => {
      const msg = answerMsg(p.topic, w, ta.value);
      if (!msg || SENDING.has(key)) return;
      SENDING.add(key); update();
      const ok = live ? await sendToSession(p, msg) : await saveAnswer(p.id, w.id, oneLine(ta.value));
      SENDING.delete(key);
      if (!ok) { update(); renderQuestions(); return; }
      delete DRAFT[key];
      if (live) SENT.add(key);
      if (QS.close) QS.close();
    };
    btn.onclick = go;
    ta.addEventListener('input', update);
    ta.addEventListener('keydown', ev => { if (ev.key === 'Escape') return; ev.stopPropagation(); if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); go(); } });
    update();
    const hint = live
      ? h('span', { class: 'fp2-sh-hint' }, 'Goes to ', h('b', null, sessLabel(target)), ' as a message; Claude records it with ', h('code', null, 'plan answer'), '.')
      : h('span', { class: 'fp2-sh-hint' }, 'Saved into the plan with ', h('code', null, 'plan answer ' + w.id), '; the next session on this plan sees it in its plan context.');
    requestAnimationFrame(() => { if (ta.isConnected && !isPhone()) ta.focus(); });
    return h('div', { class: 'fp2-sh-ans' }, ta, pv, h('div', { class: 'fp2-sh-foot' }, hint, btn));
  }

  function renderQuestions() {
    if (!QS.render) return;
    const p = ST.sums.find(x => x.id === QS.id);
    const list = p ? questionsOf(p) : [];
    const target = p ? targetOf(p) : null;
    const live = isLive(target);
    if (QS.pick && !list.some(w => w.id === QS.pick)) QS.pick = null;
    if (p && QS.pick && SENDING.has(p.id + '|' + QS.pick)) return;
    const sig = JSON.stringify([list, QS.pick, live, target, p ? [...SENT].filter(k => k.startsWith(p.id + '|')) : []]);
    if (sig === QS.sig) return;
    QS.sig = sig;
    QS.render(p, list, live, target);
  }

  function openQuestions(id) {
    const p = ST.sums.find(x => x.id === id);
    if (!p) return;
    if (SH.close) SH.close();
    const count = h('span', { class: 'fp2-sh-n' });
    const topic = h('span', { class: 'fp2-sh-tp' });
    const body = h('div', { class: 'fp2-sh-list' });
    Object.assign(QS, { id, pick: p.waiting.length === 1 ? p.waiting[0].id : null, sig: '' });
    QS.render = (cur, list, live, target) => {
      topic.textContent = cur ? cur.topic : '';
      count.textContent = list.length;
      count.classList.toggle('hidden', !list.length);
      const head = !list.length ? h('div', { class: 'dim fp2-sh-empty' }, 'No open questions.')
        : live ? h('div', { class: 'fp2-sh-intro dim' }, 'Pick one to answer. Tasks it blocks wait until it is answered.')
          : h('div', { class: 'fp2-sh-nolive' }, h('i'), h('span', null, h('b', null, 'No live session'), ` runs ${cur.topic}. Answers are saved into the plan instead of sent as a message.`));
      body.replaceChildren(head, ...list.map(w => questionCard(cur, w, live, target)));
    };
    QS.close = sheet({ title: 'Open questions', sub: [topic, count], body, onClose: () => Object.assign(QS, { id: null, pick: null, sig: '', render: null, close: null }) });
    renderQuestions();
    ensureDetail(p);
  }

  function noteSheet({ key, title, topic, p, build, placeholder, intro, goLabel }) {
    const ta = h('textarea', { class: 'fp2-sh-ta fp2-note', rows: 3, placeholder, autocomplete: 'off', autocapitalize: 'sentences', spellcheck: true });
    ta.value = DRAFT[key] || '';
    const pv = h('div', { class: 'fp2-sh-pv' });
    const btn = h('button', { class: 'btn primary fp2-sh-go' }, goLabel ? null : ico('send', 14), goLabel || 'Send');
    const update = () => {
      DRAFT[key] = ta.value;
      const msg = build(ta.value);
      btn.disabled = SENDING.has(key) || !msg;
      if (msg) pv.replaceChildren(h('span', { class: 'fp2-sh-pvl' }, 'Message'), msg);
      else pv.replaceChildren(h('span', { class: 'fp2-sh-over' }, `Too long: ${oneLine(ta.value).length} of ${TEXT_MAX} characters`));
    };
    const go = async () => {
      const msg = build(ta.value);
      if (!msg || SENDING.has(key)) return;
      SENDING.add(key); update();
      const ok = await sendToSession(p, msg);
      SENDING.delete(key);
      if (!ok) { update(); return; }
      delete DRAFT[key];
      close();
    };
    btn.onclick = go;
    ta.addEventListener('input', update);
    ta.addEventListener('keydown', ev => { if (ev.key === 'Escape') return; ev.stopPropagation(); if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); go(); } });
    update();
    requestAnimationFrame(() => { if (ta.isConnected && !isPhone()) ta.focus(); });
    const hint = h('span', { class: 'fp2-sh-hint' }, 'Goes to ', h('b', null, sessLabel(targetOf(p))), ' as a message.');
    const close = sheet({ title, sub: topic ? [h('span', { class: 'fp2-sh-tp' }, topic)] : null, body: h('div', { class: 'fp2-sh-ans fp2-note-b' }, h('div', { class: 'fp2-sh-intro dim' }, intro), ta, pv, ...(goLabel ? [hint, h('div', { class: 'fp2-sh-foot fp2-sh-btns' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), btn)] : [h('div', { class: 'fp2-sh-foot' }, hint, btn)])) });
    return close;
  }

  const openUpdate = p => noteSheet({ key: 'upd|' + p.id, title: 'Edit ' + p.topic, topic: '', p, build: note => updateMsg(p.topic, note), placeholder: 'What should change? (optional)', intro: 'Claude changes the plan in this chat and shows you what changed.', goLabel: 'Send to Claude' });

  const openMake = name => noteSheet({ key: 'make|' + name, title: 'Make a plan', topic: '', p: { sessions: [name] }, build: makeMsg, placeholder: 'What is this plan for? (optional)', intro: 'Claude drafts a plan for this session and waits for your go before starting.' });

  async function planOp(op, p) {
    const key = op + '|' + p.id;
    if (SENDING.has(key)) return null;
    SENDING.add(key);
    try { return (await api(op, { id: p.id })).id; } catch (e) { toast(e.message, 'err'); return null; } finally { SENDING.delete(key); }
  }

  const persistOpen = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(OPEN)); } catch {} };

  async function completePlan(p) {
    const name = TERM.active;
    if (!await planOp('plan-complete', p)) return;
    const own = planFor(ST.sums, name);
    delete VIEW[name];
    for (const k of Object.keys(VIEW)) if (VIEW[k] === p.id) delete VIEW[k];
    EXP.menu = false;
    ARCH.list = null;
    if (!own || own.id === p.id) {
      if (isPhone()) PH.name = null;
      else { delete OPEN[name]; persistOpen(); }
    }
    toast(p.topic + ' completed', 'ok');
    load();
  }

  async function restorePlan(p) {
    const id = await planOp('plan-restore', p);
    if (!id) return;
    APV.restored = id;
    ARCH.list = null;
    toast(p.topic + ' restored', 'ok');
    sync(true);
    load();
  }

  const allDone = p => p.complete || p.finished;

  const stepsOpen = p => {
    const n = p.total - p.done;
    return n > 0 ? `${n} step${n > 1 ? 's' : ''} still open` : '';
  };

  function confirmComplete(p) {
    const close = sheet({ title: `Complete ${p.topic}?`, body: h('div', { class: 'fp2-sh-confirm' },
      h('div', { class: 'fp2-sh-intro' }, 'It moves to Archived. You can open it there and restore it any time.'),
      h('div', { class: 'fp2-sh-foot fp2-sh-btns' },
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn grn', onclick: () => { close(); completePlan(p); } }, 'Complete'))) });
    return close;
  }

  function actionsMenu(p, rerender) {
    const canMake = isLive(TERM.active);
    const open = stepsOpen(p);
    const item = (label, small, on, dis) => h('div', { class: 'mi' + (dis ? ' dis' : ''), role: 'menuitem', onclick: () => { EXP.act = false; rerender(); on(); } }, h('span', { class: 'fp2-mi-t' }, label, small ? h('small', null, small) : null));
    const btn = h('button', { class: 'fp2-x fp2-act-b' + (EXP.act ? ' on' : ''), 'aria-label': 'plan actions', 'aria-expanded': EXP.act ? 'true' : 'false', onclick: () => { EXP.act = !EXP.act; EXP.menu = false; rerender(); } }, ico('dots', 16));
    const menu = EXP.act ? h('div', { class: 'menu fp2-actm', role: 'menu' },
      item('New plan…', canMake ? 'Ask Claude to make a plan' : NOT_LIVE, () => openMake(TERM.active), !canMake),
      p.sessions.includes(TERM.active) ? item('Leave this plan', canMake ? 'This chat stops working on it; the plan stays' : NOT_LIVE, () => sendOnce(TERM.active, leaveMsg(p.topic)), !canMake) : null,
      open ? h('div', { class: 'sep' }) : null,
      open ? item('Complete anyway', open, () => confirmComplete(p)) : null) : null;
    return h('span', { class: 'fp2-act' }, btn, menu);
  }

  function bucketEvents(timeline, phases) {
    const task = {}; const phase = {}; const qTask = {}; const taskPhase = {};
    const st = { created: null, open: [], lastPhase: phases.length ? phases[0].n : null };
    for (const ph of phases) for (const t of ph.tasks) taskPhase[t.id] = ph.n;
    const put = (m, k, e) => { (m[k] = m[k] || []).push(e); };
    for (const e of timeline || []) {
      if (e.type === 'create') { st.created = e; continue; }
      if (e.type === 'archive') continue;
      if (e.type === 'phase') { put(phase, e.phase, e); continue; }
      if (e.type === 'start') st.open.push(e.task);
      if (e.type === 'done' || e.type === 'fail' || e.type === 'undo') st.open = st.open.filter(id => id !== e.task);
      const direct = e.task || (e.q && qTask[e.q]) || null;
      const id = direct || (e.type === 'note' || e.q ? st.open[st.open.length - 1] || null : null);
      if (e.q && !(e.q in qTask)) qTask[e.q] = id;
      if (id && taskPhase[id] !== undefined) { st.lastPhase = taskPhase[id]; put(task, id, e); } else put(phase, st.lastPhase, e);
    }
    return { task, phase, created: st.created };
  }

  const EV_LABEL = { start: 'started', done: 'done', fail: 'failed', note: 'note', ask: 'asked', answer: 'answered', finish: 'finished', reopen: 'reopened', restore: 'restored', undo: 'unticked' };

  const eventText = e => e.type === 'done' || e.type === 'fail' ? (e.gate && e.gate.text) || e.text : e.text;

  function eventLine(e, onOpen) {
    const text = eventText(e);
    return h('button', { class: 'fp2-ev ' + e.type, onclick: onOpen }, h('span', { class: 'fp2-evt' }, clock(e.ts)), h('b', null, EV_LABEL[e.type] || e.type), text ? h('span', { class: 'fp2-evx' }, text) : null);
  }

  const STATUS_LABEL = { todo: 'to do', doing: 'in progress', done: 'done', blocked: 'blocked', failed: 'failed' };
  const waitsOn = t => t.by && t.by.length && t.status !== 'done' ? 'waits on ' + t.by.join(', ') : '';
  const findTask = (d, id) => {
    for (const ph of d.phases) {
      const t = ph.tasks.find(x => x.id === id);
      if (t) return { t, ph };
    }
    return null;
  };

  const detailSection = (label, ...kids) => h('div', { class: 'fp2-dsec' }, h('div', { class: 'fp2-dsh' }, label), ...kids);

  function detailEvent(e) {
    const text = eventText(e);
    return h('div', { class: 'fp2-dev ' + e.type }, h('span', { class: 'fp2-evt' }, clock(e.ts)), h('b', null, EV_LABEL[e.type] || e.type), h('span', { class: 'fp2-dev-x' }, text || ''));
  }

  const detailLog = evs => evs.length ? h('div', { class: 'fp2-dlog' }, evs.map(detailEvent)) : h('div', { class: 'dim fp2-dnone' }, 'Nothing logged yet.');

  function phaseSheet(p, d, n, nav) {
    const ph = d.phases.find(x => x.n === n);
    if (!ph) return null;
    const evs = (bucketEvents(d.timeline, d.phases).phase[n] || []).filter(e => e.type !== 'phase');
    const rows = ph.tasks.map(t => h('button', { class: 'fp2-dtr', onclick: () => nav.task(t.id) },
      taskIcon(t.status), h('span', { class: 'fp2-id' }, t.id),
      h('span', { class: 'fp2-dtr-t' }, t.title, waitsOn(t) ? h('small', null, waitsOn(t)) : null),
      modelChip(t.model), ico('chevronRight', 14)));
    return {
      title: 'Phase ' + n, sub: p.topic,
      body: h('div', { class: 'fp2-dbody' },
        h('div', { class: 'fp2-dtitle' }, h('span', { class: 'fp2-id' }, 'P' + n), ' ', ph.name),
        h('div', { class: 'fp2-dmeta' }, `${ph.done}/${ph.total} tasks done`),
        detailSection('Tasks', h('div', { class: 'fp2-dtrs' }, rows)),
        detailSection('Log', detailLog(evs))),
    };
  }

  function taskSheet(p, d, id, nav) {
    const f = findTask(d, id);
    if (!f) return null;
    const { t, ph } = f;
    const evs = bucketEvents(d.timeline, d.phases).task[id] || [];
    const gateEv = [...evs].reverse().find(e => e.gate);
    const wait = waitsOn(t);
    const gate = t.gate ? detailSection('Gate',
      h('div', { class: 'fp2-dgate ' + (t.gate.ok ? 'ok' : 'bad') }, `${t.gate.ok ? '✓' : '✗'} ${t.gate.text || 'gate'}`),
      gateEv ? h('div', { class: 'fp2-dmeta' }, askedAt(gateEv.ts)) : null) : null;
    return {
      title: 'Task ' + id, sub: p.topic,
      body: h('div', { class: 'fp2-dbody' },
        h('div', { class: 'fp2-dtitle' }, t.title),
        h('div', { class: 'fp2-dmeta' }, taskIcon(t.status), STATUS_LABEL[t.status] || t.status, wait ? ' · ' + wait : '', modelChip(t.model),
          h('button', { class: 'fp2-dlink', onclick: () => nav.phase(ph.n) }, 'P' + ph.n + ' ' + ph.name)),
        gate,
        detailSection('Log', detailLog(evs)),
        detailSection('Task card', t.body ? h('div', { class: 'fp2-body-t' }, t.body) : h('div', { class: 'dim fp2-dnone' }, 'No task card.'))),
    };
  }

  async function openDetail(p, make) {
    if (!DET[p.id] || !DET[p.id].phases) await ensureDetail(p);
    const d = DET[p.id];
    if (!d || !d.phases) return;
    const s = make(d);
    if (s) sheet(s);
  }

  const gateSheet = p => ({
    title: 'Last gate', sub: p.topic,
    body: h('div', { class: 'fp2-dbody' },
      h('div', { class: 'fp2-dgate ' + (p.lastGate.ok ? 'ok' : 'bad') }, `${p.lastGate.ok ? '✓' : '✗'} ${p.lastGate.text || 'gate'}`),
      p.lastGate.at ? h('div', { class: 'fp2-dmeta' }, askedAt(p.lastGate.at)) : null),
  });

  const detailNav = p => ({
    task: id => openDetail(p, d => taskSheet(p, d, id, detailNav(p))),
    phase: n => openDetail(p, d => phaseSheet(p, d, n, detailNav(p))),
  });

  const taskIcon = s => h('span', { class: 'fp2-si ' + s }, s === 'done' ? ico('check', 12) : s === 'failed' ? '!' : s === 'blocked' ? '?' : s === 'doing' ? spin() : null);

  const hintIcon = () => h('span', { class: 'fp2-si todo' }, h('span', { class: 'fp2-hint' }, ico('check', 12)));

  function tickBox(p, t) {
    const pending = TICKING.has(p.id + '|' + t.id);
    const ticked = pending ? t.status !== 'done' : t.status === 'done';
    const icon = ticked ? taskIcon('done') : t.status === 'done' || t.status === 'todo' ? hintIcon() : taskIcon(t.status);
    return h('button', { class: 'fp2-tick' + (pending ? ' busy' : ''), role: 'checkbox', 'aria-checked': String(ticked), 'aria-label': `${ticked ? 'mark not done' : 'mark done'} ${t.id}`, title: ticked ? 'Mark as not done' : 'Mark as done', disabled: pending, onclick: () => pressTick(p, t) }, icon);
  }

  async function pressTick(p, t) {
    const key = p.id + '|' + t.id;
    if (TICKING.has(key)) return;
    TICKING.add(key);
    sync(true);
    try {
      await api('plan-step', { id: p.id, task: t.id, done: t.status !== 'done' });
      STALE.add(p.id);
      await Promise.all([load(), ensureDetail(p)]);
    } catch (e) { toast(e.message, 'err'); }
    TICKING.delete(key);
    sync(true);
  }

  function taskRow(p, t, evs, rerender, nav, readOnly) {
    const key = p.id + '|' + t.id;
    const open = !!EXP.tasks[key];
    const cur = !readOnly && currentId(p) === t.id;
    const isNow = !readOnly && !!p.now && p.now.id === t.id;
    const isNext = !readOnly && !p.finished && !isNow && !!p.next && p.next.id === t.id;
    const steps = isNow ? p.now.steps || [] : [];
    const shown = readOnly ? [] : t.status === 'done' ? open ? evs.filter(e => e.type !== 'start') : [] : evs;
    return h('div', { class: 'fp2-task ' + t.status + (open ? ' open' : '') + (cur ? ' cur' : '') },
      h('div', { class: 'fp2-task-h' },
        readOnly ? taskIcon(t.status) : tickBox(p, t),
        h('button', { class: 'fp2-task-tg', 'aria-expanded': String(open), 'aria-label': `${open ? 'hide' : 'show'} ${t.id} card`, onclick: () => { EXP.tasks[key] = !open; rerender(); } }, h('span', { class: 'fp2-id' }, t.id)),
        h('button', { class: 'fp2-task-t', onclick: () => nav.task(t.id) }, t.title), isNext ? h('span', { class: 'fp2-nx' }, 'next') : null, modelChip(t.model)),
      isNext && p.nextNote ? h('div', { class: 'fp2-qd' }, p.nextNote) : null,
      steps.length ? h('div', { class: 'fp2-steps' }, steps.map(s => h('div', { class: 'fp2-step ' + s.s }, s.s === 'completed' ? ico('check', 13) : s.s === 'in_progress' ? spin() : h('i', { class: 'fp2-pt' }), h('span', null, s.c)))) : null,
      shown.length ? h('div', { class: 'fp2-evs' }, shown.map(e => eventLine(e, () => nav.task(t.id)))) : null,
      open ? h('div', { class: 'fp2-task-b' }, t.body ? h('div', { class: 'fp2-body-t' }, t.body) : h('div', { class: 'dim' }, 'No task card.')) : null);
  }

  const currentId = p => (p.now && p.now.id) || (!p.finished && p.next && p.next.id) || null;

  function steps(p, d, rerender, nav, readOnly) {
    const b = bucketEvents(d.timeline, d.phases);
    const current = currentId(p);
    const wrap = h('div', { class: 'fp2-sec' });
    wrap.append(h('div', { class: 'fp2-sec-h' }, 'Steps', h('span', { class: 'fp2-sp' }), b.created ? h('span', { class: 'dim' }, 'started ' + finishedWhen(b.created.ts)) : null));
    for (const ph of d.phases) {
      const complete = !!ph.total && ph.done >= ph.total;
      const done = complete ? (b.phase[ph.n] || []).filter(e => e.type === 'phase').pop() : null;
      const key = p.id + '|' + ph.n;
      const folded = !readOnly && complete && !ph.tasks.some(t => t.id === current) && !EXP.phases[key];
      const count = h('span', { class: 'dim' }, `${ph.done}/${ph.total}${done ? ' · done ' + clock(done.ts) : ''}`);
      const title = h('button', { class: 'fp2-pn', title: `P${ph.n} ${ph.name}`, onclick: () => nav.phase(ph.n) }, h('span', null, 'P' + ph.n), ' ', h('b', null, ph.name));
      const fold = () => { EXP.phases[key] = folded; rerender(); };
      const foldLabel = `${folded ? 'show' : 'hide'} phase ${ph.n} tasks`;
      const head = complete && !readOnly
        ? h('div', { class: 'fp2-ph-h fold' },
          h('button', { class: 'fp2-ph-tg', 'aria-label': foldLabel, onclick: fold }, taskIcon('done')), title,
          h('button', { class: 'fp2-ph-tg', 'aria-label': foldLabel, onclick: fold }, count, h('span', { class: 'fp2-chev' + (folded ? '' : ' on') }, ico('chevronDown', 14))))
        : h('div', { class: 'fp2-ph-h' }, title, count);
      const evs = readOnly ? [] : (b.phase[ph.n] || []).filter(e => e.type !== 'phase');
      wrap.append(h('div', { class: 'fp2-ph' + (folded ? ' folded' : '') }, head,
        !folded && evs.length ? h('div', { class: 'fp2-evs ph' }, evs.map(e => eventLine(e, () => nav.phase(ph.n)))) : null,
        folded ? null : ph.tasks.map(t => taskRow(p, t, b.task[t.id] || [], rerender, nav, readOnly))));
    }
    return wrap;
  }

  function panelBody(p, rerender, readOnly) {
    const d = DET[p.id] || p;
    const nav = detailNav(p);
    const out = [];
    if (!readOnly && p.waiting.length) out.push(questionsRow(p));
    if (d.phases) out.push(steps(p, d, rerender, nav, readOnly));
    else out.push(h('div', { class: 'dim fp2-load' }, 'loading…'));
    if (d.errors && d.errors.length && d.phases) out.push(h('div', { class: 'fp2-err' }, `${d.errors.length} line${d.errors.length > 1 ? 's' : ''} in plan.md could not be read`));
    return out;
  }

  const archivedRow = (name, p) => h('button', { class: 'fp2-arow', title: planLabel(p), onclick: () => openPreview(name, p) },
    h('span', { class: 'fp2-arow-t' }, h('span', { class: 'fp2-cn' }, p.topic), ' ', h('span', { class: 'fp2-cc' }, `${p.done}/${p.total}`), h('small', null, 'archived ' + dayMonth(p.archived))),
    ico('chevronRight', 14));

  const archivedNote = empty => ARCH.err || (ARCH.list ? empty : 'loading…');

  function archiveKey(name) {
    const projects = S.projects || [];
    const own = planFor(ST.sums, name);
    const first = own || orgPlans(ST.sums, projects, null, sessionProject(name))[0];
    return first ? planGroup(first, projects) : groupKey(projectOf(projects, sessionProject(name)));
  }

  function openArchived(name) {
    const body = h('div', { class: 'fp2-sh-arch' });
    const render = () => {
      const rows = archivedOf(ARCH.list || [], S.projects || [], archiveKey(name));
      body.replaceChildren(...(rows.length ? rows.map(p => archivedRow(name, p)) : [h('div', { class: 'dim fp2-anone' }, archivedNote('No archived plans.'))]));
    };
    render();
    sheet({ title: 'Archived', body, onClose: () => { ARCH.render = null; } });
    ARCH.render = render;
    loadArchived();
  }

  function clearPreview() {
    APV.name = null;
    APV.plan = null;
    APV.restored = null;
  }

  function panelChanged() {
    sync(true);
    if (TERM.open) renderTermPanel();
    window.dispatchEvent(new Event('resize'));
  }

  function openPreview(name, p) {
    if (SH.close) SH.close();
    EXP.menu = false;
    EXP.act = false;
    APV.name = name;
    APV.plan = p;
    APV.restored = null;
    if (!isPhone()) feat('rightOpen', 'plan');
    panelChanged();
  }

  function backToArchived() {
    const name = TERM.active;
    clearPreview();
    panelChanged();
    openArchived(name);
  }

  const pickPlan = id => { VIEW[TERM.active] = id; EXP.menu = false; sync(true); };

  const closeButton = () => h('button', { class: 'fp2-x', 'aria-label': 'close plan', onclick: toggle }, ico('x', 16));

  const planSummary = (p, ...right) => [
    h('div', { class: 'fp2-ptitle' }, planLabel(p)),
    h('div', { class: 'fp2-bar' + (allDone(p) ? ' full' : '') }, h('i', { style: `width:${p.pct}%` })),
    h('div', { class: 'fp2-pmeta' }, h('b', null, `${p.done}/${p.total} steps`), ...right),
  ];

  function planHead(c, rerender) {
    const p = c.shown;
    const nav = detailNav(p);
    const others = c.list.length - 1;
    const live = isLive(targetOf(p));
    const toggleList = () => { EXP.menu = !EXP.menu; EXP.act = false; if (EXP.menu) loadArchived(); rerender(); };
    return [
      h('div', { class: 'fp2-row' },
        h('button', { class: 'fp2-pname' + (EXP.menu ? ' on' : ''), 'aria-expanded': String(EXP.menu), title: planLabel(p), onclick: toggleList }, h('span', { class: 'fp2-ptopic' }, p.topic), h('small', null, `${EXP.menu ? '▴' : '▾'}${others > 0 ? ` +${others}` : ''}`)),
        h('span', { class: 'fp2-sp' }),
        h('button', { class: 'btn fp2-edit' + (live ? '' : ' off'), 'aria-disabled': live ? null : 'true', title: live ? 'Tell Claude what to change' : NOT_LIVE, onclick: () => { if (live) openUpdate(p); else toast(NOT_LIVE, 'err'); } }, ico('pencil', 14), 'Edit plan'),
        actionsMenu(p, rerender),
        closeButton()),
      ...planSummary(p,
        gateChip(p.lastGate, () => { if (p.lastGate.task) nav.task(p.lastGate.task); else sheet(gateSheet(p)); }),
        allDone(p) ? h('span', { class: 'fp2-pstate' }, 'All done')
          : p.phase ? h('button', { class: 'fp2-phase', title: `Phase ${p.phase.n} · ${p.phase.name}`, onclick: () => nav.phase(p.phase.n) }, `Phase ${p.phase.n} of ${p.phase.of}`) : null),
      c.own && c.own.id !== p.id ? h('button', { class: 'fp2-link back', onclick: () => pickPlan(c.own.id) }, '← this session’s plan') : null,
    ];
  }

  const previewHead = p => [
    h('div', { class: 'fp2-row' }, h('button', { class: 'fp2-pname', onclick: backToArchived }, '‹ Archived'), h('span', { class: 'fp2-sp' }), closeButton()),
    h('div', { class: 'fp2-row fp2-pvname' }, h('span', { class: 'fp2-ptopic' }, p.topic), h('span', { class: 'fp2-tag' }, 'read only')),
    ...planSummary(p, h('span', { class: 'fp2-pstate' }, 'Archived ' + dayMonth(p.archived))),
  ];

  const rowStatus = p => {
    const state = p.waiting.length ? 'waiting on you' : p.sessions.length && !p.sessions.includes(TERM.active) ? 'other chat' : p.now ? 'now ' + p.now.id : '';
    return `${p.done}/${p.total}${state ? ' · ' + state : ''}`;
  };

  function planDrop(c) {
    const row = p => {
      const done = allDone(p);
      return h('div', { class: 'fp2-it' + (p.id === c.shown.id ? ' sel' : '') },
        h('button', { class: 'fp2-it-b', title: planLabel(p), onclick: () => pickPlan(p.id) },
          h('span', { class: 'fp2-it-l' + (done ? ' mini' : '') }, h('span', { class: 'fp2-cn' }, c.names[c.list.indexOf(p)]), p.waiting.length ? h('i', { class: 'fp2-wd' }) : null, done ? h('span', { class: 'fp2-tag g' }, 'all done') : h('small', null, rowStatus(p))),
          h('span', { class: 'fp2-bar thin' + (done ? ' full' : '') }, h('i', { style: `width:${p.pct}%` }))),
        done ? h('button', { class: 'fp2-mini', onclick: () => confirmComplete(p) }, 'Complete') : null);
    };
    const others = c.list.filter(p => !(c.own && p.id === c.own.id));
    const archived = ARCH.list ? archivedOf(ARCH.list, S.projects || [], archiveKey(TERM.active)).length : '';
    return h('div', { class: 'fp2-drop' },
      c.own ? [h('div', { class: 'fp2-gh' }, 'This chat'), row(c.own)] : null,
      others.length ? [h('div', { class: 'fp2-gh' }, 'Other plans'), others.map(row)] : null,
      h('div', { class: 'fp2-sepl' }),
      h('button', { class: 'fp2-lk', onclick: () => { EXP.menu = false; sync(true); openArchived(TERM.active); } }, 'Archived', h('span', null, `${archived} ›`)));
  }

  function planFoot(p) {
    const open = stepsOpen(p);
    return open && !allDone(p)
      ? [h('button', { class: 'btn fp2-wide off', disabled: true }, 'Complete plan'), h('div', { class: 'fp2-fnote' }, open)]
      : [h('button', { class: 'btn fp2-wide grn', onclick: () => confirmComplete(p) }, '✓ Complete plan')];
  }

  function panel(phone) {
    const top = h('div', { class: 'fp2-top' });
    const drop = h('div', { class: 'fp2-drop-s' });
    const body = h('div', { class: 'fp2-pbody' });
    const foot = h('div', { class: 'fp2-foot' });
    const rerender = () => {
      const scroll = body.scrollTop;
      const c = PV.ctx;
      const p = c.preview || c.shown;
      const same = PV.shownId === p.id;
      const covered = !c.preview && (EXP.menu || EXP.act);
      PV.shownId = p.id;
      top.replaceChildren(...(c.preview ? previewHead(p) : planHead(c, rerender)).filter(Boolean));
      drop.replaceChildren(...(!c.preview && EXP.menu ? [planDrop(c)] : []));
      body.replaceChildren(...panelBody(p, rerender, !!c.preview));
      foot.replaceChildren(...(c.preview ? [h('button', { class: 'btn fp2-wide', disabled: !!APV.restored, onclick: () => restorePlan(p) }, '↶ Restore this plan')] : planFoot(p)));
      body.classList.toggle('covered', covered);
      foot.classList.toggle('covered', covered);
      body.scrollTop = same ? scroll : 0;
      const cur = body.querySelector('.fp2-task.cur');
      const seen = p.id + '|' + currentId(p);
      if (cur && PV.seen !== seen && !p.waiting.length) { PV.seen = seen; requestAnimationFrame(() => { body.scrollTop += cur.getBoundingClientRect().top - body.getBoundingClientRect().top - 48; }); }
    };
    PV.seen = null;
    PV.rerender = rerender;
    return h('div', { id: 'fp2-panel', class: 'fp2-panel' + (phone ? ' sheet' : '') },
      phone ? h('div', { class: 'fp2-grab' }) : null, top, drop, body, foot);
  }

  function remove(...ids) { for (const id of ids) { const el = document.getElementById(id); if (el) el.remove(); } }

  function teardown() {
    if (SH.close) SH.close();
    remove('fp2-panel', 'fp2-scrim');
    const main = $('.termmain');
    if (main) main.classList.remove('fp2-open');
    ST.sig = '';
  }

  const panelOpen = (name, own, list, phone) => {
    if (APV.plan) return true;
    if (!phone && filesOn()) return false;
    return list.length ? isOpen(name, !!own) : false;
  };

  function termBar(name) {
    if (!enabled() || isPhone()) return null;
    const own = planFor(ST.sums, name);
    if (!own && !claudeOf(name)) return null;
    const list = orgPlans(ST.sums, S.projects || [], own, sessionProject(name));
    if (!own && !list.length) return null;
    const open = panelOpen(name, own, list, false);
    const n = own ? own.waiting.length : 0;
    const title = own ? `Plan — ${planLabel(own)} · ${own.done}/${own.total}${n ? ` · ${n} waiting on you` : ''}` : `Plans in ${orgLabel(S.projects || [], sessionProject(name))} — ${list.length}`;
    return h('button', { class: 'btn sm ghost fp2-btn' + (open ? ' on' : ''), title, 'aria-pressed': open ? 'true' : 'false', onclick: toggle },
      own ? ring(own, 18) : ico('checkSquare', 14), h('span', { class: 'desk' }, 'Plan'),
      h('span', { class: 'fp2-cnt' }, own ? `${own.done}/${own.total}` : String(list.length)));
  }

  function sync(force) {
    renderQuestions();
    const main = $('.termmain');
    const panelEl = () => document.getElementById('fp2-panel');
    if (!enabled() || !main || !TERM.open || !TERM.active) { PH.name = null; clearPreview(); if (panelEl() || SH.close) teardown(); return; }
    const name = TERM.active;
    if (PH.name && PH.name !== name) PH.name = null;
    if (APV.name !== name) clearPreview();
    const own = planFor(ST.sums, name);
    const projects = S.projects || [];
    const projectId = sessionProject(name);
    const list = orgPlans(ST.sums, projects, own, projectId);
    if (!own && !claudeOf(name)) { PH.name = null; clearPreview(); if (panelEl() || SH.close) teardown(); return; }
    if (APV.restored && ST.sums.some(x => x.id === APV.restored)) {
      VIEW[name] = APV.restored;
      if (list.some(x => x.id === APV.restored)) {
        if (isPhone()) PH.name = name;
        else { OPEN[name] = true; persistOpen(); feat('rightOpen', 'plan'); }
      }
      clearPreview();
    }
    const shown = list.find(x => x.id === VIEW[name]) || own || list[0] || null;
    const names = planNames(list, projects);
    const phone = isPhone();
    if (phone && !list.length) PH.name = null;
    const preview = APV.plan;
    const filesWin = !phone && !preview && filesOn();
    if (filesWin && OPEN[name]) { OPEN[name] = false; persistOpen(); }
    const open = panelOpen(name, own, list, phone);
    const bar = $('#term-bar');
    if (bar && !phone) main.style.setProperty('--fp2-top', (bar.offsetTop + bar.offsetHeight) + 'px');
    const current = preview || shown;
    const dm = current && DET[current.id] ? DET[current.id].mtime : 0;
    const sig = JSON.stringify([name, own, list, names, shown && shown.id, preview && preview.id, APV.restored, dm, current && STALE.has(current.id), open, phone, EXP, current && isLive(targetOf(current))]);
    if (sig === ST.sig && !force) return;
    ST.sig = sig;
    main.classList.toggle('fp2-open', open && !phone);
    const old = document.getElementById('fp2-panel');
    if (!open) { remove('fp2-panel', 'fp2-scrim'); return; }
    PV.ctx = { own, list, names, shown, preview };
    if (old && PV.phone === phone) PV.rerender();
    else {
      remove('fp2-panel', 'fp2-scrim');
      const el = panel(phone);
      PV.rerender();
      if (phone) document.body.append(h('div', { id: 'fp2-scrim', class: 'fp2-scrim', onclick: toggle }), el); else main.append(el);
      PV.phone = phone;
    }
    ensureDetail(current);
  }

  function toggle() {
    const name = TERM.active; if (!name) return;
    EXP.menu = false;
    EXP.act = false;
    const own = planFor(ST.sums, name);
    const wasPreview = !!APV.plan;
    clearPreview();
    if (wasPreview && !(orgPlans(ST.sums, S.projects || [], own, sessionProject(name)).length && isOpen(name, !!own))) { panelChanged(); return; }
    if (isPhone()) PH.name = PH.name === name ? null : name;
    else {
      OPEN[name] = !isOpen(name, !!own);
      persistOpen();
      if (OPEN[name]) feat('rightOpen', 'plan');
    }
    panelChanged();
  }

  const filesOn = () => !!(FEAT.code && FEAT.code.filesOn && FEAT.code.filesOn());

  function rightOpen(which) {
    const name = TERM.active;
    if (which === 'plan' || !name || isPhone() || !enabled()) return;
    const hadPreview = !!APV.plan;
    clearPreview();
    if (hadPreview || isOpen(name, !!planFor(ST.sums, name))) {
      OPEN[name] = false;
      persistOpen();
      panelChanged();
    }
  }

  function onState() {
    const on = enabled();
    if (!on) { ST.was = false; if (document.getElementById('fp2-panel')) teardown(); return; }
    const key = ((S.runtime && S.runtime.sessions) || []).map(x => x.name + '@' + (x.cwd || '')).join('|');
    if (!ST.was || key !== ST.skey) { ST.was = true; ST.skey = key; load(); }
    sync();
  }

  function termShown() { sync(); }

  function termBarKey() {
    if (!enabled()) return null;
    const sums = ST.sums.map(p => [p.id, p.pct, p.done, p.total, p.waiting.length, p.sessions.join(',')].join(':')).join('|');
    const name = TERM.active;
    const own = name ? planFor(ST.sums, name) : null;
    return [sums, name && !isPhone() && panelOpen(name, own, name ? orgPlans(ST.sums, S.projects || [], own, sessionProject(name)) : [], false)].join('#');
  }

  function termItem(name) {
    if (!enabled()) return null;
    const p = planFor(ST.sums, name);
    return p ? h('span', { class: 'fp2-rail', title: `${planLabel(p)} — ${p.done}/${p.total}${p.waiting.length ? ' · waiting on you' : ''}` }, ring(p, 26)) : null;
  }

  function live() { load(); }

  function sessMenu(name, sess, cl) {
    if (!enabled() || !cl) return null;
    const own = planFor(ST.sums, name);
    if (own) {
      if (!isPhone()) return null;
      const n = own.waiting.length;
      return { label: `Plan · ${own.topic} ${own.done}/${own.total}`, sub: n ? `${n} open question${n > 1 ? 's' : ''}` : '', icon: ico('checkSquare', 15), onclick: () => { if (PH.name !== name) toggle(); } };
    }
    const offer = offerFor(ST.sums, name);
    const can = isLive(name);
    const hint = can ? '' : NOT_LIVE;
    const projects = S.projects || [];
    const projectId = sessionProject(name);
    const others = orgPlans(ST.sums, projects, null, projectId);
    return [
      { label: 'Make a plan…', sub: hint, icon: ico('plus', 15), disabled: !can, onclick: () => openMake(name) },
      others.length ? { label: `${others.length} in ${orgLabel(projects, projectId)}…`, icon: ico('checkSquare', 15), onclick: () => { if (!panelOpen(name, null, others, isPhone())) toggle(); } } : null,
      offer ? { label: `Continue ${offer.topic}`, sub: hint, icon: ico('play', 15), disabled: !can, onclick: () => sendOnce(name, continueMsg(offer.topic)) } : null,
      { label: 'Archived plans…', icon: ico('archive', 15), onclick: () => openArchived(name) },
    ].filter(Boolean);
  }

  function cardChips(proj) {
    if (!enabled()) return null;
    const l = ST.sums.filter(p => !p.archived && p.projectId === proj.id);
    if (!l.length) return null;
    const t = l[0];
    const label = `${planLabel(t)} ${t.done}/${t.total}`;
    const sess = t.sessions[0];
    const attrs = sess
      ? { class: 'fp-chip' + (t.complete ? ' done' : ''), title: label, onclick: ev => { ev.stopPropagation(); openTerm(sess); } }
      : { class: 'fp-chip static' + (t.complete ? ' done' : ''), title: label + ' — no session is on this plan' };
    return h(sess ? 'button' : 'div', attrs,
      h('span', { class: 'fp-chip-top' }, h('span', { class: 'fp-ck' }, '☑'), h('span', { class: 'fp-chip-t' }, t.topic), h('span', { class: 'fp-chip-n' }, `${t.done}/${t.total}`), l.length > 1 ? h('span', { class: 'fp-chip-more' }, '+' + (l.length - 1)) : null),
      h('div', { class: 'fp-bar' + (t.complete ? ' full' : '') }, h('i', { style: `width:${t.pct}%` })));
  }

  document.addEventListener('click', ev => {
    const outside = sel => !(ev.target.closest && ev.target.closest(sel));
    const act = EXP.act && outside('.fp2-act');
    const menu = EXP.menu && outside('.fp2-drop') && outside('.fp2-pname');
    if (!act && !menu) return;
    if (act) EXP.act = false;
    if (menu) EXP.menu = false;
    if (PV.rerender && document.getElementById('fp2-panel')) PV.rerender();
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  addEventListener('resize', () => sync());

  FEAT.plan2 = { rightOpen, onState, termShown, termBar, termBarKey, termItem, plan: onPlan, live, cardChips, sessMenu, planFor, readOpen, ringMarkup, bucketEvents, orgPlans, planNames, answerMsg, updateMsg, makeMsg, continueMsg, leaveMsg, finishedWhen, openMake, actionsMenu, questionsRow, sheet, sendToSession, saveAnswer, phaseSheet, taskSheet, archivedOf };
})();
