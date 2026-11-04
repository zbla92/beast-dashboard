'use strict';
// F4 inbox. Claude sessions that wait for you (needs-you / permission / error / limit),
// alphabetical by tmux name (never by state), each with a reply box. Frontend only: POST /api/send, /api/claude-seen.
(() => {
  const WAIT = new Set(['needs-you', 'permission', 'error', 'limit']);
  const IBX = { open: false, rows: new Map(), sent: new Map(), seen: new Map(), list: null, modal: null, esc: null };
  let banner = null;

  // sessions waiting for you, in tmux (alphabetical) order; "Seen" hides one until its state changes
  const waiting = () => {
    const out = termSessions().claude.filter(it => WAIT.has(it.claude?.state) && !it.claude.settled).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out.filter(it => IBX.seen.get(it.name) !== it.claude.since);
  };
  const lineOf = it => {
    const cl = it.claude;
    if (cl.state === 'permission' && cl.menu) return cl.menu.text.filter(Boolean).slice(-3).join('\n') || 'Claude is asking';
    if (cl.state === 'permission') return 'Wants to run: ' + (cl.lastTool || '?') + (cl.lastMessage ? '\n' + cl.lastMessage : '');
    if (cl.state === 'limit') return cl.limitText || (acct(it.account) + ' account hit its usage limit');
    return cl.lastMessage || cl.title || (cl.state === 'error' ? 'Error: open the chat' : 'Finished');
  };

  // does the inbox still own #modal? (another dialog may have replaced its content, or the modal got hidden)
  const owns = () => { const m = $('#modal'); return !!(IBX.modal && m && m.firstChild === IBX.modal && !m.classList.contains('hidden')); };
  function release() {
    IBX.open = false; IBX.rows.clear(); IBX.modal = null; IBX.list = null;
    if (IBX.esc) { document.removeEventListener('keydown', IBX.esc, true); IBX.esc = null; }
    if (IBX.mo) { IBX.mo.disconnect(); IBX.mo = null; }
  }
  function close() {
    const m = $('#modal'); if (owns()) m.classList.add('hidden');
    release();
  }
  // true while the inbox is open AND still owns the modal; otherwise cleans up
  const alive = () => { if (!IBX.open) return false; if (owns()) return true; release(); return false; };

  function makeRow(it) {
    const name = it.name; const row = { name, el: null, tell: false, since: null };
    const ta = h('textarea', { class: 'ibx-ta', rows: 1, placeholder: 'Reply to Claude…', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: true, title: 'Enter sends · Shift+Enter = new line' });
    ta.value = loadDraft(name);
    const grow = () => { ta.style.height = '40px'; if (ta.value) ta.style.height = Math.min(Math.max(40, ta.scrollHeight), 140) + 'px'; saveDraft(name, ta.value); };
    const sentTag = h('span', { class: 'ibx-sent hidden' }, 'sent ✓');
    let shelling = false;
    const send = async () => {
      const v = ta.value.trim(); if (!v) return;
      if (claudeOf(name)?.mode === 'chat' && FEAT.shell && FEAT.shell.is(v)) { if (shelling) return; shelling = true; ta.value = ''; grow(); try { if (await FEAT.shell.run(name, v)) sentTag.classList.remove('hidden'); else if (!ta.value) { ta.value = v; grow(); } } finally { shelling = false; } return; }
      // never type Enter-terminated text into a permission menu (Enter would confirm the highlighted "Yes")
      if (claudeOf(name)?.state === 'permission') { toast(claudeOf(name)?.menu ? 'Claude is asking something: pick an option above' : 'Still at the permission prompt: use Allow / Deny', 'err'); return; }
      ta.value = ''; grow();
      (PENDING[name] = PENDING[name] || []).push({ text: v, ts: Date.now() });
      try {
        await api('send', { session: name, text: v });
        IBX.sent.set(name, claudeOf(name)?.state || ''); sentTag.classList.remove('hidden');
      } catch (e) {
        toast(e.message, 'err'); PENDING[name] = (PENDING[name] || []).filter(x => x.text !== v); ta.value = v; grow();
      }
    };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); } });
    const mic = voiceButton(ta, name);
    const sendBtn = h('button', { class: 'btn primary ibx-btn ibx-send', title: 'send (Enter)', onclick: send }, ico('send', 15), 'Send');
    const answer = async k => {
      if (row.answered != null && row.answered === row.since) return;
      row.answered = row.since; row.setPermDisabled(true);
      try { await api('answer', { session: name, since: row.since, choice: k === 'y' ? 'allow' : 'deny' }); IBX.sent.set(name, claudeOf(name)?.state || ''); sentTag.classList.remove('hidden'); }
      catch (e) { toast(e.message, 'err'); row.answered = null; row.setPermDisabled(false); }
    };
    const tellBtn = h('button', { class: 'btn ibx-btn', title: 'deny (Esc), then write Claude what to do instead', onclick: async () => {
      try { await api('key', { session: name, key: 'esc' }); } catch (e) { toast(e.message, 'err'); return; }
      row.tell = true; row.el.classList.add('ibx-tell'); ta.focus();
    } }, 'Deny + tell Claude…');
    const allowBtn = h('button', { class: 'btn primary ibx-btn ibx-allow', title: 'allow this tool run (y)', onclick: () => answer('y') }, 'Allow');
    const denyBtn = h('button', { class: 'btn ibx-btn ibx-deny', title: 'deny this tool run (n)', onclick: () => answer('n') }, 'Deny');
    const permBtns = h('div', { class: 'ibx-perms' }, allowBtn, denyBtn, tellBtn);
    const chatBtn = h('button', { class: 'btn ibx-btn', title: 'open the chat', onclick: () => { close(); openTerm(name); } }, ico('chat', 15), 'Open chat');
    const seenBtn = h('button', { class: 'btn ghost ibx-btn', title: 'mark as seen — hides it until the state changes', onclick: () => {
      const cl = claudeOf(name); if (cl) IBX.seen.set(name, cl.since);
      api('claude-seen', { session: name }).catch(() => {}); render(); renderHeader();   // the tab title / badges count what the Inbox lists
    } }, 'Seen');
    const badge = h('span', { class: 'ibx-badge' }), msg = h('div', { class: 'ibx-msg' }), more = h('button', { class: 'ibx-more hidden', onclick: () => { const x = msg.classList.toggle('open'); more.textContent = x ? 'less' : 'more'; } }, 'more');
    const title = h('span', { class: 'ibx-proj' }), tag = h('span', { class: 'badge tag acc' }), av = h('span', { class: 'ibx-av' });
    const head = h('div', { class: 'ibx-head' }, av, h('div', { class: 'ibx-id' }, title, tag), h('span', { class: 'sp' }), badge);
    row.el = h('div', { class: 'ibx-row', 'data-name': name }, head, msg, more, permBtns, h('div', { class: 'ibx-reply' }, ta), h('div', { class: 'ibx-acts' }, mic, sentTag, h('span', { class: 'sp' }), seenBtn, chatBtn, sendBtn));
    Object.assign(row, { ta, grow, badge, msg, more, title, tag, av, sentTag, pid: null, text: null, permBtns, ynBtns: [allowBtn, denyBtn, tellBtn], menu: '', answered: null, setPermDisabled: d => { for (const b of row.permBtns.querySelectorAll('button')) b.disabled = d; } });
    return row;
  }

  // update a row in place: never touches the textarea
  function fill(row, it) {
    const cl = it.claude;
    if (row.since !== cl.since) { row.since = cl.since; row.tell = false; if (row.answered != null) row.answered = null; }
    if (row.answered == null) row.setPermDisabled(false);
    row.el.className = 'ibx-row st-' + cl.state + (row.tell && cl.state === 'permission' ? ' ibx-tell' : ''); row.el.style.setProperty('--org', orgColor(it.org));
    if (row.pid !== it.pid) { row.pid = it.pid; row.av.replaceChildren(avatar(it.pid, 'sm')); }
    row.title.textContent = cl.label || it.project; row.title.title = it.name;
    row.tag.className = 'badge tag acc ' + it.account; row.tag.textContent = acct(it.account);
    row.badge.replaceChildren(stateBadge(cl));
    const t = lineOf(it);
    if (row.text !== t) {
      row.text = t; row.msg.textContent = t;
      row.more.classList.toggle('hidden', t.length < 170 && t.split('\n').length < 3);
    }
    row.sentTag.classList.toggle('hidden', !IBX.sent.has(it.name));
    const mk = menuKey(cl.menu);
    if (row.menu !== mk) { row.menu = mk; row.permBtns.replaceChildren(...(cl.menu ? menuButtons(it.name, cl.menu, () => { IBX.sent.set(it.name, cl.state); row.sentTag.classList.remove('hidden'); }) : row.ynBtns)); }
  }

  function render() {
    if (!alive() || !IBX.list) return;
    const items = waiting(); const names = new Set(items.map(i => i.name));
    // a session that left the list (state changed) drops out, unless you are typing in it right now
    for (const [n, row] of IBX.rows) {
      if (!names.has(n) && document.activeElement !== row.ta) { row.el.remove(); IBX.rows.delete(n); IBX.sent.delete(n); }
    }
    for (const n of [...IBX.sent.keys()]) if (!IBX.rows.has(n) || claudeOf(n)?.state !== IBX.sent.get(n)) IBX.sent.delete(n);
    const order = [];
    for (const it of items) { let row = IBX.rows.get(it.name); if (!row) { row = makeRow(it); IBX.rows.set(it.name, row); } fill(row, it); order.push(row.el); }
    // kept-but-gone rows (focused textarea) stay where they are, after the others
    for (const [n, row] of IBX.rows) if (!names.has(n)) { row.el.classList.add('ibx-stale'); row.el.classList.remove('st-permission'); row.setPermDisabled(true); row.badge.replaceChildren(stateBadge(claudeOf(n))); order.push(row.el); }
    const cur = [...IBX.list.children].filter(c => c.classList.contains('ibx-row'));
    if (cur.length !== order.length || order.some((e, i) => e !== cur[i])) IBX.list.replaceChildren(...order);
    for (const row of IBX.rows.values()) if (!row.grown && row.el.isConnected) { row.grown = true; row.grow(); }
    const empty = IBX.list.parentNode.querySelector('.ibx-empty');
    empty.classList.toggle('hidden', order.length > 0);
    IBX.count.textContent = items.length ? items.length + ' waiting' : '';
  }

  function openInbox() {
    if (alive()) { render(); return; }
    const m = $('#modal'); m.classList.remove('hidden'); IBX.open = true;
    IBX.esc = e => { if (!alive()) return; if (e.key === 'Escape' && !document.body.classList.contains('recording')) { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', IBX.esc, true);
    IBX.list = h('div', { class: 'ibx-list' });
    IBX.count = h('span', { class: 'dim', style: 'font-size:13px' });
    const box = h('div', { class: 'box ibx' },
      h('div', { class: 'sh' }, h('h3', null, 'Inbox'), IBX.count, h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: close }, ico('x', 15))),
      h('div', { class: 'ibx-body' }, IBX.list, h('div', { class: 'ibx-empty hidden' }, 'Nothing is waiting for you.')));
    IBX.modal = box; m.replaceChildren(box); m.onclick = e => { if (e.target === m && owns()) close(); };
    try { IBX.mo = new MutationObserver(() => alive()); IBX.mo.observe(m, { childList: true, attributes: true, attributeFilter: ['class'] }); } catch {}
    render();
  }

  FEAT.inbox = {
    open: openInbox,
    count: () => waiting().length,   // app.js: tab title, Inbox badge, phone tab bar
    // Home hero (app.js puts data-slot="hero" tiles above the agents): who waits for you, one line each; a row opens
    // that session, the button opens the Inbox with a reply box per session. Same node every time — only its rows change.
    homeTiles() {
      const list = waiting(); const n = list.length; if (!n) return null;
      if (!banner) {
        banner = h('section', { class: 'ibx-banner', 'data-slot': 'hero' },
          h('h2', { class: 'ibx-bt' }), h('div', { class: 'ibx-hrows' }),
          h('button', { class: 'btn primary ibx-go', title: 'reply to each of them here', onclick: openInbox }, ico('chat', 15), 'Reply in Inbox'));
        banner._key = '';
      }
      const t = n === 1 ? 'One agent needs you' : `${n} agents need you`;
      const key = Math.floor(Date.now() / 60000) + JSON.stringify(list.map(it => [it.name, it.claude.state, it.claude.since, it.claude.label, lineOf(it).slice(0, 200)]));
      if (banner._key !== key) {
        banner._key = key; banner.querySelector('.ibx-bt').textContent = t;
        const shown = list.slice(0, 4);
        banner.querySelector('.ibx-hrows').replaceChildren(...shown.map(it => h('button', { class: 'ibx-hrow st-' + it.claude.state, title: 'open ' + it.name, onclick: () => openTerm(it.name) },
          avatar(it.pid, 'sm'), h('span', { class: 'ibx-hn' }, it.claude.label || it.project), h('span', { class: 'ibx-hm' }, oneLine(lineOf(it), 140)), h('span', { class: 'ibx-hs' }, STATE_SHORT[it.claude.state] || it.claude.state, it.claude.since ? ' · ' + ago(it.claude.since) : ''))),
          ...(n > shown.length ? [h('button', { class: 'ibx-hmore', onclick: openInbox }, `+ ${n - shown.length} more`)] : []));
      }
      return banner;
    },
    paletteItems() {
      const n = waiting().length;
      return [{ kind: 'action', label: 'Inbox', sub: n ? `${n} need${n === 1 ? 's' : ''} you` : 'nothing waiting', icon: '✓', hay: 'inbox reply needs you waiting permission', run: openInbox, rank: n ? 1 : 28 }];
    },
    deepLink(q) { if (!q.get('inbox')) return false; history.replaceState(null, '', location.pathname); openInbox(); return true; },
    onState() { if (alive()) render(); },
  };
})();
