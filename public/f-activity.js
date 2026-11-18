'use strict';
FEAT.activity = (() => {
  const SILENT_MS = 10 * 60 * 1000;
  const NOUN = { agent: 'agent', shell: 'command', monitor: 'monitor', task: 'task' };
  const KIND = { agent: 'Agent', shell: 'Command', monitor: 'Monitor', task: 'Task' };
  const ICON = {
    agent: '<circle cx="8" cy="6" r="2.5"/><path d="M3 13.5c.6-2.4 2.6-3.5 5-3.5s4.4 1.1 5 3.5"/>',
    shell: '<path d="M3 4.5l3.5 3.5L3 11.5M8 12h5"/>',
    monitor: '<path d="M1.5 8h3l1.5-4 3 8 1.5-4h4"/>',
    task: '<rect x="3" y="2.5" width="10" height="11" rx="2"/><path d="M5.5 6.5h5M5.5 9.5h3"/>',
    up: '<path d="M4 10l4-4 4 4"/>',
  };
  const OPEN = new Set();
  const STOPS = new Map();
  const SENT_MS = 10 * 1000, ERR_MS = 5000;
  const age = ms => { const m = Math.floor(ms / 60000); return m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h' : Math.floor(m / 1440) + 'd'; };
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); const hr = Math.floor(s / 3600); const mn = Math.floor(s % 3600 / 60); const sc = s % 60; return hr ? hr + 'h ' + String(mn).padStart(2, '0') + 'm' : mn ? mn + 'm ' + String(sc).padStart(2, '0') + 's' : sc + 's'; };

  function glyph(kind, size = 14) {
    const el = h('span', { class: 'bg-ico' });
    el.innerHTML = '<svg viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + ICON[kind] + '</svg>';
    return el;
  }

  function itemsOf(name, cl) {
    const lv = liveOf(name);
    const known = FEAT.subagents?.agents(name) || [];
    const mayBeSilent = cl.state !== 'working' && !FEAT.subagents?.partial(name);
    const turnDone = displayState(cl) === 'background';
    const w = cl.waitingOn || { agents: [], shells: [] };
    const held = new Set([...(w.agents || []), ...(w.shells || [])].map(x => x.id).filter(Boolean));
    const enrich = (id, base) => {
      const a = id ? known.find(x => x.agentId === id) : null;
      if (a && a.done) return null;
      const quiet = a && a.lastAt ? Date.now() - a.lastAt : 0;
      return { ...base, startedAt: base.startedAt || (a && a.startedAt) || null, silent: mayBeSilent && quiet > SILENT_MS ? quiet : 0 };
    };
    if (lv && !lv.stale && Array.isArray(lv.tasks)) {
      const stoppable = lv.stopTask === true;
      return lv.tasks.flatMap(t => {
        const it = enrich(t.kind === 'agent' ? t.id : null, { id: t.id, kind: t.kind, description: t.description || t.id, startedAt: t.startedAt || null, progress: t.progress || null });
        return it ? [{ ...it, holds: turnDone && held.has(t.id), stoppable: stoppable && !!t.id && !t.owed }] : [];
      });
    }
    const agents = (cl.bgTasks || []).flatMap(t => {
      const it = enrich(t.id, { id: t.id, kind: 'agent', description: t.description || t.type || t.id, startedAt: null, progress: null });
      return it ? [{ ...it, holds: turnDone && held.has(t.id) }] : [];
    });
    const s = S.runtime.sessions.find(x => x.name === name);
    const count = (s && s.toolShells) || 0;
    const described = (w.shells || []).map(x => ({ id: x.id, kind: 'shell', description: x.description || x.id, startedAt: x.startedAt || null, progress: null, silent: 0, holds: turnDone }));
    const extra = Array.from({ length: Math.max(0, count - described.length) }, () => ({ id: null, kind: 'shell', description: 'Command', startedAt: null, progress: null, silent: 0, holds: false }));
    return [...agents, ...described, ...extra];
  }

  function headline(items) {
    const holding = items.some(i => i.holds);
    const verb = holding ? 'Waiting' : 'Running';
    if (items.length === 1) return { verb, text: items[0].description };
    const parts = Object.keys(NOUN).map(k => [items.filter(i => i.kind === k).length, NOUN[k]]).filter(p => p[0]).map(p => plural(p[0], p[1]));
    const list = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
    return { verb: holding ? 'Waiting on ' + list : 'Running ' + list, text: '' };
  }

  const earliest = items => items.reduce((m, i) => i.startedAt && (!m || i.startedAt < m) ? i.startedAt : m, 0);
  const elapsed = start => h('span', { class: 'bg-el mono', 'data-start': start ? String(start) : '' }, start ? clock(Date.now() - start) : '');

  const stopKey = (name, id) => name + '\n' + id;
  function stopState(name, id) {
    const st = STOPS.get(stopKey(name, id));
    if (!st) return null;
    const ttl = st.state === 'err' ? ERR_MS : st.state === 'sent' ? SENT_MS : Infinity;
    return Date.now() - st.at < ttl ? st : null;
  }

  async function stopTask(name, id) {
    const key = stopKey(name, id);
    STOPS.set(key, { state: 'busy', at: Date.now() });
    paintAll();
    try {
      await api('hl-task-stop', { session: name, id });
      STOPS.set(key, { state: 'sent', at: Date.now() });
      setTimeout(paintAll, SENT_MS + 50);
    } catch (e) {
      STOPS.set(key, { state: 'err', at: Date.now(), error: e.message || 'failed' });
      setTimeout(paintAll, ERR_MS + 50);
    }
    paintAll();
  }

  function stopButton(name, it) {
    const st = stopState(name, it.id);
    const busy = !!st && st.state !== 'err';
    return h('button', { class: 'bg-act bg-x', disabled: busy, 'aria-label': 'Stop ' + (NOUN[it.kind] || 'task'), onclick: ev => { ev.stopPropagation(); if (!busy) stopTask(name, it.id); } },
      h('span', { class: 'bg-sq' }), busy ? 'Stopping…' : 'Stop');
  }

  function popItem(name, it, turnDone) {
    const st = it.stoppable ? stopState(name, it.id) : null;
    const failed = st && st.state === 'err' ? 'Could not stop: ' + st.error : '';
    const hint = it.silent ? 'silent ' + age(it.silent) : it.progress || '';
    const open = it.kind === 'agent' && it.id && FEAT.subagents ? h('button', { class: 'bg-act', onclick: () => FEAT.subagents.sheet(name, it.id) }, 'Open subagent') : null;
    const stop = it.stoppable ? stopButton(name, it) : null;
    return h('div', { class: 'bg-pi' + (it.holds ? '' : ' soft') },
      h('span', { class: 'bg-pk k-' + it.kind }, glyph(it.kind), h('span', null, KIND[it.kind] || 'Task')),
      h('div', { class: 'bg-pd' },
        h('div', { class: 'bg-pt' }, it.description, turnDone && !it.holds ? h('span', { class: 'bg-nb' }, 'Not blocking') : null),
        failed ? h('div', { class: 'bg-pp bg-err', role: 'alert' }, failed) : hint ? h('div', { class: 'bg-pp mono' }, hint) : null),
      elapsed(it.startedAt),
      open || stop ? h('span', { class: 'bg-acts' }, open, stop) : null);
  }

  function popover(name, items, turnDone) {
    return h('div', { class: 'bg-pop' + (OPEN.has(name) ? ' open' : ''), role: 'dialog', 'aria-label': 'Background work' },
      h('div', { class: 'bg-ph' }, 'Background work', h('span', { class: 'dim' }, plural(items.length, 'item'))),
      ...items.map(it => popItem(name, it, turnDone)));
  }

  function toggle(name, strip) {
    const open = !OPEN.has(name);
    if (open) OPEN.add(name); else OPEN.delete(name);
    strip.querySelector('.bg-pop').classList.toggle('open', open);
    strip.querySelector('.bg-more').setAttribute('aria-expanded', String(open));
  }

  function build(name, cl, items) {
    const turnDone = displayState(cl) === 'background';
    const holding = items.some(i => i.holds);
    const head = headline(items);
    const only = items.length === 1 ? items[0] : null;
    const strip = h('div', { class: 'act-strip' });
    const more = h('button', { class: 'bg-more', 'aria-label': 'Details', 'aria-expanded': String(OPEN.has(name)), onclick: ev => { ev.stopPropagation(); toggle(name, strip); } }, glyph('up'));
    const row = h('div', { class: 'bg-row ' + (holding ? 'hold' : 'soft') },
      h('div', { class: 'bg-main', onclick: () => toggle(name, strip) },
        h('span', { class: 'bg-spin' }),
        h('b', { class: 'bg-rl' }, head.verb),
        head.text ? h('span', { class: 'bg-sep' }, '·') : null,
        head.text ? h('span', { class: 'bg-rd' }, head.text) : null,
        h('span', { class: 'bg-grow' }),
        elapsed(earliest(items)),
        more),
      only && only.progress ? h('div', { class: 'bg-prog' }, h('span', { class: 'mono' }, only.progress)) : null);
    strip.append(popover(name, items, turnDone), row);
    return strip;
  }

  const stopSig = (name, i) => { const st = i.stoppable ? stopState(name, i.id) : null; return i.stoppable ? st ? st.state : 's' : ''; };
  const signature = (name, cl, items) => displayState(cl) + '|' + items.map(i => [i.id, i.kind, i.description, i.progress, i.holds, i.silent ? 1 : 0, i.startedAt ? 1 : 0, stopSig(name, i)].join('~')).join('|');

  function forgetStops(name, items) {
    const ids = new Set(items.map(i => i.id));
    for (const key of [...STOPS.keys()]) {
      const [n, id] = key.split('\n');
      if (n === name && (!ids.has(id) || !stopState(n, id))) STOPS.delete(key);
    }
  }

  function paintBox(box) {
    const name = box.dataset.chat;
    const cl = name ? claudeOf(name) : null;
    const items = cl && cl.mode === 'chat' ? itemsOf(name, cl) : [];
    const found = box.querySelector(':scope > .act-strip');
    if (name) forgetStops(name, items);
    if (!items.length) { if (found) found.remove(); return; }
    const sig = signature(name, cl, items);
    if (found && found.dataset.sig === sig) return;
    const strip = build(name, cl, items);
    strip.dataset.sig = sig;
    if (found) { found.replaceWith(strip); return; }
    const scroller = box.querySelector(':scope > .cscroll');
    if (!scroller) return;
    const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    scroller.after(strip);
    if (pinned) scroller.scrollTop = scroller.scrollHeight;
  }

  function paintAll() {
    for (const box of document.querySelectorAll('[data-chat]')) paintBox(box);
  }

  function tick() {
    const now = Date.now();
    for (const el of document.querySelectorAll('.bg-el[data-start]')) if (el.dataset.start) el.textContent = clock(now - Number(el.dataset.start));
  }

  function closeAll() {
    OPEN.clear();
    for (const pop of document.querySelectorAll('.bg-pop.open')) pop.classList.remove('open');
    for (const b of document.querySelectorAll('.bg-more[aria-expanded="true"]')) b.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener('click', ev => { if (OPEN.size && !ev.target.closest('.act-strip')) closeAll(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && OPEN.size && document.querySelector('.bg-pop.open')) { ev.preventDefault(); ev.stopPropagation(); closeAll(); } }, true);

  setInterval(() => { if (!document.hidden) tick(); }, 1000);
  setInterval(() => { if (!document.hidden) paintAll(); }, 5000);

  return { composerShown: paintBox, onState: paintAll };
})();
