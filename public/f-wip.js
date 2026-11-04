'use strict';
FEAT.wip = (() => {
  const FKEY = 'bd.wip.filter';
  let filter = localStorage.getItem(FKEY) || 'all';
  let lastKey = '';

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const wipOf = () => S.wip || { roots: [], groups: [] };
  const sessOf = name => S.runtime.sessions.find(s => s.name === name) || null;
  const pending = r => r.staged + r.unstaged + r.untracked + r.conflicts;

  function orgAccounts() {
    const P = byId(); const votes = {};
    for (const s of S.runtime.sessions) {
      const cl = s.claude; if (!cl || !cl.account) continue;
      const org = P[s.project]?.org; if (!org) continue;
      const v = votes[org] || (votes[org] = { personal: 0, company: 0 }); v[cl.account]++;
    }
    return (org, fb = 'personal') => { const v = votes[org]; if (v && v.company !== v.personal) return v.company > v.personal ? 'company' : 'personal'; const set = (S.settings?.orgAccounts || {})[org]; return set === 'company' || set === 'personal' ? set : fb; };
  }

  function matches(r, acc) {
    if (filter === 'live') return r.live.length > 0;
    if (filter === 'personal' || filter === 'company') return acc(r.org) === filter;
    return true;
  }

  function setName(id) {
    const P = byId(); const p = P[id];
    if (p) return p.setName || p.name;
    const m = S.projects.find(x => x.set === id); return m ? m.setName || m.name : id;
  }
  function shortName(r, set) {
    const pre = set ? set.toLowerCase() + '-' : '';
    const n = r.name || r.project;
    return pre && n.toLowerCase().startsWith(pre) && n.length > pre.length ? n.slice(pre.length) : n;
  }

  function openRoot(r) {
    if (FEAT.code && FEAT.code.open) return FEAT.code.open({ root: r.id });
    openDrawer(r.project, r.worktree ? 'worktrees' : 'changes');
  }
  function openSet(set, ids) {
    if (FEAT.code && FEAT.code.open) return FEAT.code.open({ set, roots: ids });
    const P = byId(); openDrawer(P[set] ? set : ids[0], 'changes');
  }

  function addToChat(ev, q, label) {
    const live = S.runtime.sessions.filter(s => s.claude && !['ended'].includes(s.claude.state));
    if (!live.length) { toast('No live Claude session to add it to', 'err'); return; }
    openMenu(ev, [{ header: 'Add work in progress to…' }, ...live.map(s => ({
      label: s.claude.label || chatTitle(s.claude) || s.name, sub: s.name, icon: '✦',
      onclick: async () => {
        try {
          const { text } = await api('wip-brief?' + q);
          FEAT.wip.insertDraft(s.name, text);
          openTerm(s.name);
          toast(label + ' added to the draft — review and send');
        } catch (e) { toast('brief failed: ' + e.message, 'err'); }
      },
    }))]);
  }

  function insertDraft(name, text) {
    const block = text.trim() + '\n\n';
    const ta = TERM.open && TERM.active === name ? document.querySelector('.creply') : null;
    if (ta) { ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n\n') : '') + block; ta.dispatchEvent(new Event('input', { bubbles: true })); saveDraft(name, ta.value); return; }
    const cur = loadDraft(name);
    saveDraft(name, (cur ? cur.replace(/\s*$/, '\n\n') : '') + block);
  }

  function rowMenu(ev, r) {
    ev.stopPropagation();
    openMenu(ev, [
      { label: 'Open changes', icon: '±', onclick: () => openRoot(r) },
      { label: 'Add to chat…', sub: 'work-in-progress brief into a session draft', icon: '✦', onclick: () => addToChat(ev, 'root=' + encodeURIComponent(r.id), r.name) },
      { label: 'Project details', icon: 'ⓘ', onclick: () => openDrawer(r.project, 'overview') },
      r.worktree ? { label: 'Worktrees of ' + r.name, icon: '⎇', onclick: () => openDrawer(r.project, 'worktrees') } : null,
    ].filter(Boolean));
  }
  function setMenu(ev, set, ids, title) {
    ev.stopPropagation();
    openMenu(ev, [
      { label: 'Open ' + title, icon: '±', onclick: () => openSet(set, ids) },
      { label: 'Add to chat…', sub: 'brief of every repo in the set', icon: '✦', onclick: () => addToChat(ev, 'set=' + encodeURIComponent(set), title) },
    ]);
  }

  function liveDots(r) {
    if (!r.live.length) return null;
    return h('span', { class: 'wlive' }, r.live.map(name => {
      const s = sessOf(name); const st = s?.claude?.state || 'unknown';
      return h('button', { class: 'wdot st-' + st, title: (s?.claude?.label || name) + ' · ' + (STATE_LABEL[st] || st) + ' — open', onclick: ev => { ev.stopPropagation(); openTerm(name); } });
    }));
  }

  const FLAG = {
    env: ['secret', 'a .env / key / credentials file has pending changes'],
    big: ['big', 'more than 1500 changed lines'],
    detached: ['detached', 'HEAD is detached'],
    'no-upstream': ['local branch', 'branch has no upstream — not pushed anywhere'],
  };

  function row(r, set) {
    const n = pending(r);
    const stale = r.flags.includes('stale');
    const flags = r.flags.filter(f => FLAG[f]).map(f => h('span', { class: 'wflag f-' + f, title: FLAG[f][1] }, FLAG[f][0]));
    const ed = r.editors || [];
    return h('div', { class: 'wr' + (r.live.length ? ' live' : ''), role: 'button', tabindex: '0', title: r.path, onclick: () => openRoot(r), onkeydown: ev => { if (ev.key === 'Enter') openRoot(r); } },
      h('div', { class: 'wr1' },
        h('b', { class: 'wn' }, shortName(r, set)),
        r.worktree ? h('span', { class: 'wwt', title: 'git worktree · ' + r.path }, ico('branch', 12)) : null,
        h('span', { class: 'wbr', title: r.upstream ? 'tracks ' + r.upstream : 'no upstream' }, r.branch || '?'),
        h('span', { class: 'wsp' }),
        liveDots(r),
        h('button', { class: 'wmore', title: 'more', 'aria-label': 'more', onclick: ev => rowMenu(ev, r) }, ico('dots', 16))),
      h('div', { class: 'wr2' },
        r.staged ? h('span', { class: 'wc s', title: r.staged + ' staged' }, 'S ' + r.staged) : null,
        r.unstaged ? h('span', { class: 'wc m', title: r.unstaged + ' modified, not staged' }, 'M ' + r.unstaged) : null,
        r.untracked ? h('span', { class: 'wc u', title: r.untracked + ' untracked' }, 'U ' + r.untracked) : null,
        r.conflicts ? h('span', { class: 'wc x', title: r.conflicts + ' conflicted' }, '! ' + r.conflicts) : null,
        r.add || r.del ? h('span', { class: 'wl' }, h('i', { class: 'a' }, '+' + r.add), ' ', h('i', { class: 'd' }, '−' + r.del)) : null,
        r.ahead ? h('span', { class: 'wa hot', title: r.ahead + ' commit(s) not pushed' }, ico('arrowUp', 11), r.ahead) : null,
        r.behind ? h('span', { class: 'wa', title: r.behind + ' behind ' + (r.upstream || '') }, ico('arrowDown', 11), r.behind) : null,
        r.op ? h('span', { class: 'wop', title: r.op + ' in progress' }, r.op) : null,
        r.stashes ? h('span', { class: 'wstash', title: plural(r.stashes, 'stash') }, ico('archive', 11), r.stashes) : null,
        ...flags,
        !n && !r.ahead && !r.op ? h('span', { class: 'dim' }, 'clean') : null,
        h('span', { class: 'wsp' }),
        r.oldest && n ? h('span', { class: 'wage' + (stale ? ' stale' : ''), title: 'oldest pending change ' + new Date(r.oldest).toLocaleString() + (r.newest ? ' · newest ' + ago(r.newest) + ' ago' : '') }, ago(r.oldest)) : null),
      ed.length ? h('div', { class: 'wr3', title: ed.map(e => (e.label || e.sessionId) + ' · ' + plural(e.files, 'file') + ' · ' + ago(e.at)).join('\n') },
        h('span', { class: 'wed' + (ed[0].live ? ' on' : '') }, ico('sparkle', 11), ' ', ed[0].label || 'session ' + ed[0].sessionId.slice(0, 8)), h('span', { class: 'dim' }, ' · ' + ago(ed[0].at)),
        ed.length > 1 ? h('span', { class: 'dim' }, ' · +' + (ed.length - 1)) : null) : null);
  }

  function totals(rs) {
    return { repos: rs.length, files: rs.reduce((a, r) => a + pending(r), 0), add: rs.reduce((a, r) => a + r.add, 0), del: rs.reduce((a, r) => a + r.del, 0), ahead: rs.reduce((a, r) => a + r.ahead, 0) };
  }
  const totText = t => [plural(t.repos, 'repo'), t.files ? plural(t.files, 'file') : null, t.ahead ? '↑' + t.ahead : null].filter(Boolean).join(' · ');

  function card(kind, key, title, icon, rs, set) {
    const t = totals(rs); const ids = rs.map(r => r.id);
    return h('div', { class: 'wcard k-' + kind },
      h('div', { class: 'wch', role: 'button', tabindex: '0', title: 'Open ' + title, onclick: () => kind === 'group' ? openSet(null, ids) : openSet(key, ids) },
        icon,
        h('b', { class: 'wct' }, title),
        h('span', { class: 'wcn' }, totText(t)),
        t.add || t.del ? h('span', { class: 'wl' }, h('i', { class: 'a' }, '+' + t.add), ' ', h('i', { class: 'd' }, '−' + t.del)) : null,
        h('span', { class: 'wsp' }),
        kind === 'set' ? h('button', { class: 'wmore', title: 'more', 'aria-label': 'more', onclick: ev => setMenu(ev, key, ids, title) }, ico('dots', 16)) : null),
      h('div', { class: 'wrows' }, rs.map(r => row(r, kind === 'set' ? title : null))));
  }

  function build() {
    const W = wipOf(); const acc = orgAccounts(); const P = byId();
    const all = W.roots;
    const shown = all.filter(r => matches(r, acc));
    const grouped = new Map();
    for (const g of W.groups || []) for (const id of g.roots) grouped.set(id, g.branch);
    const t = totals(all.filter(r => pending(r) || r.ahead || r.op));
    const counts = { all: all.length, personal: all.filter(r => acc(r.org) === 'personal').length, company: all.filter(r => acc(r.org) === 'company').length, live: all.filter(r => r.live.length).length };
    const chip = (k, label) => h('button', { class: 'chip' + (filter === k ? ' on' : ''), onclick: () => { filter = k; localStorage.setItem(FKEY, k); gKey = ''; render(); } }, label, counts[k] ? h('span', { class: 'n' }, counts[k]) : null);
    const head = h('div', { class: 'tshead wip-head' },
      h('h2', { class: 'tstitle' }, 'Work in progress', h('span', { class: 'n' }, totText(t))),
      h('span', { class: 'wsp' }),
      h('div', { class: 'chips sm' }, chip('all', 'All'), chip('personal', 'Personal'), chip('company', 'Company'), chip('live', 'Live')));
    if (!shown.length) return [head, h('div', { class: 'tsempty' }, all.length ? 'Nothing here for this filter.' : (W.at ? 'Nothing pending — every repo is clean.' : 'Reading the repos…'))];
    const orgs = [...new Set(shown.map(r => r.org || ''))].sort((a, b) => (!a - !b) || a.localeCompare(b));
    const out = [head];
    for (const org of orgs) {
      const inOrg = shown.filter(r => (r.org || '') === org);
      const cards = [];
      const sets = [...new Set(inOrg.filter(r => !grouped.has(r.id)).map(r => r.set))];
      for (const set of sets) {
        const rs = inOrg.filter(r => r.set === set && !grouped.has(r.id));
        const avPid = P[set] ? set : rs[0].project;
        cards.push(card('set', set, setName(set), avatar(avPid, 'sm'), rs, set));
      }
      for (const g of W.groups || []) {
        const rs = inOrg.filter(r => grouped.get(r.id) === g.branch);
        if (!rs.length) continue;
        cards.push(card('group', g.branch, g.branch, h('span', { class: 'wgi', title: 'same branch checked out as a worktree in ' + plural(rs.length, 'repo') }, ico('branch', 12)), rs, null));
      }
      out.push(h('div', { class: 'worg', style: `--org:${orgColor(org)}` },
        org ? h('div', { class: 'worgh' }, h('i', null), org, h('span', { class: 'n' }, plural(inOrg.length, 'repo'))) : null,
        h('div', { class: 'wgrid' }, cards)));
    }
    return out;
  }

  function strip() {
    const W = wipOf();
    const act = W.roots.filter(r => pending(r) || r.ahead || r.op);
    const t = totals(act);
    const live = act.filter(r => r.live.length).length;
    const go = () => FEAT.code ? FEAT.code.open({ overview: true }) : null;
    return h('div', { class: 'wstrip', role: 'button', tabindex: '0', title: 'every repo with pending changes or unpushed commits — open in Code', onclick: go, onkeydown: e => { if (e.key === 'Enter') go(); } },
      h('span', { class: 'wstrip-ic' }, ico('code', 15)),
      h('b', null, 'Work in progress'),
      h('span', { class: 'wstrip-n' }, act.length ? totText(t) : W.at ? 'every repo is clean' : 'reading the repos…'),
      live ? h('span', { class: 'wstrip-l' }, h('i'), plural(live, 'repo') + ' with a live session') : null,
      h('span', { class: 'wsp' }),
      h('span', { class: 'wstrip-go' }, 'Open in Code', ico('ext', 13)));
  }

  function onState() {
    const el = document.getElementById('wip-sec'); if (!el) return;
    if (UI.view !== 'home') return;
    const W = wipOf();
    const key = JSON.stringify(['strip', W.at ? 1 : 0, W.roots.map(r => [pending(r), r.ahead, r.op, r.live.length])]);
    if (key === lastKey) return; lastKey = key;
    el.replaceChildren(strip());
  }

  let gHost = null, gKey = '';
  function grid(host) {
    const W = wipOf();
    const states = W.roots.flatMap(r => r.live.map(n => [n, sessOf(n)?.claude?.state, sessOf(n)?.claude?.label]));
    const key = JSON.stringify([W, filter, states, Math.floor(Date.now() / 60000), S.projects.length]);
    if (host === gHost && key === gKey && host.childElementCount) return;
    gHost = host; gKey = key;
    host.replaceChildren(...build());
  }

  return { onState, insertDraft, grid, orgAccount: org => orgAccounts()(org, null) };
})();
