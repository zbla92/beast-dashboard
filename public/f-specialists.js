'use strict';
FEAT.specialists = (() => {
  const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
  const EFFORTS = [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
  const PERMS = [['bypassPermissions', 'Bypass'], ['acceptEdits', 'Accept edits'], ['auto', 'Auto'], ['manual', 'Manual'], ['dontAsk', 'Do not ask'], ['plan', 'Plan']];
  const MODES = [['run', 'Fresh run per task'], ['thread', 'One thread']];
  const PROVIDERS = [['claude', 'Claude'], ['openai', 'OpenAI'], ['xai', 'xAI']];
  const MODEL_HINT = { openai: 'model id, e.g. gpt-5', xai: 'model id, e.g. grok-4' };
  const RUN_STATE = { starting: 'starting', working: 'working', waiting: 'needs an answer', done: 'done', error: 'error', stopped: 'stopped' };
  const V = { list: [], templates: [], at: 0, busy: false, ok: false, sig: '' };
  const CR = { onEsc: null };
  const SEEN_KEY = 'bd.spec.seen';
  const SINCE_KEY = 'bd.spec.since';
  const SEEN_CAP = 200;
  const SEEN = { ids: new Set(), at: new Map(), since: 0 };
  const FIN = new Map();
  const FETCHED = new Map();
  const HOME = { node: null, key: '' };

  const enc = encodeURIComponent;
  const hue = n => n.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
  const valid = p => !!p && !p.error;
  const runOf = s => !!s.claude?.specialist;
  const ownerOf = s => s.claude?.specialist || null;
  const runSessions = name => S.runtime.sessions.filter(s => runOf(s) && ownerOf(s) === name).sort((a, b) => a.name < b.name ? -1 : 1);
  const firstLine = t => String(t || '').split('\n').find(l => l.trim())?.trim() || '';
  const isApi = provider => Object.hasOwn(MODEL_HINT, provider || '');
  const providerLabel = provider => (PROVIDERS.find(([v]) => v === provider) || [provider, provider])[1];
  const modelLabel = (m, provider) => isApi(provider) ? m || providerLabel(provider) : m ? modelName(m) : 'Default';
  const modeLabel = m => m === 'thread' ? 'Thread' : 'Run';
  const sessionSig = () => S.runtime.sessions.filter(runOf).map(s => s.name + ':' + (s.claude?.state || '')).join(',');

  function stateOf(p) {
    if (p.error) return 'error';
    const live = runSessions(p.name).map(s => s.claude);
    if (live.some(c => c && c.state === 'permission')) return 'permission';
    if (live.some(c => c && c.state === 'working') || p.thread?.state === 'working' || p.active > 0) return 'working';
    return 'idle';
  }

  const store = {
    get: k => { try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch {} }
  };
  const trimSeen = (entries, since, cap) => {
    if (entries.length <= cap) return { kept: entries, since };
    const dropped = entries.slice(0, entries.length - cap);
    return { kept: entries.slice(-cap), since: Math.max(since, ...dropped.map(e => e.endedAt || 0)) };
  };
  const seenEntries = () => [...SEEN.ids].map(id => ({ id, endedAt: SEEN.at.get(id) || 0 }));
  const loadSeen = () => {
    try {
      const entries = JSON.parse(store.get(SEEN_KEY) || '[]').map(e => typeof e === 'string' ? { id: e, endedAt: 0 } : e).filter(e => e && typeof e.id === 'string');
      SEEN.ids = new Set(entries.map(e => e.id));
      SEEN.at = new Map(entries.map(e => [e.id, Number(e.endedAt) || 0]));
    } catch {}
    const since = Number(store.get(SINCE_KEY));
    SEEN.since = since > 0 ? since : Date.now();
    if (!(since > 0)) store.set(SINCE_KEY, String(SEEN.since));
  };
  loadSeen();
  const markSeen = (id, endedAt) => {
    if (SEEN.ids.has(id)) return false;
    SEEN.ids.add(id);
    SEEN.at.set(id, Number(endedAt) || Date.now());
    const t = trimSeen(seenEntries(), SEEN.since, SEEN_CAP);
    SEEN.ids = new Set(t.kept.map(e => e.id));
    SEEN.at = new Map(t.kept.map(e => [e.id, e.endedAt]));
    if (t.since !== SEEN.since) { SEEN.since = t.since; store.set(SINCE_KEY, String(t.since)); }
    store.set(SEEN_KEY, JSON.stringify(t.kept));
    return true;
  };
  const FINAL_RUN = ['done', 'error', 'stopped'];
  const isFinal = r => FINAL_RUN.includes(r.state);
  const finKey = () => [...FIN.keys()].filter(id => !SEEN.ids.has(id)).join(',');
  const watching = r => (PG.name === r.specialist && pageShown()) || (!!TERM.open && TERM.active === r.tmux);
  const collect = runs => {
    for (const r of runs) {
      if (!isFinal(r) || FIN.has(r.runId) || SEEN.ids.has(r.runId) || !((r.endedAt || 0) > SEEN.since)) continue;
      if (watching(r)) markSeen(r.runId, r.endedAt); else FIN.set(r.runId, r);
    }
  };
  const announce = () => {
    if (FEAT.inbox && FEAT.inbox.refresh) FEAT.inbox.refresh();
    if (typeof renderHeader === 'function') renderHeader();
  };
  const unseenRuns = () => [...FIN.values()].filter(r => !SEEN.ids.has(r.runId)).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).map(r => ({ ...r, title: V.list.find(p => p.name === r.specialist)?.title || r.specialist }));
  const dismissRun = id => { markSeen(id, FIN.get(id)?.endedAt); FIN.delete(id); announce(); };
  const seenByUser = (id, endedAt) => { const added = markSeen(id, endedAt); const had = FIN.delete(id); if (added || had) announce(); };
  const openRun = r => { dismissRun(r.runId); openPage(r.specialist, { run: r.runId }); };

  async function gather() {
    for (const p of V.list.filter(valid)) {
      const lr = p.lastRun; if (!lr || !isFinal(lr)) continue;
      const sig = lr.runId + ':' + lr.state + ':' + p.active;
      if (FETCHED.get(p.name) === sig) continue;
      collect([lr]);
      if (!((lr.endedAt || 0) > SEEN.since)) { FETCHED.set(p.name, sig); continue; }
      try { const r = await api('specialist/' + enc(p.name) + '?runs=10'); collect(r.runs || []); FETCHED.set(p.name, sig); } catch {}
    }
  }

  const tile = (p, cls = 'sm') => h('span', { class: 'av ns-org ' + cls, style: `--org:hsl(${hue(p.name)} 22% 62%)` }, h('span', { class: 'g' }, p.icon ? gl(p.icon, 14) : p.name.slice(0, 2).toUpperCase()));

  function repaint() {
    renderRail();
    if (IS_PHONE && TERM.open && TERM.showList) renderTermPanel(true);
    paintPage();
  }

  async function refresh(force) {
    if (V.busy || (!force && Date.now() - V.at < 4000)) return;
    V.busy = true;
    try {
      const r = await api('specialists');
      V.list = r.specialists || []; V.templates = r.templates || []; V.ok = true;
    } catch { V.ok = false; }
    const before = finKey();
    try { await gather(); } catch {}
    V.busy = false; V.at = Date.now();
    repaint();
    if (before !== finKey()) announce();
  }

  function onState() {
    const sig = sessionSig();
    if (!V.at || sig !== V.sig) { V.sig = sig; refresh(false); }
    paintPage();
  }

  const pageShown = () => !!PG.tmux && !!TERM.open && TERM.active === PG.tmux;
  const keyOf = () => [V.ok, PG.name, pageShown(), V.list.map(p => [p.name, p.title, p.icon, p.provider, p.model, p.active, p.error, p.thread?.state, p.description]), V.list.map(p => runSessions(p.name).map(s => [s.name, s.claude?.state, s.claude?.needsYou, s.claude?.title, s.claude?.firstPrompt, s.claude?.label]))];
  const termBarKey = name => [keyOf(), trainBarKey(name), pageBarKey(name)];

  const runLabel = s => firstLine(s.claude?.title || s.claude?.firstPrompt || s.claude?.label) || s.name;

  const runState = cl => { const st = cl?.state || 'unknown'; return st === 'needs-you' ? 'idle' : st; };

  function railRun(s) {
    const cl = s.claude; const st = runState(cl);
    return h('button', { class: 'rrow sub k-spec-run st-' + st + (TERM.open && TERM.active === s.name ? ' on' : '') + (st === 'permission' ? ' need' : ''), title: s.name, onclick: () => openTerm(s.name) },
      h('i', { class: 'rdot' }),
      h('span', { class: 'rtx' }, h('span', { class: 'rnm' }, h('b', null, runLabel(s)))));
  }

  function railRow(p) {
    if (p.error) return h('button', { class: 'rrow k-spec st-error', title: p.error, onclick: () => toast(p.name + ': ' + p.error, 'err') },
      h('i', { class: 'rdot' }), h('span', { class: 'rtx' }, h('span', { class: 'rnm' }, h('b', null, p.name)), h('span', { class: 'rln2' }, h('span', { class: 'rsub' }, 'profile has an error'))));
    const st = stateOf(p);
    return h('button', { class: 'rrow k-spec st-' + st + (PG.name === p.name && pageShown() ? ' on' : ''), title: p.description || p.name, onclick: () => openPage(p.name) },
      h('span', { class: 'rav' }, tile(p), h('i', { class: 'rdot' })),
      h('span', { class: 'rtx' }, h('span', { class: 'rnm' }, h('b', null, p.title || p.name), h('em', null, modelLabel(p.model, p.provider).toLowerCase())),
        p.description ? h('span', { class: 'rln2' }, h('span', { class: 'rsub' }, p.description)) : null),
      p.active > 0 ? h('span', { class: 'rage', title: plural(p.active, 'active run') }, p.active) : null);
  }

  function listRun(s) {
    const cl = s.claude; const st = runState(cl);
    return h('div', { class: 'titem claude sub st-' + st + (TERM.active === s.name ? ' on' : ''), title: s.name, onclick: () => openTerm(s.name) },
      h('span', { class: 'dot' }),
      h('div', { class: 'tt' }, h('div', { class: 'tn' }, h('span', { class: 'nm' }, runLabel(s))),
        h('div', { class: 'ts' }, h('span', { class: 'cst mini ' + st }, gico(STATE_ICON[st] || '·', 10), ' ', STATE_LABEL[st] || st))));
  }

  function listRow(p) {
    if (p.error) return h('div', { class: 'titem other st-error', onclick: () => toast(p.name + ': ' + p.error, 'err') }, h('span', { class: 'dot' }), h('div', { class: 'tt' }, h('div', { class: 'tn' }, h('span', { class: 'nm' }, p.name)), h('div', { class: 't3' }, h('span', { class: 'ttl dim' }, p.error))));
    const st = stateOf(p);
    return h('div', { class: 'titem claude spec st-' + st, title: p.description || p.name, onclick: () => openPage(p.name) },
      tile(p),
      h('div', { class: 'tt' },
        h('div', { class: 'tn' }, h('span', { class: 'nm' }, p.title || p.name)),
        h('div', { class: 'ts' }, h('span', { class: 'cst mini ' + st }, gico(STATE_ICON[st] || '·', 10), ' ', STATE_LABEL[st] || st), h('span', { class: 'mdl' }, modelLabel(p.model, p.provider)), p.active > 0 ? h('span', { class: 'grp' }, plural(p.active, 'run')) : null),
        p.description ? h('div', { class: 't3' }, h('span', { class: 'ttl dim' }, p.description)) : null));
  }

  function railSection(kind) {
    if (kind === 'list' && !IS_PHONE) return null;
    const rows = [];
    for (const p of V.list) {
      if (kind === 'rail') rows.push(railRow(p), ...(valid(p) ? runSessions(p.name).map(railRun) : []));
      else rows.push(listRow(p), ...(valid(p) ? runSessions(p.name).map(listRun) : []));
    }
    const add = h('button', { class: 'rail-add', title: 'New specialist', 'aria-label': 'New specialist', onclick: () => openCreate() }, ico('plus', 16));
    const head = kind === 'rail'
      ? h('div', { class: 'rail-head sp-head' }, h('span', { class: 'rail-t' }, 'Specialists ', h('span', { class: 'n' }, V.list.length)), add)
      : h('div', { class: 'tsec sp-head' }, 'Specialists', h('span', { class: 'n' }, V.list.length), h('span', { class: 'sp' }), add);
    const empty = !V.list.length ? h('div', { class: kind === 'rail' ? 'rempty' : 'note sp-empty' }, V.ok ? 'No specialists yet.' : 'Specialists are not available.') : null;
    return [head, ...rows, empty];
  }

  function paletteItems() {
    const out = [];
    for (const p of V.list.filter(valid)) {
      const t = p.title || p.name;
      out.push({ kind: 'action', label: 'Specialist: ' + t, sub: p.description || modelLabel(p.model, p.provider), icon: p.icon || '◆', hay: ['specialist', p.name, t, p.description].join(' '), run: () => openPage(p.name), rank: 26 },
        { kind: 'action', label: 'Ask ' + t + '…', sub: 'send it a task', icon: p.icon || '◆', hay: ['ask specialist', p.name, t].join(' '), run: () => openPage(p.name, { focus: true }), rank: 26 });
    }
    return out;
  }

  const activeRows = () => S.runtime.sessions.filter(s => runOf(s) && ['working', 'permission'].includes(s.claude?.state)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  function homeTiles() {
    const rows = activeRows();
    if (!rows.length) return null;
    if (!HOME.node) HOME.node = h('section', { class: 'sp-home' });
    const key = Math.floor(Date.now() / 60000) + JSON.stringify(rows.map(s => [s.name, s.claude.state, s.claude.since, runLabel(s)])) + V.list.map(p => p.title || p.name).join(',');
    if (HOME.key !== key) {
      HOME.key = key;
      HOME.node.replaceChildren(
        h('h2', { class: 'sp-home-t' }, 'Specialists at work ', h('span', { class: 'n' }, rows.length)),
        ...rows.map(s => {
          const p = V.list.find(x => x.name === ownerOf(s)) || { name: ownerOf(s) };
          const st = runState(s.claude);
          return h('button', { class: 'sp-home-row st-' + st, title: 'open ' + s.name, onclick: () => openTerm(s.name) },
            tile(p), h('span', { class: 'sp-home-n' }, p.title || p.name), h('span', { class: 'sp-home-m' }, runLabel(s)),
            h('span', { class: 'sp-home-s' }, st === 'permission' ? 'needs an answer' : 'working', s.claude.since ? ' · ' + ago(s.claude.since) : ''));
        }));
    }
    return HOME.node;
  }

  const opts = (list, cur) => {
    const items = list.some(([v]) => v === (cur ?? '')) || cur == null ? list : [...list, [cur, cur]];
    return items.map(([v, l]) => h('option', { value: v }, l));
  };
  const select = (list, cur) => { const s = h('select', { class: 'txt' }, opts(list, cur)); s.value = cur ?? ''; return s; };
  const field = (label, el, cls = '') => h('label', { class: 'sp-f ' + cls }, h('span', null, label), el);

  function modelInput(provider, cur) {
    const pick = select(MODELS, isApi(provider) ? '' : cur || '');
    const id = h('input', { class: 'txt', value: isApi(provider) ? cur || '' : '', maxlength: 128, autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    const box = h('span', { class: 'sp-model' }, pick, id);
    const show = p => { pick.classList.toggle('hidden', isApi(p)); id.classList.toggle('hidden', !isApi(p)); id.placeholder = MODEL_HINT[p] || ''; };
    show(provider);
    return { box, show, value: p => isApi(p) ? id.value.trim() || null : pick.value || null };
  }

  function setup(m, close) {
    const onEsc = e => {
      if (!m.querySelector('.spbox')) { document.removeEventListener('keydown', onEsc, true); return; }
      if (e.key !== 'Escape' || m.classList.contains('hidden')) return;
      e.preventDefault(); e.stopPropagation(); close();
    };
    CR.onEsc = onEsc; document.addEventListener('keydown', onEsc, true);
    m.onclick = e => { if (e.target === m) close(); };
  }

  function closeModal() {
    const m = $('#modal'); m.classList.add('hidden');
    if (CR.onEsc) document.removeEventListener('keydown', CR.onEsc, true);
    CR.onEsc = null;
  }

  function openCreate() {
    const m = $('#modal'); m.classList.remove('hidden');
    if (CR.onEsc) document.removeEventListener('keydown', CR.onEsc, true);
    const templates = [{ id: 'blank', title: 'Blank' }, ...V.templates.filter(t => t.id !== 'blank')];
    const err = h('div', { class: 'ns-status hidden' });
    const name = h('input', { class: 'txt', placeholder: 'name, e.g. writer', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', maxlength: 32 });
    const title = h('input', { class: 'txt', placeholder: 'Title', maxlength: 60 });
    const icon = h('input', { class: 'txt sp-icon', placeholder: '◆', maxlength: 8 });
    const desc = h('input', { class: 'txt', placeholder: 'What it does, in one line', maxlength: 300 });
    const tpl = h('select', { class: 'txt' }, templates.map(t => h('option', { value: t.id }, t.title || t.id)));
    const provider = select(PROVIDERS, 'claude');
    const model = modelInput('claude', null);
    const mode = select(MODES, 'run');
    const go = h('button', { class: 'btn primary ns-send' }, 'Create');
    provider.onchange = () => model.show(provider.value);
    const fits = () => NAME_RE.test(name.value.trim()) && !/-$|-company$|-\d{6}-\d{4}|^run$/.test(name.value.trim());
    const sync = () => { go.disabled = !fits(); };
    tpl.onchange = () => { const t = templates.find(x => x.id === tpl.value); icon.placeholder = t?.meta?.icon || '◆'; };
    name.oninput = () => { err.classList.add('hidden'); sync(); };
    const create = async () => {
      if (!fits() || go.disabled) return;
      go.disabled = true; err.classList.add('hidden');
      const body = { name: name.value.trim(), template: tpl.value };
      if (title.value.trim()) body.title = title.value.trim();
      if (icon.value.trim()) body.icon = icon.value.trim();
      if (desc.value.trim()) body.description = desc.value.trim();
      if (provider.value !== 'claude') body.provider = provider.value;
      if (model.value(provider.value)) body.model = model.value(provider.value);
      if (mode.value !== 'run') body.mode = mode.value;
      try {
        const r = await api('specialist', body);
        await refresh(true);
        toast('Created ' + (r.specialist?.title || body.name), 'ok');
        closeModal(); openTrain(body.name);
      } catch (e) { go.disabled = false; err.textContent = e.message; err.classList.remove('hidden'); }
    };
    go.onclick = create;
    for (const el of [name, title, icon, desc]) el.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); create(); } };
    const box = h('div', { class: 'box spbox spcreate' },
      h('div', { class: 'sh' }, h('h3', null, gl('＋ New specialist')), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: closeModal }, ico('x', 15))),
      h('div', { class: 'sp-body' },
        field('Name', name), h('div', { class: 'sp-row' }, field('Title', title, 'grow'), field('Icon', icon)), field('Description', desc),
        h('div', { class: 'sp-row' }, field('Template', tpl, 'grow'), field('Mode', mode, 'grow')),
        h('div', { class: 'sp-row' }, field('Provider', provider, 'grow'), field('Model', model.box, 'grow')), err),
      h('div', { class: 'sp-foot' }, h('span', { class: 'dim sp-note' }, 'Gets its own folder with instructions'), h('span', { class: 'sp' }), go));
    m.replaceChildren(box); setup(m, closeModal);
    sync(); if (!IS_PHONE) name.focus();
  }

  function stateDot(st) { return h('i', { class: 'sp-dot rs-' + st }); }

  const FB = { tracked: new Map(), timer: null, ov: null };
  const FB_POLL_MS = 4000;
  const feedbackError = e => {
    if (e.status === 413) return 'That is too long to send. Shorten the answer or the note.';
    if (e.status === 429) return 'Too much feedback is waiting. Try again once the trainer has caught up.';
    if (e.status === 404) return 'This specialist or run no longer exists.';
    return e.message;
  };
  const feedbackBody = ({ runId, original, better, note }) => {
    const o = String(original || ''), b = String(better || '').trim(), n = String(note || '').trim();
    const changed = !!b && b !== o.trim();
    if (!changed && !n) return { error: 'Change the answer or add a note first.' };
    const body = { original: o };
    if (runId) body.runId = runId;
    if (changed) body.better = String(better);
    if (n) body.note = n;
    return { body };
  };
  const feedbackToast = (msg, kind, action) => {
    const t = h('div', { class: 'toast ' + kind }, msg);
    const host = $('#toasts');
    if (!host) { toast(msg, kind); return; }
    if (action) t.append(h('button', { class: 'btn sm sp-fb-act', type: 'button', onclick: () => { t.remove(); action.run(); } }, action.label));
    host.append(t);
    setTimeout(() => t.remove(), action ? 20000 : 5000);
  };
  const retryFeedback = async (name, title, id) => {
    try { await api('specialist/' + enc(name) + '/train/feedback/' + enc(id) + '/retry', {}); trackFeedback(name, title, id); toast('Sent to training again', 'ok'); }
    catch (e) { toast(feedbackError(e), 'err'); }
  };
  async function pollFeedback() {
    FB.timer = null;
    if (!FB.tracked.size) return;
    if (!document.hidden) {
      const groups = new Map();
      for (const [id, t] of FB.tracked) groups.set(t.name, [...(groups.get(t.name) || []), id]);
      for (const [name, ids] of groups) {
        try {
          const r = await api('specialist/' + enc(name) + '/train/feedback?ids=' + ids.map(enc).join(','));
          const seen = new Set();
          for (const f of r.feedback || []) {
            seen.add(f.id);
            const t = FB.tracked.get(f.id);
            if (!t) continue;
            if (f.state === 'applied') { FB.tracked.delete(f.id); feedbackToast(t.title + ' learned from your note', 'ok'); }
            else if (f.state === 'failed') { FB.tracked.delete(f.id); feedbackToast('Training did not take your note' + (f.error ? ': ' + f.error : '.'), 'err', { label: 'Retry', run: () => retryFeedback(t.name, t.title, f.id) }); }
          }
          for (const id of ids) if (!seen.has(id)) FB.tracked.delete(id);
        } catch (e) { if (e.status === 404) for (const id of ids) FB.tracked.delete(id); }
      }
    }
    if (FB.tracked.size && !FB.timer) FB.timer = setTimeout(pollFeedback, FB_POLL_MS);
  }
  function trackFeedback(name, title, id) {
    FB.tracked.set(id, { name, title });
    if (!FB.timer) FB.timer = setTimeout(pollFeedback, FB_POLL_MS);
  }
  const closeImprove = () => { if (FB.ov) { FB.ov.remove(); FB.ov = null; } };
  function openImprove({ name, title, runId, text }) {
    closeImprove();
    const better = h('textarea', { class: 'sp-fb-better', rows: 9, spellcheck: 'true', 'aria-label': 'Better answer' });
    better.value = text || '';
    const note = h('textarea', { class: 'sp-fb-note', rows: 2, placeholder: 'Why, or what to do differently (optional)', spellcheck: 'true', 'aria-label': 'Note' });
    const status = h('div', { class: 'ns-status hidden' });
    const go = h('button', { class: 'btn primary', type: 'button' }, 'Send');
    const submit = async () => {
      if (go.disabled) return;
      const v = feedbackBody({ runId, original: text, better: better.value, note: note.value });
      if (v.error) { status.textContent = v.error; status.classList.remove('hidden'); return; }
      go.disabled = true; status.classList.add('hidden');
      try {
        const r = await api('specialist/' + enc(name) + '/train/feedback', v.body);
        trackFeedback(name, title, r.feedback.id);
        closeImprove();
        toast('Sent to training', 'ok');
      } catch (e) { go.disabled = false; status.textContent = feedbackError(e); status.classList.remove('hidden'); }
    };
    go.onclick = submit;
    const onKey = ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeImprove(); }
      else if (ev.key === 'Enter' && !ev.isComposing && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); submit(); }
    };
    const box = h('div', { class: 'sp-fb-box' },
      h('div', { class: 'sh' }, h('h3', null, 'Improve this answer')),
      h('div', { class: 'dim sp-fb-help' }, 'Edit it into the version you wanted. ' + title + ' learns from the difference.'),
      better, note, status,
      h('div', { class: 'sp-fb-foot' }, h('span', { class: 'sp' }), h('button', { class: 'btn', type: 'button', onclick: closeImprove }, 'Cancel'), go));
    const ov = h('div', { class: 'sp-fb-ov', onclick: ev => { if (ev.target === ov) closeImprove(); }, onkeydown: onKey }, box);
    FB.ov = ov;
    document.body.append(ov);
    better.focus();
  }
  const improveButton = (name, title, runId, text) => h('button', { class: 'btn sm', type: 'button', title: 'edit this answer into a better one and send it to training', onclick: () => openImprove({ name, title, runId, text }) }, ico('pencil', 13), 'Improve');

  function profileTab(p, onSaved, close) {
    const title = h('input', { class: 'txt', value: p.title || '', maxlength: 60 });
    const icon = h('input', { class: 'txt sp-icon', value: p.icon || '', maxlength: 16 });
    const desc = h('input', { class: 'txt', value: p.description || '', maxlength: 300 });
    const provider = select(PROVIDERS, p.provider || 'claude');
    const model = modelInput(provider.value, p.model); const effort = select(EFFORTS, p.effort || '');
    const mode = select(MODES, p.mode); const perm = select(PERMS, p.permissionMode);
    const account = select([['personal', acct('personal')], ['company', acct('company')]], p.account);
    const claudeOnly = [field('Effort', effort), field('Permissions', perm), field('Account', account)];
    const showProvider = () => { model.show(provider.value); for (const f of claudeOnly) f.classList.toggle('hidden', isApi(provider.value)); };
    provider.onchange = showProvider;
    const ins = h('textarea', { class: 'sp-ins', spellcheck: 'false' }); ins.value = p.instructions || '';
    const err = h('div', { class: 'ns-status hidden' });
    const save = h('button', { class: 'btn primary ns-send' }, 'Save');
    const fail = (msg, reload) => { err.replaceChildren(...[msg, reload ? h('button', { class: 'btn sm ghost sp-reload', onclick: reload }, 'Reload') : null].filter(Boolean)); err.classList.remove('hidden'); };
    save.onclick = async () => {
      const cur = { title: title.value.trim(), icon: icon.value.trim(), description: desc.value.trim(), provider: provider.value, model: model.value(provider.value), effort: effort.value || null, mode: mode.value, permissionMode: perm.value, account: account.value };
      const base = { title: p.title || '', icon: p.icon || '', description: p.description || '', provider: p.provider || 'claude', model: p.model || null, effort: p.effort || null, mode: p.mode, permissionMode: p.permissionMode, account: p.account };
      const body = {}; for (const k of Object.keys(cur)) if (cur[k] !== base[k]) body[k] = cur[k];
      if (body.provider !== undefined) body.model = cur.model;
      if (ins.value !== (p.instructions || '')) body.instructions = ins.value;
      if (!Object.keys(body).length) { toast('Nothing to save'); return; }
      body.ifUpdatedAt = p.updatedAt; save.disabled = true; err.classList.add('hidden');
      try {
        const r = await api('specialist/' + enc(p.name), body);
        toast('Saved', 'ok'); await onSaved(r.specialist);
      } catch (e) { save.disabled = false; fail(e.message, e.status === 409 ? () => onSaved(null) : null); }
    };
    const arch = h('span', { class: 'sp-arch' });
    const askArchive = () => arch.replaceChildren(h('span', { class: 'dim' }, 'Move this profile to the archive?'), h('button', { class: 'btn sm danger solid', onclick: doArchive }, 'Archive'), h('button', { class: 'btn sm ghost', onclick: plain }, 'Cancel'));
    const plain = () => arch.replaceChildren(h('button', { class: 'btn sm danger', onclick: askArchive }, ico('archive', 13), 'Archive'));
    const doArchive = async () => {
      try { await api('specialist/' + enc(p.name) + '/archive', {}); toast('Archived ' + (p.title || p.name), 'ok'); close(); refresh(true); } catch (e) { plain(); fail(e.message); }
    };
    plain(); showProvider();
    return h('div', { class: 'sp-profile' }, h('div', { class: 'sp-scroll' },
      h('div', { class: 'sp-row' }, field('Title', title, 'grow'), field('Icon', icon)),
      field('Description', desc),
      h('div', { class: 'sp-grid' }, field('Provider', provider), field('Model', model.box), field('Mode', mode), ...claudeOnly),
      field('Instructions (CLAUDE.md)', ins), err),
      h('div', { class: 'sp-foot' }, arch, h('span', { class: 'sp' }), save));
  }

  const OPENING_PROMPT = 'What is this specialist for, and how should it behave?';
  const UPLOAD_MAX = 20 * 1024 * 1024;
  const ACCESS_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
  const SOURCE_LABEL = { start: 'start', trainer: 'trainer', upload: 'upload', profile: 'profile', outside: 'outside', undo: 'undo' };
  const CHANGE_LABEL = { added: 'added', modified: 'changed', deleted: 'deleted' };
  const TRAIN_STATE = { working: 'Working…', permission: 'Needs an answer' };
  const TRAINER_RE = /^claude-spec-([a-z0-9][a-z0-9-]{0,31}?)_train(-company)?$/;
  const PAGE_RE = /^claude-spec-([a-z0-9][a-z0-9-]{0,31}?)_page$/;
  const ASK_FILES_MAX = 20;
  const PANEL_KEY = 'bd.spec.trainpanel';
  const POLL_MS = 4000;
  const PAGE_POLL_MS = 5000;
  const PAGE_TICK_MS = 2000;
  const TAB_LABEL = [['files', 'Files'], ['changes', 'What changed'], ['accesses', 'Accesses']];

  const PG_EMPTY = { name: null, tmux: null, cur: null, fresh: false, tab: 'earlier', at: 0, data: null, err: null, files: [], chips: null, key: '', focus: false, panel: false, sheet: false, profile: null, earlier: null, full: new Map(), tx: new Map(), el: null, tabs: null, body: null, scrim: null };
  const PG = { ...PG_EMPTY, timer: null };
  const TR = { name: null, tmux: null, ov: null, err: null, files: [], added: [], fresh: false, panel: store.get(PANEL_KEY) !== '0', sheet: false, tab: 'files', open: new Map(), undoAsk: null, rmAsk: null, more: null, moreFlag: false, busy: false, timer: null, keys: {}, view: null, el: null, tabs: null, body: null, scrim: null };
  const PHANTOM = new Map();

  const trainerOf = tmux => { const m = TRAINER_RE.exec(typeof tmux === 'string' ? tmux : ''); return m ? m[1] : null; };
  const pageOf = tmux => { const m = PAGE_RE.exec(typeof tmux === 'string' ? tmux : ''); return m ? m[1] : null; };
  const pageTmux = name => 'claude-spec-' + name + '_page';
  const specOf = name => V.list.find(x => x.name === name) || { name };
  const pageSpec = () => PG.data?.specialist || specOf(PG.name);
  const trainerTmux = (name, account) => 'claude-spec-' + name + '_train' + (account === 'company' ? '-company' : '');
  const trainBase = () => 'specialist/' + enc(TR.name) + '/train';
  const trainTitle = tmux => {
    const t = trainerOf(tmux); const g = pageOf(tmux);
    if (!t && !g) return null;
    const p = specOf(t || g);
    return t ? 'Train ' + (p.title || t) : p.title || g;
  };
  const termTile = tmux => { const n = trainerOf(tmux) || pageOf(tmux); return n && V.list.some(p => p.name === n) ? tile(specOf(n), 'sm') : null; };
  const trainLive = () => S.runtime.sessions.find(s => s.name === TR.tmux)?.claude || null;
  const pendingNotes = () => (TR.ov?.feedback || []).filter(f => f.state === 'pending').length;
  const trainStatus = () => {
    const cl = trainLive();
    if (cl) return TRAIN_STATE[cl.state] || 'Ready';
    if (!TR.ov) return TR.err ? 'Offline' : 'Loading…';
    return TR.ov.trainer ? 'Stopped' : 'Not started';
  };
  const trainDot = () => { const cl = trainLive(); return !cl ? 'idle' : cl.state === 'working' ? 'working' : cl.state === 'permission' ? 'waiting' : 'done'; };

  function phantom(tmux) {
    const name = trainerOf(tmux) || pageOf(tmux);
    if (!name || !V.list.some(p => p.name === name && valid(p))) return null;
    if (!PHANTOM.has(tmux)) PHANTOM.set(tmux, { mode: 'chat', account: tmux.endsWith('-company') ? 'company' : 'personal' });
    return PHANTOM.get(tmux);
  }

  const trainError = (e, what) => {
    if (e.status === 413) return what === 'upload' ? 'Too big. A file can be 20 MiB at most, and the training folder holds 500 files and 200 MiB.' : e.message;
    if (e.status === 400 && what === 'upload') return 'That file name can not be used. Rename the file and try again.';
    if (e.status === 409 && /busy/.test(e.message)) return 'The trainer is busy with a turn. Try again in a moment.';
    return e.message;
  };

  async function uploadTraining(name, file) {
    const r = await fetch('/api/specialist/' + enc(name) + '/train/upload?filename=' + enc(file.name), { method: 'POST', body: file });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
    return j;
  }

  function diffView(diff, truncated) {
    const cls = l => l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
    return h('div', { class: 'sp-diff' },
      h('pre', null, diff.split('\n').map(l => h('span', { class: 'dl ' + cls(l) }, l + '\n'))),
      truncated ? h('div', { class: 'dim sp-note' }, 'The diff is cut short because it is large.') : null);
  }

  const fail = (el, msg) => { el.replaceChildren(msg || ''); el.classList.toggle('hidden', !msg); };

  function trainViews() {
    const V3 = { chips: h('div', { class: 'sptr-chips hidden' }), upErr: h('div', { class: 'ns-status hidden' }), histErr: h('div', { class: 'ns-status hidden' }), accErr: h('div', { class: 'ns-status hidden' }) };
    V3.fileIn = h('input', { type: 'file', multiple: true, class: 'hidden' });
    V3.drop = h('div', { class: 'sp-drop' });
    V3.usage = h('div', { class: 'dim sp-note' });
    V3.added = h('div', { class: 'sptr-added' });
    V3.hist = h('div', { class: 'sp-hist' });
    V3.acc = h('div', { class: 'sp-accs' });
    V3.accName = h('input', { class: 'txt', placeholder: 'NAME, e.g. DB_URL', maxlength: 64, autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
    V3.accValue = h('input', { class: 'txt', type: 'password', placeholder: 'Value', autocomplete: 'new-password', spellcheck: 'false' });
    V3.accNote = h('input', { class: 'txt', placeholder: 'Note, e.g. read replica', maxlength: 200, autocomplete: 'off' });
    V3.accSave = h('button', { class: 'btn primary' }, 'Save access');
    V3.accHelp = h('div', { class: 'dim sp-note' });
    V3.accName.oninput = () => { V3.accName.value = V3.accName.value.toUpperCase(); fail(V3.accErr, ''); };
    V3.accSave.onclick = saveAccess;
    V3.fileIn.onchange = () => { const fs = [...V3.fileIn.files]; V3.fileIn.value = ''; return addFiles(fs); };
    const hasFiles = ev => [...(ev.dataTransfer?.types || [])].includes('Files');
    V3.drop.addEventListener('dragover', ev => { if (!hasFiles(ev)) return; ev.preventDefault(); V3.drop.classList.add('over'); });
    V3.drop.addEventListener('dragleave', () => V3.drop.classList.remove('over'));
    V3.drop.addEventListener('drop', ev => { if (!hasFiles(ev)) return; ev.preventDefault(); V3.drop.classList.remove('over'); addFiles(ev.dataTransfer.files); });
    V3.drop.replaceChildren(h('span', { class: 'dim' }, 'Drop files here, or '), h('button', { class: 'btn sm', onclick: () => V3.fileIn.click() }, ico('clip', 14), 'Add files'), V3.fileIn,
      h('div', { class: 'dim sp-note' }, 'They go into the knowledge folder. Text, PDF and images, up to 20 MiB each.'));
    V3.files = h('div', { class: 'sptr-view' }, V3.drop, V3.upErr, V3.usage, V3.added);
    V3.changes = h('div', { class: 'sptr-view' }, V3.hist, V3.histErr);
    V3.accesses = h('div', { class: 'sptr-view' }, V3.accHelp, V3.acc, h('div', { class: 'sp-accform' }, V3.accName, V3.accValue, V3.accNote, V3.accSave), V3.accErr);
    return V3;
  }

  const chipRow = (el, files, drop, label) => {
    el.replaceChildren(...files.map(f => h('span', { class: 'badge tag sp-file' }, f.split('/').pop(), h('button', { class: 'sp-x', title: label, 'aria-label': label, onclick: () => drop(f) }, '×'))));
    el.classList.toggle('hidden', !files.length);
  };
  const paintChips = () => {
    const v = TR.view; if (!v) return;
    chipRow(v.chips, TR.files, f => { TR.files = TR.files.filter(x => x !== f); paintChips(); }, 'Do not mention it');
  };
  const paintPageChips = () => {
    if (PG.chips) chipRow(PG.chips, PG.files, f => { PG.files = PG.files.filter(x => x !== f); paintPageChips(); }, 'Remove');
  };
  const placeChips = () => {
    const box = $('#term-chat'); if (!box) return;
    const onPage = !!PG.tmux && TERM.active === PG.tmux;
    const chips = onPage ? PG.chips : TR.view?.chips;
    const reply = box.querySelector('.creply');
    if (onPage && reply) reply.placeholder = pagePlaceholder();
    const field = box.querySelector('.cbox2 .cfield');
    if (field && chips && chips.parentNode !== field) field.insertBefore(chips, field.querySelector('.cline'));
    if (onPage && PG.focus && reply && !IS_PHONE) { PG.focus = false; reply.focus({ preventScroll: true }); }
  };

  async function uploadOne(file) {
    if (file.size > UPLOAD_MAX) throw new Error(trainError({ status: 413, message: '' }, 'upload'));
    const r = await uploadTraining(TR.name, file).catch(e => { throw new Error(trainError(e, 'upload')); });
    if (!TR.files.includes(r.file.path)) TR.files.push(r.file.path);
    if (!TR.added.includes(r.file.path)) TR.added.push(r.file.path);
    paintChips(); placeChips(); paintTrain();
    refreshTrain();
  }

  async function addFiles(list) {
    const files = [...list].filter(Boolean); if (!files.length) return;
    const v = TR.view; fail(v.upErr, '');
    const errors = [];
    v.drop.classList.add('busy');
    for (const f of files) { try { await uploadOne(f); } catch (e) { errors.push(f.name + ': ' + e.message); } }
    v.drop.classList.remove('busy');
    fail(v.upErr, errors.join('\n'));
  }

  async function attachToAsk(file) {
    if (isApi(pageSpec().provider)) throw new Error('OpenAI and xAI specialists only get the text of a task.');
    if (PG.files.length >= ASK_FILES_MAX) throw new Error('At most ' + ASK_FILES_MAX + ' files per task.');
    const path = await uploadFile(file);
    if (!PG.files.includes(path)) PG.files.push(path);
    paintPageChips(); placeChips();
  }

  const attachFile = (tmux, file) => tmux && tmux === TR.tmux ? uploadOne(file) : tmux && tmux === PG.tmux ? attachToAsk(file) : null;

  const runsOf = () => PG.data?.runs || [];
  const curId = () => {
    if (pageSpec().mode === 'thread') return runsOf()[0]?.runId || null;
    if (PG.fresh) return null;
    return PG.cur || runsOf()[0]?.runId || null;
  };
  const curRun = () => { const f = PG.full.get(curId()); return f && !f.failed ? f : null; };
  const pagePlaceholder = () => curRun() ? 'Reply to ' + (pageSpec().title || PG.name) + '…' : 'Ask ' + (pageSpec().title || PG.name) + '…';
  const withFiles = text => PG.files.length ? text + '\n\nFiles for this task:\n' + PG.files.map(f => '- ' + f).join('\n') : text;

  const adopt = r => {
    PG.full.set(r.runId, r); PG.tx.delete(r.runId);
    PG.cur = r.runId; PG.fresh = false; PG.files = [];
    paintPageChips(); renderTermPanel(); paintPage();
    refresh(true); loadPage();
  };

  async function sendAsk(text) {
    const id = curId();
    const run = id && pageSpec().mode !== 'thread' ? PG.full.get(id) || await fetchRun(id) : null;
    if (run && !run.failed) {
      if (!isFinal(run)) throw new Error('Still working on your last message. Send the next one when it has answered.');
      try {
        const r = await api('specialist/run/' + enc(run.runId) + '/send', { text: withFiles(text) });
        adopt(r);
        return r;
      } catch (e) { if (!(e.status === 409 && /provider/i.test(e.message))) throw e; }
    }
    const body = { text, wait: false };
    if (PG.files.length) body.files = PG.files;
    const r = await api('specialist/' + enc(PG.name) + '/ask', body);
    adopt(r);
    return r;
  }

  async function sendTrain(text) {
    const body = { text };
    if (TR.files.length) body.files = TR.files;
    if (TR.fresh) body.fresh = true;
    const r = await api(trainBase() + '/send', body).catch(e => { throw Object.assign(new Error(trainError(e, 'send')), { status: e.status }); });
    TR.files = []; TR.fresh = false;
    if (TR.ov) TR.ov.trainer = r.trainer;
    paintChips(); renderTermPanel();
    for (const ms of [1200, 3500]) setTimeout(refreshTrain, ms);
    refreshTrain();
    return r;
  }

  const sendMessage = (tmux, text) => tmux && tmux === TR.tmux ? sendTrain(text) : tmux && tmux === PG.tmux ? sendAsk(text) : null;

  function emptyChat(tmux) {
    if (tmux && tmux === PG.tmux) return pageEmpty();
    if (!trainerOf(tmux)) return null;
    return h('div', { class: 'turn assistant sptr-open' }, h('div', { class: 'who' }, gl('✦ trainer')),
      h('div', { class: 'ttext' }, TR.ov?.trainer ? 'This trainer is stopped. Your next message resumes it.' : OPENING_PROMPT));
  }

  const loadCommit = async c => {
    try { const r = await api(trainBase() + '/commit/' + enc(c.id)); TR.open.set(c.id, { diff: r.diff, truncated: r.truncated, files: r.commit?.files || c.files }); } catch (e) { TR.open.set(c.id, { error: e.message }); }
    paintHist(true);
  };
  const toggleCommit = c => {
    if (TR.open.has(c.id)) { TR.open.delete(c.id); paintHist(true); return; }
    TR.open.set(c.id, { loading: true }); paintHist(true); loadCommit(c);
  };
  const doUndo = async c => {
    TR.undoAsk = null; fail(TR.view.histErr, '');
    try { await api(trainBase() + '/undo', { commit: c.id }); toast('Change undone', 'ok'); TR.more = null; await refreshTrain(); } catch (e) { fail(TR.view.histErr, trainError(e, 'undo')); paintHist(true); }
  };
  const commitRow = c => {
    const o = TR.open.get(c.id);
    const canUndo = c.source !== 'start' && !c.undone;
    const acts = TR.undoAsk === c.id
      ? [h('span', { class: 'dim' }, 'Undo this change?'), h('button', { class: 'btn sm danger solid', onclick: () => doUndo(c) }, 'Undo'), h('button', { class: 'btn sm ghost', onclick: () => { TR.undoAsk = null; paintHist(true); } }, 'Cancel')]
      : [h('button', { class: 'btn sm ghost', onclick: () => toggleCommit(c) }, o ? 'Hide' : 'View'), canUndo ? h('button', { class: 'btn sm', onclick: () => { TR.undoAsk = c.id; paintHist(true); } }, 'Undo') : null];
    return h('div', { class: 'sp-commit' + (c.undone ? ' undone' : '') },
      h('div', { class: 'sp-crow' },
        h('div', { class: 'sp-cm' }, h('div', { class: 'sp-ct' }, c.message || c.short), h('div', { class: 'dim sp-cs' }, h('span', { class: 'badge tag' }, SOURCE_LABEL[c.source] || c.source), ' ', ago(c.at) + ' ago', c.undone ? ' · undone' : '')),
        h('div', { class: 'sp-cacts' }, acts)),
      o ? h('div', { class: 'sp-cdetail' },
        o.loading ? h('div', { class: 'dim' }, 'Loading…') : o.error ? h('div', { class: 'ns-status' }, o.error) : [
          h('div', { class: 'sp-cfiles' }, (o.files || []).map(f => h('span', { class: 'badge tag' }, f.path + ' · ' + (CHANGE_LABEL[f.change] || f.change)))),
          o.diff ? diffView(o.diff, o.truncated) : h('div', { class: 'dim' }, 'No text changes.')]) : null);
  };
  const loadMore = async () => {
    const list = TR.more || TR.ov?.history?.commits || []; const last = list[list.length - 1]; if (!last) return;
    try { const r = await api(trainBase() + '/history?limit=50&before=' + enc(last.id)); TR.more = [...list, ...r.commits]; TR.moreFlag = r.more; paintHist(true); } catch (e) { fail(TR.view.histErr, e.message); }
  };
  function paintHist(force) {
    const v = TR.view; if (!v) return;
    const commits = TR.more || TR.ov?.history?.commits || [];
    const more = TR.more ? TR.moreFlag : commits.length >= 20;
    const key = JSON.stringify([commits.map(c => [c.id, c.undone]), more, TR.ov?.history?.ready]);
    if (!force && TR.keys.hist === key) return;
    TR.keys.hist = key;
    v.hist.replaceChildren(...[...(commits.length ? commits.map(commitRow) : [h('div', { class: 'dim sp-none' }, TR.ov?.history?.ready ? 'No changes yet.' : 'Nothing yet. Changes show here after the first message or upload.')]),
      more ? h('button', { class: 'btn sm ghost', onclick: loadMore }, 'Show older') : null].filter(Boolean));
  }

  const removeAccess = async a => {
    TR.rmAsk = null; fail(TR.view.accErr, '');
    try { await api('specialist/' + enc(TR.name) + '/accesses/' + enc(a.name) + '/delete', {}); toast('Removed ' + a.name, 'ok'); await refreshTrain(); } catch (e) { fail(TR.view.accErr, e.message); paintAcc(true); }
  };
  async function saveAccess() {
    const v = TR.view;
    const n = v.accName.value.trim(); const val = v.accValue.value;
    if (!ACCESS_RE.test(n)) { fail(v.accErr, 'Use a name like DB_URL: capital letters, digits and underscores.'); return; }
    if (!val) { fail(v.accErr, 'Type the value.'); return; }
    v.accSave.disabled = true; fail(v.accErr, '');
    const body = { name: n, value: val };
    if (v.accNote.value.trim()) body.note = v.accNote.value.trim();
    try { await api('specialist/' + enc(TR.name) + '/accesses', body); v.accValue.value = ''; v.accName.value = ''; v.accNote.value = ''; toast('Saved ' + n, 'ok'); await refreshTrain(); } catch (e) { fail(v.accErr, e.message); }
    v.accSave.disabled = false;
  }
  function paintAcc(force) {
    const v = TR.view; if (!v) return;
    const list = TR.ov?.accesses || [];
    const key = JSON.stringify([list.map(a => [a.name, a.note, a.updatedAt]), TR.rmAsk]);
    const provider = V.list.find(p => p.name === TR.name)?.provider;
    v.accHelp.replaceChildren('The trainer sees the names and notes, never the values.' + (isApi(provider) ? ' OpenAI and xAI specialists do not get accesses.' : ' Claude runs get them as environment variables.'));
    if (!force && TR.keys.acc === key) return;
    TR.keys.acc = key;
    v.acc.replaceChildren(...(list.length ? list.map(a => h('div', { class: 'sp-acc' },
      h('div', { class: 'sp-cm' }, h('div', { class: 'sp-ct mono' }, a.name), h('div', { class: 'dim sp-cs' }, a.note || 'No note', ' · value saved')),
      h('div', { class: 'sp-cacts' }, TR.rmAsk === a.name
        ? [h('span', { class: 'dim' }, 'Remove it?'), h('button', { class: 'btn sm danger solid', onclick: () => removeAccess(a) }, 'Remove'), h('button', { class: 'btn sm ghost', onclick: () => { TR.rmAsk = null; paintAcc(true); } }, 'Cancel')]
        : [h('button', { class: 'btn sm', onclick: () => { v.accName.value = a.name; v.accNote.value = a.note || ''; v.accValue.focus(); } }, 'Replace'), h('button', { class: 'btn sm danger', onclick: () => { TR.rmAsk = a.name; paintAcc(true); } }, 'Remove')]))) : [h('div', { class: 'dim sp-none' }, 'No accesses yet.')]));
  }

  function paintFiles() {
    const v = TR.view; if (!v) return;
    const u = TR.ov?.uploads;
    v.usage.textContent = u ? plural(u.files, 'file') + ' in the knowledge folder, ' + Math.ceil(u.bytes / 1024) + ' KiB of ' + Math.round(u.maxBytes / 1048576) + ' MiB' : '';
    v.added.replaceChildren(...(TR.added.length ? [h('div', { class: 'sptr-h' }, 'Added in this chat'), ...TR.added.map(f => h('div', { class: 'sptr-file' }, ico('file', 14), h('span', { class: 'sptr-fn' }, f.split('/').pop())))] : []));
  }

  function paintTrain() {
    const v = TR.view; if (!v || !TR.tabs) return;
    const count = { files: TR.ov?.uploads?.files, changes: null, accesses: TR.ov ? (TR.ov.accesses || []).length : null };
    TR.tabs.replaceChildren(...TAB_LABEL.map(([k, l]) => h('button', { class: 'segb' + (TR.tab === k ? ' on' : ''), onclick: () => { TR.tab = k; paintTrain(); } }, l, count[k] ? h('span', { class: 'sptr-n' }, count[k]) : null)));
    TR.body.replaceChildren(v[TR.tab]);
    paintFiles(); paintHist(); paintAcc();
  }

  async function refreshTrain() {
    const tmux = TR.tmux; if (!tmux || TR.busy) return;
    TR.busy = true;
    try { const ov = await api(trainBase()); if (TR.tmux === tmux) { TR.ov = ov; TR.err = null; } } catch (e) { if (TR.tmux === tmux) TR.err = e.message; }
    TR.busy = false;
    if (TR.tmux !== tmux) return;
    paintTrain(); renderTermPanel();
  }

  const closePanel = o => { if (IS_PHONE) o.sheet = false; else { o.panel = false; if (o === TR) store.set(PANEL_KEY, '0'); } mountPanel(o); renderTermPanel(); };
  function buildPanel(o, title, tabs) {
    const p = specOf(o.name);
    o.tabs = tabs ? h('div', { class: 'seg sptr-tabs' }) : null;
    o.body = h('div', { class: 'sptr-body' });
    o.scrim = h('div', { class: 'sptr-scrim', onclick: () => closePanel(o) });
    o.el = h('div', { class: 'sptr-panel' },
      h('div', { class: 'sptr-grab' }),
      h('div', { class: 'sptr-top' }, tile(p), h('div', { class: 'sptr-tt' }, h('b', null, title), h('span', { class: 'dim' }, p.title || p.name)), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close', 'aria-label': 'close', onclick: () => closePanel(o) }, ico('x', 15))),
      ...(o.tabs ? [o.tabs] : []), o.body);
  }

  function mountPanel(o) {
    const main = $('.termmain'); const el = o.el; if (!main || !el) return;
    const open = IS_PHONE ? o.sheet : o.panel;
    if (!open) { main.classList.remove('sptr-open'); o.scrim.remove(); if (el.parentNode) { el.classList.add('leaving'); setTimeout(() => { if (el.classList.contains('leaving')) el.remove(); }, 240); } return; }
    el.classList.remove('leaving'); el.classList.toggle('sheet', IS_PHONE);
    if (IS_PHONE) { document.body.append(o.scrim, el); main.classList.remove('sptr-open'); return; }
    const bar = $('#term-bar');
    if (bar) main.style.setProperty('--sptr-top', (bar.offsetTop + bar.offsetHeight) + 'px');
    o.scrim.remove();
    main.classList.add('sptr-open');
    if (el.parentNode !== main) main.append(el);
  }

  function togglePanel(o) {
    if (IS_PHONE) o.sheet = !o.sheet;
    else { o.panel = !o.panel; if (o === TR) store.set(PANEL_KEY, o.panel ? '1' : '0'); if (o.panel) feat('rightOpen', 'trainpanel'); }
    mountPanel(o); renderTermPanel();
  }
  const toggleFresh = () => { TR.fresh = !TR.fresh; if (TR.fresh) toast('Your next message starts a new conversation. The old one is kept.'); renderTermPanel(); };

  function teardownTrain() {
    if (!TR.tmux) return;
    clearInterval(TR.timer); TR.timer = null;
    const main = $('.termmain'); if (main) main.classList.remove('sptr-open');
    if (TR.el) TR.el.remove();
    if (TR.scrim) TR.scrim.remove();
    if (TR.view) TR.view.chips.remove();
    Object.assign(TR, { name: null, tmux: null, ov: null, err: null, files: [], added: [], fresh: false, sheet: false, tab: 'files', open: new Map(), undoAsk: null, rmAsk: null, more: null, moreFlag: false, busy: false, keys: {}, view: null, el: null, tabs: null, body: null, scrim: null });
  }

  function startTrain(name, tmux) {
    teardownTrain();
    Object.assign(TR, { name, tmux, view: trainViews() });
    buildPanel(TR, 'Training', true); paintTrain();
    TR.timer = setInterval(() => {
      if (!(TERM.open && TERM.active === TR.tmux)) { teardownTrain(); return; }
      if (!document.hidden) refreshTrain();
    }, POLL_MS);
    refreshTrain();
  }

  function termShown() {
    const tmux = TERM.open ? TERM.active : null;
    const known = name => !!name && V.list.some(p => p.name === name && valid(p));
    const trainer = trainerOf(tmux); const page = pageOf(tmux);
    if (known(trainer)) {
      teardownPage();
      if (TR.tmux !== tmux) startTrain(trainer, tmux);
      mountPanel(TR);
    } else if (known(page)) {
      teardownTrain();
      if (PG.tmux !== tmux) startPage(page, tmux);
      mountPanel(PG);
    } else { teardownTrain(); teardownPage(); }
  }

  const rightOpen = which => {
    if (which === 'trainpanel' || IS_PHONE) return;
    for (const o of [TR, PG]) if (o.tmux && o.panel) { o.panel = false; mountPanel(o); renderTermPanel(); }
  };

  const pageTabs = () => pageSpec().mode === 'thread' ? [['profile', 'Profile']] : [['earlier', 'Earlier'], ['profile', 'Profile']];
  const panelOpen = () => IS_PHONE ? PG.sheet : PG.panel;
  function openPanelTab(tab) {
    if (panelOpen() && PG.tab === tab) { togglePanel(PG); return; }
    PG.tab = tab; paintPanel();
    if (!panelOpen()) togglePanel(PG); else renderTermPanel();
  }
  function toggleFreshPage() {
    PG.fresh = !PG.fresh; PG.cur = null;
    if (PG.fresh) toast('Your next message starts a new conversation. The old one is kept.');
    renderTermPanel(); paintPage(); loadConv();
  }

  function pageBar() {
    const p = pageSpec(); const open = panelOpen(); const runMode = p.mode !== 'thread';
    return [
      h('span', { class: 'sppage-chips desk' },
        isApi(p.provider) ? h('span', { class: 'badge tag' }, providerLabel(p.provider)) : null,
        h('span', { class: 'badge tag' }, modelLabel(p.model, p.provider)),
        h('span', { class: 'badge tag' }, runMode ? 'Fresh run per task' : 'Thread'),
        !isApi(p.provider) && p.account && p.account !== 'personal' ? h('span', { class: 'badge tag acc ' + p.account }, acct(p.account)) : null),
      runMode ? h('button', { class: 'btn sm ghost sptr-btn' + (PG.fresh ? ' on' : ''), title: 'The next message starts a new conversation. The old one is kept.', 'aria-pressed': PG.fresh ? 'true' : 'false', onclick: toggleFreshPage }, ico('plus', 14), h('span', { class: 'desk' }, PG.fresh ? 'New conversation: on' : 'New conversation')) : null,
      runMode ? h('button', { class: 'btn sm ghost sptr-btn' + (open && PG.tab === 'earlier' ? ' on' : ''), title: 'Earlier conversations', 'aria-pressed': open && PG.tab === 'earlier' ? 'true' : 'false', onclick: () => openPanelTab('earlier') }, ico('clock', 14), h('span', { class: 'desk' }, 'Earlier')) : null,
      h('button', { class: 'btn sm ghost sptr-btn', title: 'talk to the trainer', onclick: () => openTrain(PG.name) }, ico('brain', 14), h('span', { class: 'desk' }, 'Train')),
      h('button', { class: 'btn sm ghost sptr-btn' + (open && PG.tab === 'profile' ? ' on' : ''), title: 'Instructions, settings and archive', 'aria-pressed': open && PG.tab === 'profile' ? 'true' : 'false', onclick: () => openPanelTab('profile') }, ico('gear', 14), h('span', { class: 'desk' }, 'Profile'))
    ];
  }
  const pageBarKey = tmux => {
    if (!tmux || tmux !== PG.tmux) return null;
    const p = pageSpec();
    return [PG.panel, PG.sheet, PG.tab, PG.fresh, p.model, p.mode, p.provider, p.account];
  };

  function termBar(tmux) {
    if (tmux && tmux === PG.tmux) return pageBar();
    if (!trainerOf(tmux) || tmux !== TR.tmux) return null;
    const notes = pendingNotes(); const open = IS_PHONE ? TR.sheet : TR.panel;
    return [
      h('span', { class: 'sptr-stat', title: 'The trainer: ' + trainStatus() + (notes ? ', ' + plural(notes, 'feedback note') + ' waiting' : '') },
        h('i', { class: 'sp-dot rs-' + trainDot() }), h('span', { class: 'sptr-st desk' }, trainStatus()), notes ? h('span', { class: 'badge tag desk' }, plural(notes, 'note') + ' waiting') : null),
      h('button', { class: 'btn sm ghost sptr-btn' + (TR.fresh ? ' on' : ''), title: 'The next message starts a new conversation. The old one is kept.', 'aria-pressed': TR.fresh ? 'true' : 'false', onclick: toggleFresh }, ico('plus', 14), h('span', { class: 'desk' }, TR.fresh ? 'New conversation: on' : 'New conversation')),
      h('button', { class: 'btn sm ghost sptr-btn' + (open ? ' on' : ''), title: 'Files, what changed and accesses', 'aria-pressed': open ? 'true' : 'false', onclick: () => togglePanel(TR) }, ico('brain', 14), h('span', { class: 'desk' }, 'Training'))
    ];
  }
  const trainBarKey = tmux => trainerOf(tmux) && tmux === TR.tmux ? [TR.fresh, TR.panel, TR.sheet, pendingNotes(), trainStatus()] : null;

  function backTo(tmux) {
    const name = trainerOf(tmux);
    if (!name) return null;
    const p = V.list.find(x => x.name === name);
    return { title: 'back to ' + (p?.title || name), go: () => openPage(name) };
  }

  function openTrain(name) {
    const p = V.list.find(x => x.name === name);
    openTerm(trainerTmux(name, p?.account));
  }

  const askNote = () => pageSpec().mode === 'thread' ? 'It keeps one thread. Each message goes into it.' : 'Each new conversation is its own run.';

  function pageEmpty() {
    const p = pageSpec();
    return h('div', { class: 'sppage' },
      p.description ? h('div', { class: 'sppage-desc' }, p.description) : null,
      isApi(p.provider) && p.keyError ? h('div', { class: 'ns-status' }, p.keyError) : null,
      PG.data ? h('div', { class: 'sppage-empty' }, tile(p, 'md'), h('b', null, 'Ask ' + (p.title || PG.name) + ' something'), h('span', { class: 'dim' }, askNote())) : h('div', { class: 'dim sp-none' }, PG.err || 'Loading…'));
  }

  async function fetchRun(id) {
    const tmux = PG.tmux;
    try { const r = await api('specialist/run/' + enc(id)); if (PG.tmux === tmux) PG.full.set(id, r); return r; }
    catch (e) { const r = { error: e.message, failed: true }; if (PG.tmux === tmux && !PG.full.get(id)) PG.full.set(id, r); return PG.full.get(id) || r; }
  }

  async function loadConv() {
    const tmux = PG.tmux; const id = curId(); if (!tmux || !id) return;
    const known = PG.full.get(id);
    if (!known || known.failed || !isFinal(known)) await fetchRun(id);
    if (PG.tmux !== tmux || curId() !== id) return;
    const run = PG.full.get(id);
    if (!run || run.failed) { paintPage(); return; }
    const sig = [run.state, run.turns, run.endedAt].join(':');
    if (!isFinal(run) || PG.tx.get(id)?.sig !== sig) {
      const t = await api('transcript/' + enc(run.tmux || id) + '?n=60').catch(() => null);
      if (PG.tmux !== tmux) return;
      PG.tx.set(id, { sig, t });
    }
    paintPage();
  }

  const stepsText = turn => (turn.steps || []).filter(x => x.k === 'text').map(x => x.text).join('\n\n');
  const turnsOf = run => {
    const tx = PG.tx.get(run.runId)?.t;
    const turns = tx?.turns?.length ? [...tx.turns] : [];
    if (!turns.length && run.task) turns.push({ role: 'user', text: run.task, ts: run.startedAt, h: 'u' + run.runId });
    const answered = turns.length && turns[turns.length - 1].role === 'assistant';
    if (!answered && isFinal(run) && (run.text || run.error)) turns.push({ role: 'assistant', steps: [{ k: 'text', text: run.text || 'It could not finish: ' + run.error }], ts: run.endedAt, h: 'a' + run.runId + ':' + (run.text || run.error || '').length });
    return turns;
  };

  function transcript(tmux) {
    if (!tmux || tmux !== PG.tmux) return null;
    const run = curRun();
    if (!run) return { total: 0, turns: [], size: 0, pending: null, more: false, empty: true, sig: ['empty', !!PG.data, PG.err, pageSpec().title, pageSpec().description, pageSpec().keyError, curId()].join(':') };
    const turns = turnsOf(run); const live = !isFinal(run); const tx = PG.tx.get(run.runId)?.t;
    return { total: turns.length, turns, size: 0, pending: live ? 'working' : null, since: live ? tx?.since || run.startedAt : null, more: false, sig: [run.runId, run.state, tx?.sig, turns.length, (run.text || '').length].join(':') };
  }

  const keyTarget = tmux => {
    if (tmux !== PG.tmux) return null;
    const run = curRun();
    return run && !isFinal(run) ? run.tmux || run.runId : null;
  };

  function answerActions(turn) {
    const text = stepsText(turn); if (!text) return null;
    return h('div', { class: 'sppage-acts' },
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Copied', 'ok'), () => toast('Could not copy', 'err')) }, ico('copy', 13), 'Copy'),
      improveButton(PG.name, pageSpec().title || PG.name, curId(), text));
  }

  function conversation(tmux, conv) {
    if (!tmux || tmux !== PG.tmux) return;
    for (const el of conv.children) {
      const turn = el._turn;
      if (!turn || turn.role !== 'assistant' || el.querySelector(':scope > .sppage-acts')) continue;
      const acts = answerActions(turn);
      if (acts) el.append(acts);
    }
  }

  function earlierRow(r) {
    const st = r.state || 'done';
    return h('button', { class: 'sppage-card rs-' + st + (curId() === r.runId ? ' on' : ''), type: 'button', onclick: () => pickRun(r.runId) },
      h('div', { class: 'sppage-task' }, firstLine(r.task) || r.runId),
      h('div', { class: 'sppage-foot' }, stateDot(st), h('span', { class: 'sppage-st' }, RUN_STATE[st] || st), h('span', { class: 'sp' }), h('span', { class: 'dim' }, ago(r.startedAt) + ' ago')));
  }

  function pickRun(id) {
    PG.cur = id; PG.fresh = false;
    if (IS_PHONE) PG.sheet = false;
    mountPanel(PG); renderTermPanel(); paintPage(); loadConv();
  }

  function paintEarlier() {
    const runs = runsOf();
    PG.earlier.replaceChildren(...(runs.length ? runs.map(earlierRow) : [h('div', { class: 'dim sp-none' }, PG.data ? 'No earlier conversations yet.' : PG.err || 'Loading…')]));
  }

  function paintPanel() {
    if (!PG.body) return;
    const d = PG.data?.specialist;
    if (!d) { if (!PG.body.firstChild) PG.body.replaceChildren(h('div', { class: 'dim sp-none' }, PG.err || 'Loading…')); return; }
    const tabs = pageTabs();
    if (!tabs.some(([k]) => k === PG.tab)) PG.tab = tabs[0][0];
    PG.tabs.classList.toggle('hidden', tabs.length < 2);
    PG.tabs.replaceChildren(...tabs.map(([k, l]) => h('button', { class: 'segb' + (PG.tab === k ? ' on' : ''), onclick: () => { PG.tab = k; paintPanel(); renderTermPanel(); } }, l)));
    if (!PG.profile) PG.profile = profileTab(d, async () => { PG.profile = null; await loadPage(); refresh(true); }, () => closeTermPanel());
    paintEarlier();
    const view = PG.tab === 'profile' ? PG.profile : PG.earlier;
    if (PG.body.firstChild !== view || PG.body.childNodes.length !== 1) PG.body.replaceChildren(view);
  }

  function paintPage() {
    if (!pageShown()) return;
    paintPanel();
    const key = JSON.stringify([transcript(PG.tmux)?.sig, curId(), PG.data?.runs?.map(r => r.runId + r.state).join(',')]);
    if (key === PG.key) return;
    PG.key = key;
    if (typeof renderChatPane === 'function') renderChatPane(true);
    placeChips();
  }

  async function loadPage() {
    const tmux = PG.tmux; if (!tmux) return;
    PG.at = Date.now();
    try {
      const r = await api('specialist/' + enc(PG.name) + '?runs=50');
      if (PG.tmux !== tmux) return;
      PG.data = r; PG.err = null;
      if (pageShown()) {
        const fresh = (r.runs || []).filter(x => isFinal(x) && (FIN.has(x.runId) || (x.endedAt || 0) > SEEN.since) && !SEEN.ids.has(x.runId));
        for (const x of fresh) { FIN.delete(x.runId); markSeen(x.runId, x.endedAt); }
        if (fresh.length) announce();
      }
    } catch (e) { if (PG.tmux === tmux) PG.err = e.message; }
    if (PG.tmux !== tmux) return;
    paintPage();
    await loadConv();
  }
  const working = () => { const r = curRun(); return !!r && !isFinal(r); };

  function startPage(name, tmux) {
    teardownPage();
    Object.assign(PG, { ...PG_EMPTY, full: new Map(), files: [], name, tmux, chips: h('div', { class: 'sptr-chips hidden' }), earlier: h('div', { class: 'sptr-view' }) });
    buildPanel(PG, 'Specialist', true);
    paintPage(); loadPage();
    PG.timer = setInterval(() => {
      if (!pageShown()) { teardownPage(); return; }
      if (!document.hidden && (working() || Date.now() - PG.at >= PAGE_POLL_MS - 200)) loadPage();
    }, PAGE_TICK_MS);
  }

  function teardownPage() {
    if (!PG.tmux) return;
    clearInterval(PG.timer); PG.timer = null;
    const main = $('.termmain'); if (main) main.classList.remove('sptr-open');
    if (PG.el) PG.el.remove();
    if (PG.scrim) PG.scrim.remove();
    if (PG.chips) PG.chips.remove();
    Object.assign(PG, { ...PG_EMPTY, full: new Map(), files: [] });
  }

  function openPage(name, o = {}) {
    const tmux = pageTmux(name);
    openTerm(tmux);
    if (PG.tmux !== tmux) return;
    PG.focus = !!o.focus;
    if (o.run) { PG.cur = o.run; PG.fresh = false; }
    PG.key = ''; paintPage(); loadConv();
    placeChips();
  }

  setInterval(() => { if (!document.hidden) refresh(true); }, 30000);

  return { phantom, noTranscript: tmux => !!pageOf(tmux), transcript, keyTarget, conversation, trainSend: sendMessage, attachFile, termBar, termShown, rightOpen, composerShown: placeChips, emptyChat, trainTitle, termTile, openTrain, backTo, onState, termBarKey, railSection, paletteItems, homeTiles, unseenRuns, dismissRun, markSeen: seenByUser, trimSeen, feedbackBody, feedbackError, trackFeedback, pollFeedback, improve: openImprove, openRun, open: openPage, create: openCreate, refresh };
})();
