'use strict';
FEAT.wip = (() => {
  let lastKey = '';

  const wipOf = () => S.wip || { roots: [], groups: [] };
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

  function insertDraft(name, text) {
    const block = text.trim() + '\n\n';
    const ta = TERM.open && TERM.active === name ? document.querySelector('.creply') : null;
    if (ta) { ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n\n') : '') + block; ta.dispatchEvent(new Event('input', { bubbles: true })); saveDraft(name, ta.value); return; }
    const cur = loadDraft(name);
    saveDraft(name, (cur ? cur.replace(/\s*$/, '\n\n') : '') + block);
  }

  function totals(rs) {
    return { repos: rs.length, files: rs.reduce((a, r) => a + pending(r), 0), add: rs.reduce((a, r) => a + r.add, 0), del: rs.reduce((a, r) => a + r.del, 0), ahead: rs.reduce((a, r) => a + r.ahead, 0) };
  }
  const totText = t => [plural(t.repos, 'repo'), t.files ? plural(t.files, 'file') : null, t.ahead ? '↑' + t.ahead : null].filter(Boolean).join(' · ');

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

  return { onState, insertDraft, orgAccount: org => orgAccounts()(org, null) };
})();
