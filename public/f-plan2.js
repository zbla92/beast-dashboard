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
  const EXP = { all: {}, timeline: {}, tasks: {} };
  const PV = { id: null, phone: false, plan: null, rerender: null };
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
  const clock = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const sinceText = (iso, now) => {
    const t = Date.parse(iso); if (!t) return '';
    const min = Math.max(0, Math.round((now - t) / 60000));
    return `since ${clock(iso)} (${min < 120 ? min + ' min' : Math.round(min / 60) + ' h'})`;
  };
  const ringMarkup = (pct, size) => {
    const dash = (RING_C * Math.max(0, Math.min(100, pct)) / 100).toFixed(1);
    return `<svg viewBox="0 0 28 28" width="${size}" height="${size}"><circle class="t" cx="14" cy="14" r="${RING_R}"/><circle class="a" cx="14" cy="14" r="${RING_R}" stroke-dasharray="${dash} ${RING_C.toFixed(1)}" transform="rotate(-90 14 14)"/></svg>`;
  };
  const ring = (p, size) => h('span', { class: 'fp2-ring' + (p.complete ? ' full' : ''), html: ringMarkup(p.pct, size) }, p.waiting.length ? h('i', { class: 'fp2-dot' }) : null);
  const isOpen = name => isPhone() ? PH.name === name : name in OPEN ? !!OPEN[name] : true;

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

  const gateChip = g => g ? h('span', { class: 'fp2-gate ' + (g.ok ? 'ok' : 'bad'), title: g.task ? 'last gate · ' + g.task : 'last gate' }, `gate ${g.ok ? '✓' : '✗'} ${g.text || ''}${g.at ? ' · ' + clock(g.at) : ''}`) : null;
  const modelChip = m => m ? h('span', { class: 'fp2-model' }, m) : null;
  const spin = () => h('span', { class: 'fp2-spin' });

  function waitCard(w) {
    return h('div', { class: 'fp2-card fp2-waitcard' },
      h('div', { class: 'fp2-lab' }, h('i', { class: 'fp2-wdot' }), 'WAITING ON YOU'),
      h('div', { class: 'fp2-q' }, w.q),
      w.detail ? h('div', { class: 'fp2-qd' }, w.detail) : null,
      h('div', { class: 'fp2-foot' }, h('span', { class: 'dim' }, `asked ${clock(w.asked)}${w.blocks && w.blocks.length ? ' · blocks ' + w.blocks.join(', ') : ''}`), h('button', { class: 'fp2-link', onclick: answerInSession }, 'Answer in session →')));
  }

  function answerInSession() {
    if (isPhone()) { PH.name = null; sync(true); }
    const box = $('#term-chat:not(.hidden) textarea');
    if (box) { box.focus(); return; }
    const frame = TERM.frames.get(TERM.active);
    if (frame) frame.focus();
  }

  function phaseBars(phases, cur) {
    return h('div', { class: 'fp2-phases' }, phases.map(ph => h('div', { class: 'fp2-pb' + (ph.n === cur ? ' cur' : '') + (ph.total && ph.done >= ph.total ? ' full' : '') },
      h('div', { class: 'fp2-bar' }, h('i', { style: `width:${ph.total ? Math.round(ph.done * 100 / ph.total) : 0}%` })),
      h('div', { class: 'fp2-pn' }, h('span', null, 'P' + ph.n), ' ', h('b', null, ph.name)),
      h('div', { class: 'fp2-pc' }, `${ph.done}/${ph.total}`))));
  }

  function nowCard(p) {
    const n = p.now; const bad = n.status === 'failed';
    const steps = (n.steps || []);
    const sdone = steps.filter(s => s.s === 'completed').length;
    return h('div', { class: 'fp2-card fp2-now-card' + (bad ? ' bad' : '') },
      h('div', { class: 'fp2-lab' }, bad ? h('i', { class: 'fp2-bdot' }) : spin(), bad ? 'FAILED' : 'NOW', h('span', { class: 'fp2-sp' }), modelChip(n.model)),
      h('div', { class: 'fp2-tt' }, h('span', { class: 'fp2-id' }, n.id), n.title),
      h('div', { class: 'fp2-sub dim' }, [n.since && !bad ? sinceText(n.since, Date.now()) : null, bad && n.gate ? n.gate.text : null, steps.length ? `${sdone}/${steps.length}` : null].filter(Boolean).join(' · ')),
      steps.length ? h('div', { class: 'fp2-steps' }, steps.map(s => h('div', { class: 'fp2-step ' + s.s }, s.s === 'completed' ? ico('check', 13) : s.s === 'in_progress' ? spin() : h('i', { class: 'fp2-pt' }), h('span', null, s.c)))) : null);
  }

  function nextCard(p) {
    const n = p.next;
    return h('div', { class: 'fp2-card fp2-next-card' },
      h('div', { class: 'fp2-lab' }, 'NEXT', h('span', { class: 'fp2-sp' }), modelChip(n.model)),
      h('div', { class: 'fp2-tt' }, h('span', { class: 'fp2-id' }, n.id), n.title),
      p.nextNote ? h('div', { class: 'fp2-qd' }, p.nextNote) : null);
  }

  const taskIcon = s => h('span', { class: 'fp2-si ' + s }, s === 'done' ? ico('check', 12) : s === 'failed' ? '!' : s === 'blocked' ? '?' : s === 'doing' ? spin() : null);

  function taskRow(pid, t, rerender) {
    const key = pid + '|' + t.id;
    const open = !!EXP.tasks[key];
    return h('div', { class: 'fp2-task ' + t.status + (open ? ' open' : '') },
      h('button', { class: 'fp2-task-h', onclick: () => { EXP.tasks[key] = !open; rerender(); } },
        taskIcon(t.status), h('span', { class: 'fp2-id' }, t.id), h('span', { class: 'fp2-task-t' }, t.title), modelChip(t.model), t.gate ? h('span', { class: 'fp2-tg ' + (t.gate.ok ? 'ok' : 'bad') }, t.gate.ok ? '✓' : '✗') : null),
      open ? h('div', { class: 'fp2-task-b' }, t.gate ? h('div', { class: 'fp2-tgt ' + (t.gate.ok ? 'ok' : 'bad') }, 'gate ' + t.gate.text) : null, t.body ? h('div', { class: 'fp2-body-t' }, t.body) : h('div', { class: 'dim' }, 'No task card.')) : null);
  }

  function allTasks(p, d, rerender) {
    const wrap = h('div', { class: 'fp2-sec' });
    wrap.append(h('button', { class: 'fp2-sec-h', onclick: () => { EXP.all[p.id] = !EXP.all[p.id]; rerender(); } }, h('span', { class: 'fp2-car' + (EXP.all[p.id] ? ' on' : '') }, '›'), 'All tasks', h('span', { class: 'fp2-sp' }), h('span', { class: 'dim' }, `${p.done}/${p.total}`)));
    if (EXP.all[p.id] && d.phases) for (const ph of d.phases) wrap.append(h('div', { class: 'fp2-ph' },
      h('div', { class: 'fp2-ph-h' }, h('span', { class: 'fp2-pn' }, h('span', null, 'P' + ph.n), ' ', h('b', null, ph.name)), h('span', { class: 'dim' }, `${ph.done}/${ph.total}`)),
      ph.tasks.map(t => taskRow(p.id, t, rerender))));
    return wrap;
  }

  const eventText = e => [e.task, e.q, e.text, e.gate && e.gate.text].filter(Boolean).join(' · ');

  function timeline(p, d, rerender) {
    const wrap = h('div', { class: 'fp2-sec' });
    const ev = d.timeline || [];
    wrap.append(h('button', { class: 'fp2-sec-h', onclick: () => { EXP.timeline[p.id] = !EXP.timeline[p.id]; rerender(); } }, h('span', { class: 'fp2-car' + (EXP.timeline[p.id] ? ' on' : '') }, '›'), 'Timeline', h('span', { class: 'fp2-sp' }), h('span', { class: 'dim' }, String(ev.length))));
    if (EXP.timeline[p.id]) wrap.append(h('div', { class: 'fp2-tl' }, ev.slice(-40).reverse().map(e => h('div', { class: 'fp2-ev ' + e.type }, h('span', { class: 'fp2-evt' }, clock(e.ts)), h('b', null, e.type), h('span', { class: 'fp2-evx' }, eventText(e))))));
    return wrap;
  }

  function panelBody(p, rerender) {
    const d = DET[p.id] || p;
    const out = [];
    out.push(h('div', { class: 'fp2-head' }, h('span', { class: 'fp2-big' }, h('b', null, p.done), '/' + p.total), h('span', { class: 'dim' }, `${p.pct}% · tasks`), h('span', { class: 'fp2-sp' }), gateChip(p.lastGate)));
    out.push(h('div', { class: 'fp2-bar big' + (p.complete ? ' full' : '') }, h('i', { style: `width:${p.pct}%` })));
    if (p.phase) out.push(h('div', { class: 'fp2-phase dim' }, 'Phase ', h('b', null, `${p.phase.n}/${p.phase.of}`), ' ', p.phase.name));
    for (const w of d.waiting || p.waiting) out.push(waitCard(w));
    if (d.phases) out.push(phaseBars(d.phases, p.phase && p.phase.n));
    if (p.now) out.push(nowCard(p));
    if (p.next) out.push(nextCard(p));
    if (!p.now && !p.next && p.complete) out.push(h('div', { class: 'fp2-card fp2-donecard' }, 'All tasks are done.'));
    if (d.phases) out.push(allTasks(p, d, rerender), timeline(p, d, rerender));
    else out.push(h('div', { class: 'dim fp2-load' }, 'loading…'));
    if (d.errors && d.errors.length && d.phases) out.push(h('div', { class: 'fp2-err' }, `${d.errors.length} line${d.errors.length > 1 ? 's' : ''} in plan.md could not be read`));
    return out;
  }

  function panel(p, phone) {
    const body = h('div', { class: 'fp2-pbody' });
    const rerender = () => { const top = body.scrollTop; body.replaceChildren(...panelBody(PV.plan, rerender)); body.scrollTop = top; };
    PV.plan = p; PV.rerender = rerender;
    rerender();
    return h('div', { id: 'fp2-panel', class: 'fp2-panel' + (phone ? ' sheet' : '') },
      phone ? h('div', { class: 'fp2-grab' }) : null,
      h('div', { class: 'fp2-ph-top' }, h('b', null, 'Plan'), h('span', { class: 'fp2-ptopic' }, p.topic), h('span', { class: 'fp2-sp' }), h('button', { class: 'fp2-x', 'aria-label': 'close plan', onclick: toggle }, ico('x', 16))),
      body);
  }

  function remove(...ids) { for (const id of ids) { const el = document.getElementById(id); if (el) el.remove(); } }

  function teardown() {
    remove('fp2-strip', 'fp2-panel', 'fp2-scrim');
    const main = $('.termmain');
    if (main) main.classList.remove('fp2-open');
    ST.sig = '';
    PV.id = null;
  }

  function sync(force) {
    const main = $('.termmain');
    if (!enabled() || !main || !TERM.open || !TERM.active) { if (document.getElementById('fp2-strip') || document.getElementById('fp2-panel')) teardown(); return; }
    const name = TERM.active;
    if (PH.name && PH.name !== name) PH.name = null;
    const p = planFor(ST.sums, name);
    if (!p) { if (document.getElementById('fp2-strip') || document.getElementById('fp2-panel')) teardown(); return; }
    const phone = isPhone();
    const open = isOpen(name);
    const found = document.getElementById('fp2-strip');
    const st = found || h('div', { id: 'fp2-strip', class: 'fp2-strip' });
    if (!found) { const bar = $('#term-bar'); if (bar) bar.after(st); else main.prepend(st); force = true; }
    main.style.setProperty('--fp2-top', (st.offsetTop + st.offsetHeight) + 'px');
    const dm = DET[p.id] ? DET[p.id].mtime : 0;
    const sig = JSON.stringify([name, p, dm, STALE.has(p.id), open, phone, EXP, Math.floor(Date.now() / 60000)]);
    if (sig === ST.sig && !force) return;
    ST.sig = sig;
    st.replaceChildren(strip(p, open));
    main.classList.toggle('fp2-open', open && !phone);
    const old = document.getElementById('fp2-panel');
    if (!open) { remove('fp2-panel', 'fp2-scrim'); PV.id = null; return; }
    if (old && PV.id === p.id && PV.phone === phone) {
      PV.plan = p;
      PV.rerender();
    } else {
      remove('fp2-panel', 'fp2-scrim');
      const el = panel(p, phone);
      if (phone) document.body.append(h('div', { id: 'fp2-scrim', class: 'fp2-scrim', onclick: toggle }), el); else main.append(el);
      PV.id = p.id; PV.phone = phone;
    }
    ensureDetail(p);
  }

  function toggle() {
    const name = TERM.active; if (!name) return;
    if (isPhone()) PH.name = PH.name === name ? null : name;
    else {
      OPEN[name] = !isOpen(name);
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

  FEAT.plan2 = { onState, termShown, termBarKey, termItem, plan: onPlan, live, cardChips, planFor, readOpen, sinceText, ringMarkup };
})();
