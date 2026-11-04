'use strict';
// F: subagents + cost by model. Registers FEAT.subagents { chatBar, homeTiles }.
(() => {
  const FAMS = ['opus', 'sonnet', 'haiku', 'fable', 'other'];
  const FAM_LABEL = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', other: 'Other' };
  const famOf = id => { const m = String(id || '').toLowerCase(); return m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : (m.includes('fable') || m.includes('mythos')) ? 'fable' : 'other'; };
  const money = v => v == null ? '–' : v > 0 && v < 0.01 ? '<$0.01' : v < 10 ? '$' + v.toFixed(2) : '$' + v.toFixed(0);
  const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's' : Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm'; };
  const tok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0);
  const modelBadge = a => { const id = a.modelId || a.model; const fam = famOf(id); const nm = id ? (typeof modelName === 'function' ? modelName(id) : id) : '?'; return h('span', { class: 'sa-mod sa-f-' + fam, title: id || '' }, nm); };
  const agentDur = a => dur((a.running ? Date.now() : a.lastAt) - a.startedAt);

  // ---- per-session data, shared by all chips of that session -------------------------------------------------
  const DATA = new Map();     // tmux name -> { at, j, err }
  const CHIPS = new Set();    // { el, name }
  const fetchAgents = async name => {
    const e = DATA.get(name) || {}; if (e.busy) return; e.busy = true; DATA.set(name, e);
    try { e.j = await api('subagents/' + encodeURIComponent(name)); e.err = null; } catch (x) { e.err = x; if (!e.j) e.j = { agents: [] }; }
    e.busy = false; e.at = Date.now(); paintChips(name);
    if (e.j && e.j.partial && !e.more) { e.more = true; setTimeout(() => { e.more = false; fetchAgents(name); }, 300); }   // server parses a bounded amount per call: ask again until complete
  };
  function chipLabel(agents) {
    const run = agents.filter(a => a.running).length;
    return run ? { t: '◇ ' + run + ' running', run: true } : { t: '◇ ' + agents.length + ' agent' + (agents.length === 1 ? '' : 's'), run: false };
  }
  function paintChips(name) {
    for (const c of CHIPS) {
      if (c.name !== name) continue;
      const ag = (DATA.get(name)?.j?.agents) || [];
      if (!ag.length) { c.el.style.display = 'none'; continue; }
      const l = chipLabel(ag); c.el.style.display = ''; c.el.textContent = l.t; c.el.classList.toggle('sa-run', l.run);
      c.el.title = ag.length + ' subagent' + (ag.length === 1 ? '' : 's') + ' in this session · ' + money(ag.reduce((s, a) => s + a.cost, 0)) + ' API-equivalent';
    }
  }
  let ticker = null;
  function tick() {
    for (const c of [...CHIPS]) if (!c.el.isConnected && Date.now() - c.born > 3000) CHIPS.delete(c);
    if (!CHIPS.size) { clearInterval(ticker); ticker = null; return; }
    if (document.hidden) return;
    for (const n of new Set([...CHIPS].map(c => c.name))) fetchAgents(n);
  }

  function chatBar(name) {
    const el = h('button', { class: 'btn sm sa-chip', style: 'display:none', onclick: () => sheet(name) });
    const c = { el, name, born: Date.now() }; CHIPS.add(c);
    const e = DATA.get(name); if (e && e.j) paintChips(name);
    if (!e || !e.at || Date.now() - e.at > 3000) setTimeout(() => { if (el.isConnected) fetchAgents(name); }, 0);
    if (!ticker) ticker = setInterval(tick, 5000);
    return el;
  }

  function sessMenu(name, sess, cl) {
    if (!cl) return null;
    const count = () => { const ag = DATA.get(name)?.j?.agents; return !ag ? '' : !ag.length ? 'none yet' : chipLabel(ag).t.slice(2); };
    const sub = h('span', { class: 'c' }, count());
    fetchAgents(name).then(() => { sub.textContent = count(); });
    return { el: h('div', { class: 'mi', title: 'subagents of this session, with their cost', onclick: () => { closeMenu(); sheet(name); } }, h('span', { class: 'ico' }, ico('diamond', 15)), h('span', { class: 'k' }, 'Subagents'), sub) };
  }

  // ---- the sheet ------------------------------------------------------------------------------------------
  function sheet(name, agentId) {
    const m = $('#modal'); m.classList.remove('hidden');
    const st = { agent: null, timer: null };
    let box = null; const owns = () => box && m.firstChild === box && !m.classList.contains('hidden');
    const cleanup = () => { clearInterval(st.timer); document.removeEventListener('keydown', esc, true); if (m.onclick === onOut) m.onclick = null; };
    const close = () => { const mine = owns(); cleanup(); if (mine) m.classList.add('hidden'); };
    const esc = e => { if (!owns()) return cleanup(); if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (st.agent) { st.agent = null; draw(); } else close(); } };
    const onOut = e => { if (e.target === m) close(); };
    document.addEventListener('keydown', esc, true);
    const title = h('h3', null, gl('◇ Subagents'));
    const back = h('button', { class: 'btn sm ghost', onclick: () => { st.agent = null; draw(); } }, '← all');
    const body = h('div', { class: 'sa-body' });
    box = h('div', { class: 'box sa-box' }, h('div', { class: 'sa-head' }, back, title, h('span', { class: 'sa-sp' }), h('span', { class: 'dim mono sa-sess' }, name), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: close }, ico('x', 15))), body);
    m.replaceChildren(box); m.onclick = onOut;
    let list = (DATA.get(name)?.j?.agents) || null; let detail = null; let want = agentId || null;

    function drawList() {
      const ag = list || [];
      title.replaceChildren(...gl('◇ Subagents' + (ag.length ? ' · ' + ag.length : '')));
      if (list == null) return body.replaceChildren(h('div', { class: 'sa-empty dim' }, 'Loading…'));
      if (!ag.length) return body.replaceChildren(h('div', { class: 'sa-empty dim' }, 'No subagents in this session yet.'));
      const total = ag.reduce((s, a) => s + a.cost, 0);
      const rows = ag.slice().reverse().map(a => h('button', { class: 'sa-row' + (a.running ? ' sa-run' : ''), onclick: () => { st.agent = a; detail = null; draw(); } },
        h('div', { class: 'sa-r1' }, h('span', { class: 'sa-type' }, a.type), modelBadge(a), a.running ? h('span', { class: 'sa-live' }, 'running') : null, a.background ? h('span', { class: 'sa-bg dim' }, 'bg') : null, h('span', { class: 'sa-sp' }), h('span', { class: 'mono sa-cost' }, money(a.cost))),
        h('div', { class: 'sa-desc' }, a.description || '(no description)'),
        h('div', { class: 'sa-r3 dim mono' }, agentDur(a), ' · ', a.tools + ' tool' + (a.tools === 1 ? '' : 's'), ' · ', tok(a.tokens.out) + ' out', ' · ', ago(a.startedAt) + ' ago'),
        a.flag ? h('div', { class: 'sa-flag' }, gl('⚠ ' + a.flag, 12)) : null));
      body.replaceChildren(h('div', { class: 'sa-sum dim mono' }, ag.filter(a => a.running).length + ' running · ' + money(total) + ' API-equivalent'), ...rows);
    }
    function drawDetail() {
      const a = st.agent; title.replaceChildren(...gl('◇ ' + a.type));
      const head = h('div', { class: 'sa-dh' }, modelBadge(a), a.running ? h('span', { class: 'sa-live' }, 'running') : null, h('span', { class: 'mono dim' }, agentDur(a) + ' · ' + money(a.cost) + ' · ' + a.tools + ' tools'), h('div', { class: 'sa-desc', style: 'flex-basis:100%' }, a.description || ''), a.flag ? h('div', { class: 'sa-flag', style: 'flex-basis:100%' }, '⚠ ' + a.flag) : null);
      if (!detail) return body.replaceChildren(head, h('div', { class: 'sa-empty dim' }, 'Loading…'));
      if (detail.error) return body.replaceChildren(head, h('div', { class: 'sa-empty dim' }, detail.error));
      const steps = detail.steps.map(s => s.k === 'text' ? h('div', { class: 'sa-step sa-st-text ttext', html: mdLite(s.text) }) : h('div', { class: 'sa-step sa-st-tool mono' }, h('b', null, s.name), ' ', s.summary));
      const open = body.querySelector('.sa-prompt')?.open;
      body.replaceChildren(head,
        h('details', { class: 'sa-prompt', open: open || null }, h('summary', null, 'prompt'), h('pre', { class: 'sa-pre' }, detail.prompt || '')),
        h('div', { class: 'sa-h' }, 'steps' + (detail.steps.length >= 60 ? ' (last 60)' : '')),
        h('div', { class: 'sa-steps' }, ...steps),
        detail.result ? h('div', { class: 'sa-h' }, 'result') : null,
        detail.result ? h('div', { class: 'sa-result ttext', html: mdLite(detail.result) }) : null);
    }
    function draw() {
      back.style.display = st.agent ? '' : 'none';
      const sc = body.scrollTop; const bottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      if (st.agent) drawDetail(); else drawList();
      body.scrollTop = st.agent && bottom && detail ? body.scrollHeight : sc;
    }
    async function refresh() {
      if (!owns()) return cleanup();
      try { await fetchAgents(name); list = DATA.get(name)?.j?.agents || []; } catch {}
      if (want && !st.agent) { st.agent = list.find(a => a.agentId === want) || null; want = null; }
      if (st.agent) {
        const fresh = list.find(a => a.agentId === st.agent.agentId); if (fresh) st.agent = fresh;
        const id = st.agent.agentId;
        try { const d = await api('subagents/' + encodeURIComponent(name) + '?agent=' + encodeURIComponent(id)); if (st.agent && st.agent.agentId === id) detail = d; } catch (e) { if (st.agent && st.agent.agentId === id) detail = { error: e.message }; }
      }
      if (owns()) draw(); else cleanup();
    }
    draw(); refresh(); st.timer = setInterval(refresh, 4000);
  }

  // ---- Home tile: cost by model -----------------------------------------------------------------------------
  const T = { el: null, models: null, flagged: [], at: 0, busy: false, sig: '' };
  async function loadTile() {
    if (T.busy) return; T.busy = true;
    try {
      T.models = await api('usage/models?days=7');
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0); const flagged = [];
      // one session at a time, and only the ones that can be running subagents (+ the open chat), so a restart does not fan out to every session
      const BUSY = new Set(['working', 'background', 'needs-you', 'permission']);
      const names = (S.runtime.sessions || []).filter(s => s.claude && (BUSY.has(s.claude.state) || s.name === (typeof TERM !== 'undefined' && TERM.active))).map(s => s.name);
      for (const n of names) {
        try {
          let j = await api('subagents/' + encodeURIComponent(n));
          for (let i = 0; j.partial && i < 40; i++) { await new Promise(r => setTimeout(r, 150)); j = await api('subagents/' + encodeURIComponent(n)); }
          for (const a of j.agents) if (a.flag && a.startedAt >= midnight.getTime()) flagged.push({ ...a, session: n });
        } catch {}
      }
      flagged.sort((x, y) => y.startedAt - x.startedAt); T.flagged = flagged;
    } catch {} finally { T.busy = false; T.at = Date.now(); paintTile(); if (typeof renderFeatHome === 'function') try { renderFeatHome(); } catch {} }
  }
  function stack(by, total, big) {
    const bar = h('div', { class: 'sa-stack' + (big ? ' sa-big' : '') });
    if (!(total > 0)) { bar.append(h('i', { class: 'sa-f-none', style: 'flex:1' })); return bar; }
    for (const f of FAMS) if (by[f] > 0) bar.append(h('i', { class: 'sa-bg-' + f, style: `flex:${by[f]}`, title: `${FAM_LABEL[f]} ${money(by[f])}` }));
    return bar;
  }
  const legend = by => h('div', { class: 'sa-legend' }, ...FAMS.filter(f => by[f] > 0).map(f => h('span', { class: 'sa-lg' }, h('i', { class: 'sa-bg-' + f }), FAM_LABEL[f] + ' ', h('b', { class: 'mono' }, money(by[f])))));
  // 7 days as a line: total per day (line + soft area), subagents as a thin second line; today gets a dot and its amount.
  // Drawn in a 100 x 40 box stretched to the tile (non-scaling strokes); dots, labels and hover targets are HTML on top.
  function lineChart(days) {
    const tot = days.map(d => FAMS.reduce((s, f) => s + d.byFamily[f], 0)); const sub = days.map(d => d.sub || 0);
    const max = Math.max(0.0001, ...tot) * 1.12; const n = days.length; const W = 100, H = 40;
    const X = i => n > 1 ? i / (n - 1) * W : W / 2, Y = v => H - v / max * H;
    const path = vs => vs.map((v, i) => i ? `C${(X(i - 1) + X(i)) / 2},${Y(vs[i - 1])} ${(X(i - 1) + X(i)) / 2},${Y(v)} ${X(i)},${Y(v)}` : `M${X(0)},${Y(v)}`).join(' ');
    const NS = 'http://www.w3.org/2000/svg'; const el = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
    const svg = el('svg', { class: 'sa-lsvg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const gid = 'sa-g' + Math.random().toString(36).slice(2, 7);
    const grad = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }); grad.append(el('stop', { offset: '0', class: 'sa-ga' }), el('stop', { offset: '1', class: 'sa-gb' }));
    const defs = el('defs', {}); defs.append(grad); svg.append(defs);
    for (const g of [0.25, 0.5, 0.75]) svg.append(el('line', { x1: 0, x2: W, y1: H * g, y2: H * g, class: 'sa-lgrid' }));
    svg.append(el('path', { d: path(tot) + ` L${W},${H} L0,${H} Z`, fill: `url(#${gid})`, class: 'sa-larea' }), el('path', { d: path(sub), class: 'sa-lsub' }), el('path', { d: path(tot), class: 'sa-ltot' }));
    const lbl = d => new Date(d.day + 'T12:00').toLocaleDateString([], { weekday: 'short' });
    const tip = (d, i) => `${new Date(d.day + 'T12:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })} · ${money(tot[i])}` + FAMS.filter(f => d.byFamily[f] > 0).map(f => `\n${FAM_LABEL[f]} ${money(d.byFamily[f])}`).join('') + (sub[i] ? `\nsubagents ${money(sub[i])}` : '');
    const pos = i => `left:${X(i)}%`;
    const top = v => `top:${Y(v) / H * 100}%`;
    const last = n - 1; const peak = tot.indexOf(Math.max(...tot));
    return h('div', { class: 'sa-line' },
      h('div', { class: 'sa-lplot' }, svg,
        h('i', { class: 'sa-ldot', style: `${pos(last)};${top(tot[last])}` }),
        h('span', { class: 'sa-lval' + (last > n * .8 ? ' end' : ''), style: `${pos(last)};${top(tot[last])}` }, money(tot[last])),
        peak !== last && tot[peak] > 0 ? h('span', { class: 'sa-lval peak', style: `${pos(peak)};${top(tot[peak])}` }, money(tot[peak])) : null,
        ...days.map((d, i) => h('span', { class: 'sa-lhit', style: pos(i), title: tip(d, i) }))),
      h('div', { class: 'sa-lx' }, ...days.map((d, i) => h('span', { class: 'sa-lday' + (i === last ? ' on' : ''), style: pos(i) }, i === last ? 'Today' : lbl(d)))),
      h('div', { class: 'sa-legend' }, h('span', { class: 'sa-lg' }, h('i', { class: 'sa-lk tot' }), 'All models'), h('span', { class: 'sa-lg' }, h('i', { class: 'sa-lk sub' }), 'Subagents')));
  }
  function paintTile() {
    const el = T.el; const M = T.models; if (!el || !M) return;
    const sig = JSON.stringify([M, T.flagged.map(a => a.agentId)]);
    if (sig === T.sig) return; T.sig = sig;
    const today = M.days[M.days.length - 1]; const tTot = FAMS.reduce((s, f) => s + today.byFamily[f], 0); const wTot = FAMS.reduce((s, f) => s + M.totals.byFamily[f], 0);
    el.replaceChildren(...[
      h('div', { class: 'k' }, h('span', null, 'Cost by model'), h('span', { class: 'dim sa-note' }, 'API-equivalent')),
      h('div', { class: 'sa-grid' },
        h('div', { class: 'sa-part' },
          h('div', { class: 'sa-lbl' }, 'Today ', h('b', { class: 'mono' }, money(tTot))), stack(today.byFamily, tTot, true), legend(today.byFamily),
          h('div', { class: 'sa-lbl', style: 'margin-top:10px' }, '7 days ', h('b', { class: 'mono' }, money(wTot))), stack(M.totals.byFamily, wTot, true), legend(M.totals.byFamily)),
        h('div', { class: 'sa-part' },
          lineChart(M.days))),
      T.flagged.length ? h('div', { class: 'sa-fl' }, h('div', { class: 'sa-lbl' }, gl('⚠ Flagged today', 12)), ...T.flagged.slice(0, 5).map(a => h('div', { class: 'sa-flrow' }, h('span', { class: 'sa-flag' }, a.flag), h('span', { class: 'dim sa-fld' }, (a.description || a.type) + ' · ' + a.session), h('b', { class: 'mono' }, money(a.cost))))) : null].filter(Boolean));
  }
  function homeTiles() {
    if (!T.el) T.el = h('div', { class: 'tile sa-tile' });
    if (!document.hidden && Date.now() - T.at > 60000) loadTile();
    return T.models ? T.el : null;
  }

  // ?subagents=<tmux name>[&agent=<id>] or &chip=1: opens that chat with the sheet on top (screenshots / tests)
  function deepLink(q) {
    const n = q.get('subagents'); if (!n) return false;
    history.replaceState(null, '', location.pathname);
    openTerm(n);
    if (q.get('chip')) setTimeout(() => { const sc = document.querySelector('.cscroll'); if (sc) sc.scrollTop = 0; }, 3500);   // &chip=1: show the chat bar (screenshots)
    else setTimeout(() => sheet(n, q.get('agent')), 2500);
    return true;
  }

  FEAT.subagents = { chatBar, sessMenu, homeTiles, deepLink };
})();
