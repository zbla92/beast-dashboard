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

test('a message that opens with a file path is not a slash command: quotes go with it, and the marker keeps the CLI from holding it to the end of the turn', () => {
  const { Q } = boot(fakeStorage());
  Q.add('s', 'quoted');
  Q.setAsk('s', Q.load('s')[0].id, 'why');
  const typed = '/home/me/.pasted/shot.jpg look';
  assert.strictEqual(Q.message('s', typed), `> quoted\n\nwhy\n\n${typed}`);
  assert.strictEqual(Q.take('s', typed).length, 1);
  assert.strictEqual(Q.message('s', typed), `📎 ${typed}`);
  assert.strictEqual(Q.message('s', '/plugin:cmd arg'), '/plugin:cmd arg');
  assert.strictEqual(Q.message('s', '/compact'), '/compact');
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

test('pill position: above the first visible line on desktop, inside the viewport', () => {
  const { Q } = boot();
  const view = { left: 0, top: 0, right: 1000, bottom: 800 }, box = { left: 100, top: 50, right: 1000, bottom: 700 };
  const rects = [{ left: 200, right: 400, top: 200, bottom: 220, width: 200 }, { left: 200, right: 600, top: 220, bottom: 240, width: 400 }];
  assert.deepStrictEqual(plain(Q.pillPos(rects, view, box, 100, 32)), { left: 250, top: 160 });
  const edge = plain(Q.pillPos([{ left: 980, right: 1000, top: 52, bottom: 70, width: 20 }], view, box, 100, 32));
  assert.ok(edge.left + 100 <= 1000 && edge.top >= 50, JSON.stringify(edge));
});

test('phone pill: stays above the composer, away from the native menu, and moves to the top when the selection ends low', () => {
  const { Q } = boot();
  const view = { left: 0, top: 0, right: 390, bottom: 844 }, box = { left: 0, top: 100, right: 390, bottom: 600 };
  const line = (top, bottom) => [{ left: 20, right: 200, top, bottom, width: 180 }];
  assert.deepStrictEqual(plain(Q.dockPos(line(200, 220), view, box, 110, 40)), { left: 140, top: 552 });
  assert.deepStrictEqual(plain(Q.dockPos(line(500, 520), view, box, 110, 40)), { left: 140, top: 108 });
  assert.deepStrictEqual(plain(Q.dockPos(line(200, 220), { ...view, bottom: 400 }, box, 110, 40)), { left: 140, top: 108 + 244 });
  assert.strictEqual(Q.dockPos(line(20, 40), view, box, 110, 40), null);
  assert.strictEqual(Q.dockPos(line(500, 520), { ...view, bottom: 400 }, box, 110, 40), null, 'the selected line is below the keyboard');
  assert.strictEqual(Q.dockPos(line(110, 130), view, { ...box, bottom: 140 }, 110, 40), null, 'no room for the pill');
  assert.strictEqual(plain(Q.dockPos(line(170, 520), view, box, 110, 40)).top, 552, 'a long selection takes the spot further from it');
  const lowFirst = [{ left: 20, right: 200, top: 490, bottom: 510, width: 180 }, { left: 220, right: 300, top: 450, bottom: 470, width: 80 }];
  assert.strictEqual(plain(Q.dockPos(lowFirst, view, box, 110, 40)).top, 108, 'the lowest line counts, not the last one');
});

test('pill position: null when every selected line has scrolled out of the chat', () => {
  const { Q } = boot();
  const view = { left: 0, top: 0, right: 1000, bottom: 800 }, box = { left: 0, top: 100, right: 1000, bottom: 700 };
  assert.strictEqual(Q.pillPos([{ left: 0, right: 90, top: 20, bottom: 40, width: 90 }], view, box, 100, 32), null);
  assert.strictEqual(Q.pillPos([{ left: 0, right: 90, top: 710, bottom: 730, width: 90 }], view, box, 100, 32), null);
  assert.strictEqual(Q.pillPos([], view, box, 100, 32), null);
});

const textOf = el => typeof el === 'string' ? el : (el.kids || []).map(textOf).join('');

test('tray label and the search for a quote in the chat', () => {
  const { Q } = boot();
  assert.strictEqual(Q.quotesLabel(1), '1 quote');
  assert.strictEqual(Q.quotesLabel(3), '3 quotes');
  assert.strictEqual(Q.needleOf('a line\n\nthe next  one…'), 'alinethenextone');
  assert.strictEqual(Q.nearestMatch('abcxabcxabc', 'abc', 5), 4);
  assert.strictEqual(Q.nearestMatch('abcxabcxabc', 'abc', 100), 8);
  assert.strictEqual(Q.nearestMatch('abcxabcxabc', 'abc', undefined), 8);
  assert.strictEqual(Q.nearestMatch('abcxabc', 'zzz', 0), -1);
  assert.strictEqual(Q.nearestMatch('abc', '', 0), -1);
});

test('a position in the text without spaces maps back to the place in the page text', () => {
  const { Q } = boot();
  const first = { nodeValue: '  ab c\n' }, second = { nodeValue: 'd  e' };
  const parts = [{ node: first, start: 0, size: 3 }, { node: second, start: 3, size: 2 }];
  assert.deepStrictEqual(plain(Q.pointAt(parts, 2)).offset, 5);
  assert.strictEqual(Q.pointAt(parts, 3).node, second);
  assert.strictEqual(Q.pointAt(parts, 4).offset, 3);
});

test('persistence: where the quote started is stored and a bad value is dropped', () => {
  const { Q } = boot();
  assert.strictEqual(plain(Q.add('s', 'text', 42)).at, 42);
  assert.strictEqual('at' in plain(Q.add('s', 'text')), false);
  assert.deepStrictEqual(plain(Q.parse(JSON.stringify([{ id: 'a', quote: 'q', at: 7 }, { id: 'b', quote: 'q', at: 'x' }]))), [{ id: 'a', quote: 'q', ask: '', at: 7 }, { id: 'b', quote: 'q', ask: '' }]);
});

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
