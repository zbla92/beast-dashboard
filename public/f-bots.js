'use strict';
FEAT.bots = (() => {
  const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const NAME_BAD_RE = /-$|-company$|-\d{6}-\d{4}|^run$/;
  const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
  const ACCOUNTS = [['personal', 'Personal'], ['company', 'Company']];
  const USES = [['skill', 'Skill'], ['agent', 'Separate agent'], ['both', 'Both']];
  const PERMS = [['bypassPermissions', 'Bypass'], ['acceptEdits', 'Accept edits'], ['auto', 'Auto'], ['manual', 'Manual'], ['dontAsk', 'Do not ask'], ['plan', 'Plan']];
  const DEFAULTS = { account: 'personal', use: 'skill', permissionMode: 'bypassPermissions' };
  const STATE_LABEL = { idle: 'idle', working: 'working', waiting: 'needs an answer', error: 'error' };
  const REFRESH_MS = 30000;
  const V = { list: [], at: 0, busy: false, ok: false, sig: '' };

  const enc = encodeURIComponent;
  const valid = p => !!p && !p.error;
  const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const sorted = list => [...list].sort(byName);
  const sessionSig = () => S.runtime.sessions.filter(s => s.claude?.specialist).map(s => s.name + ':' + (s.claude?.state || '')).join(',');
  const normalName = v => v.trim().toLowerCase().replace(/\s+/g, '-');
  const nameFits = v => NAME_RE.test(v) && !NAME_BAD_RE.test(v);

  function stateOf(p) {
    if (p.error) return 'error';
    const calls = p.recentCalls || [];
    if (calls.some(c => c.state === 'waiting') || p.thread?.state === 'waiting') return 'waiting';
    if (p.thread?.state === 'working' || p.active > 0 || calls.some(c => c.state === 'working' || c.state === 'starting')) return 'working';
    return 'idle';
  }

  function fallbackTile(p, size) {
    const color = p.iconColor || '#64748b';
    return h('span', { class: 'bt-tile', style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.46)}px;color:${color};background:color-mix(in srgb, ${color} 20%, transparent)` }, p.iconGlyph || (p.name || '?').slice(0, 1).toUpperCase());
  }
  const tile = (p, size) => window.BOT_ICON?.tile(p, size) || fallbackTile(p, size);

  function card(p) {
    const st = stateOf(p);
    const open = valid(p) ? p.active || 0 : 0;
    return h('button', { class: 'bt-card st-' + st, onclick: () => valid(p) && openChat(p.name), title: p.error || p.name },
      tile(p, 44),
      h('span', { class: 'bt-body' },
        h('span', { class: 'bt-name' }, h('span', { class: 'bt-nm' }, p.title || p.name), h('i', { class: 'bt-dot st-' + st, title: STATE_LABEL[st] })),
        h('span', { class: 'bt-desc' }, p.error || p.description || 'No description yet'),
        h('span', { class: 'bt-meta' }, open ? plural(open, 'open call') : 'no open calls')));
  }

  const newCard = () => h('button', { class: 'bt-card bt-new', onclick: create }, h('span', { class: 'bt-tile bt-plus' }, ico('plus', 20)), h('span', { class: 'bt-body' }, h('span', { class: 'bt-name' }, 'New bot'), h('span', { class: 'bt-desc' }, 'Give it a name and a job')));

  function paintCount() {
    const el = $('#bots-count');
    if (el) el.textContent = V.list.length;
  }

  function paint() {
    paintCount();
    const root = $('#bots');
    if (!root || UI.view !== 'bots') return;
    const head = h('div', { class: 'bt-head' }, h('h2', { class: 'bt-title' }, 'Bots'), h('span', { class: 'n' }, V.list.length), h('span', { class: 'bt-sp' }),
      h('button', { class: 'btn sm ghost icon bt-help', title: 'How bots work', 'aria-label': 'How bots work', onclick: () => FEAT.botsIntro?.open() }, '?'));
    const note = !V.ok && !V.list.length ? h('div', { class: 'note bt-note' }, 'Bots are not available.') : null;
    root.replaceChildren(...[head, note].filter(Boolean), h('div', { class: 'bt-grid' }, ...sorted(V.list).map(card), newCard()));
  }

  async function refresh(force) {
    if (V.busy || (!force && Date.now() - V.at < 4000)) return;
    V.busy = true;
    try {
      const r = await api('specialists');
      V.list = r.specialists || []; V.ok = true;
    } catch { V.ok = false; }
    V.busy = false; V.at = Date.now();
    paint();
  }

  function onState() {
    const sig = sessionSig();
    if (!V.at || sig !== V.sig) { V.sig = sig; refresh(false); }
  }

  function shown() {
    refresh(true);
    FEAT.botsIntro?.maybeOpen();
  }

  async function openChat(name) {
    try {
      const r = await api('specialist/' + enc(name) + '/chat', {});
      const tmux = r.thread?.tmux;
      if (!tmux) throw new Error('The chat did not start');
      openTerm(tmux);
    } catch (e) { toast(e.message, 'err'); }
  }

  const closeModal = () => $('#modal').classList.add('hidden');
  const field = (label, el) => h('label', { class: 'bt-f' }, h('span', null, label), el);
  const select = (list, cur) => { const s = h('select', { class: 'txt' }, list.map(([v, l]) => h('option', { value: v }, l))); s.value = cur; return s; };

  function createBody(v) {
    const body = { name: normalName(v.name), template: 'blank' };
    if (v.description.trim()) body.description = v.description.trim();
    if (v.model) body.model = v.model;
    for (const k of Object.keys(DEFAULTS)) if (v[k] && v[k] !== DEFAULTS[k]) body[k] = v[k];
    return body;
  }

  function create() {
    const m = $('#modal'); m.classList.remove('hidden');
    const err = h('div', { class: 'ns-status hidden' });
    const name = h('input', { class: 'txt', placeholder: 'name, e.g. writer', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', maxlength: 32 });
    const desc = h('input', { class: 'txt', placeholder: 'What it does, in one line', maxlength: 300 });
    const model = select(MODELS, '');
    const account = select(ACCOUNTS, DEFAULTS.account);
    const use = select(USES, DEFAULTS.use);
    const perm = select(PERMS, DEFAULTS.permissionMode);
    const go = h('button', { class: 'btn primary ns-send' }, 'Create');
    const sync = () => { go.disabled = !nameFits(normalName(name.value)); };
    name.oninput = () => { err.classList.add('hidden'); sync(); };
    const submit = async () => {
      if (go.disabled) return;
      go.disabled = true; err.classList.add('hidden');
      const body = createBody({ name: name.value, description: desc.value, model: model.value, account: account.value, use: use.value, permissionMode: perm.value });
      try {
        await api('specialist', body);
        closeModal();
        await refresh(true);
        openChat(body.name);
      } catch (e) { go.disabled = false; err.textContent = e.message; err.classList.remove('hidden'); }
    };
    go.onclick = submit;
    for (const el of [name, desc]) el.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } };
    const adv = h('details', { class: 'bt-adv' }, h('summary', null, 'Advanced'), h('div', { class: 'bt-advbody' }, field('Account', account), field('Used as', use), field('Permissions', perm)));
    const box = h('div', { class: 'box bt-create' },
      h('div', { class: 'sh' }, h('h3', null, 'New bot'), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: closeModal }, ico('x', 15))),
      h('div', { class: 'bt-form' }, field('Name', name), field('What it does', desc), field('Model', model), adv, err),
      h('div', { class: 'bt-foot' }, h('span', { class: 'sp' }), go));
    m.replaceChildren(box); m.onclick = e => { if (e.target === m) closeModal(); };
    sync(); if (!IS_PHONE) name.focus();
  }

  setInterval(() => { if (!document.hidden) refresh(true); }, REFRESH_MS);
  refresh(true);

  return { openChat, create, all: () => V.list, refresh, paint, shown, onState, createBody };
})();
