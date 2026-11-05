'use strict';
FEAT.icons = (() => {
  const DISMISS = 'bd.icons.dismissed';
  const BATCH = 'bd.icons.batch';
  const TYPES = new Set(['svg', 'png', 'jpg', 'jpeg', 'webp', 'ico']);
  const ACCEPT = '.svg,.png,.jpg,.jpeg,.webp,.ico,image/svg+xml,image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon';
  const MAX = 512 * 1024, LIMIT = 60;
  const missing = () => S.projects.filter(p => !p.icon && !p.hidden);
  const alive = name => !!name && S.runtime.sessions.some(s => s.name === name);
  let starting = false, banEl = null, banKey = '', open = null;

  const subject = t => t.kind === 'project' ? byId()[t.id] : S.projects.find(p => p.org === t.id);
  const look = t => {
    const p = subject(t); if (!p) return null;
    return t.kind === 'project'
      ? { p, name: p.name, url: p.icon, custom: !!p.iconCustom }
      : { p, name: t.id, url: p.orgIcon || null, custom: !!p.orgIconCustom };
  };

  function orgTile(org, url, cls) {
    const el = h('span', { class: 'fic-ot ' + (cls || ''), style: `--org:${orgColor(org)}` });
    const letter = () => h('b', null, String(org)[0].toUpperCase());
    if (url) el.append(h('img', { src: url, alt: '', draggable: 'false', onerror: e => e.target.replaceWith(letter()) }));
    else el.append(letter());
    return el;
  }

  const readB64 = f => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error || new Error('could not read the file'));
    r.readAsDataURL(f);
  });

  function started(r, what) {
    if (!r.sent) { if (r.prompt) saveDraft(r.name, r.prompt); toast(`Session ${r.name} started, but the prompt did not arrive (${r.error || 'runner not ready'}). It is in the chat box — press Send.`, 'err'); }
    else toast(`Claude is drawing ${what}. It shows up here as soon as the file is written.`, 'ok');
  }

  function sheet(t) {
    const m = $('#modal'); const info = look(t);
    if (!info) { toast(t.kind === 'project' ? 'Project not found' : 'Org not found', 'err'); return; }
    let busy = false;
    const close = () => { open = null; m.classList.add('hidden'); };
    const status = h('div', { class: 'fic-status hidden' });
    const say = (text, err) => { status.textContent = text; status.classList.toggle('err', !!err); status.classList.toggle('hidden', !text); };
    const setBusy = v => { busy = v; for (const b of box.querySelectorAll('.foot .btn')) b.disabled = v || (b.dataset.reset && !info.custom); };
    const fileIn = h('input', { type: 'file', accept: ACCEPT, style: 'display:none', onchange: () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) upload(f); } });

    async function upload(f) {
      const ext = (f.name.includes('.') ? f.name.split('.').pop() : '').toLowerCase();
      if (!TYPES.has(ext)) return say('Pick an svg, png, jpg, webp or ico file.', true);
      if (f.size > MAX) return say(`That file is ${Math.round(f.size / 1024)} KB — the limit is ${MAX / 1024} KB.`, true);
      setBusy(true); say('Uploading…');
      try { const data = await readB64(f); await api('icon-set', { kind: t.kind, id: t.id, ext, data }); toast(`Icon set for ${info.name}`, 'ok'); close(); }
      catch (e) { say('Upload failed: ' + e.message, true); setBusy(false); }
    }
    async function ask() {
      setBusy(true); say('Starting Claude…');
      try { const r = await api('icon-ask', { kind: t.kind, id: t.id, account: savedAcct() }); close(); started(r, `an icon for ${info.name}`); openTerm(r.name); }
      catch (e) { say('Could not start Claude: ' + e.message, true); setBusy(false); }
    }
    async function reset() {
      setBusy(true);
      try { await api('icon-reset', { kind: t.kind, id: t.id }); toast(`${info.name}: back to the automatic icon`, 'ok'); close(); }
      catch (e) { say('Reset failed: ' + e.message, true); setBusy(false); }
    }

    const state = info.custom ? 'Custom icon' : info.url ? (t.kind === 'project' ? 'Found in the project' : 'From the icons folder') : (t.kind === 'project' ? 'No icon yet — showing the tech fallback' : 'No icon yet');
    const prev = t.kind === 'project' ? h('span', { class: 'fic-prev' }, avatar(t.id, 'lg')) : h('span', { class: 'fic-prev' }, orgTile(t.id, info.url, 'big'));
    const box = h('div', { class: 'box settings fic' },
      h('div', { class: 'sh' }, h('h3', null, t.kind === 'project' ? 'Project icon' : 'Org icon'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: close }, ico('x', 15))),
      h('div', { class: 'sbody' },
        h('div', { class: 'fic-head' }, prev, h('div', { class: 'fic-who' }, h('b', null, info.name), h('span', { class: 'fic-state' + (info.custom ? ' custom' : '') }, state))),
        h('p', { class: 'hint' }, 'Upload an svg, png, jpg, webp or ico (max 512 KB), or let Claude draw an SVG from the code and README. A custom icon wins over the one found in the project; it appears a few seconds after the file is written.'),
        status, fileIn),
      h('div', { class: 'foot' },
        h('button', { class: 'btn ghost', 'data-reset': '1', disabled: !info.custom, title: info.custom ? 'remove the custom icon' : 'no custom icon set', onclick: () => !busy && reset() }, ico('undo', 14), 'Reset to auto'),
        h('span', { class: 'sp' }),
        h('button', { class: 'btn', onclick: () => !busy && fileIn.click() }, ico('upload', 14), 'Upload'),
        h('button', { class: 'btn primary', onclick: () => !busy && ask() }, ico('sparkle', 14), 'Ask Claude to draw one')));
    open = { t, key: JSON.stringify([info.url, info.custom]), box };
    m.replaceChildren(box); m.classList.remove('hidden'); m.onclick = e => { if (e.target === m) close(); };
  }

  async function batch() {
    const ids = missing().map(p => p.id).slice(0, LIMIT);
    if (!ids.length || starting) return;
    starting = true; banKey = ''; render();
    try {
      const r = await api('icon-ask', { kind: 'batch', ids, account: savedAcct() });
      localStorage.setItem(BATCH, r.name);
      started(r, plural(r.targets.length, 'icon'));
    } catch (e) { toast('Could not start Claude: ' + e.message, 'err'); }
    finally { starting = false; banKey = ''; render(); }
  }

  function projectsTop() {
    if (localStorage.getItem(DISMISS) === '1') return null;
    const n = missing().length; const run = localStorage.getItem(BATCH); const live = alive(run);
    if (!n && !live) return null;
    const key = JSON.stringify([n, live && run, starting]);
    if (key === banKey && banEl) return banEl;
    banKey = key;
    const dismiss = h('button', { class: 'btn sm ghost icon', title: 'dismiss', onclick: () => { localStorage.setItem(DISMISS, '1'); render(); } }, ico('x', 14));
    const text = n ? [h('b', null, ico('image', 14), ` ${plural(n, 'project')} ${n === 1 ? 'has' : 'have'} no icon`), live ? ' — Claude is drawing them; they appear as each file is written.' : ' — Ask Claude to draw them.'] : [h('b', null, ico('image', 14), ' Claude is drawing project icons'), ' — they appear as each file is written.'];
    const act = live
      ? h('button', { class: 'btn sm', onclick: () => openTerm(run) }, ico('chat', 14), 'Open session')
      : h('button', { class: 'btn sm primary', disabled: starting, title: n > LIMIT ? `one session for the first ${LIMIT}` : 'one Claude session draws an SVG for each of them', onclick: batch }, ico('sparkle', 14), starting ? 'Starting…' : 'Ask Claude to draw them');
    banEl = h('div', { class: 'ban fic-ban' }, h('span', null, ...text), h('span', { style: 'flex:1' }), act, dismiss);
    return banEl;
  }

  function projectMenu(p) {
    return { label: 'Set icon…', sub: p.iconCustom ? 'custom' : p.icon ? 'found in the project' : 'none yet', icon: ico('image', 15), onclick: () => sheet({ kind: 'project', id: p.id }) };
  }

  function orgBadge(org, ps) {
    const url = (ps.find(p => p.orgIcon) || {}).orgIcon;
    return url ? orgTile(org, url, 'badge') : null;
  }

  function orgActions(org) {
    return h('button', { class: 'btn sm ghost icon', title: 'org options', onclick: ev => openMenu(ev, [{ header: org }, { label: 'Set icon…', icon: ico('image', 15), onclick: () => sheet({ kind: 'org', id: org }) }]) }, ico('dots', 16));
  }

  function onState() {
    if (!open) return;
    if (!open.box.isConnected || $('#modal').classList.contains('hidden')) { open = null; return; }
    const info = look(open.t);
    if (info && JSON.stringify([info.url, info.custom]) !== open.key) sheet(open.t);
  }

  return { projectMenu, projectsTop, orgBadge, orgActions, onState };
})();
