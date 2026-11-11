'use strict';
FEAT.quotes = (() => {
  const CAP = 4000, KEY = 'bd.quotes.', MARK = 'bd-quote', GAP = 8, DOCK_ROOM = 80, SETTLE_MS = 120, CLICK_WAIT_MS = 300, LONG_QUOTE = 60;
  const store = new Map();
  const ui = { cur: null, pressing: false, dragging: false, timer: 0, frame: 0, marks: 0, pill: null, down: false, afterUp: null, reveal: null };

  const clean = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  const capQuote = s => {
    const t = clean(s);
    if (t.length <= CAP) return t;
    const head = t.slice(0, CAP - 1), nl = head.lastIndexOf('\n');
    return (nl > 0 ? head.slice(0, nl).trimEnd() : head.replace(/[\uD800-\uDBFF]$/, '')) + '…';
  };
  const blockquote = q => q.split('\n').map(l => '> ' + l).join('\n');
  const answerMark = plan => `> Plan ${plan.topic}, ${plan.q}: `;
  const RECORD_LINE = 'Record each answer above with plan answer <qN> "<that answer>" --plan <its plan>, then carry on with the plan.';
  const chipQuote = c => c.plan ? `${answerMark(c.plan)}${c.quote.slice(c.plan.q.length + 2)}` : blockquote(c.quote);
  const compose = (chips, text) => [...chips.flatMap(c => [chipQuote(c), String(c.ask ?? '').trim()]), chips.some(c => c.plan && String(c.ask ?? '').trim()) ? RECORD_LINE : '', String(text ?? '').trim()].filter(Boolean).join('\n\n');
  const planOf = c => c.plan && typeof c.plan.id === 'string' && typeof c.plan.topic === 'string' && typeof c.plan.q === 'string' ? { plan: { id: c.plan.id, topic: c.plan.topic, q: c.plan.q } } : {};
  const parse = raw => {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter(c => c && typeof c.id === 'string' && typeof c.quote === 'string' && c.quote).map(c => ({ id: c.id, quote: c.quote, ask: typeof c.ask === 'string' ? c.ask : '', ...(Number.isFinite(c.at) ? { at: c.at } : {}), ...planOf(c) })) : [];
    } catch { return []; }
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const seenLines = (rects, box) => rects.filter(r => r.width > 0 && r.bottom > box.top && r.top < box.bottom);
  const pillPos = (rects, view, box, w, ht) => {
    const seen = seenLines(rects, box);
    if (!seen.length) return null;
    const line = seen[0];
    const minY = Math.max(box.top, view.top) + GAP, maxY = Math.min(box.bottom, view.bottom) - ht - GAP;
    const over = line.top - ht - GAP;
    return { left: clamp(line.left + line.width / 2 - w / 2, Math.max(box.left, view.left) + GAP, Math.min(box.right, view.right) - w - GAP), top: clamp(over >= minY ? over : line.bottom + GAP, minY, maxY) };
  };
  const dockPos = (rects, view, box, w, ht) => {
    const left = Math.max(box.left, view.left), right = Math.min(box.right, view.right);
    const shownTop = Math.max(box.top, view.top), shownBottom = Math.min(box.bottom, view.bottom);
    const high = shownTop + GAP, low = shownBottom - ht - GAP;
    const seen = seenLines(rects, { top: shownTop, bottom: shownBottom });
    if (low < high || right <= left || !seen.length) return null;
    const start = Math.min(...seen.map(r => r.top)), end = Math.max(...seen.map(r => r.bottom));
    const roomBelow = low - end, roomAbove = start - high - ht;
    return { left: left + (right - left - w) / 2, top: roomBelow >= DOCK_ROOM || roomBelow >= roomAbove ? low : high };
  };

  const quotesLabel = n => n === 1 ? '1 quote' : n + ' quotes';
  const answersLabel = n => n === 1 ? '1 answer' : n + ' answers';
  const trayLabel = list => {
    const answers = list.filter(c => c.plan).length, quotes = list.length - answers;
    return [answers ? answersLabel(answers) : '', quotes ? quotesLabel(quotes) : ''].filter(Boolean).join(' · ');
  };
  const squeeze = s => String(s ?? '').replace(/\s+/g, '');
  const needleOf = quote => squeeze(String(quote ?? '').replace(/…$/, ''));
  const nearestMatch = (text, needle, at) => {
    if (!needle) return -1;
    const pieces = text.split(needle);
    if (pieces.length < 2) return -1;
    const hits = pieces.slice(0, -1).reduce((acc, piece) => { acc.push((acc.length ? acc[acc.length - 1] + needle.length : 0) + piece.length); return acc; }, []);
    return at == null ? hits[hits.length - 1] : hits.reduce((best, hit) => Math.abs(hit - at) < Math.abs(best - at) ? hit : best);
  };

  const load = name => {
    if (!store.has(name)) { const raw = (() => { try { return localStorage.getItem(KEY + name); } catch { return null; } })(); store.set(name, parse(raw)); }
    return store.get(name);
  };
  const save = (name, list) => {
    store.set(name, list);
    try { if (list.length) localStorage.setItem(KEY + name, JSON.stringify(list)); else localStorage.removeItem(KEY + name); } catch {}
  };
  const has = name => load(name).length > 0;
  const isCommand = typed => /^\/[^\s/]+(\s|$)/.test(typed);
  const pathFirst = text => /^\/[^\s/]+\//.test(text);
  const message = (name, typed) => { const text = compose(isCommand(typed) ? [] : load(name), typed); return pathFirst(text) ? '📎 ' + text : text; };
  const add = (name, text, at) => {
    const chip = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), quote: capQuote(text), ask: '', ...(Number.isFinite(at) ? { at } : {}) };
    save(name, [...load(name), chip]);
    paint(name);
    return chip;
  };
  const addAnswer = (name, { quote, ask, plan }) => {
    const chip = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), quote: capQuote(quote), ask, plan };
    save(name, [...load(name), chip]);
    paint(name);
    return chip;
  };
  const answerOf = (name, id, q) => load(name).find(c => c.plan && c.plan.id === id && c.plan.q === q) || null;
  const keepAnswers = (name, keep) => {
    const list = load(name), kept = list.filter(c => !c.plan || keep(c));
    if (kept.length !== list.length) { save(name, kept); paint(name); }
  };
  const setAsk = (name, id, ask) => { save(name, load(name).map(c => c.id === id ? { ...c, ask } : c)); boxesOf(name).forEach(mount); };
  const remove = (name, id) => { save(name, load(name).filter(c => c.id !== id)); paint(name); };
  const take = (name, typed = '') => { if (isCommand(typed)) return []; const chips = load(name); save(name, []); paint(name); return chips; };
  const restore = (name, chips) => {
    const back = new Set(chips.map(c => c.id));
    save(name, [...chips, ...load(name).filter(c => !back.has(c.id))]);
    paint(name);
  };

  const composerOf = box => { const el = box.querySelector(':scope > .cbox2'); return el && el._c; };
  const boxesOf = name => [...document.querySelectorAll('[data-chat]')].filter(b => b.dataset.chat === name);
  const paint = name => { boxesOf(name).forEach(mount); marksSoon(); };

  const indexConv = conv => {
    const walker = document.createTreeWalker(conv, NodeFilter.SHOW_TEXT), parts = [], end = { at: 0 };
    while (walker.nextNode()) {
      const text = squeeze(walker.currentNode.nodeValue);
      if (text) { parts.push({ node: walker.currentNode, start: end.at, size: text.length, text }); end.at += text.length; }
    }
    return { parts, text: parts.map(p => p.text).join('') };
  };
  const pointAt = (parts, i) => {
    const part = parts.find(p => i < p.start + p.size);
    const solid = /\S/g;
    return { node: part.node, offset: Array.from({ length: i - part.start + 1 }, () => solid.exec(part.node.nodeValue)).pop().index };
  };
  const rangeOf = (index, chip) => {
    const needle = needleOf(chip.quote), start = nearestMatch(index.text, needle, chip.at);
    if (start < 0) return null;
    const from = pointAt(index.parts, start), to = pointAt(index.parts, start + needle.length - 1), range = document.createRange();
    range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset + 1);
    return range;
  };
  const paintMarks = () => {
    const ranges = [...document.querySelectorAll('[data-chat]')].flatMap(box => {
      const chips = load(box.dataset.chat), conv = chips.length && box.querySelector(':scope > .cscroll > .conv');
      if (!conv) return [];
      const index = indexConv(conv);
      return chips.map(chip => rangeOf(index, chip)).filter(Boolean);
    });
    if (ranges.length) CSS.highlights.set(MARK, new Highlight(...ranges)); else CSS.highlights.delete(MARK);
  };
  function marksSoon() {
    if (!window.Highlight || !window.CSS || !CSS.highlights || ui.marks) return;
    ui.marks = requestAnimationFrame(() => { ui.marks = 0; paintMarks(); });
  }
  const startOffset = (conv, range) => {
    if (!conv) return undefined;
    const before = document.createRange();
    before.selectNodeContents(conv);
    before.setEnd(range.startContainer, range.startOffset);
    return squeeze(before.toString()).length;
  };

  function chipEl(name, chip) {
    const box = () => input.closest('[data-chat]');
    const input = h('input', {
      class: 'qchip-ask', type: 'text', placeholder: chip.plan ? 'Your answer…' : 'Ask about this…', 'aria-label': chip.plan ? 'Answer to this question' : 'Question about this quote', enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'true',
      oninput: () => setAsk(name, chip.id, input.value),
      onkeydown: ev => {
        ev.stopPropagation();
        const c = composerOf(box());
        if (!c) return;
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); c.enter(ev.altKey); }
        else if (ev.key === 'Escape') { ev.preventDefault(); c.ta.focus(); }
      },
    });
    input.value = chip.ask;
    const el = h('div', { class: 'qchip' });
    el._id = chip.id;
    const more = chip.quote.includes('\n') || chip.quote.length > LONG_QUOTE
      ? h('button', { class: 'qchip-btn qchip-more', type: 'button', title: 'show the whole quote', 'aria-label': 'Show the whole quote', onmousedown: ev => ev.preventDefault(), onclick: () => el.classList.toggle('open') }, ico('chevronDown', 13))
      : null;
    el.append(
      h('div', { class: 'qchip-top' }, h('div', { class: 'qchip-q' }, chip.quote), more,
        h('button', { class: 'qchip-btn', type: 'button', title: 'remove this quote', 'aria-label': 'Remove this quote', onmousedown: ev => ev.preventDefault(), onclick: () => remove(name, chip.id) }, ico('x', 13))),
      input);
    el._input = input;
    return el;
  }

  const shownChip = (host, list) => list.find(c => c.id === host._active) || (list.length === 1 ? list[0] : null);
  function paintHead(host, list) {
    const { count, peek, toggle, drop } = host._head, open = host.classList.contains('open'), one = shownChip(host, list), label = trayLabel(list);
    const text = (one || list[list.length - 1] || { quote: '' }).quote.replace(/\s+/g, ' ').trim();
    if (count.textContent !== label) count.textContent = label;
    if (peek.textContent !== text) peek.textContent = text;
    drop.classList.toggle('hidden', open || !one);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = open ? 'hide the quotes' : 'show the quotes';
    for (const [id, el] of host._els) el.classList.toggle('active', id === host._active);
  }
  const reshape = (name, host, change) => {
    const sc = host.parentElement && host.parentElement.querySelector(':scope > .cscroll'), pinned = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
    change();
    paintHead(host, load(name));
    if (pinned) sc.scrollTop = sc.scrollHeight;
  };
  const showActive = host => {
    const el = host.classList.contains('open') && host._els.get(host._active);
    if (el) host._rows.scrollTop = el.offsetTop - host._rows.offsetTop;
  };
  const settleTray = host => setTimeout(() => {
    if (ui.down) { ui.afterUp = () => settleTray(host); return; }
    if (host.isConnected && (host._active || host.classList.contains('open')) && !host.contains(document.activeElement)) host._close();
  }, 0);
  function trayEl(name) {
    const host = h('div', { class: 'qchips',
      onfocusin: ev => { const chip = ev.target.closest('.qchip'); if (chip && chip._id !== host._active) reshape(name, host, () => { host._active = chip._id; }); },
      onfocusout: () => settleTray(host),
    });
    host._close = () => reshape(name, host, () => { host._active = null; host.classList.remove('open'); });
    const count = h('span', { class: 'qchips-n' }), peek = h('span', { class: 'qchips-peek' });
    const toggle = h('button', { class: 'qchips-toggle', type: 'button', onmousedown: ev => ev.preventDefault(), onclick: () => reshape(name, host, () => { host.classList.toggle('open'); showActive(host); }) }, count, peek, ico('chevronDown', 13));
    const drop = h('button', { class: 'qchip-btn qchips-drop', type: 'button', title: 'remove this quote', 'aria-label': 'Remove this quote', onmousedown: ev => ev.preventDefault(), onclick: () => { const chip = shownChip(host, load(name)); if (chip) remove(name, chip.id); } }, ico('x', 13));
    host._rows = h('div', { class: 'qchip-rows' });
    host._els = new Map();
    host._head = { count, peek, toggle, drop };
    host.append(h('div', { class: 'qchip-list' }, h('div', { class: 'qchips-head' }, toggle, drop), host._rows));
    return host;
  }

  function mount(box) {
    const name = box.dataset.chat, c = composerOf(box);
    if (!c) return;
    const list = load(name), found = box.querySelector(':scope > .qchips'), sc = box.querySelector(':scope > .cscroll');
    const pinned = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60, shown = found ? found._rows.children.length : 0;
    const active = found && found.contains(document.activeElement) && document.activeElement.classList.contains('qchip-ask') ? document.activeElement : null;
    if (list.length) {
      const host = found || trayEl(name), els = host._els;
      for (const id of els.keys()) if (!list.some(x => x.id === id)) els.delete(id);
      for (const chip of list) {
        if (!els.has(chip.id)) els.set(chip.id, chipEl(name, chip));
        const input = els.get(chip.id)._input;
        if (input !== document.activeElement && input.value !== chip.ask) input.value = chip.ask;
      }
      syncChildren(host._rows, list.map(chip => els.get(chip.id)));
      if (active && active.isConnected && document.activeElement !== active) { active.focus({ preventScroll: true }); showActive(host); }
      paintHead(host, list);
      const stack = box.querySelector(':scope > .qstack');
      if (!found) c.el.before(host);
      else if (stack && host.nextElementSibling === stack) host.before(stack);
    } else if (found) found.remove();
    if (active && !active.isConnected) c.ta.focus({ preventScroll: true });
    c.sync();
    if (pinned && list.length !== shown) sc.scrollTop = sc.scrollHeight;
  }

  const reveal = name => {
    const host = boxesOf(name).map(box => box.querySelector(':scope > .qchips')).find(Boolean);
    ui.reveal = host ? null : name;
    if (host) reshape(name, host, () => host.classList.add('open'));
  };

  const selected = () => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0), at = n => n.nodeType === 1 ? n : n.parentElement;
    const sc = at(range.startContainer)?.closest('.cscroll');
    if (!sc || !(sc.contains(range.endContainer) || range.endOffset === 0)) return null;
    const box = sc.closest('[data-chat]');
    if (!box || !composerOf(box)) return null;
    const text = capQuote(sel.toString());
    return text ? { range, sc, box, name: box.dataset.chat, text } : null;
  };

  const pill = () => ui.pill || (ui.pill = document.body.appendChild(h('button', { class: 'qpill hidden', type: 'button', tabindex: '-1', onmousedown: ev => ev.preventDefault(), oncontextmenu: ev => ev.preventDefault(), onclick: commit }, ico('chat', 14), 'Ask Claude')));
  const sibling = el => { if (FEAT.specAsk) FEAT.specAsk.follow(el, ui.cur && ui.cur.text, ui.cur && ui.cur.name); };
  const position = () => {
    if (!ui.pill && !ui.cur) return;
    const el = pill();
    if (!ui.cur || !ui.cur.range.startContainer.isConnected) { el.classList.add('hidden'); sibling(null); return; }
    el.classList.remove('hidden');
    const vv = window.visualViewport, view = vv ? { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height } : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const sc = ui.cur.sc.getBoundingClientRect();
    const box = { left: sc.left, right: sc.right, bottom: sc.bottom, top: sc.top + (parseFloat(getComputedStyle(ui.cur.sc).getPropertyValue('--chat-inset')) || 0) };
    const pos = (TOUCH ? dockPos : pillPos)([...ui.cur.range.getClientRects()], view, box, el.offsetWidth, el.offsetHeight);
    if (!pos) { el.classList.add('hidden'); sibling(null); return; }
    el.style.left = pos.left + 'px'; el.style.top = pos.top + 'px';
    sibling(el);
  };
  const schedule = () => { if (!ui.cur || ui.frame || ui.pressing) return; ui.frame = requestAnimationFrame(() => { ui.frame = 0; position(); }); };
  const watchScroller = () => { ui.ro = ui.ro || new ResizeObserver(schedule); ui.ro.disconnect(); if (ui.cur) ui.ro.observe(ui.cur.sc); };
  const refresh = () => { if (ui.pressing) return; ui.cur = ui.dragging ? null : selected(); watchScroller(); position(); };

  function commit() {
    clearTimeout(ui.timer);
    ui.pressing = false;
    const got = ui.cur;
    ui.cur = null;
    position();
    if (!got) return;
    const chip = add(got.name, got.text, startOffset(got.sc.querySelector(':scope > .conv'), got.range));
    getSelection().removeAllRanges();
    const host = got.box.isConnected && got.box.querySelector(':scope > .qchips');
    if (!host) return;
    reshape(got.name, host, () => { host._active = chip.id; host.classList.remove('open'); });
    host._els.get(chip.id)?._input.focus({ preventScroll: true });
  }

  document.addEventListener('selectionchange', () => {
    if (ui.pressing) return;
    clearTimeout(ui.timer);
    ui.timer = setTimeout(refresh, getSelection().isCollapsed ? 0 : SETTLE_MS);
  });
  const pointerDone = () => { ui.down = false; const next = ui.afterUp; ui.afterUp = null; if (next) next(); };
  document.addEventListener('focusin', ev => {
    const box = ev.target.closest && ev.target.closest('.cbox2') && ev.target.closest('[data-chat]'), host = box && box.querySelector(':scope > .qchips');
    if (host) settleTray(host);
  });
  document.addEventListener('pointerdown', ev => {
    ui.down = true;
    if (ev.target.closest && ev.target.closest('.qpill')) { clearTimeout(ui.timer); ui.pressing = true; return; }
    ui.pressing = false;
    if (ev.pointerType === 'mouse') { ui.dragging = true; ui.cur = null; position(); }
  }, true);
  document.addEventListener('pointerup', ev => {
    pointerDone();
    ui.dragging = false;
    if (!ui.pressing) { clearTimeout(ui.timer); ui.timer = setTimeout(refresh, 0); return; }
    const r = ui.pill.getBoundingClientRect(), inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    clearTimeout(ui.timer);
    ui.timer = setTimeout(() => { if (inside) commit(); else { ui.pressing = false; refresh(); } }, CLICK_WAIT_MS);
  }, true);
  document.addEventListener('pointercancel', () => { pointerDone(); ui.dragging = false; ui.pressing = false; clearTimeout(ui.timer); ui.timer = setTimeout(refresh, 0); }, true);
  document.addEventListener('click', ev => {
    const quote = ev.target.closest && ev.target.closest('.turn.user .mquote');
    if (quote && !ev.target.closest('a') && getSelection().isCollapsed) quote.classList.toggle('open');
  });
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule);
  if (window.visualViewport) { visualViewport.addEventListener('resize', schedule); visualViewport.addEventListener('scroll', schedule); }
  window.addEventListener('storage', ev => {
    if (!ev.key || !ev.key.startsWith(KEY)) return;
    const name = ev.key.slice(KEY.length);
    store.set(name, parse(ev.newValue));
    paint(name);
  });

  return { capQuote, blockquote, compose, parse, pillPos, dockPos, quotesLabel, trayLabel, needleOf, nearestMatch, pointAt, chipEl, load, has, message, add, addAnswer, answerOf, answerMark, keepAnswers, setAsk, remove, take, restore, reveal, composerShown(box) { mount(box); if (ui.reveal === box.dataset.chat) reveal(ui.reveal); schedule(); marksSoon(); } };
})();
