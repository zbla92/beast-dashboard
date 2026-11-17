'use strict';
FEAT.fullscreen = (() => {
  const root = document.documentElement;
  const kb = navigator.keyboard;
  const AGAIN_MS = 2500;
  const supported = typeof root.requestFullscreen === 'function' && !!(kb && kb.lock) && matchMedia('(hover: hover) and (pointer: fine)').matches;
  const HELD_MS = 3000;
  const MODIFIERS = ['Meta', 'Shift', 'Control', 'Alt', 'AltGraph', 'CapsLock', 'Fn'];
  const st = { armedAt: 0, escAt: 0, optedOut: false, pending: false, refused: false };
  const pageFull = () => !!document.fullscreenElement;
  const windowFull = () => matchMedia('(display-mode: fullscreen)').matches || (outerWidth === screen.width && outerHeight === screen.height && screenX === 0 && screenY === 0);
  const activated = () => !navigator.userActivation || navigator.userActivation.isActive;
  const lockEsc = () => kb.lock(['Escape']).catch(() => {});
  const unlockEsc = () => { if (kb.unlock) kb.unlock(); };
  const swallow = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  const swallowHeld = e => { if (e.key === 'Escape' && e.repeat && pageFull()) { st.escAt = Date.now(); swallow(e); } };
  const guard = w => { try { if (w) w.addEventListener('keydown', swallowHeld, true); } catch {} };

  function grab(e) {
    if (pageFull() || st.optedOut || st.pending || st.refused || !windowFull()) return;
    if (e.type === 'keydown' && (e.key === 'Escape' || MODIFIERS.includes(e.key))) return;
    if (!activated()) return;
    st.pending = true;
    root.requestFullscreen({ navigationUI: 'hide' })
      .then(lockEsc, () => { st.refused = true; })
      .finally(() => { st.pending = false; });
  }

  function leave() {
    st.optedOut = true; st.armedAt = 0;
    unlockEsc();
    document.exitFullscreen().catch(() => {});
  }

  function onEsc(e) {
    if (e.key !== 'Escape' || !e.isTrusted || !pageFull()) return;
    st.escAt = Date.now();
    if (e.repeat) return swallow(e);
    if (st.armedAt && Date.now() - st.armedAt < AGAIN_MS) { swallow(e); leave(); return; }
    st.armedAt = Date.now();
    toast('Press Esc again to leave full screen');
  }

  if (supported) {
    window.addEventListener('pointerdown', grab, true);
    window.addEventListener('keydown', grab, true);
    window.addEventListener('keydown', onEsc, true);
    window.addEventListener('resize', () => { if (!pageFull() && !windowFull()) st.optedOut = false; });
    document.addEventListener('load', e => { if (pageFull() && e.target && e.target.tagName === 'IFRAME') guard(e.target.contentWindow); }, true);
    document.addEventListener('fullscreenchange', () => {
      if (pageFull()) { lockEsc(); for (const f of document.querySelectorAll('iframe')) guard(f.contentWindow); return; }
      unlockEsc(); st.armedAt = 0;
      if (st.escAt && Date.now() - st.escAt < HELD_MS) st.optedOut = true;
    });
  }

  return { supported };
})();
