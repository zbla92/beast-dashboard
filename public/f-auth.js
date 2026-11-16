'use strict';
FEAT.auth = (() => {
  const ACTIVE = ['starting', 'waiting', 'checking'];
  const TICK = 1000, OK_CLOSE = 2000, LOCAL_FOR = 4000;
  const accounts = () => Object.keys((S.claude && S.claude.auth) || {});
  const rec = a => ((S.claude && S.claude.auth) || {})[a] || null;
  const liveLogin = r => !!(r && r.login && ACTIVE.includes(r.login.state));
  const needs = a => { const r = rec(a); return !!r && (r.needsLogin || liveLogin(r)); };
  const HOST = /(?:^|\.)(?:claude\.com|claude\.ai|anthropic\.com)$/;
  const safeUrl = u => {
    if (typeof u !== 'string' || !u.includes('/oauth/authorize?')) return '';
    try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password && !x.port && HOST.test(x.hostname) && x.pathname.endsWith('/oauth/authorize') ? u : ''; } catch { return ''; }
  };
  const clock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const canPaste = () => typeof navigator !== 'undefined' && !!navigator.clipboard && typeof navigator.clipboard.readText === 'function';

  const wrap = h('div', { class: 'au-hdr', hidden: true });
  const hdr = { key: '' };

  function mountHeader() {
    const top = document.querySelector('.top');
    if (top && wrap.parentElement !== top) top.insertBefore(wrap, top.querySelector('.topbtns'));
  }

  function paintHeader() {
    const list = accounts().filter(needs);
    const key = JSON.stringify(list.map(a => [a, acct(a)]));
    mountHeader();
    if (key === hdr.key) return;
    hdr.key = key;
    wrap.replaceChildren(...list.map(a => h('button', { type: 'button', class: 'btn au-hb', 'data-account': a, onclick: () => open(a) }, 'Authenticate (' + acct(a) + ')')));
    wrap.hidden = !list.length;
  }

  const busyRetry = new Set();
  async function retry(name, dismiss) {
    if (busyRetry.has(name)) return;
    busyRetry.add(name);
    try { await api('auth/retry', dismiss ? { session: name, dismiss: true } : { session: name }); } catch (e) { toast(e.message, 'err'); } finally { busyRetry.delete(name); }
  }

  function bannerFor(name) {
    const cl = claudeOf(name);
    if (!cl || cl.mode !== 'chat' || cl.apiProvider) return null;
    const a = cl.account || 'personal', r = rec(a);
    if (!r) return null;
    if (r.needsLogin) return { key: 'login:' + a + ':' + acct(a), el: () => h('div', { class: 'au-ban', role: 'status' },
      h('span', { class: 'au-ban-t' }, acct(a) + ' login expired'),
      h('button', { type: 'button', class: 'btn primary au-ban-go', onclick: () => open(a) }, 'Authenticate')) };
    if ((r.retry || []).includes(name)) return { key: 'retry:' + a, el: () => h('div', { class: 'au-ban ok', role: 'status' },
      h('span', { class: 'au-ban-t' }, 'Signed in again'),
      h('button', { type: 'button', class: 'btn primary au-ban-go', onclick: () => retry(name, false) }, 'Retry'),
      h('button', { type: 'button', class: 'btn ghost au-ban-x', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => retry(name, true) }, ico('x', 14))) };
    return null;
  }

  function paintBox(box) {
    const name = box.dataset.chat, want = bannerFor(name), found = box.querySelector(':scope > .au-ban');
    if (found && want && found.dataset.k === want.key) return;
    if (!found && !want) return;
    const sc = box.querySelector(':scope > .cscroll'), pinned = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
    if (found) found.remove();
    if (want && sc) { const el = want.el(); el.dataset.k = want.key; sc.after(el); }
    if (pinned) sc.scrollTop = sc.scrollHeight;
  }

  const ui = { cur: null };

  function loginOf() {
    const r = rec(ui.cur.account);
    if (r && r.login) { ui.cur.local = null; return r.login; }
    return ui.cur.local && Date.now() - ui.cur.localAt < LOCAL_FOR ? ui.cur.local : null;
  }

  function cleanup() {
    if (!ui.cur) return;
    const c = ui.cur; ui.cur = null;
    clearInterval(c.timer); clearTimeout(c.okTimer);
    c.input.value = '';
    c.observer.disconnect();
  }

  function close() {
    const m = $('#modal');
    const mine = !!ui.cur && m.firstChild === ui.cur.box;
    cleanup();
    if (mine) m.classList.add('hidden');
  }

  async function start() {
    const c = ui.cur;
    if (!c || c.starting) return;
    c.starting = true; c.err = ''; paint();
    try {
      const r = await api('auth/start', { account: c.account });
      c.local = r && r.login; c.localAt = Date.now();
    } catch (e) { c.err = e.message; }
    c.starting = false;
    if (ui.cur === c) paint();
  }

  async function submit() {
    const c = ui.cur;
    if (!c || c.sending) return;
    const code = c.input.value.trim(), lg = loginOf();
    c.input.value = '';
    if (!code || !lg || lg.state !== 'waiting') { paint(); return; }
    c.sending = lg.id; c.err = ''; paint();
    try { await api('auth/code', { account: c.account, id: lg.id, code }); } catch (e) { c.err = e.message; c.sending = null; }
    if (ui.cur === c) paint();
  }

  async function cancel() {
    const c = ui.cur;
    if (!c) return;
    try { await api('auth/cancel', { account: c.account }); } catch (e) { toast(e.message, 'err'); return; }
    close();
  }

  async function copy() {
    const lg = ui.cur && loginOf(), url = lg && safeUrl(lg.url);
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast('Link copied', 'ok'); return; } catch {}
    const ta = h('textarea', { class: 'au-clip', readonly: true }); ta.value = url;
    document.body.append(ta); ta.select();
    const done = (() => { try { return document.execCommand('copy'); } catch { return false; } })();
    ta.remove();
    toast(done ? 'Link copied' : 'Copy failed, use Open sign-in page', done ? 'ok' : 'err');
  }

  async function paste() {
    try { const t = await navigator.clipboard.readText(); if (ui.cur) { ui.cur.input.value = (t || '').trim(); paint(); ui.cur.input.focus(); } } catch { toast('Paste is blocked here, paste into the field', 'err'); }
  }

  function stateText(lg, c) {
    if (c.err) return { t: c.err, k: 'err' };
    if (c.starting && !lg) return { t: 'Starting the login…', k: '' };
    if (!lg) return { t: 'No login running', k: '' };
    if (lg.state === 'waiting' && c.sending === lg.id) return { t: 'Checking the code…', k: '' };
    if (lg.state === 'starting') return { t: 'Starting the login…', k: '' };
    if (lg.state === 'waiting') return { t: 'Waiting for the code', k: '' };
    if (lg.state === 'checking') return { t: 'Checking the code…', k: '' };
    if (lg.state === 'ok') return { t: 'Signed in', k: 'ok' };
    if (lg.state === 'expired') return { t: 'Login expired, start again', k: 'err' };
    return { t: lg.message || 'Login failed', k: 'err' };
  }

  function paint() {
    const c = ui.cur;
    if (!c) return;
    const lg = loginOf();
    if (lg && c.sending && (lg.id !== c.sending || lg.state !== 'waiting')) c.sending = null;
    const st = stateText(lg, c);
    const live = !!lg && ACTIVE.includes(lg.state);
    const waiting = !!lg && lg.state === 'waiting' && !c.sending;
    const url = lg ? safeUrl(lg.url) : '';
    c.stateEl.textContent = st.t; c.stateEl.className = 'au-state' + (st.k ? ' ' + st.k : '');
    c.count.textContent = live && lg.endsAt ? 'expires in ' + clock(lg.endsAt - Date.now()) : '';
    c.link.hidden = !url; if (url) c.link.href = url;
    c.copyBtn.hidden = !url;
    c.input.disabled = !waiting;
    c.submit.disabled = !waiting || !c.input.value.trim();
    c.cancelBtn.hidden = !live && !(lg && (lg.state === 'error' || lg.state === 'expired'));
    c.cancelBtn.textContent = live ? 'Cancel login' : 'Cancel';
    c.startBtn.hidden = !lg || live || lg.state === 'ok';
    c.startBtn.disabled = !!c.starting;
    if (lg && lg.state === 'ok' && !c.okTimer) c.okTimer = setTimeout(() => { if (ui.cur === c) close(); }, OK_CLOSE);
  }

  function tick() {
    const m = $('#modal');
    if (!ui.cur || m.firstChild !== ui.cur.box || m.classList.contains('hidden')) { cleanup(); return; }
    paint();
  }

  function open(account) {
    if (!account) return;
    if (ui.cur) cleanup();
    const m = $('#modal');
    const input = h('input', { class: 'txt mono au-code', type: 'text', name: 'au-code', placeholder: 'code#state', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', 'aria-label': 'Sign-in code' });
    const stateEl = h('div', { class: 'au-state', role: 'status', 'aria-live': 'polite' });
    const count = h('span', { class: 'au-count dim' });
    const link = h('a', { class: 'btn primary au-open', target: '_blank', rel: 'noopener noreferrer', hidden: true }, 'Open sign-in page');
    const copyBtn = h('button', { type: 'button', class: 'btn au-copy', hidden: true, onclick: copy }, 'Copy link');
    const pasteBtn = canPaste() ? h('button', { type: 'button', class: 'btn au-paste', onclick: paste }, 'Paste') : null;
    const submitBtn = h('button', { type: 'button', class: 'btn primary au-submit', disabled: true, onclick: submit }, 'Submit');
    const startBtn = h('button', { type: 'button', class: 'btn au-again', hidden: true, onclick: start }, 'Start again');
    const cancelBtn = h('button', { type: 'button', class: 'btn ghost au-cancel', hidden: true, onclick: cancel }, 'Cancel login');
    input.addEventListener('input', () => paint());
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    input.addEventListener('focus', () => { if (input.scrollIntoView) setTimeout(() => input.scrollIntoView({ block: 'center' }), 250); });
    const box = h('div', { class: 'box ausheet', role: 'dialog', 'aria-label': 'Sign in to ' + acct(account) },
      h('div', { class: 'sh' }, h('h3', null, 'Authenticate (' + acct(account) + ')'), h('span', { class: 'sp' }), h('button', { type: 'button', class: 'btn sm ghost icon au-x', title: 'Close, the login keeps running', 'aria-label': 'Close', onclick: close }, ico('x', 15))),
      h('div', { class: 'au-body' },
        h('div', { class: 'au-stline' }, stateEl, count),
        h('ol', { class: 'au-steps' }, h('li', null, 'Open the sign-in page and approve the login.'), h('li', null, 'Copy the code it shows and paste it below.')),
        link,
        h('div', { class: 'au-row' }, copyBtn),
        h('div', { class: 'au-field' }, input, pasteBtn),
        submitBtn,
        h('div', { class: 'au-row au-foot' }, startBtn, h('span', { class: 'sp' }), cancelBtn)));
    const observer = new MutationObserver(() => { if (m.classList.contains('hidden')) cleanup(); });
    observer.observe(m, { attributes: true, attributeFilter: ['class'] });
    const c = { account, box, input, stateEl, count, link, copyBtn, submit: submitBtn, startBtn, cancelBtn, observer, local: null, localAt: 0, starting: false, sending: null, err: '', okTimer: 0, timer: 0 };
    ui.cur = c;
    m.replaceChildren(box);
    m.onclick = e => { if (e.target === m) close(); };
    m.classList.remove('hidden');
    c.timer = setInterval(tick, TICK);
    paint();
    const lg = (rec(account) || {}).login;
    if (!lg || !ACTIVE.concat('ok').includes(lg.state)) start();
    else if (!IS_PHONE && lg.state === 'waiting') input.focus();
  }

  function onState() {
    paintHeader();
    for (const box of document.querySelectorAll('[data-chat]')) paintBox(box);
    if (ui.cur) paint();
  }

  return { open, close, onState, composerShown: paintBox, buttons: () => [...wrap.children] };
})();
