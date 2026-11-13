'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const API_PROVIDERS = {
  openai: { title: 'OpenAI', baseUrl: 'https://api.openai.com/v1', example: 'gpt-5' },
  xai: { title: 'xAI', baseUrl: 'https://api.x.ai/v1', example: 'grok-4' },
};
const DOCS = 'docs/guide/bots.md';
const KEYS_MAX = 64 * 1024, KEY_MAX = 4096;
const IMPORT_MAX = 256 * 1024, PROMPT_MAX = 1024 * 1024, IMPORT_DEPTH = 5;
const HISTORY_MAX = 500 * 1024, ANSWER_MAX = 8 * 1024 * 1024, ERROR_BODY_MAX = 64 * 1024, DETAIL_MAX = 300;
const TIMEOUT_MS = 300000;
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const CONVERSATIONS = path.join('.bd', 'conversations');

class KeyFileError extends Error {}
class ProviderError extends Error {
  constructor(message, stopped = false) { super(message); this.stopped = stopped; }
}

const isApi = provider => typeof provider === 'string' && Object.hasOwn(API_PROVIDERS, provider);
const titleOf = provider => isApi(provider) ? API_PROVIDERS[provider].title : provider;
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };

function keyFile(env = process.env) {
  return env.BD_PROVIDERS_FILE ? path.resolve(env.BD_PROVIDERS_FILE) : path.join(env.HOME || os.homedir(), '.config', 'beast-dash', 'providers.json');
}

function safeStat(st, file) {
  if (st.isSymbolicLink()) throw new KeyFileError(`${file} is a symlink; replace it with a regular file`);
  if (!st.isFile()) throw new KeyFileError(`${file} is not a regular file`);
  if (st.uid !== process.getuid()) throw new KeyFileError(`${file} is not owned by you; run: chown "$(id -u)" ${file}`);
  if (st.mode & 0o077) throw new KeyFileError(`${file} can be read by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`);
  if (st.size > KEYS_MAX) throw new KeyFileError(`${file} is larger than ${KEYS_MAX} bytes`);
}

function readKeys(file = keyFile()) {
  const st = lstat(file);
  if (!st) throw new KeyFileError(`${file} does not exist; create it with chmod 600`);
  safeStat(st, file);
  const fd = (() => { try { return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { throw new KeyFileError(`${file} could not be opened (${e.code || 'error'})`); } })();
  const text = (() => {
    try {
      const now = fs.fstatSync(fd);
      if (now.ino !== st.ino || now.dev !== st.dev) throw new KeyFileError(`${file} changed while it was read; try again`);
      safeStat(now, file);
      return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  })();
  const data = (() => { try { return JSON.parse(text); } catch { return undefined; } })();
  if (data === undefined) throw new KeyFileError(`${file} is not valid JSON`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new KeyFileError(`${file} must hold a JSON object like {"openai":{"apiKey":"…"}}`);
  return data;
}

function baseUrlOf(value, provider, file) {
  const u = typeof value === 'string' ? (() => { try { return new URL(value); } catch { return null; } })() : null;
  const ok = u && (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.includes(u.hostname))) && !u.username && !u.password && !u.search && !u.hash;
  if (!ok) throw new KeyFileError(`"${provider}".baseUrl in ${file} must be an https:// URL (http:// only for 127.0.0.1 or localhost) without user, query or fragment`);
  return u.href.replace(/\/+$/, '');
}

function providerConfig(provider, file = keyFile()) {
  if (!isApi(provider)) throw new KeyFileError(`${provider} does not use an API key`);
  const data = readKeys(file);
  if (!Object.hasOwn(data, provider)) throw new KeyFileError(`${file} has no "${provider}" entry`);
  const entry = data[provider];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new KeyFileError(`"${provider}" in ${file} must be an object like {"apiKey":"…"}`);
  const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey.trim() : '';
  if (!apiKey) throw new KeyFileError(`"${provider}".apiKey in ${file} is missing or empty`);
  if (apiKey.length > KEY_MAX || !/^[\x21-\x7e]+$/.test(apiKey)) throw new KeyFileError(`"${provider}".apiKey in ${file} must be one line of plain ASCII without spaces`);
  const base = entry.baseUrl === undefined || entry.baseUrl === null || entry.baseUrl === '' ? API_PROVIDERS[provider].baseUrl : baseUrlOf(entry.baseUrl, provider, file);
  return { apiKey, baseUrl: base };
}

function keyError(provider, file = keyFile()) {
  try { providerConfig(provider, file); return null; } catch (e) {
    const why = e instanceof KeyFileError ? e.message : `${file} could not be read`;
    return `no key for ${provider}: ${why}; see ${DOCS}`;
  }
}

const IMPORT_FILES = ['CLAUDE.md', 'style.md'], IMPORT_DIRS = ['knowledge', 'examples'], SHUT_DIRS = ['.secrets', '.bd', '.git'];

function importable(root, p) {
  const r = path.relative(root, p);
  if (!r || path.isAbsolute(r)) return false;
  const parts = r.split(path.sep);
  if (parts.some(s => !s || s.startsWith('.'))) return false;
  return parts.length === 1 ? IMPORT_FILES.includes(parts[0]) : IMPORT_DIRS.includes(parts[0]);
}

function shutImport(text) {
  for (const m of String(text).matchAll(/(?:^|\s)@(\S+)/g)) {
    if (path.posix.normalize(m[1].replace(/\\/g, '/')).split('/').some(s => SHUT_DIRS.includes(s))) return '@' + m[1];
  }
  return null;
}

function mapImports(text, fn) {
  const fence = { open: null };
  return String(text).split('\n').map(l => {
    const mark = /^\s*(```|~~~)/.exec(l);
    if (mark) { fence.open = fence.open === null ? mark[1] : fence.open === mark[1] ? null : fence.open; return l; }
    if (fence.open !== null) return l;
    return l.split(/(`[^`]*`)/).map(part => part.length > 1 && part.startsWith('`') && part.endsWith('`') ? part : part.replace(/(^|\s)@(\S+)/g, (m, pre, ref) => pre + fn(ref))).join('');
  }).join('\n');
}

function importRefs(text) {
  const refs = [];
  mapImports(text, ref => { refs.push(ref); return ''; });
  return refs;
}

function readPlain(file, root, left) {
  if (!importable(root, file)) return null;
  const st = lstat(file);
  if (!st || st.isSymbolicLink() || !st.isFile() || st.size > IMPORT_MAX || st.size > left) return null;
  const at = real(file);
  if (!at || !importable(root, at)) return null;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const now = fs.fstatSync(fd);
      if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev || now.size > IMPORT_MAX || now.size > left) return null;
      return { at, text: fs.readFileSync(fd, 'utf8') };
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function systemPrompt(dir) {
  const root = real(dir);
  if (!root) return '';
  const budget = { left: PROMPT_MAX };
  const load = (file, depth, chain) => {
    const got = readPlain(file, root, budget.left);
    if (!got || chain.includes(got.at)) return null;
    budget.left -= Buffer.byteLength(got.text, 'utf8');
    const next = [...chain, got.at];
    const resolve = (ref, literal) => {
      if (depth >= IMPORT_DEPTH || ref.startsWith('~')) return literal;
      const text = load(path.resolve(path.dirname(file), ref), depth + 1, next);
      return text === null ? literal : text;
    };
    return mapImports(got.text, ref => resolve(ref, '@' + ref));
  };
  const text = load(path.join(root, 'CLAUDE.md'), 0, []);
  return text === null ? '' : text;
}

const transcriptFile = (cwd, sessionId) => path.join(cwd, CONVERSATIONS, sessionId + '.jsonl');
const isConversationFile = (cwd, file) => typeof cwd === 'string' && typeof file === 'string' && path.dirname(file) === path.join(cwd, CONVERSATIONS);

function trimHistory(messages) {
  const out = [...messages];
  const size = () => out.reduce((n, m) => n + m.content.length, 0);
  while (out.length > 1 && size() > HISTORY_MAX) out.shift();
  while (out.length > 1 && out[0].role !== 'user') out.shift();
  return out;
}

function redact(text, key) {
  return String(text).split(key).join('[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]').replace(/\b(sk|xai)-[A-Za-z0-9_-]{8,}/g, '[key]').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, DETAIL_MAX);
}

function detailOf(body, key) {
  const data = (() => { try { return JSON.parse(body); } catch { return null; } })();
  const e = data && (data.error !== undefined ? data.error : data);
  const msg = typeof e === 'string' ? e : e && typeof e.message === 'string' ? e.message : '';
  return msg ? redact(msg, key) : '';
}

function statusError(name, provider, status, detail, file) {
  const more = detail ? `: ${detail}` : '';
  if (status === 401 || status === 403) return `${name} refused the API key (${status}); check "${provider}".apiKey in ${file}`;
  if (status === 404) return `${name} answered 404; check the model id and "${provider}".baseUrl${more}`;
  if (status === 429) return `${name} rate limit or quota reached (429); try again later${more}`;
  if (status >= 500) return `${name} server error (${status}); try again later`;
  return `${name} rejected the request (${status})${more}`;
}

async function readCapped(res, max) {
  if (!res.body) return { text: '', over: false };
  const reader = res.body.getReader();
  const chunks = [], got = { bytes: 0, over: false };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got.bytes += value.byteLength;
    if (got.bytes > max) { got.over = true; await reader.cancel().catch(() => {}); break; }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), over: got.over };
}

async function chat({ provider, model, system, messages, signal, timeoutMs = TIMEOUT_MS, file = keyFile() }) {
  const name = titleOf(provider);
  const cfg = (() => { try { return providerConfig(provider, file); } catch { throw new ProviderError(keyError(provider, file)); } })();
  const timer = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, timer]) : timer;
  const host = new URL(cfg.baseUrl).host;
  const offline = e => {
    if (signal && signal.aborted) return new ProviderError('interrupted', true);
    if (timer.aborted) return new ProviderError(`${name} did not answer within ${Math.ceil(timeoutMs / 1000)} s`);
    const code = e && e.cause && typeof e.cause.code === 'string' ? e.cause.code : null;
    return new ProviderError(`${name} could not be reached at ${host}${code ? ` (${code})` : ''}`);
  };
  const body = JSON.stringify({ model, messages: [...(system.trim() ? [{ role: 'system', content: system }] : []), ...trimHistory(messages)] });
  const res = await fetch(cfg.baseUrl + '/chat/completions', { method: 'POST', redirect: 'error', signal: both, headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json', accept: 'application/json' }, body }).catch(e => { throw offline(e); });
  const got = await readCapped(res, res.ok ? ANSWER_MAX : ERROR_BODY_MAX).catch(e => { throw offline(e); });
  if (!res.ok) throw new ProviderError(statusError(name, provider, res.status, got.over ? '' : detailOf(got.text, cfg.apiKey), file));
  if (got.over) throw new ProviderError(`${name} sent an answer larger than ${ANSWER_MAX} bytes`);
  const data = (() => { try { return JSON.parse(got.text); } catch { return null; } })();
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : null;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p && typeof p.text === 'string' ? p.text : '').join('') : null;
  if (!text || !text.trim()) throw new ProviderError(`${name} sent an answer without text${choice && choice.finish_reason ? ` (finish_reason ${redact(choice.finish_reason, cfg.apiKey)})` : ''}`);
  return { text, model: data && typeof data.model === 'string' ? data.model.slice(0, 200) : model };
}

module.exports = { API_PROVIDERS, isApi, titleOf, keyFile, providerConfig, keyError, systemPrompt, shutImport, importRefs, transcriptFile, isConversationFile, chat, ProviderError };
