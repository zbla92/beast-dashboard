const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-fullscreen.js'), 'utf8');

const build = ({ fine = true, keyboard = true, displayFull = false, size = 'screen', refuse = false, activation = null } = {}) => {
  const calls = [];
  const win = {};
  const docL = {};
  const clock = { t: 1000 };
  const frameKeys = [];
  const frame = { tagName: 'IFRAME', contentWindow: { addEventListener(t, f, c) { if (t === 'keydown' && c && !frameKeys.includes(f)) frameKeys.push(f); } } };
  const on = (bag, t, f) => { (bag[t] = bag[t] || []).push(f); };
  const doc = {
    fullscreenElement: null,
    documentElement: {},
    addEventListener(t, f) { on(docL, t, f); },
    querySelectorAll: s => s === 'iframe' ? [frame] : [],
    exitFullscreen: async () => { calls.push('exit'); doc.fullscreenElement = null; (docL.fullscreenchange || []).forEach(f => f()); },
  };
  doc.documentElement.requestFullscreen = async o => {
    calls.push(['request', o.navigationUI]);
    if (refuse) throw new Error('denied');
    doc.fullscreenElement = doc.documentElement; (docL.fullscreenchange || []).forEach(f => f());
  };
  const sandbox = {
    FEAT: {}, calls, toasts: [], document: doc,
    Date: { now: () => clock.t },
    screen: { width: 1512, height: 982 },
    outerWidth: size === 'screen' ? 1512 : size === 'maximized' ? 1528 : 1400, outerHeight: size === 'screen' ? 982 : size === 'maximized' ? 998 : 900,
    screenX: size === 'maximized' ? -8 : 0, screenY: size === 'maximized' ? -8 : 0,
    matchMedia: q => ({ matches: q.includes('display-mode') ? displayFull : fine }),
    navigator: { ...(keyboard ? { keyboard: { lock: async keys => { calls.push(['lock', keys.join(',')]); }, unlock: () => calls.push('unlock') } } : {}), ...(activation ? { userActivation: activation } : {}) },
    window: { addEventListener(t, f) { on(win, t, f); } },
    toast(m) { sandbox.toasts.push(m); },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const fire = (bag, t, e) => { for (const f of bag[t] || []) { if (e.stopped) break; f(e); } return e; };
  const key = (k, repeat = false, isTrusted = true) => fire(win, 'keydown', { type: 'keydown', key: k, repeat, isTrusted, stopped: false, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  const click = () => fire(win, 'pointerdown', { type: 'pointerdown' });
  const resize = () => fire(win, 'resize', {});
  return { s: sandbox, calls, clock, key, click, resize, doc, frame, frameKeys, docL };
};
const settle = async () => { for (const _ of Array(6)) await new Promise(r => setImmediate(r)); };
const requests = calls => calls.filter(c => Array.isArray(c) && c[0] === 'request').length;

test('in a full screen window the first click takes the page full screen and locks Escape', async () => {
  const t = build();
  t.click(); await settle();
  assert.strictEqual(requests(t.calls), 1);
  assert.ok(t.calls.some(c => Array.isArray(c) && c[0] === 'lock' && c[1] === 'Escape'));
  t.click(); await settle();
  assert.strictEqual(requests(t.calls), 1);
});

test('display-mode fullscreen counts as a full screen window even when the sizes differ', async () => {
  const t = build({ size: 'small', displayFull: true });
  t.click(); await settle();
  assert.strictEqual(requests(t.calls), 1);
});

test('a normal window, a touch screen or a browser without Keyboard Lock is left alone', async () => {
  for (const o of [{ size: 'small' }, { fine: false }, { keyboard: false }]) {
    const t = build(o);
    t.click(); t.key('a'); await settle();
    assert.strictEqual(requests(t.calls), 0, JSON.stringify(o));
    assert.strictEqual(t.s.FEAT.fullscreen.supported, !(o.fine === false || o.keyboard === false));
  }
});

test('the first Esc reaches the page and asks for a second one, the second leaves full screen', async () => {
  const t = build();
  t.click(); await settle();
  const first = t.key('Escape');
  assert.strictEqual(first.stopped, false);
  assert.deepStrictEqual([...t.s.toasts], ['Press Esc again to leave full screen']);
  t.clock.t += 800;
  const second = t.key('Escape'); await settle();
  assert.ok(second.stopped && second.prevented);
  assert.ok(t.calls.includes('exit'));
  assert.ok(t.calls.includes('unlock'));
});

test('a second Esc after the hint has gone just asks again', async () => {
  const t = build();
  t.click(); await settle();
  t.key('Escape');
  t.clock.t += 4000;
  const late = t.key('Escape');
  assert.strictEqual(late.stopped, false);
  assert.strictEqual(t.s.toasts.length, 2);
  assert.ok(!t.calls.includes('exit'));
});

test('a held Esc only counts once, on the page and in the terminal frame', async () => {
  const t = build();
  t.click(); await settle();
  t.key('Escape');
  const held = t.key('Escape', true);
  assert.ok(held.stopped);
  assert.ok(!t.calls.includes('exit'));
  assert.strictEqual(t.frameKeys.length, 1);
  const inFrame = { key: 'Escape', repeat: true, isTrusted: true, stopped: false, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
  t.frameKeys[0](inFrame);
  assert.ok(inFrame.stopped);
});

test('after leaving, clicks do not take full screen again until the window itself leaves full screen', async () => {
  const t = build();
  t.click(); await settle();
  t.key('Escape'); t.clock.t += 500; t.key('Escape'); await settle();
  t.click(); await settle();
  assert.strictEqual(requests(t.calls), 1);
  t.s.outerWidth = 1400; t.s.outerHeight = 900; t.resize();
  t.s.outerWidth = 1512; t.s.outerHeight = 982; t.resize();
  t.click(); await settle();
  assert.strictEqual(requests(t.calls), 2);
});

test('Esc outside page full screen does nothing here, and a refused request is not retried', async () => {
  const t = build({ refuse: true });
  const e = t.key('Escape');
  assert.strictEqual(e.stopped, false);
  assert.strictEqual(t.s.toasts.length, 0);
  t.click(); await settle();
  t.click(); await settle();
  assert.strictEqual(requests(t.calls), 1);
});

test('a modifier key or an event without user activation does not use up the one try', async () => {
  const act = { isActive: false };
  const t = build({ activation: act });
  t.key('Meta'); t.click(); await settle();
  assert.strictEqual(requests(t.calls), 0);
  act.isActive = true;
  t.key('Shift'); await settle();
  assert.strictEqual(requests(t.calls), 0);
  t.key('k'); await settle();
  assert.strictEqual(requests(t.calls), 1);
});

test('a synthetic Esc from the Back gesture is not counted', async () => {
  const t = build();
  t.click(); await settle();
  t.key('Escape', false, false); t.key('Escape', false, false); await settle();
  assert.strictEqual(t.s.toasts.length, 0);
  assert.ok(!t.calls.includes('exit'));
});

test('a maximized window slightly larger than the screen is not treated as full screen', async () => {
  const t = build({ size: 'maximized' });
  t.click(); await settle();
  assert.strictEqual(requests(t.calls), 0);
});

test('a full screen exit the browser makes on its own does not opt out, a held Esc does', async () => {
  const t = build();
  t.click(); await settle();
  await t.doc.exitFullscreen();
  t.click(); await settle();
  assert.strictEqual(requests(t.calls), 2);
  t.key('Escape'); t.key('Escape', true);
  await t.doc.exitFullscreen();
  t.click(); await settle();
  assert.strictEqual(requests(t.calls), 2);
});
