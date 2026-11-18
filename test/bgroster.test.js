const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bgroster = require('../lib/bgroster');
const { waitingOn, holds, transcriptRoster } = require('../lib/donepush');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-bgroster-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n').filter(Boolean);
const terminal = fixture('transcript-bg-terminal.jsonl');
const folded = fixture('transcript-bg-folded.jsonl');
const counter = { n: 0 };
const fileOf = () => path.join(tmp, `s${++counter.n}.jsonl`);
const upTo = (lines, needle) => { const i = lines.findIndex(l => l.includes(needle)); assert.ok(i >= 0, needle); return lines.slice(0, i + 1); };
const write = (fp, lines) => fs.writeFileSync(fp, lines.map(l => l + '\n').join(''));
const ids = tasks => tasks.map(t => t.id).sort();
const AT = Date.parse(JSON.parse(terminal.find(l => l.includes('"taskId":"bfgdngmxi"'))).timestamp) + 1000;
const at = fp => bgroster.read(fp, 0, AT);

test('a terminal transcript gives background commands, an agent and a monitor with the contract Task shape', () => {
  const fp = fileOf();
  write(fp, upTo(terminal, '"taskId":"bfgdngmxi"'));
  const tasks = at(fp);
  assert.deepStrictEqual(ids(tasks), ['a796b15185bd3c623', 'b9mb553ba', 'bfgdngmxi', 'bxiwqmuzc']);
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  assert.deepStrictEqual(Object.keys(byId.bxiwqmuzc).sort(), ['awaited', 'description', 'id', 'kind', 'owed', 'progress', 'startedAt', 'toolUseId']);
  assert.strictEqual(byId.bxiwqmuzc.kind, 'shell');
  assert.strictEqual(byId.bxiwqmuzc.toolUseId, 'toolu_01S5woCSWt5hMaT4QC3HJNF1');
  assert.strictEqual(byId.bxiwqmuzc.description, 'Background command');
  assert.strictEqual(byId.a796b15185bd3c623.kind, 'agent');
  assert.strictEqual(byId.a796b15185bd3c623.description, 'sleeper');
  assert.strictEqual(byId.bfgdngmxi.kind, 'monitor');
  for (const t of tasks) { assert.strictEqual(t.awaited, false); assert.strictEqual(t.progress, null); assert.strictEqual(t.owed, false); assert.ok(t.startedAt > 0); }
});

test('task notifications end tasks, a monitor event without a status does not, and TaskStop ends the stopped command', () => {
  const fp = fileOf();
  const lines = upTo(terminal, '"turnOrigin":"task_notification"');
  write(fp, lines);
  assert.deepStrictEqual(ids(at(fp)), ['b9mb553ba', 'bfgdngmxi', 'bxiwqmuzc']);
  const event = terminal.findIndex((l, i) => i >= lines.length && l.includes('"turnOrigin":"task_notification"'));
  fs.appendFileSync(fp, terminal.slice(lines.length, event + 1).map(l => l + '\n').join(''));
  assert.deepStrictEqual(ids(at(fp)), ['b9mb553ba', 'bfgdngmxi', 'bxiwqmuzc']);
  const stopped = upTo(terminal, '"task_type":"local_bash"');
  fs.appendFileSync(fp, stopped.slice(event + 1).map(l => l + '\n').join(''));
  assert.deepStrictEqual(ids(at(fp)), []);
});

test('a command the user moved to the background with ctrl+b joins the roster until its notification', () => {
  const fp = fileOf();
  write(fp, upTo(terminal, '"backgroundedByUser":true'));
  assert.deepStrictEqual(ids(at(fp)), ['bcsw0vj3h']);
  write(fp, terminal);
  assert.deepStrictEqual(at(fp), []);
});

test('bd-wait marks a command awaited whether it comes before or after the start, and subagent or failed starts stay out', () => {
  const fp = fileOf();
  write(fp, upTo(folded, '"agentId":"aagent0002"'));
  const tasks = bgroster.read(fp);
  assert.deepStrictEqual(ids(tasks), ['aagent0001', 'aagent0002', 'bshell001', 'bshell002', 'bshell003']);
  const awaited = tasks.filter(t => t.awaited).map(t => t.id).sort();
  assert.deepStrictEqual(awaited, ['bshell001', 'bshell002']);
});

test('notifications absorbed mid-turn, delivered to an agent, killed or failed, and TaskStop all end what they name', () => {
  const fp = fileOf();
  write(fp, folded);
  const tasks = bgroster.read(fp);
  assert.deepStrictEqual(ids(tasks), ['bshell001']);
  assert.strictEqual(tasks[0].awaited, true);
});

test('tasks started before the session last started are left out, and a monitor drops after its timeout', () => {
  const fp = fileOf();
  write(fp, upTo(terminal, '"taskId":"bfgdngmxi"'));
  const monitor = at(fp).find(t => t.id === 'bfgdngmxi');
  assert.deepStrictEqual(bgroster.read(fp, monitor.startedAt + 1, AT), []);
  assert.deepStrictEqual(ids(bgroster.read(fp, 0, monitor.startedAt + 60000 + 60000 + 1)), ['a796b15185bd3c623', 'b9mb553ba', 'bxiwqmuzc']);
  assert.ok(!ids(bgroster.read(fp)).includes('bfgdngmxi'));
});

test('reading is incremental: a half-written line waits, a shrunk or replaced file starts over', () => {
  const fp = fileOf();
  const lines = upTo(terminal, '"backgroundTaskId":"bxiwqmuzc"');
  const last = lines[lines.length - 1];
  fs.writeFileSync(fp, lines.slice(0, -1).map(l => l + '\n').join('') + last.slice(0, 40));
  assert.deepStrictEqual(bgroster.read(fp), []);
  fs.appendFileSync(fp, last.slice(40) + '\n');
  assert.deepStrictEqual(ids(bgroster.read(fp)), ['bxiwqmuzc']);
  write(fp, terminal.slice(0, 2));
  assert.deepStrictEqual(bgroster.read(fp), []);
  const other = fileOf();
  write(other, upTo(folded, '"agentId":"aagent0001"'));
  fs.renameSync(other, fp);
  assert.deepStrictEqual(ids(bgroster.read(fp)), ['aagent0001', 'bshell001', 'bshell002', 'bshell003']);
});

test('no roster while the transcript is still being caught up, or when it cannot be read', () => {
  const fp = fileOf();
  write(fp, folded);
  assert.strictEqual(bgroster.read(fp, 0, Date.now(), 0), null);
  assert.deepStrictEqual(ids(bgroster.read(fp)), ['bshell001']);
  assert.strictEqual(bgroster.read(path.join(tmp, 'missing.jsonl')), null);
  assert.strictEqual(bgroster.read(path.join(tmp, 'not-a-transcript.txt')), null);
  assert.strictEqual(bgroster.read(null), null);
  assert.strictEqual(bgroster.read(tmp + '.jsonl'), null);
});

test('waitingOn for a terminal roster: agents and generic tasks hold, commands and monitors only when awaited', () => {
  const t = (id, kind, awaited = false) => ({ id, kind, description: id, startedAt: 1000, toolUseId: null, awaited, progress: null, owed: false });
  const roster = { source: 'transcript', tasks: [t('a1', 'agent'), t('x1', 'task'), t('b1', 'shell'), t('b2', 'shell', true), t('m1', 'monitor'), t('m2', 'monitor', true)] };
  assert.ok(transcriptRoster(roster));
  const r = { askedAt: 500, stopAt: 2000, bgTasks: [{ id: 'hook-agent', description: 'old' }], bgShells: ['bhook'], shellsAtAsk: [] };
  const w = waitingOn(r, roster, 2000);
  assert.deepStrictEqual(w.agents.map(x => x.id), ['a1', 'x1']);
  assert.deepStrictEqual(w.shells.map(x => x.id), ['b2', 'm2']);
  assert.deepStrictEqual(w.shells.map(x => x.kind), ['shell', 'monitor']);
  assert.strictEqual(w.queued, 0);
  assert.strictEqual(w.busy, false);
  assert.strictEqual(w.source, 'transcript');
  const idle = waitingOn(r, { source: 'transcript', tasks: [t('b1', 'shell')] }, 2000);
  assert.deepStrictEqual([idle.agents, idle.shells], [[], []]);
  assert.strictEqual(holds(idle), false);
  assert.strictEqual(waitingOn(r, null, 2000).source, 'hook');
  assert.ok(!transcriptRoster({ tasks: [] }));
});

test('a terminal session remembers when it last started so older transcript tasks stop counting', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-bgroster-hook-')));
  process.env.BD_TEST = '1';
  process.env.BD_MIRROR = dir;
  fs.writeFileSync(path.join(dir, 'claude-sessions.json'), '{}');
  const claude = require('../lib/claude');
  const hook = (body, ts) => claude.onHook({ 'x-tmux-session': 'claude-boot', 'x-ts': String(ts) }, body);
  try {
    hook({ hook_event_name: 'SessionStart', source: 'startup' }, 1000);
    assert.strictEqual(claude.get('claude-boot').bootAt, 1000);
    hook({ hook_event_name: 'SessionStart', source: 'compact' }, 2000);
    assert.strictEqual(claude.get('claude-boot').bootAt, 1000);
    hook({ hook_event_name: 'SessionStart', source: 'resume' }, 3000);
    assert.strictEqual(claude.get('claude-boot').bootAt, 3000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('forSession drops an agent the last Stop hook no longer lists', () => {
  const tasks = [
    { id: 'aghost', kind: 'agent', startedAt: 100, awaited: false },
    { id: 'alive', kind: 'agent', startedAt: 100, awaited: false },
    { id: 'anew', kind: 'agent', startedAt: 300, awaited: false },
    { id: 'bshell', kind: 'shell', startedAt: 100, awaited: true },
  ];
  const fake = () => tasks.map(t => ({ ...t }));
  const r = { transcriptPath: '/x.jsonl', bootAt: 50, stopAt: 200, stopIds: ['alive'] };
  assert.deepStrictEqual(bgroster.forSession(r, fake).map(t => t.id), ['alive', 'anew', 'bshell']);
  assert.deepStrictEqual(bgroster.forSession({ ...r, stopIds: null }, fake).map(t => t.id), ['aghost', 'alive', 'anew', 'bshell']);
  const w = waitingOn(r, { source: 'transcript', tasks: bgroster.forSession({ ...r, stopIds: [] }, fake).filter(t => t.kind === 'agent') });
  assert.deepStrictEqual(w.agents.map(a => a.id), ['anew']);
});

test('forSession without a session start cuts at the last prompt', () => {
  const seen = [];
  bgroster.forSession({ transcriptPath: '/x.jsonl', askedAt: 77 }, (fp, since) => { seen.push(since); return []; });
  bgroster.forSession({ transcriptPath: '/x.jsonl', askedAt: 77, bootAt: 40 }, (fp, since) => { seen.push(since); return []; });
  assert.deepStrictEqual(seen, [77, 40]);
  assert.strictEqual(bgroster.forSession({ transcriptPath: '/x.jsonl' }, () => null), null);
  assert.strictEqual(bgroster.forSession(null), null);
});
