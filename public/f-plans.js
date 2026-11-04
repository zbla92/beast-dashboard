'use strict';
// F1 plans & progress. Registers FEAT.plans. Read-only: shows docs/<topic>/PLAN.md + PROGRESS.md per project.
(() => {
  const TAB = 'plan';
  let DATA = {};            // /api/plans: { projectId: [{ topic, done, total, next, mtime }] }
  let loaded = false, sig = '', busy = false;
  const PICK = {};          // projectId -> chosen topic (this page load)
  const DET = {};           // projectId|topic -> last detail (shown instantly, refreshed on every render)
  const OPEN = { plan: false, files: {} };   // collapsible state, kept across re-renders

  const pct = (d, t) => t ? Math.round(d * 100 / t) : 0;
  const bar = (d, t, cls = '') => h('div', { class: 'fp-bar ' + cls + (t && d >= t ? ' full' : '') }, h('i', { style: `width:${pct(d, t)}%` }));
  const topics = pid => DATA[pid] || [];
  const curTopic = pid => { const l = topics(pid); const want = PICK[pid]; return l.find(x => x.topic === want) || l[0] || null; };

  async function load() {
    if (busy) return; busy = true;
    try {
      const d = await api('plans');
      const s = JSON.stringify(d);
      const first = !loaded; loaded = true;
      if (s !== sig) {
        sig = s; DATA = d;
        if (typeof render === 'function') render();
        if (UI.drawer && UI.tab === TAB) renderDrawer(true);
      } else if (first && UI.drawer && UI.tab === TAB) renderDrawer(true);
    } catch (e) { /* offline or server restarting: keep what we have */ }
    busy = false;
  }
  load();
  setInterval(load, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  // ---- card chip ----
  function cardChips(p) {
    const l = topics(p.id); if (!l.length) return null;
    const t = l[0];   // summary is ordered most recently changed first
    return h('button', { class: 'fp-chip' + (t.total && t.done >= t.total ? ' done' : ''), title: `${t.topic}${t.total ? ` ${t.done}/${t.total}` : ''}${t.next ? ' — next: ' + t.next : ''}`, onclick: ev => { ev.stopPropagation(); PICK[p.id] = t.topic; openDrawer(p.id, TAB); } },
      h('span', { class: 'fp-chip-top' }, h('span', { class: 'fp-ck' }, ico('checkSquare', 13)), h('span', { class: 'fp-chip-t' }, t.topic), t.total ? h('span', { class: 'fp-chip-n' }, `${t.done}/${t.total}`) : null, l.length > 1 ? h('span', { class: 'fp-chip-more' }, '+' + (l.length - 1)) : null),
      t.total ? bar(t.done, t.total) : null);
  }

  // ---- drawer tab ----
  function drawerTabs(p) {
    if (!topics(p.id).length) return null;
    return [{ key: TAB, label: 'Plan', render: renderTab }];
  }

  function renderTab(el, p) {
    const sum = curTopic(p.id); if (!sum) { el.append(h('div', { class: 'dim' }, 'No plan in this project.')); return; }
    PICK[p.id] = sum.topic;
    const root = h('div', { class: 'fp-tab' });
    el.append(root);
    const key = p.id + '|' + sum.topic;
    const paint = d => {
      if (!root.isConnected && !el.contains(root)) return;
      root.replaceChildren(...body(p, sum, d));
    };
    if (DET[key]) paint(DET[key]); else root.append(h('div', { class: 'dim' }, 'loading…'));
    api(`plan/${p.id}?topic=${encodeURIComponent(sum.topic)}`).then(d => {
      const old = DET[key]; DET[key] = d;
      if (UI.drawer !== p.id || UI.tab !== TAB || PICK[p.id] !== sum.topic) return;
      if (!old || old.mtime !== d.mtime) paint(d);
    }).catch(e => { if (!DET[key]) root.replaceChildren(h('div', { class: 'fp-err' }, 'Could not load plan: ' + e.message)); });
  }

  function body(p, sum, d) {
    const out = [];
    const l = topics(p.id);
    if (l.length > 1) {
      out.push(h('div', { class: 'fp-picker' }, l.map(t => h('button', { class: 'fp-pick' + (t.topic === sum.topic ? ' on' : ''), onclick: () => { PICK[p.id] = t.topic; renderDrawer(true); } },
        t.topic, t.total ? h('span', { class: 'fp-pn' }, `${t.done}/${t.total}`) : null))));
    } else out.push(h('div', { class: 'fp-topic' }, 'docs/' + sum.topic + '/'));
    const pr = d.progress;
    if (pr && pr.total) {
      out.push(h('div', { class: 'fp-head' }, h('b', null, `${pr.done}/${pr.total}`), h('span', { class: 'fp-pct' }, pct(pr.done, pr.total) + ' %'), h('span', { class: 'fp-ago' }, 'changed ' + ago(d.mtime))));
      out.push(bar(pr.done, pr.total, 'big'));
      const next = pr.items.find(i => !i.done);
      if (next) out.push(h('div', { class: 'fp-next' }, h('span', null, 'Next'), next.text));
      else out.push(h('div', { class: 'fp-next fp-alldone' }, 'All items checked'));
      out.push(h('h4', null, 'Checklist'));
      out.push(checklist(pr.items, next));
    } else if (pr) out.push(h('div', { class: 'dim' }, 'PROGRESS.md has no checkboxes.'));
    else out.push(h('div', { class: 'dim' }, 'No PROGRESS.md in this plan.'));
    if (d.plan) {
      const det = h('details', { class: 'fp-sec', open: OPEN.plan }, h('summary', null, 'PLAN.md'), h('div', { class: 'ttext fp-md', html: mdLite(d.plan.text) }));
      det.addEventListener('toggle', () => { OPEN.plan = det.open; });
      out.push(det);
    }
    if (d.files && d.files.length) {
      out.push(h('h4', null, 'Other docs'));
      const wrap = h('div', { class: 'fp-docs' });
      for (const f of d.files) wrap.append(docRow(p, sum.topic, f));
      out.push(wrap);
    }
    return out;
  }

  function checklist(items, next) {
    const groups = []; const idx = new Map();
    for (const it of items) { const k = it.section || ''; if (!idx.has(k)) { const g = { name: k, items: [] }; idx.set(k, g); groups.push(g); } idx.get(k).items.push(it); }
    const wrap = h('div', { class: 'fp-list' });
    const mk = it => h('div', { class: 'fp-item' + (it.done ? ' done' : '') + (it === next ? ' next' : ''), style: it.depth ? `margin-left:${Math.min(it.depth, 4) * 16}px` : null },
      h('span', { class: 'fp-box' }, it.done ? ico('check', 12) : ''), h('span', { class: 'fp-it' }, it.text));
    if (groups.length === 1 && !groups[0].name) { wrap.append(...groups[0].items.map(mk)); return wrap; }
    for (const g of groups) {
      const dn = g.items.filter(i => i.done).length; const all = dn === g.items.length;
      const hasNext = g.items.includes(next);
      wrap.append(h('details', { class: 'fp-grp', open: !all || hasNext },
        h('summary', null, h('span', { class: 'fp-gn' }, g.name || 'Other'), h('span', { class: 'fp-gc' + (all ? ' ok' : '') }, `${dn}/${g.items.length}`)),
        g.items.map(mk)));
    }
    return wrap;
  }

  function docRow(p, topic, rel) {
    const k = p.id + '|' + topic + '|' + rel;
    const view = h('div', { class: 'fp-docbody hidden' });
    const row = h('div', { class: 'fp-doc' });
    const head = h('button', { class: 'fp-dochead', onclick: async () => {
      const open = view.classList.contains('hidden');
      view.classList.toggle('hidden', !open); OPEN.files[k] = open; row.classList.toggle('open', open);
      if (open && !view.dataset.loaded) {
        view.textContent = 'loading…';
        try { const r = await api(`plan/${p.id}?topic=${encodeURIComponent(topic)}&file=${encodeURIComponent(rel)}`); view.dataset.loaded = '1'; view.replaceChildren(h('div', { class: 'ttext fp-md', html: mdLite(r.text) })); }
        catch (e) { view.replaceChildren(h('div', { class: 'fp-err' }, e.message)); }
      }
    } }, h('span', { class: 'fp-caret' }, '›'), h('span', { class: 'fp-fn' }, rel));
    row.append(head, view);
    if (OPEN.files[k]) head.click();
    return row;
  }

  // ---- palette ----
  function paletteItems() {
    const by = typeof byId === 'function' ? byId() : {};
    const out = [];
    for (const [pid, l] of Object.entries(DATA)) {
      const p = by[pid]; if (!p) continue;
      for (const t of l) out.push({ kind: 'action', label: `Plan: ${p.name} · ${t.topic}`, sub: t.total ? `${t.done}/${t.total}${t.next ? ' · next: ' + t.next : ''}` : 'no checklist', icon: '☑', hay: `plan progress ${p.name} ${t.topic}`, rank: 35, run: () => { PICK[pid] = t.topic; openDrawer(pid, TAB); } });
    }
    return out;
  }

  FEAT.plans = { cardChips, drawerTabs, paletteItems };
})();
