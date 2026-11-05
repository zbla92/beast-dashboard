'use strict';
// F2: git worktrees. Card chip "⎇ N" + drawer tab "Worktrees".
// Local git only: nothing here fetches, pulls or pushes.
FEAT.worktrees = (() => {
  const KEY = 'worktrees';
  let sum = {};            // { [projectId]: { count, dirty, stale } } from /api/worktrees
  let loaded = false, sumJson = '';
  let busy = false;

  async function load() {
    if (busy) return; busy = true;
    try {
      const d = await api('worktrees');
      const j = JSON.stringify(d);
      const first = !loaded; loaded = true;
      if (j !== sumJson) {
        sumJson = j; sum = d;
        if (typeof render === 'function') render();
        if (UI.drawer && UI.tab === KEY) renderDrawer(true);
      } else if (first && UI.drawer && UI.tab === KEY) renderDrawer(true);
    } catch { /* offline / server restarting: keep what we have */ }
    finally { busy = false; }
  }
  load();
  setInterval(load, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  // POST that keeps the structured error (api() would drop `conflicts`)
  async function post(path, body) {
    const r = await fetch('/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || r.statusText); e.conflicts = j.conflicts; throw e; }
    return j;
  }

  const isDirty = w => (w.dirty || 0) + (w.untracked || 0) > 0;
  const isStale = w => w.prunable || (!w.sessions.length && !isDirty(w) && !w.active && !w.agentBusy && w.merged);
  const ACTIVE_MIN = 30, TAB_TTL = 15000;
  const cache = {};        // projectId -> { d, at, p: in-flight promise }
  const uiState = new Map();   // projectId|path -> { diff: {html}|null, panel: {force, delB}|null }  survives re-renders
  const stOf = (pid, path) => { const k = pid + '|' + path; let v = uiState.get(k); if (!v) uiState.set(k, v = { diff: null, panel: null }); return v; }

  function cardChips(p) {
    const s = sum[p.id]; if (!s || !s.count) return null;
    const cls = 'wtx-chip' + (s.dirty ? ' dirty' : s.stale >= s.count ? ' stale' : '');
    const tip = `${plural(s.count, 'extra worktree')}${s.dirty ? ` · ${s.dirty} with uncommitted changes` : ''}${s.stale ? ` · ${s.stale} stale (merged, no session)` : ''}`;
    return h('button', { class: cls, title: tip, onclick: () => openDrawer(p.id, KEY) }, h('span', { class: 'ico' }, ico('branch', 13)), String(s.count));
  }

  async function getList(pid) {
    const cur = cache[pid] || (cache[pid] = { d: null, at: 0, p: null });
    if (cur.d && Date.now() - cur.at < TAB_TTL) return cur.d;
    if (!cur.p) cur.p = (async () => {
      try { cur.d = await api(`worktrees/${pid}`); cur.at = Date.now(); cur.err = null; } catch (e) { cur.err = e.message; }
      finally { cur.p = null; }
    })();
    await cur.p;
    return cur.d;
  }

  const CAN_HOVER = matchMedia('(hover: hover)').matches;
  function pickerChip(p) {
    const s = sum[p.id]; if (!s || !s.count) return null;
    const pop = h('div', { class: 'wtx-pop hidden', onclick: ev => ev.stopPropagation() });
    let hideT = 0;
    const outside = ev => { if (!chip.isConnected) { hide(); return; } if (pop.contains(ev.target) || chip.contains(ev.target)) return; ev.stopPropagation(); ev.preventDefault(); hide(); };
    const onScroll = ev => { if (!chip.isConnected || !pop.contains(ev.target)) hide(); };
    const hide = () => {
      clearTimeout(hideT); pop.classList.add('hidden');
      document.removeEventListener('click', outside, true); document.removeEventListener('scroll', onScroll, true);
    };
    const later = () => { clearTimeout(hideT); hideT = setTimeout(hide, 220); };
    const rows = d => {
      const ws = d && d.worktrees || [];
      if (!ws.length) return [h('div', { class: 'dim' }, cache[p.id]?.err || 'No extra worktrees.')];
      return ws.map(w => h('div', { class: 'wtx-prow' },
        h('div', { class: 'wtx-pt' }, h('span', { class: 'ico' }, ico('branch', 13)), h('b', null, w.branch || ('HEAD@' + w.head)),
          h('span', { class: 'wtx-sp' }),
          isDirty(w) ? h('span', { class: 'wtx-pb warn' }, 'uncommitted') : null,
          w.sessions.length ? h('span', { class: 'wtx-pb live' }, plural(w.sessions.length, 'session')) : null,
          w.merged ? h('span', { class: 'wtx-pb mute' }, 'merged') : w.ahead ? h('span', { class: 'wtx-pb' }, ico('arrowUp', 11), w.ahead) : null),
        h('div', { class: 'wtx-pp mono', title: w.path }, w.path.split('/').slice(-2).join('/')),
        w.last ? h('div', { class: 'wtx-pl' }, w.last.subject, h('i', null, ' · ' + ago(w.last.ts))) : null));
    };
    const show = async () => {
      clearTimeout(hideT);
      const r = chip.getBoundingClientRect();
      pop.style.right = Math.max(8, innerWidth - r.right) + 'px';
      if (r.bottom < innerHeight * 0.55) { pop.style.top = (r.bottom + 6) + 'px'; pop.style.bottom = ''; }
      else { pop.style.bottom = (innerHeight - r.top + 6) + 'px'; pop.style.top = ''; }
      pop.classList.remove('hidden');
      document.addEventListener('click', outside, true); document.addEventListener('scroll', onScroll, true);
      if (!pop.childNodes.length) pop.append(h('div', { class: 'dim' }, 'loading…'));
      const d = await getList(p.id);
      if (pop.isConnected) pop.replaceChildren(h('div', { class: 'wtx-ph' }, `${p.name} · ${plural(s.count, 'worktree')}`), ...rows(d));
    };
    const chip = h('button', { class: 'wtx-chip' + (s.dirty ? ' dirty' : s.stale >= s.count ? ' stale' : ''),
      onclick: ev => { ev.stopPropagation(); pop.classList.contains('hidden') ? show() : hide(); },
      onmouseenter: () => { if (CAN_HOVER) show(); }, onmouseleave: () => { if (CAN_HOVER) later(); } },
      h('span', { class: 'ico' }, ico('branch', 13)), plural(s.count, 'worktree'));
    pop.onmouseenter = () => clearTimeout(hideT);
    pop.onmouseleave = () => { if (CAN_HOVER) later(); };
    return h('span', { class: 'wtx-pick' }, chip, pop);
  }

  function drawerTabs(p) {
    const s = sum[p.id]; if (!s || !s.count) return null;
    return [{ key: KEY, label: "Worktrees", render: tab }];
  }

  function paletteItems() {
    return S.projects.filter(p => sum[p.id]?.count).map(p => ({
      kind: 'action', label: `Worktrees: ${p.name}`, sub: plural(sum[p.id].count, 'extra worktree') + (sum[p.id].dirty ? ` · ${sum[p.id].dirty} dirty` : ''),
      icon: '⎇', hay: `worktrees worktree branches ${p.name}`, run: () => openDrawer(p.id, KEY), rank: 35,
    }));
  }

  // ---------- the tab ----------
  function tab(el, p) {
    const root = h('div', { class: 'wtx' }, h('div', { class: 'dim' }, 'loading…'));
    el.append(root);
    const c = cache[p.id];
    const refresh = async (force) => {
      const cur = cache[p.id] || (cache[p.id] = { d: null, at: 0, p: null });
      if (!cur.p) {
        cur.p = (async () => {
          try { cur.d = await api(`worktrees/${p.id}`); cur.at = Date.now(); cur.err = null; } catch (e) { cur.err = e.message; }
          finally { cur.p = null; }
        })();
        load();   // keep the chip + counts in step
      }
      await cur.p;
      if (!root.isConnected) return;
      if (cur.d) paint(root, p, cur.d, refresh); else if (cur.err) root.replaceChildren(h('div', { class: 'dim' }, cur.err));
    };
    if (c && c.d) { paint(root, p, c.d, refresh); if (Date.now() - c.at > TAB_TTL) refresh(); }
    else refresh();
  }

  function paint(root, p, d, refresh) {
    const sig = JSON.stringify(d); if (root._sig === sig && root.childNodes.length > 1) return; root._sig = sig;
    const ws = d.worktrees || [];
    const prunable = ws.filter(w => w.prunable).length;
    const head = h('div', { class: 'wtx-head' },
      h('span', { class: 'wtx-base', title: 'worktrees are compared with this branch' }, 'base ', h('b', null, d.base || '?')),
      d.main ? h('span', { class: 'wtx-pill' + (d.main.dirty ? ' warn' : ' mute'), title: d.main.path }, `main checkout: ${d.main.branch || 'detached'}${d.main.dirty ? ` · ${d.main.dirty} uncommitted` : ''}`) : null,
      h('span', { class: 'wtx-sp' }),
      h('button', { class: 'btn sm', title: prunable ? `${plural(prunable, 'worktree')} whose folder is gone` : 'drop records of worktrees whose folder is gone', onclick: async () => {
        try { const r = await post('worktree-prune', { id: p.id }); toast('Prune\n' + (r.out || 'done').split('\n').slice(-3).join('\n'), 'ok'); } catch (e) { toast('Prune failed: ' + e.message, 'err'); }
        refresh(true);
      } }, 'Prune', prunable ? h('span', { class: 'wtx-n' }, prunable) : null),
      h('button', { class: 'btn sm', onclick: () => refresh(true) }, gl('↻ refresh')));
    root.replaceChildren(head, ...(ws.length ? ws.map(w => wcard(p, d, w, refresh)) : [h('div', { class: 'chclean' }, 'No extra worktrees in this repo.')]));
  }

  function wcard(p, d, w, refresh) {
    const stale = isStale(w);
    const st = stOf(p.id, w.path);
    const diffBox = h('div', { class: 'chdiff wtx-diff hidden', 'data-root': w.path });
    const panel = h('div', { class: 'wtx-panel hidden' });
    const run = async (label, fn) => {
      try { const r = await fn(); toast(label + (r?.out ? '\n' + r.out.split('\n').slice(-3).join('\n') : ''), 'ok'); }
      catch (e) { toast(label + ' failed: ' + e.message + (e.conflicts?.length ? '\n' + e.conflicts.slice(0, 6).join('\n') : ''), 'err'); }
      uiState.delete(p.id + '|' + w.path);
      if (cache[p.id]) cache[p.id].at = 0;
      refresh(true);
    };

    const sess = w.sessions.map(n => h('button', { class: 'lchip cl wtx-sess', title: 'open the terminal ' + n, onclick: () => openTerm(n) }, h('i', { class: 'd' }), w.claude && S.runtime.sessions.find(s => s.name === n)?.claude ? 'Claude' : 'shell', h('span', { class: 'wtx-sn' }, n)));

    const badges = [
      w.detached ? h('span', { class: 'wtx-pill mute' }, 'detached') : null,
      w.active ? h('span', { class: 'wtx-pill info', title: `files changed in the last ${ACTIVE_MIN} minutes: maybe an agent is working here` }, 'active') : null,
      w.locked ? h('span', { class: 'wtx-pill mute' }, gl('🔒 locked')) : null,
      w.prunable ? h('span', { class: 'wtx-pill hot', title: 'the folder no longer exists: use Prune' }, 'folder missing') : null,
      isDirty(w) ? h('span', { class: 'wtx-pill warn', title: `${w.dirty} modified, ${w.untracked} untracked` }, [ico('dot', 9), ` ${w.dirty + w.untracked} uncommitted`]) : null,
      w.merged ? h('span', { class: 'wtx-pill ok', title: 'the branch tip is in ' + d.base }, gl('✓ merged')) : (w.ahead ? h('span', { class: 'wtx-pill info' }, `${w.ahead} to merge`) : null),
      stale && !w.prunable ? h('span', { class: 'wtx-pill mute', title: 'merged, nothing running in it: safe to remove' }, 'stale') : null,
    ];

    const canMerge = !w.prunable && !w.detached && w.branch && w.ahead > 0 && !w.merged;
    const showDiff = (r) => {
      let html;
      if (r.error && !r.text) html = '<span class="dim" style="padding:0 12px">' + esc(r.error) + '</span>';
      else if (!r.text) html = '<span class="dim" style="padding:0 12px">Nothing to show: no commits beyond ' + esc(d.base || 'base') + ' and no uncommitted changes.</span>';
      else html = (r.error ? '<div class="dl meta">(' + esc(r.error) + ')</div>' : r.truncated ? '<div class="dl meta">(truncated at 600 KB)</div>' : '') + renderDiff(r.text);
      diffBox.innerHTML = html; st.diff = { html };
    };
    const diffBtn = h('button', { class: 'btn sm' + (st.diff ? ' on' : ''), onclick: async () => {
      if (!diffBox.classList.contains('hidden')) { diffBox.classList.add('hidden'); diffBtn.classList.remove('on'); st.diff = null; return; }
      diffBox.classList.remove('hidden'); diffBtn.classList.add('on'); diffBox.textContent = 'loading…'; st.diff = { html: null };
      try { showDiff(await api(`worktree-diff/${p.id}?path=${encodeURIComponent(w.path)}`)); }
      catch (e) { diffBox.textContent = e.message; st.diff = null; }
    } }, 'Diff');
    if (st.diff && st.diff.html != null) { diffBox.classList.remove('hidden'); diffBox.innerHTML = st.diff.html; }
    else if (st.diff) { st.diff = null; }

    const mergeBtn = h('button', { class: 'btn sm', disabled: !canMerge, title: canMerge ? `git merge ${w.branch} into ${d.base} (main checkout)` : w.merged ? 'already merged' : 'nothing to merge', onclick: () => {
      if (!confirm(`Merge ${w.branch} into ${d.base}?\n\nRuns "git merge --no-edit ${w.branch}" in the main checkout. On a conflict it is aborted. Nothing is pushed.`)) return;
      run(`Merged ${w.branch}`, () => post('worktree-merge', { id: p.id, path: w.path }));
    } }, 'Merge into ' + (d.base || 'base'));

    const openPanel = () => {
      const ps = st.panel || (st.panel = { force: false, delB: !!w.merged });
      const force = h('input', { type: 'checkbox', checked: ps.force });
      const delB = h('input', { type: 'checkbox', checked: ps.delB });
      const dirty = isDirty(w);
      const needForce = dirty || w.active || w.agentBusy;
      const go = h('button', { class: 'btn sm danger', disabled: needForce && !ps.force, onclick: () => {
        const msg = `Remove the worktree ${w.name}?\n${w.path}` + (force.checked ? '\n\nUncommitted changes will be DISCARDED.' : '') + (delB.checked ? `\n\nBranch ${w.branch} will be deleted${force.checked ? ' even if unmerged' : ' if it is merged'}.` : '');
        if (!confirm(msg)) return;
        run(`Removed ${w.name}`, () => post('worktree-remove', { id: p.id, path: w.path, force: force.checked, deleteBranch: delB.checked && !!w.branch }));
      } }, 'Remove');
      force.addEventListener('change', () => { ps.force = force.checked; go.disabled = needForce && !force.checked; });
      delB.addEventListener('change', () => { ps.delB = delB.checked; });
      panel.replaceChildren(...[
        w.sessions.length ? h('div', { class: 'wtx-warn' }, `A session is running here (${w.sessions.join(', ')}): stop it first, removal is refused.`) : null,
        (w.active || w.agentBusy) ? h('div', { class: 'wtx-warn' }, w.active ? `Files here changed in the last ${ACTIVE_MIN} minutes: maybe an agent is working in it. Tick force to remove it anyway.` : 'A Claude session in this repo is working; this worktree may belong to it. Tick force to remove it anyway.') : null,
        needForce ? h('label', { class: 'wtx-chk' }, force, h('span', null, dirty ? `force: discard ${w.dirty} modified and ${w.untracked} untracked file${w.dirty + w.untracked > 1 ? 's' : ''}` : 'force: remove even though it looks active')) : null,
        w.branch ? h('label', { class: 'wtx-chk' }, delB, h('span', null, w.merged ? `also delete branch ${w.branch} (merged)` : `also delete branch ${w.branch}` + (w.ahead ? ` (${plural(w.ahead, 'commit')} not merged: git keeps it unless forced)` : ''))) : null,
        h('div', { class: 'wtx-row' }, go, h('button', { class: 'btn sm', onclick: () => { st.panel = null; panel.classList.add('hidden'); } }, 'Cancel'))].filter(Boolean));
      panel.classList.remove('hidden');
    };
    const removeBtn = h('button', { class: 'btn sm danger', onclick: () => {
      if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); st.panel = null; return; }
      openPanel();
    } }, 'Remove');
    if (st.panel) openPanel();

    return h('div', { class: 'wtx-card' + (w.active ? ' active' : '') + (isDirty(w) ? ' dirty' : '') + (stale ? ' stale' : '') },
      h('div', { class: 'wtx-top' },
        h('span', { class: 'wtx-name' }, h('span', { class: 'ico' }, ico('branch', 13)), h('b', null, w.branch || ('HEAD@' + w.head))),
        h('span', { class: 'wtx-ab', title: `vs ${d.base}: ${w.ahead} ahead, ${w.behind} behind` }, w.ahead ? h('span', { class: 'up' }, ico('arrowUp', 11), w.ahead) : null, w.behind ? h('span', { class: 'dn' }, ico('arrowDown', 11), w.behind) : null, !w.ahead && !w.behind ? h('span', { class: 'dim' }, '=') : null),
        h('span', { class: 'wtx-sp' }), ...badges),
      h('div', { class: 'wtx-path mono', title: w.path }, w.path),
      h('div', { class: 'wtx-meta' },
        w.diffstat.files ? h('span', { class: 'wtx-stat', title: `${d.base}...${w.branch}, committed work only` }, `${plural(w.diffstat.files, 'file')} `, h('span', { class: 'chnum add' }, '+' + w.diffstat.ins), ' ', h('span', { class: 'chnum del' }, '−' + w.diffstat.del)) : h('span', { class: 'dim' }, 'no committed changes vs ' + (d.base || 'base')),
        w.last ? h('span', { class: 'wtx-last', title: w.last.subject }, w.last.subject, h('i', null, ' · ' + ago(w.last.ts))) : null),
      sess.length ? h('div', { class: 'wtx-sessions' }, sess) : null,
      h('div', { class: 'wtx-actions' }, diffBtn, mergeBtn, h('span', { class: 'wtx-sp' }), removeBtn),
      panel, diffBox);
  }

  return { cardChips, drawerTabs, paletteItems, pickerChip };
})();
