const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const cardSrc = appSrc.slice(appSrc.indexOf('const ASKC = new WeakMap()'), appSrc.indexOf('// Poll while a conversation is on screen'));
const textOf = n => n == null || n === false ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : n.kids.map(textOf).join('');
const findAll = (n, pred, out = []) => {
  if (Array.isArray(n)) for (const x of n) findAll(x, pred, out);
  else if (n && typeof n === 'object') { if (pred(n)) out.push(n); findAll(n.kids, pred, out); }
  return out;
};
const boot = () => {
  const calls = [];
  const ctx = {
    WeakMap,
    h: (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids, classList: { add() {}, remove() {}, toggle() {} }, innerHTML: '' }),
    gl: x => x,
    mdLite: t => 'MD:' + t,
    toast() {},
    api: async (ep, body) => { calls.push({ ep, body }); return { ok: true }; },
  };
  vm.runInNewContext(cardSrc + '; this.askCard = askCard;', ctx);
  return { askCard: ctx.askCard, calls };
};
const buttons = card => findAll(card, n => n.tag === 'button');
const press = (card, label) => buttons(card).find(b => textOf(b) === label).attrs.onclick();

test('a plan approval shows the plan and two working buttons, and no empty question form', async () => {
  const { askCard, calls } = boot();
  const card = askCard({}, 'claude-x', { rid: 'r1', kind: 'question', tool: 'ExitPlanMode', input: { plan: '# Do it' } }, () => {});
  assert.deepStrictEqual(buttons(card).map(textOf), ['Approve and start', 'Keep planning']);
  assert.strictEqual(findAll(card, n => n.attrs.class === 'ttext askplan')[0].innerHTML, 'MD:# Do it');
  assert.ok(!textOf(card).includes('Send answers'));
  await press(card, 'Approve and start');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [{ ep: 'hl-answer', body: { session: 'claude-x', rid: 'r1', decision: 'allow', answers: {} } }]);
});

test('Keep planning declines with a message Claude can read', async () => {
  const { askCard, calls } = boot();
  const card = askCard({}, 'claude-x', { rid: 'r2', kind: 'question', tool: 'ExitPlanMode', input: { plan: 'p' } }, () => {});
  await press(card, 'Keep planning');
  assert.strictEqual(calls[0].body.decision, 'deny');
  assert.strictEqual(calls[0].body.message, 'The user wants to keep planning.');
});

test('a plan approval without plan text still has its buttons, and gains the text when the live stream brings it', () => {
  const { askCard } = boot();
  const box = {};
  const bare = askCard(box, 'claude-x', { rid: 'r3', kind: 'question', tool: 'ExitPlanMode' }, () => {});
  assert.deepStrictEqual(buttons(bare).map(textOf), ['Approve and start', 'Keep planning']);
  assert.strictEqual(askCard(box, 'claude-x', { rid: 'r3', kind: 'question', tool: 'ExitPlanMode' }, () => {}), bare);
  const full = askCard(box, 'claude-x', { rid: 'r3', kind: 'question', tool: 'ExitPlanMode', input: { plan: 'p' } }, () => {});
  assert.notStrictEqual(full, bare);
  assert.strictEqual(findAll(full, n => n.attrs.class === 'ttext askplan')[0].innerHTML, 'MD:p');
});

test('any other tool in that shape gets Allow and Deny with its name', () => {
  const { askCard } = boot();
  const card = askCard({}, 'claude-x', { rid: 'r4', kind: 'question', tool: 'Mystery', what: 'Mystery' }, () => {});
  assert.deepStrictEqual(buttons(card).map(textOf), ['Allow', 'Deny']);
  assert.ok(textOf(card).includes('Claude wants to use Mystery'));
});

test('a real question keeps its options and Skip', () => {
  const { askCard } = boot();
  const q = { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true };
  const labels = buttons(askCard({}, 'claude-x', { rid: 'r5', kind: 'question', tool: 'AskUserQuestion', questions: [q] }, () => {})).map(textOf);
  assert.deepStrictEqual(labels, ['A', 'B', 'Send answers', 'Skip']);
});
