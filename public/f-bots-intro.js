'use strict';
FEAT.botsIntro = (() => {
  const KEY = 'bd.bots.intro';
  const VERSION = 1;
  const SAMPLE = {
    db: { name: 'db', iconKey: 'database', iconColor: '#84cc16' },
    writer: { name: 'writer', iconKey: 'write', iconColor: '#eab308' },
    vault: { name: 'vault', iconKey: 'security', iconColor: '#8b5cf6' },
    reviewer: { name: 'reviewer', iconKey: 'review', iconColor: '#06b6d4' },
    helper: { name: 'helper', iconKey: 'robot', iconColor: '#4f7cff' }
  };
  const STEPS = [
    {
      title: 'A bot is a helper with its own chat',
      body: 'Each bot keeps its own instructions, its own memory and its own plan. Give it one job and it gets better at that job the more you use it.',
      bots: ['db', 'writer', 'reviewer']
    },
    {
      title: 'Passwords and keys stay private',
      body: 'Add them in the bot\'s settings. They are stored only on this machine, in the bot\'s private folder. They are never committed, never shown to your other chats, and only this bot gets them.',
      bots: ['vault']
    },
    {
      title: 'Use a bot from any chat',
      body: 'In any chat, say "ask the db bot how many people signed up today". In a terminal, run bd-bot. Every call opens as its own chat under the bot, and you can pick it up and continue it.',
      bots: ['helper', 'db']
    },
    {
      title: 'Teach it by talking',
      body: 'In the bot\'s own chat, just say "remember that we always use UTC". It writes the note itself. Changed your mind? Undo it in the bot\'s settings.',
      bots: ['writer']
    }
  ];
  const SWIPE_MIN = 50;

  const state = { step: 0, onKey: null, touchX: null };

  const stored = () => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  };
  const seenCurrent = () => {
    const raw = stored();
    return raw !== null && /^\d+$/.test(raw) && Number(raw) >= VERSION;
  };
  const remember = () => {
    try { localStorage.setItem(KEY, String(VERSION)); } catch { return; }
  };

  const isOpen = () => state.onKey !== null;

  function close() {
    if (!isOpen()) return;
    document.removeEventListener('keydown', state.onKey, true);
    state.onKey = null;
    const m = $('#modal');
    m.classList.add('hidden');
    m.onclick = null;
    m.replaceChildren();
    remember();
  }

  function go(to) {
    if (to < 0) return;
    if (to >= STEPS.length) { close(); return; }
    state.step = to;
    render();
  }

  function trap(e, box) {
    const els = [...box.querySelectorAll('button')].filter(b => !b.disabled);
    if (!els.length) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function render() {
    const step = STEPS[state.step];
    const last = state.step === STEPS.length - 1;
    const dots = h('div', { class: 'bi-dots', role: 'group', 'aria-label': `Step ${state.step + 1} of ${STEPS.length}` },
      STEPS.map((_, i) => h('button', { class: 'bi-dot' + (i === state.step ? ' on' : ''), type: 'button', 'aria-label': `Step ${i + 1}`, 'aria-current': i === state.step ? 'step' : null, onclick: () => go(i) })));
    const next = h('button', { class: 'btn primary bi-next', type: 'button', onclick: () => go(state.step + 1) }, last ? 'Done' : 'Next');
    const back = h('button', { class: 'btn bi-back', type: 'button', disabled: state.step === 0, onclick: () => go(state.step - 1) }, 'Back');
    const art = h('div', { class: 'bi-art', 'aria-hidden': 'true' }, step.bots.map((k, i) => h('div', { class: 'bi-tile bi-t' + i }, BOT_ICON.tile(SAMPLE[k], 56))));
    const box = h('div', { class: 'box bi-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bi-title' },
      art,
      h('h3', { id: 'bi-title', class: 'bi-title' }, step.title),
      h('p', { class: 'bi-body' }, step.body),
      h('div', { class: 'bi-foot' }, back, dots, next));
    box.addEventListener('touchstart', e => { state.touchX = e.changedTouches[0].clientX; }, { passive: true });
    box.addEventListener('touchend', e => {
      const from = state.touchX;
      state.touchX = null;
      if (from === null) return;
      const dx = e.changedTouches[0].clientX - from;
      if (dx <= -SWIPE_MIN) go(state.step + 1);
      else if (dx >= SWIPE_MIN) go(state.step - 1);
    }, { passive: true });
    const m = $('#modal');
    m.replaceChildren(box);
    m.onclick = e => { if (e.target === m) close(); };
    next.focus();
    if (state.onKey) document.removeEventListener('keydown', state.onKey, true);
    state.onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(state.step + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(state.step - 1); }
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); go(state.step + 1); }
      else if (e.key === 'Tab') trap(e, box);
    };
    document.addEventListener('keydown', state.onKey, true);
  }

  function open() {
    state.step = 0;
    $('#modal').classList.remove('hidden');
    render();
  }

  function maybeOpen() {
    if (seenCurrent()) return false;
    if (!$('#modal').classList.contains('hidden')) return false;
    open();
    return true;
  }

  return { open, maybeOpen };
})();
