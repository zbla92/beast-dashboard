'use strict';
window.BOT_ICON = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const fill = (d, rule = 'nonzero') => `<path d="${d}" fill="currentColor" fill-opacity=".22" fill-rule="${rule}" stroke="none"/>`;
  const dot = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;
  const PATHS = {
    security: fill('M12 3 4.5 6v5.6c0 4.4 3.1 7.7 7.5 9.4 4.4-1.7 7.5-5 7.5-9.4V6z') + '<path d="M12 3 4.5 6v5.6c0 4.4 3.1 7.7 7.5 9.4 4.4-1.7 7.5-5 7.5-9.4V6z"/><path d="m8.7 12.2 2.3 2.3 4.4-4.8"/>',
    legal: fill('M5 7.5 2.5 13.5a2.75 2.75 0 0 0 5 0zM19 7.5l-2.5 6a2.75 2.75 0 0 0 5 0z') + '<path d="M12 4v16M8 20h8M5 7.5h14"/><path d="M5 7.5 2.5 13.5a2.75 2.75 0 0 0 5 0zM19 7.5l-2.5 6a2.75 2.75 0 0 0 5 0z"/>',
    money: fill('M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z') + '<circle cx="12" cy="12" r="8.5"/><path d="M14.6 9.3c-.4-.9-1.4-1.4-2.6-1.4-1.5 0-2.6.8-2.6 2 0 2.7 5.2 1.3 5.2 4 0 1.2-1.1 2-2.6 2-1.2 0-2.3-.5-2.7-1.4M12 6.6v1.3M12 16.1v1.3"/>',
    translate: fill('M6.5 3.5h5A3 3 0 0 1 14.5 6.5v5a3 3 0 0 1-3 3h-5a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3z') + '<rect x="3.5" y="3.5" width="11" height="11" rx="3"/><path d="M6.3 7.2h5.4M9 5.6v1.6M7 7.2c.4 2 1.6 3.4 3.6 4.2M11.4 7.2c-.5 2.2-1.9 3.6-4.2 4.4"/><path d="m13.5 20.5 3.5-8 3.5 8M14.8 18h4.4"/>',
    review: fill('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z') + '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>' + dot(12, 12, 1),
    test: fill('M7.4 14.5h9.2l2.2 3.8a1.8 1.8 0 0 1-1.6 2.7H6.8a1.8 1.8 0 0 1-1.6-2.7z') + '<path d="M9.5 3.5h5M10.5 3.5v5.8l-5.3 9A1.8 1.8 0 0 0 6.8 21h10.4a1.8 1.8 0 0 0 1.6-2.7l-5.3-9V3.5M7.4 14.5h9.2"/>',
    bug: fill('M12 7.5a4 4 0 0 0-4 4v3a4 4 0 0 0 8 0v-3a4 4 0 0 0-4-4z') + '<path d="M8 11.5a4 4 0 0 1 8 0v3a4 4 0 0 1-8 0zM12 11v8.5M9.5 7.7a2.5 2.5 0 0 1 5 0M4 12.5h4M16 12.5h4M5 6.5 8.3 9M19 6.5 15.7 9M5 19l3.2-2.5M19 19l-3.2-2.5"/>',
    deploy: fill('M4 15.5v3a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-3z') + '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15.5v3A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-3"/>',
    database: fill('M12 3a7.5 3 0 1 0 0 6 7.5 3 0 0 0 0-6z') + '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
    calendar: fill('M3.5 8.5A3.5 3.5 0 0 1 7 5h10a3.5 3.5 0 0 1 3.5 3.5V10h-17z') + '<rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M3.5 10h17M8 3v3.5M16 3v3.5M8 14h2M14 14h2M8 17h2"/>',
    support: fill('M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zm0 5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z', 'evenodd') + '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="m6 6 3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5"/>',
    mail: fill('M6.5 5.5h11a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3z') + '<rect x="3.5" y="5.5" width="17" height="13" rx="3"/><path d="m4 8.5 8 5.5 8-5.5"/>',
    chat: fill('M21 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1.2-4.4A8.5 8.5 0 1 1 21 12z') + '<path d="M21 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1.2-4.4A8.5 8.5 0 1 1 21 12z"/><path d="M8.5 11.5h7M8.5 14.5h4"/>',
    design: fill('M12 3.5a8.5 8.5 0 1 0 0 17c1.3 0 2-.8 2-1.8 0-1.4-1.3-1.5-1.3-2.7 0-.9.7-1.5 1.6-1.5H17a3.5 3.5 0 0 0 3.5-3.5C20.5 6.7 16.8 3.5 12 3.5z') + '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.3 0 2-.8 2-1.8 0-1.4-1.3-1.5-1.3-2.7 0-.9.7-1.5 1.6-1.5H17a3.5 3.5 0 0 0 3.5-3.5C20.5 6.7 16.8 3.5 12 3.5z"/>' + dot(7.6, 11.2, 1.1) + dot(10.3, 7.6, 1.1) + dot(14.7, 7.6, 1.1),
    image: fill('M6.5 4.5h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3z') + '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m4 17.5 5-4.5 3.5 3 3-2.5 4.5 4"/>',
    chart: fill('M7 11h2.5v6H7zM11.5 7H14v10h-2.5zM16 9.5h2.5V17H16z') + '<path d="M4 4v16h16"/><path d="M8.2 17v-6M12.7 17V7M17.2 17V9.5"/>',
    data: fill('M6 4.5h12a2.5 2.5 0 0 1 2.5 2.5v3h-17V7A2.5 2.5 0 0 1 6 4.5z') + '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M3.5 14.8h17M10 10v9.5"/>',
    search: fill('M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z') + '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    docs: fill('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z') + '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 16.5h4"/>',
    write: fill('m4 20 1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z') + '<path d="m4 20 1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z"/><path d="m14.5 6.5 3 3"/>',
    cloud: fill('M7 18.5a4 4 0 0 1-.4-7.98 5.5 5.5 0 0 1 10.6 1.2A3.4 3.4 0 0 1 17 18.5z') + '<path d="M7 18.5a4 4 0 0 1-.4-7.98 5.5 5.5 0 0 1 10.6 1.2A3.4 3.4 0 0 1 17 18.5z"/>',
    terminal: fill('M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z') + '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9.5 3 2.5-3 2.5M13 15h4"/>',
    code: fill('M6.5 4.5h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3z') + '<path d="m9 9-3 3 3 3M15 9l3 3-3 3M13 8l-2 8"/>',
    robot: fill('M8 8h8a4 4 0 0 1 4 4v3.5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z') + '<rect x="4" y="8" width="16" height="11.5" rx="4"/><path d="M12 8V4.8M2.5 12.5v3M21.5 12.5v3M9.5 16.5h5"/>' + dot(12, 4, 1) + dot(9, 12.5, 1.15) + dot(15, 12.5, 1.15)
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
    t.style.background = `linear-gradient(150deg, color-mix(in srgb, ${color} 34%, transparent), color-mix(in srgb, ${color} 13%, transparent))`;
    t.style.boxShadow = `inset 0 0 0 1px color-mix(in srgb, ${color} 30%, transparent), inset 0 1px 0 rgba(255,255,255,.1)`;
    t.style.color = `color-mix(in srgb, ${color} 72%, white)`;
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
