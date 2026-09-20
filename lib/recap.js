'use strict';
// "What did I do today / yesterday": per project — your commits, the Claude sessions that ran (their titles, what you
// asked, which files they edited) and the API-equivalent spend. Built from git log + the transcripts; cached briefly.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { run } = require('./util');

const cache = new Map();   // dayKey -> { at, data }
const trim = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const pad = n => String(n).padStart(2, '0');
function dayWindow(offset) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - offset); const start = d.getTime(); return { start, end: start + 86400e3, key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }; }
let AUTHOR = null;
async function author() { if (AUTHOR != null) return AUTHOR; const e = await run('git', ['config', '--global', 'user.email']); const n = await run('git', ['config', '--global', 'user.name']); AUTHOR = n.stdout.trim() || e.stdout.trim() || process.env.USER || ''; return AUTHOR; }   // the name matches both the personal and the company e-mail

// prompts / titles / edited files inside the window, from one transcript
async function readTranscript(fp, start, end) {
  const out = { prompts: [], files: new Set(), title: null, cwd: null, turns: 0 };
  let stream; try { stream = fs.createReadStream(fp, { encoding: 'utf8' }); } catch { return out; }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.includes('"type":"ai-title"') || line.includes('"type":"custom-title"')) { try { const o = JSON.parse(line); out.title = o.customTitle || o.aiTitle || out.title; } catch {} continue; }
    if (!line.includes('"timestamp"')) continue;
    const m = line.match(/"timestamp":"([^"]+)"/); if (!m) continue; const ts = Date.parse(m[1]); if (!(ts >= start && ts < end)) continue;
    if (line.includes('"type":"user"')) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.isSidechain) continue; const c = o.message?.content; if (!o.cwd && out.cwd == null) out.cwd = o.cwd || null; if (o.cwd) out.cwd = o.cwd;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
      const clean = text.replace(/<pasted_content[^>]*>/g, '').replace(/<\/pasted_content>/g, '').replace(/\[Image: original [^\]]*\]/g, '').trim();
      if (!clean || clean.startsWith('<') || clean.startsWith('[Request interrupted')) continue;   // tool results / system-ish / bare screenshots
      out.turns++; if (out.prompts.length < 12) out.prompts.push({ ts, text: trim(clean, 140) });
    } else if (line.includes('"type":"assistant"') && (line.includes('"name":"Edit"') || line.includes('"name":"Write"') || line.includes('"name":"MultiEdit"') || line.includes('"name":"NotebookEdit"'))) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      for (const b of (Array.isArray(o.message?.content) ? o.message.content : [])) if (b.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name)) { const p = b.input?.file_path || b.input?.notebook_path; if (p) out.files.add(p); }
    }
  }
  return out;
}

async function recap(offset, projects, usageFiles, attribute) {
  const { start, end, key } = dayWindow(offset);
  const c = cache.get(key); if (c && Date.now() - c.at < (offset ? 10 : 2) * 60000) return c.data;
  const per = new Map(); const P = id => { if (!per.has(id)) { const p = projects.find(x => x.id === id); per.set(id, { id, name: p ? p.name : (id || 'other'), org: p ? p.org : null, commits: [], sessions: [], cost: 0 }); } return per.get(id); };
  // git: commits by me in the window, every repo, a few at a time
  const repos = projects.filter(p => p.isGit); const me = await author();
  for (let i = 0; i < repos.length; i += 8) await Promise.all(repos.slice(i, i + 8).map(async p => {
    const r = await run('git', ['-C', p.path, 'log', `--since=${new Date(start).toISOString()}`, `--until=${new Date(end).toISOString()}`, '--author=' + me, '--format=%h\t%s\t%ct', '--no-merges'], { timeout: 8000 });
    for (const l of r.stdout.split('\n').filter(Boolean)) { const [hash, subject, ct] = l.split('\t'); P(p.id).commits.push({ hash, subject: trim(subject, 100), ts: +ct * 1000 }); }
  }));
  // transcripts that cost something that day (usage cache knows per-day cost per file)
  const active = Object.entries(usageFiles).filter(([, r]) => (r.days || {})[key] > 0);
  for (let i = 0; i < active.length; i += 4) await Promise.all(active.slice(i, i + 4).map(async ([fp, r]) => {
    const t = await readTranscript(fp, start, end); if (!t.turns && !t.files.size) return;
    const pid = attribute(t.cwd) || null; const e = P(pid || ('dir:' + (t.cwd || 'unknown'))); if (!pid) e.name = t.cwd ? t.cwd.replace(/^\/home\/[^/]+\//, '~/') : 'unknown';
    const cost = r.days[key]; e.cost += cost;
    e.sessions.push({ sessionId: r.sessionId, account: r.account, title: t.title, cwd: t.cwd, prompts: t.prompts, turns: t.turns, files: [...t.files].slice(0, 40).map(f => f.replace(/^\/home\/[^/]+\/dev\//, '')), cost, model: r.model, transcript: fp });
  }));
  const list = [...per.values()].filter(x => x.commits.length || x.sessions.length).sort((a, b) => (b.cost + b.commits.length * 2) - (a.cost + a.commits.length * 2));
  for (const x of list) { x.commits.sort((a, b) => b.ts - a.ts); x.sessions.sort((a, b) => b.cost - a.cost); }
  const data = { day: key, offset, projects: list, totals: { commits: list.reduce((n, x) => n + x.commits.length, 0), sessions: list.reduce((n, x) => n + x.sessions.length, 0), prompts: list.reduce((n, x) => n + x.sessions.reduce((m, s) => m + s.turns, 0), 0), cost: list.reduce((n, x) => n + x.cost, 0), files: list.reduce((n, x) => n + x.sessions.reduce((m, s) => m + s.files.length, 0), 0) } };
  cache.set(key, { at: Date.now(), data }); return data;
}

module.exports = { recap };
