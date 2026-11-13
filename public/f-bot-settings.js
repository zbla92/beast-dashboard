'use strict';
FEAT.botSettings = (() => {
  const SECTIONS = [['about', 'About'], ['model', 'Model'], ['credentials', 'Credentials'], ['memory', 'Memory'], ['advanced', 'Advanced']];
  const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
  const EFFORTS = [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
  const PERMS = [['bypassPermissions', 'Bypass'], ['acceptEdits', 'Accept edits'], ['auto', 'Auto'], ['manual', 'Manual'], ['dontAsk', 'Do not ask'], ['plan', 'Plan']];
  const PROVIDERS = [['claude', 'Claude'], ['openai', 'OpenAI'], ['xai', 'xAI']];
  const MODEL_HINT = { openai: 'model id, e.g. gpt-5', xai: 'model id, e.g. grok-4' };
  const USES = [['skill', 'Skill'], ['agent', 'Separate agent'], ['both', 'Both']];
  const USE_NOTE = {
    skill: 'Agents load its profile into their own chat and do the work themselves, so nothing gets lost in a handoff.',
    agent: 'Agents send it a task and get its answer back (bd-ask). Use for its own accesses, another provider or an independent view.',
    both: 'Agents load it as a skill by default and ask it separately only when the work needs isolation.'
  };
  const SOURCE_LABEL = { chat: 'learned in chat', upload: 'upload', profile: 'instructions', outside: 'outside change', undo: 'undo', trainer: 'trainer' };
  const CHANGE_LABEL = { added: 'added', modified: 'changed', deleted: 'deleted' };
  const HIDDEN_SOURCES = new Set(['start', 'preamble']);
  const ACCESS_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
  const AUTO_ICONS = new Set(['', 'auto', '◆']);
  const PAGE = 50;

  const D = { name: null, p: null, keys: [], palette: [], onEsc: null, token: 0, section: 'about', paint: null };
  const enc = encodeURIComponent;
  const isApi = provider => Object.hasOwn(MODEL_HINT, provider || '');
  const useOf = p => Object.hasOwn(USE_NOTE, p?.use) ? p.use : 'agent';
  const fail = (el, msg) => { el.replaceChildren(msg || ''); el.classList.toggle('hidden', !msg); };
  const url = path => 'specialist/' + enc(D.name) + path;

  const opts = (list, cur) => {
    const items = list.some(([v]) => v === (cur ?? '')) || cur == null ? list : [...list, [cur, cur]];
    return items.map(([v, l]) => h('option', { value: v }, l));
  };
  const select = (list, cur) => { const s = h('select', { class: 'txt' }, opts(list, cur)); s.value = cur ?? ''; return s; };
  const field = (label, el, cls = '') => h('label', { class: 'sp-f ' + cls }, h('span', null, label), el);
  const textInput = (value, max) => h('input', { class: 'txt', value: value || '', maxlength: max, autocomplete: 'off', spellcheck: 'false' });
  const changed = (cur, base) => Object.fromEntries(Object.keys(cur).filter(k => cur[k] !== base[k]).map(k => [k, cur[k]]));
  const when = at => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const fallbackTile = p => h('span', { class: 'bs-tile', style: p.iconColor ? 'background:' + p.iconColor : null }, p.iconGlyph || String(p.title || p.name || '?')[0].toUpperCase());

  const undoMessage = e => {
    const m = e.message || '';
    if (/busy/.test(m)) return 'The bot is working right now. Try again when it is idle.';
    if (/preamble/.test(m)) return 'This part is managed by the dashboard and cannot be undone.';
    if (/starting point/.test(m)) return 'The starting point cannot be undone.';
    if (/later changes/.test(m)) return 'Later changes touch the same lines. Undo those first.';
    return m || 'Could not undo this change.';
  };

  const saver = (err, btn, run) => async () => {
    fail(err, ''); btn.disabled = true;
    try { await run(); } catch (e) {
      fail(err, e.message);
      if (e.status === 409) err.append(h('button', { class: 'btn sm ghost bs-reload', type: 'button', onclick: () => open(D.name, D.section) }, 'Reload'));
    }
    btn.disabled = false;
  };

  async function update(body) {
    if (!Object.keys(body).length) { toast('Nothing to save'); return; }
    await api(url(''), { ...body, ifUpdatedAt: D.p.updatedAt });
    const r = await api(url(''));
    D.p = r.specialist;
    toast('Saved', 'ok');
    FEAT.specialists?.refresh?.(true);
  }

  function aboutPane() {
    const p = D.p;
    const title = textInput(p.title, 60);
    const desc = textInput(p.description, 300);
    const err = h('div', { class: 'ns-status hidden' });
    const keyed = D.keys.includes(p.icon);
    const legacy = !keyed && !AUTO_ICONS.has(p.icon) && !/^[a-z][a-z0-9-]*$/.test(p.icon || '') ? p.icon : null;
    const stored = keyed || legacy ? p.icon : 'auto';
    const pick = { icon: stored, color: p.color || null };
    const iconRow = h('div', { class: 'bs-icons', role: 'group', 'aria-label': 'Icon' });
    const colorRow = h('div', { class: 'bs-swatches', role: 'group', 'aria-label': 'Colour' });
    const iconBtn = (value, label, content) => h('button', { class: 'bs-ic' + (pick.icon === value ? ' on' : ''), type: 'button', title: label, 'aria-pressed': pick.icon === value ? 'true' : 'false', 'data-icon': value, onclick: () => { pick.icon = value; paintIcons(); } }, content);
    const paintIcons = () => iconRow.replaceChildren(
      iconBtn('auto', 'Auto, from the name', h('span', { class: 'bs-auto' }, 'Auto')),
      legacy ? iconBtn(legacy, 'Current', h('span', { class: 'bs-glyph' }, legacy)) : null,
      ...D.keys.map(k => iconBtn(k, k, window.BOT_ICON?.svg(k, 18) || h('span', { class: 'bs-keyname' }, k))));
    const swatch = (value, label, content, style) => h('button', { class: 'bs-sw' + (pick.color === value ? ' on' : ''), type: 'button', title: label, 'aria-pressed': pick.color === value ? 'true' : 'false', 'data-color': value || 'auto', style, onclick: () => { pick.color = value; paintColors(); } }, content);
    const paintColors = () => colorRow.replaceChildren(swatch(null, 'Auto, from the name', 'Auto', null), ...D.palette.map(c => swatch(c, c, null, 'background:' + c)));
    paintIcons(); paintColors();
    const save = h('button', { class: 'btn primary ns-send', type: 'button' }, 'Save');
    save.onclick = saver(err, save, async () => {
      const cur = { title: title.value.trim(), description: desc.value.trim(), icon: pick.icon, color: pick.color };
      const base = { title: D.p.title || '', description: D.p.description || '', icon: stored, color: D.p.color || null };
      await update(changed(cur, base));
      D.paint?.();
    });
    return {
      first: title,
      el: h('div', { class: 'bs-pane' },
        h('div', { class: 'bs-scroll' },
          field('Name', h('input', { class: 'txt', value: p.name, readonly: true })),
          field('Title', title), field('Description', desc),
          h('div', { class: 'sp-f' }, h('span', null, 'Icon'), iconRow),
          h('div', { class: 'sp-f' }, h('span', null, 'Colour'), colorRow), err),
        h('div', { class: 'sp-foot' }, h('span', { class: 'sp' }), save))
    };
  }

  function modelInput(provider, cur) {
    const pick = select(MODELS, isApi(provider) ? '' : cur || '');
    const id = h('input', { class: 'txt', value: isApi(provider) ? cur || '' : '', maxlength: 128, autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    const box = h('span', { class: 'sp-model' }, pick, id);
    const show = pv => { pick.classList.toggle('hidden', isApi(pv)); id.classList.toggle('hidden', !isApi(pv)); id.placeholder = MODEL_HINT[pv] || ''; };
    show(provider);
    return { box, show, value: pv => isApi(pv) ? id.value.trim() || null : pick.value || null };
  }

  function modelPane() {
    const p = D.p;
    const provider = select(PROVIDERS, p.provider || 'claude');
    const model = modelInput(provider.value, p.model);
    const effort = select(EFFORTS, p.effort || '');
    const account = select([['personal', acct('personal')], ['company', acct('company')]], p.account);
    const claudeOnly = [field('Effort', effort), field('Account', account)];
    const err = h('div', { class: 'ns-status hidden' });
    const keyNote = h('div', { class: 'ns-status hidden' });
    const show = () => {
      model.show(provider.value);
      for (const f of claudeOnly) f.classList.toggle('hidden', isApi(provider.value));
      fail(keyNote, isApi(provider.value) && provider.value === (D.p.provider || 'claude') ? D.p.keyError : '');
    };
    provider.onchange = show;
    show();
    const save = h('button', { class: 'btn primary ns-send', type: 'button' }, 'Save');
    save.onclick = saver(err, save, async () => {
      const cur = { provider: provider.value, model: model.value(provider.value), effort: effort.value || null, account: account.value };
      const base = { provider: D.p.provider || 'claude', model: D.p.model || null, effort: D.p.effort || null, account: D.p.account };
      const body = changed(cur, base);
      if (body.provider !== undefined) body.model = cur.model;
      await update(body);
      show();
    });
    return {
      first: provider,
      el: h('div', { class: 'bs-pane' },
        h('div', { class: 'bs-scroll' },
          h('div', { class: 'dim sp-note' }, 'Changes apply the next time the bot starts. A chat that is already open keeps its model.'),
          field('Provider', provider), field('Model', model.box), ...claudeOnly, keyNote, err),
        h('div', { class: 'sp-foot' }, h('span', { class: 'sp' }), save))
    };
  }

  function credentialsPane() {
    const name = h('input', { class: 'txt mono', placeholder: 'DB_URL', maxlength: 64, autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
    const value = h('input', { class: 'txt', type: 'password', placeholder: 'value', autocomplete: 'new-password', autocapitalize: 'off', spellcheck: 'false' });
    const note = h('input', { class: 'txt', placeholder: 'note (optional)', maxlength: 200, autocomplete: 'off' });
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    const list = h('div', { class: 'bs-list' });
    const err = h('div', { class: 'ns-status hidden' });
    const form = h('div', { class: 'sp-accform' }, name, value, note, save);
    const help = h('div', { class: 'dim sp-note' });
    const C = { items: [], ask: null, usable: true };
    const paint = () => {
      help.replaceChildren(C.usable
        ? 'Credentials stay on this machine in the bot\'s private folder, are never committed and are given only to this bot. A saved value is never shown again; to change one, type a new value.'
        : 'OpenAI and xAI bots do not get credentials.');
      form.classList.toggle('hidden', !C.usable);
      list.replaceChildren(...(C.items.length ? C.items.map(a => h('div', { class: 'sp-acc' },
        h('div', { class: 'sp-cm' }, h('div', { class: 'sp-ct mono' }, a.name), h('div', { class: 'dim sp-cs' }, a.note || 'No note', ' · value saved')),
        h('div', { class: 'sp-cacts' }, C.ask === a.name
          ? [h('span', { class: 'dim' }, 'Remove it?'), h('button', { class: 'btn sm danger solid', type: 'button', onclick: () => remove(a) }, 'Remove'), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { C.ask = null; paint(); } }, 'Cancel')]
          : [h('button', { class: 'btn sm', type: 'button', onclick: () => { name.value = a.name; note.value = a.note || ''; value.value = ''; value.focus(); } }, 'Replace'), h('button', { class: 'btn sm danger', type: 'button', onclick: () => { C.ask = a.name; paint(); } }, 'Remove')]))) : [h('div', { class: 'dim sp-none' }, 'No credentials yet.')]));
    };
    const load = async () => {
      try { const r = await api(url('/accesses')); C.items = r.accesses || []; C.usable = r.usedByRuns !== false; fail(err, ''); } catch (e) { fail(err, e.message); }
      paint();
    };
    const remove = async a => {
      C.ask = null; fail(err, '');
      try { await api(url('/accesses/' + enc(a.name) + '/delete'), {}); toast('Removed ' + a.name, 'ok'); await load(); } catch (e) { fail(err, e.message); paint(); }
    };
    const add = async () => {
      const n = name.value.trim();
      if (!ACCESS_RE.test(n)) { fail(err, 'Use a name like DB_URL: capital letters, digits and underscores.'); return; }
      if (!value.value) { fail(err, 'Type the value.'); return; }
      save.disabled = true; fail(err, '');
      const body = { name: n, value: value.value };
      if (note.value.trim()) body.note = note.value.trim();
      try {
        await api(url('/accesses'), body);
        value.value = ''; name.value = ''; note.value = '';
        toast('Saved ' + n, 'ok');
        await load();
      } catch (e) { fail(err, e.message); }
      save.disabled = false;
    };
    save.onclick = add;
    for (const el of [name, value, note]) el.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } };
    paint();
    return {
      first: name, load,
      el: h('div', { class: 'bs-pane' }, h('div', { class: 'bs-scroll' }, help, h('div', { class: 'bs-listbox' }, list), form, err))
    };
  }

  function diffView(diff, truncated) {
    const cls = l => l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
    return h('div', { class: 'sp-diff' },
      h('pre', null, diff.split('\n').map(l => h('span', { class: 'dl ' + cls(l) }, l + '\n'))),
      truncated ? h('div', { class: 'dim sp-note' }, 'The diff is cut short because it is large.') : null);
  }

  function memoryPane() {
    const M = { commits: [], more: false, ask: null, open: new Map(), ready: false };
    const list = h('div', { class: 'bs-list' });
    const err = h('div', { class: 'ns-status hidden' });
    const paint = () => {
      const rows = M.commits.filter(c => !HIDDEN_SOURCES.has(c.source));
      list.replaceChildren(...(rows.length ? rows.map(row) : [h('div', { class: 'dim sp-none' }, M.ready ? 'Nothing learned yet. Tell the bot "remember ..." in its chat.' : 'Loading…')]),
        M.more ? h('button', { class: 'btn sm ghost', type: 'button', onclick: more }, 'Show older') : null);
    };
    const load = async () => {
      try { const r = await api(url('/train/history?limit=' + PAGE)); M.commits = r.commits || []; M.more = !!r.more; M.ready = true; fail(err, ''); } catch (e) { fail(err, e.message); }
      paint();
    };
    const more = async () => {
      const last = M.commits[M.commits.length - 1]; if (!last) return;
      try { const r = await api(url('/train/history?limit=' + PAGE + '&before=' + enc(last.id))); M.commits = [...M.commits, ...(r.commits || [])]; M.more = !!r.more; paint(); } catch (e) { fail(err, e.message); }
    };
    const view = async c => {
      if (M.open.has(c.id)) { M.open.delete(c.id); paint(); return; }
      M.open.set(c.id, { loading: true }); paint();
      try { const r = await api(url('/train/commit/' + enc(c.id))); M.open.set(c.id, { diff: r.diff, truncated: r.truncated }); } catch (e) { M.open.set(c.id, { error: e.message }); }
      paint();
    };
    const undo = async c => {
      M.ask = null; fail(err, '');
      try { await api(url('/train/undo'), { commit: c.id }); toast('Change undone', 'ok'); await load(); } catch (e) { fail(err, undoMessage(e)); paint(); }
    };
    const row = c => {
      const o = M.open.get(c.id);
      const acts = M.ask === c.id
        ? [h('span', { class: 'dim' }, 'Undo this change?'), h('button', { class: 'btn sm danger solid', type: 'button', onclick: () => undo(c) }, 'Undo'), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { M.ask = null; paint(); } }, 'Cancel')]
        : [h('button', { class: 'btn sm ghost', type: 'button', onclick: () => view(c) }, o ? 'Hide' : 'View'), c.undone ? null : h('button', { class: 'btn sm', type: 'button', onclick: () => { M.ask = c.id; paint(); } }, 'Undo')];
      return h('div', { class: 'sp-commit' + (c.undone ? ' undone' : '') },
        h('div', { class: 'sp-crow' },
          h('div', { class: 'sp-cm' },
            h('div', { class: 'sp-ct' }, c.message || c.short),
            h('div', { class: 'dim sp-cs' }, when(c.at), ' · ', SOURCE_LABEL[c.source] || c.source, c.undone ? ' · undone' : ''),
            (c.files || []).length ? h('div', { class: 'sp-cfiles' }, c.files.map(f => h('span', { class: 'badge tag' }, f.path + ' · ' + (CHANGE_LABEL[f.change] || f.change)))) : null),
          h('div', { class: 'sp-cacts' }, acts)),
        o ? h('div', { class: 'sp-cdetail' }, o.loading ? h('div', { class: 'dim' }, 'Loading…') : o.error ? h('div', { class: 'ns-status' }, o.error) : o.diff ? diffView(o.diff, o.truncated) : h('div', { class: 'dim' }, 'No text changes.')) : null);
    };
    paint();
    return {
      first: null, load,
      el: h('div', { class: 'bs-pane' }, h('div', { class: 'bs-scroll' }, h('div', { class: 'dim sp-note' }, 'What the bot learned, newest first. Undo takes one change back.'), h('div', { class: 'bs-listbox' }, list), err))
    };
  }

  function advancedPane() {
    const p = D.p;
    const apiBot = isApi(p.provider);
    const use = select(USES, useOf(p));
    const useNote = h('div', { class: 'dim sp-note' }, USE_NOTE[use.value] || '');
    use.onchange = () => { useNote.textContent = USE_NOTE[use.value] || ''; };
    const perm = select(PERMS, p.permissionMode);
    const ins = apiBot ? h('textarea', { class: 'sp-ins', spellcheck: 'false' }) : null;
    if (ins) ins.value = p.instructions || '';
    const err = h('div', { class: 'ns-status hidden' });
    const save = h('button', { class: 'btn primary ns-send', type: 'button' }, 'Save');
    save.onclick = saver(err, save, async () => {
      const body = apiBot ? {} : changed({ use: use.value, permissionMode: perm.value }, { use: useOf(D.p), permissionMode: D.p.permissionMode });
      if (ins && ins.value !== (D.p.instructions || '')) body.instructions = ins.value;
      await update(body);
    });
    const edited = (p.skill?.accounts || []).filter(a => a.state === 'edited');
    const regen = async () => {
      try { await api(url('/skill/sync'), { force: true }); toast('Skill regenerated', 'ok'); } catch (e) { fail(err, e.message); }
    };
    const skillWarn = edited.length ? h('div', { class: 'sp-skillwarn' },
      h('span', null, 'The skill was edited by hand in ' + edited.map(a => a.account).join(' and ') + '. Regenerating writes it again from this profile; the edited copy is saved in the profile first.'),
      h('button', { class: 'btn sm', type: 'button', onclick: regen }, 'Regenerate skill')) : null;
    const arch = h('span', { class: 'sp-arch' });
    const plain = () => arch.replaceChildren(h('button', { class: 'btn sm danger', type: 'button', onclick: ask }, ico('archive', 13), 'Archive bot'));
    const ask = () => arch.replaceChildren(h('span', { class: 'dim' }, 'Move this bot to the archive?'), h('button', { class: 'btn sm danger solid', type: 'button', onclick: doArchive }, 'Archive'), h('button', { class: 'btn sm ghost', type: 'button', onclick: plain }, 'Cancel'));
    const doArchive = async () => {
      try {
        await api(url('/archive'), { endChat: true });
        toast('Archived ' + (D.p.title || D.name), 'ok');
        close();
        FEAT.specialists?.refresh?.(true);
      } catch (e) { plain(); fail(err, e.message); }
    };
    plain();
    return {
      first: ins || use,
      el: h('div', { class: 'bs-pane' },
        h('div', { class: 'bs-scroll' },
          apiBot ? null : field('Use', use), apiBot ? null : useNote,
          apiBot ? null : field('Permission mode', perm),
          skillWarn,
          ins ? field('Instructions (CLAUDE.md)', ins) : null, err),
        h('div', { class: 'sp-foot' }, arch, h('span', { class: 'sp' }), save))
    };
  }

  function close() {
    $('#modal').classList.add('hidden');
    if (D.onEsc) document.removeEventListener('keydown', D.onEsc, true);
    D.onEsc = null; D.paint = null; D.token++;
  }

  function mount(section) {
    const m = $('#modal');
    if (D.onEsc) document.removeEventListener('keydown', D.onEsc, true);
    m.classList.remove('hidden');
    const panes = { about: aboutPane(), model: modelPane(), credentials: credentialsPane(), memory: memoryPane(), advanced: advancedPane() };
    const loaded = new Set();
    const tabs = SECTIONS.map(([id, label]) => h('button', { class: 'bs-tab', type: 'button', role: 'tab', 'data-section': id, onclick: () => show(id) }, label));
    const secs = SECTIONS.map(([id]) => h('div', { class: 'bs-sec hidden', 'data-section': id, role: 'tabpanel' }, panes[id].el));
    const show = id => {
      D.section = id;
      SECTIONS.forEach(([sid], i) => {
        tabs[i].classList.toggle('on', sid === id);
        tabs[i].setAttribute('aria-selected', sid === id ? 'true' : 'false');
        secs[i].classList.toggle('hidden', sid !== id);
      });
      if (panes[id].load && !loaded.has(id)) { loaded.add(id); panes[id].load(); }
      panes[id].first?.focus();
    };
    const headParts = () => [
      window.BOT_ICON?.tile ? window.BOT_ICON.tile(D.p, 28) : fallbackTile(D.p),
      h('h3', null, D.p.title || D.p.name),
      h('span', { class: 'sp' }),
      h('button', { class: 'btn sm ghost icon', type: 'button', title: 'close (Esc)', 'aria-label': 'Close', onclick: close }, ico('x', 15))
    ];
    const head = h('div', { class: 'sh' }, headParts());
    D.paint = () => head.replaceChildren(...headParts());
    const box = h('div', { class: 'box spbox bsbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bot settings' }, head, h('div', { class: 'bs-tabs', role: 'tablist' }, tabs), h('div', { class: 'bs-body' }, secs));
    const onEsc = e => {
      if (!m.querySelector('.bsbox')) { document.removeEventListener('keydown', onEsc, true); return; }
      if (e.key !== 'Escape' || m.classList.contains('hidden')) return;
      e.preventDefault(); e.stopPropagation(); close();
    };
    D.onEsc = onEsc; document.addEventListener('keydown', onEsc, true);
    m.onclick = e => { if (e.target === m) close(); };
    m.replaceChildren(box);
    show(SECTIONS.some(([id]) => id === section) ? section : 'about');
  }

  async function open(name, section = 'about') {
    const token = ++D.token;
    try {
      const [detail, all] = await Promise.all([api('specialist/' + enc(name)), api('specialists')]);
      if (token !== D.token) return;
      D.name = name; D.p = detail.specialist;
      D.keys = all.iconKeys || window.BOT_ICON?.keys || [];
      D.palette = all.palette || [];
      mount(section);
    } catch (e) { toast(e.message, 'err'); }
  }

  return { open };
})();
