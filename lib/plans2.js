'use strict';
const fs = require('fs');
const path = require('path');
const pf = require('./planfile');

const ARCHIVE_DAYS = 14;
const DEBOUNCE_MS = 300;
const POLL_MS = 5000;
const CWD_TTL = 60000;
const RESOURCE_ERRORS = new Set(['ENOSPC', 'EMFILE', 'ENFILE', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM']);
const WATCHED_FILES = new Set(['plan.md', 'events.jsonl']);

function real(p) { try { return fs.realpathSync(p); } catch { return null; } }
function decode(s) { try { return decodeURIComponent(s); } catch { return null; } }

function createPlanStore({ root = pf.storeRoot() } = {}) {
  const cache = new Map();
  const cwdCache = new Map();
  const listeners = new Set();

  function locate(id) {
    if (typeof id !== 'string') return null;
    const segs = id.split('/');
    const archived = segs.length === 3;
    if (segs.length < 2 || segs.length > 3) return null;
    if (archived && segs[1] !== '_archive') return null;
    if (!segs.every((s, i) => (archived && i === 1) || pf.isTopic(s))) return null;
    const base = real(root);
    if (!base) return null;
    const dir = path.join(base, ...segs);
    if (real(dir) !== dir) return null;
    return { id, repoDir: segs[0], topic: segs[segs.length - 1], archived, dir };
  }

  function safeFile(dir, name) {
    const f = path.join(dir, name);
    try { return fs.lstatSync(f).isFile() ? f : null; } catch { return null; }
  }

  function attempt(fn) {
    try { return fn(); } catch { return null; }
  }

  function mtimeOf(file) {
    return attempt(() => Math.round(fs.statSync(file).mtimeMs)) || 0;
  }

  function statStamp(planFile, eventsFile) {
    return attempt(() => {
      const ps = fs.statSync(planFile);
      const es = eventsFile ? fs.statSync(eventsFile) : null;
      return { mtime: Math.round(ps.mtimeMs), sig: `${ps.mtimeMs}:${ps.size}:${es ? `${es.mtimeMs}:${es.size}` : '-'}` };
    });
  }

  function load(loc) {
    const planFile = safeFile(loc.dir, 'plan.md');
    if (!planFile) { cache.delete(loc.dir); return null; }
    const eventsFile = safeFile(loc.dir, 'events.jsonl');
    const stamp = statStamp(planFile, eventsFile);
    if (!stamp) return null;
    const { sig, mtime } = stamp;
    const hit = cache.get(loc.dir);
    if (hit && hit.sig === sig) return hit;
    const parsed = attempt(() => pf.readPlan(loc.dir));
    if (!parsed) return null;
    const entry = { sig, mtime, doc: parsed.doc, events: eventsFile ? pf.readEvents(loc.dir).events : [] };
    cache.set(loc.dir, entry);
    return entry;
  }

  function collect() {
    const out = [];
    const keep = new Set();
    for (const e of pf.listPlans(root)) {
      const loc = locate(e.id);
      if (!loc) continue;
      const entry = load(loc);
      if (!entry) continue;
      keep.add(loc.dir);
      out.push({ loc, entry });
    }
    for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
    return out;
  }

  function repoChanged(main) {
    const repoDir = main && attempt(() => pf.repoDirFor(root, main));
    if (!repoDir) return;
    for (const e of pf.listPlans(root)) if (e.repoDir === repoDir && !e.archived) for (const fn of listeners) fn(e.id);
  }

  function refresh(cwd, hit) {
    cwdCache.set(cwd, { main: hit ? hit.main : null, at: hit ? hit.at : 0, pending: true });
    pf.mainWorktreeAsync(cwd).then(main => {
      cwdCache.set(cwd, { main, at: Date.now(), pending: false });
      if (cwdCache.size > 500) cwdCache.delete(cwdCache.keys().next().value);
      if (!hit || hit.main !== main) { repoChanged(main); if (hit) repoChanged(hit.main); }
    }).catch(() => cwdCache.delete(cwd));
  }

  function mainOf(cwd) {
    const hit = cwdCache.get(cwd);
    if (hit && (hit.pending || Date.now() - hit.at < CWD_TTL)) return hit.main;
    refresh(cwd, hit);
    return hit ? hit.main : null;
  }

  function sessionMap(items, sessions) {
    const live = items.filter(x => !x.loc.archived && x.entry.doc.meta.status !== 'done');
    const unfinished = live.filter(x => !pf.summarize(x.entry.doc, x.entry.events).finished);
    const claimers = new Map();
    const offered = new Map();
    const add = (map, id, name) => { if (!map.has(id)) map.set(id, []); map.get(id).push(name); };
    for (const s of [...(sessions || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (!s || !s.name || !s.cwd) continue;
      const main = mainOf(s.cwd);
      const repoDir = main && pf.repoDirFor(root, main);
      if (!repoDir) continue;
      const claim = pf.readClaim(root, s.name);
      const claimed = claim && claim.repoDir === repoDir ? live.find(x => x.loc.repoDir === repoDir && x.loc.topic === claim.topic) : null;
      if (claimed) { add(claimers, claimed.loc.id, s.name); continue; }
      const open = unfinished.filter(x => x.loc.repoDir === repoDir);
      if (open.length === 1) add(offered, open[0].loc.id, s.name);
    }
    return { claimers, offered };
  }

  function projectIds(projects) {
    const out = new Map();
    for (const p of projects || []) {
      const r = p && p.path && real(p.path);
      if (r && !out.has(r)) out.set(r, p.id);
    }
    return out;
  }

  function serverFields(x, map, ids) {
    const repo = x.entry.doc.meta.repo;
    return {
      id: x.loc.id, repoDir: x.loc.repoDir, projectId: (repo && ids.get(repo)) || null,
      sessions: map.claimers.get(x.loc.id) || [], offered: map.offered.get(x.loc.id) || [], mtime: x.entry.mtime,
    };
  }

  const liveTopic = loc => loc.archived ? {} : { topic: loc.topic };

  function summaries({ projects, sessions, archived = false } = {}) {
    const items = collect();
    const map = sessionMap(items, sessions);
    const ids = projectIds(projects);
    const cutoff = Date.now() - ARCHIVE_DAYS * 86400000;
    return items
      .filter(x => {
        if (!x.loc.archived) return true;
        if (archived) return true;
        return (Date.parse(x.entry.doc.meta.archived) || x.entry.mtime) >= cutoff;
      })
      .sort((a, b) => Number(a.loc.archived) - Number(b.loc.archived) || b.entry.mtime - a.entry.mtime || a.loc.id.localeCompare(b.loc.id))
      .map(x => ({ ...serverFields(x, map, ids), ...pf.summarize(x.entry.doc, x.entry.events), ...liveTopic(x.loc) }));
  }

  function detail(id, { projects, sessions } = {}) {
    const loc = locate(id);
    const entry = loc && load(loc);
    if (!entry) return { error: 'no such plan' };
    const x = { loc, entry };
    const map = sessionMap(collect(), sessions);
    return { ...serverFields(x, map, projectIds(projects)), ...pf.detail(entry.doc, entry.events), ...liveTopic(loc) };
  }

  function find(id) {
    const loc = locate(id);
    const hit = loc && pf.listPlans(root).find(e => e.id === loc.id);
    const entry = hit && load(loc);
    if (!entry) return null;
    const doc = entry.doc;
    return {
      id: hit.id, repoDir: hit.repoDir, topic: hit.archived ? doc.meta.topic || null : hit.topic,
      folder: path.basename(hit.dir), archived: hit.archived, repo: hit.repo, doc,
    };
  }

  function scan() {
    const out = new Map();
    for (const e of pf.listPlans(root)) {
      const loc = locate(e.id);
      const f = loc && safeFile(loc.dir, 'plan.md');
      if (!f) continue;
      try {
        const ps = fs.statSync(f);
        const ev = safeFile(loc.dir, 'events.jsonl');
        const es = ev && fs.statSync(ev);
        out.set(loc.id, `${ps.mtimeMs}:${ps.size}:${es ? `${es.mtimeMs}:${es.size}` : '-'}`);
      } catch {}
    }
    return out;
  }

  function claimedId(name) {
    const claim = pf.readClaim(root, name);
    return claim ? `${claim.repoDir}/${claim.topic}` : null;
  }

  function readClaims() {
    const out = new Map();
    const files = attempt(() => fs.readdirSync(path.join(root, '.claims'))) || [];
    for (const f of files) {
      const name = f.endsWith('.json') && decode(f.slice(0, -5));
      const id = name && claimedId(name);
      if (id) out.set(name, id);
    }
    return out;
  }

  function claimIds(claims, file) {
    if (!file.endsWith('.json')) return [];
    const name = decode(file.slice(0, -5));
    if (!name) return [];
    const before = claims.get(name) || null;
    const now = claimedId(name);
    if (now) claims.set(name, now); else claims.delete(name);
    return [...new Set([before, now])].filter(Boolean);
  }

  function idsOfPath(rel, claims) {
    const s = String(rel).split(path.sep).filter(Boolean);
    if (s[0] === '.claims') return s.length === 2 ? claimIds(claims, s[1]) : [];
    const archived = s[1] === '_archive';
    const depth = archived ? 3 : 2;
    if (s.length < depth || s.length > depth + 1) return [];
    if (!s.slice(0, depth).every((n, i) => (archived && i === 1) || pf.isTopic(n))) return [];
    if (s.length === depth + 1 && !WATCHED_FILES.has(s[depth])) return [];
    return [s.slice(0, depth).join('/')];
  }

  function watch(onChange) {
    const timers = new Map();
    const st = { watcher: null, degraded: false, closed: false, snap: scan() };
    const claims = readClaims();

    function fire(id) {
      const loc = locate(id);
      const f = loc && safeFile(loc.dir, 'plan.md');
      const mtime = f ? mtimeOf(f) : 0;
      try { onChange({ id, mtime, removed: !f }); } catch {}
    }

    function emit(id) {
      if (st.closed) return;
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => { timers.delete(id); fire(id); }, DEBOUNCE_MS));
    }

    function drop() {
      if (!st.watcher) return;
      try { st.watcher.close(); } catch {}
      st.watcher = null;
    }

    function attach() {
      try {
        const w = fs.watch(root, { recursive: true }, (ev, file) => {
          if (file) for (const id of idsOfPath(file, claims)) emit(id);
        });
        w.on('error', e => { drop(); if (e && RESOURCE_ERRORS.has(e.code)) st.degraded = true; });
        st.watcher = w;
      } catch (e) {
        if (e && RESOURCE_ERRORS.has(e.code)) st.degraded = true;
      }
    }

    function diff() {
      const next = scan();
      for (const [id, sig] of next) if (st.snap.get(id) !== sig) emit(id);
      for (const id of st.snap.keys()) if (!next.has(id)) emit(id);
      st.snap = next;
    }

    function tick() {
      if (st.closed) return;
      if (st.watcher && !real(root)) drop();
      const wasWatching = !!st.watcher;
      if (!wasWatching && !st.degraded) attach();
      if (!wasWatching) diff();
    }

    attach();
    listeners.add(emit);
    const poll = setInterval(tick, POLL_MS);
    poll.unref();

    return {
      close() {
        st.closed = true;
        listeners.delete(emit);
        clearInterval(poll);
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        drop();
      },
    };
  }

  return { summaries, detail, find, watch };
}

module.exports = { createPlanStore };
