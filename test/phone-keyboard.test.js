const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const src = appSrc.slice(appSrc.indexOf('const KB_MIN_HEIGHT'), appSrc.indexOf('function syncKeyboard'));
const ctx = vm.createContext({});
vm.runInContext(src + ';this.keyboardUp = keyboardUp;this.nextKb = nextKb;', ctx);
const { keyboardUp, nextKb } = ctx;

test('the keyboard counts as up only while typing in the chat and the view shrank a lot', () => {
  assert.strictEqual(keyboardUp(844, 470, true), true);
  assert.strictEqual(keyboardUp(844, 470, false), false);
  assert.strictEqual(keyboardUp(844, 844, true), false);
});

test('a browser address bar sliding away is not a keyboard', () => {
  assert.strictEqual(keyboardUp(844, 760, true), false);
});

test('the full height is kept while typing, so the keyboard shows as a difference', () => {
  assert.strictEqual(nextKb({ base: 844, width: 390 }, 470, 390, true).base, 844);
  assert.strictEqual(nextKb({ base: 800, width: 390 }, 844, 390, true).base, 844);
});

test('with nothing focused the current height becomes the new full height', () => {
  assert.strictEqual(nextKb({ base: 844, width: 390 }, 420, 390, false).base, 420);
});

test('rotating starts over from the new height, even with the composer focused', () => {
  assert.strictEqual(nextKb({ base: 844, width: 390 }, 390, 844, true).base, 390);
  assert.strictEqual(keyboardUp(nextKb({ base: 844, width: 390 }, 390, 844, true).base, 390, true), false);
});

test('rounding from zoom does not count as rotating', () => {
  assert.strictEqual(nextKb({ base: 844, width: 390 }, 470, 391, true).base, 844);
});
