'use strict';
const { SpecialistError } = require('./specialists');

const BODY_MAX = 2e6;
const decode = s => { try { return decodeURIComponent(s); } catch { return null; } };

function intParam(url, key, def, min, max) {
  const v = url.searchParams.get(key);
  if (v === null || v === '') return def;
  const n = /^\d+$/.test(v) ? +v : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new SpecialistError(400, `${key} must be a whole number ${min}-${max}`);
  return n;
}

function createSpecialistApi({ store, runs, training, skills = null, readBody, onChange = () => {} }) {
  const read = async req => {
    try { return await readBody(req, BODY_MAX); } catch (e) { throw new SpecialistError(e.status === 413 ? 413 : 400, e.status === 413 ? 'request body too large' : 'bad JSON'); }
  };

  async function route(req, res, parts, url) {
    const m = req.method;
    if (parts[0] === 'specialists' && parts.length === 1 && m === 'GET') return [200, { ok: true, root: store.root(), specialists: await runs.list(), templates: store.templates() }];
    if (parts[0] !== 'specialist') return [404, { ok: false, error: 'not found' }];
    const seg = parts.slice(1).map(decode);
    if (seg.some(s => s === null)) throw new SpecialistError(400, 'bad path');
    if (seg[0] === 'run') {
      if (seg.length === 2 && m === 'GET') {
        const wait = url.searchParams.get('wait') === '1';
        return [200, { ok: true, ...(await runs.get(seg[1], { wait, timeoutSec: intParam(url, 'timeoutSec', 300, 1, 1800) })) }];
      }
      if (seg.length === 3 && seg[2] === 'send' && m === 'POST') {
        const b = await read(req);
        const r = await runs.send(seg[1], b); onChange();
        return [200, { ok: true, ...r }];
      }
      return [404, { ok: false, error: 'not found' }];
    }
    if (seg.length === 0 && m === 'POST') {
      const b = await read(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new SpecialistError(400, 'body must be a JSON object');
      const { template, ...input } = b;
      if (template !== undefined && typeof template !== 'string') throw new SpecialistError(400, 'template must be a string');
      const made = store.create(input, template === undefined ? 'blank' : template); onChange();
      if (training) await training.created(made.name);
      const p = store.get(made.name);
      return [201, { ok: true, specialist: skills ? { ...p, skill: skills.sync(p) } : p }];
    }
    const name = seg[0];
    if (seg.length === 1 && m === 'GET') return [200, { ok: true, ...(await runs.detail(name, intParam(url, 'runs', 50, 1, 500))) }];
    if (seg.length === 1 && m === 'POST') {
      const b = await read(req);
      const p = await training.update(name, b); onChange();
      return [200, { ok: true, specialist: p }];
    }
    if (seg.length === 2 && seg[1] === 'archive' && m === 'POST') {
      const b = await read(req);
      const r = await runs.archive(name, b); onChange();
      return [200, { ok: true, name: r.name, archivedAs: r.archivedAs }];
    }
    if (seg.length === 2 && seg[1] === 'chat' && m === 'POST') {
      const b = await read(req);
      const r = await runs.chat(name, b); onChange();
      return [200, { ok: true, ...r }];
    }
    if (seg.length === 2 && seg[1] === 'ask' && m === 'POST') {
      const b = await read(req);
      const r = await runs.ask(name, b); onChange();
      return [200, { ok: true, ...r }];
    }
    if (seg.length === 3 && seg[1] === 'skill' && seg[2] === 'sync' && m === 'POST') {
      const b = await read(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new SpecialistError(400, 'body must be a JSON object');
      const bad = Object.keys(b).filter(k => k !== 'force');
      if (bad.length) throw new SpecialistError(400, `unknown field "${bad[0]}"`);
      if (b.force !== undefined && typeof b.force !== 'boolean') throw new SpecialistError(400, 'force must be true or false');
      const p = store.get(name);
      if (!skills) throw new SpecialistError(500, 'skills are not available');
      const skill = skills.sync(p, { force: b.force === true }); onChange();
      return [200, { ok: true, skill }];
    }
    if (seg[1] === 'train') return trainRoute(req, res, name, seg.slice(2), url);
    if (seg[1] === 'accesses') return accessRoute(req, name, seg.slice(2));
    return [404, { ok: false, error: 'not found' }];
  }

  async function trainRoute(req, res, name, rest, url) {
    const m = req.method, path = rest.join('/');
    if (m === 'GET' && path === '') return [200, { ok: true, ...(await training.overview(name)) }];
    if (m === 'POST' && path === 'send') {
      const b = await read(req);
      const r = await training.send(name, b); onChange();
      return [200, { ok: true, ...r }];
    }
    if (m === 'GET' && path === 'history') {
      const before = url.searchParams.get('before');
      return [200, { ok: true, ...(await training.history(name, { limit: intParam(url, 'limit', 50, 1, 200), before: before === null || before === '' ? null : before })) }];
    }
    if (m === 'GET' && rest.length === 2 && rest[0] === 'commit') return [200, { ok: true, ...(await training.commit(name, rest[1])) }];
    if (m === 'POST' && path === 'undo') {
      const b = await read(req);
      const r = await training.undo(name, b); onChange();
      return [201, { ok: true, ...r }];
    }
    if (m === 'POST' && path === 'upload') {
      const r = await training.upload(name, req, url, res); onChange();
      return [201, { ok: true, ...r }];
    }
    if (m === 'GET' && path === 'feedback') {
      const ids = url.searchParams.get('ids');
      return [200, { ok: true, ...training.feedback(name, { limit: intParam(url, 'limit', 50, 1, 500), ids: ids === null || ids === '' ? null : ids }) }];
    }
    if (m === 'POST' && path === 'feedback') {
      const b = await read(req);
      const r = await training.addFeedback(name, b); onChange();
      return [201, { ok: true, ...r }];
    }
    if (m === 'POST' && rest.length === 3 && rest[0] === 'feedback' && rest[2] === 'retry') {
      req.resume();
      const r = await training.retry(name, rest[1]); onChange();
      return [200, { ok: true, ...r }];
    }
    return [404, { ok: false, error: 'not found' }];
  }

  async function accessRoute(req, name, rest) {
    const m = req.method;
    if (m === 'GET' && rest.length === 0) return [200, { ok: true, ...training.accessList(name) }];
    if (m === 'POST' && rest.length === 0) {
      const b = await read(req);
      const r = await training.setAccess(name, b); onChange();
      return [200, { ok: true, ...r }];
    }
    if (m === 'POST' && rest.length === 2 && rest[1] === 'delete') {
      req.resume();
      const r = await training.removeAccess(name, rest[0]); onChange();
      return [200, { ok: true, ...r }];
    }
    return [404, { ok: false, error: 'not found' }];
  }

  async function handle(req, res, parts, url, json) {
    if (parts[0] !== 'specialists' && parts[0] !== 'specialist') return false;
    try {
      const [status, out] = await route(req, res, parts, url);
      json(res, status, out);
    } catch (e) {
      if (!(e instanceof SpecialistError)) console.error('specialist api', e);
      const status = e instanceof SpecialistError ? e.status : 500;
      if (!res.headersSent) json(res, status, { ok: false, error: e instanceof SpecialistError ? e.message : String(e.message || e) });
    }
    return true;
  }

  return { handle };
}

module.exports = { createSpecialistApi };
