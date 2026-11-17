'use strict';
FEAT.fullscreen = (() => {
  const root = document.documentElement;
  const supported = typeof root.requestFullscreen === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
  const on = () => !!document.fullscreenElement;
  const kb = navigator.keyboard;
  const lockEsc = () => { if (kb && kb.lock) kb.lock(['Escape']).catch(() => {}); };
  const unlockEsc = () => { if (kb && kb.unlock) kb.unlock(); };
  const locks = !!(kb && kb.lock);
  const swallowHeld = e => { if (e.key === 'Escape' && e.repeat && document.fullscreenElement) { e.preventDefault(); e.stopImmediatePropagation(); } };
  const guard = w => { try { if (w) w.addEventListener('keydown', swallowHeld, true); } catch {} };
  const guardFrames = () => { for (const f of document.querySelectorAll('iframe')) guard(f.contentWindow); };
  const ENTER = '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>';
  const LEAVE = '<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>';

  async function toggle() {
    if (on()) { unlockEsc(); await document.exitFullscreen().catch(() => {}); return; }
    try { await root.requestFullscreen({ navigationUI: 'hide' }); lockEsc(); }
    catch { toast('Full screen is not available here', 'err'); }
  }

  const btn = supported ? h('button', { class: 'btn ghost icon', id: 'btn-fullscreen', onclick: toggle }) : null;
  function paint() {
    if (!btn) return;
    const label = on() ? 'Leave full screen (or hold Esc)' : locks ? 'Full screen: Esc closes dialogs, hold Esc to leave' : 'Full screen';
    btn.title = label; btn.setAttribute('aria-label', label);
    btn.innerHTML = `<svg class="ico" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${on() ? LEAVE : ENTER}</svg>`;
  }
  if (btn) {
    const bar = $('.topbtns');
    if (bar) bar.insertBefore(btn, $('#btn-settings'));
    guard(window);
    document.addEventListener('load', e => { if (on() && e.target && e.target.tagName === 'IFRAME') guard(e.target.contentWindow); }, true);
    document.addEventListener('fullscreenchange', () => { if (on()) { lockEsc(); guardFrames(); } else unlockEsc(); paint(); });
    paint();
  }

  function paletteItems() {
    if (!supported) return [];
    return [{ kind: 'action', label: on() ? 'Leave full screen' : 'Full screen', sub: 'Esc closes dialogs instead of leaving; hold Esc to leave', icon: '⛶', hay: 'full screen fullscreen maximize escape esc', run: toggle, rank: 29 }];
  }

  return { paletteItems, toggle };
})();
