'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { LIMITS, scan, analyze, render } = require('../lib/cost-report');

const ROOT = path.join(__dirname, 'fixtures', 'cost-report', 'projects');
const BIN = path.join(__dirname, '..', 'bin', 'cost-report');
const NOW = '2026-11-20T12:00:00Z';

const scanned = (extra = {}) => scan({ roots: [ROOT], days: 7, now: NOW, ...extra });
const analysis = analyze(scanned());
const forLabel = (pattern, sessionPrefix) => analysis.findings.filter(f => f.pattern === pattern && f.label.includes(sessionPrefix));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} vs ${expected}`);

test('P1 opus-subagent: routine agent is a finding priced against haiku, general-purpose is marked check', () => {
  const routine = forLabel('opus-subagent', 'agent Explore');
  assert.strictEqual(routine.length, 1);
  assert.deepStrictEqual(routine[0].tokens, { input: 2000, cacheWrite: 4000, cacheRead: 20000, output: 1000 });
  near(routine[0].usd, 0.052 - 0.0014);
  assert.strictEqual(routine[0].fix, 'pass model: haiku');
  assert.ok(routine[0].label.includes('find the demo handler'));
  assert.ok(!routine[0].check);

  const check = forLabel('opus-subagent', 'agent general-purpose');
  assert.strictEqual(check.length, 1);
  assert.strictEqual(check[0].check, true);
  assert.strictEqual(check[0].fix, 'pass model: sonnet');
  near(check[0].usd, 0.052 - (2000 * 2 + 1000 * 10 + 20000 * 0.2 + 4000 * 2.5) / 1e6);
});

test('P1 ignores reviewer agents and subagents already on a cheaper model', () => {
  assert.strictEqual(forLabel('opus-subagent', 'agent reviewer').length, 0);
  assert.strictEqual(analysis.findings.filter(f => f.pattern === 'opus-subagent').length, 2);
});

test('P2 cache-expired: late request with a big cache write is a finding, small writes are not', () => {
  const found = forLabel('cache-expired', 'cac0e003');
  assert.strictEqual(found.length, 1);
  assert.deepStrictEqual(found[0].tokens, { input: 0, cacheWrite: 25000, cacheRead: 0, output: 0 });
  near(found[0].usd, 25000 * (5 - 0.2) / 1e6);
  assert.match(found[0].detail, /gap 9 min/);
});

test('P3 big-tool-result: counts later requests only until the compaction', () => {
  const found = forLabel('big-tool-result', 'b16e0004');
  assert.strictEqual(found.length, 1);
  assert.deepStrictEqual(found[0].tokens, { input: 0, cacheWrite: 10000, cacheRead: 30000, output: 0 });
  near(found[0].usd, (10000 * 2.5 + 30000 * 0.2) / 1e6);
  assert.match(found[0].detail, /^Bash cat build\.log/);
});

test('P4 big-start: first request context is carried by every later request', () => {
  const found = forLabel('big-start', 'b165ca05');
  assert.strictEqual(found.length, 1);
  assert.deepStrictEqual(found[0].tokens, { input: 0, cacheWrite: 50005, cacheRead: 150015, output: 0 });
  near(found[0].usd, (50005 * 5 + 150015 * 0.2) / 1e6);
});

test('P5 repeat-call: normalized repeats count, skipped tools do not', () => {
  const found = forLabel('repeat-call', 'e0ea7006');
  assert.strictEqual(found.length, 1);
  assert.deepStrictEqual(found[0].tokens, { input: 0, cacheWrite: 2200, cacheRead: 0, output: 0 });
  near(found[0].usd, 2200 * 0.125 / 1e6);
  assert.match(found[0].detail, /^Read \/home\/user\/work\/demo\/notes\.txt x3/);
});

test('clean, streamed and out-of-window sessions yield no findings', () => {
  for (const prefix of ['c1ea0001', '57ea0007', '01d00008', '9re00009']) {
    assert.strictEqual(analysis.findings.filter(f => f.label.includes(prefix)).length, 0, prefix);
  }
  assert.strictEqual(analysis.findings.length, 10);
});

test('a streamed request is counted once and keeps tool_use blocks from every line', () => {
  const stream = scanned().transcripts.find(t => t.sessionId.startsWith('57ea0007'));
  assert.strictEqual(stream.requests.length, 2);
  assert.deepStrictEqual(stream.requests[0].tools.map(t => t.name), ['Read', 'Grep']);
});

test('requests outside the window are ignored', () => {
  const old = scanned().transcripts.find(t => t.sessionId.startsWith('01d00008'));
  assert.strictEqual(old.requests.length, 0);
  const wide = scan({ roots: [ROOT], days: 30, now: NOW }).transcripts.find(t => t.sessionId.startsWith('01d00008'));
  assert.strictEqual(wide.requests.length, 2);
});

test('big-start is skipped when the true first request is before the window', () => {
  const mixed = scanned().transcripts.find(t => t.sessionId.startsWith('9re00009'));
  assert.strictEqual(mixed.requests.length, 2);
  assert.strictEqual(mixed.firstInWindow, false);
  assert.strictEqual(forLabel('big-start', '9re00009').length, 0);
});

test('1h cache writes set the 1h TTL and are priced at the 1h rate in P2 to P5', () => {
  const expired = forLabel('cache-expired', '1b00000a');
  assert.strictEqual(expired.length, 1);
  assert.match(expired[0].detail, /gap 80 min, TTL 60 min/);
  near(expired[0].usd, 25000 * (4 - 0.2) / 1e6);

  const big = forLabel('big-tool-result', '1b00000a');
  assert.deepStrictEqual(big[0].tokens, { input: 0, cacheWrite: 10000, cacheRead: 50000, output: 0 });
  near(big[0].usd, (10000 * 4 + 50000 * 0.2) / 1e6);

  const start = forLabel('big-start', '1b00000a');
  assert.deepStrictEqual(start[0].tokens, { input: 0, cacheWrite: 45000, cacheRead: 225000, output: 0 });
  near(start[0].usd, (45000 * 4 + 225000 * 0.2) / 1e6);

  const repeat = forLabel('repeat-call', '1b00000a');
  assert.deepStrictEqual(repeat[0].tokens, { input: 0, cacheWrite: 2200, cacheRead: 0, output: 0 });
  near(repeat[0].usd, (1100 * 4 + 1100 * 0.2) / 1e6);
});

test('the tool input summary never uses a url or directory path', () => {
  const found = analysis.findings.filter(f => /^(Bash|Read)/.test(f.detail));
  assert.ok(found.length > 0);
  assert.ok(found.every(f => !/https?:/.test(f.detail)));
});

test('limits can be overridden per call', () => {
  const lenient = analyze(scanned(), { limits: { ...LIMITS, startMain: 10 ** 9 } });
  assert.strictEqual(lenient.findings.filter(f => f.pattern === 'big-start').length, 0);
});

test('labels use the last two path parts of the cwd and the first 8 session id characters', () => {
  const main = scanned().transcripts.find(t => t.sessionId.startsWith('c1ea0001'));
  assert.strictEqual(main.label, 'work/demo c1ea0001');
});

test('render prints the summary table, sections, and none for empty patterns', () => {
  const text = render(analysis, { days: 7, now: Date.parse(NOW), top: 10 });
  assert.match(text, /^# Session waste report/);
  assert.match(text, /## Summary\n\n\| Pattern \| Findings \| input \| cache write \| cache read \| output \| Est\. \$ \| Fix \|/);
  assert.match(text, /\| big-start \| 2 \| 0 \| 95\.0k \| 375\.0k \| 0 \| \$0\.51 \|/);
  for (const pattern of ['opus-subagent', 'cache-expired', 'big-tool-result', 'big-start', 'repeat-call']) {
    assert.match(text, new RegExp(`\\n## ${pattern}\\n`));
  }
  assert.strictEqual(text, render(analysis, { days: 7, now: Date.parse(NOW), top: 10 }));

  const empty = render(analyze(scan({ roots: [path.join(ROOT, 'missing')], days: 7, now: NOW })), { days: 7, now: Date.parse(NOW), top: 10 });
  assert.strictEqual((empty.match(/\nnone\n/g) || []).length, 5);
});

test('render keeps the top findings by cost', () => {
  const text = render(analysis, { days: 7, now: Date.parse(NOW), top: 1 });
  const section = text.split('\n## opus-subagent\n')[1].split('\n## cache-expired\n')[0];
  assert.strictEqual((section.match(/\| work\/demo /g) || []).length, 1);
  assert.match(section, /agent Explore/);
});

test('CLI exits 2 with usage without --out or with an unknown flag', () => {
  const missing = spawnSync(process.execPath, [BIN, '--days', '3'], { encoding: 'utf8' });
  assert.strictEqual(missing.status, 2);
  assert.match(missing.stderr, /usage: cost-report/);
  const unknown = spawnSync(process.execPath, [BIN, '--out', path.join(os.tmpdir(), 'x.md'), '--bogus', '1'], { encoding: 'utf8' });
  assert.strictEqual(unknown.status, 2);
});

test('CLI exits 2 when --out is an existing directory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [BIN, '--out', dir, '--root', ROOT, '--now', NOW], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /usage: cost-report/);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dir)).filter(n => n === `${path.basename(dir)}-2`), []);
});

test('CLI writes the report and never overwrites an existing file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'report.md');
  const args = [BIN, '--out', out, '--root', ROOT, '--now', NOW, '--days', '7'];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.strictEqual(first.status, 0);
  assert.strictEqual(first.stdout.trim(), out);
  const original = fs.readFileSync(out, 'utf8');
  assert.match(original, /^# Session waste report/);

  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.strictEqual(second.status, 0);
  assert.strictEqual(second.stdout.trim(), path.join(dir, 'report-2.md'));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), original);

  const third = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.strictEqual(third.stdout.trim(), path.join(dir, 'report-3.md'));
});
