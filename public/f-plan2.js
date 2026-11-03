'use strict';
(() => {
  const OPEN_KEY = 'bd.plan2.open';
  const readOpen = () => {
    try {
      const v = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  };
  const OPEN = readOpen();
  const EXP = { q: {}, tasks: {}, phases: {}, menu: false };
  const PV = { phone: false, ctx: null, rerender: null, seen: null };
  const VIEW = {};
  const PH = { name: null };
  const ST = { sums: [], busy: false, again: false, sig: '', skey: null, was: false, timer: 0 };
  const DET = {};
  const STALE = new Set();
  const FETCHING = new Set();
  const RING_R = 11;
  const RING_C = 2 * Math.PI * RING_R;

  const enabled = () => !!(S.settings && S.settings.plans);
  const isPhone = () => matchMedia('(max-width: 900px)').matches;
  const planFor = (sums, name) => sums.find(p => !p.archived && p.sessions.includes(name)) || null;
  const clock = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
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
  const orgLabel = (projects, projectId) => { const pr = projectOf(projects, projectId); return pr ? pr.org || pr.name : ''; };
  const isOpen = (name, hasOwn) => isPhone() ? PH.name === name : name in OPEN ? !!OPEN[name] : hasOwn;

  async function load() {
    if (!enabled()) return;
    if (ST.busy) { ST.again = true; return; }
    ST.busy = true;
    try {
      const d = await api('plans?v=2');
      ST.sums = d.plans || [];
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
    ST.timer = setTimeout(load, 150);
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

  const gateChip = g => g ? h('span', { class: 'fp2-gate ' + (g.ok ? 'ok' : 'bad'), title: ['last gate', g.task, g.text, g.at ? clock(g.at) : ''].filter(Boolean).join(' · ') }, `${g.ok ? '✓' : '✗'} ${g.text || 'gate'}`) : null;
  const modelChip = m => m ? h('span', { class: 'fp2-model' }, m) : null;
  const spin = () => h('span', { class: 'fp2-spin' });

  function waitLine(p, w, own, rerender) {
    const key = p.id + '|' + w.id;
    const open = !!EXP.q[key];
    return h('div', { class: 'fp2-wl' + (open ? ' open' : '') },
      h('div', { class: 'fp2-wl-h', onclick: () => { EXP.q[key] = !open; rerender(); } },
        h('i', { class: 'fp2-wdot' }),
        h('span', { class: 'fp2-wq' }, w.q),
        w.blocks && w.blocks.length ? h('span', { class: 'fp2-wb' }, 'blocks ' + w.blocks.join(', ')) : null,
        own ? h('button', { class: 'fp2-link', onclick: ev => { ev.stopPropagation(); answerInSession(w); } }, 'Answer →')
          : p.sessions.length ? h('button', { class: 'fp2-link', onclick: ev => { ev.stopPropagation(); openTerm(p.sessions[0]); } }, 'Open session →') : null),
      open && w.detail ? h('div', { class: 'fp2-qd' }, w.detail) : null);
  }

  const answerHead = w => `Answer to ${w.id}${w.blocks && w.blocks.length ? ' (blocks ' + w.blocks.join(', ') + ')' : ''}: "${w.q}"\n`;

  function answerInSession(w) {
    if (isPhone()) { PH.name = null; sync(true); }
    const box = $('#term-chat:not(.hidden) textarea');
    if (box) {
      const head = answerHead(w);
      if (!box.value.startsWith(head)) { box.value = head + box.value; box.dispatchEvent(new Event('input')); }
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      return;
    }
    const frame = TERM.frames.get(TERM.active);
    if (frame) frame.focus();
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

  const EV_LABEL = { start: 'started', done: 'done', fail: 'failed', note: 'note', ask: 'asked', answer: 'answered' };

  function eventLine(e) {
    const text = e.type === 'done' || e.type === 'fail' ? (e.gate && e.gate.text) || e.text : e.text;
    return h('div', { class: 'fp2-ev ' + e.type }, h('span', { class: 'fp2-evt' }, clock(e.ts)), h('b', null, EV_LABEL[e.type] || e.type), text ? h('span', { class: 'fp2-evx' }, text) : null);
  }

  const taskIcon = s => h('span', { class: 'fp2-si ' + s }, s === 'done' ? ico('check', 12) : s === 'failed' ? '!' : s === 'blocked' ? '?' : s === 'doing' ? spin() : null);

  function taskRow(p, t, evs, rerender) {
    const key = p.id + '|' + t.id;
    const open = !!EXP.tasks[key];
    const isNext = !!(p.next && p.next.id === t.id);
    const steps = p.now && p.now.id === t.id ? p.now.steps || [] : [];
    const shown = t.status === 'done' ? open ? evs.filter(e => e.type !== 'start') : [] : evs;
    const cur = currentId(p) === t.id;
    return h('div', { class: 'fp2-task ' + t.status + (open ? ' open' : '') + (cur ? ' cur' : '') },
      h('button', { class: 'fp2-task-h', onclick: () => { EXP.tasks[key] = !open; rerender(); } },
        taskIcon(t.status), h('span', { class: 'fp2-id' }, t.id), h('span', { class: 'fp2-task-t' }, t.title), isNext ? h('span', { class: 'fp2-nx' }, 'next') : null, modelChip(t.model)),
      isNext && p.nextNote ? h('div', { class: 'fp2-qd' }, p.nextNote) : null,
      steps.length ? h('div', { class: 'fp2-steps' }, steps.map(s => h('div', { class: 'fp2-step ' + s.s }, s.s === 'completed' ? ico('check', 13) : s.s === 'in_progress' ? spin() : h('i', { class: 'fp2-pt' }), h('span', null, s.c)))) : null,
      shown.length ? h('div', { class: 'fp2-evs' }, shown.map(eventLine)) : null,
      open ? h('div', { class: 'fp2-task-b' }, t.body ? h('div', { class: 'fp2-body-t' }, t.body) : h('div', { class: 'dim' }, 'No task card.')) : null);
  }

  const currentId = p => (p.now && p.now.id) || (p.next && p.next.id) || null;

  function steps(p, d, rerender) {
    const b = bucketEvents(d.timeline, d.phases);
    const wrap = h('div', { class: 'fp2-sec' });
    wrap.append(h('div', { class: 'fp2-sec-h' }, 'Steps', h('span', { class: 'fp2-sp' }), b.created ? h('span', { class: 'dim' }, 'started ' + clock(b.created.ts)) : null));
    for (const ph of d.phases) {
      const complete = !!ph.total && ph.done >= ph.total;
      const done = complete ? (b.phase[ph.n] || []).filter(e => e.type === 'phase').pop() : null;
      const key = p.id + '|' + ph.n;
      const folded = complete && !ph.tasks.some(t => t.id === currentId(p)) && !EXP.phases[key];
      const count = h('span', { class: 'dim' }, `${ph.done}/${ph.total}${done ? ' · done ' + clock(done.ts) : ''}`);
      const title = h('span', { class: 'fp2-pn' }, h('span', null, 'P' + ph.n), ' ', h('b', null, ph.name));
      const head = complete
        ? h('button', { class: 'fp2-ph-h fold', onclick: () => { EXP.phases[key] = folded; rerender(); } }, taskIcon('done'), title, count, h('span', { class: 'fp2-chev' + (folded ? '' : ' on') }, ico('chevronDown', 14)))
        : h('div', { class: 'fp2-ph-h' }, title, count);
      const evs = (b.phase[ph.n] || []).filter(e => e.type !== 'phase');
      wrap.append(h('div', { class: 'fp2-ph' + (folded ? ' folded' : '') }, head,
        folded ? null : evs.length ? h('div', { class: 'fp2-evs ph' }, evs.map(eventLine)) : null,
        folded ? null : ph.tasks.map(t => taskRow(p, t, b.task[t.id] || [], rerender))));
    }
    return wrap;
  }

  function panelBody(p, own, rerender) {
    const d = DET[p.id] || p;
    const out = [];
    out.push(h('div', { class: 'fp2-head' },
      h('span', { class: 'fp2-big' }, h('b', null, p.done), '/' + p.total),
      h('span', { class: 'dim' }, p.pct + '%'),
      p.phase ? h('span', { class: 'fp2-phase dim' }, 'P', h('b', null, `${p.phase.n}/${p.phase.of}`), ' ', p.phase.name) : null,
      gateChip(p.lastGate)));
    out.push(h('div', { class: 'fp2-bar' + (p.complete ? ' full' : '') }, h('i', { style: `width:${p.pct}%` })));
    for (const w of d.waiting || p.waiting) out.push(waitLine(p, w, own, rerender));
    if (d.phases) out.push(steps(p, d, rerender));
    else out.push(h('div', { class: 'dim fp2-load' }, 'loading…'));
    if (d.errors && d.errors.length && d.phases) out.push(h('div', { class: 'fp2-err' }, `${d.errors.length} line${d.errors.length > 1 ? 's' : ''} in plan.md could not be read`));
    return out;
  }

  function switcher(list, names, shownId, ownId, rerender) {
    if (list.length < 2) return null;
    const pick = id => { VIEW[TERM.active] = id; EXP.menu = false; sync(true); };
    const inner = (p, i) => [p.id === ownId ? h('i', { class: 'fp2-own' }) : null, h('span', { class: 'fp2-cn' }, names[i]), h('span', { class: 'fp2-cc' }, `${p.done}/${p.total}`), p.waiting.length ? h('i', { class: 'fp2-wdot' }) : null];
    const item = (p, i) => h('button', { class: 'fp2-chip' + (p.id === shownId ? ' on' : ''), title: planLabel(p) + (p.id === ownId ? ' — this session' : ''), onclick: () => pick(p.id) }, ...inner(p, i));
    const cur = list.findIndex(p => p.id === shownId);
    const back = ownId && shownId !== ownId ? h('button', { class: 'fp2-link back', onclick: () => pick(ownId) }, '← this session’s plan') : null;
    const menu = h('div', { class: 'fp2-menu' + (EXP.menu ? ' open' : '') },
      h('button', { class: 'fp2-menu-b', onclick: () => { EXP.menu = !EXP.menu; rerender(); } }, ...inner(list[cur], cur), h('span', { class: 'fp2-menu-n' }, `${list.length} plans`), ico('chevronDown', 14)),
      EXP.menu ? h('div', { class: 'fp2-menu-l' }, list.map(item)) : null);
    return h('div', { class: 'fp2-swi' }, h('div', { class: 'fp2-chips' }, list.map(item)), menu, back);
  }

  function panel(phone) {
    const body = h('div', { class: 'fp2-pbody' });
    const sw = h('div', { class: 'fp2-sw' });
    const topic = h('span', { class: 'fp2-ptopic' });
    const rerender = () => {
      const top = body.scrollTop;
      const c = PV.ctx;
      const same = PV.shownId === c.shown.id;
      PV.shownId = c.shown.id;
      topic.textContent = c.shown.topic;
      sw.replaceChildren(...[switcher(c.list, c.names, c.shown.id, c.own && c.own.id, rerender)].filter(Boolean));
      body.replaceChildren(...panelBody(c.shown, !!c.own && c.own.id === c.shown.id, rerender));
      body.scrollTop = same ? top : 0;
      const cur = body.querySelector('.fp2-task.cur');
      const seen = c.shown.id + '|' + currentId(c.shown);
      if (cur && PV.seen !== seen) { PV.seen = seen; requestAnimationFrame(() => { body.scrollTop += cur.getBoundingClientRect().top - body.getBoundingClientRect().top - 48; }); }
    };
    PV.seen = null;
    PV.rerender = rerender;
    return h('div', { id: 'fp2-panel', class: 'fp2-panel' + (phone ? ' sheet' : '') },
      phone ? h('div', { class: 'fp2-grab' }) : null,
      h('div', { class: 'fp2-ph-top' }, h('b', null, 'Plan'), topic, h('span', { class: 'fp2-sp' }), h('button', { class: 'fp2-x', 'aria-label': 'close plan', onclick: toggle }, ico('x', 16))),
      sw, body);
  }

  function remove(...ids) { for (const id of ids) { const el = document.getElementById(id); if (el) el.remove(); } }

  function teardown() {
    remove('fp2-strip', 'fp2-panel', 'fp2-scrim');
    const main = $('.termmain');
    if (main) main.classList.remove('fp2-open');
    ST.sig = '';
  }

  function quietStrip(list, org, open) {
    return h('button', { class: 'fp2-strip-b quiet', title: 'Plans in ' + org, onclick: toggle },
      h('span', { class: 'fp2-nop' }, `No plan · ${list.length} in ${org}`),
      h('span', { class: 'fp2-chev' + (open ? ' on' : '') }, ico('chevronDown', 15)));
  }

  function sync(force) {
    const main = $('.termmain');
    const stripEl = () => document.getElementById('fp2-strip') || document.getElementById('fp2-panel');
    if (!enabled() || !main || !TERM.open || !TERM.active) { if (stripEl()) teardown(); return; }
    const name = TERM.active;
    if (PH.name && PH.name !== name) PH.name = null;
    const own = planFor(ST.sums, name);
    const sess = ((S.runtime && S.runtime.sessions) || []).find(x => x.name === name);
    const projects = S.projects || [];
    const list = orgPlans(ST.sums, projects, own, sess && sess.project);
    if (!list.length) { if (stripEl()) teardown(); return; }
    const shown = list.find(x => x.id === VIEW[name]) || own || list[0];
    const names = planNames(list, projects);
    const phone = isPhone();
    const open = isOpen(name, !!own);
    const org = own ? '' : orgLabel(projects, sess && sess.project);
    const found = document.getElementById('fp2-strip');
    const st = found || h('div', { id: 'fp2-strip', class: 'fp2-strip' });
    if (!found) { const bar = $('#term-bar'); if (bar) bar.after(st); else main.prepend(st); force = true; }
    main.style.setProperty('--fp2-top', (st.offsetTop + st.offsetHeight) + 'px');
    const dm = DET[shown.id] ? DET[shown.id].mtime : 0;
    const sig = JSON.stringify([name, own, org, list, names, shown.id, dm, STALE.has(shown.id), open, phone, EXP]);
    if (sig === ST.sig && !force) return;
    ST.sig = sig;
    st.replaceChildren(own ? strip(own, open) : quietStrip(list, org, open));
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

  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  addEventListener('resize', () => sync());

  FEAT.plan2 = { onState, termShown, termBarKey, termItem, plan: onPlan, live, cardChips, planFor, readOpen, ringMarkup, bucketEvents, orgPlans, planNames, answerHead };
})();
