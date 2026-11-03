'use strict';
FEAT.shell = (() => {
  const SHOW = 12, CAP = 64 * 1024;
  const all = new Set();
  const snap = () => HL.snap;
  const find = id => ((snap() || {}).shells || []).find(x => x.id === id);
  const chipText = e => e.state === 'running' ? 'running' : e.state === 'stopped' ? 'stopped' : e.state === 'timeout' ? 'timed out' : e.state === 'error' ? 'failed' : e.signal ? 'killed ' + e.signal : 'exit ' + (e.code ?? 0);
  const bad = e => e.state === 'error' || e.state === 'timeout' || (e.state === 'done' && (e.code !== 0 || !!e.signal));

  function paint(el, e) {
    const pre = el.querySelector('.shout'), more = el.querySelector('.shmore');
    const ls = String(e.out || '').replace(/\n$/, '').split('\n'), open = all.has(e.id), hide = !open && ls.length > SHOW;
    const text = (e.cut ? '… earlier output cut\n' : '') + (hide ? ls.slice(-SHOW) : ls).join('\n');
    pre.classList.toggle('hidden', !e.out);
    if (pre.textContent !== text) { pre.textContent = text; if (open || e.state === 'running') pre.scrollTop = pre.scrollHeight; }
    pre.classList.toggle('full', open);
    more.classList.toggle('hidden', ls.length <= SHOW);
    more.textContent = open ? 'show less' : `show all (${ls.length} lines)`;
  }

  function card(e, name) {
    const act = e.state === 'running'
      ? h('button', { class: 'btn sm ghost danger', title: 'stop the command', onclick: () => api('hl-shell-stop', { session: name, id: e.id }).catch(x => toast(x.message, 'err')) }, ico('stop', 13), h('span', { class: 'shl' }, 'Stop'))
      : h('button', { class: 'btn sm ghost', title: 'remove it — Claude will not see this output', onclick: () => api('hl-shell-drop', { session: name, id: e.id }).catch(x => toast(x.message, 'err')) }, ico('x', 13));
    const chip = h('span', { class: 'shchip' + (bad(e) ? ' bad' : '') + (e.state === 'running' ? ' run' : '') }, chipText(e), e.state === 'running' ? h('span', { class: 'wtimer', 'data-since': e.at }, ' · ' + elapsedTxt(e.at)) : e.end ? ' · ' + durTxt(e.end - e.at) : null);
    const more = h('button', { class: 'shmore hidden', onclick: ev => { const cur = find(e.id) || e; if (all.has(e.id)) all.delete(e.id); else all.add(e.id); paint(ev.currentTarget.closest('.shcard'), cur); } });
    const el = h('div', { class: 'turn user shell shcard ' + e.state, 'data-id': e.id },
      h('div', { class: 'who' }, gl('❯ you · shell'), hhmm(e.at), chip, h('span', { class: 'sp' }), act),
      h('pre', { class: 'mcode small shcmd' }, '! ' + e.cmd),
      h('pre', { class: 'mcode small shout hidden' }), more,
      h('div', { class: 'shnote' }, 'Claude sees this with your next message'));
    paint(el, e);
    return el;
  }

  return {
    is: v => v.startsWith('!'),
    async run(name, v) {
      const cmd = v.slice(1).trim();
      if (!cmd) { toast('type a command after the !'); return false; }
      try { await api('hl-shell', { session: name, cmd }); return true; } catch (e) { toast(e.message, 'err'); return false; }
    },
    bar(name, cl) {
      if (cl.mode !== 'chat') return null;
      const el = h('div', { class: 'cshell hidden' }, h('span', { class: 'cshbadge' }, '! shell'), h('span', { class: 'cshint' }, 'runs in ' + ((cl.cwd || '').split('/').filter(Boolean).pop() || 'the session folder') + ' · Claude sees it with your next message'));
      return { el, sync: v => { const on = v.startsWith('!'); el.classList.toggle('hidden', !on); return on; } };
    },
    convTail(name, lv) {
      return ((lv && lv.shells) || []).map(e => card(e, name));
    },
    liveEvent(ev, o, s) {
      if (ev === 'shells') { s.shells = o.shells || []; return; }
      if (!s.shells) s.shells = [];
      if (ev === 'shell') { const i = s.shells.findIndex(x => x.id === o.shell.id); if (i < 0) s.shells.push(o.shell); else s.shells[i] = o.shell; return; }
      const e = s.shells.find(x => x.id === o.id); if (!e) return;
      e.out = (e.out || '') + o.chunk;
      if (e.out.length > CAP) { e.out = e.out.slice(-CAP); e.cut = true; }
      for (const el of document.querySelectorAll(`.shcard[data-id="${CSS.escape(o.id)}"]`)) paint(el, e);
    },
  };
})();
