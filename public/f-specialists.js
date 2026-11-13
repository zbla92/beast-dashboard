'use strict';
FEAT.specialists = (() => {
  const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const CALL_RE = /^claude-spec-([a-z0-9][a-z0-9-]{0,31}?)-\d{6}-\d{4}(?:-\d{1,2})?(?:-company)?$/;
  const THREAD_RE = /^claude-spec-([a-z0-9][a-z0-9-]{0,31}?)(?:-company)?$/;
  const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
  const MODES = [['run', 'Fresh run per task'], ['thread', 'One thread']];
  const PROVIDERS = [['claude', 'Claude'], ['openai', 'OpenAI'], ['xai', 'xAI']];
  const MODEL_HINT = { openai: 'model id, e.g. gpt-5', xai: 'model id, e.g. grok-4' };
  const USES = [['skill', 'Skill'], ['agent', 'Separate agent'], ['both', 'Both']];
  const USE_NOTE = {
    skill: 'Agents load its profile into their own chat and do the work themselves, so nothing gets lost in a handoff.',
    agent: 'Agents send it a task and get its answer back (bd-ask). Use for its own accesses, another provider or an independent view.',
    both: 'Agents load it as a skill by default and ask it separately only when the work needs isolation.'
  };
  const CALL_STATE = { starting: 'working', working: 'working', waiting: 'permission', done: 'idle', error: 'error', stopped: 'idle' };
  const FINAL_RUN = ['done', 'error', 'stopped'];
  const RAIL_CALLS = 5;
  const CALL_TITLE_MAX = 80;
  const LIVE_HINT = 'This call is still working. You can reply once it has a result.';
  const TILE_PX = { sm: 24, md: 36 };
  const V = { list: [], templates: [], at: 0, busy: false, ok: false, sig: '' };
  const CR = { onEsc: null };
  const CALLS = new Map();
  const ASKED = new Set();
  const PHANTOM = new Map();
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
  const cut = (t, n) => t.length > n ? t.slice(0, n - 1) + '…' : t;
  const isApi = provider => Object.hasOwn(MODEL_HINT, provider || '');
  const providerLabel = provider => (PROVIDERS.find(([v]) => v === provider) || [provider, provider])[1];
  const modelLabel = (m, provider) => isApi(provider) ? m || providerLabel(provider) : m ? modelName(m) : 'Default';
  const sessionSig = () => S.runtime.sessions.filter(runOf).map(s => s.name + ':' + (s.claude?.state || '')).join(',');
  const isFinal = r => FINAL_RUN.includes(r.state);
  const byName = list => [...list].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  function stateOf(p) {
    if (p.error) return 'error';
    const live = runSessions(p.name).map(s => s.claude);
    if (live.some(c => c && c.state === 'permission')) return 'permission';
    if (live.some(c => c && c.state === 'working') || p.thread?.state === 'working' || p.active > 0) return 'working';
    return 'idle';
  }

  function kindOf(tmux) {
    const s = typeof tmux === 'string' ? tmux : '';
    const call = CALL_RE.exec(s);
    const name = (call || THREAD_RE.exec(s))?.[1];
    const p = name && V.list.find(x => x.name === name && valid(x));
    return p ? { p, call: !!call } : null;
  }
  const callOf = tmux => kindOf(tmux)?.call ? CALLS.get(tmux) || null : null;
  const callTitle = r => cut(firstLine(r.task) || r.runId, CALL_TITLE_MAX);
  const callerTitle = tmux => { const s = S.runtime.sessions.find(x => x.name === tmux); return (s && sessTitle(s)) || tmux; };
  const calledFrom = r => r.caller ? 'called from ' + callerTitle(r.caller) : 'called from outside the dashboard';
  const callsOf = p => (p.recentCalls || []).filter(r => r.mode === 'run').slice(0, RAIL_CALLS);

  function loadCall(id) {
    if (ASKED.has(id)) return;
    ASKED.add(id);
    api('specialist/run/' + enc(id)).then(r => { CALLS.set(id, r); renderChatPane(false); }, () => {});
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
  const finKey = () => [...FIN.keys()].filter(id => !SEEN.ids.has(id)).join(',');
  const threadTmux = name => V.list.find(p => p.name === name)?.thread?.tmux;
  const watching = r => !!TERM.open && (TERM.active === r.tmux || TERM.active === threadTmux(r.specialist));
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

  const fallbackTile = (p, px) => h('span', { class: 'sp-tile', style: `width:${px}px;height:${px}px;background:${p.iconColor || `hsl(${hue(p.name)} 40% 45%)`}` }, p.iconGlyph || p.name.slice(0, 1).toUpperCase());
  const tile = (p, size = 'sm') => window.BOT_ICON?.tile ? window.BOT_ICON.tile(p, TILE_PX[size]) : fallbackTile(p, TILE_PX[size]);

  function repaint() {
    renderRail();
    if (IS_PHONE && TERM.open && TERM.showList) renderTermPanel(true);
  }

  async function refresh(force) {
    if (V.busy || (!force && Date.now() - V.at < 4000)) return;
    V.busy = true;
    const finals = () => [...CALLS].map(([k, r]) => k + isFinal(r)).join(',');
    const finalsBefore = finals();
    try {
      const r = await api('specialists');
      V.list = r.specialists || []; V.templates = r.templates || []; V.ok = true;
      for (const p of V.list) for (const c of p.recentCalls || []) CALLS.set(c.runId, c);
    } catch { V.ok = false; }
    const before = finKey();
    try { await gather(); } catch {}
    V.busy = false; V.at = Date.now();
    repaint();
    if (finalsBefore !== finals() && TERM.open) renderChatPane(false);
    if (before !== finKey()) announce();
  }

  function onState() {
    const sig = sessionSig();
    if (V.at && sig === V.sig) return;
    if (V.busy || Date.now() - V.at < 4000) return;
    V.sig = sig;
    refresh(false);
  }

  const keyOf = () => [V.ok, V.list.map(p => [p.name, p.title, p.iconKey, p.iconColor, p.iconGlyph, p.provider, p.model, p.active, p.error, p.thread?.state, p.thread?.tmux, p.description, (p.recentCalls || []).map(r => [r.runId, r.state, r.caller, r.task])]), V.list.map(p => runSessions(p.name).map(s => [s.name, s.claude?.state, s.claude?.needsYou, s.claude?.title, s.claude?.firstPrompt, s.claude?.label]))];

  const runLabel = s => firstLine(s.claude?.title || s.claude?.firstPrompt || s.claude?.label) || s.name;
  const runState = cl => { const st = cl?.state || 'unknown'; return st === 'needs-you' ? 'idle' : st; };

  async function openBot(name) {
    if (FEAT.bots?.openChat) return FEAT.bots.openChat(name);
    try {
      const r = await api('specialist/' + enc(name) + '/chat', {});
      await refresh(true);
      openTerm(r.thread.tmux);
    } catch (e) { toast(e.message, 'err'); }
  }

  function openRun(r) {
    if (isFinal(r)) dismissRun(r.runId);
    CALLS.set(r.runId, { ...CALLS.get(r.runId), ...r });
    openTerm(r.runId);
  }

  const create = () => FEAT.bots?.create ? FEAT.bots.create() : openCreate();

  function callRow(r, cls) {
    const st = CALL_STATE[r.state] || 'idle';
    const on = TERM.open && TERM.active === r.runId;
    return h('button', { class: 'rrow k-spec-run st-' + st + (on ? ' on' : '') + (st === 'permission' ? ' need' : ''), title: r.runId, onclick: () => openRun(r) },
      h('i', { class: 'rdot' }),
      h('span', { class: 'rtx' }, h('span', { class: 'rnm' }, h('b', null, callTitle(r))), h('span', { class: 'rln2' }, h('span', { class: 'rsub' }, calledFrom(r)))));
  }

  function railRow(p) {
    if (p.error) return h('button', { class: 'rrow k-spec st-error', title: p.error, onclick: () => toast(p.name + ': ' + p.error, 'err') },
      h('i', { class: 'rdot' }), h('span', { class: 'rtx' }, h('span', { class: 'rnm' }, h('b', null, p.name)), h('span', { class: 'rln2' }, h('span', { class: 'rsub' }, 'profile has an error'))));
    const st = stateOf(p);
    return h('button', { class: 'rrow k-spec st-' + st + (TERM.open && p.thread?.tmux && TERM.active === p.thread.tmux ? ' on' : ''), title: p.description || p.name, onclick: () => openBot(p.name) },
      h('span', { class: 'rav' }, tile(p), h('i', { class: 'rdot' })),
      h('span', { class: 'rtx' }, h('span', { class: 'rnm' }, h('b', null, p.title || p.name), h('em', null, modelLabel(p.model, p.provider).toLowerCase())),
        p.description ? h('span', { class: 'rln2' }, h('span', { class: 'rsub' }, p.description)) : null),
      p.active > 0 ? h('span', { class: 'rage', title: plural(p.active, 'open call') }, p.active) : null);
  }

  function listCall(r) {
    const st = CALL_STATE[r.state] || 'idle';
    return h('div', { class: 'titem claude sub st-' + st + (TERM.active === r.runId ? ' on' : ''), title: r.runId, onclick: () => openRun(r) },
      h('span', { class: 'dot' }),
      h('div', { class: 'tt' }, h('div', { class: 'tn' }, h('span', { class: 'nm' }, callTitle(r))), h('div', { class: 'ts' }, h('span', { class: 'dim' }, calledFrom(r)))));
  }

  function listRow(p) {
    if (p.error) return h('div', { class: 'titem other st-error', onclick: () => toast(p.name + ': ' + p.error, 'err') }, h('span', { class: 'dot' }), h('div', { class: 'tt' }, h('div', { class: 'tn' }, h('span', { class: 'nm' }, p.name)), h('div', { class: 't3' }, h('span', { class: 'ttl dim' }, p.error))));
    const st = stateOf(p);
    return h('div', { class: 'titem claude spec st-' + st, title: p.description || p.name, onclick: () => openBot(p.name) },
      tile(p),
      h('div', { class: 'tt' },
        h('div', { class: 'tn' }, h('span', { class: 'nm' }, p.title || p.name)),
        h('div', { class: 'ts' }, h('span', { class: 'cst mini ' + st }, gico(STATE_ICON[st] || '·', 10), ' ', STATE_LABEL[st] || st), h('span', { class: 'mdl' }, modelLabel(p.model, p.provider)), p.active > 0 ? h('span', { class: 'grp' }, plural(p.active, 'call')) : null),
        p.description ? h('div', { class: 't3' }, h('span', { class: 'ttl dim' }, p.description)) : null));
  }

  function railSection(kind) {
    if (kind === 'list' && !IS_PHONE) return null;
    const rows = [];
    for (const p of byName(V.list)) {
      const calls = valid(p) ? callsOf(p) : [];
      if (kind === 'rail') rows.push(railRow(p), ...calls.map(r => callRow(r)));
      else rows.push(listRow(p), ...calls.map(listCall));
    }
    const add = h('button', { class: 'rail-add', title: 'New bot', 'aria-label': 'New bot', onclick: () => create() }, ico('plus', 16));
    const head = kind === 'rail'
      ? h('div', { class: 'rail-head sp-head' }, h('span', { class: 'rail-t' }, 'Bots ', h('span', { class: 'n' }, V.list.length)), add)
      : h('div', { class: 'tsec sp-head' }, 'Bots', h('span', { class: 'n' }, V.list.length), h('span', { class: 'sp' }), add);
    const empty = !V.list.length ? h('div', { class: kind === 'rail' ? 'rempty' : 'note sp-empty' }, V.ok ? 'No bots yet.' : 'Bots are not available.') : null;
    return [head, ...rows, empty];
  }

  function paletteItems() {
    const out = [];
    for (const p of V.list.filter(valid)) {
      const t = p.title || p.name;
      out.push({ kind: 'action', label: 'Bot: ' + t, sub: p.description || modelLabel(p.model, p.provider), icon: p.iconGlyph || '◆', hay: ['bot', p.name, t, p.description].join(' '), run: () => openBot(p.name), rank: 26 });
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
        h('h2', { class: 'sp-home-t' }, 'Bots at work ', h('span', { class: 'n' }, rows.length)),
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

  function phantom(tmux) {
    if (!kindOf(tmux)?.call) return null;
    if (!PHANTOM.has(tmux)) PHANTOM.set(tmux, { mode: 'chat', account: tmux.endsWith('-company') ? 'company' : 'personal' });
    return PHANTOM.get(tmux);
  }

  function termTitle(tmux) {
    const k = kindOf(tmux);
    if (!k) return null;
    const r = k.call ? CALLS.get(tmux) : null;
    return r ? callTitle(r) : k.p.title || k.p.name;
  }
  const termTile = tmux => { const k = kindOf(tmux); return k ? tile(k.p, 'sm') : null; };

  function callItem(r) {
    return { el: h('div', { class: 'mi sp-callmi', title: r.runId, onclick: () => { closeMenu(); openRun(r); } },
      h('span', { class: 'ico' }, h('i', { class: 'sp-dot rs-' + r.state })),
      h('span', { class: 'k sp-callmi-tx' }, h('span', { class: 'sp-callmi-t' }, callTitle(r)), h('span', { class: 'sp-callmi-s dim' }, calledFrom(r)))) };
  }

  function openCalls(ev, p) {
    const anchor = ev.currentTarget;
    const show = runs => {
      const calls = runs.filter(r => r.mode === 'run').sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      for (const r of calls) CALLS.set(r.runId, { ...CALLS.get(r.runId), ...r });
      openMenu({ currentTarget: anchor }, calls.length ? calls.map(callItem) : [{ info: true, label: 'No calls yet', sub: '' }]);
    };
    api('specialist/' + enc(p.name) + '?runs=50').then(r => show(r.runs || []), () => show(p.recentCalls || []));
  }

  function termBar(tmux) {
    const k = kindOf(tmux);
    if (!k) return null;
    const label = h('span', { class: 'sp-botname' }, k.p.title || k.p.name);
    const chip = k.call
      ? h('button', { class: 'btn sm ghost sp-botchip', title: 'open ' + (k.p.title || k.p.name), onclick: () => openBot(k.p.name) }, tile(k.p, 'sm'), label)
      : h('span', { class: 'sp-botchip', title: k.p.description || k.p.name }, tile(k.p, 'sm'), label);
    if (k.call) return [chip];
    return [chip,
      h('button', { class: 'btn sm ghost sp-barbtn', title: 'Every call to this bot', onclick: ev => openCalls(ev, k.p) }, ico('clock', 14), h('span', { class: 'desk' }, 'Calls')),
      h('button', { class: 'btn sm ghost sp-barbtn', title: 'Bot settings', 'aria-label': 'Bot settings', onclick: () => FEAT.botSettings?.open(k.p.name) }, ico('gear', 14))];
  }
  const termBarKey = () => keyOf();

  function chatBar(name) {
    if (!kindOf(name)?.call) return null;
    const r = CALLS.get(name);
    if (!r) { loadCall(name); return null; }
    return h('span', { class: 'sp-called dim' }, calledFrom(r));
  }

  function composerShown(box) {
    const reply = box.querySelector('.creply');
    if (!reply) return;
    const r = callOf(box.dataset.chat);
    const lock = !!r && !isFinal(r);
    if (lock === (reply.dataset.spLock === '1')) return;
    reply.dataset.spLock = lock ? '1' : '';
    if (lock) { reply.dataset.spHint = reply.placeholder; reply.placeholder = LIVE_HINT; } else reply.placeholder = reply.dataset.spHint || '';
    reply.disabled = lock;
    for (const b of box.querySelectorAll('.csend')) b.disabled = lock;
  }

  function sendCall(name, text) {
    const r = callOf(name);
    if (!r) return null;
    return api('specialist/run/' + enc(r.runId) + '/send', { text, wait: false }).then(x => { CALLS.set(r.runId, { ...r, ...x }); refresh(true); return x; });
  }

  const opts = (list, cur) => {
    const items = list.some(([v]) => v === (cur ?? '')) || cur == null ? list : [...list, [cur, cur]];
    return items.map(([v, l]) => h('option', { value: v }, l));
  };
  const select = (list, cur) => { const s = h('select', { class: 'txt' }, opts(list, cur)); s.value = cur ?? ''; return s; };
  const field = (label, el, cls = '') => h('label', { class: 'sp-f ' + cls }, h('span', null, label), el);

  const legacyServer = () => V.list.some(valid) && !V.list.some(p => valid(p) && p.skill);

  function useInput(provider, cur) {
    const pick = select(USES, cur);
    const note = h('span', { class: 'dim sp-note sp-usenote' });
    const box = h('span', { class: 'sp-usebox' }, pick, note);
    const paint = () => { note.textContent = USE_NOTE[pick.value] || ''; };
    const show = prov => { if (isApi(prov)) pick.value = 'agent'; pick.disabled = isApi(prov); paint(); };
    pick.onchange = paint;
    show(provider);
    return { box, show, value: () => pick.value };
  }

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
    const use = useInput('claude', 'skill');
    const go = h('button', { class: 'btn primary ns-send' }, 'Create');
    provider.onchange = () => { model.show(provider.value); use.show(provider.value); };
    const fits = () => NAME_RE.test(name.value.trim()) && !/-$|-company$|-\d{6}-\d{4}|^run$/.test(name.value.trim());
    const sync = () => { go.disabled = !fits(); };
    tpl.onchange = () => { const t = templates.find(x => x.id === tpl.value); icon.placeholder = t?.meta?.icon || '◆'; };
    name.oninput = () => { err.classList.add('hidden'); sync(); };
    const make = async () => {
      if (!fits() || go.disabled) return;
      go.disabled = true; err.classList.add('hidden');
      const body = { name: name.value.trim(), template: tpl.value };
      if (title.value.trim()) body.title = title.value.trim();
      if (icon.value.trim()) body.icon = icon.value.trim();
      if (desc.value.trim()) body.description = desc.value.trim();
      if (provider.value !== 'claude') body.provider = provider.value;
      if (model.value(provider.value)) body.model = model.value(provider.value);
      if (mode.value !== 'run') body.mode = mode.value;
      if (!legacyServer()) body.use = use.value();
      try {
        const r = await api('specialist', body);
        await refresh(true);
        toast('Created ' + (r.specialist?.title || body.name), 'ok');
        closeModal(); openBot(body.name);
      } catch (e) { go.disabled = false; err.textContent = e.message; err.classList.remove('hidden'); }
    };
    go.onclick = make;
    for (const el of [name, title, icon, desc]) el.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); make(); } };
    const box = h('div', { class: 'box spbox spcreate' },
      h('div', { class: 'sh' }, h('h3', null, gl('＋ New bot')), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: closeModal }, ico('x', 15))),
      h('div', { class: 'sp-body' },
        field('Name', name), h('div', { class: 'sp-row' }, field('Title', title, 'grow'), field('Icon', icon)), field('Description', desc),
        h('div', { class: 'sp-row' }, field('Template', tpl, 'grow'), field('Mode', mode, 'grow')),
        h('div', { class: 'sp-row' }, field('Provider', provider, 'grow'), field('Model', model.box, 'grow')),
        field('Used as', use.box), err),
      h('div', { class: 'sp-foot' }, h('span', { class: 'dim sp-note' }, 'Gets its own folder with instructions'), h('span', { class: 'sp' }), go));
    m.replaceChildren(box); setup(m, closeModal);
    sync(); if (!IS_PHONE) name.focus();
  }

  return { phantom, termTitle, termTile, termBar, termBarKey, chatBar, composerShown, sendCall, onState, railSection, paletteItems, homeTiles, unseenRuns, dismissRun, markSeen: seenByUser, trimSeen, openRun, create, refresh };
})();
