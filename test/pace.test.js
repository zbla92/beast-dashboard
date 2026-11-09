const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-pace.js'), 'utf8');
const fakeH = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k != null) });
const text = el => el == null ? '' : typeof el === 'string' ? el : el.kids.map(text).join('');
const boot = () => { const ctx = { FEAT: {}, h: fakeH, whenStr: ts => new Date(ts).toISOString().slice(5, 16), Date, Math }; vm.createContext(ctx); vm.runInContext(src, ctx); return ctx.FEAT.pace; };

const H = 3600e3, DAY = 24 * H, WEEK = 7 * DAY;
const reset = Date.UTC(2026, 10, 13, 15, 0);           // Fri 13 Nov 16:00 CET
const read = Date.UTC(2026, 10, 9, 20, 6);             // Mon 9 Nov 21:06 CET: 58% used
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} not within ${tol} of ${b}`);

test('58% after 3d 5h of the week: runs out Thursday early morning, about 35 h before the reset; 11%/day lasts', () => {
  const P = boot();
  const p = P.calc({ pct: 58, resetsAt: reset }, WEEK, read, read + 2 * 60000);
  near(p.tick, (WEEK - (reset - read)) / WEEK, 0.001, 'tick');
  near(p.perDay, 18, 0.2, 'per day');
  near(p.emptyAt, Date.UTC(2026, 10, 12, 4, 0), 10 * 60000, 'empty at');   // Thu 12 Nov ~05:00 CET
  near(p.early / H, 35, 0.5, 'hours early');
  near(p.budget, 11.1, 0.1, 'budget');
  assert.ok(p.atReset > 100);
});

test('a night without work makes the outlook better: same 58% read 14 h later', () => {
  const P = boot();
  const now = P.calc({ pct: 58, resetsAt: reset }, WEEK, read, read);
  const morning = P.calc({ pct: 58, resetsAt: reset }, WEEK, read + 14 * H, read + 14 * H);
  assert.ok(morning.perDay < now.perDay);
  assert.ok(morning.emptyAt > now.emptyAt);
  assert.ok(morning.early < now.early);
});

test('an even pace lasts: no out time, only the share at the reset', () => {
  const P = boot();
  const p = P.calc({ pct: 30, resetsAt: reset }, WEEK, read, read);
  near(p.atReset, 30 * WEEK / (WEEK - (reset - read)), 0.01, 'at reset');
  assert.strictEqual(p.emptyAt, undefined);
});

test('the % is taken as of its fetch, not the clock: a stale read is not counted as idle time', () => {
  const P = boot();
  const fresh = P.calc({ pct: 58, resetsAt: reset }, WEEK, read, read);
  const later = P.calc({ pct: 58, resetsAt: reset }, WEEK, read, read + 3 * H);
  assert.strictEqual(later.emptyAt, fresh.emptyAt);
  assert.ok(later.tick > fresh.tick);   // the tick is the clock
});

test('no outlook too early in the window, with nothing used, at the limit or after the reset: only the tick', () => {
  const P = boot();
  const start = reset - WEEK;
  assert.deepStrictEqual(Object.keys(P.calc({ pct: 3, resetsAt: reset }, WEEK, start + 4 * H, start + 4 * H)), ['tick']);
  assert.deepStrictEqual(Object.keys(P.calc({ pct: 0, resetsAt: reset }, WEEK, read, read)), ['tick']);
  assert.deepStrictEqual(Object.keys(P.calc({ pct: 100, resetsAt: reset }, WEEK, read, read)), ['tick']);
  assert.strictEqual(P.calc({ pct: 0, reset: true, resetAt: reset }, WEEK, read, read), null);
  assert.strictEqual(P.calc({ pct: 20, resetsAt: null }, WEEK, read, read), null);
  assert.strictEqual(P.calc(null, WEEK, read, read), null);
});

test('rendered: the week line says when it runs out and what lasts; the rail drops the budget; the 5 h window gets no line', () => {
  const P = boot();
  const realNow = Date.now; Date.now = () => read + 60000;
  try {
    const L = { fetchedAt: read };
    const card = P.limitPace({ pct: 58, resetsAt: reset }, 'week', L, 'card');
    assert.match(card.attrs.class, /lpace early/);
    assert.match(text(card), /^Pace: out 11-12T0[34]:\d\d · 1d 1[01]h early · keep ≤11%\/day$/);
    const rail = P.limitPace({ pct: 58, resetsAt: reset }, 'week', L, 'rail');
    assert.match(rail.attrs.class, /ru-pace early/);
    assert.doesNotMatch(text(rail), /keep/);
    assert.match(text(P.limitPace({ pct: 30, resetsAt: reset }, 'week', L, 'rail')), /^Pace: ~6\d% at reset$/);
    assert.strictEqual(P.limitPace({ pct: 58, resetsAt: read + 2 * H }, 'session', L, 'card'), null);
    assert.ok(P.limitBar({ pct: 58, resetsAt: read + 2 * H }, 'session', L).attrs.style.startsWith('left:60.'));
    assert.strictEqual(P.limitBar({ pct: 0, resetsAt: reset }, 'week', L), null);
  } finally { Date.now = realNow; }
});

test('durations read like the reset countdown', () => {
  const P = boot();
  assert.strictEqual(P.dur(20 * 1000), '1m');
  assert.strictEqual(P.dur(40 * 60000), '40m');
  assert.strictEqual(P.dur(5 * H + 20 * 60000), '5h 20m');
  assert.strictEqual(P.dur(35 * H), '1d 11h');
});
