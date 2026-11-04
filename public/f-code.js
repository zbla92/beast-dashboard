'use strict';
FEAT.code = (() => {
  const SKEY = 'bd.code.scope';
  const det = new Map();
  const WSC = new Map();
  const WS = { on: localStorage.getItem('bd.code.ws') === '1', w: +localStorage.getItem('bd.code.wsw') || 460, host: null };

  const phone = () => matchMedia('(max-width: 900px)').matches;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const wipOf = () => S.wip || { roots: [], groups: [] };
  const wipRoot = id => wipOf().roots.find(r => r.id === id) || null;
  const pending = r => r ? r.staged + r.unstaged + r.untracked + r.conflicts : 0;
  const sessOf = name => S.runtime.sessions.find(s => s.name === name) || null;
  const enc = encodeURIComponent;
  const OVW = { kind: 'overview', id: 'overview', title: 'Work in progress' };
  const MODE = { staged: 'Staged', unstaged: 'Unstaged', untracked: 'New file', head: 'vs HEAD', file: 'File', conflict: 'vs HEAD' };

  function rootInfo(id) {
    const w = wipRoot(id); if (w) return w;
    const d = det.get(id)?.data?.root; if (d) return d;
    const p = byId()[id]; if (!p) return { id, project: id.split('~')[0], name: id, branch: null, worktree: id.includes('~'), staged: 0, unstaged: 0, untracked: 0, conflicts: 0, add: 0, del: 0, ahead: 0, behind: 0, live: [], flags: [] };
    const g = gitOf(p) || {};
    return { id, project: id, name: p.name, path: p.path, org: p.org, set: p.set || id, branch: g.branch || null, worktree: false, upstream: g.upstream, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, add: 0, del: 0, ahead: g.ahead || 0, behind: g.behind || 0, live: [], flags: [] };
  }

  function setName(id) {
    const p = byId()[id];
    if (p) return p.setName || p.name;
    const m = S.projects.find(x => x.set === id); return m ? m.setName || m.name : id;
  }

  function setRoots(set) {
    const mains = S.projects.filter(p => p.set === set && p.isGit && !p.hidden).sort((a, b) => a.name.localeCompare(b.name));
    const wts = wipOf().roots.filter(r => r.set === set && r.worktree);
    const out = [];
    for (const p of mains) { out.push(p.id); for (const w of wts) if (w.project === p.id) out.push(w.id); }
    for (const w of wipOf().roots) if (w.set === set && !out.includes(w.id)) out.push(w.id);
    return out;
  }

  function wsRoots(ws) { return ws ? [...new Set([...ws.sets.flatMap(setRoots), ...ws.roots])] : []; }

  function wipCards() {
    const W = wipOf(); const grouped = new Map();
    for (const g of W.groups || []) for (const id of g.roots) grouped.set(id, g.branch);
    const orgs = [...new Set(W.roots.map(r => r.org || ''))].sort((a, b) => (!a - !b) || a.localeCompare(b));
    const out = [];
    for (const org of orgs) {
      const inOrg = W.roots.filter(r => (r.org || '') === org);
      const cards = [];
      for (const set of [...new Set(inOrg.filter(r => !grouped.has(r.id)).map(r => r.set))]) {
        const rs = inOrg.filter(r => r.set === set && !grouped.has(r.id));
        cards.push({ kind: 'set', id: set, title: setName(set), pid: byId()[set] ? set : rs[0].project, rs });
      }
      for (const g of W.groups || []) {
        const rs = inOrg.filter(r => grouped.get(r.id) === g.branch); if (!rs.length) continue;
        cards.push({ kind: 'group', id: g.branch, title: g.branch, rs });
      }
      out.push({ org, cards });
    }
    return out;
  }

  function sigOf(id) { const r = wipRoot(id); return r ? [r.staged, r.unstaged, r.untracked, r.conflicts, r.add, r.del, r.ahead, r.behind, r.stashes, r.newest, r.branch, r.op].join() : 'clean'; }

  async function loadDetail(id) {
    const r = wipRoot(id); const sig = sigOf(id);
    const c = det.get(id);
    if (c && (c.sig === sig || c.loading) && (r || Date.now() - c.at < 60000)) return c;
    const e = { sig, at: Date.now(), loading: true, data: c?.data || null };
    det.set(id, e);
    try { e.data = await api('wip/' + enc(id)); } catch (err) { e.data = { error: err.message }; }
    e.loading = false; e.at = Date.now();
    repaint();
    return e;
  }

  let wipSigOf = null, wipSig = '';
  function wipSignature() {
    const W = wipOf(); if (W === wipSigOf) return wipSig;
    wipSigOf = W; wipSig = W.roots.map(r => r.id + ':' + pending(r) + ':' + (r.newest || 0) + ':' + r.ahead).join('|');
    return wipSig;
  }

  function wsOf(name, force) {
    if (!name || !sessOf(name)?.claude) return null;
    const c = WSC.get(name); const cl = sessOf(name).claude;
    const sig = wipSignature() + '#' + cl.state;
    const stale = c && !c.loading && c.sig !== sig && Date.now() - c.at > 3000;
    if (!c || force || stale || (c && !c.loading && c.err && Date.now() - c.at > 60000)) {
      const e = { at: Date.now(), loading: true, sig, data: c?.data || null, err: null };
      WSC.set(name, e);
      api('workspace?session=' + enc(name)).then(d => { e.data = d; }).catch(err => { e.err = err.message; }).finally(() => { e.loading = false; e.at = Date.now(); repaint(); });
      return e.data;
    }
    return c.data;
  }
  const wsErr = name => WSC.get(name)?.err || null;

  function liveDots(r) {
    if (!r.live || !r.live.length) return null;
    return h('span', { class: 'wlive' }, r.live.map(name => {
      const s = sessOf(name); const st = s?.claude?.state || 'unknown';
      return h('button', { class: 'wdot st-' + st, title: (s?.claude?.label || name) + ' · ' + (STATE_LABEL[st] || st) + ' — open', onclick: ev => { ev.stopPropagation(); openTerm(name); } });
    }));
  }

  function counts(r) {
    return [
      r.staged ? h('span', { class: 'wc s', title: r.staged + ' staged' }, 'S ' + r.staged) : null,
      r.unstaged ? h('span', { class: 'wc m', title: r.unstaged + ' modified' }, 'M ' + r.unstaged) : null,
      r.untracked ? h('span', { class: 'wc u', title: r.untracked + ' untracked' }, 'U ' + r.untracked) : null,
      r.conflicts ? h('span', { class: 'wc x', title: r.conflicts + ' conflicted' }, '! ' + r.conflicts) : null,
      r.add || r.del ? h('span', { class: 'wl' }, h('i', { class: 'a' }, '+' + r.add), ' ', h('i', { class: 'd' }, '−' + r.del)) : null,
      r.ahead ? h('span', { class: 'wa hot', title: r.ahead + ' not pushed' }, '⬆' + r.ahead) : null,
      r.behind ? h('span', { class: 'wa', title: r.behind + ' behind' }, '⬇' + r.behind) : null,
      r.op ? h('span', { class: 'wop' }, r.op) : null,
    ];
  }

  function splitPath(rel) { const i = rel.lastIndexOf('/'); return i < 0 ? ['', rel] : [rel.slice(0, i + 1), rel.slice(i + 1)]; }

  function modesOf(f) {
    if (!f) return ['head', 'file'];
    if (f.status === '?') return ['untracked', 'file'];
    if (f.status === 'U') return ['head', 'file'];
    const m = [];
    if (f.x !== '.') m.push('staged');
    if (f.y !== '.') m.push('unstaged');
    if (m.length > 1) m.push('head');
    if (f.y !== 'D' && !(f.x === 'D' && f.y === '.')) m.push('file');
    return m;
  }

  function rootForPath(abs) {
    for (const c of WSC.values()) for (const [root, arr] of Object.entries(c.data?.edited || {})) {
      const base = rootInfo(root).path; if (!base) continue;
      const x = arr.find(e => base.replace(/\/$/, '') + '/' + e.rel === abs); if (x) return { root, rel: x.rel };
    }
    let best = null, len = 0;
    const cands = [...wipOf().roots.map(r => ({ id: r.id, path: r.path })), ...S.projects.filter(p => p.isGit).map(p => ({ id: p.id, path: p.path }))];
    for (const c of cands) {
      if (!c.path) continue; const base = c.path.replace(/\/$/, '') + '/';
      if (abs.startsWith(base) && base.length > len) { best = { root: c.id, rel: abs.slice(base.length) }; len = base.length; }
    }
    return best;
  }

  function addToChat(ev, q, label) {
    const live = S.runtime.sessions.filter(s => s.claude && s.claude.state !== 'ended');
    if (!live.length) { toast('No live Claude session to add it to', 'err'); return; }
    openMenu(ev, [{ header: 'Add work in progress to…' }, ...live.map(s => ({
      label: s.claude.label || chatTitle(s.claude) || s.name, sub: s.name, icon: '✦',
      onclick: async () => { try { const { text } = await api('wip-brief?' + q); FEAT.wip.insertDraft(s.name, text); openTerm(s.name); toast(label + ' added to the draft — review and send'); } catch (e) { toast('brief failed: ' + e.message, 'err'); } },
    }))]);
  }

  function make(kind) {
    const panel = kind === 'panel';
    const C = { scope: null, focus: null, file: null, commit: null, tab: 'changes', q: '', step: panel ? 'list' : 'scope', from: null, fromTerm: null, ws: null, sess: null, prev: null, layers: 0, showAll: new Set() };
    const TREE = { open: new Set(JSON.parse(localStorage.getItem('bd.code.fopen') || '[]')), sel: null, mode: 'auto', editing: false, wide: false };
    const ovHost = h('div', { class: 'cvovw-in' });
    let el = null, paneL = null, listL = null, qIn = null, paneM = null, paneR = null, keyL = '', keyM = '', keyR = '', viewTok = 0;
    if (!panel) { try { C.scope = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch { C.scope = null; } }

    const stacked = () => panel || phone();
    const layered = () => !panel && phone();

    function saveScope() { if (!panel && C.scope && C.scope.kind !== 'session') localStorage.setItem(SKEY, JSON.stringify(C.scope)); }

    function scopeRoots(s = C.scope) {
      if (!s) return [];
      if (s.kind === 'set') return [...new Set([...setRoots(s.id), ...(s.roots || [])])];
      if (s.kind === 'overview') return [];
      if (s.kind === 'session') { const ed = C.ws?.edited || {}; const rank = id => ed[id]?.length ? 0 : pending(wipRoot(id)) || wipRoot(id)?.ahead ? 1 : 2; return wsRoots(C.ws).map((id, i) => [rank(id), i, id]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map(x => x[2]); }
      return s.roots || [];
    }

    function scopeValid(s) {
      if (s.kind === 'session') return !!C.ws;
      if (s.kind === 'overview') return true;
      if (!S.projects.length) return true;
      if (s.kind === 'set') return S.projects.some(p => p.set === s.id || p.id === s.id);
      return (s.roots || []).some(id => byId()[id] || wipRoot(id) || (id.includes('~') && byId()[id.split('~')[0]]));
    }

    function sessTitle() { const s = C.ws && sessOf(C.ws.session); return s?.claude?.label || (s?.claude ? chatTitle(s.claude) : '') || C.ws?.session || 'session'; }

    function pickScope(scope, opts = {}) {
      C.scope = scope; C.prev = null; C.file = null; C.commit = null; C.tab = 'changes';
      const rs = scopeRoots(); C.focus = rs.includes(opts.focus) ? opts.focus : rs[0] || null;
      saveScope();
      if (layered() && C.step === 'scope') { C.step = 'list'; pushLayer('code'); C.layers++; }
      paint(true);
    }

    function scopeIs(k, id) { return C.scope && C.scope.kind === k && C.scope.id === id; }

    function buildLeft() {
      if (panel) return;
      if (!listL) {
        qIn = h('input', { class: 'txt cvq', placeholder: 'Find a project…', autocomplete: 'off', oninput: e => { C.q = e.target.value.trim().toLowerCase(); paintLeft(); }, onkeydown: e => e.stopPropagation() });
        listL = h('div', { class: 'cvl-list' });
        paneL.replaceChildren(h('div', { class: 'cvh' }, h('b', null, 'Code'), h('span', { class: 'wsp' })), listL);
      }
      paintLeft();
    }

    function paintLeft() {
      if (!listL) return;
      const W = wipOf();
      const key = JSON.stringify([C.scope, C.q, C.ws && [C.ws.session, C.ws.roots], W.roots.map(r => [r.id, pending(r), r.ahead, r.live.length]), W.groups, S.projects.length]);
      if (key === keyL) return; keyL = key;
      const out = [];
      if (C.ws) {
        const n = wsRoots(C.ws).length;
        out.push(h('div', { class: 'cvsec' }, 'This session'),
          h('button', { class: 'cvi' + (C.scope?.kind === 'session' ? ' on' : ''), onclick: () => pickScope({ kind: 'session', id: C.ws.session, title: sessTitle() }) },
            h('span', { class: 'cvi-ic ses' }, '✦'), h('span', { class: 'cvi-t' }, sessTitle()), h('span', { class: 'cvi-n' }, plural(n, 'repo'))));
      }
      if (!C.q) {
        out.push(h('div', { class: 'cvsec' }, 'Work in progress'));
        const act = W.roots.filter(r => pending(r) || r.ahead || r.op);
        out.push(h('button', { class: 'cvi' + (C.scope?.kind === 'overview' ? ' on' : ''), title: 'every repo with pending changes or unpushed commits', onclick: () => pickScope(OVW) },
          h('span', { class: 'cvi-ic ovw' }, '▦'), h('span', { class: 'cvi-t' }, 'Overview'), h('span', { class: 'cvi-n' }, act.length ? plural(act.length, 'repo') : '')));
        const groups = wipCards();
        if (!groups.length) out.push(h('div', { class: 'cvempty' }, W.at ? 'Every repo is clean.' : 'Reading the repos…'));
        for (const g of groups) {
          if (g.org) out.push(h('div', { class: 'cvorg', style: `--org:${orgColor(g.org)}` }, h('i'), g.org));
          for (const c of g.cards) {
            const files = c.rs.reduce((a, r) => a + pending(r), 0); const ahead = c.rs.reduce((a, r) => a + r.ahead, 0);
            const sc = c.kind === 'set' ? { kind: 'set', id: c.id, title: c.title } : { kind: 'group', id: c.id, title: c.title, roots: c.rs.map(r => r.id) };
            out.push(h('button', { class: 'cvi' + (scopeIs(sc.kind, sc.id) ? ' on' : ''), title: c.title, onclick: () => pickScope(sc) },
              c.kind === 'set' ? avatar(c.pid, 'sm') : h('span', { class: 'cvi-ic wt' }, '⎇'),
              h('span', { class: c.kind === 'group' ? 'cvi-t mono' : 'cvi-t' }, c.title),
              c.rs.some(r => r.live.length) ? h('i', { class: 'cvi-live' }) : null,
              h('span', { class: 'cvi-n' }, [files ? String(files) : null, ahead ? '⬆' + ahead : null].filter(Boolean).join(' '))));
          }
        }
      }
      out.push(h('div', { class: 'cvsec' }, 'All projects'), qIn);
      const q = C.q;
      const list = S.projects.filter(p => p.isGit && !p.hidden && (!q || [p.name, p.rel, p.org, p.setName].join(' ').toLowerCase().includes(q)))
        .sort((a, b) => (a.org || '').localeCompare(b.org || '') || a.name.localeCompare(b.name));
      for (const p of list) {
        const w = wipRoot(p.id); const g = gitOf(p) || {};
        const n = w ? pending(w) : (g.dirty || 0) + (g.untracked || 0);
        out.push(h('button', { class: 'cvi sm' + (scopeIs('root', p.id) ? ' on' : ''), title: p.rel || p.name, onclick: () => pickScope({ kind: 'root', id: p.id, title: p.name, roots: [p.id] }) },
          avatar(p.id, 'sm'), h('span', { class: 'cvi-t' }, p.name), n ? h('span', { class: 'cvi-n' }, String(n)) : null));
      }
      if (!list.length) out.push(h('div', { class: 'cvempty' }, 'No project matches.'));
      const keepFocus = document.activeElement === qIn;
      listL.replaceChildren(...out);
      if (keepFocus) qIn.focus();
    }

    function shortName(r) { const set = setName(C.scope.id).toLowerCase() + '-'; const n = r.name || ''; return n.toLowerCase().startsWith(set) && n.length > set.length ? n.slice(set.length) : n; }
    function shortName0(id) { const r = rootInfo(id); return C.scope?.kind === 'set' ? shortName(r) : r.name + (r.worktree ? ' ⎇' : ''); }

    function scopeHead(rs) {
      const s = C.scope;
      const tot = rs.map(rootInfo).reduce((a, r) => ({ files: a.files + pending(r), ahead: a.ahead + (r.ahead || 0) }), { files: 0, ahead: 0 });
      const focus = C.focus && rootInfo(C.focus);
      const sum = [plural(rs.length, 'repo'), tot.files ? plural(tot.files, 'file') : null, tot.ahead ? '⬆ ' + tot.ahead : null].filter(Boolean).join(' · ');
      if (panel) return h('div', { class: 'cvh' },
        h('div', { class: 'cvh-t' }, h('b', null, 'Files of this session'), h('span', { class: 'cvh-n' }, sum)),
        h('span', { class: 'wsp' }),
        h('button', { class: 'btn sm ghost', title: 'add the work in progress of these repos to the message draft', onclick: () => addWip(C.ws?.session) }, '+ WIP'),
        h('button', { class: 'btn sm ghost icon', title: 'open the full Code view for this session', onclick: () => FEAT.code.open({ session: C.ws?.session }) }, ico('full', 15)),
        h('button', { class: 'btn sm ghost icon', title: 'close the panel', onclick: () => toggleWs(false) }, ico('x', 15)));
      return h('div', { class: 'cvh' },
        phone() ? h('button', { class: 'btn ghost icon cvback', 'aria-label': 'back', onclick: () => back(true) }, ico('back', 18)) : null,
        h('div', { class: 'cvh-t' }, h('b', null, s.title || s.id), h('span', { class: 'cvh-n' }, sum)),
        h('span', { class: 'wsp' }),
        h('div', { class: 'seg' },
          h('button', { class: C.tab === 'changes' ? 'segb on' : 'segb', onclick: () => { C.tab = 'changes'; paint(true); } }, 'Changes'),
          h('button', { class: C.tab === 'tree' ? 'segb on' : 'segb', title: focus ? 'files of ' + focus.name : '', onclick: () => { C.tab = 'tree'; paint(true); } }, 'Files')),
        h('button', { class: 'wmore', title: 'more', 'aria-label': 'more', onclick: ev => scopeMenu(ev, rs) }, '⋯'));
    }

    function scopeMenu(ev, rs) {
      const s = C.scope; const q = s.kind === 'set' ? 'set=' + enc(s.id) : s.kind === 'root' ? 'root=' + enc(s.id) : null;
      openMenu(ev, [
        q ? { label: 'Add to chat…', sub: 'work-in-progress brief into a session draft', icon: '✦', onclick: () => addToChat(ev, q, s.title) } : null,
        s.kind === 'session' && C.ws ? { label: 'Add to this chat', sub: 'work-in-progress brief into the draft', icon: '✦', onclick: () => addWip(C.ws.session) } : null,
        s.kind === 'session' && C.ws ? { label: 'Open the session', icon: '▸', onclick: () => openTerm(C.ws.session) } : null,
        C.focus ? { label: 'Project details', icon: 'ⓘ', onclick: () => openDrawer(rootInfo(C.focus).project, 'overview') } : null,
        { label: 'Copy link', icon: '⎘', onclick: () => { const u = new URL(location.origin + location.pathname); u.searchParams.set('view', 'code'); if (s.kind === 'set') u.searchParams.set('set', s.id); else if (s.kind === 'session') u.searchParams.set('session', s.id); else u.searchParams.set('root', C.focus || rs[0]); navigator.clipboard?.writeText(u.href).then(() => toast('link copied')); } },
      ].filter(Boolean));
    }

    function hotFile() {
      if (!C.ws) return null;
      const st = sessOf(C.ws.session)?.claude?.state;
      if (st !== 'working' && st !== 'background') return null;
      let best = null;
      for (const [root, arr] of Object.entries(C.ws.edited || {})) for (const x of arr) if (!best || x.seq > best.seq) best = { root, rel: x.rel, seq: x.seq };
      return best;
    }

    function fileRow(root, f, kind, mine, hot) {
      const [dir, base] = splitPath(f.rel);
      const on = C.file && C.file.root === root && C.file.rel === f.rel && C.file.kind === kind;
      const ed = f.editors || [];
      const st = kind === 'staged' ? f.x : kind === 'unstaged' ? f.y : f.status;
      const letter = st === '?' ? '?' : st || 'M';
      const go = () => openFile({ root, rel: f.rel, kind, f });
      return h('div', { class: 'cvf' + (on ? ' on' : '') + (mine ? ' mine' : '') + (hot ? ' hot' : ''), role: 'button', tabindex: '0', title: f.rel + (ed.length ? '\n' + ed.map(e => '✦ ' + (e.label || e.sessionId.slice(0, 8)) + ' · ' + ago(e.at)).join('\n') : ''),
        onclick: go, onkeydown: ev => { if (ev.key === 'Enter') go(); } },
        h('span', { class: 'chst s' + (letter === '?' ? 'Q' : letter) }, letter), fileIcon(base),
        h('span', { class: 'cvf-p' }, dir ? h('span', { class: 'cvf-d' }, '‎' + dir + '‎') : null, h('b', null, f.from && kind !== 'unstaged' ? splitPath(f.from)[1] + ' → ' + base : base)),
        hot ? h('span', { class: 'cvf-hot', title: 'being edited right now' }) : mine ? h('span', { class: 'cvf-me', title: 'edited in this session' }, '●') : null,
        ed.length ? h('span', { class: 'cvf-ed' + (ed[0].live ? ' on' : ''), title: ed.map(e => (e.label || e.sessionId.slice(0, 8)) + ' · ' + ago(e.at)).join('\n') }, '✦') : null,
        f.binary ? h('span', { class: 'dim' }, 'bin') : null,
        f.add != null && kind !== 'untracked' && (f.add || f.del) ? h('span', { class: 'cvf-n' }, h('i', { class: 'a' }, '+' + f.add), ' ', h('i', { class: 'd' }, '−' + f.del)) : null);
    }

    function commitRow(root, c) {
      const on = C.commit && C.commit.root === root && C.commit.hash === c.hash;
      return h('div', { class: 'cvc' + (c.unpushed ? ' unp' : '') + (on ? ' on' : ''), role: 'button', tabindex: '0', title: `${c.subject}\n${c.author} · ${c.rel}${c.unpushed ? '\nNOT PUSHED' : ''}`, onclick: () => openCommit(root, c) },
        h('span', { class: 'cdot' }), h('b', { class: 'mono' }, c.hash), h('span', { class: 'cvc-s' }, c.subject), h('span', { class: 'cvc-w' }, c.author), h('span', { class: 'cvc-t mono' }, ago(c.at)));
    }

    function rootBlock(id, many, hot) {
      const r = rootInfo(id); const e = det.get(id); const d = e?.data;
      const edited = C.ws?.edited?.[id] || [];
      const need = !many || pending(r) || r.ahead || r.op || C.focus === id;
      if (need && (!e || (!e.loading && e.sig !== sigOf(id)))) loadDetail(id);
      const mine = new Set(edited.map(x => x.rel));
      const short = C.scope?.kind === 'set' ? shortName(r) : r.name;
      const head = h('div', { class: 'cvr-h' + (C.focus === id ? ' focus' : ''), onclick: () => { if (C.focus !== id) { C.focus = id; paint(true); } } },
        avatar(r.project, 'sm'), h('b', { class: 'cvr-n' }, short), r.worktree ? h('span', { class: 'wwt', title: 'git worktree · ' + (r.path || '') }, '⎇') : null,
        h('span', { class: 'wbr', title: r.upstream ? 'tracks ' + r.upstream : 'no upstream' }, r.branch || '?'),
        h('span', { class: 'wsp' }), edited.length ? h('span', { class: 'cvr-me', title: 'files this session edited here' }, '● ' + edited.length) : null, liveDots(r),
        h('button', { class: 'wmore', title: 'project details', 'aria-label': 'project details', onclick: ev => { ev.stopPropagation(); openDrawer(r.project, r.worktree ? 'worktrees' : 'changes'); } }, 'ⓘ'));
      const sub = h('div', { class: 'cvr-c wr2' }, ...counts(r), !pending(r) && !r.ahead && !r.op ? h('span', { class: 'dim' }, 'clean') : null);
      const body = [];
      if (need && !d) body.push(h('div', { class: 'cvempty' }, 'loading…'));
      if (d && d.error) body.push(h('div', { class: 'cvempty' }, d.error));
      if (d && !d.error) {
        const fs_ = d.files || [];
        const conf = fs_.filter(f => f.status === 'U');
        const staged = fs_.filter(f => f.status !== 'U' && f.x !== '.' && f.x !== '?');
        const unst = fs_.filter(f => f.status !== 'U' && f.y !== '.' && f.y !== '?');
        const untr = fs_.filter(f => f.status === '?');
        let left = C.showAll.has(id) ? Infinity : panel ? 40 : 80;
        const isHot = f => hot && hot.root === id && hot.rel === f.rel;
        const sec = (title, arr, k, cls) => {
          if (!arr.length) return;
          body.push(h('div', { class: 'cvs ' + cls }, title, h('span', { class: 'n' }, arr.length)));
          for (const f of arr) { if (left-- <= 0) break; body.push(fileRow(id, f, k, mine.has(f.rel), isHot(f))); }
        };
        sec('Conflicts', conf, 'conflict', 'x');
        sec('Staged', staged, 'staged', 'ok');
        sec('Changes', unst, 'unstaged', 'warn');
        sec('Untracked', untr, 'untracked', 'new');
        if (left < 0 || d.truncated) body.push(h('button', { class: 'btn sm ghost cvmore', onclick: () => { C.showAll.add(id); paint(true); } }, d.truncated ? 'first 500 files shown — open the project for all' : 'show all files'));
        const un = d.commits?.unpushed || []; const rec = (d.commits?.recent || []).filter(c => !un.some(u => u.hash === c.hash));
        if (un.length) { body.push(h('div', { class: 'cvs hot' }, 'Not pushed', h('span', { class: 'n' }, un.length))); for (const c of un) body.push(commitRow(id, c)); }
        if (rec.length && (!many || C.focus === id || un.length)) { body.push(h('div', { class: 'cvs' }, 'Last 24 h', h('span', { class: 'n' }, rec.length))); for (const c of rec.slice(0, many ? 5 : 30)) body.push(commitRow(id, c)); }
        if (d.stashes?.length) { body.push(h('div', { class: 'cvs' }, 'Stashes', h('span', { class: 'n' }, d.stashes.length))); for (const s of d.stashes) body.push(h('div', { class: 'cvst' }, h('b', { class: 'mono' }, s.ref), h('span', { class: 'cvc-s' }, s.msg), h('span', { class: 'cvc-t mono' }, ago(s.at)))); }
        const wts = (d.worktrees || []).filter(w => w.id !== id);
        if (wts.length && !panel) {
          body.push(h('div', { class: 'cvs' }, 'Worktrees', h('span', { class: 'n' }, wts.length)));
          body.push(h('div', { class: 'cvwts' }, wts.map(w => h('button', { class: 'cvwt', title: w.path, onclick: () => pickScope({ kind: 'root', id: w.id, title: (byId()[w.id.split('~')[0]]?.name || w.id.split('~')[0]) + (w.worktree ? ' ⎇ ' + w.branch : ''), roots: [w.id] }) }, h('span', { class: 'wwt' }, w.worktree ? '⎇' : '◆'), h('span', { class: 'mono' }, w.branch || '?'), w.dirty ? h('span', { class: 'wc m' }, String(w.dirty)) : null, w.live?.length ? h('i', { class: 'cvi-live' }) : null))));
        }
      }
      return h('div', { class: 'cvr' + (C.focus === id ? ' focus' : '') }, head, sub, ...body);
    }

    function paintMiddle(force) {
      if (C.scope?.kind === 'overview') {
        if (force || keyM !== 'ovw' || !paneM.contains(ovHost)) {
          keyM = 'ovw';
          paneM.replaceChildren(...[phone() ? h('div', { class: 'cvh' }, h('button', { class: 'btn ghost icon cvback', 'aria-label': 'back', onclick: () => back(true) }, ico('back', 18)), h('span', { class: 'dim' }, 'Code')) : null, h('div', { class: 'cvm-body cvovw' }, ovHost)].filter(Boolean));
        }
        FEAT.wip?.grid(ovHost);
        return;
      }
      if (!C.scope) {
        const ek = 'empty:' + (panel ? wsErr(TERM.active) : '');
        if (keyM === ek) return; keyM = ek;
        if (panel) { const err = wsErr(TERM.active); paneM.replaceChildren(h('div', { class: 'cvh' }, h('div', { class: 'cvh-t' }, h('b', null, 'Files of this session')), h('span', { class: 'wsp' }), h('button', { class: 'btn sm ghost icon', title: 'close the panel', onclick: () => toggleWs(false) }, ico('x', 15))), h('div', { class: 'cvhint' }, h('b', null, err ? 'Could not read this session' : 'Reading this session…'), err ? h('span', null, err) : null)); return; }
        paneM.replaceChildren(h('div', { class: 'cvhint' }, panel ? h('b', null, 'Reading this session…') : [h('b', null, 'Pick a set or a repo'), h('span', null, 'Work in progress lists every repo with pending changes or unpushed commits. Click one to see its files, commits and diffs.')]));
        return;
      }
      const rs = scopeRoots();
      if (C.tab === 'tree' && !panel) {
        const id = C.focus || rs[0];
        const key = 'tree:' + id;
        if (!force && key === keyM) return; keyM = key;
        const host = h('div', { class: 'cvtree' });
        paneM.replaceChildren(...[scopeHead(rs), rs.length > 1 ? h('div', { class: 'cvfocus' }, rs.map(x => h('button', { class: 'chip' + (x === id ? ' on' : ''), onclick: () => { C.focus = x; paint(true); } }, shortName0(x)))) : null, host].filter(Boolean));
        const r = rootInfo(id);
        if (id) tabFiles(host, { id, isGit: true, name: r.name, rel: '', path: r.path }, { st: TREE, key: 'bd.code.fopen' });
        return;
      }
      const hot = hotFile();
      const key = JSON.stringify([C.scope, C.focus, C.file && [C.file.root, C.file.rel, C.file.kind], C.commit, [...C.showAll], rs.map(id => [id, sigOf(id), det.get(id)?.at, (wipRoot(id)?.live || []).map(n => sessOf(n)?.claude?.state)]), C.ws && C.ws.edited, hot, Math.floor(Date.now() / 60000)]);
      if (!force && key === keyM) return; keyM = key;
      const top = paneM.querySelector('.cvm-body')?.scrollTop || 0;
      const bodyEl = h('div', { class: 'cvm-body' }, rs.length ? rs.map(id => rootBlock(id, rs.length > 1, hot)) : h('div', { class: 'cvempty' }, C.scope.kind === 'session' ? 'This session has not touched a repo yet.' : 'No repos.'));
      paneM.replaceChildren(scopeHead(rs), bodyEl);
      bodyEl.scrollTop = top;
    }

    function forward() { if (stacked() && C.step !== 'view') { C.step = 'view'; if (layered()) { pushLayer('code'); C.layers++; } } }

    function openFile(sel) {
      const modes = modesOf(sel.f);
      const mode = sel.mode || (sel.kind === 'conflict' ? 'head' : modes.includes(sel.kind) ? sel.kind : modes[0]);
      C.file = { root: sel.root, rel: sel.rel, kind: sel.kind, mode, f: sel.f || null }; C.commit = null;
      C.focus = sel.root;
      forward();
      paint(true);
    }
    function openCommit(root, c) {
      C.commit = { root, hash: c.hash, subject: c.subject }; C.file = null; C.focus = root;
      forward();
      paint(true);
    }

    function refine(root, rel) {
      if (!C.file || C.file.root !== root || C.file.rel !== rel || C.file.f) return;
      const f = (det.get(root)?.data?.files || []).find(x => x.rel === rel); if (!f) return;
      const modes = modesOf(f);
      const kind = f.status === '?' ? 'untracked' : f.status === 'U' ? 'conflict' : modes[0];
      C.file = { ...C.file, kind, f, mode: kind === 'conflict' ? 'head' : modes.includes(kind) ? kind : modes[0] };
      paint(true);
    }

    function openPath(root, rel) {
      const f = (det.get(root)?.data?.files || []).find(x => x.rel === rel) || null;
      const modes = modesOf(f);
      openFile({ root, rel, kind: f ? (f.status === '?' ? 'untracked' : f.status === 'U' ? 'conflict' : modes[0]) : 'head', f, mode: f ? null : 'head' });
    }

    function viewerBar(kids) {
      return h('div', { class: 'cvh cvv-h' }, stacked() ? h('button', { class: 'btn ghost icon cvback', 'aria-label': 'back', onclick: () => back(true) }, ico('back', 18)) : null, ...kids);
    }

    async function paintRight(force) {
      const key = JSON.stringify([C.file && [C.file.root, C.file.rel, C.file.mode], C.commit, C.tab, C.scope?.kind === 'overview']);
      if (!force && key === keyR) return; keyR = key;
      if ((C.tab === 'tree' && !panel) || C.scope?.kind === 'overview') { paneR.replaceChildren(); return; }
      const tok = ++viewTok;
      if (C.commit) {
        const { root, hash, subject } = C.commit;
        const box = h('div', { class: 'cvv-b cvcommit' }, h('div', { class: 'cvempty' }, 'loading…'));
        paneR.replaceChildren(viewerBar([h('span', { class: 'chst sM' }, '●'), h('span', { class: 'cvv-p' }, h('span', { class: 'dim' }, ' ' + shortName0(root) + ' · '), h('b', null, subject))]), box);
        try { const c = await api(`git/${enc(root)}/commit/${enc(hash)}`); if (tok !== viewTok) return; renderCommit(box, { id: root }, c); } catch (e) { if (tok === viewTok) box.textContent = e.message; }
        return;
      }
      if (!C.file) {
        paneR.replaceChildren(h('div', { class: 'cvhint' }, h('b', null, 'Pick a file or a commit'), h('span', null, 'Staged, unstaged and vs HEAD diffs, or the file itself.')));
        return;
      }
      const { root, rel, mode, f } = C.file; const r = rootInfo(root);
      const name = rel.split('/').pop();
      const abs = r.path ? r.path.replace(/\/$/, '') + '/' + rel : rel;
      const modes = f ? modesOf(f) : ['head', 'file'];
      const raw = `/api/download/${enc(root)}?path=${enc(rel)}`;
      const box = h('div', { class: 'cvv-b' }, h('div', { class: 'cvempty' }, 'loading…'));
      const [dir, base] = splitPath(rel);
      paneR.replaceChildren(viewerBar([
        fileIcon(name), h('span', { class: 'cvv-p', title: abs }, h('span', { class: 'cvf-d' }, '‎' + (stacked() ? '' : shortName0(root) + ' / ') + dir + '‎'), h('b', null, base)),
        h('span', { class: 'wsp' }),
        h('div', { class: 'seg' }, modes.map(m => h('button', { class: m === mode ? 'segb on' : 'segb', onclick: () => { C.file = { ...C.file, mode: m }; paint(); } }, MODE[m]))),
        h('button', { class: 'btn sm ghost', title: 'copy path', onclick: () => navigator.clipboard?.writeText(abs).then(() => toast('copied ' + abs)) }, ico('copy', 14)),
        mode === 'file' || f?.status === '?' ? h('a', { class: 'btn sm ghost', href: raw + '&inline=1', target: '_blank', rel: 'noopener', title: 'open raw in a new tab' }, ico('ext', 14)) : null,
        h('a', { class: 'btn sm ghost', href: raw, download: name, title: 'download' }, '⇩'),
        h('button', { class: 'btn sm ghost', title: 'open the project drawer', onclick: () => openDrawer(r.project, 'changes') }, 'ⓘ'),
      ]), box);
      try {
        if (mode === 'file') {
          const media = mediaOf(name);
          if (media === 'img') { box.replaceChildren(h('div', { class: 'fmedia' }, h('img', { src: raw + '&inline=1', alt: name }))); return; }
          if (media === 'video') { box.replaceChildren(h('div', { class: 'fmedia' }, h('video', { src: raw + '&inline=1', controls: '' }))); return; }
          if (media === 'pdf') { box.replaceChildren(h('iframe', { class: 'fmedia pdf', src: raw + '&inline=1', title: name })); return; }
          const c = await api(`read/${enc(root)}?path=${enc(rel)}`); if (tok !== viewTok) return;
          if (c.error) { box.replaceChildren(h('div', { class: 'cvempty' }, c.error)); return; }
          if (c.binary) { box.replaceChildren(h('div', { class: 'cvempty' }, 'binary file — use download')); return; }
          const lines = hlLines(c.text, langOf(name));
          box.replaceChildren(...[h('pre', { class: 'fcode hljs' }, lines.map((l, i) => h('div', { class: 'ln' }, h('span', { class: 'n' }, i + 1), h('span', { class: 't', html: l || ' ' }))), c.truncated ? h('div', { class: 'dim' }, '… truncated — download for the whole file') : null)].filter(Boolean));
          return;
        }
        const d = mode === 'head' ? await api(`git/${enc(root)}/headdiff?file=${enc(rel)}&untracked=0`) : await api(`git/${enc(root)}/diff?file=${enc(rel)}&kind=${mode}`);
        if (tok !== viewTok) return;
        if (d.error) { box.replaceChildren(h('div', { class: 'cvempty' }, d.error)); return; }
        if (!d.text || !d.text.trim()) { box.replaceChildren(h('div', { class: 'cvempty' }, mode === 'head' ? 'No difference to HEAD — committed already, or not tracked.' : 'No changes here.'), h('button', { class: 'btn sm cvmore', onclick: () => { C.file = { ...C.file, mode: 'file' }; paint(); } }, 'Show the file')); return; }
        box.replaceChildren(h('div', { class: 'chdiff cvdiff hljs', html: renderDiffHl(d.text, langOf(name)) }));
      } catch (e) { if (tok === viewTok) box.replaceChildren(h('div', { class: 'cvempty' }, e.message)); }
    }

    function hostEl() { return panel ? WS.host : document.getElementById('code'); }

    function ensure() {
      const host = hostEl(); if (!host) return false;
      if (el && host.contains(el)) return true;
      paneM = h('section', { class: 'cvm' }); paneR = h('section', { class: 'cvr-v' });
      if (panel) { paneL = null; el = h('div', { class: 'cv cvp' }, paneM, paneR); }
      else { paneL = h('section', { class: 'cvl' }); el = h('div', { class: 'cv' }, paneL, paneM, paneR); }
      listL = null; keyL = keyM = keyR = '';
      host.replaceChildren(...(panel ? [h('div', { class: 'cvp-grip', title: 'drag to resize', onpointerdown: grip }), el] : [el]));
      return true;
    }

    function active() { return panel ? panelOn() : UI.view === 'code'; }

    function paint(force) {
      if (!active() || !ensure()) return;
      if (panel) {
        const ws = wsOf(TERM.active);
        if (C.sess !== TERM.active) { C.sess = TERM.active; C.file = null; C.commit = null; C.step = 'list'; C.showAll.clear(); keyM = keyR = ''; }
        C.ws = ws && ws.session === TERM.active ? ws : null;
        C.scope = C.ws ? { kind: 'session', id: C.ws.session, title: sessTitle() } : null;
      }
      if (!panel && C.ws) { if (C.scope?.kind === 'session') C.ws = wsOf(C.ws.session) || C.ws; else if (!sessOf(C.ws.session)) C.ws = null; }
      if (C.scope && !scopeValid(C.scope)) C.scope = null;
      if (!C.scope && !panel) C.scope = OVW;
      if (C.scope && !scopeRoots().includes(C.focus)) C.focus = scopeRoots()[0] || null;
      el.dataset.step = stacked() ? C.step : '';
      el.classList.toggle('tree', C.tab === 'tree' && !panel && C.scope?.kind !== 'overview');
      el.classList.toggle('ovw', C.scope?.kind === 'overview');
      buildLeft(); paintMiddle(force); paintRight();
    }

    function dropLayer(fromButton) { if (!layered()) return; C.layers = Math.max(0, C.layers - 1); if (fromButton) popLayer(); }

    function leave() {
      if (panel || !C.layers) { if (!panel && C.step !== 'scope') C.step = 'scope'; return; }
      const n = C.layers; C.layers = 0; C.step = 'scope'; C.from = null; C.fromTerm = null; C.prev = null;
      // step back only over Code entries still on top: not when Back / Forward already left them (putting an entry's
      // place back), nor under a page or chat opened on top of them (those stay below; Back passes them)
      let k = 0; while (k < n && LAYERS.hist[LAYERS.depth - k]?.bd === 'code') k++;
      if (!LAYERS.restoring) goBack(k);
    }

    function back(fromButton) {
      if (!active()) return false;
      if (C.step === 'view') { C.step = 'list'; C.file = null; C.commit = null; }
      else if (panel) return false;
      else if (C.step === 'list' && C.prev) { C.scope = C.prev; C.prev = null; C.file = null; C.commit = null; C.focus = null; }
      else if (C.step === 'list' && (C.from || C.fromTerm)) {
        const v = C.from || 'home', t = C.fromTerm; C.from = null; C.fromTerm = null; C.step = 'scope';
        dropLayer(fromButton);
        setView(v);
        if (t) openTerm(t);
        return true;
      }
      else if (C.step === 'list') C.step = 'scope';
      else return false;
      dropLayer(fromButton);
      paint(true);
      return true;
    }

    async function open(o = {}) {
      const from = UI.view !== 'code' ? UI.view : null;
      const fromTerm = TERM.open ? TERM.active : null;
      C.prev = UI.view === 'code' && C.scope?.kind === 'overview' && !o.overview ? C.scope : null;
      if (o.overview) C.scope = OVW;
      else if (o.session) {
        try { C.ws = await api('workspace?session=' + enc(o.session)); WSC.set(o.session, { at: Date.now(), loading: false, data: C.ws }); } catch (e) { toast('workspace: ' + e.message, 'err'); }
        if (C.ws) C.scope = { kind: 'session', id: C.ws.session, title: sessTitle() };
      } else if (o.set) C.scope = { kind: 'set', id: o.set, title: setName(o.set), roots: o.roots };
      else if (o.roots && o.roots.length > 1) { const g = (wipOf().groups || []).find(x => o.roots.every(id => x.roots.includes(id))); C.scope = { kind: 'group', id: g ? g.branch : o.roots.join(','), title: g ? g.branch : plural(o.roots.length, 'repo'), roots: o.roots }; }
      else if (o.root || (o.roots && o.roots[0])) { const id = o.root || o.roots[0]; C.scope = { kind: 'root', id, title: rootInfo(id).name, roots: [id] }; }
      C.tab = 'changes'; C.file = null; C.commit = null;
      const rs = scopeRoots(); C.focus = rs.includes(o.root) ? o.root : rs[0] || null;
      saveScope();
      C.step = 'scope';
      if (o.file && C.focus) { const root = o.root || C.focus; C.file = { root, rel: o.file, kind: 'head', mode: 'head', f: null }; const f = (det.get(root)?.data?.files || []).find(x => x.rel === o.file); if (f) refine(root, o.file); else loadDetail(root).then(() => refine(root, o.file)); }
      // Code is a page: the chat you came from keeps its entry below (Back returns to it); a drawer's entry is taken over
      const reuse = UI.drawer && LAYERS.hist[LAYERS.depth]?.bd === 'drawer' ? 1 : 0;
      if (UI.drawer) closeDrawer(false);
      if (TERM.open) closeTermPanel(false);
      let need = phone() && C.prev ? C.layers : 0;
      if (phone()) {
        if (!C.prev) { C.from = from; C.fromTerm = fromTerm; }
        if (C.scope) { C.step = 'list'; need++; }
        if (C.file) { C.step = 'view'; need++; }
      }
      keyL = keyM = keyR = '';
      setView('code');   // before the entries: they carry the Code page
      if (phone()) {
        const have = C.layers + reuse;
        if (reuse && have <= need) retop('code');   // the drawer's entry becomes the top Code step
        for (let i = have; i < need; i++) pushLayer('code');
        if (have > need) goBack(have - need);
      }
      C.layers = phone() ? need : 0;
      navTo();   // no Code step entry (desktop, nothing picked): one entry for the page; takes over a closed drawer's
    }

    return { C, paint, back, open, openPath, refine, leave, reset: () => { keyL = keyM = keyR = ''; } };
  }

  const V = make('view');
  const P = make('panel');

  function repaint() { V.paint(); paintPanel(); }

  function panelOn() { return WS.on && TERM.open && !!TERM.active && !!sessOf(TERM.active)?.claude && !phone(); }

  function paintPanel() {
    const frames = document.getElementById('term-frames');
    const on = panelOn();
    if (frames) {
      if (!WS.host || !frames.contains(WS.host)) { WS.host = h('aside', { class: 'cvpanel', id: 'term-ws' }); frames.append(WS.host); }
      frames.classList.toggle('ws-on', on);
      frames.style.setProperty('--ws-w', WS.w + 'px');
    }
    if (on) P.paint();
  }

  function toggleWs(v) {
    WS.on = v == null ? !WS.on : v;
    localStorage.setItem('bd.code.ws', WS.on ? '1' : '0');
    if (WS.on) feat('rightOpen', 'files');
    P.reset();
    paintPanel();
    if (TERM.open) renderTermPanel(true);
  }

  function grip(ev) {
    ev.preventDefault();
    const frames = document.getElementById('term-frames'); if (!frames) return;
    const right = frames.getBoundingClientRect().right;
    frames.classList.add('ws-drag');
    const mv = e => { WS.w = Math.max(320, Math.min(right - 380 - frames.getBoundingClientRect().left, Math.round(right - e.clientX))); frames.style.setProperty('--ws-w', WS.w + 'px'); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); frames.classList.remove('ws-drag'); localStorage.setItem('bd.code.wsw', String(WS.w)); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }

  async function addWip(name) {
    if (!name) return;
    const ws = wsOf(name);
    if (!ws) { toast('Still reading this session — try again in a second'); return; }
    const inSets = new Set(ws.sets.flatMap(setRoots));
    const qs = [...ws.sets.map(s => 'set=' + enc(s)), ...ws.roots.filter(r => !inSets.has(r)).map(r => 'root=' + enc(r))];
    if (!qs.length) { toast('This session has not touched a repo yet'); return; }
    try {
      const texts = await Promise.all(qs.map(q => api('wip-brief?' + q).then(r => r.text).catch(() => '')));
      const text = texts.filter(Boolean).join('\n\n');
      if (!text.trim()) { toast('Nothing pending in these repos'); return; }
      FEAT.wip.insertDraft(name, text);
      toast('Work in progress added to the draft — review and send');
    } catch (e) { toast('brief failed: ' + e.message, 'err'); }
  }

  function badge(name) {
    if (!sessOf(name)?.claude) return null;
    const ws = wsOf(name); if (!ws) return null;
    const rs = wsRoots(ws); if (!rs.length) return null;
    const files = rs.reduce((a, id) => a + pending(wipRoot(id)), 0);
    return { repos: rs.length, files };
  }

  function termBar(name) {
    const cl = sessOf(name)?.claude; if (!cl) return null;
    queueMicrotask(paintPanel);
    const b = badge(name);
    const pressed = WS.on && !phone();
    return h('button', { class: 'btn sm ghost cvfiles' + (pressed ? ' on' : ''), 'aria-pressed': pressed ? 'true' : 'false', title: 'every repo of this session with its pending changes — side panel', onclick: () => phone() ? V.open({ session: name }) : toggleWs() },
      ico('folder', 14), h('span', { class: 'desk' }, 'Files'), b ? h('span', { class: 'pill' + (b.files ? ' warn' : '') }, b.files ? `${plural(b.repos, 'repo')} · ${b.files}` : plural(b.repos, 'repo')) : null);
  }

  function termBarKey(name) { const b = badge(name); return [WS.on, b && b.repos, b && b.files]; }

  function toolOpen(t, ctx) {
    if (!t || !t.file || !['Edit', 'MultiEdit', 'Write'].includes(t.name)) return null;
    return h('button', { class: 'tr-open', title: 'open ' + t.file + ' in the viewer', onclick: ev => { ev.stopPropagation(); openAbs(t.file, ctx && ctx.session); } }, 'open');
  }

  function openAbs(abs, session) {
    const hit = rootForPath(abs);
    if (!hit) { toast('Not inside a known git repo: ' + abs, 'err'); return; }
    if (phone() || !TERM.open) { V.open({ root: hit.root, file: hit.rel }); return; }
    if (!sessOf(TERM.active)?.claude) { V.open({ root: hit.root, file: hit.rel }); return; }
    if (!WS.on) toggleWs(true);
    P.C.sess = TERM.active;
    P.openPath(hit.root, hit.rel);
    if (!P.C.file?.f) loadDetail(hit.root).then(() => P.refine(hit.root, hit.rel));
  }

  function onState() { if (UI.view !== 'code' && (V.C.layers || V.C.step !== 'scope')) V.leave(); repaint(); }

  function deepLink(q) {
    if (q.get('view') !== 'code') return false;
    history.replaceState(null, '', location.pathname);
    const o = { set: q.get('set') || null, root: q.get('root') || null, file: q.get('file') || null, session: q.get('session') || null };
    V.open({ ...o, overview: !o.set && !o.root && !o.session });
    return true;
  }

  const rightOpen = which => { if (which !== 'files' && WS.on) toggleWs(false); };
  const filesOn = () => WS.on && !phone();

  return { open: V.open, back: V.back, onState, rightOpen, filesOn, deepLink, termBar, termBarKey, toolOpen, openAbs, togglePanel: toggleWs, state: V.C, panel: P.C };
})();
