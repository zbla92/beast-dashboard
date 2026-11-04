'use strict';
(() => {
  const ST = { acct: localStorage.getItem('bd.nt.acct') === 'company' ? 'company' : 'personal', tab: localStorage.getItem('bd.ns.tab') === 'resume' ? 'resume' : 'new' };
  const HUES = [210, 25, 150, 275, 45, 190, 330, 95, 240, 10, 170, 300];
  const hash = s => { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };
  const mono = s => { const w = String(s).split(/[^A-Za-z0-9]+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).replace(/^./, c => c.toUpperCase()); };
  const orgTile = (name, size = 'sm') => h('span', { class: 'av ns-org ' + size, style: `--org:hsl(${HUES[hash(name) % HUES.length]} 22% 62%)`, title: name }, h('span', { class: 'g' }, mono(name)));
  const rootTile = (size = 'sm') => h('span', { class: 'av ns-root ' + size, title: 'no project' }, ico('folder', size === 'sm' ? 13 : 18));
  const devRoot = () => S.host.devRoot || '';
  const tilde = p => String(p || '').replace(/^\/home\/[^/]+\//, '~/');
  const ROOT = () => ({ kind: 'root', cwd: devRoot(), name: tilde(devRoot()) || '~/dev' });
  const fromProject = p => ({ kind: 'project', id: p.id, org: p.org || undefined, cwd: p.path, name: p.name || p.dirName });
  const fromOrg = o => ({ kind: 'org', org: o, cwd: devRoot() + '/' + o, name: o });
  const tileOf = (c, size = 'sm') => c.kind === 'project' ? avatar(c.id, size) : c.kind === 'org' ? orgTile(c.group ? c.group.split('/').pop() : c.org, size) : rootTile(size);
  const subOf = c => c.kind === 'project' ? [c.org, tilde(c.cwd)].filter(Boolean).join(' · ') : c.kind === 'org' ? 'folder · ' + tilde(c.cwd) : 'no project · ' + tilde(c.cwd);
  const targetOf = c => c.kind === 'project' ? { kind: 'project', id: c.id } : c.kind === 'org' ? { kind: 'org', org: c.org, ...(c.group ? { group: c.group } : {}) } : { kind: 'root' };
  const titleOf = it => it.label || it.title || it.firstPrompt || it.id.slice(0, 8);
  const projName = id => { const p = byId()[id]; return p ? p.name : id; };

  function dayGroup(ts) {
    const d = new Date(ts), now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= start) return 'Today';
    if (ts >= start - 864e5) return 'Yesterday';
    if (ts >= start - 6 * 864e5) return 'This week';
    return d.getFullYear() === now.getFullYear() ? 'Earlier this year' : 'Older';
  }

  const hereOf = name => {
    const sess = S.runtime.sessions.find(x => x.name === name); if (!sess || !sess.claude) return null;
    const cwd = sess.claude.cwd || sess.cwd || ''; const p = sess.project && byId()[sess.project];
    if (p && (!cwd || p.path === cwd)) return fromProject(p);
    const org = cwd.startsWith(devRoot() + '/') && cwd.slice(devRoot().length + 1);
    if (org && !org.includes('/') && S.projects.some(x => x.org === org)) return fromOrg(org);
    if (p) return fromProject(p);
    return ROOT();
  };

  function open(tab, text, opts = {}) {
    const m = $('#modal'); m.classList.remove('hidden');
    if (tab === 'new' || tab === 'resume') ST.tab = tab;
    ST.acct = localStorage.getItem('bd.nt.acct') === 'company' ? 'company' : 'personal';
    const proj = opts.project ? S.projects.find(p => p.id === opts.project) || S.projects.find(p => p.dirName === opts.project || p.name === opts.project) : null;
    const here = opts.here ? hereOf(opts.here) : proj ? fromProject(proj) : null; const hereAcct = opts.here ? (claudeOf(opts.here) || {}).account : ['personal', 'company'].includes(opts.account) ? opts.account : null;
    const G = { res: null, for: '', manual: here, touched: !!hereAcct, seq: 0, busy: false, timer: 0 };
    if (hereAcct) ST.acct = hereAcct;
    const saved = () => localStorage.getItem('bd.nt.acct') === 'company' ? 'company' : 'personal';
    const R = { seq: 0, timer: 0 };
    const close = () => { m.classList.add('hidden'); document.removeEventListener('keydown', onEsc, true); };
    const onEsc = e => { if (!box.isConnected) { document.removeEventListener('keydown', onEsc, true); return; } if (e.key !== 'Escape' || m.classList.contains('hidden') || document.body.classList.contains('recording')) return; e.preventDefault(); e.stopPropagation(); if (!pick.classList.contains('hidden')) { pick.classList.add('hidden'); return; } close(); };
    document.addEventListener('keydown', onEsc, true);

    const acctSeg = h('span', { class: 'seg' });
    const renderAcct = () => acctSeg.replaceChildren(...[['personal', 'Personal'], ['company', 'Company']].map(([v, l]) => h('button', { class: 'segb' + (ST.acct === v ? ' on' : ''), onclick: () => { G.touched = true; localStorage.setItem('bd.nt.acct', v); setAcct(v, true); renderHint(); if (!IS_PHONE) (ST.tab === 'new' ? ta : hq).focus(); } }, l)));
    const setAcct = (v, save) => { if (ST.acct === v) return; ST.acct = v; if (save) localStorage.setItem('bd.nt.acct', v); renderAcct(); renderHint(); if (ST.tab === 'resume') loadHist(); };
    const tabSeg = h('span', { class: 'seg ns-tabs' });
    const renderTabs = () => tabSeg.replaceChildren(...[['new', 'New chat', 'chat'], ['resume', 'Resume', 'clock']].map(([v, l, i]) => h('button', { class: 'segb' + (ST.tab === v ? ' on' : ''), onclick: () => { ST.tab = v; localStorage.setItem('bd.ns.tab', v); renderTabs(); renderBody(); } }, ico(i, 14), l)));

    const target = () => G.manual || (G.res && G.res.best) || ROOT();
    const ta = h('textarea', { class: 'txt ns-ta', rows: 5, placeholder: 'What should Claude do? Just start typing — the project is picked from what you write.', autocapitalize: 'sentences', spellcheck: true });
    const chip = h('button', { class: 'ns-chip', title: 'where the chat starts — click to change' });
    const hint = h('span', { class: 'ns-hint dim' });
    const sendBtn = h('button', { class: 'btn primary ns-send' }, ico('send', 14), 'Start chat');
    const pickIn = h('input', { class: 'txt', placeholder: 'Search projects and folders…', autocomplete: 'off' });
    const pickList = h('div', { class: 'ns-picklist' });
    const pick = h('div', { class: 'ns-pick hidden' }, pickIn, pickList);
    const status = h('div', { class: 'ns-status hidden' });

    const renderChip = () => {
      const c = target(); const sure = G.manual || (G.res && G.res.confident) || c.kind !== 'project';
      chip.replaceChildren(...[h('span', { class: 'dim ns-in' }, 'in'), tileOf(c), h('span', { class: 'ns-cn' }, c.name), !sure ? h('span', { class: 'ns-q', title: 'a guess — check it' }, '?') : null, h('span', { class: 'caret' }, '▾')].filter(Boolean));
      chip.title = subOf(c) + ' — click to change';
      chip.classList.toggle('guess', !sure);
      renderHint();
    };
    const renderHint = () => {
      const c = target(); const want = G.touched ? ST.acct : c.account || saved();
      if (want !== ST.acct) { setAcct(want, false); return; }
      hint.textContent = !G.touched && c.account && c.account !== saved() ? `${c.account} account — usual for ${c.name}` : '';
    };
    const choose = c => { G.manual = c; pick.classList.add('hidden'); renderChip(); ta.focus(); };
    const pickRow = c => h('div', { class: 'ntrow ns-prow' + (target() === c || (G.manual && G.manual.kind === c.kind && G.manual.id === c.id && G.manual.org === c.org && G.manual.group === c.group) ? ' on' : ''), onclick: () => choose(c) }, tileOf(c), h('div', { class: 'ntn' }, h('div', { class: 'ntt' }, c.name), h('div', { class: 'nts' }, subOf(c))), c.why ? h('span', { class: 'dim ns-why' }, c.why) : null);
    const renderPick = () => {
      const q = pickIn.value.trim().toLowerCase(); const rows = [];
      const sug = ((G.res && G.res.cands) || []).filter(c => c.kind !== 'root');
      if (!q && sug.length) rows.push(h('div', { class: 'tsec' }, 'Suggested'), ...sug.map(pickRow));
      const projs = S.projects.filter(p => !p.hidden && (!q || [p.name, p.dirName, p.org, p.group].join(' ').toLowerCase().includes(q))).slice(0, q ? 40 : 200);
      if (projs.length) rows.push(h('div', { class: 'tsec' }, 'Projects'), ...projs.map(p => pickRow(fromProject(p))));
      const orgs = [...new Set(S.projects.filter(p => !p.hidden).map(p => p.org).filter(Boolean))].filter(o => !q || o.toLowerCase().includes(q));
      if (orgs.length) rows.push(h('div', { class: 'tsec' }, 'Org folders'), ...orgs.map(o => pickRow(fromOrg(o))));
      rows.push(h('div', { class: 'tsec' }, 'No project'), pickRow(ROOT()));
      pickList.replaceChildren(...rows);
    };
    chip.onclick = () => { const was = pick.classList.contains('hidden'); pick.classList.toggle('hidden', !was); if (was) { pickIn.value = ''; renderPick(); if (!IS_PHONE) pickIn.focus(); } };
    pickIn.oninput = renderPick;
    pickIn.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); const r = pickList.querySelector('.ntrow'); if (r) r.click(); } };

    const ctx = () => { const s = TERM.active && S.runtime.sessions.find(x => x.name === TERM.active); return s && s.project || null; };
    const guessNow = async () => {
      clearTimeout(G.timer); const text = ta.value.trim(); const n = ++G.seq;
      if (!text) { G.res = null; G.for = ''; renderChip(); return; }
      try { const r = await api('guess-project', { text, context: ctx() }); if (n === G.seq) { G.res = r; G.for = text; renderChip(); if (!pick.classList.contains('hidden')) renderPick(); } } catch {}
    };
    const runGuess = () => { clearTimeout(G.timer); G.timer = setTimeout(guessNow, 300); };
    ta.oninput = runGuess;

    const go = async () => {
      const text = ta.value.trim(); if (!text || G.busy) return;
      G.busy = true; sendBtn.disabled = true; sendBtn.lastChild.textContent = 'Starting…';
      if (!G.manual && G.for !== text) await guessNow();
      const c = target();
      try {
        const r = await api('chat-new', { text, account: ST.acct, target: targetOf(c) });
        localStorage.setItem('bd.ns.tab', 'new');
        if (!r.sent) { saveDraft(r.name, text); toast('Chat started, but the first message did not arrive (' + (r.error || 'runner not ready') + '). It is in the chat box — press Send.', 'err'); }
        else toast(`Chat started in ${c.name} (${ST.acct})`, 'ok');
        close(); openTerm(r.name);
      } catch (e) {
        status.classList.remove('hidden'); status.textContent = 'Could not start the chat: ' + e.message;
        G.busy = false; sendBtn.disabled = false; sendBtn.lastChild.textContent = 'Start chat';
      }
    };
    sendBtn.onclick = go;
    ta.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing && ((e.metaKey || e.ctrlKey) || (!IS_PHONE && !e.shiftKey))) { e.preventDefault(); go(); } };

    const newBody = h('div', { class: 'ns-new' }, ta, h('div', { class: 'ns-bar' }, chip, h('span', { class: 'sp' }), voiceButton(ta, '_new'), sendBtn), hint, pick, status);

    const hq = h('input', { class: 'txt', placeholder: 'Search past conversations — title, prompt, project, folder…', autocomplete: 'off' });
    const hlist = h('div', { class: 'ntlist ns-hist' });
    const deep = h('button', { class: 'btn sm ghost ns-deep', title: 'full-text search inside every conversation (both accounts)', onclick: () => { const q = hq.value.trim(); close(); openPalette('search'); if (q) setTimeout(() => { const i = $('#pal-in'); if (i) { i.value = '? ' + q; i.dispatchEvent(new Event('input', { bubbles: true })); } }, 20); } }, '⌕ Search inside conversations');
    const histRow = it => {
      const pid = it.project || (it.projects || [])[0];
      const chips = (it.projects || []).slice(0, 3).map(id => h('span', { class: 'ns-pchip' }, projName(id)));
      const more = (it.projects || []).length > 3 ? h('span', { class: 'dim ns-more' }, '+' + ((it.projects || []).length - 3)) : null;
      const sub = it.lastPrompt && it.lastPrompt !== it.firstPrompt ? '❯ ' + it.lastPrompt : tilde(it.cwd);
      return h('div', { class: 'ntrow ns-hrow', onclick: () => resume(it) },
        pid ? avatar(pid, 'sm') : rootTile(),
        h('div', { class: 'ntn' }, h('div', { class: 'ntt' }, h('span', { class: 'ns-ht' }, titleOf(it)), it.live ? h('span', { class: 'badge tag chat', title: 'running now: ' + it.live }, 'live') : null), h('div', { class: 'nts' }, sub), chips.length ? h('div', { class: 'ns-chips' }, chips, more) : null),
        h('div', { class: 'ns-meta dim' }, h('span', null, ago(it.lastAt)), it.prompts ? h('span', { title: 'prompts' }, it.prompts + ' ❯') : null));
    };
    const resume = it => {
      close();
      if (it.live) return openTerm(it.live);
      openTranscriptFile({ sessionId: it.id, cwd: it.cwd, account: it.account, file: it.file, title: titleOf(it), mtime: it.lastAt });
    };
    const loadHist = async () => {
      const n = ++R.seq; const q = hq.value.trim();
      if (!hlist.childElementCount) hlist.replaceChildren(h('div', { class: 'tsempty' }, 'loading…'));
      let r; try { r = await api(`history?account=${ST.acct}&limit=200&q=${encodeURIComponent(q)}`); } catch (e) { if (n === R.seq) hlist.replaceChildren(h('div', { class: 'tsempty' }, e.message)); return; }
      if (n !== R.seq) return;
      if (!r.items.length) { hlist.replaceChildren(h('div', { class: 'tsempty' }, q ? 'No conversation matches. Try “Search inside conversations”.' : `No ${ST.acct} conversations yet.`)); return; }
      const rows = []; let last = null;
      for (const it of r.items) { const g = dayGroup(it.lastAt || 0); if (g !== last) { rows.push(h('div', { class: 'tsec' }, g)); last = g; } rows.push(histRow(it)); }
      if (r.total > r.items.length) rows.push(h('div', { class: 'tsempty dim' }, `${r.total - r.items.length} older — narrow the search`));
      hlist.replaceChildren(...rows);
    };
    hq.oninput = () => { clearTimeout(R.timer); R.timer = setTimeout(loadHist, 250); };
    hq.onkeydown = async e => { if (e.key !== 'Enter') return; e.preventDefault(); clearTimeout(R.timer); await loadHist(); const r = hlist.querySelector('.ns-hrow'); if (r) r.click(); };
    const resumeBody = h('div', { class: 'ns-resume' }, h('div', { class: 'ns-sbar' }, hq, deep), hlist);

    const body = h('div', { class: 'ns-body' });
    const renderBody = () => {
      body.replaceChildren(ST.tab === 'new' ? newBody : resumeBody);
      box.classList.toggle('resume', ST.tab === 'resume');
      if (ST.tab === 'resume') { loadHist(); if (!IS_PHONE) setTimeout(() => hq.focus(), 0); }
      else if (!IS_PHONE) setTimeout(() => ta.focus(), 0);
    };
    const foot = h('div', { class: 'ns-foot' },
      h('button', { class: 'btn sm ghost', title: 'plain bash in ~/dev', onclick: () => { close(); newShell(); } }, ico('plus', 13), 'Plain shell'));
    const box = h('div', { class: 'box ntbox nsbox' },
      h('div', { class: 'sh' }, h('h3', null, '＋ New session'), h('span', { class: 'sp' }), acctSeg, h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: close }, ico('x', 15))),
      tabSeg, body, foot);
    m.replaceChildren(box); m.onclick = e => { if (e.target === m) close(); };
    renderAcct(); renderTabs(); renderChip(); renderBody();
    if (text && ST.tab === 'new') { ta.value = String(text).slice(0, 100000); runGuess(); }
  }

  function move(name) {
    const m = $('#modal'); m.classList.remove('hidden');
    const sess = S.runtime.sessions.find(x => x.name === name); const here = (sess && sess.claude && sess.claude.cwd) || '';
    let busy = false;
    const close = () => { m.classList.add('hidden'); document.removeEventListener('keydown', onEsc, true); };
    const onEsc = e => { if (!box.isConnected) { document.removeEventListener('keydown', onEsc, true); return; } if (e.key !== 'Escape' || m.classList.contains('hidden')) return; e.preventDefault(); e.stopPropagation(); close(); };
    document.addEventListener('keydown', onEsc, true);
    const q = h('input', { class: 'txt', placeholder: 'Search projects and folders…', autocomplete: 'off' });
    const list = h('div', { class: 'ntlist ns-picklist ns-movelist' });
    const status = h('div', { class: 'ns-status hidden' });
    const go = async c => {
      if (busy || c.cwd === here) return; busy = true; list.classList.add('busy');
      status.classList.remove('hidden'); status.classList.add('wait'); status.textContent = `Moving to ${c.name}…`;
      try { await api('chat-move', { session: name, target: targetOf(c) }); toast(`Chat moved to ${c.name} — same conversation, new folder`, 'ok'); close(); }
      catch (e) { status.classList.remove('wait'); status.textContent = 'Could not move: ' + e.message; busy = false; list.classList.remove('busy'); }
    };
    const row = c => h('div', { class: 'ntrow ns-prow' + (c.cwd === here ? ' on' : ''), title: c.cwd === here ? 'the chat is here now' : '', onclick: () => go(c) }, tileOf(c), h('div', { class: 'ntn' }, h('div', { class: 'ntt' }, c.name), h('div', { class: 'nts' }, subOf(c))), c.cwd === here ? h('span', { class: 'dim ns-why' }, 'here now') : null);
    const render = () => {
      const t = q.value.trim().toLowerCase(); const rows = [];
      const projs = S.projects.filter(p => !p.hidden && (!t || [p.name, p.dirName, p.org, p.group].join(' ').toLowerCase().includes(t))).slice(0, t ? 40 : 200);
      if (projs.length) rows.push(h('div', { class: 'tsec' }, 'Projects'), ...projs.map(p => row(fromProject(p))));
      const orgs = [...new Set(S.projects.filter(p => !p.hidden).map(p => p.org).filter(Boolean))].filter(o => !t || o.toLowerCase().includes(t));
      if (orgs.length) rows.push(h('div', { class: 'tsec' }, 'Org folders'), ...orgs.map(o => row(fromOrg(o))));
      rows.push(h('div', { class: 'tsec' }, 'No project'), row(ROOT()));
      list.replaceChildren(...rows);
    };
    q.oninput = render;
    q.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); const r = list.querySelector('.ntrow:not(.on)'); if (r) r.click(); } };
    const box = h('div', { class: 'box ntbox nsbox' },
      h('div', { class: 'sh' }, h('h3', null, 'Move chat'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: close }, ico('x', 15))),
      h('div', { class: 'dim ns-movehint' }, `${sess ? sessTitle(sess) : name} keeps its conversation; Claude continues in the folder you pick.`),
      q, list, status);
    m.replaceChildren(box); m.onclick = e => { if (e.target === m) close(); };
    render(); if (!IS_PHONE) setTimeout(() => q.focus(), 0);
  }

  FEAT.session = { open, move };
})();
