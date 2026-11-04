'use strict';
// F: emu — Android emulator. Registers FEAT.emu: Home tile, modal "Android", key a, palette, ?emu=1.
(() => {
  const EMU = { st: null, at: 0, loading: false, tile: null, tileSig: '', thumbT: 0, serial: localStorage.getItem('bd.emu.serial') || null, modal: null };
  const usable = () => (EMU.st?.devices || []).filter(d => d.state === 'device');
  const devName = d => d.avd || d.model || d.serial;
  const sig = st => JSON.stringify((st?.devices || []).map(d => [d.serial, d.state, d.booted, d.avd]));

  async function load(force) {
    if (EMU.loading || (!force && Date.now() - EMU.at < 4000)) return EMU.st;
    EMU.loading = true;
    try {
      const before = sig(EMU.st);
      EMU.st = await api('emu'); EMU.at = Date.now();
      if (usable().length) EMU.seen = Date.now();
      if (before !== sig(EMU.st)) { if (typeof renderFeatHome === 'function') renderFeatHome(); EMU.modal?.refresh(); }
    } catch { /* adb missing or server busy: keep the last answer */ }
    EMU.loading = false;
    return EMU.st;
  }
  // Keep the device list fresh, but only while someone looks: Home view visible, or the Android modal open.
  // Every miss costs the server several adb/ps calls, so it backs off to 60 s when the SDK is missing or no device was
  // seen for 5 minutes (modal closed). The loop stops by itself when Home is not shown or the tab is hidden, and is
  // restarted by homeTiles() (each Home render), openModal() and visibilitychange.
  let pollT = 0;
  const modalOpen = () => !!EMU.modal?.live();
  const wanted = () => !document.hidden && (modalOpen() || (typeof UI !== 'undefined' && UI.view === 'home'));
  function pollDelay() {
    if (modalOpen()) return 8000;
    if (EMU.st && EMU.st.sdk === false) return 60000;
    if (EMU.seen && Date.now() - EMU.seen > 300000) return 60000;
    return 8000;
  }
  function poll() {
    if (pollT || !wanted()) return;
    if (!EMU.seen) EMU.seen = Date.now();   // grace: 5 min of fast polling before the first device is seen
    const tick = () => {
      pollT = 0;
      if (!wanted()) return;                // stopped; restarted on the next Home render / modal open / tab show
      load(true);
      pollT = setTimeout(tick, pollDelay());
    };
    tick();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  // ---------- Home tile (same element every call, updated in place) ----------
  function tile() {
    if (!EMU.tile) {
      const img = h('img', { class: 'emu-thumb', alt: '', draggable: 'false' });
      EMU.tile = { el: h('button', { class: 'emu-tile', type: 'button', title: 'Open the Android emulator', onclick: () => openModal() },
        h('span', { class: 'emu-thumbwrap' }, img), h('span', { class: 'emu-tinfo' }, h('b', { class: 'emu-tname' }), h('span', { class: 'emu-tsub dim' })), h('span', { class: 'emu-tgo' }, 'Open ›')), img, name: null, sub: null };
      EMU.tile.name = EMU.tile.el.querySelector('.emu-tname'); EMU.tile.sub = EMU.tile.el.querySelector('.emu-tsub');
      setInterval(thumb, 5000);
    }
    const t = EMU.tile, d = usable().find(x => x.serial === EMU.serial) || usable()[0];
    if (d) {
      t.name.replaceChildren(ico('phone', 13), ' ' + devName(d));
      const p = (EMU.st.procs || []).find(x => x.avd === d.avd);
      t.sub.textContent = [d.booted ? null : 'booting…', d.w ? d.w + '×' + d.hgt : null, p ? p.gpu + ' GPU' + (p.gpu === 'host' ? '' : ' (slow)') : null, p ? p.cpu + '% cpu' : null].filter(Boolean).join(' · ');
      if (t.serial !== d.serial) { t.serial = d.serial; thumb(true); }
    }
    return t;
  }
  function thumb(force) {
    const t = EMU.tile; if (!t || !t.serial || document.hidden || !t.el.isConnected || EMU.modal?.live()) return;
    if (!force && Date.now() - EMU.thumbT < 4000) return;
    EMU.thumbT = Date.now(); t.img.src = '/api/emu-screen?serial=' + encodeURIComponent(t.serial) + '&t=' + Date.now();
  }

  // ---------- modal ----------
  function openModal() {
    const m = $('#modal'); m.classList.remove('hidden');
    EMU.modal?.close(true);
    const dead = { v: false };
    // we own #modal only while our box is its first child (another feature's modal replaces the content)
    const live = () => !dead.v && !m.classList.contains('hidden') && box.isConnected && m.firstChild === box;
    const close = (silent) => {
      const owner = m.firstChild === box;
      dead.v = true; clearTimeout(timer); clearInterval(refresher);
      document.removeEventListener('keydown', esc, true); document.removeEventListener('visibilitychange', wake);
      if (EMU.modal === api_) EMU.modal = null;
      if (!silent && owner) m.classList.add('hidden');   // never hide a modal that now belongs to someone else
    };
    const esc = e => {
      if (e.key !== 'Escape') return;
      if (!live()) { close(true); return; }             // replaced or hidden: clean up, leave the key to the new owner
      e.preventDefault(); e.stopPropagation(); close();
    };
    document.addEventListener('keydown', esc, true);
    const body = h('div', { class: 'emu-body' });
    const box = h('div', { class: 'box emu' }, body);
    m.replaceChildren(box); m.onclick = e => { if (e.target === m && live()) close(); };
    let img = null, timer = 0, refresher = 0, shown = '', started = {}, errs = 0;
    const api_ = { close, live, refresh: () => { if (live()) draw(); } };
    EMU.modal = api_;
    poll();

    // live screen: the next frame is requested only after the previous one has loaded
    const frame = () => {
      clearTimeout(timer);
      if (!live()) { close(true); return; }   // replaced, hidden or closed → stop for good
      if (document.hidden || !img || !EMU.serial) { timer = setTimeout(frame, 500); return; }
      img.src = '/api/emu-screen?serial=' + encodeURIComponent(EMU.serial) + '&t=' + Date.now();
    };
    const wake = () => { if (dead.v) return; if (!live()) { close(true); return; } if (!document.hidden) frame(); };
    document.addEventListener('visibilitychange', wake);
    const onLoad = () => { errs = 0; img.classList.remove('emu-bad'); const ph = body.querySelector('.emu-ph'); if (ph) ph.classList.add('hidden'); timer = setTimeout(frame, 40); };
    const onErr = () => { errs++; img.classList.add('emu-bad'); const ph = body.querySelector('.emu-ph'); if (ph) { ph.classList.remove('hidden'); ph.textContent = 'No picture yet (booting?) …'; } timer = setTimeout(frame, Math.min(4000, 800 * errs)); };

    const send = async (ev) => {
      try { await api('emu-input', { serial: EMU.serial, ...ev }); } catch (e) { toast('Android input: ' + e.message, 'err'); }
    };
    const toDev = (e) => {
      const r = img.getBoundingClientRect(); const nw = img.naturalWidth, nh = img.naturalHeight; if (!nw || !r.width) return null;
      return { x: Math.round((e.clientX - r.left) / r.width * nw), y: Math.round((e.clientY - r.top) / r.height * nh) };
    };
    function bindPointer(el) {
      let down = null;
      el.addEventListener('pointerdown', e => { if (e.button > 0) return; down = { ...toDev(e), cx: e.clientX, cy: e.clientY, t: Date.now() }; if (down.x == null) down = null; else { try { el.setPointerCapture(e.pointerId); } catch {} } e.preventDefault(); });
      el.addEventListener('pointerup', e => {
        if (!down) return; const a = down; down = null; const b = toDev(e); if (!b) return;
        if (Math.hypot(e.clientX - a.cx, e.clientY - a.cy) < 10) send({ kind: 'tap', x: a.x, y: a.y });
        else send({ kind: 'swipe', x: a.x, y: a.y, x2: b.x, y2: b.y, ms: Math.min(1500, Math.max(80, Date.now() - a.t)) });
      });
      el.addEventListener('pointercancel', () => { down = null; });
      el.addEventListener('contextmenu', e => e.preventDefault());
    }

    function head(extra) {
      return h('div', { class: 'emu-head' }, h('h3', null, ico('phone', 16), ' Android'), extra, h('span', { class: 'emu-sp' }),
        h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: () => close() }, ico('x', 15)));
    }

    function draw() {
      const st = EMU.st, devs = usable();
      if (!st) { body.replaceChildren(head(), h('p', { class: 'dim emu-note' }, 'Loading…')); shown = 'load'; return; }
      if (!devs.length) {   // no device: AVD list
        const s = 'none|' + (st.avds || []).join() + '|' + (st.procs || []).map(p => p.avd).join() + JSON.stringify(started);
        if (shown === s) return; shown = s; img = null;
        const rows = (st.avds || []).map(a => {
          const run = (st.procs || []).some(p => p.avd === a) || (st.devices || []).some(d => d.avd === a) || (started[a] && Date.now() - started[a] < 90000);
          return h('div', { class: 'emu-avd' }, h('span', { class: 'emu-avdn' }, ico('phone', 14), ' ', h('b', null, a)),
            h('button', { class: 'btn primary', disabled: run, onclick: async ev => {
              ev.currentTarget.disabled = true;
              try { const r = await api('emu-start', { avd: a }); started[a] = Date.now(); toast(r.out || 'Starting ' + a, 'ok'); shown = ''; draw(); load(true); }
              catch (e) { toast('Start failed: ' + e.message, 'err'); ev.currentTarget.disabled = false; }
            } }, run ? 'Starting…' : gl('▶ Start')));
        });
        body.replaceChildren(head(),
          (st.devices || []).length ? h('p', { class: 'dim emu-note' }, 'adb sees: ' + st.devices.map(d => d.serial + ' (' + d.state + ')').join(', ')) : null,
          h('p', { class: 'emu-note' }, st.sdk ? 'No device is connected.' : 'Android SDK not found on the server (set ANDROID_HOME).'),
          st.avds?.length ? h('div', { class: 'emu-avds' }, rows) : (st.sdk ? h('p', { class: 'dim emu-note' }, 'No AVDs defined.') : null),
          h('p', { class: 'dim emu-note emu-small' }, 'Start runs the emulator headless on the GPU (or your ', h('code', null, 'EMULATOR_LAUNCHER'), ' script). It takes about a minute to boot.'));
        return;
      }
      if (!devs.some(d => d.serial === EMU.serial)) { EMU.serial = devs[0].serial; }
      const d = devs.find(x => x.serial === EMU.serial);
      const s = 'dev|' + devs.map(x => x.serial + x.booted + x.avd).join() + EMU.serial;
      if (shown === s) { const p = body.querySelector('.emu-info'); if (p) p.textContent = info(d); return; }
      shown = s;
      try { localStorage.setItem('bd.emu.serial', EMU.serial); } catch {}
      const pick = devs.length > 1 ? h('select', { class: 'txt emu-pick', onchange: e => { EMU.serial = e.target.value; shown = ''; draw(); frame(); } }, devs.map(x => h('option', { value: x.serial, selected: x.serial === EMU.serial }, devName(x)))) : h('span', { class: 'dim mono emu-dname' }, devName(d));
      img = h('img', { class: 'emu-screen', alt: 'device screen', draggable: 'false', onload: onLoad, onerror: onErr });
      bindPointer(img);
      const txt = h('input', { class: 'txt emu-text', type: 'text', maxlength: '500', placeholder: 'Type on the device (ASCII)…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
      const sendTxt = async () => { const v = txt.value; if (!v) return; await send({ kind: 'text', text: v }); txt.value = ''; };
      txt.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendTxt(); } });
      const nav = (label, key, title) => h('button', { class: 'btn emu-nav', title, onclick: () => send({ kind: 'key', key }) }, gl(label));
      body.replaceChildren(head(pick),
        h('div', { class: 'emu-main' },
          h('div', { class: 'emu-screenwrap' }, img, h('div', { class: 'emu-ph dim' }, 'Loading picture…')),
          h('div', { class: 'emu-side' },
            h('div', { class: 'emu-navs' }, nav('◁', 'BACK', 'Back'), nav('○', 'HOME', 'Home'), nav('▢', 'APP_SWITCH', 'Recents')),
            h('div', { class: 'emu-txtrow' }, txt, h('button', { class: 'btn', onclick: sendTxt }, 'Send')),
            h('div', { class: 'emu-keys' }, nav('⏎', 'ENTER', 'Enter'), nav('⌫', 'DEL', 'Backspace'), nav('⇥', 'TAB', 'Tab'), nav('Vol −', 'VOLUME_DOWN', 'Volume down'), nav('Vol +', 'VOLUME_UP', 'Volume up'), nav('⏻', 'POWER', 'Power (screen off/on)')),
            h('div', { class: 'emu-info dim mono' }, info(d)),
            d.kind === 'emulator' ? h('button', { class: 'btn emu-stop', onclick: async () => {
              if (!confirm('Stop the emulator ' + devName(d) + '? Unsaved state in apps is lost.')) return;
              try { await api('emu-stop', { serial: d.serial }); toast('Stopping ' + devName(d), 'ok'); shown = ''; setTimeout(() => load(true), 1500); } catch (e) { toast('Stop failed: ' + e.message, 'err'); }
            } }, gl('■ Stop emulator')) : null)));
      frame();
    }
    function info(d) {
      const p = (EMU.st.procs || []).find(x => x.avd === d.avd);
      return [d.serial, d.w ? d.w + '×' + d.hgt : null, d.booted ? null : 'booting', p ? p.gpu + ' GPU' : null, p ? p.cpu + '% cpu' : null].filter(Boolean).join(' · ');
    }
    draw(); load(true).then(() => { if (live()) draw(); });
    refresher = setInterval(() => { if (!live()) close(true); else if (!document.hidden) load(true).then(() => { if (live()) draw(); }); }, 3000);
  }

  FEAT.emu = {
    homeTiles() { poll(); return usable().length ? [tile().el] : []; },
    paletteItems() { return [{ kind: 'action', label: 'Android emulator', sub: usable().length ? 'live screen + touch' : 'start an AVD', icon: '📱', hay: 'android emulator phone avd adb screen', run: () => openModal(), rank: 26 }]; },
    deepLink(q) { if (!q.get('emu')) return false; try { history.replaceState(null, '', location.pathname); } catch {} openModal(); return true; },
  };
})();
