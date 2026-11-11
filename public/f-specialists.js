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
  const PG = { name: null, tab: 'runs', data: null, timer: null, full: new Map(), shown: new Set(), onEsc: null, box: null };
  const ASK = { name: null, box: null };
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
  const askShown = () => !!ASK.box && $('#modal').contains(ASK.box);
  const watching = r => (PG.name === r.specialist && pageShown()) || (ASK.name === r.specialist && askShown()) || (!!TERM.open && TERM.active === r.tmux);
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
  }

  const pageShown = () => !!PG.name && !!PG.box && $('#modal').contains(PG.box);
  const keyOf = () => [V.ok, PG.name, pageShown(), V.list.map(p => [p.name, p.title, p.icon, p.provider, p.model, p.active, p.error, p.thread?.state, p.description]), V.list.map(p => runSessions(p.name).map(s => [s.name, s.claude?.state, s.claude?.needsYou, s.claude?.title, s.claude?.firstPrompt, s.claude?.label]))];
  const termBarKey = () => keyOf();

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
        { kind: 'action', label: 'Ask ' + t + '…', sub: 'send it a task', icon: p.icon || '◆', hay: ['ask specialist', p.name, t].join(' '), run: () => openAsk(p.name), rank: 26 });
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

  function openAsk(name) {
    const p = V.list.find(x => x.name === name) || { name };
    const t = p.title || name;
    const m = $('#modal'); m.classList.remove('hidden');
    if (PG.onEsc) document.removeEventListener('keydown', PG.onEsc, true);
    clearInterval(PG.timer); PG.timer = null; PG.name = null; PG.box = null;
    const mode = { wait: true };
    const text = h('textarea', { class: 'sp-ask', rows: 4, placeholder: 'Ask ' + t + '…' });
    const status = h('div', { class: 'ns-status hidden' });
    const go = h('button', { class: 'btn primary ns-send' }, 'Ask');
    const hint = h('span', { class: 'dim sp-note' });
    const seg = h('span', { class: 'seg ns-tabs' });
    const paintSeg = () => {
      seg.replaceChildren(...[[true, 'Wait here'], [false, 'Notify me']].map(([v, l]) => h('button', { class: 'segb' + (mode.wait === v ? ' on' : ''), onclick: () => { mode.wait = v; paintSeg(); } }, l)));
      hint.textContent = mode.wait ? 'Shows the run when it is done' : 'Lands in the Inbox when it is done';
    };
    const send = async () => {
      const body = text.value.trim(); if (!body || go.disabled) return;
      const wait = mode.wait;
      go.disabled = true; text.disabled = true; status.classList.add('hidden');
      ASK.name = name; ASK.box = box;
      if (wait) { status.textContent = 'Waiting for ' + t + '…'; status.classList.remove('hidden'); }
      try {
        const r = await api('specialist/' + enc(name) + '/ask', wait ? { text: body, wait: true, timeoutSec: 300 } : { text: body, wait: false });
        const here = askShown();
        if (wait && here && isFinal(r)) { markSeen(r.runId, r.endedAt); FIN.delete(r.runId); }
        ASK.name = null; ASK.box = null;
        if (wait && here) openPage(name, { run: r.runId });
        else if (!wait && here) { closeModal(); toast('Asked ' + t + '. It lands in the Inbox when done.', 'ok'); }
        refresh(true);
      } catch (e) {
        ASK.name = null; ASK.box = null;
        go.disabled = false; text.disabled = false; status.textContent = e.message; status.classList.remove('hidden');
      }
    };
    go.onclick = send;
    text.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing && ((e.metaKey || e.ctrlKey) || (!IS_PHONE && !e.shiftKey))) { e.preventDefault(); send(); } };
    const box = h('div', { class: 'box spbox spcreate spask' },
      h('div', { class: 'sh' }, tile(p), h('h3', null, 'Ask ' + t), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: closeModal }, ico('x', 15))),
      h('div', { class: 'sp-body' }, text, status),
      h('div', { class: 'sp-foot' }, seg, hint, h('span', { class: 'sp' }), go));
    paintSeg();
    m.replaceChildren(box); PG.box = box; setup(m, closeModal);
    if (!IS_PHONE) text.focus();
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
    PG.onEsc = onEsc; document.addEventListener('keydown', onEsc, true);
    m.onclick = e => { if (e.target === m) close(); };
  }

  function closeModal() {
    const m = $('#modal'); m.classList.add('hidden');
    if (PG.onEsc) document.removeEventListener('keydown', PG.onEsc, true);
    PG.onEsc = null; clearInterval(PG.timer); PG.timer = null; PG.name = null; PG.box = null; ASK.box = null;
    renderRail();
  }

  function openCreate() {
    const m = $('#modal'); m.classList.remove('hidden');
    if (PG.onEsc) document.removeEventListener('keydown', PG.onEsc, true);
    clearInterval(PG.timer); PG.timer = null; PG.name = null;
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
        openPage(body.name, { tab: 'train', focus: true });
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
    m.replaceChildren(box); PG.box = box; setup(m, closeModal);
    sync(); if (!IS_PHONE) name.focus();
  }

  function stateDot(st) { return h('i', { class: 'sp-dot rs-' + st }); }

  async function loadPage() {
    if (!PG.name) return;
    const name = PG.name;
    try {
      const r = await api('specialist/' + enc(name) + '?runs=50');
      if (PG.name !== name) return;
      PG.data = r; PG.err = null;
      if (pageShown()) {
        const fresh = (r.runs || []).filter(x => isFinal(x) && (FIN.has(x.runId) || (x.endedAt || 0) > SEEN.since) && !SEEN.ids.has(x.runId));
        for (const x of fresh) { FIN.delete(x.runId); markSeen(x.runId, x.endedAt); }
        if (fresh.length) announce();
      }
    } catch (e) { if (PG.name === name) PG.err = e.message; }
    if (PG.name === name) PG.paint && PG.paint();
  }

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

  async function showRunText(r, slot) {
    if (!PG.full.has(r.runId) || !isFinal(PG.full.get(r.runId))) {
      try { PG.full.set(r.runId, await api('specialist/run/' + enc(r.runId))); } catch (e) { slot.replaceChildren(h('div', { class: 'ns-status' }, e.message)); return; }
    }
    const full = PG.full.get(r.runId);
    const sendIn = h('input', { class: 'txt', placeholder: 'Continue this run…', autocomplete: 'off' });
    const sendBtn = h('button', { class: 'btn sm primary' }, 'Send');
    const status = h('div', { class: 'ns-status hidden' });
    const cont = async () => {
      const text = sendIn.value.trim(); if (!text) return;
      sendBtn.disabled = true; status.classList.add('hidden');
      try { await api('specialist/run/' + enc(r.runId) + '/send', { text }); closeModal(); openTerm(full.tmux || r.tmux || r.runId); } catch (e) { sendBtn.disabled = false; status.textContent = e.message; status.classList.remove('hidden'); }
    };
    sendBtn.onclick = cont; sendIn.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); cont(); } };
    const canSend = full.mode === 'run' && isFinal(full);
    slot.replaceChildren(
      full.text ? h('div', { class: 'sp-out' }, full.text) : h('div', { class: 'dim sp-none' }, full.error ? full.error : 'No result yet.'),
      h('div', { class: 'sp-acts' },
        full.text ? h('button', { class: 'btn sm', onclick: () => navigator.clipboard.writeText(full.text).then(() => toast('Copied', 'ok'), () => toast('Could not copy', 'err')) }, ico('copy', 13), 'Copy') : null,
        full.text && PG.name ? improveButton(PG.name, PG.data?.specialist?.title || PG.name, r.runId, full.text) : null,
        canSend ? [sendIn, sendBtn] : null),
      status);
  }

  function runRow(r) {
    const st = r.state || 'done'; const live = !!claudeOf(r.tmux);
    const opened = PG.shown.has(r.runId);
    const slot = h('div', { class: 'sp-detail' });
    const row = h('div', { class: 'ntrow sp-run' + (opened ? ' open' : ''), onclick: () => {
      if (live) { closeModal(); openTerm(r.tmux); return; }
      if (PG.shown.has(r.runId)) { PG.shown.delete(r.runId); slot.replaceChildren(); row.classList.remove('open'); return; }
      PG.shown.add(r.runId); row.classList.add('open'); showRunText(r, slot);
    } },
      stateDot(st),
      h('div', { class: 'ntn' }, h('div', { class: 'ntt sp-task' }, firstLine(r.task) || r.runId), r.preview && !opened ? h('div', { class: 'nts sp-prev' }, firstLine(r.preview)) : null),
      h('div', { class: 'sp-meta dim' }, h('span', null, RUN_STATE[st] || st), h('span', null, ago(r.startedAt))));
    if (opened) showRunText(r, slot);
    return h('div', { class: 'sp-runwrap' }, row, slot);
  }

  function paintRuns(box) {
    const d = PG.data; if (!d) { box.replaceChildren(h('div', { class: 'dim sp-none' }, PG.err || 'Loading…')); return; }
    const runs = d.runs || [];
    box.replaceChildren(...(runs.length ? runs.map(runRow) : [h('div', { class: 'dim sp-none' }, 'No runs yet.')]));
  }

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
  const TRAINER_STATE = { idle: 'Ready', working: 'Working…', waiting: 'Needs an answer' };

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

  function trainTab(name) {
    const T = { ov: null, tr: null, err: null, files: [], fresh: false, sending: false, open: new Map(), undoAsk: null, rmAsk: null, more: null, keys: {}, extra: [], busy: false, moreFlag: false };
    const status = h('div', { class: 'sp-tstatus' });
    const conv = h('div', { class: 'conv sp-tconv' });
    const chips = h('div', { class: 'sp-chipsrow' });
    const ta = h('textarea', { class: 'sp-ask', rows: 3, placeholder: 'Tell the trainer…', spellcheck: 'true' });
    const sendBtn = h('button', { class: 'btn primary ns-send' }, 'Send');
    const freshBtn = h('button', { class: 'btn sm ghost', title: 'The old conversation is kept as it is' });
    const sendErr = h('div', { class: 'ns-status hidden' });
    const upErr = h('div', { class: 'ns-status hidden' });
    const fileIn = h('input', { type: 'file', multiple: true, class: 'hidden' });
    const drop = h('div', { class: 'sp-drop' });
    const hist = h('div', { class: 'sp-hist' });
    const histErr = h('div', { class: 'ns-status hidden' });
    const acc = h('div', { class: 'sp-accs' });
    const accName = h('input', { class: 'txt', placeholder: 'NAME, e.g. DB_URL', maxlength: 64, autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
    const accValue = h('input', { class: 'txt', type: 'password', placeholder: 'Value', autocomplete: 'new-password', spellcheck: 'false' });
    const accNote = h('input', { class: 'txt', placeholder: 'Note, e.g. read replica', maxlength: 200, autocomplete: 'off' });
    const accSave = h('button', { class: 'btn primary' }, 'Save access');
    const accErr = h('div', { class: 'ns-status hidden' });
    const accHelp = h('div', { class: 'dim sp-note' });

    const fail = (el, msg) => { el.replaceChildren(msg || ''); el.classList.toggle('hidden', !msg); };
    const trainer = () => T.ov?.trainer || null;
    const base = () => 'specialist/' + enc(name) + '/train';
    const provider = () => PG.data?.specialist?.provider || V.list.find(p => p.name === name)?.provider;

    const paintStatus = () => {
      const t = trainer(); const pf = PG.data?.specialist?.trainer?.pendingFeedback || 0;
      const text = !T.ov ? (T.err || 'Loading…') : !t ? 'Not started' : !t.live ? 'Stopped. The next message resumes it.' : TRAINER_STATE[t.state] || 'Ready';
      status.replaceChildren(...[h('i', { class: 'sp-dot rs-' + (t?.live && t.state === 'working' ? 'working' : t?.live && t.state === 'waiting' ? 'waiting' : 'done') }), h('span', null, text),
        pf ? h('span', { class: 'dim' }, ' · ' + plural(pf, 'feedback note') + ' waiting') : null, h('span', { class: 'sp' }), t ? h('span', { class: 'dim' }, plural(t.turns || 0, 'turn')) : null].filter(Boolean));
    };

    const paintConv = () => {
      const t = trainer(); const turns = T.tr?.turns || [];
      const key = [t?.sessionId, T.tr?.sig, T.tr?.total, turns.length, t?.state, t?.live].join(':');
      if (T.keys.conv === key) return;
      T.keys.conv = key;
      const atEnd = conv.scrollHeight - conv.scrollTop - conv.clientHeight < 60;
      const first = !turns.length ? h('div', { class: 'turn assistant sp-open' }, h('div', { class: 'who' }, 'Trainer'), h('div', { class: 'ttext' }, OPENING_PROMPT)) : null;
      conv.replaceChildren(...(first ? [first] : turns.map(x => convTurn(x, t.tmux))));
      if (atEnd) conv.scrollTop = conv.scrollHeight;
    };

    const paintChips = () => {
      chips.replaceChildren(...T.files.map(f => h('span', { class: 'badge tag sp-file' }, f.split('/').pop(), h('button', { class: 'sp-x', title: 'Do not mention it', 'aria-label': 'Do not mention it', onclick: () => { T.files = T.files.filter(x => x !== f); paintChips(); } }, '×'))));
      chips.classList.toggle('hidden', !T.files.length);
      sendBtn.disabled = T.sending;
    };
    const paintFresh = () => { freshBtn.replaceChildren(T.fresh ? 'New conversation: on' : 'New conversation'); freshBtn.classList.toggle('on', T.fresh); };

    const sendMsg = async () => {
      const typed = ta.value.trim();
      if ((!typed && !T.files.length) || T.sending) return;
      const body = { text: typed || 'I added these files for you to use.' };
      if (T.files.length) body.files = T.files;
      if (T.fresh) body.fresh = true;
      T.sending = true; paintChips(); fail(sendErr, '');
      try {
        const r = await api(base() + '/send', body);
        ta.value = ''; T.files = []; T.fresh = false; paintFresh();
        if (T.ov) T.ov.trainer = r.trainer;
        T.keys.conv = ''; paintStatus();
        for (const ms of [1200, 3500]) setTimeout(refresh, ms);
        refresh();
      } catch (e) { fail(sendErr, trainError(e, 'send')); }
      T.sending = false; paintChips();
    };
    sendBtn.onclick = sendMsg;
    freshBtn.onclick = () => { T.fresh = !T.fresh; paintFresh(); };
    ta.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing && ((e.metaKey || e.ctrlKey) || (!IS_PHONE && !e.shiftKey))) { e.preventDefault(); sendMsg(); } };

    const addFiles = async list => {
      const files = [...list].filter(Boolean); if (!files.length) return;
      fail(upErr, '');
      const errors = [];
      drop.classList.add('busy');
      for (const f of files) {
        if (f.size > UPLOAD_MAX) { errors.push(f.name + ': ' + trainError({ status: 413, message: '' }, 'upload')); continue; }
        try { const r = await uploadTraining(name, f); T.files.push(r.file.path); } catch (e) { errors.push(f.name + ': ' + trainError(e, 'upload')); }
      }
      drop.classList.remove('busy');
      paintChips(); fail(upErr, errors.join('\n'));
      refresh();
    };
    fileIn.onchange = () => { const fs = [...fileIn.files]; fileIn.value = ''; return addFiles(fs); };
    const hasFiles = ev => [...(ev.dataTransfer?.types || [])].includes('Files');
    drop.addEventListener('dragover', ev => { if (!hasFiles(ev)) return; ev.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', ev => { if (!hasFiles(ev)) return; ev.preventDefault(); drop.classList.remove('over'); addFiles(ev.dataTransfer.files); });
    drop.replaceChildren(h('span', { class: 'dim' }, 'Drop files here, or '), h('button', { class: 'btn sm', onclick: () => fileIn.click() }, ico('clip', 14), 'Add files'), fileIn,
      h('div', { class: 'dim sp-note' }, 'They go into the knowledge folder. Text, PDF and images, up to 20 MiB each.'));

    const loadCommit = async c => {
      try { const r = await api(base() + '/commit/' + enc(c.id)); T.open.set(c.id, { diff: r.diff, truncated: r.truncated, files: r.commit?.files || c.files }); } catch (e) { T.open.set(c.id, { error: e.message }); }
      paintHist(true);
    };
    const toggleCommit = c => {
      if (T.open.has(c.id)) { T.open.delete(c.id); paintHist(true); return; }
      T.open.set(c.id, { loading: true }); paintHist(true); loadCommit(c);
    };
    const doUndo = async c => {
      T.undoAsk = null; fail(histErr, '');
      try { await api(base() + '/undo', { commit: c.id }); toast('Change undone', 'ok'); T.more = null; await refresh(); } catch (e) { fail(histErr, trainError(e, 'undo')); paintHist(true); }
    };
    const commitRow = c => {
      const o = T.open.get(c.id);
      const canUndo = c.source !== 'start' && !c.undone;
      const acts = T.undoAsk === c.id
        ? [h('span', { class: 'dim' }, 'Undo this change?'), h('button', { class: 'btn sm danger solid', onclick: () => doUndo(c) }, 'Undo'), h('button', { class: 'btn sm ghost', onclick: () => { T.undoAsk = null; paintHist(true); } }, 'Cancel')]
        : [h('button', { class: 'btn sm ghost', onclick: () => toggleCommit(c) }, o ? 'Hide' : 'View'), canUndo ? h('button', { class: 'btn sm', onclick: () => { T.undoAsk = c.id; paintHist(true); } }, 'Undo') : null];
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
      const list = T.more || T.ov?.history?.commits || []; const last = list[list.length - 1]; if (!last) return;
      try { const r = await api(base() + '/history?limit=50&before=' + enc(last.id)); T.more = [...list, ...r.commits]; T.moreFlag = r.more; paintHist(true); } catch (e) { fail(histErr, e.message); }
    };
    const paintHist = force => {
      const commits = T.more || T.ov?.history?.commits || [];
      const more = T.more ? T.moreFlag : commits.length >= 20;
      const key = JSON.stringify([commits.map(c => [c.id, c.undone]), more, T.ov?.history?.ready]);
      if (!force && T.keys.hist === key) return;
      T.keys.hist = key;
      hist.replaceChildren(...[...(commits.length ? commits.map(commitRow) : [h('div', { class: 'dim sp-none' }, T.ov?.history?.ready ? 'No changes yet.' : 'Nothing yet. Changes show here after the first message or upload.')]),
        more ? h('button', { class: 'btn sm ghost', onclick: loadMore }, 'Show older') : null].filter(Boolean));
    };

    const accForm = () => {
      accHelp.replaceChildren('The trainer sees the names and notes, never the values.' + (isApi(provider()) ? ' OpenAI and xAI specialists do not get accesses.' : ' Claude runs get them as environment variables.'));
    };
    const removeAccess = async a => {
      T.rmAsk = null; fail(accErr, '');
      try { await api('specialist/' + enc(name) + '/accesses/' + enc(a.name) + '/delete', {}); toast('Removed ' + a.name, 'ok'); await refresh(); } catch (e) { fail(accErr, e.message); paintAcc(true); }
    };
    const paintAcc = force => {
      const list = T.ov?.accesses || [];
      const key = JSON.stringify([list.map(a => [a.name, a.note, a.updatedAt]), T.rmAsk]);
      if (!force && T.keys.acc === key) return;
      T.keys.acc = key;
      acc.replaceChildren(...(list.length ? list.map(a => h('div', { class: 'sp-acc' },
        h('div', { class: 'sp-cm' }, h('div', { class: 'sp-ct mono' }, a.name), h('div', { class: 'dim sp-cs' }, a.note || 'No note', ' · value saved')),
        h('div', { class: 'sp-cacts' }, T.rmAsk === a.name
          ? [h('span', { class: 'dim' }, 'Remove it?'), h('button', { class: 'btn sm danger solid', onclick: () => removeAccess(a) }, 'Remove'), h('button', { class: 'btn sm ghost', onclick: () => { T.rmAsk = null; paintAcc(true); } }, 'Cancel')]
          : [h('button', { class: 'btn sm', onclick: () => { accName.value = a.name; accNote.value = a.note || ''; accValue.focus(); } }, 'Replace'), h('button', { class: 'btn sm danger', onclick: () => { T.rmAsk = a.name; paintAcc(true); } }, 'Remove')]))) : [h('div', { class: 'dim sp-none' }, 'No accesses yet.')]));
    };
    accName.oninput = () => { accName.value = accName.value.toUpperCase(); fail(accErr, ''); };
    accSave.onclick = async () => {
      const n = accName.value.trim(); const v = accValue.value;
      if (!ACCESS_RE.test(n)) { fail(accErr, 'Use a name like DB_URL: capital letters, digits and underscores.'); return; }
      if (!v) { fail(accErr, 'Type the value.'); return; }
      accSave.disabled = true; fail(accErr, '');
      const body = { name: n, value: v };
      if (accNote.value.trim()) body.note = accNote.value.trim();
      try { await api('specialist/' + enc(name) + '/accesses', body); accValue.value = ''; accName.value = ''; accNote.value = ''; toast('Saved ' + n, 'ok'); await refresh(); } catch (e) { fail(accErr, e.message); }
      accSave.disabled = false;
    };

    async function refresh() {
      if (T.busy || PG.name !== name) return;
      T.busy = true;
      try {
        const ov = await api(base());
        T.ov = ov; T.err = null;
        const tmux = ov.trainer?.tmux;
        T.tr = tmux ? await api('transcript/' + enc(tmux) + '?n=60').catch(() => null) : null;
      } catch (e) { T.err = e.message; }
      T.busy = false;
      if (PG.name !== name) return;
      paintStatus(); paintConv(); paintHist(); paintAcc(); accForm();
    }

    const section = (title, ...kids) => h('section', { class: 'sp-sec' }, h('h4', null, title), kids);
    const el = h('div', { class: 'sp-train' },
      status, conv,
      h('div', { class: 'sp-composer' }, chips, ta, h('div', { class: 'ns-bar' }, freshBtn, h('span', { class: 'sp' }), sendBtn), sendErr),
      section('Files', drop, upErr),
      section('What changed', hist, histErr),
      section('Accesses', accHelp, acc, h('div', { class: 'sp-accform' }, accName, accValue, accNote, accSave), accErr));
    paintStatus(); paintConv(); paintChips(); paintFresh(); paintHist(); paintAcc(); accForm();
    return { el, refresh, focus: () => ta.focus() };
  }

  function openPage(name, o = {}) {
    const m = $('#modal'); m.classList.remove('hidden');
    if (PG.onEsc) document.removeEventListener('keydown', PG.onEsc, true);
    clearInterval(PG.timer);
    const known = V.list.find(p => p.name === name) || { name };
    Object.assign(PG, { name, tab: o.tab || 'runs', data: null, err: null }); PG.shown.clear(); PG.full.clear();
    if (o.run) { PG.shown.add(o.run); if (FIN.has(o.run)) { markSeen(o.run, FIN.get(o.run).endedAt); FIN.delete(o.run); } }
    const head = h('div', { class: 'sh sp-hd' });
    const desc = h('div', { class: 'sp-desc dim' });
    const keyNote = h('div', { class: 'ns-status sp-key hidden' });
    const tabs = h('span', { class: 'seg ns-tabs' });
    const body = h('div', { class: 'sp-body sp-pane' });
    const box = h('div', { class: 'box spbox' }, head, desc, keyNote, tabs, body);
    const ask = h('textarea', { class: 'sp-ask', rows: 3 });
    const askBtn = h('button', { class: 'btn primary ns-send' }, 'Ask');
    const askStatus = h('div', { class: 'ns-status hidden' });
    const runsBox = h('div', { class: 'sp-runs' });
    const trainBox = { tab: null };

    const paintHead = () => {
      const p = PG.data?.specialist || known; const t = PG.data?.thread;
      head.replaceChildren(...[tile(p, 'md'), h('div', { class: 'sp-ht' }, h('h3', null, p.title || name), h('div', { class: 'sp-chips' }, isApi(p.provider) ? h('span', { class: 'badge tag' }, providerLabel(p.provider)) : null, h('span', { class: 'badge tag' }, modelLabel(p.model, p.provider)), h('span', { class: 'badge tag' }, p.mode === 'thread' ? 'Thread' : 'Fresh run per task'), !isApi(p.provider) && p.account && p.account !== 'personal' ? h('span', { class: 'badge tag acc ' + p.account }, acct(p.account)) : null)),
        h('span', { class: 'sp' }), t?.live ? h('button', { class: 'btn sm', title: 'open the live thread', onclick: () => { closeModal(); openTerm(t.tmux); } }, 'Open thread') : null,
        h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', 'aria-label': 'close', onclick: closeModal }, ico('x', 15))].filter(Boolean));
      desc.textContent = p.description || ''; desc.classList.toggle('hidden', !p.description);
      keyNote.textContent = isApi(p.provider) && p.keyError || ''; keyNote.classList.toggle('hidden', !keyNote.textContent);
      ask.placeholder = 'Ask ' + (p.title || name) + '…';
    };
    const paintTabs = () => tabs.replaceChildren(...[['runs', 'Runs'], ['train', 'Train'], ['profile', 'Profile']].map(([k, l]) => h('button', { class: 'segb' + (PG.tab === k ? ' on' : ''), onclick: () => { PG.tab = k; paintTabs(); paintBody(); } }, l)));
    const paintBody = () => {
      if (PG.tab === 'runs') {
        body.replaceChildren(h('div', { class: 'sp-composer' }, ask, h('div', { class: 'ns-bar' }, h('span', { class: 'sp' }), askBtn), askStatus), runsBox);
        paintRuns(runsBox);
        if (o.focus) setTimeout(() => ask.focus(), 30);
        o.focus = false;
      } else if (PG.tab === 'train') {
        if (!trainBox.tab) trainBox.tab = trainTab(name);
        body.replaceChildren(trainBox.tab.el); trainBox.tab.refresh();
        if (o.focus) setTimeout(() => trainBox.tab.focus(), 30);
        o.focus = false;
      } else if (!PG.data) body.replaceChildren(h('div', { class: 'dim sp-none' }, PG.err || 'Loading…'));
      else { PG.profile = profileTab(PG.data.specialist, async () => { await loadPage(); refresh(true); paintHead(); paintBody(); }, closeModal); body.replaceChildren(PG.profile); }
    };
    PG.paint = () => { paintHead(); if (PG.tab === 'runs') paintRuns(runsBox); else if (PG.tab === 'train') trainBox.tab?.refresh(); else if (!PG.profile || !body.contains(PG.profile)) paintBody(); };

    const sendAsk = async () => {
      const text = ask.value.trim(); if (!text || askBtn.disabled) return;
      askBtn.disabled = true; askStatus.classList.add('hidden');
      try {
        const r = await api('specialist/' + enc(name) + '/ask', { text, wait: false });
        closeModal(); openTerm(r.tmux || r.runId); refresh(true);
      } catch (e) { askBtn.disabled = false; askStatus.textContent = e.message; askStatus.classList.remove('hidden'); }
    };
    askBtn.onclick = sendAsk;
    ask.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing && ((e.metaKey || e.ctrlKey) || (!IS_PHONE && !e.shiftKey))) { e.preventDefault(); sendAsk(); } };

    m.replaceChildren(box); PG.box = box; setup(m, closeModal);
    paintHead(); paintTabs(); paintBody(); loadPage();
    PG.timer = setInterval(() => {
      if (!pageShown()) { clearInterval(PG.timer); PG.timer = null; PG.name = null; PG.box = null; renderRail(); return; }
      if (!document.hidden) loadPage();
    }, 5000);
    renderRail();
  }

  setInterval(() => { if (!document.hidden) refresh(true); }, 30000);

  return { onState, termBarKey, railSection, paletteItems, homeTiles, unseenRuns, dismissRun, markSeen: seenByUser, trimSeen, feedbackBody, feedbackError, trackFeedback, pollFeedback, improve: openImprove, openRun, openAsk, open: openPage, create: openCreate, refresh };
})();
