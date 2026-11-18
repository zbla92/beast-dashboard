'use strict';
(() => {
  const LEAD = /^[\s:–—·|]/;
  const SEP = /^[\s:\-–—·|]+/;

  function strip(project, text) {
    if (!text || !project) return text || '';
    const t = text.trim();
    const p = project.toLowerCase();
    if (t.toLowerCase() === p) return '';
    if (t.toLowerCase().startsWith(p) && LEAD.test(t.slice(p.length))) return t.slice(p.length).replace(SEP, '');
    return t;
  }

  function names(it, project, tuck, fallback, plain) {
    const cl = it.claude;
    const raw = isNewChat(it.name) ? chatTitle(cl) : (cl?.label || withoutLeadingPaths(cl?.title) || '');
    const title = strip(project, raw);
    if (project && !tuck) return { name: project, line: title || (cl?.lastPrompt ? shortPrompt(withoutLeadingPaths(cl.lastPrompt)) : '') };
    if (tuck) return { name: title || plain, line: '' };
    return { name: title || fallback, line: '' };
  }

  function group(g, row) {
    if (g.items.length === 1) return [row(g.items[0], 'claude', false, g.pid ? g.project : null)];
    return [h('div', { class: 'rgrp-p flat' },
      h('div', { class: 'rproj', title: g.items.length + ' Claude sessions on ' + g.project }, avatar(g.pid, 'sm'), h('b', null, g.project), h('em', null, String(g.items.length))),
      ...g.items.map(it => row(it, 'claude', true, g.pid ? g.project : null)))];
  }

  FEAT.railflat = { names, group, strip };
})();
