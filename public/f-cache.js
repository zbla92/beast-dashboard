'use strict';
FEAT.cache = (() => {
  const BIG = 100000, SOON = 5;
  const dismissed = new Map();

  function view(cl) {
    const c = cl && cl.cache; if (!c) return { text: '', cls: 'ccache', title: '', offer: false };
    if (!c.cold) return { text: c.min + 'm', cls: 'ccache' + (c.min <= SOON ? ' ccache-warn' : ''), title: `Cache warm for ${c.min} more min`, offer: false };
    const big = !!cl.ctx && cl.ctx.used >= BIG;
    return { text: 'cold', cls: 'ccache' + (big ? ' ccache-warn' : ''), title: 'Cache cold: the next message re-reads the context uncached', offer: big && cl.mode === 'chat' };
  }

  function paint(el, cl) {
    const v = view(cl);
    if (el.textContent !== v.text) el.textContent = v.text;
    if (el.className !== v.cls) el.className = v.cls;
    if (el.title !== v.title) el.title = v.title;
  }

  function ctxChip(cl) { const el = h('span', { class: 'ccache' }); paint(el, cl); return el; }

  function notice(name, cl) {
    const el = h('div', { class: 'ccold' },
      h('span', { class: 'ccold-t' }, `Cache expired: your next message re-reads ${fmtTok(cl.ctx.used)} uncached. Send anyway, or`),
      h('button', { class: 'btn sm', title: 'also re-reads the context once, but every turn after it starts small', onclick: () => compactSession(name) }, 'Compact'),
      h('button', { class: 'btn sm', title: 're-reads nothing: starts with an empty context, this conversation stays as it is', onclick: () => newChatHere(name) }, 'New chat'),
      h('button', { class: 'btn sm ghost', title: 'hide until this chat runs again', 'aria-label': 'Hide', onclick: () => { dismissed.set(name, cl.usage && cl.usage.cacheAt); reshape(el.parentElement, () => el.remove()); } }, ico('x', 13)));
    return el;
  }

  function reshape(box, change) {
    const sc = box && box.querySelector(':scope > .cscroll'), pinned = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
    change(sc);
    if (pinned) sc.scrollTop = sc.scrollHeight;
  }

  function paintBox(box) {
    const name = box.dataset.chat, cl = claudeOf(name), found = box.querySelector(':scope > .ccold');
    const on = view(cl).offer && dismissed.get(name) !== (cl.usage && cl.usage.cacheAt);
    if (on && !found) reshape(box, sc => { if (sc) sc.after(notice(name, cl)); });
    else if (!on && found) reshape(box, () => found.remove());
  }

  function onState() {
    for (const el of document.querySelectorAll('.ctxm[data-s] > .ccache')) paint(el, claudeOf(el.parentElement.dataset.s));
    for (const box of document.querySelectorAll('[data-chat]')) paintBox(box);
  }

  return { view, ctxChip, onState, composerShown: paintBox };
})();
