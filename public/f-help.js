'use strict';
FEAT.help = (() => {
  ICONS.help = '<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.5a2.4 2.4 0 0 1 4.6.9c0 1.6-2.3 2-2.3 3.5"/><circle cx="12" cy="16.9" r=".6" fill="currentColor"/>';
  const TINTS = ['var(--purple)', 'var(--cyan)', 'var(--amber)', 'var(--green)', 'var(--pink)', 'var(--indigo)', 'var(--blue)', 'var(--red)'];
  const POP = { box: null, scrim: null, anchor: null, off: null, layered: false };
  const LAYER = { el: null, layered: false };
  const find = id => HELP.find(t => t.id === id) || null;
  const tintOf = t => TINTS[Math.max(0, HELP.indexOf(t)) % TINTS.length];
  const isPhone = () => matchMedia('(max-width: 900px)').matches;
  const badge = (t, size, cls) => h('span', { class: cls, style: `--tint:${tintOf(t)}` }, ico(t.icon, size));

  function closeTip(pop = true, refocus = false) {
    if (!POP.box) return;
    const { anchor, layered } = POP;
    POP.off();
    POP.box.remove();
    if (POP.scrim) POP.scrim.remove();
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
    Object.assign(POP, { box: null, scrim: null, anchor: null, off: null, layered: false });
    if (layered && pop) popLayer();
    if (refocus && anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
  }

  const closeTipFocus = () => closeTip(true, true);

  function closeLayer(pop = true) {
    if (!LAYER.el) return;
    const { layered } = LAYER;
    LAYER.el.remove();
    Object.assign(LAYER, { el: null, layered: false });
    if (layered && pop) popLayer();
  }

  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || (!POP.box && !LAYER.el)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (POP.box) closeTipFocus(); else closeLayer();
  }, true);

  function place(box, anchor) {
    const r = anchor.getBoundingClientRect(), pad = 8;
    const w = box.offsetWidth, bh = box.offsetHeight;
    box.style.left = Math.max(pad, Math.min(r.left - 12, innerWidth - w - pad)) + 'px';
    const below = r.bottom + 6, above = r.top - bh - 6;
    box.style.top = Math.max(pad, below + bh > innerHeight - pad && above >= pad ? above : Math.min(below, innerHeight - bh - pad)) + 'px';
  }

  function openTip(anchor, t) {
    closeTip();
    const phone = isPhone();
    const box = h('div', { class: 'hp-pop' + (phone ? ' phone' : ''), role: 'dialog', 'aria-label': t.title, onclick: ev => ev.stopPropagation() },
      phone ? h('div', { class: 'hp-grab' }) : null,
      h('div', { class: 'hp-pop-h' }, badge(t, 15, 'hp-pop-ic'), h('b', null, t.title), h('button', { class: 'hp-x', 'aria-label': 'close', onclick: closeTipFocus }, ico('x', 14))),
      h('p', { class: 'hp-pop-t' }, t.short),
      h('button', { class: 'hp-more', onclick: () => { closeTip(); open(t.id); } }, 'Learn more', ico('chevronRight', 13)));
    const scrim = phone ? h('div', { class: 'hp-scrim', onclick: ev => { ev.stopPropagation(); closeTip(); } }) : null;
    const onDown = e => { if (!box.contains(e.target) && !anchor.contains(e.target) && !(scrim && scrim === e.target)) closeTip(); };
    const onScroll = e => { if (!box.contains(e.target)) closeTip(); };
    document.addEventListener('pointerdown', onDown, true);
    if (!phone) { document.addEventListener('scroll', onScroll, true); addEventListener('resize', closeTip); }
    const off = () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', closeTip);
    };
    Object.assign(POP, { box, scrim, anchor, off, layered: phone });
    if (phone) pushLayer('tip');
    anchor.setAttribute('aria-expanded', 'true');
    document.body.append(...[scrim, box].filter(Boolean));
    if (!phone) place(box, anchor);
    box.querySelector('.hp-more').focus({ preventScroll: true });
  }

  const toggleTip = (anchor, t) => { if (POP.anchor === anchor) closeTip(); else openTip(anchor, t); };

  function tip(id) {
    const t = find(id); if (!t) return null;
    const hit = ev => { ev.preventDefault(); ev.stopPropagation(); toggleTip(b, t); };
    const b = h('span', { class: 'hp-q', role: 'button', tabindex: '0', title: 'What is this?', 'aria-label': 'Help: ' + t.title, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      onclick: hit, onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') hit(ev); } }, ico('help', 15));
    return b;
  }

  function pane(t) {
    return h('section', { class: 'sm-pane hp-pane', 'data-sec': t.id },
      h('div', { class: 'sg-t' }, badge(t, 16, 'sg-ic'), t.title),
      h('p', { class: 'hp-lead' }, t.short),
      t.sections.map(s => h('div', { class: 'hp-sec' }, h('h4', null, s.h), h('div', { class: 'ttext hp-md', html: mdLite(s.md) }))),
      t.docs ? h('p', { class: 'hp-docs' }, 'Full reference: ', h('code', null, t.docs), ' in the beast-dash repo') : null);
  }

  function open(id) {
    closeTip();
    const panes = new Map();
    const title = h('h3', null, 'Help');
    const main = h('div', { class: 'sm-main' });
    const close = () => closeLayer();
    const back = h('button', { class: 'btn sm ghost icon sm-back', title: 'back', 'aria-label': 'back', onclick: () => { box.classList.remove('sm-open'); title.textContent = 'Help'; } }, ico('arrowLeft', 15));
    const items = HELP.map(t => h('button', { class: 'sm-item', 'data-sec': t.id, style: `--tint:${tintOf(t)}`, onclick: () => show(t.id, true) }, badge(t, 16, 'sm-ico'), h('span', { class: 'sm-nm' }, t.title), h('span', { class: 'sm-go' }, ico('chevronRight', 14))));
    const wrap = h('div', { class: 'sbody sm-wrap' }, h('nav', { class: 'sm-nav', 'aria-label': 'Help topics' }, items), main);
    const show = (want, opened) => {
      const cur = find(want) || HELP[0];
      if (!panes.has(cur.id)) { const p = pane(cur); panes.set(cur.id, p); main.append(p); }
      for (const [k, p] of panes) p.classList.toggle('on', k === cur.id);
      for (const i of items) i.classList.toggle('on', i.dataset.sec === cur.id);
      title.textContent = opened && isPhone() ? cur.title : 'Help';
      box.classList.toggle('sm-open', !!opened);
      main.scrollTop = 0;
      wrap.scrollTop = 0;
    };
    const box = h('div', { class: 'box settings setmodal hpmodal' },
      h('div', { class: 'sh' }, back, title, h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', 'aria-label': 'close', onclick: close }, ico('x', 15))),
      wrap);
    const had = !!LAYER.el;
    const layer = h('div', { class: 'modal hp-layer', onclick: e => { if (e.target === layer) close(); } }, box);
    if (had) closeLayer(false);
    document.body.append(layer);
    Object.assign(LAYER, { el: layer, layered: true });
    if (!had) pushLayer('help');
    show(id, !!find(id));
  }

  function header() {
    const top = $('.topbtns'); if (!top || $('#btn-help')) return;
    top.insertBefore(h('button', { class: 'btn ghost icon', id: 'btn-help', title: 'Help: what each part of beast-dash does', 'aria-label': 'Help', onclick: () => open() }, ico('help', 18)), $('#btn-settings'));
  }
  header();

  function paletteItems() {
    return [
      { kind: 'action', label: 'Help', sub: 'what each part of beast-dash does', icon: 'help', hay: 'help docs guide how what explain', run: () => open(), rank: 35 },
      ...HELP.map(t => ({ kind: 'action', label: 'Help: ' + t.title, sub: t.short, icon: t.icon, hay: `help ${t.id} ${t.title}`, run: () => open(t.id), rank: 50 })),
    ];
  }

  function deepLink(q) {
    if (!q.has('help')) return false;
    history.replaceState(history.state, '', location.pathname);
    open(q.get('help') || null);
    return true;
  }

  window.helpTip = tip;
  return { paletteItems, deepLink, open, closeTip, closeLayer, tipOpen: () => !!POP.box, layerOpen: () => !!LAYER.el };
})();
