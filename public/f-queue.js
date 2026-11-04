'use strict';
FEAT.queue = (() => {
  const KEY = 'bd.chat.followUp', SHOW = 3;
  const more = new Set();
  const hm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const followUp = () => { try { return localStorage.getItem(KEY) === 'queue' ? 'queue' : 'steer'; } catch { return 'steer'; } };
  const setFollowUp = v => { try { localStorage.setItem(KEY, v === 'queue' ? 'queue' : 'steer'); } catch {} };

  function waitingRow(m) {
    return h('div', { class: 'qrow waiting', title: 'Already in Claude\'s input: Claude reads it at its next step (after the running tool) — it can\'t be cancelled any more' },
      h('div', { class: 'qtext' }, m.text), h('div', { class: 'qmeta' }, 'Waiting for Claude', h('span', { class: 'qtime' }, ' · ' + hm(m.at))));
  }

  function queuedRow(j, C, refresh) {
    const text = j.prompts.slice(j.idx || 0).join('\n\n');
    const drop = () => api('schedule-remove', { id: j.id });
    return h('div', { class: 'qrow queued', title: 'queued: goes out by itself when this turn is over' },
      h('div', { class: 'qtext' }, text), h('div', { class: 'qmeta' }, 'Queued' + (j.prompts.length > 1 ? ` · ${j.prompts.length} messages` : '')),
      h('div', { class: 'qacts' },
        h('button', { class: 'btn sm ghost', title: 'send it now — into the running turn', onclick: () => api('schedule-now', { id: j.id }).then(() => { toast('sent'); setTimeout(refresh, 800); }).catch(e => toast(e.message, 'err')) }, ico('send', 13), h('span', { class: 'ql' }, 'Send now')),
        h('button', { class: 'btn sm ghost', title: 'take it out of the queue and back into the box', onclick: ev => { const box = ev.currentTarget.closest('[data-chat]'); drop().then(() => { const c = (box && box.querySelector('.cbox2') || {})._c || C, cur = c.ta.value.trim(); c.ta.value = cur ? cur + '\n\n' + text : text; c.grow(); c.ta.focus(); }).catch(e => toast(e.message, 'err')); } }, ico('pencil', 13), h('span', { class: 'ql' }, 'Edit')),
        h('button', { class: 'btn sm ghost danger', title: 'remove from the queue', onclick: () => drop().then(() => toast('removed from the queue')).catch(e => toast(e.message, 'err')) }, ico('x', 13), h('span', { class: 'ql' }, 'Cancel'))));
  }

  function stack(name, o) {
    const rows = [...o.waiting.map(waitingRow), ...o.jobs.map(j => queuedRow(j, o.C, o.refresh))];
    if (!rows.length) { more.delete(name); return null; }
    const extra = rows.length - SHOW;
    rows.slice(SHOW).forEach(r => r.classList.add('qextra'));
    const el = h('div', { class: 'qstack' + (more.has(name) ? ' open' : '') });
    const label = () => el.classList.contains('open') ? 'Show less' : `${extra} more`;
    const toggle = extra > 0 ? h('button', { class: 'qmore', onclick: ev => { const on = el.classList.toggle('open'); if (on) more.add(name); else more.delete(name); ev.currentTarget.textContent = label(); } }) : null;
    el.append(h('div', { class: 'qlist' }, rows, toggle));
    if (toggle) toggle.textContent = label();
    return el;
  }

  return { followUp, setFollowUp, stack };
})();
