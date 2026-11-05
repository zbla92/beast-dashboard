'use strict';
(() => {
  ICONS.comment = '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.2A8 8 0 1 1 21 12z"/><path d="M8 10h8M8 14h5"/>';
  const KEY = 'bd.review';
  const MAX = 200;
  const RV = { list: load(), pill: null, editor: null };

  function load() { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(RV.list.slice(-MAX))); } catch {} renderPill(); }

  function rawOf(el) {
    const t = el.textContent.replace(/\u00a0/g, '');
    const sign = el.querySelector(':scope > .dsign');
    return sign && sign.textContent === ' ' && /^\\ No newline/.test(t.slice(1)) ? t.slice(1) : t;
  }

  function scan(el) {
    const host = el.parentElement; const out = new Map();
    let file = null, from = null, old = 0, neu = 0, remO = 0, remN = 0;
    for (const p of host ? host.children : []) {
      if (!p.classList.contains('dl')) continue;
      const t = rawOf(p);
      if (remO > 0 || remN > 0) {
        const c = t[0];
        if (c === '+') { out.set(p, { kind: 'add', file: file || from, line: neu, side: 'new', code: t.slice(1) }); neu++; remN--; continue; }
        if (c === '-') { out.set(p, { kind: 'del', file: from || file, line: old, side: 'old', code: t.slice(1) }); old++; remO--; continue; }
        if (c === '\\') continue;
        out.set(p, { kind: 'ctx', file: file || from, line: neu, side: 'new', code: t.slice(1) }); old++; neu++; remO--; remN--; continue;
      }
      if (t.startsWith('diff ')) { file = from = null; continue; }
      if (t.startsWith('--- ')) { const f = t.slice(4).trim(); from = f === '/dev/null' ? null : f.replace(/^a\//, ''); continue; }
      if (t.startsWith('+++ ')) { const f = t.slice(4).trim(); file = f === '/dev/null' ? null : f.replace(/^b\//, ''); continue; }
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(t);
      if (m) { old = +m[1]; remO = m[2] == null ? 1 : +m[2]; neu = +m[3]; remN = m[4] == null ? 1 : +m[4]; }
    }
    return out;
  }

  const lineAt = el => (el && el.classList.contains('dl') && scan(el).get(el)) || null;

  function closeEditor() { if (RV.editor) { RV.editor.remove(); RV.editor = null; } }

  function openEditor(lineEl, box) {
    const at = lineAt(lineEl); if (!at || !at.file) { toast('Could not tell which file this line is in', 'err'); return; }
    closeEditor();
    const root = box.dataset.root; const session = box.closest('[data-session]')?.dataset.session || null;
    const code = at.code;
    const ta = h('textarea', { class: 'txt rv-ta', rows: 2, placeholder: `Comment on ${at.file}:${at.line} — goes to the review tray` });
    const add = () => {
      const text = ta.value.trim(); if (!text) { ta.focus(); return; }
      RV.list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), root, session, file: at.file, line: at.line, side: at.side, code: code.slice(0, 300), text: text.slice(0, 4000), at: Date.now() });
      save(); lineEl.classList.add('rv-has'); closeEditor();
      toast(`Added to review (${RV.list.length})`, 'ok');
    };
    ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } if (e.key === 'Escape') { e.preventDefault(); closeEditor(); } });
    RV.editor = h('div', { class: 'rv-ed', onclick: e => e.stopPropagation() },
      h('div', { class: 'rv-where mono' }, `${at.file}:${at.line}`, at.side === 'old' ? h('span', { class: 'rv-old' }, 'removed line') : null),
      ta,
      h('div', { class: 'rv-btns' }, h('span', { class: 'dim rv-hint' }, IS_PHONE ? '' : '⌘/Ctrl+Enter adds'), h('span', { class: 'sp' }),
        h('button', { class: 'btn sm ghost', onclick: closeEditor }, 'Cancel'),
        h('button', { class: 'btn sm primary', onclick: add }, ico('comment', 13), 'Add to review')));
    lineEl.after(RV.editor);
    setTimeout(() => ta.focus(), 20);
  }

  document.addEventListener('click', e => {
    const lineEl = e.target.closest && e.target.closest('.dl');
    if (!lineEl) return;
    const box = lineEl.closest('.chdiff[data-root]'); if (!box || !box.dataset.root || !lineAt(lineEl)) return;
    const sel = window.getSelection(); if (sel && !sel.isCollapsed && box.contains(sel.anchorNode)) return;
    e.stopPropagation();
    openEditor(lineEl, box);
  });

  const BLOCK = new Set(['permission']);
  const homeOf = c => (c || '').replace(/^\/home\/[^/]+\//, '~/');
  const inside = (a, b) => !!a && !!b && (a === b || a.startsWith(b.replace(/\/$/, '') + '/'));
  function sessionsFor(root) {
    const all = termSessions().claude.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const near = all.filter(s => { const c = s.claude?.cwd || s.cwd; return inside(c, root) || inside(root, c); });
    return { all, near };
  }

  function message(items) {
    const byRoot = new Map();
    for (const c of items) { if (!byRoot.has(c.root)) byRoot.set(c.root, []); byRoot.get(c.root).push(c); }
    const parts = [];
    for (const [root, list] of byRoot) {
      parts.push(`Review comments on ${homeOf(root)} — please address each one:`);
      list.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
      for (const c of list) parts.push(`\n${c.file}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}\n> ${c.code.trim() || '(blank line)'}\n${c.text}`);
      parts.push('');
    }
    return parts.join('\n').trim();
  }

  function tray() {
    const m = $('#modal');
    const roots = [...new Set(RV.list.map(c => c.root))];
    const pre = RV.list.slice().reverse().find(c => c.session)?.session;
    const { all, near } = sessionsFor(roots[0]);
    const def = (pre && all.some(s => s.name === pre) && pre) || (TERM.active && near.some(s => s.name === TERM.active) && TERM.active) || near[0]?.name || all[0]?.name || '';
    const sel = h('select', { class: 'txt rv-sel' }, ...all.map(s => h('option', { value: s.name }, (near.includes(s) ? 'near · ' : '') + sessTitle(s) + ' · ' + s.name)));
    sel.value = def;
    const list = h('div', { class: 'rv-list' });
    const draw = () => {
      if (!RV.list.length) { close(); return; }
      list.replaceChildren(...RV.list.map(c => h('div', { class: 'rv-item' },
        h('div', { class: 'rv-ih' }, fileIcon(c.file), h('span', { class: 'mono rv-f' }, `${c.file}:${c.line}`), roots.length > 1 ? h('span', { class: 'dim rv-r' }, homeOf(c.root)) : null, h('span', { class: 'sp' }),
          h('button', { class: 'btn sm ghost icon', title: 'remove this comment', onclick: () => { RV.list = RV.list.filter(x => x.id !== c.id); save(); draw(); } }, ico('x', 13))),
        h('div', { class: 'mono rv-code' }, c.code || ' '),
        h('div', { class: 'rv-txt' }, c.text))));
    };
    const close = () => { m.classList.add('hidden'); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (!box.isConnected || m.classList.contains('hidden')) { document.removeEventListener('keydown', onKey, true); return; } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    const send = async () => {
      const name = sel.value; if (!name) return toast('Pick a session', 'err');
      const cl = claudeOf(name);
      if (cl && BLOCK.has(cl.state)) return toast('That session is waiting on a permission prompt — answer it first', 'err');
      const text = message(RV.list);
      try { await api('send', { session: name, text }); RV.list = []; save(); close(); toast('Review sent', 'ok'); openTerm(name); }
      catch (e) { toast('Send failed: ' + e.message, 'err'); }
    };
    const toDraft = () => {
      const name = sel.value; if (!name) return;
      const text = message(RV.list);
      const prev = loadDraft(name); saveDraft(name, prev ? prev.replace(/\s*$/, '\n\n') + text : text);
      RV.list = []; save(); close(); toast('Review is in the chat box — edit and send', 'ok'); openTerm(name);
    };
    const box = h('div', { class: 'box settings rv-box' },
      h('div', { class: 'sh' }, h('h3', null, `Review · ${RV.list.length} comment${RV.list.length === 1 ? '' : 's'}`), h('span', { class: 'sp' }),
        h('button', { class: 'btn sm ghost', title: 'drop every comment', onclick: async () => { if (await confirmBox({ title: 'Clear the review?', text: `${RV.list.length} comments are dropped.`, ok: 'Clear', danger: true })) { RV.list = []; save(); } else tray(); } }, 'Clear'),
        h('button', { class: 'btn sm ghost icon', onclick: close }, ico('x', 15))),
      h('div', { class: 'sbody' }, list),
      h('div', { class: 'foot rv-foot' }, h('span', { class: 'dim rv-to' }, 'To'), sel, h('span', { class: 'sp' }),
        h('button', { class: 'btn ghost', title: 'put it in the session\'s chat box instead of sending', onclick: toDraft }, 'To chat box'),
        h('button', { class: 'btn primary', onclick: send }, ico('send', 14), 'Send')));
    draw();
    m.replaceChildren(box); m.classList.remove('hidden'); m.onclick = e => { if (e.target === m) close(); };
    document.addEventListener('keydown', onKey, true);
  }

  function renderPill() {
    const n = RV.list.length;
    if (!n) { if (RV.pill) { RV.pill.remove(); RV.pill = null; } return; }
    if (!RV.pill) { RV.pill = h('button', { class: 'rv-pill', onclick: tray }); document.body.append(RV.pill); }
    RV.pill.replaceChildren(ico('comment', 15), h('span', null, 'Review'), h('b', null, String(n)));
    RV.pill.title = `${n} comment${n === 1 ? '' : 's'} on diff lines — click to send them to a session`;
  }

  function paletteItems() {
    return RV.list.length ? [{ kind: 'action', label: 'Review tray', sub: `${RV.list.length} comments on diff lines`, icon: '✎', hay: 'review comments tray diff send', run: tray, rank: 5 }] : [];
  }

  window.addEventListener('storage', e => { if (e.key === KEY) { RV.list = load(); renderPill(); } });
  setTimeout(renderPill, 0);
  FEAT.review = { paletteItems };
})();
