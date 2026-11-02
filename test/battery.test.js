const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { battery } = require('../lib/sys');

// a fake /sys/class/power_supply: Apple's ACPI battery (charge_* in µAh / µA) behind a mains adapter
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-ps-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const put = (n, files) => { fs.mkdirSync(path.join(dir, n), { recursive: true }); for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, n, f), v + '\n'); };
const read = ({ online = 1, status, now = 6062000, curAvg = 40000 }) => {
  put('ADP1', { type: 'Mains', online });
  put('BAT0', { type: 'Battery', present: 1, status, charge_now: now, charge_full: 6218000, charge_full_design: 7334000, current_avg: curAvg, voltage_now: 12526000, cycle_count: 188 });
  return battery(dir);
};
const unplug = () => read({ online: 0, status: 'Discharging', curAvg: 900000 });

test('full on AC with the firmware flipping Full / Discharging on a trickle reads full every time', () => {
  unplug();
  const seen = ['Discharging', 'Full', 'Discharging', 'Full', 'Discharging'].map(status => read({ status }));
  assert.deepStrictEqual(seen.map(b => b.status), ['Not charging', 'Full', 'Full', 'Full', 'Full']);   // 97 %: the first tick has nothing to go by
  assert.deepStrictEqual([seen[4].pct, seen[4].ac, seen[4].health, seen[4].cycles], [97, true, 85, 188]);
});

test('a firmware that says Not charging between the flips keeps that word', () => {
  unplug();
  assert.deepStrictEqual(['Not charging', 'Discharging', 'Not charging', 'Discharging'].map(status => read({ status, now: 4975000 }).status), ['Not charging', 'Not charging', 'Not charging', 'Not charging']);
});

test('unplugging forgets it, and a charger too weak for the load still drains', () => {
  unplug(); read({ status: 'Full' });
  assert.strictEqual(unplug().status, 'Discharging');
  assert.strictEqual(read({ status: 'Discharging', now: 3700000, curAvg: 200000 }).status, 'Discharging');   // 60 %, 2.5 W out
  assert.strictEqual(read({ status: 'Discharging' }).status, 'Not charging');   // 97 % on a trickle, no word from the firmware since
});
