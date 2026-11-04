const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const from = src.indexOf('const RELOAD_QUIET_MS');
const to = src.indexOf('const refocusAfterReload');
const { RELOAD_QUIET_MS, reloadWaits } = new Function(`${src.slice(from, to)}; return { RELOAD_QUIET_MS, reloadWaits };`)();

test('an update waits while the person is active on the page', () => {
  assert.equal(reloadWaits(false, 0), true);
  assert.equal(reloadWaits(false, RELOAD_QUIET_MS - 1), true);
});

test('an update goes through after a quiet stretch', () => {
  assert.equal(reloadWaits(false, RELOAD_QUIET_MS), false);
});

test('a page in the background updates right away', () => {
  assert.equal(reloadWaits(true, 0), false);
});
