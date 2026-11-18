const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-bgtasks-')));
process.env.BD_TEST = '1';
process.env.BD_MIRROR = tmp;
process.env.XDG_RUNTIME_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'claude-sessions.json'), '{}');
const claude = require('../lib/claude');
const subagents = require('../lib/subagents');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const name = 'claude-bg';
const hook = (body, ts) => claude.onHook({ 'x-tmux-session': name, 'x-ts': String(ts) }, body);

test('Stop keeps only the non-shell background tasks, trimmed, and SessionStart clears them', () => {
  const long = 'x'.repeat(300);
  hook({ hook_event_name: 'Stop', background_tasks: [
    { id: 'a3550cfa90b9a7d6c', type: 'subagent', status: 'running', description: long, agent_type: 'general-purpose' },
    { id: 'bq1w2e3r4', type: 'local_bash', status: 'running', description: 'npm run dev' },
  ] }, 1000);
  const tasks = claude.info(name).bgTasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'a3550cfa90b9a7d6c');
  assert.equal(tasks[0].type, 'subagent');
  assert.ok(tasks[0].description.length <= 100);
  assert.equal(claude.info(name).state, 'background');

  hook({ hook_event_name: 'SessionStart', source: 'compact' }, 2000);
  assert.equal(claude.info(name).bgTasks.length, 1);

  hook({ hook_event_name: 'SessionStart', source: 'startup' }, 3000);
  assert.deepEqual(claude.info(name).bgTasks, []);
});

test('a later Stop without tasks empties the list', () => {
  hook({ hook_event_name: 'Stop', background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'x' }] }, 4000);
  hook({ hook_event_name: 'Stop', background_tasks: [] }, 5000);
  assert.deepEqual(claude.info(name).bgTasks, []);
});

test('a task with status completed is dropped and does not keep the session in background', () => {
  hook({ hook_event_name: 'Stop', background_tasks: [{ id: 'a1', type: 'subagent', status: 'completed', description: 'x' }] }, 6000);
  assert.deepEqual(claude.info(name).bgTasks, []);
  assert.equal(claude.info(name).state, 'needs-you');
});

test('StopFailure clears the list', () => {
  hook({ hook_event_name: 'Stop', background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'x' }] }, 7000);
  assert.equal(claude.info(name).bgTasks.length, 1);
  hook({ hook_event_name: 'StopFailure', error: 'server_error' }, 8000);
  assert.deepEqual(claude.info(name).bgTasks, []);
});

test('a record without bgTasks gives an empty list', () => {
  assert.deepEqual(claude.info('claude-never-seen').bgTasks, []);
  const rec = claude.get(name);
  delete rec.bgTasks;
  assert.deepEqual(claude.info(name).bgTasks, []);
});

test('subagent is done when its transcript ends in an end_turn assistant line', () => {
  const transcript = path.join(tmp, 'sess-d.jsonl');
  const dir = path.join(tmp, 'sess-d', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const line = (stop, at) => JSON.stringify({ type: 'assistant', requestId: 'r' + at, timestamp: new Date(at).toISOString(), message: { model: 'claude-sonnet-5-5', stop_reason: stop, content: [], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n';
  fs.writeFileSync(path.join(dir, 'agent-adone.jsonl'), line('tool_use', Date.now() - 2000) + line('end_turn', Date.now() - 1000));
  fs.writeFileSync(path.join(dir, 'agent-abusy.jsonl'), line('tool_use', Date.now() - 1000));
  const byId = Object.fromEntries(subagents.forSession(transcript).agents.map(a => [a.agentId, a]));
  assert.equal(byId.adone.done, true);
  assert.equal(byId.abusy.done, false);
});

test('a real prompt remembers which background commands were already running; a task notification does not count as a prompt', () => {
  const n = 'claude-bgask';
  const h = (body, ts) => claude.onHook({ 'x-tmux-session': n, 'x-ts': String(ts) }, body);
  h({ hook_event_name: 'SessionStart', source: 'startup' }, 100);
  h({ hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' }, 1000);
  h({ hook_event_name: 'Stop', background_tasks: [{ id: 'bdev', type: 'local_bash', status: 'running', description: 'npm run dev' }] }, 2000);
  assert.deepStrictEqual(claude.get(n).bgShells, ['bdev']);
  assert.deepStrictEqual(claude.get(n).shellsAtAsk, []);
  assert.strictEqual(claude.get(n).askedAt, 1000);
  h({ hook_event_name: 'UserPromptSubmit', prompt: 'run the tests' }, 3000);
  assert.deepStrictEqual(claude.get(n).shellsAtAsk, ['bdev']);
  h({ hook_event_name: 'Stop', background_tasks: [
    { id: 'bdev', type: 'local_bash', status: 'running' },
    { id: 'btest', type: 'local_bash', status: 'running' },
    { id: 'bold', type: 'local_bash', status: 'completed' },
  ] }, 4000);
  assert.deepStrictEqual(claude.get(n).bgShells, ['bdev', 'btest']);
  h({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification> <task-id>btest</task-id>' }, 5000);
  assert.strictEqual(claude.get(n).askedAt, 3000);
  assert.strictEqual(claude.get(n).promptAt, 5000);
  assert.deepStrictEqual(claude.get(n).shellsAtAsk, ['bdev']);
  h({ hook_event_name: 'SessionStart', source: 'clear' }, 6000);
  assert.deepStrictEqual(claude.get(n).bgShells, []);
});

test('Stop keeps the ids of every running background task as the roster level, SessionStart and a Stop without the field clear it', () => {
  hook({ hook_event_name: 'Stop', background_tasks: [
    { id: 'a1', type: 'subagent', status: 'running', description: 'x' },
    { id: 'bq1', type: 'local_bash', status: 'running', description: 'y' },
    { id: 'a2', type: 'subagent', status: 'completed', description: 'z' },
  ] }, 9000);
  assert.deepStrictEqual(claude.get(name).stopIds, ['a1', 'bq1']);
  hook({ hook_event_name: 'Stop' }, 9100);
  assert.strictEqual(claude.get(name).stopIds, null);
  hook({ hook_event_name: 'Stop', background_tasks: [] }, 9200);
  assert.deepStrictEqual(claude.get(name).stopIds, []);
  hook({ hook_event_name: 'SessionStart', source: 'startup' }, 9300);
  assert.strictEqual(claude.get(name).stopIds, null);
});
