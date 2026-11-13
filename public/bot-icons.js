'use strict';
window.BOT_ICON = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const PATHS = {
    security: '<path d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 9.5-4.1-1.9-7-5.3-7-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
    legal: '<path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7 2.5 13a3 3 0 0 0 5 0zM19 7l-2.5 6a3 3 0 0 0 5 0z"/>',
    money: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2c-.4-.8-1.3-1.2-2.5-1.2-1.5 0-2.5.8-2.5 1.9 0 2.6 5 1.2 5 3.9 0 1.1-1 1.9-2.5 1.9-1.2 0-2.2-.5-2.6-1.3M12 6.5V8M12 16v1.5"/>',
    translate: '<path d="M4 6h9M8.5 4v2M6 6c.5 3 2.5 5.5 5.5 7M11 6c-.5 3-3 6-6.5 7.5"/><path d="m12.5 20 4-9 4 9M13.8 17h5.4"/>',
    review: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    test: '<path d="M9.5 3.5h5M10.5 3.5v6L5 19a1.5 1.5 0 0 0 1.3 2.2h11.4A1.5 1.5 0 0 0 19 19l-5.5-9.5v-6"/><path d="M7.8 15h8.4"/>',
    bug: '<rect x="8" y="7" width="8" height="12" rx="4"/><path d="M9.5 7.5a2.5 2.5 0 0 1 5 0M4 12h4M16 12h4M5 6.5 8 9M19 6.5 16 9M5 19l3-2.5M19 19l-3-2.5M12 11v8"/>',
    deploy: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
    database: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    support: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="m6 6 3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="3"/><path d="m3.5 8 8.5 6 8.5-6"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.2A8 8 0 1 1 21 12z"/>',
    design: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.3 0 2-.8 2-1.8 0-1.4-1.3-1.5-1.3-2.7 0-.9.7-1.5 1.6-1.5H17a3.5 3.5 0 0 0 3.5-3.5C20.5 6.7 16.8 3.5 12 3.5z"/><circle cx="7.5" cy="11" r=".7"/><circle cx="10" cy="7.5" r=".7"/><circle cx="14.5" cy="7.5" r=".7"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4"/>',
    chart: '<path d="M4 4v16h16"/><path d="M8 16v-4M12.5 16V8M17 16v-6"/>',
    data: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M3.5 15h17M10 10v9.5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    docs: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    write: '<path d="m4 20 1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z"/><path d="m14.5 6.5 3 3"/>',
    cloud: '<path d="M7 18.5a4 4 0 0 1-.4-7.98 5.5 5.5 0 0 1 10.6 1.2A3.4 3.4 0 0 1 17 18.5z"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    code: '<path d="m8 8-4.5 4L8 16M16 8l4.5 4L16 16M13.5 5.5l-3 13"/>',
    robot: '<rect x="4.5" y="8" width="15" height="11.5" rx="3.5"/><path d="M12 8V4.5M2.5 13v2M21.5 13v2M9.5 17h5"/><circle cx="12" cy="4" r=".6"/><circle cx="9" cy="13.5" r="1"/><circle cx="15" cy="13.5" r="1"/>'
  };
  const keys = ['security', 'legal', 'money', 'translate', 'review', 'test', 'bug', 'deploy', 'database', 'calendar', 'support', 'mail', 'chat', 'design', 'image', 'chart', 'data', 'search', 'docs', 'write', 'cloud', 'terminal', 'code', 'robot'];
  const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  const FALLBACK_COLOR = '#64748b';

  function svg(key, size = 16) {
    const e = document.createElementNS(NS, 'svg');
    e.setAttribute('viewBox', '0 0 24 24');
    e.setAttribute('width', size);
    e.setAttribute('height', size);
    e.setAttribute('fill', 'none');
    e.setAttribute('stroke', 'currentColor');
    e.setAttribute('stroke-width', '1.6');
    e.setAttribute('stroke-linecap', 'round');
    e.setAttribute('stroke-linejoin', 'round');
    e.setAttribute('class', 'ico bot-ico');
    e.setAttribute('aria-hidden', 'true');
    e.innerHTML = PATHS[key] || PATHS.robot;
    return e;
  }

  function tile(bot, size = 32) {
    const b = bot || {};
    const color = COLOR.test(b.iconColor || '') ? b.iconColor : FALLBACK_COLOR;
    const glyph = typeof b.iconGlyph === 'string' && [...b.iconGlyph].length === 1 ? b.iconGlyph : '';
    const t = document.createElement('span');
    t.className = 'bot-tile';
    t.setAttribute('role', 'img');
    t.setAttribute('aria-label', String(b.name || 'bot'));
    t.style.display = 'inline-grid';
    t.style.placeItems = 'center';
    t.style.flex = 'none';
    t.style.background = `linear-gradient(145deg, color-mix(in srgb, ${color} 38%, transparent), color-mix(in srgb, ${color} 12%, transparent))`;
    t.style.boxShadow = `inset 0 0 0 1px color-mix(in srgb, ${color} 32%, transparent)`;
    t.style.color = `color-mix(in srgb, ${color} 78%, white)`;
    t.style.width = size + 'px';
    t.style.height = size + 'px';
    t.style.borderRadius = Math.round(size * 0.3) + 'px';
    if (glyph) {
      t.classList.add('bot-tile-glyph');
      t.style.fontSize = Math.round(size * 0.5) + 'px';
      t.textContent = glyph;
    } else {
      t.append(svg(b.iconKey, Math.round(size * 0.58)));
    }
    return t;
  }

  return { keys, svg, tile };
})();
