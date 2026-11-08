'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-usage-'));
fs.mkdirSync(path.join(tmp, 'lib'));
for (const f of ['usage.js', 'util.js']) fs.copyFileSync(path.join(__dirname, '..', 'lib', f), path.join(tmp, 'lib', f));
process.env.HOME = path.join(tmp, 'home');
for (const k of ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT']) delete process.env[k];
const dir = path.join(tmp, 'home', '.claude', 'projects', 'proj');
fs.mkdirSync(path.join(dir, 'sess-1', 'subagents'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'home', '.claude-company'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'home', '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200k' } }));
fs.writeFileSync(path.join(tmp, 'home', '.claude-company', 'settings.json'), JSON.stringify({ autoCompactWindow: 500000, modelSettings: { 'claude-sonnet-5-5': { autoCompactWindow: '300k' }, haiku: { autoCompactWindow: 400000 } } }));
const OLD_AT = Date.now() - 86400e3;
const oldLine = JSON.stringify({ type: 'assistant', requestId: 'o1', timestamp: new Date(OLD_AT).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 1 } } }) + '\n';
fs.writeFileSync(path.join(dir, 'sess-old.jsonl'), oldLine);
fs.mkdirSync(path.join(tmp, 'state'));
fs.writeFileSync(path.join(tmp, 'state', 'usage-cache.json'), JSON.stringify({ v: 2, files: { [path.join(dir, 'sess-old.jsonl')]: { offset: Buffer.byteLength(oldLine), lastReq: 'o1', account: 'personal', sessionId: 'sess-old', sub: false, model: 'claude-opus-5-5', in: 1, out: 0, cr: 0, cw: 0, cost: 0, requests: 1, first: OLD_AT, last: OLD_AT, ctx: 1, days: {}, models: {}, dayModels: {} } } }));
const usage = require(path.join(tmp, 'lib', 'usage.js'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const now = Date.now();
const line = (req, at, usageExtra, model = 'claude-opus-5-5') => JSON.stringify({ type: 'assistant', requestId: req, timestamp: new Date(at).toISOString(), message: { model, usage: { input_tokens: 1000, output_tokens: 100, ...usageExtra } } }) + '\n';
const main = path.join(dir, 'sess-1.jsonl');
const agent = (id, type, model) => {
  const fp = path.join(dir, 'sess-1', 'subagents', `agent-${id}.jsonl`);
  fs.writeFileSync(fp, line('r-' + id, now - 1000, {}, model));
  if (type) fs.writeFileSync(fp.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: type }));
};

test('parseCompactWindow reads values the way the CLI does', () => {
  const cases = { '200k': 200000, '1M': 1000000, '200K': 200000, '0.5M': 500000, '150.5k': 150500, '1.5M': 1000000, '9M': 1000000, 200: 100000, 500000: 500000 };
  for (const [v, want] of Object.entries(cases)) assert.strictEqual(usage.parseCompactWindow(v), want, v);
  for (const bad of ['', 'lots', 'auto', '0', 'k', null, undefined]) assert.strictEqual(usage.parseCompactWindow(bad), null, String(bad));
});

test('ctxLimits caps the model window by the account setting and places the compact point 33k below it', () => {
  assert.deepStrictEqual(usage.ctxLimits(1e6, 'personal'), { window: 200000, modelWindow: 1e6, compactAt: 167000 });
  assert.deepStrictEqual(usage.ctxLimits(1e6, null), { window: 200000, modelWindow: 1e6, compactAt: 167000 });
  assert.deepStrictEqual(usage.ctxLimits(1e6, 'company'), { window: 500000, modelWindow: 1e6, compactAt: 467000 });
  assert.deepStrictEqual(usage.ctxLimits(2e5, 'company'), { window: 200000, modelWindow: 2e5, compactAt: 167000 });
});

test('ctxLimits prefers a per-model setting over the top-level one, and the environment setting over both', () => {
  assert.strictEqual(usage.ctxLimits(1e6, 'company', 'claude-sonnet-5-5[1m]').window, 300000);
  assert.strictEqual(usage.ctxLimits(1e6, 'company', 'claude-haiku-5-5').window, 400000);
  assert.strictEqual(usage.ctxLimits(1e6, 'company', 'claude-opus-5-5').window, 500000);
  assert.strictEqual(usage.ctxLimits(1e6, 'personal', 'claude-sonnet-5-5').window, 200000);
});

test('ctxLimits drops the compact point when auto-compact is off', () => {
  process.env.DISABLE_AUTO_COMPACT = '1';
  try { assert.deepStrictEqual(usage.ctxLimits(1e6, 'personal'), { window: 200000, modelWindow: 1e6, compactAt: null }); } finally { delete process.env.DISABLE_AUTO_COMPACT; }
});

test('cacheOf gives minutes left while warm and cold after the ttl', () => {
  const cl = (ttl, ago) => ({ state: 'idle', usage: { cacheAt: now - ago, cacheTtl: ttl } });
  assert.deepStrictEqual(usage.cacheOf(cl(3600e3, 22 * 60e3), now), { cold: false, min: 38 });
  assert.deepStrictEqual(usage.cacheOf(cl(300e3, 299e3), now), { cold: false, min: 1 });
  assert.deepStrictEqual(usage.cacheOf(cl(300e3, 300e3), now), { cold: true });
  assert.deepStrictEqual(usage.cacheOf(cl(3600e3, 3600e3 + 1), now), { cold: true });
});

test('cacheOf stays silent unless it knows the answer', () => {
  const base = { state: 'idle', since: now, usage: { cacheAt: now - 60e3, cacheTtl: 3600e3 } };
  assert.deepStrictEqual(usage.cacheOf(base, now), { cold: false, min: 59 }, 'a fresh state change alone (opening a chat) changes nothing');
  for (const state of ['working', 'background', 'permission', 'limit', 'ended']) assert.strictEqual(usage.cacheOf({ ...base, state }, now), null, state);
  assert.strictEqual(usage.cacheOf({ ...base, usage: { ...base.usage, pending: true } }, now), null, 'transcript has bytes the scan has not read');
  assert.strictEqual(usage.cacheOf({ ...base, usage: null }, now), null);
  assert.strictEqual(usage.cacheOf({ ...base, usage: { cacheAt: null, cacheTtl: null } }, now), null);
  assert.strictEqual(usage.cacheOf({ ...base, usage: { cacheAt: now - 60e3, cacheTtl: null } }, now), null, 'unknown ttl inside the longest ttl');
  assert.deepStrictEqual(usage.cacheOf({ ...base, usage: { cacheAt: now - 3700e3, cacheTtl: null } }, now), { cold: true }, 'past the longest ttl it is cold whatever the ttl was');
});

test('a compact or a switch to another model family ends a warm cache', () => {
  const u = { cacheAt: now - 60e3, cacheTtl: 3600e3, cacheModel: 'claude-opus-5-5' };
  const chat = (usage_, model) => ({ state: 'idle', mode: 'chat', model, usage: usage_ });
  assert.deepStrictEqual(usage.cacheOf(chat({ ...u, compactAt: now - 30e3 }, 'claude-opus-5-5'), now), { cold: true });
  assert.deepStrictEqual(usage.cacheOf(chat({ ...u, compactAt: now - 90e3 }, 'claude-opus-5-5'), now), { cold: false, min: 59 });
  assert.deepStrictEqual(usage.cacheOf(chat(u, 'sonnet'), now), { cold: true });
  assert.deepStrictEqual(usage.cacheOf(chat(u, 'opus'), now), { cold: false, min: 59 });
  assert.deepStrictEqual(usage.cacheOf(chat(u, 'claude-opus-5-5[1m]'), now), { cold: false, min: 59 });
  assert.deepStrictEqual(usage.cacheOf(chat(u, null), now), { cold: false, min: 59 });
  assert.deepStrictEqual(usage.cacheOf({ state: 'idle', mode: 'terminal', model: 'sonnet', usage: u }, now), { cold: false, min: 59 }, 'a terminal model name can be stale');
});

test('scan records the ttl of the last write, keeps it through read-only requests and starts the clock at the first line of a request', async () => {
  fs.writeFileSync(main, line('r1', now - 600e3, { cache_creation: { ephemeral_5m_input_tokens: 500 } }));
  await usage.scan();
  assert.strictEqual(usage.bySession('sess-1').cacheTtl, 300e3);
  fs.appendFileSync(main, line('r2', now - 500e3, { cache_creation: { ephemeral_1h_input_tokens: 500 } }));
  await usage.scan();
  assert.strictEqual(usage.bySession('sess-1').cacheTtl, 3600e3);
  fs.appendFileSync(main, line('r3', now - 400e3, { cache_read_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }));
  fs.appendFileSync(main, line('r3', now - 300e3, { cache_read_input_tokens: 500 }));
  await usage.scan();
  const s = usage.bySession('sess-1');
  assert.strictEqual(s.cacheTtl, 3600e3);
  assert.strictEqual(s.cacheAt, new Date(now - 400e3).getTime());
});

test('an error line that never reached the API leaves the cache clock alone, and unread bytes mark it pending', async () => {
  const fp = path.join(dir, 'sess-err.jsonl');
  fs.writeFileSync(fp, line('e1', now - 7200e3, { cache_creation: { ephemeral_1h_input_tokens: 500 } }));
  await usage.scan();
  assert.strictEqual(usage.bySession('sess-err').pending, false);
  const synthetic = JSON.stringify({ type: 'assistant', requestId: 'e2', timestamp: new Date(now - 60e3).toISOString(), message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }) + '\n';
  fs.appendFileSync(fp, synthetic);
  assert.strictEqual(usage.bySession('sess-err').pending, true);
  await usage.scan();
  const s = usage.bySession('sess-err');
  assert.strictEqual(s.pending, false);
  assert.strictEqual(s.cacheAt, new Date(now - 7200e3).getTime());
  assert.deepStrictEqual(usage.cacheOf({ state: 'idle', usage: s }, now), { cold: true });
});

test('a sidechain line in the main transcript leaves the cache clock and model alone', async () => {
  const fp = path.join(dir, 'sess-side.jsonl');
  fs.writeFileSync(fp, line('m1', now - 600e3, { cache_creation: { ephemeral_1h_input_tokens: 500 } }));
  const side = JSON.parse(line('h1', now - 60e3, { cache_creation: { ephemeral_5m_input_tokens: 300 } }, 'claude-haiku-5-5'));
  fs.appendFileSync(fp, JSON.stringify({ ...side, isSidechain: true }) + '\n');
  await usage.scan();
  const s = usage.bySession('sess-side');
  assert.strictEqual(s.cacheAt, now - 600e3);
  assert.strictEqual(s.cacheModel, 'claude-opus-5-5');
  assert.strictEqual(s.cacheTtl, 3600e3);
});

test('a compact boundary is kept for the cache check, and the next request clears it', async () => {
  const fp = path.join(dir, 'sess-cmp.jsonl');
  fs.writeFileSync(fp, line('c1', now - 120e3, { cache_creation: { ephemeral_1h_input_tokens: 500 } }));
  fs.appendFileSync(fp, JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(now - 60e3).toISOString(), compactMetadata: { postTokens: 15000 } }) + '\n');
  await usage.scan();
  assert.deepStrictEqual(usage.cacheOf({ state: 'idle', usage: usage.bySession('sess-cmp') }, now), { cold: true });
  fs.appendFileSync(fp, line('c2', now - 30e3, { cache_creation: { ephemeral_1h_input_tokens: 500 } }));
  await usage.scan();
  assert.strictEqual(usage.cacheOf({ state: 'idle', usage: usage.bySession('sess-cmp') }, now).cold, false);
});

test('a record from an older cache file falls back to the last request time and an unknown ttl', () => {
  const s = usage.bySession('sess-old');
  assert.strictEqual(s.cacheAt, OLD_AT);
  assert.strictEqual(s.cacheTtl, null);
  assert.strictEqual(s.pending, false);
  assert.strictEqual(usage.cacheOf({ state: 'idle', usage: s }, OLD_AT + 60e3), null);
  assert.deepStrictEqual(usage.cacheOf({ state: 'idle', usage: s }, OLD_AT + 3601e3), { cold: true });
});

test('models splits subagent spend by type and family, and a subagent never moves the main cache clock', async () => {
  agent('aaa', 'reviewer', 'claude-opus-5-5');
  agent('bbb', 'reviewer', 'claude-opus-5-5');
  agent('ccc', 'Explore', 'claude-haiku-5-5');
  agent('ddd', null, 'claude-sonnet-5-5');
  await usage.scan();
  const m = usage.models(7);
  const by = Object.fromEntries(m.agents.map(a => [a.type + '/' + a.family, a.cost]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['Explore/haiku', 'general-purpose/sonnet', 'reviewer/opus']);
  assert.ok(Math.abs(by['reviewer/opus'] - 2 * usage.costOf({ input_tokens: 1000, output_tokens: 100 }, 'claude-opus-5-5')) < 1e-9);
  assert.ok(Math.abs(m.agents.reduce((sum, a) => sum + a.cost, 0) - m.totals.sub) < 1e-9);
  assert.deepStrictEqual(m.agents.map(a => a.cost), [...m.agents.map(a => a.cost)].sort((x, y) => y - x));
  assert.strictEqual(usage.bySession('sess-1').cacheAt, new Date(now - 400e3).getTime());
});

test('an agent type that appears after the first scan is picked up', async () => {
  fs.writeFileSync(path.join(dir, 'sess-1', 'subagents', 'agent-ddd.meta.json'), JSON.stringify({ agentType: 'test-writer' }));
  const m = usage.models(7);
  assert.ok(m.agents.some(a => a.type === 'test-writer' && a.family === 'sonnet'));
  assert.ok(!m.agents.some(a => a.type === 'general-purpose'));
});
