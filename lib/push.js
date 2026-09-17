'use strict';
// Web Push without dependencies: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291 / RFC 8188).
// Subscriptions come from public/sw.js on the phone/Mac; they only work when the dashboard is served over
// HTTPS (service workers need a secure origin) — see README "HTTPS".
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const { readJson, writeJson, STATE } = require('./util');

const FILE = path.join(STATE, 'push.json');
let st = null;
function load() { if (!st) { st = readJson(FILE, { vapid: null, subs: [] }); if (!st.vapid) { st.vapid = genVapid(); writeJson(FILE, st); } } return st; }
function save() { writeJson(FILE, st); }

const b64u = b => Buffer.from(b).toString('base64url');
function genVapid() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { pub: b64u(ecdh.getPublicKey()), priv: b64u(ecdh.getPrivateKey()) };
}
function publicKey() { return load().vapid.pub; }
function subscriptions() { return load().subs; }
function subscribe(sub, label) {
  if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return { ok: false, error: 'bad subscription' };
  const s = load(); s.subs = s.subs.filter(x => x.endpoint !== sub.endpoint);
  s.subs.push({ endpoint: sub.endpoint, keys: sub.keys, label: label || '', addedAt: Date.now() }); save();
  return { ok: true, count: s.subs.length };
}
function unsubscribe(endpoint) { const s = load(); s.subs = s.subs.filter(x => x.endpoint !== endpoint); save(); return { ok: true, count: s.subs.length }; }

function vapidJwt(aud) {
  const v = load().vapid;
  const pub = Buffer.from(v.pub, 'base64url');           // 65 bytes, uncompressed point
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: v.priv, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:admin@<host>.<tailnet>.ts.net' }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

function encrypt(sub, payload) {
  const uaPub = Buffer.from(sub.keys.p256dh, 'base64url'); const auth = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1'); const asPub = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPub);
  const salt = crypto.randomBytes(16);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);     // 0x02 = last record delimiter
  const ct = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}

function sendOne(sub, payload, ttl = 600) {
  return new Promise(resolve => {
    let u; try { u = new URL(sub.endpoint); } catch { return resolve({ ok: false, status: 0, error: 'bad endpoint' }); }
    let body; try { body = encrypt(sub, payload); } catch (e) { return resolve({ ok: false, status: 0, error: e.message }); }
    const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + u.search, headers: {
      'content-type': 'application/octet-stream', 'content-encoding': 'aes128gcm', 'content-length': body.length, ttl, urgency: 'high',
      authorization: `vapid t=${vapidJwt(u.origin)}, k=${load().vapid.pub}` } }, res => { let b = ''; res.on('data', c => { if (b.length < 500) b += c; }); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: b.trim() || undefined })); });
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    req.end(body);
  });
}

// Send to every subscriber; drop subscriptions the push service says are gone (404/410).
async function notify(data) {
  const s = load(); if (!s.subs.length) return { sent: 0 };
  const payload = JSON.stringify(data); let sent = 0, dropped = 0;
  const results = await Promise.all(s.subs.map(sub => sendOne(sub, payload)));
  s.subs = s.subs.filter((sub, i) => { const r = results[i]; if (r.ok) sent++; if (r.status === 404 || r.status === 410) { dropped++; return false; } return true; });
  if (dropped) save();
  return { sent, dropped, results };
}

module.exports = { publicKey, subscriptions, subscribe, unsubscribe, notify };
