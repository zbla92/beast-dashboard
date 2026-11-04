'use strict';
(() => {
  ICONS.undo = '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>';
  const CK = new Map();
  const enc = encodeURIComponent;
  const hm = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const busyOf = name => ['working', 'background', 'permission'].includes((claudeOf(name) || {}).state);
  const base = p => String(p).split('/').pop();
  const totals = e => e.repos.reduce((a, x) => ({ files: a.files + (x.files || 0), add: a.add + (x.add || 0), del: a.del + (x.del || 0) }), { files: 0, add: 0, del: 0 });

  function ensure(name) { let c = CK.get(name); if (!c) CK.set(name, c = { items: [], at: 0, sig: '', key: null, inflight: null }); return c; }
  function fetchCk(name) {
    const c = ensure(name); if (c.inflight) return c.inflight;
    c.inflight = api('checkpoints/' + enc(name)).then(r => { c.items = r.items || []; c.at = Date.now(); c.sig = c.items.map(e => e.id + ':' + (e.endAt || '')).join(','); return c; })
      .catch(() => c).finally(() => { c.inflight = null; });
    return c.inflight;
  }
  const undoneBy = (items, e) => { const u = items.find(x => x.kind === 'undo' && x.of === e.id); if (!u) return null; return items.some(x => x.kind === 'undo' && x.of === u.id && x.startAt >= u.startAt) ? null : u; };
  const convsOf = name => [...document.querySelectorAll('[data-chat]')].filter(b => b.dataset.chat === name).map(b => b.querySelector('.cscroll > .conv')).filter(Boolean);
  const redraw = name => { for (const conv of convsOf(name)) decorate(name, conv); };

  function chipRow(name, e, items) {
    const t = totals(e); const u = undoneBy(items, e); const busy = busyOf(name);
    return h('div', { class: 'ckp-row' + (u ? ' undone' : '') },
      h('button', { class: 'ckp-sum', title: 'what this turn changed', onclick: () => openTurn(name, e.id) },
        h('span', { class: 'ckp-ic' }, ico('pencil', 13)), plural(t.files, 'file') + ' changed',
        t.add ? h('b', { class: 'ckp-a' }, '+' + t.add) : null, t.del ? h('b', { class: 'ckp-d' }, '−' + t.del) : null,
        e.repos.length > 1 ? h('span', { class: 'ckp-n' }, e.repos.length + ' repos') : null,
        u ? h('span', { class: 'ckp-tag' }, 'undone ' + hm(u.startAt)) : null),
      h('button', { class: 'btn sm ghost', onclick: () => openTurn(name, e.id) }, 'Diff'),
      u ? h('button', { class: 'btn sm ghost', disabled: busy, title: busy ? 'wait until Claude is done' : 'put the changes back', onclick: () => undo(name, u.id, true) }, 'Redo')
        : h('button', { class: 'btn sm ghost', disabled: busy, title: busy ? 'wait until Claude is done' : 'put the files this turn changed back the way they were before it', onclick: () => undo(name, e.id, false) }, ico('undo', 13), 'Undo'));
  }

  function decorate(name, conv) {
    const c = CK.get(name); if (!c) return;
    const turns = [...conv.children].filter(el => el._turn && el._turn.role === 'assistant' && el._turn.ts);
    const want = new Map();
    for (const e of c.items) {
      if (e.kind !== 'turn' || !e.endAt) continue;
      let host = null; for (const el of turns) { const ts = el._turn.ts; if (ts >= e.startAt - 5000 && ts <= e.endAt + 5000) host = el; }
      if (host) (want.get(host) || want.set(host, []).get(host)).push(e);
    }
    const busy = busyOf(name);
    for (const el of turns) {
      const es = want.get(el); const cur = el.querySelector(':scope > .ckp');
      if (!es) { if (cur) cur.remove(); continue; }
      const key = es.map(e => e.id + ':' + ((undoneBy(c.items, e) || {}).id || '')).join(',') + (busy ? ':b' : '');
      if (cur && cur.dataset.k === key) continue;
      const chip = h('div', { class: 'ckp', 'data-k': key }, es.slice().reverse().map(e => chipRow(name, e, c.items)));
      if (cur) cur.replaceWith(chip); else el.append(chip);
    }
  }

  function conversation(name, conv) {
    const c = ensure(name); decorate(name, conv);
    const key = ((claudeOf(name) || {}).state || '') + '|' + conv.children.length;
    if (c.key === key && Date.now() - c.at < 30000) return;
    c.key = key;
    const was = c.sig;
    const refetch = () => fetchCk(name).then(c2 => { if (c2.sig !== was) redraw(name); });
    refetch(); if (!busyOf(name)) setTimeout(refetch, 2500);
  }

  function modal(box, onClose) {
    const m = $('#modal'); let done = false;
    const close = () => { if (done) return; done = true; m.classList.add('hidden'); document.removeEventListener('keydown', onKey, true); if (onClose) onClose(); };
    const onKey = ev => {
      if (!box.isConnected || m.classList.contains('hidden')) { done = true; document.removeEventListener('keydown', onKey, true); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
    };
    m.replaceChildren(box); m.classList.remove('hidden'); m.onclick = ev => { if (ev.target === m) close(); };
    document.addEventListener('keydown', onKey, true);
    return close;
  }

  async function openTurn(name, id) {
    const c = await fetchCk(name); const e = c.items.find(x => x.id === id);
    if (!e) return toast('that checkpoint is gone', 'err');
    const t = totals(e); const u = e.kind === 'turn' ? undoneBy(c.items, e) : null;
    const diffBox = h('div', { class: 'chdiff ckp-diff', 'data-session': name }, h('div', { class: 'dim ckp-pick' }, 'Pick a file to see its diff.'));
    let sel = null;
    const show = async (x, file, row) => {
      if (sel) sel.classList.remove('on'); sel = row; if (row) row.classList.add('on');
      diffBox.dataset.root = x.top; diffBox.textContent = 'loading…';
      try {
        const r = await api(`checkpoint-diff?session=${enc(name)}&id=${enc(e.id)}&top=${enc(x.top)}${file ? '&file=' + enc(file) : ''}`);
        diffBox.innerHTML = (r.truncated ? '<div class="dl meta">(truncated at 600 KB)</div>' : '') + renderDiff(r.text);
      } catch (err) { diffBox.textContent = err.message; }
    };
    const repos = e.repos.map(x => h('div', { class: 'ckp-repo' },
      h('div', { class: 'ckp-rh' }, ico('folder', 13), h('span', { class: 'mono ckp-top', title: x.top }, home(x.top)), h('span', { class: 'sp' }),
        h('button', { class: 'btn sm ghost', onclick: ev => show(x, '', ev.currentTarget) }, 'All files')),
      x.others && x.others.length ? h('div', { class: 'ckp-warn' }, 'Also working in this repo during this turn: ' + x.others.join(', ')) : null,
      x.list.map(f => { const row = h('div', { class: 'chfile ckp-file', title: f.f, onclick: () => show(x, f.f, row) },
        h('span', { class: 'chst s' + f.s }, f.s), fileIcon(f.f), h('span', { class: 'chpath' }, f.f),
        f.a ? h('span', { class: 'chnum add' }, '+' + f.a) : null, f.d ? h('span', { class: 'chnum del' }, '−' + f.d) : null); return row; }),
      x.files > x.list.length ? h('div', { class: 'dim ckp-more' }, `… ${x.files - x.list.length} more — see All files`) : null));
    const busy = busyOf(name);
    let close = null;
    const act = e.kind === 'undo' ? h('button', { class: 'btn', disabled: busy, onclick: () => { close(); undo(name, e.id, true); } }, 'Redo')
      : u ? h('button', { class: 'btn', disabled: busy, onclick: () => { close(); undo(name, u.id, true); } }, 'Redo')
      : h('button', { class: 'btn primary', disabled: busy, title: busy ? 'wait until Claude is done' : '', onclick: () => { close(); undo(name, e.id, false); } }, ico('undo', 14), 'Undo this turn');
    const box = h('div', { class: 'box settings ckp-box' },
      h('div', { class: 'sh' }, h('h3', null, e.kind === 'undo' ? 'Undo at ' + hm(e.startAt) : `Turn #${e.n} · ${hm(e.startAt)}${e.endAt && hm(e.endAt) !== hm(e.startAt) ? '–' + hm(e.endAt) : ''}`),
        h('div', { class: 'ckp-sub' }, e.prompt ? h('span', { class: 'ckp-prompt' }, e.prompt) : null,
          h('span', { class: 'mono ckp-tot' }, plural(t.files, 'file'), ' ', h('b', { class: 'ckp-a' }, '+' + t.add), ' ', h('b', { class: 'ckp-d' }, '−' + t.del)),
          u ? h('span', { class: 'ckp-tag' }, 'undone ' + hm(u.startAt)) : null)),
      h('div', { class: 'sbody ckp-body' }, h('div', { class: 'ckp-files' }, repos), diffBox),
      h('div', { class: 'foot' }, h('button', { class: 'btn ghost', onclick: () => openList(name) }, 'All turns'), h('span', { class: 'sp' }), h('button', { class: 'btn ghost', onclick: () => close() }, 'Close'), act));
    close = modal(box);
    const first = e.repos[0]; if (first && first.list.length === 1) show(first, first.list[0].f, box.querySelector('.ckp-file'));
  }

  async function openList(name) {
    const c = await fetchCk(name);
    const rows = c.items.filter(e => e.endAt).map(e => {
      const t = totals(e); const u = e.kind === 'turn' ? undoneBy(c.items, e) : null;
      return h('div', { class: 'chfile ckp-li' + (e.kind === 'undo' ? ' isundo' : '') + (u ? ' undone' : ''), onclick: () => openTurn(name, e.id) },
        h('span', { class: 'ckp-num mono' }, e.kind === 'undo' ? ico('undo', 13) : '#' + e.n),
        h('span', { class: 'ckp-when mono' }, hm(e.startAt)),
        h('span', { class: 'chpath ckp-pr' }, e.kind === 'undo' ? e.prompt : e.prompt || '(no prompt text)'),
        h('span', { class: 'mono ckp-tot' }, plural(t.files, 'file'), ' ', h('b', { class: 'ckp-a' }, '+' + t.add), ' ', h('b', { class: 'ckp-d' }, '−' + t.del)),
        u ? h('span', { class: 'ckp-tag' }, 'undone') : null, h('span', { class: 'caret' }, ico('chevronRight', 12)));
    });
    let close = null;
    const box = h('div', { class: 'box settings ckp-box ckp-listbox' },
      h('div', { class: 'sh' }, h('h3', null, 'Changes by turn'), h('div', { class: 'ckp-sub' }, sessWho(name))),
      h('div', { class: 'sbody' }, rows.length ? h('div', { class: 'ckp-list' }, rows) : h('div', { class: 'dim', style: 'padding:18px 4px' }, 'No file changes recorded for this session yet. Every Claude turn that changes files in a git repo shows up here, with its diff and an Undo.')),
      h('div', { class: 'foot' }, h('span', { class: 'dim', style: 'font-size:12px' }, 'Snapshots are git objects without refs; git gc removes them after about two weeks.'), h('span', { class: 'sp' }), h('button', { class: 'btn ghost', onclick: () => close() }, 'Close')));
    close = modal(box);
  }

  function note(name, files, redo, when) {
    const del = files.filter(f => f.act === 'delete').map(f => f.f); const res = files.filter(f => f.act === 'restore').map(f => f.f);
    const lst = a => a.slice(0, 12).join(', ') + (a.length > 12 ? ` and ${a.length - 12} more` : '');
    const txt = redo
      ? `[beast-dash] I put back the file changes from your turn at ${when} that I had undone: ${lst(files.map(f => f.f))}. Re-read these files before you edit them.`
      : `[beast-dash] I undid the file changes from your turn at ${when}. ${res.length ? 'Back to how they were before that turn: ' + lst(res) + '. ' : ''}${del.length ? 'Deleted (they did not exist before it): ' + lst(del) + '. ' : ''}Re-read these files before you edit them.`;
    const join = v => (v.trim() ? v.replace(/\s*$/, '\n\n') : '') + txt;
    const ta = [...document.querySelectorAll('[data-chat] .creply')].find(x => x.closest('[data-chat]').dataset.chat === name);
    if (ta) { ta.value = join(ta.value); ta.dispatchEvent(new Event('input')); } else saveDraft(name, join(loadDraft(name)));
  }

  async function undo(name, id, redo) {
    if (busyOf(name)) return toast('Claude is working in this session — wait until it is done', 'err');
    let dry; try { dry = await api('checkpoint-restore', { session: name, id, dry: true }); } catch (err) { return toast(err.message, 'err'); }
    const all = dry.repos.flatMap(r => r.files.map(f => ({ ...f, top: r.top })));
    const files = all.filter(f => f.act !== 'keep'); const kept = all.filter(f => f.act === 'keep');
    const errs = dry.repos.filter(r => r.error);
    if (!files.length) return toast(errs.length ? errs[0].error : kept.length ? `Nothing to change — ${plural(kept.length, 'file')} left as is (${kept[0].why})` : 'Nothing to change — the files already match', errs.length ? 'err' : '');
    const multi = new Set(files.map(f => f.top)).size > 1;
    const shown = [...files, ...kept];
    const plan = h('div', { class: 'ckp-plan' }, shown.slice(0, 40).map(f => h('div', { class: 'ckp-pl ' + f.act, title: f.why || '' },
      h('span', { class: 'ckp-act' }, f.act), h('span', { class: 'mono ckp-pf' }, (multi ? base(f.top) + '/' : '') + f.f),
      f.later && f.act !== 'keep' ? h('span', { class: 'ckp-later', title: 'edited again after this turn — those later edits are lost too' }, 'changed later') : null)),
      shown.length > 40 ? h('div', { class: 'dim' }, `… and ${shown.length - 40} more`) : null);
    const warns = [];
    if (kept.length) warns.push(`Files marked "keep" stay as they are: ${[...new Set(kept.map(f => f.why))].join('; ')}.`);
    if (files.some(f => f.later)) warns.push('Files marked "changed later" were edited again after this turn; those later edits go too.');
    if (dry.others && dry.others.length) warns.push('Other sessions worked in the same repo: ' + dry.others.join(', ') + '. Only the files listed here change.');
    if (dry.repos.some(r => r.headMoved)) warns.push('HEAD moved since this turn (commit, checkout or pull). The files get their old content back; git shows that as changes.');
    if (errs.length) warns.push(errs.map(r => base(r.top) + ': ' + r.error).join('; '));
    const ok = await confirmBox({ title: redo ? 'Redo these changes?' : 'Undo this turn?', who: sessWho(name), icon: 'undo', ok: redo ? 'Redo' : 'Undo', danger: files.some(f => f.later),
      text: [redo ? 'The files go back to how they were before the undo.' : 'The files this turn changed go back to how they were before it. Nothing else is touched, and a snapshot is taken first so you can redo it.', plan, ...warns.map(w => h('p', { class: 'ckp-warn' }, w))] });
    if (!ok) return;
    let r; try { r = await api('checkpoint-restore', { session: name, id }); } catch (err) { toast('Failed: ' + err.message, 'err'); return; }
    const c = await fetchCk(name); const e = c.items.find(x => x.id === id);
    const orig = e && e.kind === 'undo' ? c.items.find(x => x.id === e.of) : e;
    note(name, files, redo, hm(orig ? orig.startAt : Date.now()));
    toast((redo ? 'Redone: ' : 'Undone: ') + plural(files.length, 'file') + '. A note for Claude is in the reply box.' + (r.error ? '\n' + r.error : ''), r.error ? 'err' : 'ok');
    redraw(name);
  }

  FEAT.checkpoints = {
    conversation,
    sessMenu: (name, sess, cl) => cl ? { label: 'Changes by turn…', icon: ico('undo', 15), title: 'what each Claude turn changed, with diff and undo', onclick: () => openList(name) } : null,
    openTurn, openList,
  };
})();
