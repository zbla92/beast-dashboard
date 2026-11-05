'use strict';
(() => {
  ICONS.fork = '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5"/>';
  ICONS.moon = '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>';
  ICONS.sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  ICONS.link = '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>';

  const BUSY = new Set(['working', 'background', 'permission']);
  const hm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tomorrow8 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime(); };

  async function fork(name) {
    try {
      const r = await api('chat-fork', { session: name });
      toast(`Forked: ${r.label}`, 'ok');
      openTerm(r.name);
    } catch (e) { toast('Fork failed: ' + e.message, 'err'); }
  }

  function settle(name, until) {
    api('claude-settle', { session: name, until })
      .then(r => toast(!r.settled ? 'Back in the list' : r.settled.until ? 'Snoozed until ' + hm(r.settled.until) : 'Settled — it wakes up when it needs you'))
      .catch(e => toast(e.message, 'err'));
  }

  function sessMenu(name, sess, cl) {
    if (!cl) return null;
    const busy = BUSY.has(cl.state);
    const out = [];
    if (cl.sessionId) out.push({ label: 'Fork chat', sub: 'a new chat that starts from this conversation', icon: ico('fork', 15), disabled: busy, title: busy ? 'only when Claude is not in a turn' : 'the new chat has everything said so far; this one stays as it is', onclick: () => fork(name) });
    if (cl.settled) out.push({ label: cl.settled.until ? 'Unsnooze' : 'Unsettle', sub: cl.settled.until ? 'snoozed until ' + hm(cl.settled.until) : 'settled ' + hm(cl.settled.at), icon: ico('sun', 15), onclick: () => settle(name, false) });
    else out.push(
      { label: 'Settle', sub: 'dim it until it needs you again', icon: ico('moon', 15), onclick: () => settle(name, null) },
      { label: 'Snooze 1 h', sub: 'no done buzz or inbox until ' + hm(Date.now() + 3600e3), icon: ico('clock', 15), onclick: () => settle(name, Date.now() + 3600e3) },
      { label: 'Snooze until tomorrow 8:00', icon: ico('clock', 15), onclick: () => settle(name, tomorrow8()) });
    return out;
  }

  const linkFor = (project, text, account) => {
    const q = new URLSearchParams({ new: 'chat' });
    if (project) q.set('project', project);
    if (account) q.set('account', account);
    if (text) q.set('text', text);
    return location.origin + '/?' + q.toString();
  };

  function currentProject() {
    if (UI.drawer && !String(UI.drawer).startsWith('session:') && S.projects.some(p => p.id === UI.drawer)) return UI.drawer;
    const s = TERM.active && S.runtime.sessions.find(x => x.name === TERM.active);
    return s && s.project || '';
  }

  function linkDialog() {
    const m = $('#modal');
    const active = TERM.active && document.querySelector(`[data-chat="${CSS.escape(TERM.active)}"] .creply`);
    const ta = h('textarea', { class: 'txt t3-ta', rows: 6, placeholder: 'The prompt the link opens with…' });
    ta.value = active ? active.value : '';
    const sel = h('select', { class: 'txt' }, h('option', { value: '' }, 'Guess from the prompt'),
      ...S.projects.filter(p => !p.hidden).slice().sort((a, b) => a.name.localeCompare(b.name)).map(p => h('option', { value: p.id }, p.name)));
    sel.value = currentProject();
    const out = h('input', { class: 'txt mono t3-out', readonly: true });
    const upd = () => { out.value = linkFor(sel.value, ta.value.trim()); };
    ta.addEventListener('input', upd); sel.addEventListener('change', upd); upd();
    const close = () => { m.classList.add('hidden'); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (!box.isConnected || m.classList.contains('hidden')) { document.removeEventListener('keydown', onKey, true); return; } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    const copy = () => {
      const done = () => { toast('Prompt link copied', 'ok'); close(); };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(out.value).then(done, () => { out.select(); toast('Select and copy the link', 'err'); });
      else { out.focus(); out.select(); try { document.execCommand('copy') ? done() : toast('Select and copy the link'); } catch { toast('Select and copy the link'); } }
    };
    const box = h('div', { class: 'box settings t3-link' },
      h('div', { class: 'sh' }, h('h3', null, 'Prompt link'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', onclick: close }, ico('x', 15))),
      h('div', { class: 'sbody' },
        h('p', { class: 'dim t3-note' }, 'Opens New chat with this prompt filled in. Nothing runs until you press Start chat.'),
        h('div', { class: 'sg' }, h('div', { class: 'sg-t' }, 'Project'), sel),
        h('div', { class: 'sg' }, h('div', { class: 'sg-t' }, 'Prompt'), ta),
        h('div', { class: 'sg' }, h('div', { class: 'sg-t' }, 'Link'), out)),
      h('div', { class: 'foot' }, h('span', { class: 'sp' }), h('button', { class: 'btn ghost', onclick: close }, 'Close'), h('button', { class: 'btn primary', onclick: copy }, ico('link', 14), 'Copy link')));
    m.replaceChildren(box); m.classList.remove('hidden'); m.onclick = e => { if (e.target === m) close(); };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => ta.focus(), 30);
  }

  const TRIAGE = 'Read ~/beast-dash/docs/TRIAGE.md and run the triage it describes, working in ~/beast-dash. Report first; change nothing until I say so.';
  function triage() {
    const p = S.projects.find(p => p.dirName === 'beast-dash') || S.projects.find(p => p.name === 'beast-dash');
    newSessionModal('new', TRIAGE, { project: p ? p.id : null, account: 'personal' });
  }

  function paletteItems() {
    return [
      { kind: 'action', label: 'Copy prompt link', sub: 'a link that opens New chat with a prompt filled in', icon: '⛓', hay: 'copy prompt link url share new chat', run: linkDialog, rank: 29 },
      { kind: 'action', label: 'Triage beast-dash', sub: 'new chat: logs, crashes, gate, open plan items — report only', icon: '⚕', hay: 'triage beast-dash health logs errors check', run: triage, rank: 29 },
    ];
  }

  FEAT.t3 = { sessMenu, paletteItems };
})();
