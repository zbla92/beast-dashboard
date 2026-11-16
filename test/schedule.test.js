const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const schedule = require('../lib/schedule');

schedule.useFile(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-sched-')), 'schedule.json'));

const notRunning = async () => ({ ok: false, notRunning: true, error: 'Claude is not running in this session' });
const idle = () => false; const exists = async () => true;

test('a first prompt waits while a fresh session has not started Claude yet, then fails after the grace period', async () => {
  const { job } = schedule.add('claude-fresh', Date.now() - 1000, ['hello']);
  await schedule.runOnce(idle, notRunning, exists);
  assert.strictEqual(job.state, 'waiting');
  assert.strictEqual(job.idx, 0);
  job.at = Date.now() - 120000;
  await schedule.runOnce(idle, notRunning, exists);
  assert.strictEqual(job.state, 'failed');
  schedule.remove(job.id);
});

test('a follow-up prompt fails at once when Claude is gone', async () => {
  const { job } = schedule.add('claude-gone', Date.now() - 1000, ['one', 'two']);
  Object.assign(job, { idx: 1, state: 'running', lastSentAt: Date.now() - 60000 });
  await schedule.runOnce(idle, notRunning, exists);
  assert.strictEqual(job.state, 'failed');
  schedule.remove(job.id);
});

test('a send refused for a credential value fails the job and leaves nothing waiting', async () => {
  const { job } = schedule.add('claude-spec-held', Date.now() - 1000, ['one', 'two']);
  const refused = async () => ({ ok: false, refused: true, status: 409, error: "this message contains one of the bot's credentials; set credentials in the bot's settings" });
  await schedule.runOnce(idle, refused, exists);
  assert.deepStrictEqual([job.state, job.idx, job.error], ['failed', 1, "this message contains one of the bot's credentials; set credentials in the bot's settings"]);
  assert.ok(!schedule.all().some(j => j.session === 'claude-spec-held' && j.state !== 'failed'));
  schedule.remove(job.id);
});
