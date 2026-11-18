'use strict';
FEAT.activity = (() => {
  const SILENT_MS = 10 * 60 * 1000;
  const age = ms => { const m = Math.floor(ms / 60000); return m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h' : Math.floor(m / 1440) + 'd'; };
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  function agentsOf(name, cl) {
    const known = FEAT.subagents?.agents(name) || [];
    const mayBeSilent = cl.state !== 'working' && !FEAT.subagents?.partial(name);
    return (cl.bgTasks || []).flatMap(t => {
      const a = known.find(x => x.agentId === t.id);
      if (a && a.done) return [];
      const quiet = a && a.lastAt ? Date.now() - a.lastAt : 0;
      return [{ description: t.description || t.type || t.id, silent: mayBeSilent && quiet > SILENT_MS ? quiet : 0 }];
    });
  }

  function shellsOf(name, cl) {
    const s = S.runtime.sessions.find(x => x.name === name);
    const count = s && s.toolShells || 0;
    const described = cl.waitingOn ? (cl.waitingOn.shells || []).map(x => x.description || x.id).slice(0, count) : [];
    return { count, described };
  }

  const spinner = () => h('span', { class: 'act-spin' });

  function agentsPart(name, agents) {
    const silent = agents.filter(a => a.silent);
    return h('button', { class: 'act-part act-agents' + (silent.length ? ' act-silent' : ''), title: 'open subagents', onclick: () => FEAT.subagents.sheet(name) },
      spinner(),
      h('b', null, plural(agents.length, 'agent')),
      h('span', { class: 'act-desc' }, agents.map(a => a.description).join(' · ')),
      ...silent.map(a => h('span', { class: 'act-warn' }, 'silent ' + age(a.silent))));
  }

  function build(name) {
    const cl = claudeOf(name);
    if (!cl || cl.mode !== 'chat') return null;
    const agents = agentsOf(name, cl);
    const shells = shellsOf(name, cl);
    const parts = [
      agents.length ? agentsPart(name, agents) : null,
      shells.count ? h('span', { class: 'act-part' }, spinner(), h('b', null, plural(shells.count, 'command') + ' running'), shells.described.length ? h('span', { class: 'act-desc' }, shells.described.join(' · ')) : null) : null,
    ].filter(Boolean);
    return parts.length ? parts : null;
  }

  const signature = parts => parts.map(p => p.textContent).join('|');

  function paintBox(box) {
    const name = box.dataset.chat;
    const found = box.querySelector(':scope > .act-strip');
    const parts = name ? build(name) : null;
    if (!parts) { if (found) found.remove(); return; }
    const sig = signature(parts);
    if (found && found.dataset.sig === sig) return;
    const strip = h('div', { class: 'act-strip' }, ...parts);
    strip.dataset.sig = sig;
    if (found) { found.replaceWith(strip); return; }
    const scroller = box.querySelector(':scope > .cscroll');
    if (!scroller) return;
    const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    scroller.after(strip);
    if (pinned) scroller.scrollTop = scroller.scrollHeight;
  }

  function onState() {
    for (const box of document.querySelectorAll('[data-chat]')) paintBox(box);
  }

  setInterval(() => { if (!document.hidden) onState(); }, 5000);

  return { composerShown: paintBox, onState };
})();
