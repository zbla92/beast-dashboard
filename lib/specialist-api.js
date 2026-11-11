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

function createSpecialistApi({ store, runs, readBody, onChange = () => {} }) {
  const read = async req => {
    try { return await readBody(req, BODY_MAX); } catch (e) { throw new SpecialistError(e.status === 413 ? 413 : 400, e.status === 413 ? 'request body too large' : 'bad JSON'); }
  };

  async function route(req, parts, url) {
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
      const p = store.create(input, template === undefined ? 'blank' : template); onChange();
      return [201, { ok: true, specialist: p }];
    }
    const name = seg[0];
    if (seg.length === 1 && m === 'GET') return [200, { ok: true, ...(await runs.detail(name, intParam(url, 'runs', 50, 1, 500))) }];
    if (seg.length === 1 && m === 'POST') {
      const b = await read(req);
      const p = store.update(name, b); onChange();
      return [200, { ok: true, specialist: p }];
    }
    if (seg.length === 2 && seg[1] === 'archive' && m === 'POST') {
      req.resume();
      const r = await runs.archive(name); onChange();
      return [200, { ok: true, name: r.name, archivedAs: r.archivedAs }];
    }
    if (seg.length === 2 && seg[1] === 'ask' && m === 'POST') {
      const b = await read(req);
      const r = await runs.ask(name, b); onChange();
      return [200, { ok: true, ...r }];
    }
    return [404, { ok: false, error: 'not found' }];
  }

  async function handle(req, res, parts, url, json) {
    if (parts[0] !== 'specialists' && parts[0] !== 'specialist') return false;
    try {
      const [status, out] = await route(req, parts, url);
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
