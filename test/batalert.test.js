const test = require('node:test');
const assert = require('node:assert');
const { createBatteryAlert } = require('../lib/batalert');

const off = pct => ({ pct, status: 'Discharging', ac: false });
const on = (pct, status = 'Charging') => ({ pct, status, ac: true });

test('one push at 25 %, one more at 10 %, nothing in between or below', () => {
  const a = createBatteryAlert();
  assert.deepStrictEqual([40, 26, 25, 24, 11, 10, 9, 3].map(p => a.check(off(p))), [null, null, 25, null, null, 10, null, null]);
});

test('plugged in and charging never pushes; unplugging below 25 % does', () => {
  const a = createBatteryAlert();
  assert.strictEqual(a.check(on(20)), null);
  assert.strictEqual(a.check(off(20)), 25);
});

test('a weak charger flipping Charging / Discharging around 20 % pushes once', () => {
  const a = createBatteryAlert();
  const seen = [off(22), on(22), on(21, 'Discharging'), on(22), on(21, 'Discharging'), on(23)].map(b => a.check(b));
  assert.deepStrictEqual(seen, [25, null, null, null, null, null]);
});

test('charged back above 30 % arms it again', () => {
  const a = createBatteryAlert();
  assert.strictEqual(a.check(off(25)), 25);
  assert.strictEqual(a.check(on(28)), null);
  assert.strictEqual(a.check(off(26)), null);   // never got above 30: still disarmed for 25
  assert.strictEqual(a.check(on(31)), null);
  assert.strictEqual(a.check(off(25)), 25);
});

test('starting below both levels gives one push, not two; no battery gives none', () => {
  const a = createBatteryAlert();
  assert.strictEqual(a.check(off(8)), 10);
  assert.strictEqual(a.check(off(7)), null);
  assert.strictEqual(createBatteryAlert().check(null), null);
});
