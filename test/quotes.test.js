const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const appSrc = pub('app.js');
const mdLiteSrc = appSrc.slice(appSrc.indexOf('function mdLite('), appSrc.indexOf('// A past conversation from search'));
const escSrc = appSrc.slice(appSrc.indexOf('const esc = s =>'), appSrc.indexOf('const fmtB ='));

const mdCtx = vm.createContext({ LANG: {}, hlLines: code => code.split('\n').map(l => l.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))) });
vm.runInContext(escSrc + mdLiteSrc + ';this.mdLite = mdLite;', mdCtx);
const mdLite = mdCtx.mdLite;

const fakeStorage = (init = {}) => {
  const data = new Map(Object.entries(init));
  return { data, getItem: k => data.has(k) ? data.get(k) : null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
};

const fakeH = (tag, attrs, ...kids) => {
  if (attrs && 'html' in attrs) throw new Error('chips must not use html');
  const el = { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(k => k != null), classList: { toggle() {} } };
  el.append = (...more) => el.kids.push(...more.filter(k => k != null));
  el.closest = () => null;
  return el;
};

const boot = (localStorage = fakeStorage()) => {
  const on = () => {};
  const ctx = {
    FEAT: {}, localStorage, h: fakeH, ico: n => ({ icon: n }), console, setTimeout, clearTimeout,
    document: { addEventListener: on, querySelectorAll: () => [] }, window: { addEventListener: on }, getSelection: () => null,
  };
  vm.createContext(ctx);
  vm.runInContext(pub('f-quotes.js'), ctx);
  return { Q: ctx.FEAT.quotes, localStorage };
};
const plain = v => JSON.parse(JSON.stringify(v));

test('compose: quotes, then their question, then the typed text, separated by blank lines', () => {
  const { Q } = boot();
  assert.strictEqual(Q.compose([{ quote: 'one\ntwo', ask: ' why? ' }, { quote: 'three', ask: '' }], ' and this '), '> one\n> two\n\nwhy?\n\n> three\n\nand this');
});

test('compose: every quote line is prefixed, blank lines too, and an empty box is fine', () => {
  const { Q } = boot();
  assert.strictEqual(Q.compose([{ quote: 'a\n\nb', ask: '' }], ''), '> a\n> \n> b');
  assert.strictEqual(Q.compose([], 'just text'), 'just text');
  assert.strictEqual(Q.compose([], '   '), '');
});

test('message: empty without chips, the quote alone with chips and an empty box', () => {
  const { Q } = boot();
  assert.strictEqual(Q.message('s', ''), '');
  assert.strictEqual(Q.has('s'), false);
  Q.add('s', 'quoted');
  assert.strictEqual(Q.has('s'), true);
  assert.strictEqual(Q.message('s', ''), '> quoted');
});

test('persistence: chips and questions are stored per session and read back after a reload', () => {
  const store = fakeStorage();
  const first = boot(store).Q;
  const chip = first.add('s1', 'quote one');
  first.setAsk('s1', chip.id, 'what is this');
  first.add('s2', 'other session');
  const again = boot(store).Q;
  assert.deepStrictEqual(plain(again.load('s1')).map(c => [c.quote, c.ask]), [['quote one', 'what is this']]);
  assert.deepStrictEqual(plain(again.load('s2')).map(c => c.quote), ['other session']);
  assert.ok(store.data.has('bd.quotes.s1'));
});

test('persistence: removing the last chip removes the key', () => {
  const store = fakeStorage();
  const { Q } = boot(store);
  const a = Q.add('s', 'a'), b = Q.add('s', 'b');
  Q.remove('s', a.id);
  assert.deepStrictEqual(plain(Q.load('s')).map(c => c.id), [b.id]);
  Q.remove('s', b.id);
  assert.ok(!store.data.has('bd.quotes.s'));
});

test('persistence: corrupted or wrong-shaped storage reads as no chips', () => {
  for (const raw of ['{not json', 'null', '42', '{"a":1}', '[null,1,{"id":"x"},{"id":1,"quote":"q"},{"id":"y","quote":""}]']) {
    const { Q } = boot(fakeStorage({ 'bd.quotes.s': raw }));
    assert.deepStrictEqual(plain(Q.load('s')), [], raw);
    assert.strictEqual(Q.has('s'), false);
  }
  const { Q } = boot(fakeStorage({ 'bd.quotes.s': '[{"id":"y","quote":"kept","ask":7}]' }));
  assert.deepStrictEqual(plain(Q.load('s')), [{ id: 'y', quote: 'kept', ask: '' }]);
});

test('persistence: storage that throws still keeps the chips in this tab', () => {
  const boom = () => { throw new Error('denied'); };
  const { Q } = boot({ getItem: boom, setItem: boom, removeItem: boom });
  Q.add('s', 'q');
  assert.strictEqual(Q.message('s', ''), '> q');
});

test('take clears the chips; restore after a failed send puts them back with their questions', () => {
  const store = fakeStorage();
  const { Q } = boot(store);
  const chip = Q.add('s', 'quote');
  Q.setAsk('s', chip.id, 'question');
  const before = Q.message('s', 'typed');
  const taken = Q.take('s');
  assert.strictEqual(Q.has('s'), false);
  assert.ok(!store.data.has('bd.quotes.s'));
  Q.restore('s', taken);
  assert.strictEqual(Q.message('s', 'typed'), before);
  assert.ok(store.data.has('bd.quotes.s'));
});

test('a slash command goes out alone and the chips wait', () => {
  const { Q } = boot(fakeStorage());
  Q.add('s', 'quote');
  assert.strictEqual(Q.message('s', '/compact'), '/compact');
  assert.strictEqual(Q.take('s', '/compact').length, 0);
  assert.strictEqual(Q.has('s'), true);
});

test('restore keeps chips added while the send was in flight, after the restored ones', () => {
  const { Q } = boot();
  Q.add('s', 'first');
  const taken = Q.take('s');
  Q.add('s', 'second');
  Q.restore('s', taken);
  assert.deepStrictEqual(plain(Q.load('s')).map(c => c.quote), ['first', 'second']);
});

test('cap: short quotes stay whole and are only tidied', () => {
  const { Q } = boot();
  assert.strictEqual(Q.capQuote('\r\n  a\r\nb\n\n\n\nc  \n'), '  a\nb\n\nc');
  const exact = 'x'.repeat(4000);
  assert.strictEqual(Q.capQuote(exact), exact);
});

test('cap: a long quote is cut at the last line break in range and marked', () => {
  const { Q } = boot();
  const cut = Q.capQuote('a'.repeat(3000) + '\n' + 'b'.repeat(500) + '\n' + 'c'.repeat(3000));
  assert.strictEqual(cut, 'a'.repeat(3000) + '\n' + 'b'.repeat(500) + '…');
  assert.ok(cut.length <= 4000);
});

test('cap: without a line break in range it cuts at the cap, never inside a surrogate pair', () => {
  const { Q } = boot();
  const cut = Q.capQuote('y'.repeat(5000));
  assert.strictEqual(cut.length, 4000);
  assert.ok(cut.endsWith('y…'));
  const emoji = Q.capQuote('z'.repeat(3998) + '😀' + 'z'.repeat(50));
  assert.strictEqual(emoji, 'z'.repeat(3998) + '…');
});

test('pill position: above the first visible line on desktop, below the last one on phone, inside the viewport', () => {
  const { Q } = boot();
  const view = { left: 0, top: 0, right: 1000, bottom: 800 }, box = { left: 100, top: 50, right: 1000, bottom: 700 };
  const rects = [{ left: 200, right: 400, top: 200, bottom: 220, width: 200 }, { left: 200, right: 600, top: 220, bottom: 240, width: 400 }];
  assert.deepStrictEqual(plain(Q.pillPos(rects, view, box, 100, 32, false)), { left: 250, top: 160 });
  const phone = plain(Q.pillPos(rects, view, box, 100, 40, true));
  assert.deepStrictEqual(phone, { left: 350, top: 268 });
  const edge = plain(Q.pillPos([{ left: 980, right: 1000, top: 52, bottom: 70, width: 20 }], view, box, 100, 32, false));
  assert.ok(edge.left + 100 <= 1000 && edge.top >= 50, JSON.stringify(edge));
  const bottom = plain(Q.pillPos([{ left: 200, right: 300, top: 670, bottom: 690, width: 100 }], view, box, 100, 40, true));
  assert.ok(bottom.top + 40 <= 700 && bottom.top < 670, JSON.stringify(bottom));
});

test('pill position: null when every selected line has scrolled out of the chat', () => {
  const { Q } = boot();
  const view = { left: 0, top: 0, right: 1000, bottom: 800 }, box = { left: 0, top: 100, right: 1000, bottom: 700 };
  assert.strictEqual(Q.pillPos([{ left: 0, right: 90, top: 20, bottom: 40, width: 90 }], view, box, 100, 32, false), null);
  assert.strictEqual(Q.pillPos([{ left: 0, right: 90, top: 710, bottom: 730, width: 90 }], view, box, 100, 32, false), null);
  assert.strictEqual(Q.pillPos([], view, box, 100, 32, false), null);
});

const textOf = el => typeof el === 'string' ? el : (el.kids || []).map(textOf).join('');

test('chips: a <script> quote stays literal text and never reaches html', () => {
  const { Q } = boot();
  const evil = '<script>window.PWNED=1</script><img src=x onerror=alert(1)>';
  const el = Q.chipEl('s', { id: 'i', quote: evil, ask: '' });
  assert.ok(textOf(el).includes(evil));
});

test('mdLite: consecutive quote lines become one blockquote and text after it is outside', () => {
  assert.strictEqual(mdLite('> one\n> two\n\nquestion'), '<blockquote class="mquote">one<br>two</blockquote>question');
  assert.strictEqual(mdLite('before\n\n> q\n\nafter'), 'before<blockquote class="mquote">q</blockquote>after');
  assert.strictEqual(mdLite('> a\n> \n> b'), '<blockquote class="mquote">a<br><br>b</blockquote>');
});

test('mdLite: a line starting with > and no space is not swallowed into the quote', () => {
  assert.strictEqual(mdLite('> a\n>b\nc'), '<blockquote class="mquote">a</blockquote>&gt;b<br>c');
});

test('mdLite: two quotes separated by a question stay two blockquotes', () => {
  assert.strictEqual(mdLite('> a\n\nwhy\n\n> b'), '<blockquote class="mquote">a</blockquote>why<blockquote class="mquote">b</blockquote>');
});

test('mdLite: <script> and event handlers inside a quote are escaped', () => {
  const out = mdLite('> <script>window.PWNED=1</script>\n> <img src=x onerror=alert(1)>\n\n<b>hi</b>');
  assert.ok(!/<script|<img|<b>hi/.test(out), out);
  assert.ok(out.includes('&lt;script&gt;window.PWNED=1&lt;/script&gt;'), out);
  assert.ok(out.includes('&lt;b&gt;hi&lt;/b&gt;'), out);
});

test('mdLite: a literal blockquote tag in the text cannot open a real one', () => {
  const out = mdLite('<blockquote class="mquote">x</blockquote>\n> y');
  assert.ok(out.startsWith('&lt;blockquote'), out);
  assert.strictEqual(out.match(/<blockquote/g).length, 1);
  assert.ok(!mdLite('> [a](javascript:alert(1))').includes('href'));
});

test('mdLite: inline formatting and links still work inside a quote', () => {
  const out = mdLite('> **bold** and `code` and [site](https://a.example/x)\n> - item');
  assert.ok(out.includes('<b>bold</b>') && out.includes('<code>code</code>'), out);
  assert.ok(out.includes('<a href="https://a.example/x"'), out);
  assert.ok(out.includes('<span class="mli">• item</span>'), out);
  assert.ok(out.endsWith('</blockquote>'), out);
  assert.ok(mdLite('> see https://a.example/x\n> next').includes('<a href="https://a.example/x" target="_blank" rel="noopener noreferrer">https://a.example/x</a><br>next'));
});

test('mdLite: a code fence keeps its > lines as code, and fence markers inside a quote stay in the quote', () => {
  const fenced = mdLite('```\n> not a quote\n```');
  assert.ok(!fenced.includes('<blockquote'), fenced);
  assert.ok(fenced.includes('&gt; not a quote'), fenced);
  const quoted = mdLite('> ```\n> code\n> ```\n\nafter');
  assert.ok(quoted.startsWith('<blockquote class="mquote">```<br>code<br>```</blockquote>'), quoted);
  assert.ok(!quoted.includes('<pre'), quoted);
});

test('mdLite: tables work next to and inside a quote', () => {
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
  const beside = mdLite('> q\n\n' + table);
  assert.ok(beside.includes('</blockquote><table'), beside);
  assert.ok(beside.includes('<td>1</td>'), beside);
  const inside = mdLite(table.trimEnd().split('\n').map(l => '> ' + l).join('\n'));
  assert.ok(inside.startsWith('<blockquote class="mquote"><table'), inside);
  assert.ok(inside.endsWith('</table></blockquote>'), inside);
});

test('mdLite: > in the middle of a line, or without a space, is not a quote', () => {
  assert.strictEqual(mdLite('a > b'), 'a &gt; b');
  assert.strictEqual(mdLite('>nope'), '&gt;nope');
  assert.strictEqual(mdLite('plain\ntext'), 'plain<br>text');
});
