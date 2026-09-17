'use strict';
// Port health: is the thing listening on that port actually answering? TCP connect first (down / up), then an HTTP
// GET / with a short timeout for the status code. Non-HTTP services (postgres, redis) answer the TCP connect and
// then fail the HTTP parse — that counts as "up (tcp)". Each port is probed at most every INTERVAL ms.
const net = require('net');
const http = require('http');

const INTERVAL = 15000;
const results = new Map();   // port -> { state: 'ok'|'warn'|'down'|'tcp', status, ms, at }

function tcp(port, host) {
  return new Promise(resolve => {
    const t0 = Date.now(); const s = net.connect({ port, host });
    const done = ok => { try { s.destroy(); } catch {} resolve({ ok, ms: Date.now() - t0 }); };
    s.setTimeout(2000, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false));
  });
}
function httpGet(port, host) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = http.get({ host, port, path: '/', timeout: 2500, headers: { 'user-agent': 'beast-dash-health', accept: '*/*' } }, res => { res.resume(); resolve({ status: res.statusCode, ms: Date.now() - t0 }); });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ms: Date.now() - t0, timeout: true }); });
    req.on('error', () => resolve({ status: null, ms: Date.now() - t0 }));   // not HTTP (or dropped)
  });
}
async function probe(port, addr) {
  const host = addr === '::1' ? '::1' : '127.0.0.1';
  const t = await tcp(port, host);
  if (!t.ok) return { state: 'down', status: null, ms: t.ms, at: Date.now() };
  const h = await httpGet(port, host);
  if (h.status == null) return { state: 'tcp', status: null, ms: t.ms, at: Date.now() };
  if (h.timeout) return { state: 'warn', status: 0, ms: h.ms, at: Date.now(), note: 'no response in 2.5 s' };
  return { state: h.status < 500 ? 'ok' : 'warn', status: h.status, ms: h.ms, at: Date.now() };
}

// ports: [{ port, addr }] — everything the dashboard shows a chip for
async function refresh(ports) {
  const now = Date.now(); const want = new Map(ports.map(p => [p.port, p.addr]));
  for (const k of [...results.keys()]) if (!want.has(k)) results.delete(k);
  const due = [...want].filter(([port]) => !results.has(port) || now - results.get(port).at > INTERVAL);
  await Promise.all(due.map(async ([port, addr]) => { results.set(port, await probe(port, addr)); }));
  return Object.fromEntries(results);
}
function all() { return Object.fromEntries(results); }

module.exports = { refresh, all };
