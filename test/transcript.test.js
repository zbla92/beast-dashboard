const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tail } = require('../lib/transcript');

const T0 = Date.parse('2026-10-29T10:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const user = (uuid, parentUuid, text, s) => ({ type: 'user', uuid, parentUuid, timestamp: at(s), origin: { kind: 'human' }, message: { role: 'user', content: text } });
const said = (uuid, parentUuid, text, s) => ({ type: 'assistant', uuid, parentUuid, timestamp: at(s), message: { id: 'm-' + uuid, role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = (uuid, parentUuid, id, s) => ({ type: 'assistant', uuid, parentUuid, timestamp: at(s), message: { id: 'm-' + uuid, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } });
const toolResult = (uuid, parentUuid, id, s) => ({ type: 'user', uuid, parentUuid, timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { stdout: 'ok', stderr: '' } });
const done = (uuid, parentUuid, ms, s) => ({ type: 'system', subtype: 'turn_duration', uuid, parentUuid, timestamp: at(s), durationMs: ms });
const queued = (uuid, parentUuid, prompt, kind, s) => ({ type: 'attachment', uuid, parentUuid, timestamp: at(s), attachment: { type: 'queued_command', prompt, commandMode: kind === 'human' ? 'prompt' : 'task-notification', origin: { kind } } });

function file(recs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-transcript-'));
  const f = path.join(dir, 's.jsonl'); fs.writeFileSync(f, recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const users = t => t.turns.filter(x => x.role === 'user').map(x => x.text);

test('a prompt replaced after a rewind is dropped with its answer', () => {
  const t = tail(file([
    user('u1', null, 'first', 0), said('a1', 'u1', 'hi', 1), done('d1', 'a1', 1000, 2),
    user('u2', 'd1', 'check now', 3), said('a2', 'u2', 'old answer', 4),
    user('u3', 'd1', 'try this instead', 10), said('a3', 'u3', 'new answer', 11),
  ]));
  assert.deepStrictEqual(users(t), ['first', 'try this instead']);
  assert.ok(!JSON.stringify(t.turns).includes('old answer'));
});

test('parallel tool results are not mistaken for a dead branch', () => {
  const t = tail(file([
    user('u1', null, 'go', 0), toolUse('a1', 'u1', 't1', 1), toolUse('a2', 'a1', 't2', 1),
    toolResult('r1', 'a1', 't1', 2), toolResult('r2', 'a2', 't2', 2), said('a3', 'r2', 'both done', 3),
  ]));
  const steps = t.turns.find(x => x.role === 'assistant').steps.filter(x => x.k === 'tool');
  assert.deepStrictEqual(steps.map(x => x.done), [true, true]);
});

test('messages sent while Claude works show up, task notifications become events', () => {
  const t = tail(file([
    user('u1', null, 'start', 0), toolUse('a1', 'u1', 't1', 1),
    queued('q1', 'a1', 'also do this', 'human', 2),
    queued('q2', 'q1', '<task-notification>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>', 'task-notification', 3),
    toolResult('r1', 'q2', 't1', 4), said('a2', 'r1', 'ok', 5),
  ]));
  const mid = t.turns.find(x => x.role === 'user' && x.text === 'also do this');
  assert.ok(mid && mid.queued);
  assert.ok(t.turns.some(x => x.role === 'event' && x.status === 'completed' && x.text.includes('finished')));
});

test('an interrupted turn says how long it ran', () => {
  const t = tail(file([
    user('u1', null, 'long job', 0), said('a1', 'u1', 'working on it', 5),
    user('u2', 'a1', '[Request interrupted by user]', 42),
  ]));
  const a = t.turns.find(x => x.role === 'assistant');
  assert.strictEqual(a.stopped, 42000);
  assert.strictEqual(a.dur, undefined);
});

test('sig stays put on a re-read, moves when a turn changes, and appends are picked up', () => {
  const f = file([user('u1', null, 'hello', 0), said('a1', 'u1', 'hi', 1)]);
  const a = tail(f), b = tail(f);
  assert.strictEqual(a.sig, b.sig);
  assert.ok(a.turns.every(x => x.id && x.h));
  fs.appendFileSync(f, JSON.stringify({ type: 'attachment', uuid: 'x1', parentUuid: 'a1', attachment: { type: 'api-request-shape' } }) + '\n');
  assert.strictEqual(tail(f).sig, a.sig);
  fs.appendFileSync(f, JSON.stringify(said('a2', 'x1', 'more', 2)) + '\n');
  const c = tail(f);
  assert.notStrictEqual(c.sig, a.sig);
  assert.strictEqual(c.turns[0].h, a.turns[0].h);
  assert.ok(c.turns[1].steps[0].text.includes('more'));
});

test('a line written in two halves is read once it is complete', () => {
  const f = file([user('u1', null, 'hello', 0)]);
  const line = JSON.stringify(said('a1', 'u1', 'čćž done', 1)) + '\n'; const buf = Buffer.from(line); const cut = buf.indexOf('č') + 1;
  assert.strictEqual(tail(f).turns.length, 1);
  fs.appendFileSync(f, buf.subarray(0, cut));
  assert.strictEqual(tail(f).turns.length, 1);
  fs.appendFileSync(f, buf.subarray(cut));
  assert.strictEqual(tail(f).turns[1].steps[0].text, 'čćž done');
});

test('a prompt sent during a long tool call stays visible when both branches continue', () => {
  const t = tail(file([
    user('u1', null, 'run the build', 0), toolUse('a1', 'u1', 't1', 1),
    user('u2', 'a1', 'meanwhile, what is in README?', 5), toolResult('r1', 'a1', 't1', 300),
    said('a2', 'u2', 'README says hi', 301), said('a3', 'r1', 'build done', 302),
  ]));
  assert.deepStrictEqual(users(t), ['run the build', 'meanwhile, what is in README?']);
  assert.ok(JSON.stringify(t.turns).includes('README says hi'));
  assert.ok(JSON.stringify(t.turns).includes('build done'));
});

test('a queued prompt with an image shows its text, not [object Object]', () => {
  const t = tail(file([
    user('u1', null, 'start', 0), toolUse('a1', 'u1', 't1', 1),
    queued('q1', 'a1', [{ type: 'text', text: 'look at this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }], 'human', 2),
  ]));
  assert.ok(users(t).includes('look at this'));
  assert.ok(!JSON.stringify(t).includes('object Object'));
  assert.ok(!JSON.stringify(t).includes('AAAA'));
});

test('a queued prompt with bash blocks gives shell turns and keeps the prompt', () => {
  const t = tail(file([
    user('u1', null, 'start', 0), toolUse('a1', 'u1', 't1', 1),
    queued('q1', 'a1', [{ type: 'text', text: '<bash-input>ls</bash-input>' }, { type: 'text', text: '<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>' }, { type: 'text', text: 'what now' }], 'human', 2),
  ]));
  assert.deepStrictEqual(t.turns.filter(x => x.role !== 'assistant').map(x => x.role + ':' + x.text), ['user:start', 'shell:ls', 'user:what now']);
  assert.strictEqual(t.turns.find(x => x.role === 'shell').out, 'a.txt');
});

test('a turn started by a task notification is timed from the notification', () => {
  const note = '<task-notification>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>';
  const f = file([
    user('u1', null, 'start', 0), said('a1', 'u1', 'ok', 1), done('d1', 'a1', 1000, 2),
    queued('q1', 'd1', note, 'task-notification', 3600), said('a2', 'q1', 'reading the result', 3601),
  ]);
  fs.utimesSync(f, new Date(), new Date());
  assert.strictEqual(tail(f).since, T0 + 3600 * 1000);
  fs.appendFileSync(f, JSON.stringify(user('u2', 'a2', '[Request interrupted by user]', 3610)) + '\n');
  assert.strictEqual(tail(f).turns.find(x => x.role === 'assistant' && x.stopped !== undefined).stopped, 10000);
});

test('a message queued mid-turn does not restart the working timer', () => {
  const f = file([
    user('u1', null, 'start', 0), toolUse('a1', 'u1', 't1', 1),
    queued('q1', 'a1', 'also this', 'human', 20), queued('q2', 'q1', 'and this', 'human', 25),
    toolResult('r1', 'q2', 't1', 30), said('a2', 'r1', 'working', 31),
  ]);
  const t = tail(f);
  assert.strictEqual(t.since, T0);
  fs.appendFileSync(f, JSON.stringify(user('u3', 'a2', '[Request interrupted by user]', 40)) + '\n');
  assert.strictEqual(tail(f).turns.find(x => x.stopped !== undefined).stopped, 40000);
});

const blocks = (uuid, parentUuid, parts, s) => ({ type: 'user', uuid, parentUuid, timestamp: at(s), origin: { kind: 'human' }, message: { role: 'user', content: parts.map(text => ({ type: 'text', text })) } });

test('bash blocks in front of a prompt become shell turns and the prompt stays a prompt', () => {
  const t = tail(file([
    blocks('u1', null, ['<bash-input>ls -la</bash-input>', '<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>', '<bash-input>false</bash-input>', '<bash-stdout></bash-stdout><bash-stderr>\nExit code 1</bash-stderr>', 'what did that show?'], 0),
    said('a1', 'u1', 'two files', 1),
    done('d1', 'a1', 1000, 2),
  ]));
  assert.deepStrictEqual(t.turns.map(x => x.role), ['shell', 'shell', 'user', 'assistant']);
  assert.deepStrictEqual([t.turns[0].text, t.turns[0].out], ['ls -la', 'a\nb']);
  assert.deepStrictEqual([t.turns[1].text, t.turns[1].out], ['false', 'Exit code 1']);
  assert.strictEqual(t.turns[2].text, 'what did that show?');
  assert.strictEqual(new Set(t.turns.map(x => x.id)).size, 4);
});

test('a message with only bash blocks gives shell turns and no empty prompt', () => {
  const t = tail(file([blocks('u1', null, ['<bash-input>pwd</bash-input>', '<bash-stdout>/tmp</bash-stdout><bash-stderr></bash-stderr>'], 0)]));
  assert.deepStrictEqual(t.turns.map(x => x.role), ['shell']);
});

test('a rewound prompt that carried bash blocks is still recognised as a prompt', () => {
  const t = tail(file([
    said('a0', null, 'hi', 0),
    blocks('u1', 'a0', ['<bash-input>ls</bash-input>', '<bash-stdout>x</bash-stdout><bash-stderr></bash-stderr>', 'old question'], 1),
    blocks('u2', 'a0', ['new question'], 2),
    said('a2', 'u2', 'ok', 3),
  ]));
  assert.deepStrictEqual(users(t), ['new question']);
  assert.ok(!t.turns.some(x => x.role === 'shell'));
});
