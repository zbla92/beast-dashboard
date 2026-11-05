'use strict';
FEAT.code = (() => {
  const enc = encodeURIComponent;
  const det = new Map();
  const WSC = new Map();
  const chains = new Map();
  const POP = { close: null, anchor: null };
  const WS = { on: localStorage.getItem('bd.code.ws') === '1', w: +localStorage.getItem('bd.code.wsw') || 460, host: null };
  const readPrefs = () => { try { return JSON.parse(localStorage.getItem('bd.code.prefs')) || {}; } catch { return {}; } };
  const PREF = { split: false, wrap: false, ws: false, scope: 'all', tab: 'changes', w: 340, ...readPrefs() };
  const savePrefs = () => localStorage.setItem('bd.code.prefs', JSON.stringify(PREF));

  const LARGE_LINES = 3000;
  const MAX_FETCHES = 4;
  const PIN_MS = 2500;
  const SPLIT_MIN = 700;
  const SCOPES = { all: 'Uncommitted', staged: 'Staged', unstaged: 'Unstaged' };
  const TABS = [['changes', 'Changes', 'diff'], ['files', 'Files', 'folder'], ['history', 'History', 'clock'], ['worktrees', 'Worktrees', 'fork'], ['preview', 'Preview', 'screen']];
  const LOCAL_ICONS = {
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    diff: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 10.5v5M9.5 13h5M9.5 18h5"/>',
    fork: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v1.5A3.5 3.5 0 0 0 9.5 12h5A3.5 3.5 0 0 0 18 8.5V7M12 12v5"/>',
    screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8.5 21h7M12 17v4"/>',
    unified: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8 9.5h8M8 14.5h8"/>',
    split: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M12 4v16"/>',
    wrap: '<path d="M4 6h16M4 18h5M4 12h13a3 3 0 0 1 0 6h-4"/><path d="m15 15.5-2.5 2.5 2.5 2.5"/>',
    space: '<path d="M4 10v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    expandAll: '<path d="m7.5 9.5 4.5-5 4.5 5M7.5 14.5l4.5 5 4.5-5"/>',
    collapseAll: '<path d="m7.5 4.5 4.5 5 4.5-5M7.5 19.5l4.5-5 4.5 5"/>',
    commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
    stash: '<path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M6 4h12l2 4H4zM10 12h4"/>',
    prev: '<path d="m6 15 6-6 6 6"/>',
    next: '<path d="m6 9 6 6 6-6"/>',
    chat: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"/>',
  };
  const ic = (name, size = 16) => { const e = ico(name, size); if (LOCAL_ICONS[name]) e.innerHTML = LOCAL_ICONS[name]; return e; };

  const phone = () => matchMedia('(max-width: 900px)').matches;
  const touch = () => matchMedia('(hover: none)').matches;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const wipOf = () => S.wip || { roots: [], groups: [] };
  const wipRoot = id => wipOf().roots.find(r => r.id === id) || null;
  const pending = r => r ? r.staged + r.unstaged + r.untracked + r.conflicts : 0;
  const work = r => r ? pending(r) + (r.ahead || 0) : 0;
  const sessOf = name => S.runtime.sessions.find(s => s.name === name) || null;
  const isFolder = rel => rel.endsWith('/');
  const pathArg = rel => rel.replace(/\/$/, '');
  const baseOf = rel => pathArg(rel).split('/').pop() + (isFolder(rel) ? '/' : '');
  const dirOf = rel => pathArg(rel).split('/').slice(0, -1).join('/');
  const setText = (e, s) => { if (e.textContent !== s) e.textContent = s; };
  const show = (e, on) => { if (e.hidden === on) e.hidden = !on; };
  const fill = (e, ...kids) => e.replaceChildren(...kids.filter(Boolean));
  const onActivate = fn => ev => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); fn(); } };
  const skelBars = (n, base, spread) => Array.from({ length: n }, (_, i) => h('i', { style: `width:${base + (i * 37) % spread}%` }));

  const isConflict = f => f.status === 'U';
  const isUntracked = f => f.x === '?';
  const isStaged = f => !isConflict(f) && f.x !== '.' && f.x !== '?';
  const isUnstaged = f => !isConflict(f) && f.y !== '.' && f.y !== '?';
  const isChange = f => isUnstaged(f) || isUntracked(f);

  function rootInfo(id) {
    const w = wipRoot(id); if (w) return w;
    const d = det.get(id)?.data?.root; if (d) return d;
    const p = byId()[id];
    if (!p) return { id, project: id.split('~')[0], name: id, branch: null, worktree: id.includes('~'), staged: 0, unstaged: 0, untracked: 0, conflicts: 0, add: 0, del: 0, ahead: 0, behind: 0, live: [], flags: [] };
    const g = gitOf(p) || {};
    return { id, project: id, name: p.name, path: p.path, org: p.org, set: p.set || id, branch: g.branch || null, worktree: false, upstream: g.upstream, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, add: 0, del: 0, ahead: g.ahead || 0, behind: g.behind || 0, live: [], flags: [] };
  }

  const nameOrder = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const wipList = () => wipOf().roots.filter(r => work(r) > 0).sort(nameOrder);
  const firstWork = ids => ids.find(id => work(wipRoot(id)) > 0) || ids[0] || null;

  function setRoots(set) {
    const mains = S.projects.filter(p => p.set === set && p.isGit && !p.hidden).map(p => p.id);
    return [...new Set([...mains, ...wipOf().roots.filter(r => r.set === set).map(r => r.id)])];
  }

  const wsRoots = ws => ws ? [...new Set([...ws.sets.flatMap(setRoots), ...ws.roots])] : [];

  function sessionRoots(ws) {
    if (!ws) return [];
    const edits = id => ws.edited?.[id]?.length || 0;
    return wsRoots(ws).map((id, i) => ({ id, i })).sort((a, b) => edits(b.id) - edits(a.id) || work(wipRoot(b.id)) - work(wipRoot(a.id)) || a.i - b.i).map(x => x.id);
  }

  function sigOf(id) {
    const r = wipRoot(id);
    if (r) return [r.staged, r.unstaged, r.untracked, r.conflicts, r.add, r.del, r.ahead, r.behind, r.stashes, r.newest, r.branch, r.op].join();
    const p = byId()[id]; const g = p ? gitOf(p) : null;
    return g ? ['clean', g.branch, g.ahead, g.behind].join() : 'clean';
  }

  function loadDetail(id, force) {
    const c = det.get(id); const sig = sigOf(id);
    if (!force && c && (c.sig === sig || c.loading)) return c.wait;
    const e = { sig, loading: true, data: c?.data || null, wait: null };
    det.set(id, e);
    e.wait = api('wip/' + enc(id))
      .then(d => { e.data = d; }, err => { e.data = e.data && !e.data.error ? e.data : { error: err.message }; })
      .then(() => { e.loading = false; repaint(); return e; });
    return e.wait;
  }

  function wsOf(name) {
    if (!name || !sessOf(name)?.claude) return null;
    const c = WSC.get(name); const state = sessOf(name).claude.state;
    const sig = wipOf().roots.map(r => r.id + ':' + pending(r) + ':' + (r.newest || 0)).join('|') + '#' + state;
    const stale = c && !c.loading && c.sig !== sig && Date.now() - c.at > 3000;
    if (c && !stale) return c.data;
    const e = { at: Date.now(), loading: true, sig, data: c?.data || null };
    WSC.set(name, e);
    api('workspace?session=' + enc(name)).then(d => { e.data = d; }).catch(() => {}).finally(() => { e.loading = false; e.at = Date.now(); repaint(); });
    return e.data;
  }

  function rootForPath(abs) {
    const edited = [...WSC.values()].flatMap(c => Object.entries(c.data?.edited || {}).flatMap(([root, arr]) => arr.map(x => ({ root, rel: x.rel, base: rootInfo(root).path }))));
    const hit = edited.find(x => x.base && x.base.replace(/\/$/, '') + '/' + x.rel === abs);
    if (hit) return { root: hit.root, rel: hit.rel };
    const cands = [...wipOf().roots, ...S.projects.filter(p => p.isGit)].filter(c => c.path).map(c => ({ id: c.id, base: c.path.replace(/\/$/, '') + '/' }));
    const best = cands.filter(c => abs.startsWith(c.base)).sort((a, b) => b.base.length - a.base.length)[0];
    return best ? { root: best.id, rel: abs.slice(best.base.length) } : null;
  }

  async function gitOp(id, body) {
    const r = await api(`git/${enc(id)}/op`, body);
    if (!r.ok) throw new Error(r.error || 'Git refused this');
    return r;
  }

  function serial(id, fn) {
    const next = (chains.get(id) || Promise.resolve()).then(fn, fn);
    chains.set(id, next.catch(() => {}));
    return next;
  }

  function closePop() { if (POP.close) POP.close(); }

  function openPop(anchor, cls, build) {
    if (POP.anchor === anchor) { closePop(); return; }
    closePop();
    const el = h('div', { class: 'cv-pop ' + cls });
    const onDown = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePop(); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); anchor.focus(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    POP.anchor = anchor;
    POP.close = () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      el.remove(); POP.close = null; POP.anchor = null;
      anchor.setAttribute('aria-expanded', 'false');
    };
    anchor.setAttribute('aria-expanded', 'true');
    document.body.append(el);
    const a = anchor.getBoundingClientRect();
    const pad = 10;
    const w = Math.min(Math.max(a.width, 320), innerWidth - pad * 2);
    el.style.width = w + 'px';
    el.style.left = Math.max(pad, Math.min(a.left, innerWidth - w - pad)) + 'px';
    el.style.top = a.bottom + 6 + 'px';
    el.style.maxHeight = Math.max(240, innerHeight - a.bottom - 6 - pad) + 'px';
    build(el);
  }

  function comboBox(el, placeholder, rows) {
    const list = h('div', { class: 'cv-optlist', role: 'listbox' });
    const cur = { i: 0 };
    const opts = () => [...list.querySelectorAll('.cv-opt:not(:disabled)')];
    const mark = () => opts().forEach((o, n) => { o.classList.toggle('on', n === cur.i); if (n === cur.i) o.scrollIntoView({ block: 'nearest' }); });
    const input = h('input', {
      class: 'cv-search', placeholder, 'aria-label': placeholder, autocomplete: 'off', spellcheck: 'false',
      oninput: () => refill(),
      onkeydown: e => {
        e.stopPropagation();
        const n = opts().length;
        if (e.key === 'ArrowDown' && n) { e.preventDefault(); cur.i = (cur.i + 1) % n; mark(); }
        else if (e.key === 'ArrowUp' && n) { e.preventDefault(); cur.i = (cur.i + n - 1) % n; mark(); }
        else if (e.key === 'Enter') { e.preventDefault(); opts()[cur.i]?.click(); }
      },
    });
    const refill = () => { list.replaceChildren(...rows(input.value.trim())); cur.i = 0; mark(); };
    el.append(h('div', { class: 'cv-searchrow' }, ic('search', 15), input), list);
    refill();
    if (!touch()) input.focus();
    return refill;
  }

  const optHead = (text, n) => h('div', { class: 'cv-opthead' }, h('span', null, text), n ? h('span', { class: 'cv-optcount' }, n) : null);

  function syncKids(box, items) {
    const have = new Map([...box.children].map(n => [n.cvKey, n]));
    const next = items.map(it => {
      const old = have.get(it.key);
      if (old && old.cvSig === it.sig) return old;
      const n = it.build(); n.cvKey = it.key; n.cvSig = it.sig; return n;
    });
    const keep = new Set(next);
    for (const n of [...box.children]) if (!keep.has(n)) n.remove();
    next.forEach((n, i) => { if (box.children[i] !== n) box.insertBefore(n, box.children[i] || null); });
  }

  function parseDiff(text) {
    const out = { hunks: [], add: 0, del: 0, truncated: false, meta: [], lines: 0, top: 0, lit: false };
    const st = { hunk: null, o: 0, n: 0 };
    for (const l of String(text || '').split('\n')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m) { st.hunk = { head: l, rows: [] }; out.hunks.push(st.hunk); st.o = +m[1]; st.n = +m[2]; continue; }
      if (l === '… (truncated)') { out.truncated = true; continue; }
      if (!st.hunk) { if (l) out.meta.push(l); continue; }
      if (l[0] === '+') { st.hunk.rows.push({ t: 'add', o: '', n: st.n, s: l.slice(1) }); st.n++; out.add++; }
      else if (l[0] === '-') { st.hunk.rows.push({ t: 'del', o: st.o, n: '', s: l.slice(1) }); st.o++; out.del++; }
      else if (l[0] === ' ') { st.hunk.rows.push({ t: 'ctx', o: st.o, n: st.n, s: l.slice(1) }); st.o++; st.n++; }
      out.top = Math.max(out.top, st.o, st.n);
    }
    out.lines = out.hunks.reduce((a, x) => a + x.rows.length, 0);
    return out;
  }

  function highlight(p, lang) {
    if (p.lit === lang) return;
    p.lit = lang;
    for (const hunk of p.hunks) {
      const olds = hunk.rows.filter(r => r.t !== 'add');
      const news = hunk.rows.filter(r => r.t !== 'del');
      const oh = hlLines(olds.map(r => r.s).join('\n'), lang);
      const nh = hlLines(news.map(r => r.s).join('\n'), lang);
      olds.forEach((r, i) => { r.html = oh[i] ?? esc(r.s); });
      news.forEach((r, i) => { if (r.t === 'add') r.html = nh[i] ?? esc(r.s); else r.htmlNew = nh[i] ?? esc(r.s); });
    }
  }

  const uniRow = r => `<div class="cvl ${r.t}"><span class="cvn" data-n="${r.o}"></span><span class="cvn" data-n="${r.n}"></span><span class="cvc">${r.htmlNew || r.html || ' '}</span></div>`;
  const sideRow = (r, side) => r ? `<div class="cvl ${r.t}"><span class="cvn" data-n="${side === 'o' ? r.o : r.n}"></span><span class="cvc">${(side === 'n' && r.htmlNew) || r.html || ' '}</span></div>` : '<div class="cvl blank"><span class="cvn"></span><span class="cvc"> </span></div>';
  const hunkRow = hunk => `<div class="cvl hunk"><span class="cvc">${esc(hunk.head)}</span></div>`;

  function pairRows(rows) {
    const out = []; const dels = []; const adds = [];
    const flush = () => {
      Array.from({ length: Math.max(dels.length, adds.length) }, (_, i) => out.push([dels[i] || null, adds[i] || null]));
      dels.length = 0; adds.length = 0;
    };
    for (const r of rows) {
      if (r.t === 'del') dels.push(r);
      else if (r.t === 'add') adds.push(r);
      else { flush(); out.push([r, r]); }
    }
    flush();
    return out;
  }

  function diffHtml(p, split, wrap) {
    const width = `--nw:${String(p.top).length + 1}ch`;
    if (!split) return `<div class="cvd-uni" style="${width}">${p.hunks.map(x => hunkRow(x) + x.rows.map(uniRow).join('')).join('')}</div>`;
    const sides = p.hunks.map(x => ({ head: x, cells: pairRows(x.rows) }));
    if (wrap) return `<div class="cvd-grid" style="${width}">${sides.map(x => `<div class="cvd-span">${hunkRow(x.head)}</div>` + x.cells.map(([a, b]) => sideRow(a, 'o') + sideRow(b, 'n')).join('')).join('')}</div>`;
    const col = (k, side) => `<div class="cvd-col"><div class="cvd-colin" style="${width}">${sides.map(x => hunkRow(x.head) + x.cells.map(c => sideRow(c[k], side)).join('')).join('')}</div></div>`;
    return `<div class="cvd-cols">${col(0, 'o')}${col(1, 'n')}</div>`;
  }

  function statEl(add, del) {
    const a = h('span', { class: 'cv-add' }); const d = h('span', { class: 'cv-del' });
    const el = h('span', { class: 'cv-stat' }, a, d);
    el.set = (x, y) => { setText(a, x ? '+' + x : ''); setText(d, y ? '−' + y : ''); show(el, !!(x || y)); el.setAttribute('aria-label', `${x} added, ${y} removed`); };
    el.set(add, del);
    return el;
  }

  const LETTER_CLASS = { M: 'm', T: 'm', A: 'a', D: 'd', R: 'r', C: 'r', U: 'u', '!': 'x' };
  const LETTER_TITLE = { M: 'Modified', T: 'Type changed', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Untracked', '!': 'Conflict' };
  const letterEl = l => h('span', { class: 'cv-let ' + (LETTER_CLASS[l] || 'm'), title: LETTER_TITLE[l] || l }, l === '!' ? 'C' : l);

  function makeStack(opts) {
    const blocks = new Map();
    const st = { ctx: null, collapsed: false, pin: null, pinTimer: null };
    const list = h('div', { class: 'cvd-list' });
    const scroller = opts.scroller;

    function pump() {
      const loading = [...blocks.values()].filter(b => b.state === 'loading').length;
      const idle = [...blocks.values()].filter(b => b.vis && b.open && b.state === 'idle');
      idle.slice(0, Math.max(0, MAX_FETCHES - loading)).forEach(load);
    }

    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const b = e.target.cvBlock; if (!b) continue;
        b.vis = e.isIntersecting;
        if (!b.vis && b.state === 'loading') { b.ctl?.abort(); b.state = 'idle'; }
      }
      pump();
    }, { root: scroller, rootMargin: '500px 0px' });

    function note(b, text, action) {
      b.body.replaceChildren(h('div', { class: 'cvd-note' }, h('span', null, text), action || null));
    }

    const loadAnyway = b => h('button', { class: 'btn sm', onclick: () => { b.force = true; if (b.parsed) paintBlock(b); else { b.state = 'idle'; pump(); } } }, 'Load anyway');

    function emptyReason(p) {
      if (p.meta.some(l => l.startsWith('rename'))) return 'Renamed with no content changes.';
      if (p.meta.some(l => l.startsWith('old mode'))) return 'File mode changed, no content changes.';
      if (p.meta.some(l => l.startsWith('Binary'))) return 'Binary file, no text diff to show.';
      return 'No text changes to show.';
    }

    function paintBlock(b) {
      const p = b.parsed;
      if (!p) return;
      if (!p.hunks.length) { note(b, emptyReason(p)); return; }
      if (p.lines > LARGE_LINES && !b.force) { note(b, `Large diff: ${p.lines.toLocaleString()} lines.`, loadAnyway(b)); return; }
      highlight(p, langOf(baseOf(b.item.rel)));
      const split = opts.split();
      fill(b.body, h('div', { class: 'cvd-lines', html: diffHtml(p, split, PREF.wrap) }), p.truncated ? h('div', { class: 'cvd-note' }, h('span', null, 'This diff was cut off because it is too long.')) : null);
      b.painted = split + '|' + PREF.wrap;
    }

    function skeleton(item) {
      const rows = Math.max(3, Math.min(14, (item.add || 0) + (item.del || 0) + 3));
      return h('div', { class: 'cv-skel', style: `height:${rows * 20 + 20}px` }, skelBars(Math.min(rows, 7), 30, 55));
    }

    function load(b) {
      const size = (b.item.add || 0) + (b.item.del || 0);
      if (!b.force && size > LARGE_LINES) { b.state = 'large'; note(b, `Large diff: ${size.toLocaleString()} changed lines.`, loadAnyway(b)); return; }
      if (b.item.binary) { b.state = 'ready'; note(b, 'Binary file, no text diff to show.'); return; }
      if (isFolder(b.item.rel)) { b.state = 'ready'; note(b, 'New folder. Stage it to see the files inside.'); return; }
      b.state = 'loading';
      b.ctl = new AbortController();
      const ctl = b.ctl;
      if (!b.parsed) b.body.replaceChildren(skeleton(b.item));
      fetch('/api/' + b.item.url, { signal: ctl.signal })
        .then(r => r.json().then(d => r.ok ? d : { error: d.error || r.statusText }))
        .then(d => {
          if (b.ctl !== ctl || !blocks.has(b.key)) return;
          b.state = 'ready';
          if (d.error) { b.parsed = null; b.text = null; note(b, d.error); return; }
          if (d.text === b.text) return;
          b.text = d.text; b.parsed = parseDiff(d.text);
          paintBlock(b);
          b.stat.set(b.parsed.add, b.parsed.del);
          opts.onStat();
        })
        .catch(e => { if (e.name !== 'AbortError' && b.ctl === ctl) { b.state = 'ready'; note(b, e.message); } })
        .finally(() => { if (b.ctl === ctl) pump(); });
    }

    function setOpen(b, open) {
      b.open = open;
      b.el.classList.toggle('closed', !open);
      b.caret.setAttribute('aria-expanded', String(open));
      b.caret.setAttribute('aria-label', (open ? 'Collapse ' : 'Expand ') + b.item.rel);
    }

    function makeBlock(item) {
      const rel = item.rel; const dir = dirOf(rel);
      const b = { key: item.key, item, sig: item.sig, vis: false, open: !st.collapsed, state: 'idle', text: null, parsed: null, force: false, ctl: null, painted: '' };
      const flip = ev => { ev.stopPropagation(); setOpen(b, !b.open); pump(); };
      b.caret = h('button', { class: 'cv-ib cvd-caret', onclick: flip }, ic('chevronDown', 15));
      b.stat = statEl(item.add || 0, item.del || 0);
      b.body = h('div', { class: 'cvd-body' }, skeleton(item));
      b.el = h('section', { class: 'cvd-file', 'data-rel': rel },
        h('header', { class: 'cvd-head', onclick: flip },
          b.caret,
          letterEl(item.letter),
          h('span', { class: 'cvd-path', title: rel }, dir ? h('span', { class: 'cvd-dir' }, dir + '/') : null, h('b', null, baseOf(rel))),
          b.stat,
          item.letter !== 'D' && !isFolder(rel) ? h('button', { class: 'cv-ib', title: 'Open file', 'aria-label': 'Open file ' + rel, onclick: ev => { ev.stopPropagation(); opts.onOpen(item); } }, ic('file', 15)) : null),
        b.body);
      b.el.cvBlock = b;
      setOpen(b, b.open);
      io.observe(b.el);
      return b;
    }

    function drop(b) { b.ctl?.abort(); b.ctl = null; io.unobserve(b.el); b.el.remove(); blocks.delete(b.key); if (st.pin === b) unpin(); }

    function unpin() { st.pin = null; }
    new ResizeObserver(() => st.pin?.el.scrollIntoView({ block: 'start' })).observe(list);
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) scroller.addEventListener(type, unpin, { passive: true });

    function set(items, ctx) {
      if (ctx !== st.ctx) { [...blocks.values()].forEach(drop); st.ctx = ctx; st.collapsed = false; scroller.scrollTop = 0; }
      const seen = new Set(items.map(x => x.key));
      for (const b of [...blocks.values()]) if (!seen.has(b.key)) drop(b);
      items.forEach((item, i) => {
        const old = blocks.get(item.key);
        const b = old || makeBlock(item);
        if (!old) blocks.set(item.key, b);
        if (old && old.sig !== item.sig) {
          old.item = item; old.sig = item.sig;
          if (old.state === 'loading') old.ctl?.abort();
          if (!old.parsed) old.stat.set(item.add || 0, item.del || 0);
          old.state = 'idle';
        }
        if (list.children[i] !== b.el) list.insertBefore(b.el, list.children[i] || null);
      });
      pump();
    }

    return {
      list, set,
      repaintAll() {
        const key = opts.split() + '|' + PREF.wrap;
        for (const b of blocks.values()) if (b.parsed && b.painted !== key) paintBlock(b);
      },
      reload() { for (const b of blocks.values()) { if (b.state === 'loading') b.ctl?.abort(); b.state = 'idle'; } pump(); },
      scrollTo(key) {
        const b = blocks.get(key); if (!b) return;
        setOpen(b, true);
        b.el.scrollIntoView({ block: 'start' });
        st.pin = b;
        clearTimeout(st.pinTimer);
        st.pinTimer = setTimeout(unpin, PIN_MS);
        pump();
      },
      mark(key) { for (const b of blocks.values()) b.el.classList.toggle('cur', b.key === key); },
      setAll(open) { st.collapsed = !open; for (const b of blocks.values()) setOpen(b, open); pump(); },
      allClosed: () => blocks.size > 0 && [...blocks.values()].every(b => !b.open),
      total: () => [...blocks.values()].reduce((t, b) => ({ add: t.add + (b.parsed ? b.parsed.add : b.item.add || 0), del: t.del + (b.parsed ? b.parsed.del : b.item.del || 0) }), { add: 0, del: 0 }),
    };
  }

  function addToChat(anchor, root, label, session) {
    const insert = async name => {
      try {
        const { text } = await api('wip-brief?root=' + enc(root));
        FEAT.wip.insertDraft(name, text);
        if (!session) openTerm(name);
        toast(label + ' added to the draft. Review and send it.', 'ok');
      } catch (e) { toast('Could not add it: ' + e.message, 'err'); }
    };
    if (session) { insert(session); return; }
    const live = S.runtime.sessions.filter(s => s.claude && s.claude.state !== 'ended');
    if (!live.length) { toast('No live Claude session to add it to', 'err'); return; }
    openMenu({ currentTarget: anchor }, [{ header: 'Add work in progress to' }, ...live.map(s => ({ label: s.claude.label || chatTitle(s.claude) || s.name, sub: s.name, onclick: () => insert(s.name) }))]);
  }

  function smartAction(r, n, msg) {
    const off = label => ({ label, off: true });
    if (n.conflicts) return off(`Resolve ${plural(n.conflicts, 'conflict')} first`);
    if (r.op) return off(`A ${r.op} is in progress. Finish it in a terminal.`);
    if (r.detached) return off('Detached HEAD. Switch to a branch first.');
    if (n.staged) return msg ? { label: 'Commit', run: 'commit', icon: 'check' } : off('Write a commit message');
    if (n.changes) return msg ? { label: `Commit all (${n.changes})`, run: 'commitAll', icon: 'check' } : off('Write a commit message');
    if (!r.upstream) return { label: 'Publish branch', run: 'push', icon: 'arrowUp' };
    if (r.ahead && r.behind) return off('Branch has diverged. Pull or rebase in a terminal.');
    if (r.ahead) return { label: `Push ${r.ahead}`, run: 'push', icon: 'arrowUp' };
    if (r.behind) return { label: `Pull ${r.behind}`, run: 'pull', icon: 'arrowDown' };
    return off('Everything is committed and pushed');
  }

  function pushBlock(r) {
    if (r.op) return `A ${r.op} is in progress`;
    if (r.detached) return 'Detached HEAD';
    if (!r.upstream) return null;
    if (r.ahead && r.behind) return 'Branch has diverged';
    if (r.behind) return 'Pull first';
    if (!r.ahead) return 'Nothing to push';
    return null;
  }

  function pullBlock(r) {
    if (r.op) return `A ${r.op} is in progress`;
    if (r.detached) return 'Detached HEAD';
    if (!r.upstream) return 'This branch has no upstream';
    if (r.ahead && r.behind) return 'Branch has diverged';
    if (!r.behind) return 'Already up to date';
    return null;
  }

  function make(kind) {
    const panel = kind === 'panel';
    const C = { root: null, tab: panel ? 'changes' : PREF.tab, step: 'list', layers: 0, sess: null, ws: null, fromTerm: null, sel: null, one: null, want: null, commit: null, commitData: null, port: null, pin: null };
    const TREE = { open: new Set(JSON.parse(localStorage.getItem('bd.code.fopen') || '[]')), sel: null, mode: 'auto', editing: false, wide: false };
    const HIST = { root: null, sig: null, commits: [], more: false, loading: false, tok: 0, err: null };
    const D = {};
    const stamp = { tree: null, frame: null, commitTok: 0, avatar: '', arrows: '', empty: '', meta: '', wide: null, sized: false };
    const rowBusy = new Set();
    const busyBy = new Map();
    const errBy = new Map();

    const stacked = () => panel || phone();
    const layered = () => !panel && phone();
    const active = () => panel ? panelOn() : UI.view === 'code';
    const hostEl = () => panel ? WS.host : document.getElementById('code');
    const detail = () => C.root ? det.get(C.root)?.data || null : null;
    const info = () => detail()?.root || (C.root ? rootInfo(C.root) : null);
    const files = () => detail()?.files || [];
    const message = () => D.msg.value.trim();
    const draftKey = id => 'bd.code.msg.' + id;

    function counts() {
      const fs = files();
      return { conflicts: fs.filter(isConflict).length, staged: fs.filter(isStaged).length, changes: fs.filter(isChange).length };
    }

    const orderedFiles = () => {
      const fs = files();
      return [...new Map([...fs.filter(isConflict), ...fs.filter(isStaged), ...fs.filter(isChange)].map(f => [f.rel, f])).values()];
    };

    function diffUrl(f) {
      const ws = PREF.ws ? '&ws=1' : '';
      const q = `git/${enc(C.root)}/`;
      if (PREF.scope === 'staged' && isStaged(f)) return `${q}diff?file=${enc(f.rel)}&kind=staged${ws}`;
      if (PREF.scope === 'unstaged' && isChange(f)) return `${q}diff?file=${enc(f.rel)}&kind=${isUntracked(f) ? 'untracked' : 'unstaged'}${ws}`;
      return `${q}headdiff?file=${enc(f.rel)}&untracked=${isUntracked(f) ? 1 : 0}${ws}`;
    }

    function letterOf(f, sec) {
      if (isConflict(f)) return '!';
      if (isUntracked(f)) return 'U';
      if (sec === 'staged') return f.x;
      if (sec === 'changes') return f.y;
      return f.y !== '.' ? f.y : f.x;
    }

    function diffItem(f) {
      const url = diffUrl(f);
      return { key: f.rel, rel: f.rel, letter: letterOf(f), add: f.add || 0, del: f.del || 0, binary: !!f.binary, url, sig: [url, f.x, f.y, f.add, f.del, f.mtime].join('|') };
    }

    function scopeFiles() {
      if (PREF.scope === 'staged') return orderedFiles().filter(isStaged);
      if (PREF.scope === 'unstaged') return orderedFiles().filter(isChange);
      return orderedFiles();
    }

    const secOf = f => isConflict(f) ? 'conflicts' : isStaged(f) ? 'staged' : 'changes';

    async function run(label, fn) {
      const id = C.root;
      if (busyBy.has(id)) return false;
      errBy.delete(id); busyBy.set(id, label); paintCta();
      const ok = await serial(id, fn).then(() => true, e => { errBy.set(id, e.message); return false; });
      busyBy.delete(id);
      await loadDetail(id, true);
      paint();
      return ok;
    }

    function clearDraft(id) {
      localStorage.removeItem(draftKey(id));
      if (C.root === id) { D.msg.value = ''; sizeMsg(); }
    }

    function doCommit({ all, amend, push }) {
      const id = C.root; const text = D.msg.value;
      return run(amend ? 'Amending' : 'Committing', async () => {
        if (all) await gitOp(id, { op: 'stage', all: true });
        const r = await gitOp(id, { op: 'commit', message: text, ...(amend ? { amend: true } : {}) });
        clearDraft(id);
        toast(`${amend ? 'Amended' : 'Committed'} ${r.hash}`, 'ok');
        if (!push) return;
        busyBy.set(id, 'Pushing'); paintCta();
        await gitOp(id, { op: 'push' });
        toast('Pushed', 'ok');
      });
    }

    const simpleOp = (label, body, done) => () => { const id = C.root; return run(label, async () => { await gitOp(id, body); if (done) toast(done, 'ok'); }); };
    const doPush = simpleOp('Pushing', { op: 'push' }, 'Pushed');
    const doPull = simpleOp('Pulling', { op: 'pull' }, 'Pulled');
    const doStageAll = simpleOp('Staging', { op: 'stage', all: true });
    const doUnstageAll = simpleOp('Unstaging', { op: 'unstage', all: true });

    function runSmart() {
      if (busyBy.has(C.root) || !detail() || detail().error) return;
      const a = smartAction(info(), counts(), message());
      if (a.off) return;
      if (a.run === 'commit') doCommit({});
      else if (a.run === 'commitAll') doCommit({ all: true });
      else if (a.run === 'push') doPush();
      else doPull();
    }

    function moreMenu(ev) {
      const r = info(); const n = counts(); const msg = message();
      const anything = n.staged || n.changes;
      const blocked = n.conflicts ? 'Resolve the conflicts first' : r.op ? `A ${r.op} is in progress` : null;
      const whyCommit = blocked || (!anything ? 'Nothing to commit' : !msg ? 'Write a commit message' : r.detached ? 'Detached HEAD' : null);
      const whyAmend = blocked || (r.detached ? 'Detached HEAD' : !msg ? 'Write a commit message' : r.upstream && !r.ahead ? 'The last commit is already pushed' : null);
      const item = (label, why, onclick) => why ? { label, sub: why, disabled: true } : { label, onclick };
      openMenu(ev, [
        item(n.staged || !anything ? 'Commit & push' : `Commit all & push (${n.changes})`, whyCommit, () => doCommit({ all: !n.staged, push: true })),
        item('Amend last commit', whyAmend, () => doCommit({ amend: true })),
        item('Stage all', n.changes ? null : 'No changes to stage', doStageAll),
        'sep',
        item(r.upstream ? 'Push' : 'Publish branch', pushBlock(r), doPush),
        item('Pull', pullBlock(r), doPull),
      ]);
    }

    function rowOp(id, f, sec, body) {
      const key = id + '|' + sec + ':' + f.rel;
      rowBusy.add(key); paintChanges();
      serial(id, () => gitOp(id, body))
        .then(() => { errBy.delete(id); }, e => { errBy.set(id, e.message); })
        .then(() => loadDetail(id, true))
        .then(() => { rowBusy.delete(key); paint(); });
    }

    async function discard(f) {
      const untracked = isUntracked(f);
      const id = C.root;
      const yes = await confirmBox({
        title: untracked ? `Delete ${baseOf(f.rel)}?` : `Discard changes in ${baseOf(f.rel)}?`,
        text: [
          h('p', { class: 'cv-confirm-file' }, [info()?.name, f.rel].filter(Boolean).join(' / ')),
          untracked ? `This ${isFolder(f.rel) ? 'folder' : 'file'} is untracked, so git has no copy of it. It will be deleted permanently.` : 'Your uncommitted edits to this file will be lost. Anything already staged stays staged.',
        ],
        ok: untracked ? 'Delete permanently' : 'Discard changes', danger: true,
      });
      if (yes) rowOp(id, f, 'changes', { op: 'discard', files: [pathArg(f.rel)], ...(untracked ? { untracked: true } : {}) });
    }

    function hotFile() {
      if (!C.ws) return null;
      const state = sessOf(C.ws.session)?.claude?.state;
      if (state !== 'working' && state !== 'background') return null;
      const all = Object.entries(C.ws.edited || {}).flatMap(([root, arr]) => arr.map(x => ({ root, rel: x.rel, seq: x.seq })));
      return all.reduce((a, x) => (!a || x.seq > a.seq ? x : a), null);
    }

    function editState(f, hot) {
      if (hot && hot.root === C.root && hot.rel === f.rel) return 'hot';
      if ((C.ws?.edited?.[C.root] || []).some(x => x.rel === f.rel)) return 'edited';
      if (!C.ws && (f.editors || []).some(e => e.live)) return 'edited';
      return '';
    }

    function fileRow(f, sec, edit) {
      const dir = dirOf(f.rel);
      const letter = letterOf(f, sec);
      const stat = (f.add || f.del) ? statEl(f.add || 0, f.del || 0) : f.binary ? h('span', { class: 'cv-stat' }, h('span', { class: 'cv-bin' }, 'binary')) : null;
      const pill = stat ? h('span', { class: 'cv-pill' }, stat) : null;
      const act = (label, name, onclick, cls) => h('button', { class: 'cv-ib' + (cls ? ' ' + cls : ''), title: label, 'aria-label': label + ' ' + f.rel, onclick: ev => { ev.stopPropagation(); onclick(); } }, ic(name, 16));
      const onTouch = touch();
      const activate = () => openRow(f, sec);
      return h('div', {
        class: 'cv-row', role: 'button', tabindex: '0', title: f.from ? `${f.from} renamed to ${f.rel}` : f.rel, 'data-key': sec + ':' + f.rel,
        onclick: activate, onkeydown: onActivate(activate),
      },
      letterEl(letter),
      h('span', { class: 'cv-txt' },
        h('span', { class: 'cv-name' }, h('span', { class: 'cv-nm' }, baseOf(f.rel)), edit ? h('span', { class: 'cv-dot ' + edit, title: edit === 'hot' ? 'Being edited right now' : 'Edited by this session' }) : null),
        h('span', { class: 'cv-sub' }, onTouch ? pill : null, dir ? h('span', { class: 'cv-dirn' }, dir) : null)),
      onTouch ? null : pill,
      h('span', { class: 'cv-acts' },
        sec === 'staged' ? act('Unstage', 'minus', () => rowOp(C.root, f, sec, { op: 'unstage', files: [pathArg(f.rel)] })) : null,
        sec === 'changes' ? act('Stage', 'plus', () => rowOp(C.root, f, sec, { op: 'stage', files: [pathArg(f.rel)] })) : null,
        sec === 'conflicts' ? act('Mark resolved', 'check', () => rowOp(C.root, f, sec, { op: 'stage', files: [pathArg(f.rel)] })) : null,
        sec === 'changes' ? act(isUntracked(f) ? 'Delete' : 'Discard', 'undo', () => discard(f), 'danger') : null,
        letter !== 'D' && !isFolder(f.rel) ? act('Open file', 'file', () => openFile(f.rel)) : null));
    }

    function buildCommitBox() {
      D.msg = h('textarea', {
        class: 'cv-msg', rows: '2', placeholder: 'Commit message', 'aria-label': 'Commit message',
        oninput: () => {
          if (D.msg.value) localStorage.setItem(draftKey(C.root), D.msg.value); else localStorage.removeItem(draftKey(C.root));
          sizeMsg(); paintCta();
        },
        onkeydown: ev => {
          ev.stopPropagation();
          if (ev.key === 'Escape') D.msg.blur();
          if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); runSmart(); }
        },
      });
      D.ctaIcon = h('span', { class: 'cv-cta-ic' });
      D.ctaText = h('span', { class: 'cv-cta-t' });
      D.cta = h('button', { class: 'cv-cta', onclick: runSmart }, D.ctaIcon, D.ctaText);
      D.ctaMore = h('button', { class: 'cv-cta-more', title: 'More git actions', 'aria-label': 'More git actions', 'aria-haspopup': 'menu', onclick: moreMenu }, ic('chevronDown', 16));
      D.onMain = h('div', { class: 'cv-mainnote', hidden: true });
      D.errText = h('div', { class: 'cv-errtext' });
      D.err = h('div', { class: 'cv-err', role: 'alert', hidden: true },
        h('span', { class: 'cv-erric' }, ic('alert', 15)), D.errText,
        h('button', { class: 'cv-ib', title: 'Dismiss', 'aria-label': 'Dismiss this error', onclick: () => { errBy.delete(C.root); paintCta(); } }, ic('x', 14)));
      return h('div', { class: 'cv-commit' }, D.msg, h('div', { class: 'cv-ctarow' }, D.cta, D.ctaMore), D.onMain, D.err);
    }

    function sizeMsg() {
      D.msg.style.height = 'auto';
      if (D.msg.scrollHeight) D.msg.style.height = Math.min(D.msg.scrollHeight + 2, 200) + 'px';
    }

    function ctaState(d, r) {
      if (busyBy.has(C.root)) return { label: busyBy.get(C.root) + '…', off: true };
      if (!d || d.error || !r) return { label: d?.error ? 'This repo could not be read' : 'Reading the repo…', off: true };
      return smartAction(r, counts(), message());
    }

    function paintCta() {
      const d = detail(); const r = info();
      const ready = !!d && !d.error && !!r;
      const busy = busyBy.has(C.root);
      const err = errBy.get(C.root);
      const a = ctaState(d, r);
      setText(D.ctaText, a.label);
      D.cta.disabled = !!a.off;
      D.cta.classList.toggle('busy', busy);
      D.cta.classList.toggle('off', !!a.off && !busy);
      D.ctaMore.classList.toggle('off', !!a.off);
      D.ctaMore.disabled = busy || !ready;
      const icon = busy ? 'spin' : a.icon || '';
      if (D.ctaIcon.dataset.icon !== icon) {
        D.ctaIcon.dataset.icon = icon;
        D.ctaIcon.replaceChildren(...(icon === 'spin' ? [h('span', { class: 'cv-spin' })] : icon ? [ic(icon, 16)] : []));
      }
      const n = ready ? counts() : { staged: 0, changes: 0 };
      const onMain = ready && (r.branch === 'main' || r.branch === 'master') && (n.staged || n.changes);
      show(D.onMain, !!onMain);
      if (onMain) setText(D.onMain, `Committing on ${r.branch}`);
      show(D.err, !!err);
      if (err) setText(D.errText, err);
    }

    function buildSection(key, title) {
      const label = h('span', { class: 'cv-sect' }, title);
      const acts = h('span', { class: 'cv-secacts' });
      const list = h('div', { class: 'cv-rows' });
      const el = h('section', { class: 'cv-sec cv-sec-' + key, 'aria-label': title }, h('header', { class: 'cv-sech' }, label, acts), list);
      return { el, label, list, acts, title };
    }

    function paintSection(sec, key, list) {
      show(sec.el, list.length > 0);
      setText(sec.label, `${sec.title} (${list.length})`);
      const hot = hotFile(); const onTouch = touch();
      syncKids(sec.list, list.map(f => {
        const edit = editState(f, hot);
        return { key: f.rel, sig: [f.x, f.y, f.add, f.del, f.binary, f.from, edit, onTouch].join('|'), build: () => fileRow(f, key, edit) };
      }));
      for (const row of sec.list.children) {
        row.classList.toggle('sel', C.sel === row.dataset.key);
        row.classList.toggle('busy', rowBusy.has(C.root + '|' + row.dataset.key));
      }
    }

    function paintChanges() {
      if (!D.msg) return;
      const d = detail(); const fs = files();
      paintCta();
      show(D.secSkel, !d);
      show(D.secEmpty, !!d && !d.error && !fs.length);
      show(D.secError, !!d?.error);
      if (d?.error) setText(D.secError, d.error);
      show(D.secTrunc, !!d?.truncated);
      paintSection(D.conf, 'conflicts', fs.filter(isConflict));
      paintSection(D.staged, 'staged', fs.filter(isStaged));
      paintSection(D.changes, 'changes', fs.filter(isChange));
    }

    function buildChanges() {
      D.conf = buildSection('conflicts', 'Conflicts');
      D.staged = buildSection('staged', 'Staged');
      D.changes = buildSection('changes', 'Changes');
      const secAct = (label, name, onclick, cls) => h('button', { class: 'cv-ib' + (cls ? ' ' + cls : ''), title: label, 'aria-label': label, onclick }, ic(name, 16));
      D.staged.acts.append(secAct('Unstage all', 'minus', doUnstageAll));
      D.changes.acts.append(secAct('Stage all', 'plus', doStageAll));
      D.secSkel = h('div', { class: 'cv-sec' }, h('div', { class: 'cv-skel rows' }, skelBars(5, 50, 40)));
      D.secEmpty = h('div', { class: 'cv-empty', hidden: true }, h('b', null, 'Working tree is clean'), h('span', null, 'Edits in this repo show up here.'));
      D.secError = h('div', { class: 'cv-empty', hidden: true });
      D.secTrunc = h('div', { class: 'cv-trunc', hidden: true }, 'This repo has too many changed files to list them all.');
      return h('div', { class: 'cv-tab' }, buildCommitBox(), h('div', { class: 'cv-scroll cv-secs' }, D.secSkel, D.secEmpty, D.secError, D.conf.el, D.staged.el, D.changes.el, D.secTrunc));
    }

    function openRow(f, sec) {
      C.sel = sec + ':' + f.rel;
      if (stacked()) { C.one = f.rel; enterView(); paint(); return; }
      if ((PREF.scope === 'staged' && !isStaged(f)) || (PREF.scope === 'unstaged' && !isChange(f))) setScope('all');
      paint();
      D.stack.scrollTo(f.rel);
    }

    function enterView() {
      if (C.step === 'view') return;
      C.step = 'view';
      if (layered()) { pushLayer('code'); C.layers = 1; }
    }

    function closeView() { C.step = 'list'; C.one = null; }

    function dropViewLayer() {
      if (C.layers && layered()) { C.layers = 0; popLayer(); }
    }

    function openFile(rel) {
      TREE.sel = rel; TREE.mode = 'auto'; TREE.editing = false;
      stamp.tree = null;
      setTab('files');
      if (stacked()) enterView();
      paint();
    }

    function setTab(tab) {
      if (C.tab === tab) return;
      C.tab = tab;
      if (!panel) { PREF.tab = tab; savePrefs(); }
    }

    function setScope(scope) { PREF.scope = scope; savePrefs(); }

    function buildFiles() {
      D.treeHost = h('div', { class: 'cv-scroll cv-tree' });
      return h('div', { class: 'cv-tab' },
        h('div', { class: 'cv-tabbar' }, h('span', { class: 'cv-sect' }, 'Files'),
          h('button', { class: 'cv-ib', title: 'Reload the file tree', 'aria-label': 'Reload the file tree', onclick: () => { stamp.tree = null; paintTree(); } }, ic('refresh', 15))),
        D.treeHost);
    }

    function paintTree() {
      const r = info();
      if (!r || !D.treeHost || stamp.tree === C.root) return;
      stamp.tree = C.root;
      const box = h('div', { class: 'cv-treebox' });
      D.treeHost.replaceChildren(box);
      tabFiles(box, { id: C.root, isGit: true, name: r.name, rel: '', path: r.path }, { st: TREE, key: 'bd.code.fopen' });
      D.fileV.replaceChildren(box.querySelector('.fprev'));
      box.addEventListener('click', ev => { if (ev.target.closest('.frow.file') && stacked()) { enterView(); paint(); } });
    }

    function buildHistory() {
      D.histList = h('div', { class: 'cv-rows' });
      D.histMore = h('button', { class: 'btn sm cv-more', hidden: true, onclick: () => loadLog(false) }, 'Load more');
      D.histState = h('div', { class: 'cv-empty', hidden: true });
      D.histSkel = h('div', { class: 'cv-skel rows', hidden: true }, skelBars(6, 45, 45));
      D.stashes = h('div', { class: 'cv-rows' });
      D.stashSec = h('section', { class: 'cv-sec', hidden: true, 'aria-label': 'Stashes' }, h('header', { class: 'cv-sech' }, h('span', { class: 'cv-sect' }, 'Stashes')), D.stashes);
      return h('div', { class: 'cv-tab' }, h('div', { class: 'cv-scroll cv-secs' },
        h('section', { class: 'cv-sec', 'aria-label': 'Commits' }, h('header', { class: 'cv-sech' }, h('span', { class: 'cv-sect' }, 'Commits')), D.histSkel, D.histState, D.histList, D.histMore),
        D.stashSec));
    }

    function logSig() {
      const d = detail(); const r = info();
      return [C.root, r?.branch, r?.ahead, r?.behind, d?.commits?.recent?.[0]?.hash, d?.commits?.unpushed?.[0]?.hash].join('|');
    }

    async function loadLog(reset) {
      if (!C.root) return;
      const tok = ++HIST.tok; const id = C.root;
      if (reset) { HIST.sig = logSig(); HIST.err = null; if (HIST.root !== id) { HIST.commits = []; HIST.more = false; } HIST.root = id; }
      HIST.loading = true;
      paintHistoryList();
      try {
        const skip = reset ? 0 : HIST.commits.length;
        const d = await api(`git/${enc(id)}/log?skip=${skip}&limit=50`);
        if (tok !== HIST.tok) return;
        HIST.commits = reset ? d.commits || [] : [...HIST.commits, ...(d.commits || [])];
        HIST.more = !!d.more; HIST.err = d.error || null;
      } catch (e) { if (tok === HIST.tok) HIST.err = e.message; }
      if (tok === HIST.tok) { HIST.loading = false; paintHistoryList(); }
    }

    function commitRow(c) {
      const activate = () => openCommit(c);
      return h('div', {
        class: 'cv-row cv-crow', role: 'button', tabindex: '0', 'data-key': c.hash, title: c.subject,
        onclick: activate, onkeydown: onActivate(activate),
      },
      h('span', { class: 'cv-cmark' + (c.unpushed ? ' up' : ''), title: c.unpushed ? 'Not pushed yet' : 'Pushed' }, c.unpushed ? ic('arrowUp', 13) : ic('commit', 15)),
      h('span', { class: 'cv-txt' },
        h('span', { class: 'cv-name' }, h('span', { class: 'cv-nm' }, c.subject)),
        h('span', { class: 'cv-sub' }, h('span', { class: 'cv-hash' }, c.short), h('span', { class: 'cv-dirn' }, c.unpushed ? `Not pushed, ${c.rel}` : `${c.author}, ${c.rel}`))));
    }

    function paintHistoryList() {
      if (!D.histList) return;
      const loading = HIST.loading && !HIST.commits.length;
      const says = !loading && (!HIST.commits.length || !!HIST.err);
      show(D.histSkel, loading);
      show(D.histState, says);
      if (says) setText(D.histState, HIST.err || 'No commits yet');
      syncKids(D.histList, HIST.commits.map(c => ({ key: c.hash, sig: String(c.unpushed), build: () => commitRow(c) })));
      for (const row of D.histList.children) row.classList.toggle('sel', C.commit?.hash === row.dataset.key);
      show(D.histMore, HIST.more);
      D.histMore.disabled = HIST.loading;
    }

    function paintHistory() {
      if (HIST.root !== C.root || (HIST.sig !== logSig() && !HIST.loading)) loadLog(true);
      paintHistoryList();
      const stashes = detail()?.stashes || [];
      show(D.stashSec, stashes.length > 0);
      syncKids(D.stashes, stashes.map(s => ({
        key: s.ref, sig: s.msg + s.at,
        build: () => h('div', { class: 'cv-row static' }, h('span', { class: 'cv-cmark' }, ic('stash', 15)), h('span', { class: 'cv-txt' }, h('span', { class: 'cv-name' }, h('span', { class: 'cv-nm' }, s.msg)), h('span', { class: 'cv-sub' }, h('span', { class: 'cv-hash' }, s.ref), s.at ? h('span', { class: 'cv-dirn' }, ago(s.at)) : null))),
      })));
    }

    async function openCommit(c) {
      C.commit = { root: C.root, hash: c.hash, subject: c.subject, short: c.short };
      C.commitData = null;
      const tok = ++stamp.commitTok; const id = C.root;
      if (stacked()) enterView();
      paint();
      const d = await api(`git/${enc(id)}/commit/${enc(c.hash)}`).catch(e => ({ error: e.message, files: [] }));
      if (tok !== stamp.commitTok) return;
      C.commitData = d;
      paint();
    }

    function buildWorktrees() {
      D.wtList = h('div', { class: 'cv-rows' });
      D.wtManage = h('button', { class: 'btn sm cv-more', hidden: true, onclick: () => { const r = info(); if (r) openDrawer(r.project, 'worktrees'); } }, 'Manage worktrees');
      D.wtHint = h('div', { class: 'cv-empty', hidden: true }, h('span', null, 'This repo has one checkout. Start a chat in a worktree from its project menu to add another.'));
      return h('div', { class: 'cv-tab' }, h('div', { class: 'cv-scroll cv-secs' },
        h('section', { class: 'cv-sec', 'aria-label': 'Worktrees' }, h('header', { class: 'cv-sech' }, h('span', { class: 'cv-sect' }, 'Worktrees')), D.wtList, D.wtManage), D.wtHint));
    }

    function worktreeRow(w) {
      const pick = () => select(w.id);
      return h('div', {
        class: 'cv-row', role: 'button', tabindex: '0', 'data-key': w.id, title: w.path,
        onclick: pick, onkeydown: onActivate(pick),
      },
      h('span', { class: 'cv-cmark' }, ic('branch', 15)),
      h('span', { class: 'cv-txt' },
        h('span', { class: 'cv-name' }, h('span', { class: 'cv-nm' }, w.branch || 'Detached HEAD')),
        h('span', { class: 'cv-sub' }, h('span', { class: 'cv-dirn' }, w.worktree ? w.path.split('/').slice(-2).join('/') : 'Main checkout'))),
      w.live?.length ? h('span', { class: 'cv-lives' }, w.live.map(name => {
        const st = sessOf(name)?.claude?.state || 'unknown';
        return h('button', { class: 'wdot st-' + st, title: `${sessOf(name)?.claude?.label || name}: ${STATE_LABEL[st] || st}. Open this chat.`, 'aria-label': 'Open chat ' + name, onclick: ev => { ev.stopPropagation(); openTerm(name); } });
      })) : null,
      w.dirty ? h('span', { class: 'cv-count', title: plural(w.dirty, 'changed file') }, w.dirty) : null);
    }

    function paintWorktrees() {
      const list = detail()?.worktrees || [];
      syncKids(D.wtList, list.map(w => ({ key: w.id, sig: [w.branch, w.dirty, (w.live || []).map(n => n + (sessOf(n)?.claude?.state || '')).join()].join('|'), build: () => worktreeRow(w) })));
      for (const row of D.wtList.children) row.classList.toggle('sel', row.dataset.key === C.root);
      show(D.wtManage, list.length > 1);
      show(D.wtHint, !!detail() && list.length <= 1);
    }

    function serversOf(r) {
      if (!r?.project) return [];
      const rt = runtimeFor(r.project);
      const out = new Map();
      const add = (port, name, loopback) => { if (!out.has(port)) out.set(port, { port, name, loopback }); };
      for (const s of rt.sessions) for (const p of s.ports || []) if (!p.ephemeral) add(p.port, s.claude?.label || s.label || s.name, !!p.loopback);
      for (const e of rt.external) for (const p of e.ports || []) if (!p.ephemeral) add(p.port, e.label || e.comm, !!p.loopback);
      for (const c of rt.containers) if (c.state === 'running') for (const p of c.ports || []) if (p.host) add(p.host, c.service || c.name, String(p.hostIp).startsWith('127.'));
      return [...out.values()].sort((a, b) => a.port - b.port);
    }

    const localDash = () => /^(localhost|127\.|\[::1\])/.test(location.hostname);
    const urlOfPort = port => localDash() ? `http://${location.hostname}:${port}` : portUrl(port);

    function buildPreview() {
      D.prevList = h('div', { class: 'cv-rows' });
      D.prevSec = h('section', { class: 'cv-sec', 'aria-label': 'Running servers' }, h('header', { class: 'cv-sech' }, h('span', { class: 'cv-sect' }, 'Running servers')), D.prevList);
      D.prevEmpty = h('div', { class: 'cv-empty', hidden: true }, h('b', null, 'No server running for this repo.'), h('span', null, 'Start a dev server from a chat or a terminal and it shows up here.'));
      return h('div', { class: 'cv-tab' }, h('div', { class: 'cv-scroll cv-secs' }, D.prevSec, D.prevEmpty));
    }

    function serverRow(s) {
      const pick = () => { C.port = s.port; if (stacked()) enterView(); paint(); };
      return h('div', {
        class: 'cv-row', role: 'button', tabindex: '0', 'data-key': String(s.port), title: urlOfPort(s.port),
        onclick: pick, onkeydown: onActivate(pick),
      },
      h('span', { class: 'cv-cmark' }, ic('screen', 15)),
      h('span', { class: 'cv-txt' }, h('span', { class: 'cv-name' }, h('span', { class: 'cv-nm' }, s.name || 'Server')), h('span', { class: 'cv-sub' }, h('span', { class: 'cv-dirn' }, s.loopback && !localDash() && !exposedPort(s.port) ? 'Only reachable on the server' : urlOfPort(s.port)))),
      h('span', { class: 'cv-count' }, String(s.port)));
    }

    function paintPreviewList() {
      const list = serversOf(info());
      syncKids(D.prevList, list.map(s => ({ key: String(s.port), sig: [s.name, s.loopback, !!exposedPort(s.port)].join('|'), build: () => serverRow(s) })));
      for (const row of D.prevList.children) row.classList.toggle('sel', row.dataset.key === String(C.port));
      show(D.prevSec, list.length > 0);
      show(D.prevEmpty, !list.length);
    }

    function buildFrame() {
      D.urlText = h('span', { class: 'cv-urltext' });
      D.frameReload = h('button', { class: 'cv-ib', title: 'Reload', 'aria-label': 'Reload the preview', onclick: () => { stamp.frame = null; paintFrame(); } }, ic('refresh', 15));
      D.frameOpen = h('a', { class: 'cv-ib', title: 'Open in a new tab', 'aria-label': 'Open in a new tab', target: '_blank', rel: 'noopener' }, ic('ext', 15));
      D.frameBody = h('div', { class: 'cv-framebody' });
      return h('div', { class: 'cv-frame', hidden: true },
        h('div', { class: 'cv-urlbar' }, h('button', { class: 'cv-ib cv-vback', title: 'Back', 'aria-label': 'Back', onclick: () => back(true) }, ic('back', 16)), D.frameReload, D.urlText, D.frameOpen),
        D.frameBody);
    }

    function frameNote(url, title, text, extra) {
      D.frameBody.replaceChildren(h('div', { class: 'cv-empty big' }, h('b', null, title), h('span', null, text), h('span', { class: 'cv-noteacts' }, extra || null, h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, ic('ext', 15), 'Open'))));
    }

    function paintFrame() {
      const s = serversOf(info()).find(x => x.port === C.port);
      if (!s) {
        const key = 'none:' + C.port;
        if (stamp.frame === key) return;
        stamp.frame = key;
        D.frameBody.replaceChildren(h('div', { class: 'cv-empty big' }, h('b', null, C.port ? `Nothing is running on port ${C.port} any more.` : 'Pick a server to preview it here.')));
        setText(D.urlText, '');
        show(D.frameOpen, false); show(D.frameReload, false);
        return;
      }
      const url = urlOfPort(s.port);
      const local = s.loopback && !localDash() && !exposedPort(s.port);
      const key = url + (local ? '#local' : '');
      if (stamp.frame === key) return;
      stamp.frame = key;
      setText(D.urlText, url);
      D.frameOpen.href = url;
      show(D.frameOpen, true); show(D.frameReload, true);
      if (location.protocol === 'https:' && url.startsWith('http:')) { frameNote(url, 'This preview opens in its own tab', 'The dashboard is on https and this server is on http, so the browser will not show it inside the page.'); return; }
      if (new URL(url).origin === location.origin) { frameNote(url, 'This is the dashboard itself', 'It can not be shown inside its own page.'); return; }
      if (local) {
        frameNote(url, `Port ${s.port} only listens on the server`, 'Expose it to reach it from this device.', h('button', { class: 'btn', onclick: ev => exposeChip(ev, { port: s.port, addr: '127.0.0.1', loopback: true }) }, 'Expose'));
        return;
      }
      const frame = h('iframe', { class: 'cv-iframe', src: url, title: 'Preview of port ' + s.port, sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads' });
      D.frameBody.replaceChildren(frame);
      fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(5000) }).catch(() => {
        if (stamp.frame === key && frame.isConnected) frameNote(url, `Nothing answers on port ${s.port}`, 'The server may still be starting, or it may not serve pages.');
      });
    }

    function buildViewer() {
      D.vBack = h('button', { class: 'cv-ib cv-vback', title: 'Back', 'aria-label': 'Back', onclick: () => back(true) }, ic('back', 16));
      D.vLabel = h('span', { class: 'cv-vlabel' });
      D.vStat = statEl(0, 0);
      D.vPos = h('span', { class: 'cv-vpos', hidden: true });
      D.vPrev = h('button', { class: 'cv-ib', title: 'Previous file', 'aria-label': 'Previous file', hidden: true, onclick: () => stepFile(-1) }, ic('prev', 16));
      D.vNext = h('button', { class: 'cv-ib', title: 'Next file', 'aria-label': 'Next file', hidden: true, onclick: () => stepFile(1) }, ic('next', 16));
      D.vScopeT = h('span');
      D.vScope = h('button', { class: 'cv-scope', 'aria-haspopup': 'menu', title: 'Which changes to show', onclick: scopeMenu }, D.vScopeT, ic('chevronDown', 14));
      const tool = (name, label, onclick) => h('button', { class: 'cv-ib', title: label, 'aria-label': label, onclick }, ic(name, 16));
      D.tSplit = tool('split', 'Split view', () => { PREF.split = !PREF.split; savePrefs(); applyView(); });
      D.tWrap = tool('wrap', 'Wrap long lines', () => { PREF.wrap = !PREF.wrap; savePrefs(); applyView(); });
      D.tWs = tool('space', 'Ignore whitespace', () => { PREF.ws = !PREF.ws; savePrefs(); applyView(); paint(); });
      D.tAll = tool('collapseAll', 'Collapse all files', () => { D.stack.setAll(D.stack.allClosed()); paintTools(); });
      D.tRefresh = tool('refresh', 'Refresh', () => { if (C.root) loadDetail(C.root, true); D.stack.reload(); });
      D.vHead = h('header', { class: 'cv-vh' }, D.vBack, D.vLabel, D.vStat, h('span', { class: 'cv-wsp' }), D.vPos, D.vPrev, D.vNext, D.vScope, h('span', { class: 'cv-tools' }, D.tSplit, D.tWrap, D.tWs, D.tAll, D.tRefresh));
      D.vMeta = h('div', { class: 'cv-cmeta', hidden: true });
      D.vEmpty = h('div', { class: 'cv-empty big', hidden: true });
      D.vScroll = h('div', { class: 'cv-vbody' });
      D.stack = makeStack({ scroller: D.vScroll, split: splitOn, onStat: paintStat, onOpen: item => openFile(item.rel) });
      D.vScroll.append(D.vMeta, D.vEmpty, D.stack.list);
      D.stackV = h('div', { class: 'cv-stackv' }, D.vHead, D.vScroll);
      D.fileV = h('div', { class: 'cv-filev' });
      D.fileWrap = h('div', { class: 'cv-filewrap', hidden: true },
        h('div', { class: 'cv-fileh' }, h('button', { class: 'cv-ib', title: 'Back', 'aria-label': 'Back', onclick: () => back(true) }, ic('back', 16))),
        D.fileV);
      D.frameV = buildFrame();
      new ResizeObserver(() => {
        const wide = D.vScroll.clientWidth >= SPLIT_MIN;
        if (!D.vScroll.clientWidth || wide === stamp.wide) return;
        stamp.wide = wide;
        applyView();
      }).observe(D.vScroll);
      return h('section', { class: 'cv-pane cv-main' }, D.stackV, D.fileWrap, D.frameV);
    }

    function splitOn() { return PREF.split && D.vScroll.clientWidth >= SPLIT_MIN; }

    function applyView() {
      D.vScroll.classList.toggle('wrap', PREF.wrap);
      paintTools();
      D.stack.repaintAll();
    }

    function swapIcon(btn, name) {
      if (btn.dataset.icon === name) return;
      btn.dataset.icon = name;
      btn.replaceChildren(ic(name, 16));
    }

    function labelBtn(btn, label) { btn.title = label; btn.setAttribute('aria-label', label); }

    function paintTools() {
      const canSplit = D.vScroll.clientWidth >= SPLIT_MIN;
      D.tSplit.disabled = !canSplit;
      labelBtn(D.tSplit, !canSplit ? 'Split view needs a wider pane' : splitOn() ? 'Switch to unified view' : 'Switch to split view');
      swapIcon(D.tSplit, splitOn() ? 'unified' : 'split');
      D.tWrap.setAttribute('aria-pressed', String(PREF.wrap));
      D.tWs.setAttribute('aria-pressed', String(PREF.ws));
      const closed = D.stack.allClosed();
      labelBtn(D.tAll, closed ? 'Expand all files' : 'Collapse all files');
      swapIcon(D.tAll, closed ? 'expandAll' : 'collapseAll');
      show(D.tAll, !C.one);
    }

    function paintStat() { const t = D.stack.total(); D.vStat.set(t.add, t.del); }

    function scopeMenu(ev) {
      openMenu(ev, Object.entries(SCOPES).map(([k, label]) => ({ label, cur: PREF.scope === k, onclick: () => { setScope(k); paint(); } })));
    }

    function stepFile(dir) {
      const list = orderedFiles();
      const f = list[list.findIndex(x => x.rel === C.one) + dir];
      if (!f) return;
      C.sel = secOf(f) + ':' + f.rel;
      C.one = f.rel;
      paint();
      D.vScroll.scrollTop = 0;
    }

    function paintEmpty(key, build) {
      show(D.vEmpty, !!key);
      if (key && stamp.empty !== key) fill(D.vEmpty, ...build());
      stamp.empty = key;
    }

    const bigSkel = () => [h('div', { class: 'cv-skel big' }, skelBars(10, 30, 60))];

    function paintChangesView() {
      const d = detail();
      show(D.vScope, true);
      setText(D.vScopeT, SCOPES[PREF.scope]);
      show(D.vMeta, false); stamp.meta = '';
      const one = stacked() ? C.one : null;
      const shown = one ? orderedFiles().filter(f => f.rel === one) : scopeFiles();
      const list = orderedFiles();
      const pos = list.findIndex(f => f.rel === one);
      show(D.vPos, !!one && pos >= 0); show(D.vPrev, !!one); show(D.vNext, !!one);
      show(D.vScope, !one);
      if (one) { setText(D.vPos, `${pos + 1} of ${list.length}`); D.vPrev.disabled = pos <= 0; D.vNext.disabled = pos < 0 || pos >= list.length - 1; }
      setText(D.vLabel, one ? baseOf(one) : PREF.scope === 'all' ? 'All changes' : `${SCOPES[PREF.scope]} changes`);
      D.vLabel.title = one || '';
      D.stack.set(d && !d.error ? shown.map(diffItem) : [], 'changes|' + C.root);
      D.stack.mark(C.sel ? C.sel.slice(C.sel.indexOf(':') + 1) : null);
      paintStat();
      if (!d) { paintEmpty('loading', bigSkel); return; }
      if (d.error) { paintEmpty('err' + d.error, () => [h('b', null, 'This repo could not be read'), h('span', null, d.error)]); return; }
      if (one && !shown.length) { paintEmpty('gone' + one, () => [h('b', null, 'No more changes in this file'), h('span', null, baseOf(one))]); return; }
      if (shown.length) { paintEmpty('', null); return; }
      if (PREF.scope === 'staged' && files().length) { paintEmpty('nostage', () => [h('b', null, 'Nothing staged'), h('span', null, 'Stage a file and its diff shows up here.')]); return; }
      if (PREF.scope === 'unstaged' && files().length) { paintEmpty('nounst', () => [h('b', null, 'Everything is staged'), h('span', null, 'Switch to Staged to read what will be committed.')]); return; }
      const last = d.commits?.recent?.[0];
      paintEmpty('clean' + (last?.hash || ''), () => [h('b', null, 'No changes'), last ? h('span', null, 'Last commit ', h('span', { class: 'cv-hash' }, last.short || String(last.hash).slice(0, 7)), ' ' + last.subject) : null]);
    }

    function paintCommitView() {
      show(D.vScope, false);
      show(D.vPos, false); show(D.vPrev, false); show(D.vNext, false);
      const c = C.commit?.root === C.root ? C.commit : null;
      const d = c ? C.commitData : null;
      setText(D.vLabel, c ? c.subject : 'History');
      D.vLabel.title = c ? c.subject : '';
      if (!c) {
        D.stack.set([], 'commit|none'); paintStat();
        show(D.vMeta, false); stamp.meta = '';
        paintEmpty('pick', () => [h('b', null, 'Pick a commit'), h('span', null, 'Its changes show up here, file by file.')]);
        return;
      }
      const items = (d?.files || []).map(f => {
        const url = `git/${enc(C.root)}/commit/${enc(c.hash)}?file=${enc(f.path)}${PREF.ws ? '&ws=1' : ''}`;
        return { key: f.path, rel: f.path, letter: (f.s || 'M')[0], add: f.add || 0, del: f.del || 0, binary: f.add == null, url, sig: url };
      });
      D.stack.set(items, 'commit|' + c.hash);
      paintStat();
      const metaKey = c.hash + (d ? ':' + (d.body || '') : '');
      show(D.vMeta, !!d && !d.error);
      if (d && !d.error && stamp.meta !== metaKey) {
        stamp.meta = metaKey;
        fill(D.vMeta, h('div', { class: 'cv-cmetaline' }, h('span', { class: 'cv-hash' }, d.short), h('span', null, `${d.author}, ${d.rel}`)), d.body ? h('p', { class: 'cv-cbody' }, d.body) : null);
      }
      if (!d) { paintEmpty('loadingc', bigSkel); return; }
      if (d.error) { paintEmpty('errc' + d.error, () => [h('b', null, 'This commit could not be read'), h('span', null, d.error)]); return; }
      if (!items.length) { paintEmpty('emptyc', () => [h('b', null, 'This commit changes no files')]); return; }
      paintEmpty('', null);
    }

    function paintViewer() {
      const mode = C.tab === 'files' ? 'file' : C.tab === 'preview' ? 'preview' : C.tab === 'history' ? 'commit' : 'changes';
      show(D.stackV, mode === 'changes' || mode === 'commit');
      show(D.fileWrap, mode === 'file');
      show(D.frameV, mode === 'preview');
      if (mode === 'changes') paintChangesView();
      else if (mode === 'commit') paintCommitView();
      else if (mode === 'preview') paintFrame();
      paintTools();
    }

    function pickRepo(id) {
      closePop();
      if (stacked() && C.step === 'view') { closeView(); dropViewLayer(); }
      select(id);
    }

    function repoRow(id, name, o) {
      const r = wipRoot(id);
      const n = work(r);
      return h('button', { class: 'cv-opt' + (id === C.root ? ' cur' : '') + (o.nested ? ' nested' : ''), role: 'option', onclick: () => pickRepo(id) },
        o.nested ? h('span', { class: 'cv-optic' }, ic('branch', 15)) : avatar(o.project, 'sm'),
        h('span', { class: 'cv-optt' }, h('span', { class: 'cv-optn1' }, name), o.sub ? h('span', { class: 'cv-optn2' }, o.sub) : null),
        n ? h('span', { class: 'cv-count', title: `${plural(pending(r), 'changed file')}, ${plural(r.ahead || 0, 'unpushed commit')}` }, n) : null);
    }

    function worktreesOf(pid) {
      const fromWip = wipOf().roots.filter(r => r.worktree && r.project === pid).map(r => ({ id: r.id, branch: r.branch }));
      const fromDet = (det.get(pid)?.data?.worktrees || []).filter(w => w.worktree);
      return [...new Map([...fromDet, ...fromWip].map(w => [w.id, w])).values()].sort((a, b) => String(a.branch).localeCompare(String(b.branch)));
    }

    function repoRows(q) {
      const low = q.toLowerCase();
      const hit = (...texts) => !low || texts.some(t => String(t || '').toLowerCase().includes(low));
      const none = () => [h('div', { class: 'cv-optnone' }, 'No repo matches')];
      if (panel) {
        const rows = sessionRoots(C.ws).map(rootInfo).filter(r => hit(r.name, r.branch)).map(r => repoRow(r.id, r.name, { project: r.project, sub: r.branch }));
        return rows.length ? rows : none();
      }
      const wip = wipList().filter(r => hit(r.name, r.branch, r.org));
      const taken = new Set(wip.map(r => r.id));
      const mains = S.projects.filter(p => p.isGit && !p.hidden).sort((a, b) => a.name.localeCompare(b.name));
      const orgs = [...new Set(mains.map(p => p.org || ''))].sort((a, b) => (!a - !b) || a.localeCompare(b));
      const groups = orgs.map(org => {
        const rows = mains.filter(p => (p.org || '') === org).flatMap(p => {
          const self = !taken.has(p.id) && hit(p.name, org) ? [repoRow(p.id, p.name, { project: p.id, sub: gitOf(p)?.branch })] : [];
          const wts = worktreesOf(p.id).filter(w => !taken.has(w.id) && hit(p.name, w.branch));
          return [...self, ...wts.map(w => repoRow(w.id, w.branch || w.id, { project: p.id, nested: true, sub: self.length ? null : p.name }))];
        });
        return rows.length ? [optHead(org || 'Other'), ...rows] : [];
      }).flat();
      const out = [
        ...(wip.length ? [optHead('Work in progress', wip.length), ...wip.map(r => repoRow(r.id, r.name, { project: r.project, sub: r.branch }))] : []),
        ...(groups.length ? [h('div', { class: 'cv-optband' }, 'All projects'), ...groups] : []),
      ];
      return out.length ? out : none();
    }

    function openRepos(ev) {
      const anchor = ev.currentTarget;
      openPop(anchor, 'cv-repopop', el => {
        comboBox(el, panel ? 'Find a repo of this chat' : 'Find a repo', repoRows);
        const r = info();
        if (r) el.append(h('div', { class: 'cv-popfoot' }, h('button', { class: 'cv-footbtn', onclick: () => { closePop(); addToChat(anchor, r.id, r.name, panel ? TERM.active : null); } }, ic('chat', 15), 'Add work in progress to chat')));
      });
    }

    function branchRow(b, id) {
      const held = !!b.worktree && !b.current;
      const go = () => {
        closePop();
        if (b.current) return;
        run('Switching branch', async () => { const r = await gitOp(id, { op: 'checkout', branch: b.name }); toast('On ' + r.branch, 'ok'); });
      };
      return h('button', { class: 'cv-opt' + (b.current ? ' cur' : ''), role: 'option', disabled: held, title: held ? `Checked out in another worktree: ${b.worktree}` : b.name, onclick: go },
        h('span', { class: 'cv-optic' }, ic('branch', 15)),
        h('span', { class: 'cv-optt' }, h('span', { class: 'cv-optn1' }, b.name), held ? h('span', { class: 'cv-optn2' }, 'Open in another worktree') : null),
        b.ahead ? h('span', { class: 'cv-arrow' }, ic('arrowUp', 12), b.ahead) : null,
        b.behind ? h('span', { class: 'cv-arrow' }, ic('arrowDown', 12), b.behind) : null,
        b.current ? h('span', { class: 'cv-badge' }, 'current') : null,
        held ? h('span', { class: 'cv-badge' }, 'worktree') : null,
        b.remote ? h('span', { class: 'cv-badge' }, 'remote') : null);
    }

    function openBranches(ev) {
      const anchor = ev.currentTarget; const id = C.root;
      if (!id) return;
      openPop(anchor, 'cv-branchpop', el => {
        const data = { list: null, truncated: false, error: null };
        const create = q => h('button', {
          class: 'cv-opt', role: 'option',
          onclick: () => { closePop(); run('Creating branch', async () => { const r = await gitOp(id, { op: 'branch', name: q }); toast('On new branch ' + r.branch, 'ok'); }); },
        }, h('span', { class: 'cv-optic' }, ic('plus', 15)), h('span', { class: 'cv-optt' }, h('span', { class: 'cv-optn1' }, `Create branch ${q}`)));
        const rows = q => {
          if (data.error) return [h('div', { class: 'cv-optnone' }, data.error)];
          if (!data.list) return [h('div', { class: 'cv-skel rows' }, skelBars(5, 40, 50))];
          const low = q.toLowerCase();
          const hits = data.list.filter(b => !low || b.name.toLowerCase().includes(low));
          const exact = data.list.some(b => b.name === q || b.name.replace(/^[^/]+\//, '') === q);
          return [
            ...hits.map(b => branchRow(b, id)),
            q && !exact ? create(q) : null,
            !hits.length && !q ? h('div', { class: 'cv-optnone' }, 'No branches found') : null,
            data.truncated ? h('div', { class: 'cv-optnone' }, 'Showing the most recent branches only.') : null,
          ].filter(Boolean);
        };
        const refill = comboBox(el, 'Find or create a branch', rows);
        api(`git/${enc(id)}/branches`)
          .then(d => { data.list = d.branches || []; data.truncated = !!d.truncated; data.error = d.error || null; }, e => { data.error = e.message; })
          .then(() => { if (el.isConnected) refill(); });
      });
    }

    function leftHead() {
      D.backChat = h('button', { class: 'cv-ib cv-backchat', title: 'Back to the chat', 'aria-label': 'Back to the chat', hidden: true, onclick: () => { const n = 1 + C.layers; C.fromTerm = null; C.layers = 0; closeView(); goBack(n); } }, ic('back', 16));
      D.repoAv = h('span', { class: 'cv-repoav' });
      D.repoName = h('span', { class: 'cv-reponame' });
      D.repoChev = h('span', { class: 'cv-chev' }, ic('chevronDown', 15));
      D.repoBtn = h('button', { class: 'cv-repo', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', title: 'Switch repo', onclick: openRepos }, D.repoAv, D.repoName, D.repoChev);
      D.branchName = h('span', { class: 'cv-brname' });
      D.branchAhead = h('span', { class: 'cv-arrow', hidden: true, title: 'Commits to push' });
      D.branchBehind = h('span', { class: 'cv-arrow', hidden: true, title: 'Commits to pull' });
      D.branchBtn = h('button', { class: 'cv-branch', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', title: 'Switch or create a branch', onclick: openBranches }, ic('branch', 15), D.branchName, D.branchAhead, D.branchBehind, h('span', { class: 'cv-chev' }, ic('chevronDown', 14)));
      D.seg = h('div', { class: 'cv-seg', role: 'tablist', 'aria-label': 'Code sections' }, TABS.map(([key, label, icon]) => h('button', {
        class: 'cv-segb', role: 'tab', title: label, 'aria-label': label, 'data-tab': key,
        onclick: () => { if (stacked() && C.step === 'view') { closeView(); dropViewLayer(); } setTab(key); paint(); },
      }, ic(icon, 17))));
      const panelBtns = panel ? [
        h('button', { class: 'cv-ib', title: 'Expand to the full Code view', 'aria-label': 'Expand to the full Code view', onclick: () => V.open({ root: C.root, session: TERM.active }) }, ic('full', 15)),
        h('button', { class: 'cv-ib', title: 'Close this panel', 'aria-label': 'Close this panel', onclick: () => toggleWs(false) }, ic('x', 15)),
      ] : [];
      return h('div', { class: 'cv-lhead' }, h('div', { class: 'cv-reporow' }, D.backChat, D.repoBtn, panelBtns), D.branchBtn, D.seg);
    }

    function buildLeft() {
      const head = leftHead();
      D.tabs = { changes: buildChanges(), files: buildFiles(), history: buildHistory(), worktrees: buildWorktrees(), preview: buildPreview() };
      D.noRepo = h('div', { class: 'cv-empty big', hidden: true });
      D.left = h('section', { class: 'cv-pane cv-left' }, head, D.noRepo, ...Object.values(D.tabs));
      return D.left;
    }

    function setWidth(w) {
      PREF.w = Math.round(Math.max(280, Math.min(600, w)));
      D.el.style.setProperty('--cv-w', PREF.w + 'px');
      D.grip.setAttribute('aria-valuenow', String(PREF.w));
    }

    function startGrip(ev) {
      ev.preventDefault();
      const left = D.left.getBoundingClientRect().left;
      D.el.classList.add('dragging');
      const mv = e => setWidth(e.clientX - left);
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); D.el.classList.remove('dragging'); savePrefs(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    }

    function ensure() {
      const host = hostEl(); if (!host) return false;
      if (!D.el) {
        D.el = h('div', { class: 'cv-root' + (panel ? ' cvp' : '') });
        const left = buildLeft();
        const main = buildViewer();
        D.grip = panel ? null : h('div', {
          class: 'cv-grip', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the file list', 'aria-valuemin': '280', 'aria-valuemax': '600', tabindex: '0',
          onpointerdown: startGrip,
          onkeydown: ev => { if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); setWidth(PREF.w + (ev.key === 'ArrowLeft' ? -20 : 20)); savePrefs(); } },
        });
        D.el.append(left, ...(D.grip ? [D.grip] : []), main);
        if (D.grip) setWidth(PREF.w);
      }
      if (D.el.parentElement !== host) host.replaceChildren(...(panel ? [h('div', { class: 'cvp-grip', title: 'Drag to resize', onpointerdown: grip }), D.el] : [D.el]));
      return true;
    }

    const known = id => !!byId()[id] || !!wipRoot(id) || (id.includes('~') && !det.get(id)?.data?.error);

    function defaultRoot() {
      const saved = localStorage.getItem('bd.code.root');
      if (saved && known(saved)) return saved;
      return wipList()[0]?.id || S.projects.find(p => p.isGit && !p.hidden)?.id || null;
    }

    function select(id) {
      if (C.root === id) { paint(); return; }
      C.root = id; C.sel = null; C.one = null; C.commit = null; C.commitData = null; C.port = null;
      stamp.tree = null; stamp.frame = null; TREE.sel = null;
      if (!panel && id) localStorage.setItem('bd.code.root', id);
      if (D.msg) { D.msg.value = id ? localStorage.getItem(draftKey(id)) || '' : ''; sizeMsg(); }
      paint();
    }

    function syncPanelSession() {
      if (C.sess !== TERM.active) { C.sess = TERM.active; C.root = null; C.pin = null; closeView(); }
      C.ws = wsOf(C.sess);
      const ids = sessionRoots(C.ws);
      if (C.ws && !ids.includes(C.root) && C.root !== C.pin) {
        C.root = null;
        if (ids[0]) select(ids[0]);
      }
    }

    function syncSession() {
      if (panel) { syncPanelSession(); return; }
      if (C.sess && !sessOf(C.sess)) C.sess = null;
      C.ws = C.sess ? wsOf(C.sess) : null;
    }

    function ensureRoot() {
      if (panel) return;
      if (C.root && !known(C.root)) C.root = null;
      if (!C.root) { const id = defaultRoot(); if (id) select(id); }
    }

    function resolveWant() {
      const w = C.want;
      if (!w || w.root !== C.root || !detail()) return;
      C.want = null;
      const f = files().find(x => x.rel === w.rel);
      if (!f) { openFile(w.rel); return; }
      C.sel = secOf(f) + ':' + f.rel;
      setTab('changes');
      if (stacked()) { C.one = f.rel; enterView(); return; }
      setScope('all');
      queueMicrotask(() => D.stack.scrollTo(f.rel));
    }

    function paintHead() {
      const r = info();
      const avatarKey = r ? r.project : '';
      if (stamp.avatar !== avatarKey) {
        stamp.avatar = avatarKey;
        D.repoAv.replaceChildren(...(r ? [avatar(r.project, 'sm')] : []));
      }
      setText(D.repoName, r ? r.name : panel ? 'No repo yet' : 'No repo');
      const several = !panel || sessionRoots(C.ws).length > 1;
      D.repoBtn.disabled = !several;
      show(D.repoChev, several);
      setText(D.branchName, r ? (r.detached ? 'Detached HEAD' : r.branch || 'Reading…') : '');
      D.branchBtn.disabled = !r;
      show(D.branchAhead, !!r?.ahead); show(D.branchBehind, !!r?.behind);
      const arrows = `${r?.ahead || 0}|${r?.behind || 0}`;
      if (stamp.arrows !== arrows) {
        stamp.arrows = arrows;
        D.branchAhead.replaceChildren(ic('arrowUp', 12), String(r?.ahead || 0));
        D.branchBehind.replaceChildren(ic('arrowDown', 12), String(r?.behind || 0));
      }
      show(D.backChat, !panel && !!C.fromTerm);
      for (const b of D.seg.children) {
        const on = b.dataset.tab === C.tab;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', String(on));
      }
      for (const [k, t] of Object.entries(D.tabs)) show(t, k === C.tab && !!C.root);
      show(D.noRepo, !C.root);
      if (!C.root) setText(D.noRepo, panel ? 'This chat has not touched a repo yet.' : 'No git repos found.');
    }

    function paintTab() {
      if (C.tab === 'changes') paintChanges();
      else if (C.tab === 'files') paintTree();
      else if (C.tab === 'history') paintHistory();
      else if (C.tab === 'worktrees') paintWorktrees();
      else paintPreviewList();
    }

    function paint() {
      if (!active() || !ensure()) return;
      syncSession();
      ensureRoot();
      if (C.root) loadDetail(C.root);
      resolveWant();
      if (stacked()) D.el.dataset.step = C.step; else delete D.el.dataset.step;
      paintHead();
      if (!C.root) return;
      paintTab();
      paintViewer();
      if (!stamp.sized && D.msg.offsetParent) { stamp.sized = true; sizeMsg(); }
    }

    function leave() {
      closePop();
      C.fromTerm = null;
      if (panel) return;
      const top = C.layers && LAYERS.hist[LAYERS.depth]?.bd === 'code';
      C.layers = 0;
      closeView();
      if (top && !LAYERS.restoring) goBack(1);
    }

    function back(fromButton) {
      if (!active() || C.step !== 'view') return false;
      closeView();
      if (layered() && C.layers) { C.layers = 0; if (fromButton) popLayer(); }
      paint();
      return true;
    }

    function openPath(root, rel) {
      C.want = { root, rel }; C.pin = root;
      if (C.root !== root) select(root); else paint();
    }

    async function open(o = {}) {
      closePop();
      const fromTerm = TERM.open ? TERM.active : null;
      const live = o.session ? sessOf(o.session) : null;
      const session = o.session && (!live || live.claude) ? o.session : null;
      C.sess = (live && session) || fromTerm;
      if (session && !WSC.get(session)?.data) {
        await api('workspace?session=' + enc(session)).then(ws => { WSC.set(session, { at: Date.now(), loading: false, data: ws, sig: '' }); }, e => toast('Could not open that chat\'s repos: ' + e.message, 'err'));
      }
      const ws = session ? WSC.get(session)?.data : null;
      const target = o.root
        || (o.roots?.length ? firstWork(o.roots) : null)
        || (o.set ? firstWork(setRoots(o.set)) : null)
        || (ws ? sessionRoots(ws)[0] : null)
        || (o.overview ? (work(wipRoot(C.root)) ? C.root : wipList()[0]?.id) : null)
        || null;
      closeView();
      const reuse = UI.drawer && LAYERS.hist[LAYERS.depth]?.bd === 'drawer' ? 1 : 0;
      if (UI.drawer) closeDrawer(false);
      if (TERM.open) closeTermPanel(false);
      C.fromTerm = fromTerm;
      const need = phone() && o.file ? 1 : 0;
      if (o.file) C.want = { root: target || C.root, rel: o.file };
      if (need) C.step = 'view';
      setView('code');
      if (phone()) {
        const have = C.layers + reuse;
        if (reuse && have <= need) retop('code');
        if (have < need) pushLayer('code');
        if (have > need) goBack(have - need);
      }
      C.layers = need;
      navTo();
      if (ensure() && target) select(target); else paint();
    }

    return { C, paint, back, open, openPath, leave };
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
    closePop();
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

  function badge(name) {
    if (!sessOf(name)?.claude) return null;
    const ws = wsOf(name); if (!ws) return null;
    const rs = wsRoots(ws); if (!rs.length) return null;
    return { repos: rs.length, files: rs.reduce((a, id) => a + pending(wipRoot(id)), 0) };
  }

  function termBar(name) {
    if (!sessOf(name)?.claude) return null;
    queueMicrotask(paintPanel);
    const b = badge(name);
    const pressed = WS.on && !phone();
    return h('button', { class: 'btn sm ghost cvfiles' + (pressed ? ' on' : ''), 'aria-pressed': pressed ? 'true' : 'false', title: 'Repos of this chat with their changes', onclick: () => phone() ? V.open({ session: name }) : toggleWs() },
      ico('folder', 14), h('span', { class: 'desk' }, 'Files'), b ? h('span', { class: 'pill' + (b.files ? ' warn' : '') }, b.files || plural(b.repos, 'repo')) : null);
  }

  function termBarKey(name) { const b = badge(name); return [WS.on, b && b.repos, b && b.files]; }

  function toolOpen(t, ctx) {
    if (!t || !t.file || !['Edit', 'MultiEdit', 'Write'].includes(t.name)) return null;
    return h('button', { class: 'tr-open', title: 'open ' + t.file + ' in the viewer', onclick: ev => { ev.stopPropagation(); openAbs(t.file, ctx && ctx.session); } }, 'open');
  }

  function openAbs(abs) {
    const hit = rootForPath(abs);
    if (!hit) { toast('Not inside a known git repo: ' + abs, 'err'); return; }
    if (phone() || !TERM.open || !sessOf(TERM.active)?.claude) { V.open({ root: hit.root, file: hit.rel }); return; }
    if (!WS.on) toggleWs(true);
    P.C.sess = TERM.active;
    P.openPath(hit.root, hit.rel);
  }

  function onState() {
    if (UI.view !== 'code' && (V.C.layers || V.C.step !== 'list' || V.C.fromTerm)) V.leave();
    repaint();
  }

  function deepLink(q) {
    if (q.get('view') !== 'code') return false;
    history.replaceState(null, '', location.pathname);
    const o = { set: q.get('set') || null, root: q.get('root') || null, file: q.get('file') || null, session: q.get('session') || null };
    V.open({ ...o, overview: !o.set && !o.root && !o.session });
    return true;
  }

  const rightOpen = which => { if (which !== 'files' && panelOn()) toggleWs(false); };
  const filesOn = panelOn;

  return { open: V.open, back: V.back, onState, rightOpen, filesOn, deepLink, termBar, termBarKey, toolOpen, openAbs, togglePanel: toggleWs, state: V.C, panel: P.C };
})();
