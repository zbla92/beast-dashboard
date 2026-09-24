'use strict';
// Full-text search across every Claude conversation (both accounts). grep does the heavy lifting (it only prints
// file:line:match, never whole lines — transcript lines can be megabytes), then we read just those lines for a
// snippet and skip tool results / meta lines. Results carry enough to open the conversation or resume it.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { run, HOME } = require('./util');

const ROOTS = { personal: path.join(HOME, '.claude', 'projects'), company: path.join(HOME, '.claude-company', 'projects') };
const MAX_FILES = 40, MAX_HITS = 80;

async function search(q, opts = {}) {
  q = String(q || '').trim(); if (q.length < 2) return { hits: [], error: 'type at least 2 characters' };
  const hits = []; const perFile = new Map();
  for (const [account, root] of Object.entries(ROOTS)) {
    if (!fs.existsSync(root)) continue;
    // -o prints only the matched text, -n the line number, -H the file: tiny output even for huge lines
    const g = await run('grep', ['-r', '-i', '-F', '-n', '-o', '-H', '--include=*.jsonl', '-m', '30', '--', q, root], { timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
    for (const l of g.stdout.split('\n')) {
      const m = l.match(/^(.*?\.jsonl):(\d+):/); if (!m) continue;
      const file = m[1]; if (!perFile.has(file)) perFile.set(file, { account, lines: new Set() });
      perFile.get(file).lines.add(+m[2]);
    }
  }
  // newest transcripts first
  const files = [...perFile.entries()].map(([file, v]) => { let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch {} return { file, ...v, mtime }; }).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
  const lq = q.toLowerCase();
  for (const f of files) {
    const want = f.lines; let title = null, cwd = null; const sessionId = path.basename(f.file, '.jsonl');
    const rl = readline.createInterface({ input: fs.createReadStream(f.file, { encoding: 'utf8' }), crlfDelay: Infinity });
    let n = 0; const found = [];
    for await (const line of rl) {
      n++;
      if (line.includes('"type":"ai-title"')) { try { title = JSON.parse(line).aiTitle || title; } catch {} }
      if (!want.has(n)) continue;
      if (line.length > 400000) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.cwd && !cwd) cwd = o.cwd;
      if (o.type !== 'user' && o.type !== 'assistant') continue;
      if (o.isMeta || o.isSidechain) continue;
      const c = o.message?.content; let text = '';
      if (typeof c === 'string') text = c; else if (Array.isArray(c)) text = c.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (!text || /<local-command-caveat>|<command-name>/.test(text)) continue;
      let role = o.type;
      if (o.type === 'user') { const k = require('./transcript').classifyUser(o, text); if (k.kind === 'skip') continue; if (k.kind !== 'prompt') role = 'event'; text = k.text || text; }
      const i = text.toLowerCase().indexOf(lq); if (i < 0) continue;
      const start = Math.max(0, i - 80); const snippet = (start ? '…' : '') + text.slice(start, i + q.length + 120).replace(/\s+/g, ' ') + (i + q.length + 120 < text.length ? '…' : '');
      found.push({ role, ts: o.timestamp ? Date.parse(o.timestamp) : null, snippet });
      if (found.length >= 5) break;
    }
    rl.close();
    if (!cwd) { try { const head = fs.readFileSync(f.file, { encoding: 'utf8', flag: 'r' }).slice(0, 20000); const m = head.match(/"cwd":"([^"]+)"/); if (m) cwd = m[1]; } catch {} }
    for (const h of found) hits.push({ account: f.account, sessionId, file: f.file, cwd, title, mtime: f.mtime, ...h });
    if (hits.length >= MAX_HITS) break;
  }
  hits.sort((a, b) => (b.ts || b.mtime) - (a.ts || a.mtime));
  return { q, hits: hits.slice(0, MAX_HITS), files: files.length };
}

// Is this path one of our transcript files? (for /api/transcript?file=)
function isTranscript(file) { const r = path.resolve(String(file || '')); return Object.values(ROOTS).some(root => r.startsWith(root + path.sep)) && r.endsWith('.jsonl') && fs.existsSync(r); }

module.exports = { search, isTranscript, ROOTS };
