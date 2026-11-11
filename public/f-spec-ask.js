'use strict';
FEAT.specAsk = (() => {
  const KEY = 'bd.specask.', LAST_KEY = 'bd.specask.last', CAP = 10, POLL_SEC = 20, LIST_TTL = 30000, STORE_TEXT = 60000, STORE_TASK = 4000, MAX_TASK = 100000, INDEX_KEY = 'bd.specask.index', MAX_SESSIONS = 30, PLAIN_MS = 4000, BACKOFF_MIN = 2000, BACKOFF_MAX = 30000, FINAL = ['done', 'error', 'stopped'];
  const enc = encodeURIComponent;
  const cards = new Map(), els = new Map(), watching = new Set();
  const lists = { at: 0, items: [], pending: null };
  const idle = { waiters: [] };
  const held = { value: null, down: false, el: null, overlay: null };

  const capCards = list => list.slice(-CAP);
  const asText = v => typeof v === 'string' ? v : '';
  const parseCards = raw => {
    try {
      const v = JSON.parse(raw);
      if (!Array.isArray(v)) return [];
      return capCards(v.filter(c => c && typeof c.id === 'string' && typeof c.specialist === 'string' && typeof c.task === 'string' && typeof c.session === 'string').map(c => ({
        id: c.id, session: c.session, specialist: c.specialist, title: asText(c.title) || c.specialist, task: c.task, runId: asText(c.runId) || null, mode: asText(c.mode) || null,
        state: ['asking', 'working', 'waiting', 'done', 'error'].includes(c.state) ? c.state : 'error', text: asText(c.text), error: asText(c.error), follow: asText(c.follow), truncated: c.truncated === true, endedAt: Number.isFinite(c.endedAt) ? c.endedAt : 0, at: Number.isFinite(c.at) ? c.at : 0,
      })).map(c => c.state === 'asking' ? { ...c, state: 'error', error: 'The page was reloaded before this ask was sent.' } : c));
    } catch { return []; }
  };
  const fromRun = r => {
    if (!FINAL.includes(r.state)) return { state: r.state === 'waiting' ? 'waiting' : 'working', text: '', error: '' };
    if (r.state === 'done') return { state: 'done', text: asText(r.text), error: '' };
    return { state: 'error', text: asText(r.text), error: asText(r.error) || (r.state === 'stopped' ? 'The run was stopped.' : 'The run failed.') };
  };
  const messageText = turn => {
    if (!turn) return '';
    if (turn.role === 'assistant') return (turn.steps || []).filter(s => s.k === 'text').map(s => s.text).join('\n\n').trim();
    return asText(turn.text).trim();
  };
  const taskFor = text => {
    const t = String(text || '').trim();
    return t ? FEAT.quotes.blockquote(t) + '\n\n' : '';
  };
    const createLimiter = max => {
    const held = new Set();
    return { acquire: id => { if (held.has(id)) return true; if (held.size >= max) return false; held.add(id); return true; }, release: id => { held.delete(id); }, size: () => held.size };
  };
  const longPolls = createLimiter(1);
  const touchIndex = (index, name, cap) => {
    const next = [...index.filter(n => n !== name), name];
    return { index: next.slice(-cap), dropped: next.slice(0, Math.max(0, next.length - cap)) };
  };
  const backoff = fails => Math.min(BACKOFF_MIN * 2 ** Math.max(0, fails - 1), BACKOFF_MAX);
  const readIndex = () => { try { const v = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); return Array.isArray(v) ? v.filter(n => typeof n === 'string') : []; } catch { return []; } };
  const writeIndex = index => { try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch {} };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const firstLine = t => String(t || '').split('\n').map(l => l.replace(/^>\s?/, '').trim()).find(Boolean) || '';

  const load = name => {
    if (!cards.has(name)) { const raw = (() => { try { return localStorage.getItem(KEY + name); } catch { return null; } })(); cards.set(name, parseCards(raw)); }
    return cards.get(name);
  };
  const save = (name, list) => {
    cards.set(name, list);
    const slim = list.map(c => ({ ...c, task: c.task.slice(0, STORE_TASK), follow: c.follow.slice(0, STORE_TASK), text: c.text.slice(0, STORE_TEXT), truncated: c.truncated || c.text.length > STORE_TEXT }));
    try {
      if (slim.length) { const t = touchIndex(readIndex(), name, MAX_SESSIONS); localStorage.setItem(KEY + name, JSON.stringify(slim)); writeIndex(t.index); for (const gone of t.dropped) { localStorage.removeItem(KEY + gone); cards.delete(gone); } }
      else { localStorage.removeItem(KEY + name); writeIndex(readIndex().filter(n => n !== name)); }
    } catch {}
  };
  const pruneStored = () => {
    if (typeof S === 'undefined' || !S.runtime || !Array.isArray(S.runtime.sessions) || !S.runtime.sessions.length) return;
    const live = new Set(S.runtime.sessions.map(s => s.name));
    const index = readIndex(), gone = index.filter(n => !live.has(n));
    if (!gone.length) return;
    for (const n of gone) { try { localStorage.removeItem(KEY + n); } catch {} cards.delete(n); }
    writeIndex(index.filter(n => live.has(n)));
  };
  const find = (name, id) => load(name).find(c => c.id === id) || null;
  const paint = (name, id) => { const el = els.get(id), c = find(name, id); if (el && c) fill(el, c); };
  const patch = (name, id, fields) => {
    if (!find(name, id)) return null;
    const extra = fields.text !== undefined && fields.truncated === undefined ? { truncated: false } : {};
    save(name, load(name).map(c => c.id === id ? { ...c, ...fields, ...extra } : c));
    paint(name, id);
    return find(name, id);
  };

  const fetchList = async () => {
    try {
      const r = await api('specialists');
      lists.items = (r.specialists || []).filter(p => !p.error);
      lists.at = Date.now();
      document.body.classList.toggle('sax-none', !lists.items.length);
      pruneStored();
    } catch {}
  };
  const ensureList = force => {
    if (lists.pending) return lists.pending;
    if (!force && Date.now() - lists.at < LIST_TTL) return Promise.resolve();
    lists.pending = fetchList().finally(() => { lists.pending = null; });
    return lists.pending;
  };
  const titleOf = name => { const p = lists.items.find(x => x.name === name); return p ? p.title || p.name : name; };

  const boxesOf = name => [...document.querySelectorAll('[data-chat]')].filter(b => b.dataset.chat === name);
  const composerOf = name => { for (const b of boxesOf(name)) { const el = b.querySelector(':scope > .cbox2'); if (el && el._c) return el._c; } return null; };
  const insertText = (name, text) => {
    const c = composerOf(name);
    if (!c) { toast('Open this chat first', 'err'); return false; }
    const cur = c.ta.value.replace(/\s+$/, '');
    c.ta.value = cur ? cur + '\n\n' + text : text;
    c.grow();
    c.ta.focus();
    return true;
  };

  const nap = ms => new Promise(res => setTimeout(res, ms));
  const whenVisible = () => document.hidden ? new Promise(res => idle.waiters.push(res)) : null;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { const ws = idle.waiters.splice(0); for (const w of ws) w(); } });
  const cardFinal = c => !!c && !!c.runId && (c.state === 'done' || c.state === 'error');
  const markCardSeen = c => { if (cardFinal(c) && FEAT.specialists && FEAT.specialists.markSeen) FEAT.specialists.markSeen(c.runId, c.endedAt || undefined); };
  const visibleCard = id => { const el = els.get(id); return !!el && el.isConnected === true && !document.hidden; };
  const fullText = async c => {
    if (!c.truncated || !c.runId) return c.text;
    try { const r = await api('specialist/run/' + enc(c.runId)); return asText(r.text) || c.text; } catch { return c.text; }
  };

  async function watch(name, id) {
    if (watching.has(id)) return;
    watching.add(id);
    const st = { fails: 0 };
    try {
      while (true) {
        const c = find(name, id);
        if (!c || !c.runId || c.state === 'done' || c.state === 'error') return;
        const hidden = whenVisible();
        if (hidden) { await hidden; continue; }
        const long = longPolls.acquire(id);
        try {
          const r = await api('specialist/run/' + enc(c.runId) + (long ? '?wait=1&timeoutSec=' + POLL_SEC : ''));
          st.fails = 0;
          const next = fromRun(r);
          const fin = FINAL.includes(r.state);
          if (next.state !== c.state || next.text !== c.text || next.error !== c.error) patch(name, id, fin ? { ...next, endedAt: Number(r.endedAt) || Date.now() } : next);
          if (fin) { if (visibleCard(id)) markCardSeen(find(name, id)); return; }
          if (!long) await nap(PLAIN_MS);
        } catch (e) {
          if (e.status === 404) { patch(name, id, { state: 'error', error: 'This run no longer exists.' }); return; }
          st.fails += 1;
          await nap(backoff(st.fails));
        } finally { if (long) longPolls.release(id); }
      }
    } finally { watching.delete(id); }
  }

  const showCard = card => {
    const el = elFor(card);
    for (const box of boxesOf(card.session)) {
      const sc = box.querySelector(':scope > .cscroll'), conv = sc && sc.querySelector(':scope > .conv');
      if (!conv) continue;
      conv.append(el);
      sc.scrollTop = sc.scrollHeight;
      return;
    }
  };
  const addCard = card => {
    const list = load(card.session), next = capCards([...list, card]);
    for (const gone of list.filter(c => !next.some(n => n.id === c.id))) { els.get(gone.id)?.remove(); els.delete(gone.id); }
    save(card.session, next);
    showCard(card);
  };
  const dismiss = (name, id) => { markCardSeen(find(name, id)); save(name, load(name).filter(c => c.id !== id)); els.get(id)?.remove(); els.delete(id); };

  async function ask({ session, specialist, task }) {
    const card = { id: newId(), session, specialist, title: titleOf(specialist), task, runId: null, mode: null, state: 'asking', text: '', error: '', follow: '', at: Date.now() };
    addCard(card);
    try {
      const r = await api('specialist/' + enc(specialist) + '/ask', { text: task, wait: false });
      patch(session, card.id, { runId: r.runId, mode: r.mode || null, ...fromRun(r) });
    } catch (e) { patch(session, card.id, { state: 'error', error: e.message }); return; }
    watch(session, card.id);
  }
  async function follow(name, id, text) {
    const c = find(name, id);
    if (!c || !c.runId) return;
    patch(name, id, { state: 'working', follow: text, error: '' });
    try {
      const r = await api('specialist/run/' + enc(c.runId) + '/send', { text, wait: false });
      patch(name, id, { mode: r.mode || c.mode, ...fromRun(r) });
    } catch (e) {
      if (e.status !== 409) { patch(name, id, { state: 'error', error: e.message }); return; }
      patch(name, id, { state: 'working', error: '' });
    }
    watch(name, id);
  }

  function fill(el, c) {
    const prev = el.querySelector('.sax-more input'), keep = prev && el.contains(document.activeElement) ? prev.value : null;
    const working = c.state === 'asking' || c.state === 'working' || c.state === 'waiting';
    const status = c.state === 'waiting' ? 'needs an answer in the dashboard' : working ? 'working' : c.state === 'error' ? 'failed' : 'done';
    const head = h('div', { class: 'who sax-head' }, working ? h('span', { class: 'spin' }) : ico(c.state === 'error' ? 'x' : 'check', 13), h('b', null, c.title), h('span', { class: 'dim' }, ' · ' + status), h('span', { class: 'sp' }),
      h('button', { class: 'sax-x', type: 'button', title: 'remove this card', 'aria-label': 'Remove this card', onclick: () => dismiss(c.session, c.id) }, ico('x', 13)));
    const asked = h('div', { class: 'sax-task' }, firstLine(c.follow || c.task) || '…');
    const body = c.text && !(c.state === 'asking' || c.state === 'working') ? h('div', { class: 'ttext sax-out', html: mdLite(c.text) }) : null;
    const cut = c.truncated && c.text ? h('div', { class: 'sax-cut dim' }, 'Truncated. Open the run for the full text.') : null;
    const err = c.error ? h('div', { class: 'sax-err' }, c.error) : null;
    const canFollow = c.runId && c.mode !== 'thread' && (c.state === 'done' || c.state === 'error');
    const input = h('input', { class: 'txt', placeholder: 'Continue this run…', autocomplete: 'off', enterkeyhint: 'send' });
    const go = h('button', { class: 'btn sm primary', type: 'button' }, 'Send');
    const more = h('div', { class: 'sax-more hidden' }, input, go);
    const send = () => { const t = input.value.trim(); if (t) { markCardSeen(c); follow(c.session, c.id, t); } };
    go.onclick = send;
    input.onkeydown = ev => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); send(); } };
    const acts = h('div', { class: 'sax-acts' },
      c.text ? h('button', { class: 'btn sm', type: 'button', onclick: async () => { markCardSeen(c); const t = await fullText(c); navigator.clipboard.writeText(t).then(() => toast('Copied', 'ok'), () => toast('Could not copy', 'err')); } }, ico('copy', 13), 'Copy') : null,
      c.text ? h('button', { class: 'btn sm', type: 'button', title: 'put this text in the message box of this chat', onclick: async () => { markCardSeen(c); insertText(c.session, await fullText(c)); } }, ico('arrowUp', 13), 'Insert') : null,
      c.runId && FEAT.specialists ? h('button', { class: 'btn sm', type: 'button', onclick: () => { markCardSeen(c); FEAT.specialists.open(c.specialist, { run: c.runId }); } }, ico('ext', 13), 'Open run') : null,
      canFollow ? h('button', { class: 'btn sm', type: 'button', onclick: () => { markCardSeen(c); more.classList.toggle('hidden'); if (!more.classList.contains('hidden')) input.focus(); } }, ico('redo', 13), 'Continue') : null);
    el.replaceChildren(head, asked, body, cut, err, acts, canFollow ? more : null, h('div', { class: 'sax-note dim' }, 'Only shown here. It reaches this chat only if you press Insert.'));
    if (keep != null && canFollow) { input.value = keep; more.classList.remove('hidden'); input.focus(); }
  }
  function elFor(c) {
    if (!els.has(c.id)) { const el = h('div', { class: 'turn assistant sax-card' }); els.set(c.id, el); fill(el, c); }
    return els.get(c.id);
  }

  const closePicker = () => { if (held.overlay) { held.overlay.remove(); held.overlay = null; } };
  async function openPicker({ session, text }) {
    closePicker();
    await ensureList(true);
    const items = lists.items;
    const select = h('select', { class: 'sax-pick', 'aria-label': 'Specialist' }, items.map(p => h('option', { value: p.name }, p.title || p.name)));
    const last = (() => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } })();
    if (items.some(p => p.name === last)) select.value = last;
    const ta = h('textarea', { class: 'sax-task-in', rows: 7, placeholder: 'What should it do?', spellcheck: 'true' });
    ta.value = taskFor(text);
    const status = h('div', { class: 'ns-status hidden' });
    const go = h('button', { class: 'btn primary', type: 'button' }, 'Ask');
    const submit = () => {
      const task = ta.value.trim();
      if (!task) { ta.focus(); return; }
      if (task.length > MAX_TASK) { status.textContent = 'Too long: ' + task.length + ' of ' + MAX_TASK + ' characters.'; status.classList.remove('hidden'); return; }
      try { localStorage.setItem(LAST_KEY, select.value); } catch {}
      closePicker();
      ask({ session, specialist: select.value, task });
    };
    go.onclick = submit;
    ta.onkeydown = ev => { if (ev.key === 'Enter' && !ev.isComposing && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); submit(); } };
    const title = h('div', { class: 'sh' }, h('h3', null, 'Ask a specialist'));
    const box = items.length
      ? h('div', { class: 'sax-box' }, title, select, ta, status, h('div', { class: 'sax-foot' }, h('span', { class: 'dim' }, 'The answer comes back as a card in this chat.'), h('span', { class: 'sp' }), h('button', { class: 'btn', type: 'button', onclick: closePicker }, 'Cancel'), go))
      : h('div', { class: 'sax-box' }, title, h('div', { class: 'dim' }, 'No specialists yet.'), h('div', { class: 'sax-foot' }, h('span', { class: 'sp' }), FEAT.specialists ? h('button', { class: 'btn primary', type: 'button', onclick: () => { closePicker(); FEAT.specialists.create(); } }, 'Create one') : null, h('button', { class: 'btn', type: 'button', onclick: closePicker }, 'Close')));
    const overlay = h('div', { class: 'sax-ov', onclick: ev => { if (ev.target === overlay) closePicker(); }, onkeydown: ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closePicker(); } } }, box);
    held.overlay = overlay;
    document.body.append(overlay);
    if (items.length) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  const pill = () => held.el || (held.el = document.body.appendChild(h('button', { class: 'sax-pill hidden', type: 'button', tabindex: '-1', onmousedown: ev => ev.preventDefault(), oncontextmenu: ev => ev.preventDefault() }, ico('chat', 14), 'Ask specialist')));
  const place = anchor => {
    const el = pill(), r = anchor.getBoundingClientRect();
    el.classList.remove('hidden');
    const w = el.offsetWidth, right = r.right + 6, fits = right + w <= innerWidth - 8;
    el.style.top = r.top + 'px';
    el.style.height = r.height + 'px';
    el.style.left = (fits ? right : Math.max(8, r.left - 6 - w)) + 'px';
  };
  const followSelection = (anchor, text, session) => {
    if (!held.el && !anchor) return;
    const el = pill();
    if (!anchor || !text) { el.classList.add('hidden'); return; }
    ensureList();
    if (!lists.items.length) { el.classList.add('hidden'); return; }
    held.value = { session, text };
    place(anchor);
  };
  document.addEventListener('pointerdown', ev => { held.down = !!(ev.target.closest && ev.target.closest('.sax-pill')); }, true);
  document.addEventListener('pointerup', () => {
    if (!held.down) return;
    held.down = false;
    const v = held.value;
    if (!v) return;
    held.value = null;
    setTimeout(() => { getSelection().removeAllRanges(); openPicker(v); }, 0);
  }, true);

  const decorate = (name, el) => {
    const cl = el.classList;
    if (el._sax || !cl || !cl.contains('turn') || cl.contains('sax-card') || !(cl.contains('user') || cl.contains('assistant'))) return;
    if (cl.contains('pending') || cl.contains('live') || cl.contains('cmenu') || cl.contains('shell')) return;
    const who = el.querySelector(':scope > .who');
    if (!who || !messageText(el._turn)) return;
    el._sax = true;
    who.append(h('button', { class: 'sax-msg', type: 'button', title: 'ask a specialist about this message', 'aria-label': 'Ask a specialist about this message', onclick: ev => { ev.stopPropagation(); openPicker({ session: name, text: messageText(el._turn) }); } }, ico('chat', 12), h('span', null, 'Specialist')));
  };

  const resume = name => { for (const c of load(name)) { if (c.runId && !cardFinal(c)) watch(name, c.id); else markCardSeen(c); } };

  return {
    capCards, parseCards, fromRun, createLimiter, touchIndex, backoff, messageText, taskFor, follow: followSelection, ask, open: openPicker,
    convTail(name) { resume(name); return load(name).map(elFor); },
    conversation(name, conv) { ensureList(); for (const el of conv.children) decorate(name, el); },
    sessMenu(name, sess, cl) { return cl ? { label: 'Ask a specialist…', icon: ico('chat', 15), title: 'send a task to a specialist; the answer comes back as a card here', onclick: () => openPicker({ session: name, text: '' }) } : null; },
  };
})();
