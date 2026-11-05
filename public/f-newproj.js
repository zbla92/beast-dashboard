'use strict';
FEAT.newproj = (() => {
  const RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  const hue = n => n.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
  const tileOf = n => h('span', { class: 'av ns-org sm', style: `--org:hsl(${hue(n)} 22% 62%)` }, h('span', { class: 'g' }, n.slice(0, 2).toUpperCase()));

  function folders() {
    const ps = S.projects.filter(p => !p.hidden);
    const isProj = new Set(S.projects.map(p => p.rel));
    const orgs = [...new Set(ps.map(p => p.org).filter(Boolean))].filter(o => !isProj.has(o)).sort();
    const groups = new Set();
    for (const p of ps) { if (!p.org || !p.group) continue; const seg = p.group.split('/'); for (let i = 1; i <= seg.length; i++) groups.add(p.org + '/' + seg.slice(0, i).join('/')); }
    return { orgs, groups: [...groups].filter(g => !isProj.has(g)).sort() };
  }

  function open(opts = {}) {
    const m = $('#modal'); m.classList.remove('hidden');
    const F = folders();
    const st = { org: '', group: '', fresh: false, acct: savedAcct(), touched: false, busy: false };
    const orgAcct = o => FEAT.wip?.orgAccount ? FEAT.wip.orgAccount(o) : ['personal', 'company'].includes((S.settings?.orgAccounts || {})[o]) ? S.settings.orgAccounts[o] : null;
    const close = () => { m.classList.add('hidden'); document.removeEventListener('keydown', onEsc, true); };
    const onEsc = e => { if (!box.isConnected) { document.removeEventListener('keydown', onEsc, true); return; } if (e.key !== 'Escape' || m.classList.contains('hidden')) return; e.preventDefault(); e.stopPropagation(); close(); };
    document.addEventListener('keydown', onEsc, true);

    const list = h('div', { class: 'np-list' });
    const orgIn = h('input', { class: 'txt np-org hidden', placeholder: 'new org folder name', autocapitalize: 'off', spellcheck: 'false' });
    const nameIn = h('input', { class: 'txt', placeholder: 'project-name', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    const path = h('div', { class: 'np-path dim' });
    const err = h('div', { class: 'ns-status hidden' });
    const acctSeg = h('span', { class: 'seg' });
    const go = h('button', { class: 'btn primary ns-send', onclick: () => create() }, 'Create');

    const rel = () => [st.org, st.group, nameIn.value.trim()].filter(Boolean).join('/');
    const valid = () => RE.test(st.org) && RE.test(nameIn.value.trim());
    const renderAcct = () => acctSeg.replaceChildren(...[['personal', 'Personal'], ['company', 'Company']].map(([v, l]) => h('button', { class: 'segb' + (st.acct === v ? ' on' : ''), onclick: () => { st.touched = true; st.acct = v; localStorage.setItem('bd.nt.acct', v); renderAcct(); } }, l)));
    const renderPath = () => {
      const name = nameIn.value.trim();
      const bad = (st.fresh && st.org && !RE.test(st.org)) || (name && !RE.test(name));
      path.textContent = (S.host.devRoot ? home(S.host.devRoot) : '~/dev') + '/' + (rel() || '…');
      path.classList.toggle('bad', !!bad);
      go.disabled = st.busy || !valid();
    };
    const row = (label, sub, on, click, tile) => h('div', { class: 'ntrow ns-prow' + (on ? ' on' : ''), onclick: click }, tile, h('div', { class: 'ntn' }, h('div', { class: 'ntt' }, label), sub ? h('div', { class: 'nts' }, sub) : null));
    const renderList = () => {
      const items = [];
      for (const o of F.orgs) {
        items.push(row(o, '', !st.fresh && st.org === o && !st.group, () => pick(o, '', false), tileOf(o)));
        for (const g of F.groups.filter(x => x.startsWith(o + '/'))) { const gp = g.slice(o.length + 1); items.push(row(gp, 'in ' + o, !st.fresh && st.org === o && st.group === gp, () => pick(o, gp, false), tileOf(gp.split('/').pop()))); }
      }
      items.push(row('New org folder…', 'a new top-level folder', st.fresh, () => pick('', '', true), h('span', { class: 'av sm ns-org ns-root' }, h('span', { class: 'g' }, '+'))));
      list.replaceChildren(...items);
    };
    const pick = (org, group, fresh) => {
      st.org = org; st.group = group; st.fresh = fresh; err.classList.add('hidden');
      if (!st.touched) st.acct = (!fresh && orgAcct(org)) || savedAcct();
      orgIn.classList.toggle('hidden', !fresh);
      if (!fresh) orgIn.value = '';
      renderList(); renderAcct(); renderPath();
      if (fresh) orgIn.focus(); else if (!IS_PHONE) nameIn.focus();
    };

    orgIn.oninput = () => { st.org = orgIn.value.trim(); err.classList.add('hidden'); renderPath(); };
    nameIn.oninput = () => { err.classList.add('hidden'); renderPath(); };
    const onKey = e => { if (e.key === 'Enter') { e.preventDefault(); if (!go.disabled) create(); } };
    orgIn.onkeydown = onKey; nameIn.onkeydown = onKey;

    async function create() {
      if (!valid() || st.busy) return;
      st.busy = true; go.disabled = true; err.classList.add('hidden');
      const body = { org: st.org, name: nameIn.value.trim(), account: st.acct, ...(st.group ? { group: st.group } : {}) };
      try {
        const r = await api('project-new', body);
        const acct = r.account || st.acct;
        close();
        if (!r.id) { toast('Project created, will show after the next scan', 'ok'); return; }
        toast('Created ' + (r.rel || r.id), 'ok');
        for (let i = 0; i < 15 && !S.projects.some(p => p.id === r.id); i++) await new Promise(res => setTimeout(res, 200));
        newSessionModal('new', '', { project: r.id, account: acct });
      } catch (e) {
        st.busy = false; err.textContent = e.message; err.classList.remove('hidden'); renderPath();
      }
    }

    const box = h('div', { class: 'box ntbox nsbox npbox' },
      h('div', { class: 'sh' }, h('h3', null, gl('＋ New project')), h('span', { class: 'sp' }), acctSeg, h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: close }, ico('x', 15))),
      h('div', { class: 'np-body' },
        h('div', { class: 'tsec' }, 'Where'), list, orgIn,
        h('div', { class: 'tsec' }, 'Name'), nameIn, path, err),
      h('div', { class: 'np-foot' }, h('span', { class: 'dim np-note' }, 'Makes the folder and runs git init'), h('span', { class: 'sp' }), go));
    m.replaceChildren(box); m.onclick = e => { if (e.target === m) close(); };
    const first = opts.org && F.orgs.includes(opts.org) ? opts.org : F.orgs[0];
    if (first) pick(first, '', false); else pick('', '', true);
  }

  const btn = $('#btn-newproj'); if (btn) btn.onclick = () => open();
  return { open };
})();
