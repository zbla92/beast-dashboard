const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sp = require('../lib/specialists');

function tmpRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-specialists-')));
  const before = process.env.BD_SPECIALISTS_DIR;
  process.env.BD_SPECIALISTS_DIR = path.join(dir, 'specialists');
  t.after(() => {
    if (before === undefined) delete process.env.BD_SPECIALISTS_DIR; else process.env.BD_SPECIALISTS_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { tmp: dir, root: path.join(dir, 'specialists') };
}

const status = code => e => e instanceof sp.SpecialistError && e.status === code;

test('root comes from BD_SPECIALISTS_DIR or ~/.beast/specialists', () => {
  assert.strictEqual(sp.root({ BD_SPECIALISTS_DIR: '/tmp/x/../y' }), '/tmp/y');
  assert.strictEqual(sp.root({ HOME: '/home/demo' }), '/home/demo/.beast/specialists');
});

test('names: lowercase slug, no -company ending, no date stamp, run is reserved', () => {
  for (const ok of ['writer', 'a', 'code-reviewer', 'x1', 'a'.repeat(32)]) assert.strictEqual(sp.nameError(ok), null, ok);
  for (const bad of ['', 'Writer', '-a', 'a-', 'a_b', 'a.b', '../x', 'a/b', 'a'.repeat(33), 'x-company', 'x-251111-0930', '251111-0930-x', 'run', 7, null]) {
    assert.ok(sp.nameError(bad), String(bad));
  }
});

test('an empty or missing root lists nothing', t => {
  tmpRoot(t);
  assert.deepStrictEqual(sp.list(), []);
});

test('create writes the profile with defaults and the blank template', t => {
  const { root } = tmpRoot(t);
  const s = sp.create({ name: 'helper', description: 'Answers questions' });
  assert.strictEqual(s.name, 'helper');
  assert.strictEqual(s.title, 'helper');
  assert.strictEqual(s.provider, 'claude');
  assert.strictEqual(s.account, 'personal');
  assert.strictEqual(s.mode, 'run');
  assert.strictEqual(s.permissionMode, 'bypassPermissions');
  assert.strictEqual(s.model, null);
  assert.strictEqual(s.effort, null);
  assert.strictEqual(s.color, null);
  assert.strictEqual(s.dir, path.join(root, 'helper'));
  assert.ok(s.createdAt && s.createdAt === s.updatedAt);
  assert.deepStrictEqual(s.files, { instructions: true, settings: false, mcp: false, skills: [], agents: [] });
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'helper', 'specialist.json'), 'utf8'));
  assert.strictEqual(onDisk.name, 'helper');
  assert.strictEqual(onDisk.description, 'Answers questions');
  assert.match(sp.readInstructions('helper'), /^# helper\n\nAnswers questions\n/);
  assert.deepStrictEqual(fs.readdirSync(root), ['helper']);
});

test('the writer template adds a style guide, an examples folder and its defaults; fields given win', t => {
  const { root } = tmpRoot(t);
  const s = sp.create({ name: 'writer', model: 'sonnet' }, 'writer');
  assert.strictEqual(s.icon, '✎');
  assert.strictEqual(s.permissionMode, 'dontAsk');
  assert.strictEqual(s.model, 'sonnet');
  assert.ok(fs.statSync(path.join(root, 'writer', 'examples')).isDirectory());
  assert.ok(fs.existsSync(path.join(root, 'writer', 'style.md')));
  const text = sp.readInstructions('writer');
  assert.match(text, /@style\.md/);
  assert.match(text, /Only the message text/);
  assert.ok(sp.templates().some(x => x.id === 'writer' && x.meta.permissionMode === 'dontAsk'));
  assert.throws(() => sp.create({ name: 'other' }, 'nope'), status(400));
});

test('create refuses bad input, unknown fields and an existing folder', t => {
  const { root } = tmpRoot(t);
  assert.throws(() => sp.create({ name: 'Bad' }), status(400));
  assert.throws(() => sp.create({ name: 'ok', secret: 1 }), status(400));
  assert.throws(() => sp.create({ name: 'ok', createdAt: 'x' }), status(400));
  assert.throws(() => sp.create({ name: 'ok', provider: 'codex' }), /not available yet/);
  assert.throws(() => sp.create({ name: 'ok', mode: 'forever' }), status(400));
  assert.throws(() => sp.create({ name: 'ok', title: 'two\nlines' }), status(400));
  assert.throws(() => sp.create({ name: 'ok', instructions: 'x'.repeat(sp.LIMITS.instructionsBytes + 1) }), status(413));
  fs.mkdirSync(path.join(root, 'taken'), { recursive: true });
  assert.throws(() => sp.create({ name: 'taken' }), status(409));
  sp.create({ name: 'twice' });
  assert.throws(() => sp.create({ name: 'twice' }), status(409));
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['taken', 'twice']);
});

test('field validation: model, effort, color, icon, permission modes', t => {
  tmpRoot(t);
  sp.create({ name: 'v' });
  for (const model of ['opus', 'sonnet', 'haiku', 'fable', 'opus[1m]', 'claude-sonnet-4-5', 'claude-opus-5-5']) assert.strictEqual(sp.update('v', { model }).model, model);
  assert.strictEqual(sp.update('v', { model: 'default' }).model, null);
  assert.strictEqual(sp.update('v', { model: null }).model, null);
  for (const model of ['gpt-5', 'OPUS', '--x', 'claude-', '']) assert.throws(() => sp.update('v', { model }), status(400), model);
  assert.strictEqual(sp.update('v', { effort: 'xhigh' }).effort, 'xhigh');
  assert.throws(() => sp.update('v', { effort: 'huge' }), status(400));
  assert.strictEqual(sp.update('v', { color: '#AbC' }).color, '#abc');
  assert.throws(() => sp.update('v', { color: 'red' }), status(400));
  assert.throws(() => sp.update('v', { icon: '' }), status(400));
  assert.throws(() => sp.update('v', { icon: 'x'.repeat(17) }), status(400));
  for (const m of sp.PERMISSION_MODES) assert.strictEqual(sp.update('v', { permissionMode: m }).permissionMode, m);
  assert.throws(() => sp.update('v', { permissionMode: 'default' }), status(400));
  assert.strictEqual(sp.update('v', { account: 'company' }).account, 'company');
  assert.throws(() => sp.update('v', { account: 'other' }), status(400));
});

test('update changes metadata and instructions, keeps unknown keys, and refuses name and timestamps', t => {
  const { root } = tmpRoot(t);
  const first = sp.create({ name: 'ed' });
  const file = path.join(root, 'ed', 'specialist.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), future: { x: 1 } }));
  const s = sp.update('ed', { title: '  Editor  ', description: 'Edits', mode: 'thread', instructions: '# Editor\n' });
  assert.strictEqual(s.title, 'Editor');
  assert.strictEqual(s.mode, 'thread');
  assert.strictEqual(s.createdAt, first.createdAt);
  assert.ok(s.updatedAt >= first.updatedAt);
  assert.strictEqual(sp.readInstructions('ed'), '# Editor\n');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).future, { x: 1 });
  for (const k of ['name', 'createdAt', 'updatedAt']) assert.throws(() => sp.update('ed', { [k]: 'x' }), /cannot be changed/);
  assert.throws(() => sp.update('ed', { nope: 1 }), status(400));
  assert.throws(() => sp.update('ed', []), status(400));
  assert.throws(() => sp.update('missing', { title: 'x' }), status(404));
  assert.strictEqual(sp.update('ed', { instructions: 'new' }).name, 'ed');
  assert.strictEqual(sp.readInstructions('ed'), 'new');
  assert.throws(() => sp.update('ed', { instructions: 5 }), status(400));
  const outside = path.join(path.dirname(sp.root()), 'outside-claude.md');
  fs.writeFileSync(outside, 'keep');
  const md = path.join(sp.get('ed').dir, 'CLAUDE.md');
  fs.rmSync(md); fs.symlinkSync(outside, md);
  assert.throws(() => sp.update('ed', { instructions: 'overwrite' }), status(409));
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.ok(fs.lstatSync(md).isSymbolicLink());
  fs.rmSync(md); fs.rmSync(outside);
});

test('ifUpdatedAt guards against overwriting a newer profile', t => {
  tmpRoot(t);
  const s = sp.create({ name: 'g' });
  const next = sp.update('g', { title: 'One', ifUpdatedAt: s.updatedAt });
  assert.strictEqual(next.title, 'One');
  assert.throws(() => sp.update('g', { title: 'Two', ifUpdatedAt: '2000-01-01T00:00:00.000Z' }), status(409));
  assert.strictEqual(sp.get('g').title, 'One');
});

test('a broken specialist.json is listed with an error and can be fixed through update', t => {
  const { root } = tmpRoot(t);
  sp.create({ name: 'ok' });
  sp.create({ name: 'broken' });
  const file = path.join(root, 'broken', 'specialist.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'broken', mode: 'weird' }));
  fs.mkdirSync(path.join(root, 'no-meta'));
  fs.mkdirSync(path.join(root, 'Not_A_Name'));
  fs.writeFileSync(path.join(root, 'Not_A_Name', 'specialist.json'), '{}');
  const list = sp.list();
  assert.deepStrictEqual(list.map(s => s.name), ['broken', 'ok']);
  assert.match(list[0].error, /mode must be one of/);
  assert.throws(() => sp.get('broken'), status(409));
  assert.strictEqual(sp.update('broken', { mode: 'run' }).mode, 'run');
  fs.writeFileSync(file, 'not json');
  assert.match(sp.list()[0].error, /not a JSON object/);
});

test('the folder name wins over a name inside specialist.json', t => {
  const { root } = tmpRoot(t);
  sp.create({ name: 'real' });
  const file = path.join(root, 'real', 'specialist.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), name: '../evil' }));
  assert.strictEqual(sp.get('real').name, 'real');
});

test('symlinked profiles and symlinked files inside are refused', t => {
  const { tmp, root } = tmpRoot(t);
  sp.create({ name: 'inside' });
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'specialist.json'), JSON.stringify({ title: 'Outside' }));
  fs.symlinkSync(outside, path.join(root, 'linked'));
  assert.deepStrictEqual(sp.list().map(s => s.name), ['inside']);
  assert.throws(() => sp.get('linked'), status(409));
  assert.throws(() => sp.update('linked', { title: 'x' }), status(409));
  assert.throws(() => sp.archive('linked'), status(409));
  const secret = path.join(tmp, 'secret.txt');
  fs.writeFileSync(secret, 'secret');
  fs.rmSync(path.join(root, 'inside', 'CLAUDE.md'));
  fs.symlinkSync(secret, path.join(root, 'inside', 'CLAUDE.md'));
  assert.throws(() => sp.readInstructions('inside'), status(409));
  assert.throws(() => sp.get('../outside'), status(400));
});

test('archive moves the folder into _archive with a stamp and never deletes it', t => {
  const { root } = tmpRoot(t);
  sp.create({ name: 'old', instructions: 'keep me' });
  const at = new Date(Date.UTC(2026, 10, 11, 8, 30, 5));
  const a = sp.archive('old', at);
  assert.strictEqual(a.archivedAs, '_archive/old-20261111-083005');
  assert.strictEqual(fs.readFileSync(path.join(root, '_archive', 'old-20261111-083005', 'CLAUDE.md'), 'utf8'), 'keep me');
  assert.deepStrictEqual(sp.list(), []);
  assert.throws(() => sp.get('old'), status(404));
  sp.create({ name: 'old' });
  assert.strictEqual(sp.archive('old', at).archivedAs, '_archive/old-20261111-083005-2');
  assert.throws(() => sp.archive('old'), status(404));
});

test('run and thread names follow the tmux naming and parse back', () => {
  const d = new Date(2026, 10, 11, 9, 5);
  assert.strictEqual(sp.runName('writer', 'personal', d), 'claude-spec-writer-261111-0905');
  assert.strictEqual(sp.runName('writer', 'company', d, 3), 'claude-spec-writer-261111-0905-3-company');
  assert.strictEqual(sp.threadName('writer', 'personal'), 'claude-spec-writer');
  assert.strictEqual(sp.threadName('writer', 'company'), 'claude-spec-writer-company');
  assert.strictEqual(sp.threadRunId('writer', 'company', 4), 'claude-spec-writer-company_4');
  assert.deepStrictEqual(sp.parseRunId('claude-spec-code-review-261111-0905-2-company'), { name: 'code-review', mode: 'run', account: 'company', tmux: 'claude-spec-code-review-261111-0905-2-company' });
  assert.deepStrictEqual(sp.parseRunId('claude-spec-writer_12'), { name: 'writer', mode: 'thread', account: 'personal', tmux: 'claude-spec-writer' });
  for (const bad of ['claude-spec-writer', 'claude-chat-261111-0905', 'claude-spec-writer-261111-0905_2', 'claude-spec-run-261111-0905', 'claude-spec-x-261111-0905-1', '../x', null]) assert.strictEqual(sp.parseRunId(bad), null, String(bad));
  assert.strictEqual(sp.specialistOfTmux('claude-spec-writer-company'), 'writer');
  assert.strictEqual(sp.specialistOfTmux('claude-spec-writer-261111-0905'), 'writer');
  assert.strictEqual(sp.specialistOfTmux('claude-chat-261111-0905'), null);
  for (const n of ['claude-spec-writer-261111-0905-2-company', 'claude-spec-writer-company']) assert.match(n, /^[A-Za-z0-9_.-]+$/);
});

test('runs are stored in the profile, listed newest first as summaries and read back in full', t => {
  const { root } = tmpRoot(t);
  sp.create({ name: 'w' });
  const runId = sp.runName('w', 'personal', new Date(2026, 10, 11, 9, 5));
  const saved = sp.saveRun({ runId, specialist: 'w', state: 'starting', task: 'Draft a reply to: ' + 'x'.repeat(300), startedAt: 1000, cwd: path.join(root, 'w') });
  assert.strictEqual(saved.mode, 'run');
  assert.strictEqual(saved.tmux, runId);
  assert.strictEqual(saved.text, null);
  assert.strictEqual(saved.turns, 1);
  assert.ok(fs.existsSync(path.join(root, 'w', '.bd', 'runs', runId + '.json')));
  const done = sp.patchRun(runId, { state: 'done', text: 'Full answer '.repeat(100), endedAt: 2000, sessionId: '0b8f7a2c-1111-4222-8333-444455556666' });
  assert.strictEqual(done.text.length, 1200);
  assert.strictEqual(sp.getRun(runId).text, done.text);
  sp.saveRun({ runId: sp.threadRunId('w', 'personal', 1), specialist: 'w', state: 'working', task: 'later', startedAt: 3000 });
  const runs = sp.listRuns('w');
  assert.deepStrictEqual(runs.map(r => r.runId), ['claude-spec-w_1', runId]);
  assert.strictEqual(runs[1].task.length, 200);
  assert.strictEqual(runs[1].preview.length, 200);
  assert.strictEqual(runs[1].text, undefined);
  assert.strictEqual(sp.listRuns('w', { limit: 1 }).length, 1);
  sp.patchRun('claude-spec-w_1', { state: 'done', text: 'now' });
  assert.deepStrictEqual(sp.listRuns('w').map(r => [r.state, r.preview]), [['done', 'now'], ['done', runs[1].preview]]);
  fs.rmSync(path.join(root, 'w', '.bd', 'runs', 'claude-spec-w_1.json'));
  assert.deepStrictEqual(sp.listRuns('w').map(r => r.runId), [runId]);
  assert.strictEqual(sp.getRun('claude-spec-w-261111-0906'), null);
  assert.strictEqual(sp.getRun('nonsense'), null);
  assert.ok(sp.isFinal('done') && !sp.isFinal('waiting'));
});

test('run records are validated against their runId and capped', t => {
  tmpRoot(t);
  sp.create({ name: 'w' });
  const runId = sp.runName('w', 'personal', new Date(2026, 10, 11, 9, 5));
  assert.throws(() => sp.saveRun({ runId, specialist: 'other', state: 'done' }), status(400));
  assert.throws(() => sp.saveRun({ runId, specialist: 'w', state: 'finished' }), status(400));
  assert.throws(() => sp.saveRun({ runId, specialist: 'w', state: 'done', account: 'company' }), status(400));
  assert.throws(() => sp.saveRun({ runId, specialist: 'w', state: 'done', sessionId: 'nope' }), status(400));
  assert.throws(() => sp.saveRun({ runId: 'claude-spec-gone-261111-0905', specialist: 'gone', state: 'done' }), status(404));
  assert.throws(() => sp.patchRun(runId, { state: 'done' }), status(404));
  const big = sp.saveRun({ runId, specialist: 'w', state: 'done', text: 'y'.repeat(sp.LIMITS.text + 10) });
  assert.strictEqual(big.text.length, sp.LIMITS.text);
  assert.strictEqual(big.truncated, true);
});

test('a symlinked .bd folder is never written through', t => {
  const { tmp, root } = tmpRoot(t);
  sp.create({ name: 'w' });
  const elsewhere = path.join(tmp, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(root, 'w', '.bd'));
  const runId = sp.runName('w', 'personal', new Date(2026, 10, 11, 9, 5));
  assert.throws(() => sp.saveRun({ runId, specialist: 'w', state: 'done' }), status(409));
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
  assert.throws(() => sp.listRuns('w'), status(409));
});

test('thread state is stored per specialist', t => {
  tmpRoot(t);
  sp.create({ name: 'th', mode: 'thread' });
  assert.strictEqual(sp.getThread('th'), null);
  const th = sp.setThread('th', { account: 'company', sessionId: '0b8f7a2c-1111-4222-8333-444455556666', seq: 2, startedAt: 5 });
  assert.strictEqual(th.tmux, 'claude-spec-th-company');
  assert.deepStrictEqual(sp.getThread('th'), th);
  assert.throws(() => sp.setThread('th', { account: 'company', seq: -1 }), status(400));
});
