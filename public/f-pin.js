'use strict';
// F: the question stays pinned while you read a long reply. Registers FEAT.pin { conversation }.
// One button laid over the top of the chat, outside .cscroll: it can't move or resize the scroller, syncChildren never
// touches it, and it only follows where the turns are right now, so replaced turn nodes don't matter.
(() => {
  const GAP = 8, MAX = 500;   // px left above the question after a tap; characters handed to the two-line clamp
  const BAND = 60;            // at least the pin's height: a question this close to the top edge is on screen and the pin would cover it
  const textOf = q => trim1((q.querySelector(':scope > .ttext')?.textContent || '').replace(/\s+/g, ' ').trim(), MAX) || 'your message';

  function questionAt(conv, top) {
    const us = conv.querySelectorAll(':scope > .turn.user');
    let i = us.length - 1;
    while (i >= 0 && us[i].getBoundingClientRect().top >= top + BAND) i--;
    if (i < 0) return null;
    const q = us[i];
    if (q.getBoundingClientRect().bottom > top) return null;   // still on screen, even if only its end
    if (q.matches('.pending, .queued, .shell')) return null;   // not (yet) a question with a reply below it; never look past it to an older one
    return q;
  }

  function attach(conv, box) {
    const scroller = conv.parentElement;
    let cur = null, raf = 0;
    const txt = h('span', { class: 'qpin-t' });
    // positioned inline: if f-pin.css ever fails to load, the pin is plain but still stays out of the scroller's way
    const pin = h('button', { class: 'qpin hidden', style: 'position:absolute;top:0;left:0;right:0', title: 'back to the start of this question and its reply', onclick: () => {
      if (!cur || !cur.isConnected) return;
      scroller.scrollTop += cur.getBoundingClientRect().top - scroller.getBoundingClientRect().top - GAP;
    } }, ico('arrowUp', 14), txt);
    const update = () => {
      raf = 0;
      if (!scroller.isConnected) { st.stop(); return; }
      const r = scroller.getBoundingClientRect(), q = r.height ? questionAt(conv, r.top) : null;   // no height: Terminal view, panel closed
      if (q === cur) return;
      cur = q; pin.classList.toggle('hidden', !q);
      if (!q) return;
      const s = textOf(q); if (txt.textContent !== s) txt.textContent = s;
      pin.style.right = scroller.offsetWidth - scroller.clientWidth + 'px';   // leave the scrollbar uncovered
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    const ro = new ResizeObserver(schedule);   // no scroll event for these: Focus, tool rows opening, the reply growing, the keyboard
    const st = { conv, schedule, stop() { cancelAnimationFrame(raf); ro.disconnect(); scroller.removeEventListener('scroll', schedule); pin.remove(); if (box._qpin === st) box._qpin = null; } };
    box.append(pin);
    scroller.addEventListener('scroll', schedule, { passive: true });
    ro.observe(conv); ro.observe(scroller);
    return st;
  }

  FEAT.pin = {
    conversation(name, conv, box) {
      const st = box._qpin;
      if (st && st.conv === conv) { st.schedule(); return; }
      if (st) st.stop();   // another chat in the same pane
      queueMicrotask(() => { if (conv.parentElement) box._qpin = attach(conv, box); });   // a new conv goes into its scroller right after this hook
    },
  };
})();
