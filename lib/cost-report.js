'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { costOf, price, family } = require('./usage');

const DAY = 86400e3;
const FIVE_MIN = 300;
const ONE_HOUR = 3600;

const LIMITS = {
  cacheWrite: 20000,
  bigResultChars: 20000,
  startMain: 40000,
  startSub: 30000,
  repeatMin: 3,
  repeatMinTokens: 2000,
};

const ROUTINE_TYPES = ['Explore', 'gate-runner', 'test-writer', 'cross-repo-impact', 'web-fetch', 'statusline-setup'];
const CHECK_TYPES = ['general-purpose', 'claude', 'Plan'];
const HAIKU_TYPES = ['Explore', 'gate-runner', 'web-fetch'];
const TARGET_MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' };
const SKIP_REPEAT_TOOLS = ['TodoWrite', 'ScheduleWakeup', 'Monitor', 'AskUserQuestion', 'SendMessage'];
const SKIP_REPEAT_PREFIXES = ['Task'];

const PATTERNS = ['opus-subagent', 'cache-expired', 'big-tool-result', 'big-start', 'repeat-call'];
const PATTERN_FIX = {
  'opus-subagent': 'pass model: sonnet or haiku',
  'cache-expired': 'past the cache TTL: /clear and continue from the plan instead of resuming',
  'big-tool-result': 'redirect to a file and print a summary / limit the read / hand it to a subagent',
  'big-start': 'trim CLAUDE.md / memory / MCP servers / skills loaded at start',
  'repeat-call': 'keep the first result or a summary instead of re-running',
};

const zeroTokens = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

const cut = (text, max) => {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) : flat;
};

const usageTokens = usage => ({
  input: usage.input_tokens || 0,
  cacheWrite: usage.cache_creation_input_tokens || 0,
  cacheRead: usage.cache_read_input_tokens || 0,
  output: usage.output_tokens || 0,
});

const addTokens = (a, b) => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
});

const tokensCost = (tokens, model, oneHour) => costOf({
  input_tokens: tokens.input,
  output_tokens: tokens.output,
  cache_read_input_tokens: tokens.cacheRead,
  cache_creation_input_tokens: tokens.cacheWrite,
  cache_creation: oneHour
    ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: tokens.cacheWrite }
    : { ephemeral_5m_input_tokens: tokens.cacheWrite, ephemeral_1h_input_tokens: 0 },
}, model);

const writeSplit = usage => {
  const total = usage.cache_creation_input_tokens || 0;
  const split = usage.cache_creation || {};
  const oneHour = split.ephemeral_1h_input_tokens || 0;
  const fiveMin = split.ephemeral_5m_input_tokens != null ? split.ephemeral_5m_input_tokens : Math.max(0, total - oneHour);
  return { fiveMin, oneHour };
};

const resultChars = content => {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => sum + (part && part.type === 'text' && typeof part.text === 'string' ? part.text.length : 0), 0);
};

const toolSummary = input => {
  if (!input || typeof input !== 'object') return '';
  const value = input.command || input.file_path || input.pattern || '';
  return cut(typeof value === 'string' ? value : '', 80);
};

const labelOf = (cwd, sessionId) => {
  const parts = String(cwd || '').split('/').filter(Boolean);
  const dir = parts.slice(-2).join('/') || 'unknown';
  return `${dir} ${String(sessionId).slice(0, 8)}`;
};

const readMeta = file => {
  try {
    return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) || {};
  } catch {
    return {};
  }
};

const listFiles = (roots, startMs) => {
  const found = [];
  const mtimeOk = fp => {
    try {
      return fs.statSync(fp).mtimeMs >= startMs;
    } catch {
      return false;
    }
  };
  const readDir = dir => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const root of roots) {
    for (const slug of readDir(root)) {
      if (!slug.isDirectory()) continue;
      const slugDir = path.join(root, slug.name);
      for (const entry of readDir(slugDir)) {
        const entryPath = path.join(slugDir, entry.name);
        if (entry.isDirectory()) {
          const subDir = path.join(entryPath, 'subagents');
          for (const sub of readDir(subDir)) {
            if (!sub.name.startsWith('agent-') || !sub.name.endsWith('.jsonl')) continue;
            const fp = path.join(subDir, sub.name);
            if (mtimeOk(fp)) found.push({ file: fp, sub: true, sessionId: entry.name });
          }
        } else if (entry.name.endsWith('.jsonl') && mtimeOk(entryPath)) {
          found.push({ file: entryPath, sub: false, sessionId: entry.name.slice(0, -6) });
        }
      }
    }
  }
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

const readText = file => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const parseLine = line => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const parseTranscript = (entry, startMs, endMs) => {
  const requests = new Map();
  const toolUses = new Map();
  const results = [];
  const compactions = [];
  const state = { cwd: null, seq: 0 };
  for (const line of readText(entry.file).split('\n')) {
    if (!line) continue;
    const o = parseLine(line);
    if (!o || typeof o !== 'object') continue;
    if (o.type !== 'assistant' && o.type !== 'user' && o.type !== 'system') continue;
    state.seq += 1;
    const seq = state.seq;
    const ts = Date.parse(o.timestamp);
    if (!state.cwd && typeof o.cwd === 'string') state.cwd = o.cwd;
    if (o.type === 'system') {
      if (o.subtype === 'compact_boundary') compactions.push({ seq, ts });
      continue;
    }
    const message = o.message || {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (o.type === 'user') {
      for (const block of content) {
        if (block && block.type === 'tool_result') {
          results.push({ seq, ts, toolUseId: block.tool_use_id, chars: resultChars(block.content) });
        }
      }
      continue;
    }
    if (!message.usage) continue;
    const id = o.requestId || message.id || `line-${seq}`;
    const tools = content
      .filter(block => block && block.type === 'tool_use')
      .map(block => ({ id: block.id, name: block.name, input: block.input }));
    for (const tool of tools) if (tool.id) toolUses.set(tool.id, tool);
    const existing = requests.get(id);
    if (existing) {
      for (const tool of tools) if (!existing.tools.some(t => t.id === tool.id)) existing.tools.push(tool);
      continue;
    }
    requests.set(id, { id, seq, ts, model: message.model || null, usage: message.usage, tools });
  }
  const inWindow = t => Number.isFinite(t) && t >= startMs && t <= endMs;
  const realRequests = [...requests.values()].filter(r => r.model !== '<synthetic>' && Object.values(usageTokens(r.usage)).some(n => n > 0));
  const requestList = realRequests.filter(r => inWindow(r.ts));
  const meta = entry.sub ? readMeta(entry.file) : {};
  const agentType = entry.sub ? String(meta.agentType || 'general-purpose') : null;
  const description = entry.sub && meta.description ? cut(meta.description, 60) : '';
  const base = labelOf(state.cwd, entry.sessionId);
  const label = entry.sub ? `${base} agent ${agentType}${description ? ` ${description}` : ''}` : base;
  return {
    file: entry.file,
    sub: entry.sub,
    sessionId: entry.sessionId,
    label,
    agentType,
    metaModel: meta.model || null,
    requests: requestList,
    first: realRequests[0] || null,
    firstInWindow: realRequests[0] ? inWindow(realRequests[0].ts) : false,
    results: results.filter(r => inWindow(r.ts)),
    allResults: results,
    toolUses,
    compactions: compactions.filter(c => !Number.isFinite(c.ts) || c.ts <= endMs),
    wrote1h: realRequests.some(r => ((r.usage.cache_creation || {}).ephemeral_1h_input_tokens || 0) > 0),
  };
};

const scan = ({ roots, days = 7, now = Date.now() }) => {
  const endMs = typeof now === 'string' ? Date.parse(now) : now;
  const startMs = endMs - days * DAY;
  const transcripts = listFiles(roots || [], startMs).map(entry => parseTranscript(entry, startMs, endMs));
  const totalUsd = transcripts.reduce((sum, t) => sum + t.requests.reduce((s, r) => s + costOf(r.usage, r.model), 0), 0);
  return { startMs, endMs, days, transcripts, totalUsd };
};

const modelOf = transcript => (transcript.requests[0] ? transcript.requests[0].model : transcript.metaModel);

const finding = (pattern, transcript, ts, detail, tokens, usd, extra = {}) => ({
  pattern,
  label: transcript.label,
  ts,
  detail,
  tokens,
  usd,
  fix: PATTERN_FIX[pattern],
  ...extra,
});

const opusSubagent = transcript => {
  if (!transcript.sub || !transcript.requests.length) return [];
  const model = modelOf(transcript);
  if (family(model) !== 'opus') return [];
  const type = transcript.agentType;
  const routine = ROUTINE_TYPES.includes(type);
  const check = CHECK_TYPES.includes(type);
  if (!routine && !check) return [];
  const targetKey = HAIKU_TYPES.includes(type) ? 'haiku' : 'sonnet';
  const target = TARGET_MODELS[targetKey];
  const tokens = transcript.requests.reduce((sum, r) => addTokens(sum, usageTokens(r.usage)), zeroTokens());
  const actual = transcript.requests.reduce((sum, r) => sum + costOf(r.usage, r.model), 0);
  const cheaper = transcript.requests.reduce((sum, r) => sum + costOf(r.usage, target), 0);
  const detail = `${check ? 'check: ' : ''}${type} ran on ${model}, ${transcript.requests.length} requests, pass model: ${targetKey}`;
  return [finding('opus-subagent', transcript, transcript.requests[0].ts, detail, tokens, actual - cheaper, { check, fix: `pass model: ${targetKey}` })];
};

const cacheExpired = (transcript, limits) => {
  if (transcript.sub) return [];
  const ttl = transcript.wrote1h ? ONE_HOUR : FIVE_MIN;
  return transcript.requests.flatMap((request, index) => {
    if (index === 0) return [];
    const gap = (request.ts - transcript.requests[index - 1].ts) / 1000;
    const written = request.usage.cache_creation_input_tokens || 0;
    const read = request.usage.cache_read_input_tokens || 0;
    if (gap <= ttl || written < limits.cacheWrite || read >= written) return [];
    const p = price(request.model);
    const split = writeSplit(request.usage);
    const cost = (split.fiveMin * p.cw5 + split.oneHour * p.cw1 - written * p.cr) / 1e6;
    const tokens = { input: 0, cacheWrite: written, cacheRead: 0, output: 0 };
    const detail = `gap ${Math.round(gap / 60)} min, TTL ${Math.round(ttl / 60)} min, wrote ${written} tokens`;
    return [finding('cache-expired', transcript, request.ts, detail, tokens, cost)];
  });
};

const requestsAfter = (transcript, seq) => {
  const next = transcript.compactions.find(c => c.seq > seq);
  const limit = next ? next.seq : Infinity;
  return transcript.requests.filter(r => r.seq > seq && r.seq < limit).length;
};

const bigToolResult = (transcript, limits) => {
  return transcript.results
    .filter(result => result.chars >= limits.bigResultChars)
    .map(result => {
      const tokensEach = Math.round(result.chars / 4);
      const later = requestsAfter(transcript, result.seq);
      const tokens = { input: 0, cacheWrite: tokensEach, cacheRead: tokensEach * later, output: 0 };
      const model = (transcript.requests.find(r => r.seq > result.seq) || transcript.requests[transcript.requests.length - 1] || {}).model || modelOf(transcript);
      const tool = transcript.toolUses.get(result.toolUseId) || {};
      const summary = toolSummary(tool.input);
      const detail = `${tool.name || 'tool'}${summary ? ` ${summary}` : ''}, ${tokensEach} tokens kept for ${later} requests`;
      return finding('big-tool-result', transcript, result.ts, detail, tokens, tokensCost(tokens, model, transcript.wrote1h));
    });
};

const bigStart = (transcript, limits) => {
  const first = transcript.first;
  if (!first || !transcript.firstInWindow) return [];
  const t = usageTokens(first.usage);
  const context = t.input + t.cacheWrite + t.cacheRead;
  const threshold = transcript.sub ? limits.startSub : limits.startMain;
  if (context < threshold) return [];
  const tokens = { input: 0, cacheWrite: context, cacheRead: context * (transcript.requests.length - 1), output: 0 };
  const detail = `first request carried ${context} tokens`;
  return [finding('big-start', transcript, first.ts, detail, tokens, tokensCost(tokens, first.model, transcript.wrote1h))];
};

const sortKeys = value => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => ({ ...acc, [key]: sortKeys(value[key]) }), {});
  }
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  return value;
};

const repeatCall = (transcript, limits) => {
  const resultsById = new Map(transcript.allResults.map(r => [r.toolUseId, r]));
  const groups = new Map();
  for (const request of transcript.requests) {
    for (const tool of request.tools) {
      if (SKIP_REPEAT_TOOLS.includes(tool.name) || SKIP_REPEAT_PREFIXES.some(p => String(tool.name).startsWith(p))) continue;
      const key = `${tool.name}\u0000${JSON.stringify(sortKeys(tool.input))}`;
      const group = groups.get(key) || { name: tool.name, input: tool.input, calls: [] };
      group.calls.push({ ts: request.ts, model: request.model, tokens: Math.round(((resultsById.get(tool.id) || {}).chars || 0) / 4) });
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .filter(group => group.calls.length >= limits.repeatMin)
    .map(group => ({ group, repeats: group.calls.slice(1), wasted: group.calls.slice(1).reduce((sum, call) => sum + call.tokens, 0) }))
    .filter(({ wasted }) => wasted >= limits.repeatMinTokens)
    .map(({ group, repeats, wasted }) => {
      const tokens = { input: 0, cacheWrite: wasted, cacheRead: 0, output: 0 };
      const summary = toolSummary(group.input);
      const detail = `${group.name}${summary ? ` ${summary}` : ''} x${group.calls.length}, ${wasted} tokens repeated`;
      return finding('repeat-call', transcript, group.calls[group.calls.length - 1].ts, detail, tokens, repeats.reduce((sum, call) => sum + tokensCost({ ...zeroTokens(), cacheWrite: call.tokens }, call.model, transcript.wrote1h), 0));
    });
};

const analyze = (scanResult, { limits = LIMITS } = {}) => {
  const lim = { ...LIMITS, ...limits };
  const findings = scanResult.transcripts.flatMap(t => [
    ...opusSubagent(t),
    ...cacheExpired(t, lim),
    ...bigToolResult(t, lim),
    ...bigStart(t, lim),
    ...repeatCall(t, lim),
  ]);
  return {
    startMs: scanResult.startMs,
    endMs: scanResult.endMs,
    mainCount: scanResult.transcripts.filter(t => !t.sub).length,
    subCount: scanResult.transcripts.filter(t => t.sub).length,
    totalUsd: scanResult.totalUsd,
    findings,
  };
};

const pad = n => String(n).padStart(2, '0');
const localDate = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localDateTime = ms => {
  const d = new Date(ms);
  return `${localDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const compact = n => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};
const usd = n => `$${n.toFixed(2)}`;
const cell = text => String(text).replace(/\|/g, '/').replace(/\s+/g, ' ');

const byUsd = (a, b) => b.usd - a.usd || a.ts - b.ts || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

const render = (analysis, { days = 7, top = 10 } = {}) => {
  const rows = PATTERNS.map(pattern => {
    const list = analysis.findings.filter(f => f.pattern === pattern);
    return {
      pattern,
      list,
      tokens: list.reduce((sum, f) => addTokens(sum, f.tokens), zeroTokens()),
      usd: list.reduce((sum, f) => sum + f.usd, 0),
    };
  });
  const summaryRows = [...rows].sort((a, b) => b.usd - a.usd || PATTERNS.indexOf(a.pattern) - PATTERNS.indexOf(b.pattern));
  const out = [
    '# Session waste report',
    '',
    `Range: ${localDate(analysis.startMs)} to ${localDate(analysis.endMs)} (${days} days). Transcripts scanned: ${analysis.mainCount} main, ${analysis.subCount} subagent. Total API-equivalent cost in range: ${usd(analysis.totalUsd)}.`,
    '',
    '## Summary',
    '',
    '| Pattern | Findings | input | cache write | cache read | output | Est. $ | Fix |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...summaryRows.map(r => `| ${r.pattern} | ${r.list.length} | ${compact(r.tokens.input)} | ${compact(r.tokens.cacheWrite)} | ${compact(r.tokens.cacheRead)} | ${compact(r.tokens.output)} | ${usd(r.usd)} | ${cell(PATTERN_FIX[r.pattern])} |`),
    '',
  ];
  for (const row of rows) {
    out.push(`## ${row.pattern}`, '');
    if (!row.list.length) {
      out.push('none', '');
      continue;
    }
    out.push('| Session | When | Detail | cache write | cache read | output | $ |', '| --- | --- | --- | ---: | ---: | ---: | ---: |');
    for (const f of [...row.list].sort(byUsd).slice(0, top)) {
      out.push(`| ${cell(f.label)} | ${localDateTime(f.ts)} | ${cell(f.detail)} | ${compact(f.tokens.cacheWrite)} | ${compact(f.tokens.cacheRead)} | ${compact(f.tokens.output)} | ${usd(f.usd)} |`);
    }
    out.push('', `Fix: ${PATTERN_FIX[row.pattern]}`, '');
  }
  return out.join('\n');
};

const defaultRoots = (home = os.homedir()) => {
  const names = (() => {
    try {
      return fs.readdirSync(home);
    } catch {
      return [];
    }
  })();
  return names
    .filter(name => name.startsWith('.claude'))
    .sort()
    .map(name => path.join(home, name, 'projects'))
    .filter(dir => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
};

module.exports = { LIMITS, scan, analyze, render, defaultRoots };
