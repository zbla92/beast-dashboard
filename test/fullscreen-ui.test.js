const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'f-fullscreen.js'), 'utf8');

const build = ({ fine = true, keyboard = true, canFull = true, refuse = false } = {}) => {
  const calls = [];
  const listeners = {};
  const winKeys = [];
  const frameKeys = [];
  const frame = { tagName: 'IFRAME', contentWindow: { addEventListener(t, f, c) { if (t === 'keydown' && c && !frameKeys.includes(f)) frameKeys.push(f); } } };
  const settingsBtn = { id: 'btn-settings' };
  const bar = { inserted: [], insertBefore(n, ref) { bar.inserted.push([n, ref]); } };
  const doc = {
    fullscreenElement: null,
    documentElement: {},
    addEventListener(t, f) { listeners[t] = f; },
    querySelectorAll: s => s === 'iframe' ? [frame] : [],
    exitFullscreen: async () => { calls.push('exit'); doc.fullscreenElement = null; listeners.fullscreenchange?.(); },
  };
  if (canFull) doc.documentElement.requestFullscreen = async o => {
    calls.push(['request', o]);
    if (refuse) throw new Error('denied');
    doc.fullscreenElement = doc.documentElement; listeners.fullscreenchange?.();
  };
  const sandbox = {
    FEAT: {}, calls, bar, toasts: [], document: doc,
    window: { addEventListener(t, f, c) { if (t === 'keydown' && c) winKeys.push(f); } },
    matchMedia: () => ({ matches: fine }),
    navigator: keyboard ? { keyboard: { lock: async keys => { calls.push(['lock', keys]); }, unlock: () => calls.push('unlock') } } : {},
    h: (tag, attrs) => ({ tag, ...attrs, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
    $: s => s === '.topbtns' ? bar : s === '#btn-settings' ? settingsBtn : null,
    toast(m, k) { sandbox.toasts.push([m, k]); },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { ...sandbox, settingsBtn, winKeys, frameKeys, frame, listeners, btn: bar.inserted[0]?.[0] };
};
const settle = async () => { for (const _ of Array(6)) await new Promise(r => setImmediate(r)); };

test('the button sits before Settings and full screen locks Escape so a short Esc reaches the page', async () => {
  const s = build();
  assert.strictEqual(s.bar.inserted.length, 1);
  assert.strictEqual(s.bar.inserted[0][1], s.settingsBtn);
  assert.match(s.btn.title, /^Full screen/);
  s.btn.onclick();
  await settle();
  assert.strictEqual(JSON.stringify(s.calls[0]), JSON.stringify(['request', { navigationUI: 'hide' }]));
  assert.ok(s.calls.some(c => Array.isArray(c) && c[0] === 'lock' && c[1].length === 1 && c[1][0] === 'Escape'));
  assert.match(s.btn.title, /^Leave full screen/);
});

test('leaving full screen unlocks the keyboard', async () => {
  const s = build();
  s.btn.onclick(); await settle();
  s.btn.onclick(); await settle();
  assert.ok(s.calls.includes('exit'));
  assert.ok(s.calls.includes('unlock'));
  assert.match(s.btn.title, /^Full screen/);
});

test('without the Keyboard Lock API full screen still works', async () => {
  const s = build({ keyboard: false });
  s.btn.onclick(); await settle();
  assert.strictEqual(JSON.stringify(s.calls), JSON.stringify([['request', { navigationUI: 'hide' }]]));
  assert.strictEqual(s.toasts.length, 0);
});

test('a refused request shows an error instead of throwing', async () => {
  const s = build({ refuse: true });
  s.btn.onclick(); await settle();
  assert.strictEqual(s.toasts.length, 1);
  assert.strictEqual(s.toasts[0][1], 'err');
  assert.ok(!s.calls.some(c => Array.isArray(c) && c[0] === 'lock'));
});

test('touch screens and browsers without the Fullscreen API get no button and no palette item', () => {
  for (const o of [{ fine: false }, { canFull: false }]) {
    const s = build(o);
    assert.strictEqual(s.bar.inserted.length, 0);
    assert.deepStrictEqual(Array.from(s.FEAT.fullscreen.paletteItems()), []);
  }
});

test('the palette item follows the state', async () => {
  const s = build();
  assert.strictEqual(s.FEAT.fullscreen.paletteItems()[0].label, 'Full screen');
  s.btn.onclick(); await settle();
  assert.strictEqual(s.FEAT.fullscreen.paletteItems()[0].label, 'Leave full screen');
});

const esc = repeat => ({ key: 'Escape', repeat, stopped: false, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });

test('holding Esc in full screen only lets the first press through, on the page and in the terminal frame', async () => {
  const s = build();
  assert.strictEqual(s.winKeys.length, 1);
  const first = esc(false), held = esc(true), outside = esc(true);
  s.winKeys[0](outside);
  assert.strictEqual(outside.stopped, false);
  s.btn.onclick(); await settle();
  s.winKeys[0](first); s.winKeys[0](held);
  assert.strictEqual(first.stopped, false);
  assert.ok(held.stopped && held.prevented);
  assert.strictEqual(s.frameKeys.length, 1);
  const inFrame = esc(true);
  s.frameKeys[0](inFrame);
  assert.ok(inFrame.stopped);
  s.listeners.load({ target: s.frame });
  assert.strictEqual(s.frameKeys.length, 1);
});
