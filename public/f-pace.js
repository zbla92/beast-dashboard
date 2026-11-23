'use strict';
// Pace: will a plan window last until it resets? Worked out from what the limits fetch already brings (the % and the
// reset time), so no extra request to Anthropic. The window started at resetsAt − its length; the % was read at the
// account's fetchedAt; pace = % ÷ time since the start. Hours without work lower the pace, so the outlook gets better
// overnight. Every bar in use gets a tick where an even pace would be by now (fill past the tick = spending faster than that);
// the 7-day windows also get a line: "~80% at reset", or when they run out and how much to keep under per day.
FEAT.pace = (() => {
  const H = 3600e3, DAY = 24 * H;
  const LEN = { session: 5 * H, week: 7 * DAY };
  const MIN_SHARE = 0.05;   // under 5% of the window gone (8 h of a week) the pace is mostly noise: no outlook yet

  // w: { pct, resetsAt, reset }, len: window length (ms), asOf: when the % was read, now: the clock
  function calc(w, len, asOf, now) {
    if (!w || w.reset || !w.resetsAt || w.pct == null || !len) return null;
    const start = w.resetsAt - len; const at = Math.min(asOf || now, now);
    const out = { tick: Math.min(1, Math.max(0, (now - start) / len)) };
    const gone = at - start;
    if (w.pct <= 0 || w.pct >= 100 || gone < len * MIN_SHARE || at >= w.resetsAt) return out;
    const rate = w.pct / gone;   // % per ms
    out.gone = gone;
    out.perDay = rate * DAY;
    out.atReset = w.pct + rate * (w.resetsAt - at);
    if (out.atReset < 100) return out;
    out.emptyAt = at + (100 - w.pct) / rate;
    out.early = w.resetsAt - out.emptyAt;
    out.budget = (100 - w.pct) / Math.max(H, w.resetsAt - now) * DAY;   // % a day from now on that just lasts
    return out;
  }
  // "35h"-style, like the reset countdown next to it: 40m, 5h 20m, 1d 11h
  const dur = ms => { const m = Math.round(Math.max(0, ms) / 60000); if (m < 60) return Math.max(1, m) + 'm'; if (m < 1440) return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : ''); return Math.floor(m / 1440) + 'd ' + Math.floor(m % 1440 / 60) + 'h'; };
  const pc = v => Math.round(v) + '%';

  const kindLen = kind => LEN[kind === 'session' ? 'session' : 'week'];
  const of = (w, kind, L, now = Date.now()) => calc(w, kindLen(kind), L && L.fetchedAt, now);

  function limitBar(w, kind, L) {
    const p = of(w, kind, L); if (!p || !w.pct) return null;   // nothing used: the tick would only be noise
    return h('i', { class: 'pace-tick', style: `left:${(p.tick * 100).toFixed(1)}%`, title: `${pc(p.tick * 100)} of the window has gone by: an even pace would be here` });
  }
  function limitPace(w, kind, L, where) {
    if (kind === 'session') return null;   // the 5-hour window only gets the tick
    const p = of(w, kind, L); if (!p || p.atReset == null) return null;
    const cls = (where === 'rail' ? 'ru-pace' : 'lpace') + (p.emptyAt ? ' early' : '');
    const head = `${w.pct}% in ${dur(p.gone)} · ${pc(p.perDay)} a day so far`;
    if (!p.emptyAt) return h('div', { class: cls, title: `${head} · at that pace about ${pc(p.atReset)} by the reset` }, `Pace: ~${pc(p.atReset)} at reset`);
    const text = `Pace: out ${whenStr(p.emptyAt)} · ${dur(p.early)} early`;
    return h('div', { class: cls, title: `${head} · at that pace it runs out ${whenStr(p.emptyAt)}, ${dur(p.early)} before the reset · to last: at most ${pc(p.budget)} a day` },
      text, where === 'rail' ? null : h('span', { class: 'pace-budget' }, ` · keep ≤${pc(p.budget)}/day`));
  }
  return { calc, dur, limitBar, limitPace };
})();
