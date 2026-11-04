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
  const EXP = { tasks: {}, phases: {}, menu: false, act: false };
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
  const clock = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const dayMonth = ts => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
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
    ST.timer = setTimeout(() => { load(); if (EXP.menu || ARCH.render) loadArchived(); }, 150);
  }

  async function loadArchived() {
    ARCH.seq += 1;
    const seq = ARCH.seq;
    try {
      const d = await api('plans?v=2&archived=1');
      if (seq !== ARCH.seq) return;
      ARCH.list = d.plans || [];
      ARCH.err = '';
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

  function strip(p, open) {
    const meta = [];
    if (p.phase) meta.push(h('span', { class: 'fp2-meta' }, 'Phase ', h('b', null, `${p.phase.n}/${p.phase.of}`)));
    meta.push(h('span', { class: 'fp2-meta' }, h('b', null, `${p.done}/${p.total}`)));
    const focus = p.now ? ['now: ', p.now.id, p.now.title] : p.next ? ['next: ', p.next.id, p.next.title] : p.complete ? ['all tasks done'] : null;
    return h('button', { class: 'fp2-strip-b', title: 'Plan — ' + planLabel(p), onclick: toggle },
      ring(p, 26), h('span', { class: 'fp2-name' }, p.topic), ...meta,
      p.waiting.length ? h('span', { class: 'fp2-wait' }, h('i'), `${p.waiting.length} waiting on you`) : null,
      focus ? h('span', { class: 'fp2-now' }, focus[0], focus[1] ? h('b', null, focus[1]) : null, focus[2] ? ' ' + focus[2] : null) : null,
      h('span', { class: 'fp2-chev' + (open ? ' on' : '') }, ico('chevronDown', 15)));
  }

  const gateChip = (g, onOpen) => g ? h('button', { class: 'fp2-gate ' + (g.ok ? 'ok' : 'bad'), title: ['last gate', g.task, g.text, g.at ? clock(g.at) : ''].filter(Boolean).join(' · '), onclick: onOpen }, `${g.ok ? '✓' : '✗'} ${g.text || 'gate'}`) : null;
  const modelChip = m => m ? h('span', { class: 'fp2-model' }, m) : null;
  const spin = () => h('span', { class: 'fp2-spin' });

  const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
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

  function noteSheet({ key, title, topic, p, build, placeholder, intro }) {
    const ta = h('textarea', { class: 'fp2-sh-ta fp2-note', rows: 3, placeholder, autocomplete: 'off', autocapitalize: 'sentences', spellcheck: true });
    ta.value = DRAFT[key] || '';
    const pv = h('div', { class: 'fp2-sh-pv' });
    const btn = h('button', { class: 'btn primary fp2-sh-go' }, ico('send', 14), 'Send');
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
    const close = sheet({ title, sub: topic ? [h('span', { class: 'fp2-sh-tp' }, topic)] : null, body: h('div', { class: 'fp2-sh-ans fp2-note-b' }, h('div', { class: 'fp2-sh-intro dim' }, intro), ta, pv, h('div', { class: 'fp2-sh-foot' }, hint, btn)) });
    return close;
  }

  const openUpdate = p => noteSheet({ key: 'upd|' + p.id, title: 'Update plan', topic: p.topic, p, build: note => updateMsg(p.topic, note), placeholder: 'What should change? (optional)', intro: 'Claude edits the plan with the plan CLI. Add a note if you want a specific change.' });

  const openMake = name => noteSheet({ key: 'make|' + name, title: 'Make a plan', topic: '', p: { sessions: [name] }, build: makeMsg, placeholder: 'What is this plan for? (optional)', intro: 'Claude drafts a plan for this session and waits for your go before starting.' });

  async function planOp(op, p) {
    const key = op + '|' + p.id;
    if (SENDING.has(key)) return null;
    SENDING.add(key);
    try { return (await api(op, { id: p.id })).id; } catch (e) { toast(e.message, 'err'); return null; } finally { SENDING.delete(key); }
  }

  const LIFECYCLE = {
    async finish(p) {
      if (!await planOp('plan-finish', p)) return;
      toast(p.topic + ' marked finished', 'ok');
      load();
    },
    async archive(p) {
      if (!await planOp('plan-archive', p)) return;
      for (const name of Object.keys(VIEW)) if (VIEW[name] === p.id) delete VIEW[name];
      ARCH.list = null;
      toast(p.topic + ' archived', 'ok');
      load();
    },
    async restore(p) {
      const id = await planOp('plan-restore', p);
      if (!id) return;
      VIEW[TERM.active] = id;
      EXP.menu = false;
      ARCH.list = null;
      if (ARCH.render) SH.close();
      toast(p.topic + ' restored', 'ok');
      sync(true);
      load();
    },
  };

  const openTasks = p => {
    const n = p.total - p.done;
    return n > 0 ? `${n} task${n > 1 ? 's' : ''} still open` : '';
  };

  function confirmSheet({ title, text, action, run }) {
    const close = sheet({ title, body: h('div', { class: 'fp2-sh-confirm' },
      text ? h('div', { class: 'fp2-sh-intro' }, text) : null,
      h('div', { class: 'fp2-sh-foot fp2-sh-btns' },
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { close(); run(); } }, action))) });
    return close;
  }

  const confirmFinish = p => confirmSheet({ title: `Mark ${p.topic} as finished?`, text: openTasks(p) && openTasks(p) + '.', action: 'Mark finished', run: () => LIFECYCLE.finish(p) });

  const confirmArchive = p => confirmSheet({ title: `Archive ${p.topic}?`, text: 'It disappears from the panel. You can restore it from the plan list.', action: 'Archive', run: () => LIFECYCLE.archive(p) });

  function actionsMenu(p, rerender) {
    const target = targetOf(p);
    const live = isLive(target);
    const canMake = isLive(TERM.active);
    const item = (icon, label, small, on, dis) => h('div', { class: 'mi' + (dis ? ' dis' : ''), role: 'menuitem', onclick: () => { EXP.act = false; rerender(); on(); } }, ico(icon, 16), h('span', { class: 'fp2-mi-t' }, label, small ? h('small', null, small) : null));
    const btn = h('button', { class: 'fp2-x fp2-act-b' + (EXP.act ? ' on' : ''), 'aria-label': 'plan actions', 'aria-expanded': EXP.act ? 'true' : 'false', onclick: () => { EXP.act = !EXP.act; rerender(); } }, ico('dots', 16));
    const menu = EXP.act ? h('div', { class: 'menu fp2-actm', role: 'menu' },
      item('pencil', 'Update plan…', live ? 'Tell Claude what to change' : NOT_LIVE, () => openUpdate(p), !live),
      item('plus', 'New plan…', canMake ? 'Ask Claude to make a plan' : NOT_LIVE, () => openMake(TERM.active), !canMake),
      p.finished ? null : item('check', 'Mark finished', openTasks(p), () => confirmFinish(p)),
      h('div', { class: 'sep' }),
      item('archive', 'Archive', 'Hide it; restore any time from the plan list', () => confirmArchive(p))) : null;
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
      if (e.type === 'done' || e.type === 'fail') st.open = st.open.filter(id => id !== e.task);
      const direct = e.task || (e.q && qTask[e.q]) || null;
      const id = direct || (e.type === 'note' || e.q ? st.open[st.open.length - 1] || null : null);
      if (e.q && !(e.q in qTask)) qTask[e.q] = id;
      if (id && taskPhase[id] !== undefined) { st.lastPhase = taskPhase[id]; put(task, id, e); } else put(phase, st.lastPhase, e);
    }
    return { task, phase, created: st.created };
  }

  const EV_LABEL = { start: 'started', done: 'done', fail: 'failed', note: 'note', ask: 'asked', answer: 'answered', finish: 'finished', reopen: 'reopened', restore: 'restored' };

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

  function taskRow(p, t, evs, rerender, nav) {
    const key = p.id + '|' + t.id;
    const open = !!EXP.tasks[key];
    const isNext = !!(p.next && p.next.id === t.id);
    const steps = p.now && p.now.id === t.id ? p.now.steps || [] : [];
    const shown = t.status === 'done' ? open ? evs.filter(e => e.type !== 'start') : [] : evs;
    const cur = currentId(p) === t.id;
    return h('div', { class: 'fp2-task ' + t.status + (open ? ' open' : '') + (cur ? ' cur' : '') },
      h('div', { class: 'fp2-task-h' },
        h('button', { class: 'fp2-task-tg', 'aria-expanded': String(open), 'aria-label': `${open ? 'hide' : 'show'} ${t.id} card`, onclick: () => { EXP.tasks[key] = !open; rerender(); } }, taskIcon(t.status), h('span', { class: 'fp2-id' }, t.id)),
        h('button', { class: 'fp2-task-t', onclick: () => nav.task(t.id) }, t.title), isNext ? h('span', { class: 'fp2-nx' }, 'next') : null, modelChip(t.model)),
      isNext && p.nextNote ? h('div', { class: 'fp2-qd' }, p.nextNote) : null,
      steps.length ? h('div', { class: 'fp2-steps' }, steps.map(s => h('div', { class: 'fp2-step ' + s.s }, s.s === 'completed' ? ico('check', 13) : s.s === 'in_progress' ? spin() : h('i', { class: 'fp2-pt' }), h('span', null, s.c)))) : null,
      shown.length ? h('div', { class: 'fp2-evs' }, shown.map(e => eventLine(e, () => nav.task(t.id)))) : null,
      open ? h('div', { class: 'fp2-task-b' }, t.body ? h('div', { class: 'fp2-body-t' }, t.body) : h('div', { class: 'dim' }, 'No task card.')) : null);
  }

  const currentId = p => (p.now && p.now.id) || (p.next && p.next.id) || null;

  function steps(p, d, rerender, nav) {
    const b = bucketEvents(d.timeline, d.phases);
    const wrap = h('div', { class: 'fp2-sec' });
    wrap.append(h('div', { class: 'fp2-sec-h' }, 'Steps', h('span', { class: 'fp2-sp' }), b.created ? h('span', { class: 'dim' }, 'started ' + clock(b.created.ts)) : null));
    for (const ph of d.phases) {
      const complete = !!ph.total && ph.done >= ph.total;
      const done = complete ? (b.phase[ph.n] || []).filter(e => e.type === 'phase').pop() : null;
      const key = p.id + '|' + ph.n;
      const folded = complete && !ph.tasks.some(t => t.id === currentId(p)) && !EXP.phases[key];
      const count = h('span', { class: 'dim' }, `${ph.done}/${ph.total}${done ? ' · done ' + clock(done.ts) : ''}`);
      const title = h('button', { class: 'fp2-pn', title: `P${ph.n} ${ph.name}`, onclick: () => nav.phase(ph.n) }, h('span', null, 'P' + ph.n), ' ', h('b', null, ph.name));
      const fold = () => { EXP.phases[key] = folded; rerender(); };
      const foldLabel = `${folded ? 'show' : 'hide'} phase ${ph.n} tasks`;
      const head = complete
        ? h('div', { class: 'fp2-ph-h fold' },
          h('button', { class: 'fp2-ph-tg', 'aria-label': foldLabel, onclick: fold }, taskIcon('done')), title,
          h('button', { class: 'fp2-ph-tg', 'aria-label': foldLabel, onclick: fold }, count, h('span', { class: 'fp2-chev' + (folded ? '' : ' on') }, ico('chevronDown', 14))))
        : h('div', { class: 'fp2-ph-h' }, title, count);
      const evs = (b.phase[ph.n] || []).filter(e => e.type !== 'phase');
      wrap.append(h('div', { class: 'fp2-ph' + (folded ? ' folded' : '') }, head,
        folded ? null : evs.length ? h('div', { class: 'fp2-evs ph' }, evs.map(e => eventLine(e, () => nav.phase(ph.n)))) : null,
        folded ? null : ph.tasks.map(t => taskRow(p, t, b.task[t.id] || [], rerender, nav))));
    }
    return wrap;
  }

  const finishedBadge = small => h('span', { class: 'fp2-badge' + (small ? ' sm' : '') }, small ? null : ico('check', 12), 'Finished');

  function finishedRow(p) {
    return h('div', { class: 'fp2-fin' },
      h('span', { class: 'fp2-fin-t' }, h('b', null, 'Finished'), p.finishedAt ? ` ${clock(p.finishedAt)}.` : null),
      h('button', { class: 'btn sm', onclick: () => confirmArchive(p) }, ico('archive', 15), 'Archive'));
  }

  function panelBody(p, rerender) {
    const d = DET[p.id] || p;
    const nav = detailNav(p);
    const out = [];
    out.push(h('div', { class: 'fp2-head' },
      h('span', { class: 'fp2-big' }, h('b', null, p.done), '/' + p.total),
      h('span', { class: 'dim fp2-pct' }, p.pct + '%'),
      p.phase ? h('button', { class: 'fp2-phase', title: `P${p.phase.n} ${p.phase.name}`, onclick: () => nav.phase(p.phase.n) }, 'P', h('b', null, `${p.phase.n}/${p.phase.of}`), ' ', p.phase.name) : null,
      gateChip(p.lastGate, () => { if (p.lastGate.task) nav.task(p.lastGate.task); else sheet(gateSheet(p)); })));
    out.push(h('div', { class: 'fp2-bar' + (p.complete ? ' full' : '') }, h('i', { style: `width:${p.pct}%` })));
    if (p.finished) out.push(finishedRow(p));
    if (p.waiting.length) out.push(questionsRow(p));
    if (d.phases) out.push(steps(p, d, rerender, nav));
    else out.push(h('div', { class: 'dim fp2-load' }, 'loading…'));
    if (d.errors && d.errors.length && d.phases) out.push(h('div', { class: 'fp2-err' }, `${d.errors.length} line${d.errors.length > 1 ? 's' : ''} in plan.md could not be read`));
    return out;
  }

  const archivedRow = p => h('div', { class: 'fp2-arow' },
    h('span', { class: 'fp2-arow-t', title: planLabel(p) }, h('span', { class: 'fp2-cn' }, p.topic), ' ', h('span', { class: 'fp2-cc' }, `${p.done}/${p.total}`), h('small', null, 'archived ' + dayMonth(p.archived))),
    h('button', { class: 'btn sm', onclick: () => LIFECYCLE.restore(p) }, ico('undo', 14), 'Restore'));

  const archivedNote = empty => ARCH.err || (ARCH.list ? empty : 'loading…');

  function archivedGroup(rows) {
    const note = rows.length ? '' : archivedNote('No archived plans');
    return [h('div', { class: 'mh' }, rows.length ? `Archived · ${rows.length}` : 'Archived'), note ? h('div', { class: 'dim fp2-anone' }, note) : null, rows.map(archivedRow)];
  }

  function openArchived(name) {
    const body = h('div', { class: 'fp2-sh-arch' });
    const render = () => {
      const projects = S.projects || [];
      const rows = archivedOf(ARCH.list || [], projects, groupKey(projectOf(projects, sessionProject(name))));
      body.replaceChildren(...(rows.length ? rows.map(archivedRow) : [h('div', { class: 'dim fp2-anone' }, archivedNote('No archived plans.'))]));
    };
    render();
    sheet({ title: 'Archived', body, onClose: () => { ARCH.render = null; } });
    ARCH.render = render;
    loadArchived();
  }

  function switcher(list, names, shownId, ownId, rerender) {
    if (!list.length) return null;
    const phone = isPhone();
    const pick = id => { VIEW[TERM.active] = id; EXP.menu = false; sync(true); };
    const inner = (p, i) => [p.id === ownId ? h('i', { class: 'fp2-own' }) : null, h('span', { class: 'fp2-cn' }, names[i]), h('span', { class: 'fp2-cc' }, `${p.done}/${p.total}`), p.waiting.length ? h('i', { class: 'fp2-wdot' }) : null];
    const item = (p, i, badge) => h('button', { class: 'fp2-chip' + (p.id === shownId ? ' on' : ''), title: planLabel(p) + (p.id === ownId ? ' — this session' : ''), onclick: () => pick(p.id) }, ...inner(p, i), badge && p.finished ? finishedBadge(true) : null);
    const toggleMenu = () => { EXP.menu = !EXP.menu; if (EXP.menu) loadArchived(); rerender(); };
    const rows = archivedOf(ARCH.list || [], S.projects || [], planGroup(list[0], S.projects || []));
    const cur = list.findIndex(p => p.id === shownId);
    const back = ownId && shownId !== ownId ? h('button', { class: 'fp2-link back', onclick: () => pick(ownId) }, '← this session’s plan') : null;
    const archChip = phone ? null : h('span', { class: 'fp2-archw' },
      h('button', { class: 'fp2-chip fp2-archc' + (EXP.menu ? ' on' : ''), 'aria-expanded': EXP.menu ? 'true' : 'false', onclick: toggleMenu }, ico('archive', 14), h('span', { class: 'fp2-cn' }, 'Archived'), rows.length ? h('span', { class: 'fp2-cc' }, rows.length) : null, ico('chevronDown', 14)),
      EXP.menu ? h('div', { class: 'fp2-menu-l fp2-aml' }, archivedGroup(rows)) : null);
    const menu = h('div', { class: 'fp2-menu' + (EXP.menu ? ' open' : '') },
      h('button', { class: 'fp2-menu-b', onclick: toggleMenu }, ...inner(list[cur], cur), h('span', { class: 'fp2-menu-n' }, `${list.length} plan${list.length > 1 ? 's' : ''}`), ico('chevronDown', 14)),
      EXP.menu && phone ? h('div', { class: 'fp2-menu-l fp2-aml' }, h('div', { class: 'mh' }, 'This org'), list.map((p, i) => item(p, i, true)), h('div', { class: 'sep' }), archivedGroup(rows)) : null);
    return h('div', { class: 'fp2-swi' }, h('div', { class: 'fp2-chips' }, list.map((p, i) => item(p, i)), archChip), menu, back);
  }

  function panel(phone) {
    const body = h('div', { class: 'fp2-pbody' });
    const sw = h('div', { class: 'fp2-sw' });
    const topic = h('span', { class: 'fp2-ptopic' });
    const act = h('span', { class: 'fp2-act-h' });
    const badge = h('span', { class: 'fp2-badge-h' });
    const rerender = () => {
      const top = body.scrollTop;
      const c = PV.ctx;
      const same = PV.shownId === c.shown.id;
      PV.shownId = c.shown.id;
      topic.textContent = c.shown.topic;
      badge.replaceChildren(...(c.shown.finished ? [finishedBadge()] : []));
      act.replaceChildren(actionsMenu(c.shown, rerender));
      sw.replaceChildren(...[switcher(c.list, c.names, c.shown.id, c.own && c.own.id, rerender)].filter(Boolean));
      body.replaceChildren(...panelBody(c.shown, rerender));
      body.scrollTop = same ? top : 0;
      const cur = body.querySelector('.fp2-task.cur');
      const seen = c.shown.id + '|' + currentId(c.shown);
      if (cur && PV.seen !== seen) { PV.seen = seen; requestAnimationFrame(() => { body.scrollTop += cur.getBoundingClientRect().top - body.getBoundingClientRect().top - 48; }); }
    };
    PV.seen = null;
    PV.rerender = rerender;
    return h('div', { id: 'fp2-panel', class: 'fp2-panel' + (phone ? ' sheet' : '') },
      phone ? h('div', { class: 'fp2-grab' }) : null,
      h('div', { class: 'fp2-ph-top' }, h('b', null, 'Plan'), topic, badge, h('span', { class: 'fp2-sp' }), act, h('button', { class: 'fp2-x', 'aria-label': 'close plan', onclick: toggle }, ico('x', 16))),
      sw, body);
  }

  function remove(...ids) { for (const id of ids) { const el = document.getElementById(id); if (el) el.remove(); } }

  function teardown() {
    if (SH.close) SH.close();
    remove('fp2-strip', 'fp2-panel', 'fp2-scrim');
    const main = $('.termmain');
    if (main) main.classList.remove('fp2-open');
    ST.sig = '';
  }

  function quietStrip(name, list, org, open) {
    const can = isLive(name);
    return h('div', { class: 'fp2-strip-b quiet fp2-np' + (can ? '' : ' off') },
      h('span', { class: 'fp2-nop' }, 'No plan'), h('span', { class: 'fp2-nop' }, '·'),
      h('button', { class: 'fp2-np-b', disabled: !can, title: can ? 'Ask Claude to make a plan' : null, onclick: () => openMake(name) }, 'Make a plan…'),
      can ? null : h('span', { class: 'fp2-np-hint' }, NOT_LIVE),
      h('button', { class: 'fp2-np-arch', onclick: () => openArchived(name) }, 'Archived'),
      list.length ? h('button', { class: 'fp2-np-org', title: 'Plans in ' + org, onclick: toggle }, h('span', { class: 'fp2-nop' }, `${list.length} in ${org}`), h('span', { class: 'fp2-chev' + (open ? ' on' : '') }, ico('chevronDown', 15))) : null);
  }

  function sync(force) {
    renderQuestions();
    const main = $('.termmain');
    const stripEl = () => document.getElementById('fp2-strip') || document.getElementById('fp2-panel');
    if (!enabled() || !main || !TERM.open || !TERM.active) { if (stripEl()) teardown(); return; }
    const name = TERM.active;
    if (PH.name && PH.name !== name) PH.name = null;
    const own = planFor(ST.sums, name);
    const projects = S.projects || [];
    const projectId = sessionProject(name);
    const list = orgPlans(ST.sums, projects, own, projectId);
    if (!own && !claudeOf(name)) { if (stripEl()) teardown(); return; }
    const shown = list.find(x => x.id === VIEW[name]) || own || list[0] || null;
    const names = planNames(list, projects);
    const phone = isPhone();
    const open = list.length ? isOpen(name, !!own) : false;
    const org = own ? '' : orgLabel(projects, projectId);
    const found = document.getElementById('fp2-strip');
    const st = found || h('div', { id: 'fp2-strip', class: 'fp2-strip' });
    if (!found) { const bar = $('#term-bar'); if (bar) bar.after(st); else main.prepend(st); force = true; }
    main.style.setProperty('--fp2-top', (st.offsetTop + st.offsetHeight) + 'px');
    const dm = shown && DET[shown.id] ? DET[shown.id].mtime : 0;
    const sig = JSON.stringify([name, own, org, list, names, shown && shown.id, dm, shown && STALE.has(shown.id), open, phone, EXP, !own && isLive(name)]);
    if (sig === ST.sig && !force) return;
    ST.sig = sig;
    st.replaceChildren(own ? strip(own, open) : quietStrip(name, list, org, open));
    main.classList.toggle('fp2-open', open && !phone);
    const old = document.getElementById('fp2-panel');
    if (!open) { remove('fp2-panel', 'fp2-scrim'); return; }
    PV.ctx = { own, list, names, shown };
    if (old && PV.phone === phone) PV.rerender();
    else {
      remove('fp2-panel', 'fp2-scrim');
      const el = panel(phone);
      PV.rerender();
      if (phone) document.body.append(h('div', { id: 'fp2-scrim', class: 'fp2-scrim', onclick: toggle }), el); else main.append(el);
      PV.phone = phone;
    }
    ensureDetail(shown);
  }

  function toggle() {
    const name = TERM.active; if (!name) return;
    EXP.menu = false;
    EXP.act = false;
    if (isPhone()) PH.name = PH.name === name ? null : name;
    else {
      OPEN[name] = !isOpen(name, !!planFor(ST.sums, name));
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(OPEN)); } catch {}
    }
    sync(true);
    window.dispatchEvent(new Event('resize'));
  }

  function onState() {
    const on = enabled();
    if (!on) { ST.was = false; if (document.getElementById('fp2-strip')) teardown(); return; }
    const key = ((S.runtime && S.runtime.sessions) || []).map(x => x.name + '@' + (x.cwd || '')).join('|');
    if (!ST.was || key !== ST.skey) { ST.was = true; ST.skey = key; load(); }
    sync();
  }

  function termShown() { sync(); }

  function termBarKey() {
    if (!enabled()) return null;
    return ST.sums.map(p => [p.id, p.pct, p.waiting.length, p.sessions.join(',')].join(':')).join('|');
  }

  function termItem(name) {
    if (!enabled()) return null;
    const p = planFor(ST.sums, name);
    return p ? h('span', { class: 'fp2-rail', title: `${planLabel(p)} — ${p.done}/${p.total}${p.waiting.length ? ' · waiting on you' : ''}` }, ring(p, 26)) : null;
  }

  function live() { load(); }

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
    const menu = EXP.menu && outside('.fp2-swi');
    if (!act && !menu) return;
    if (act) EXP.act = false;
    if (menu) EXP.menu = false;
    if (PV.rerender && document.getElementById('fp2-panel')) PV.rerender();
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  addEventListener('resize', () => sync());

  FEAT.plan2 = { onState, termShown, termBarKey, termItem, plan: onPlan, live, cardChips, planFor, readOpen, ringMarkup, bucketEvents, orgPlans, planNames, answerMsg, updateMsg, makeMsg, openMake, actionsMenu, quietStrip, questionsRow, sheet, sendToSession, saveAnswer, phaseSheet, taskSheet, archivedOf };
})();
