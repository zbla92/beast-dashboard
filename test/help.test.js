'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pub = path.join(__dirname, '..', 'public');
const HELP = vm.runInNewContext(fs.readFileSync(path.join(pub, 'f-help-topics.js'), 'utf8') + '\nHELP;', {});
const ids = new Set(HELP.map(t => t.id));
const jsFiles = fs.readdirSync(pub).filter(f => f.endsWith('.js')).map(f => ({ f, src: fs.readFileSync(path.join(pub, f), 'utf8') }));

const nonEmpty = (v, what) => assert.ok(typeof v === 'string' && v.trim().length > 0, what);

test('HELP is a non-empty list of topics with unique ids', () => {
  assert.ok(Array.isArray(HELP) && HELP.length > 0);
  assert.equal(ids.size, HELP.length);
  for (const t of HELP) assert.match(t.id, /^[a-z0-9-]+$/);
});

test('every topic has its fields with the right types', () => {
  const allowed = new Set(['id', 'title', 'icon', 'short', 'sections', 'docs']);
  for (const t of HELP) {
    for (const k of Object.keys(t)) assert.ok(allowed.has(k), `${t.id}: unknown field ${k}`);
    nonEmpty(t.title, `${t.id}: title`);
    nonEmpty(t.icon, `${t.id}: icon`);
    nonEmpty(t.short, `${t.id}: short`);
    assert.ok(Array.isArray(t.sections) && t.sections.length > 0, `${t.id}: sections`);
    for (const s of t.sections) {
      assert.deepEqual(Object.keys(s).sort(), ['h', 'md'], `${t.id}: section fields`);
      nonEmpty(s.h, `${t.id}: section heading`);
      nonEmpty(s.md, `${t.id}: section ${s.h}`);
    }
    if ('docs' in t) assert.match(t.docs, /^docs\/guide\/[\w-]+\.md(#[\w-]+)?$/, `${t.id}: docs`);
  }
});

test('every docs path points at an existing guide', () => {
  for (const t of HELP.filter(x => x.docs)) assert.ok(fs.existsSync(path.join(__dirname, '..', t.docs.split('#')[0])), `${t.id}: ${t.docs}`);
});

test('every topic icon is an outline icon', () => {
  const app = jsFiles.find(x => x.f === 'app.js').src;
  const block = app.slice(app.indexOf('const ICONS = {'), app.indexOf('\n};', app.indexOf('const ICONS = {')));
  const known = new Set([...block.matchAll(/^\s+([A-Za-z0-9]+): '/gm)].map(m => m[1]));
  for (const { src } of jsFiles) for (const m of src.matchAll(/\bICONS\.([A-Za-z0-9]+)\s*=/g)) known.add(m[1]);
  for (const t of HELP) assert.ok(known.has(t.icon), `${t.id}: icon ${t.icon}`);
});

test('every helpTip call names a topic that exists', () => {
  const calls = jsFiles.flatMap(({ f, src }) => [...src.matchAll(/\bhelpTip\(\s*(['"])([^'"]+)\1\s*\)/g)].map(m => ({ f, id: m[2] })));
  assert.ok(calls.length > 0);
  for (const c of calls) assert.ok(ids.has(c.id), `${c.f}: helpTip('${c.id}') has no topic`);
});

test('every SECT_HELP id in app.js names a topic that exists', () => {
  const app = jsFiles.find(x => x.f === 'app.js').src;
  const lit = app.match(/const SECT_HELP = (\{[^}]*\});/);
  assert.ok(lit);
  const map = vm.runInNewContext('(' + lit[1] + ')', {});
  assert.ok(Object.keys(map).length > 0);
  for (const [sec, id] of Object.entries(map)) assert.ok(ids.has(id), `SECT_HELP.${sec}: '${id}' has no topic`);
});
