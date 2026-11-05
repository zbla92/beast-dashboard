const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const edits = require('../lib/edits');

const toolUse = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name, input }] } }) + '\n';
const schema = JSON.stringify({ tools: [{ name: 'Edit', description: 'edits', input_schema: { type: 'object' } }] }) + '\n';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-edits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  edits.init({});
  const main = path.join(dir, 'sess.jsonl');
  return { dir, main };
}

test('scan finds main and subagent edits, replace_all first, escaped paths, ignores schema mentions', async t => {
  const { dir, main } = setup(t);
  fs.writeFileSync(main, schema
    + toolUse('Edit', { file_path: '/r/a.js', old_string: 'x', new_string: 'y' })
    + toolUse('Edit', { replace_all: true, file_path: '/r/b.js', old_string: 'x', new_string: 'y' })
    + toolUse('Write', { file_path: '/r/we "ird"\\name.txt', content: 'z' })
    + toolUse('NotebookEdit', { notebook_path: '/r/n.ipynb', new_source: '' })
    + toolUse('Read', { file_path: '/r/read-only.js' }));
  const sub = path.join(dir, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), toolUse('MultiEdit', { file_path: '/r/a.js', edits: [] }) + toolUse('Edit', { file_path: '/r/c.js' }));
  const out = await edits.scan(main);
  const by = Object.fromEntries(out.map(x => [x.path, x]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['/r/a.js', '/r/b.js', '/r/c.js', '/r/n.ipynb', '/r/we "ird"\\name.txt'].sort());
  assert.strictEqual(by['/r/a.js'].by, 'both');
  assert.strictEqual(by['/r/a.js'].count, 2);
  assert.strictEqual(by['/r/c.js'].by, 'agent');
  assert.strictEqual(by['/r/b.js'].by, 'main');
  assert.strictEqual(by['/r/n.ipynb'].tool, 'NotebookEdit');
  assert.deepStrictEqual(await edits.scan('/nope/x.jsonl'), []);
  assert.deepStrictEqual(await edits.scan('not-a-transcript'), []);
});

test('incremental append reads only complete lines; a rewrite triggers a full re-read', async t => {
  const { main } = setup(t);
  fs.writeFileSync(main, toolUse('Edit', { file_path: '/r/a.js' }));
  assert.deepStrictEqual((await edits.scan(main)).map(x => x.path), ['/r/a.js']);
  const half = toolUse('Edit', { file_path: '/r/b.js' });
  fs.appendFileSync(main, half.slice(0, 20));
  assert.deepStrictEqual((await edits.scan(main)).map(x => x.path), ['/r/a.js']);
  fs.appendFileSync(main, half.slice(20) + toolUse('Edit', { file_path: '/r/a.js' }));
  const after = await edits.scan(main);
  assert.deepStrictEqual(after.map(x => x.path).sort(), ['/r/a.js', '/r/b.js']);
  assert.strictEqual(after.find(x => x.path === '/r/a.js').count, 2);
  assert.strictEqual(after[0].path, '/r/a.js');
  fs.writeFileSync(main, toolUse('Write', { file_path: '/r/only.js' }));
  assert.deepStrictEqual((await edits.scan(main)).map(x => x.path), ['/r/only.js']);
});

test('large deltas go through grep and give the same hits', async t => {
  const { main } = setup(t);
  const filler = JSON.stringify({ type: 'user', pad: 'x'.repeat(1024 * 1024) }) + '\n';
  let body = '';
  for (let i = 0; i < 9; i++) body += filler + toolUse('Edit', { replace_all: false, file_path: `/r/f${i}.js` });
  fs.writeFileSync(main, body);
  const out = await edits.scan(main);
  assert.strictEqual(out.length, 9);
  assert.strictEqual(out[0].path, '/r/f8.js');
});

test('byPath lists sessions that edited a file, newest first, with label and live session', async t => {
  const { dir } = setup(t);
  const now = Date.now();
  const mk = (name, lines, mtime) => { const f = path.join(dir, name + '.jsonl'); fs.writeFileSync(f, lines); fs.utimesSync(f, mtime / 1000, mtime / 1000); return f; };
  const older = mk('old', toolUse('Edit', { file_path: '/r/shared.js' }), now - 3600e3);
  const newer = mk('new', toolUse('Edit', { file_path: '/r/shared.js' }) + toolUse('Write', { file_path: '/r/own.js' }), now - 60e3);
  const ancient = mk('ancient', toolUse('Edit', { file_path: '/r/shared.js' }), now - 30 * 864e5);
  edits.init({
    entries: () => [
      { id: 'o', file: older, lastAt: now - 3600e3, title: 'old one' },
      { id: 'n', file: newer, lastAt: now - 60e3, title: 'new one' },
      { id: 'a', file: ancient, lastAt: now - 30 * 864e5 },
    ],
    live: id => id === 'n' ? 'bd-1' : null,
    label: id => id === 'o' ? 'Labelled' : null,
  });
  assert.strictEqual(edits.indexReady(), false);
  await edits.refreshIndex(true);
  assert.strictEqual(edits.indexReady(), true);
  const hits = edits.byPath('/r/shared.js');
  assert.deepStrictEqual(hits.map(h => h.sessionId), ['n', 'o']);
  assert.strictEqual(hits[0].live, 'bd-1');
  assert.strictEqual(hits[1].label, 'Labelled');
  assert.strictEqual(hits[0].label, 'new one');
  assert.deepStrictEqual(edits.byPath('/r/own.js').map(h => h.sessionId), ['n']);
  assert.deepStrictEqual(edits.byPath('/r/none.js'), []);
});

test('cwdsOf counts the folders of a transcript and its subagents, also past the inline limit and across appends', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-cwds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  edits.init({});
  const main = path.join(root, 's.jsonl');
  const line = cwd => JSON.stringify({ type: 'user', cwd, message: { content: 'x'.repeat(2000) } }) + '\n';
  fs.writeFileSync(main, line('/r/a').repeat(200) + line('/r/b').repeat(2));
  const sub = path.join(root, 's', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), line('/r/b'));
  const count = async () => Object.fromEntries((await edits.cwdsOf(main)).map(c => [c.dir, c.count]));
  assert.deepStrictEqual(await count(), { '/r/a': 200, '/r/b': 3 });
  fs.appendFileSync(main, line('/r/c'));
  assert.deepStrictEqual(await count(), { '/r/a': 200, '/r/b': 3, '/r/c': 1 });
  assert.deepStrictEqual(await edits.cwdsOf('not-a-transcript'), []);
});
