'use strict';
FEAT.quotes = (() => {
  const CAP = 4000, KEY = 'bd.quotes.', GAP = 8, BELOW_GAP = 28, SETTLE_MS = 120, CLICK_WAIT_MS = 300, LONG_QUOTE = 60;
  const store = new Map();
  const ui = { cur: null, pressing: false, dragging: false, timer: 0, frame: 0, pill: null };

  const clean = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  const capQuote = s => {
    const t = clean(s);
    if (t.length <= CAP) return t;
    const head = t.slice(0, CAP - 1), nl = head.lastIndexOf('\n');
    return (nl > 0 ? head.slice(0, nl).trimEnd() : head.replace(/[\uD800-\uDBFF]$/, '')) + '…';
  };
  const blockquote = q => q.split('\n').map(l => '> ' + l).join('\n');
  const compose = (chips, text) => [...chips.flatMap(c => [blockquote(c.quote), String(c.ask ?? '').trim()]), String(text ?? '').trim()].filter(Boolean).join('\n\n');
  const parse = raw => {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter(c => c && typeof c.id === 'string' && typeof c.quote === 'string' && c.quote).map(c => ({ id: c.id, quote: c.quote, ask: typeof c.ask === 'string' ? c.ask : '' })) : [];
    } catch { return []; }
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const pillPos = (rects, view, box, w, ht, below) => {
    const seen = rects.filter(r => r.width > 0 && r.bottom > box.top && r.top < box.bottom);
    if (!seen.length) return null;
    const line = below ? seen[seen.length - 1] : seen[0];
    const minY = Math.max(box.top, view.top) + GAP, maxY = Math.min(box.bottom, view.bottom) - ht - GAP;
    const under = line.bottom + (below ? BELOW_GAP : GAP), over = line.top - ht - GAP;
    const y = below ? (under <= maxY ? under : over) : (over >= minY ? over : under);
    return { left: clamp(line.left + line.width / 2 - w / 2, Math.max(box.left, view.left) + GAP, Math.min(box.right, view.right) - w - GAP), top: clamp(y, minY, maxY) };
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
  const isCommand = typed => typed.startsWith('/');
  const message = (name, typed) => compose(isCommand(typed) ? [] : load(name), typed);
  const add = (name, text) => {
    const chip = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), quote: capQuote(text), ask: '' };
    save(name, [...load(name), chip]);
    paint(name);
    return chip;
  };
  const setAsk = (name, id, ask) => { save(name, load(name).map(c => c.id === id ? { ...c, ask } : c)); paint(name); };
  const remove = (name, id) => { save(name, load(name).filter(c => c.id !== id)); paint(name); };
  const take = (name, typed = '') => { if (isCommand(typed)) return []; const chips = load(name); save(name, []); paint(name); return chips; };
  const restore = (name, chips) => {
    const back = new Set(chips.map(c => c.id));
    save(name, [...chips, ...load(name).filter(c => !back.has(c.id))]);
    paint(name);
  };

  const composerOf = box => { const el = box.querySelector(':scope > .cbox2'); return el && el._c; };
  const boxesOf = name => [...document.querySelectorAll('[data-chat]')].filter(b => b.dataset.chat === name);
  const paint = name => boxesOf(name).forEach(mount);

  function chipEl(name, chip) {
    const box = () => input.closest('[data-chat]');
    const input = h('input', {
      class: 'qchip-ask', type: 'text', placeholder: 'Ask about this…', 'aria-label': 'Question about this quote', enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'true',
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
    const more = chip.quote.includes('\n') || chip.quote.length > LONG_QUOTE
      ? h('button', { class: 'qchip-btn qchip-more', type: 'button', title: 'show the whole quote', 'aria-label': 'Show the whole quote', onclick: () => el.classList.toggle('open') }, ico('chevronDown', 13))
      : null;
    el.append(
      h('div', { class: 'qchip-top' }, h('div', { class: 'qchip-q' }, chip.quote), more,
        h('button', { class: 'qchip-btn', type: 'button', title: 'remove this quote', 'aria-label': 'Remove this quote', onclick: () => remove(name, chip.id) }, ico('x', 13))),
      input);
    el._input = input;
    return el;
  }

  function mount(box) {
    const name = box.dataset.chat, c = composerOf(box);
    if (!c) return;
    const list = load(name), found = box.querySelector(':scope > .qchips'), sc = box.querySelector(':scope > .cscroll');
    const pinned = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60, shown = found ? found.firstElementChild.children.length : 0;
    const active = found && found.contains(document.activeElement) && document.activeElement.classList.contains('qchip-ask') ? document.activeElement : null;
    if (list.length) {
      const rows = found ? found.firstElementChild : h('div', { class: 'qchip-list' });
      const host = found || h('div', { class: 'qchips' }, rows);
      const els = host._els || (host._els = new Map());
      for (const id of els.keys()) if (!list.some(x => x.id === id)) els.delete(id);
      for (const chip of list) {
        if (!els.has(chip.id)) els.set(chip.id, chipEl(name, chip));
        const input = els.get(chip.id)._input;
        if (input !== document.activeElement && input.value !== chip.ask) input.value = chip.ask;
      }
      syncChildren(rows, list.map(chip => els.get(chip.id)));
      const stack = box.querySelector(':scope > .qstack');
      if (!found) c.el.before(host);
      else if (stack && host.nextElementSibling === stack) host.before(stack);
    } else if (found) found.remove();
    if (active && !active.isConnected) c.ta.focus({ preventScroll: true });
    c.sync();
    if (pinned && list.length !== shown) sc.scrollTop = sc.scrollHeight;
  }

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
  const position = () => {
    if (!ui.pill && !ui.cur) return;
    const el = pill();
    if (!ui.cur || !ui.cur.range.startContainer.isConnected) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const vv = window.visualViewport, view = vv ? { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height } : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const pos = pillPos([...ui.cur.range.getClientRects()], view, ui.cur.sc.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, IS_PHONE || TOUCH);
    if (!pos) { el.classList.add('hidden'); return; }
    el.style.left = pos.left + 'px'; el.style.top = pos.top + 'px';
  };
  const schedule = () => { if (!ui.cur || ui.frame) return; ui.frame = requestAnimationFrame(() => { ui.frame = 0; position(); }); };
  const refresh = () => { if (ui.pressing) return; ui.cur = ui.dragging ? null : selected(); position(); };

  function commit() {
    clearTimeout(ui.timer);
    ui.pressing = false;
    const got = ui.cur;
    ui.cur = null;
    position();
    if (!got) return;
    add(got.name, got.text);
    getSelection().removeAllRanges();
    const input = got.box.isConnected && [...got.box.querySelectorAll(':scope > .qchips .qchip-ask')].pop();
    if (input) input.focus({ preventScroll: true });
  }

  document.addEventListener('selectionchange', () => {
    if (ui.pressing) return;
    clearTimeout(ui.timer);
    ui.timer = setTimeout(refresh, getSelection().isCollapsed ? 0 : SETTLE_MS);
  });
  document.addEventListener('pointerdown', ev => {
    if (ev.target.closest && ev.target.closest('.qpill')) { clearTimeout(ui.timer); ui.pressing = true; return; }
    ui.pressing = false;
    if (ev.pointerType === 'mouse') { ui.dragging = true; ui.cur = null; position(); }
  }, true);
  document.addEventListener('pointerup', ev => {
    ui.dragging = false;
    if (!ui.pressing) { clearTimeout(ui.timer); ui.timer = setTimeout(refresh, 0); return; }
    const r = ui.pill.getBoundingClientRect(), inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    clearTimeout(ui.timer);
    ui.timer = setTimeout(() => { if (inside) commit(); else { ui.pressing = false; refresh(); } }, CLICK_WAIT_MS);
  }, true);
  document.addEventListener('pointercancel', () => { ui.dragging = false; ui.pressing = false; clearTimeout(ui.timer); ui.timer = setTimeout(refresh, 0); }, true);
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule);
  if (window.visualViewport) { visualViewport.addEventListener('resize', schedule); visualViewport.addEventListener('scroll', schedule); }
  window.addEventListener('storage', ev => {
    if (!ev.key || !ev.key.startsWith(KEY)) return;
    const name = ev.key.slice(KEY.length);
    store.set(name, parse(ev.newValue));
    paint(name);
  });

  return { capQuote, blockquote, compose, parse, pillPos, chipEl, load, has, message, add, setAsk, remove, take, restore, composerShown(box) { mount(box); schedule(); } };
})();
