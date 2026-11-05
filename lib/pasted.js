'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { checkoutOf } = require('./roots');

const UNSORTED = '_unsorted';
const KEEP = 'keep';
const DAY_MS = 86400e3;
const PROJECT_DAYS = 30;
const LOOSE_DAYS = 7;

const realOr = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const segmentsUnder = (root, p) => {
  const rel = path.relative(root, p);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).filter(Boolean);
};

function safeFolderName(name) {
  const clean = name.replace(/[^\w.-]+/g, '-');
  const distinct = clean === name ? clean : `${clean}-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 6)}`;
  return /^[A-Za-z0-9]/.test(distinct) && distinct !== KEEP ? distinct : UNSORTED;
}

function nameTakenInOtherOrg(root, org, name) {
  const orgs = fs.readdirSync(root).filter(o => !o.startsWith('.') && o !== org);
  return orgs.some(o => isDir(path.join(root, o, name)));
}

function projectFolder(cwd, devRoot) {
  if (!cwd || !devRoot) return UNSORTED;
  const root = realOr(devRoot);
  const real = realOr(cwd);
  const checkout = checkoutOf(real);
  const main = checkout && realOr(checkout.main);
  const repoInDev = main && segmentsUnder(root, main)?.length > 0;
  const segments = segmentsUnder(root, checkout?.worktree || repoInDev ? main : real);
  if (!segments?.length) return UNSORTED;
  const [org, name] = segments;
  if (!name) return repoInDev ? safeFolderName(nameTakenInOtherOrg(root, org, org) ? `root-${org}` : org) : UNSORTED;
  return safeFolderName(isDir(path.join(root, name)) || nameTakenInOtherOrg(root, org, name) ? `${org}-${name}` : name);
}

const uploadDir = (base, folder, keep) => (keep ? path.join(base, KEEP, folder) : path.join(base, folder));

function removeOlderThan(dir, days, now) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    if (now - fs.statSync(file).mtimeMs > days * DAY_MS) fs.unlinkSync(file);
  }
}

function sweep(base, now = Date.now()) {
  try {
    removeOlderThan(base, LOOSE_DAYS, now);
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === KEEP) continue;
      removeOlderThan(path.join(base, entry.name), entry.name === UNSORTED ? LOOSE_DAYS : PROJECT_DAYS, now);
    }
  } catch {}
}

const PASTED_PATH = /(?:^|[\s'"=(,:])((?:[^\s'"=(,:;|&)]*\/)?)\.pasted(\/[^\s'"`;|&),]*)?(?=$|[\s'"`;|&),])/g;
const WILDCARD = /[*?[{]/;
const SEARCHES_OR_READS = /(?:^|[\s(/])(ls|ll|la|tree|find|fd|fdfind|grep|egrep|fgrep|rg|ag|ack|cat|head|tail|less|more|file|strings|du|stat|wc|tar|zip|unzip|cp|mv|rsync|scp|for|cd|pushd|python3?|node|perl|ruby|awk|sed|xargs|pdftotext)(?=$|[\s;)])/;
const RUNS_A_SCRIPT = /(?:^|[\s(/;&|])(python3?|node|perl|ruby)\s+-/;
const ONLY_MENTIONS = /^\s*(git|gh|echo|printf|plan)\b/;
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\b/g;
const EXCLUDES = /--exclude(?:-dir)?(?:=|\s+)\S+|(?:-not|\\?!)\s+-(?:i?path|i?name|wholename)\s+\S+|-(?:i?path|i?name)\s+\S+\s+-prune|(?:-g|--glob)(?:=|\s+)\S*!\S*/g;
const ONE_COMMAND = /(?:[^;&|\n'"]+|'[^']*'|"(?:\\.|[^"\\])*"|['"])+/g;

function namesOneFile(devRoot, suffix, parts) {
  if (parts.some(p => WILDCARD.test(p))) return false;
  const found = fs.statSync(path.join(devRoot, '.pasted', suffix), { throwIfNoEntry: false });
  return found ? found.isFile() : !!path.extname(parts[parts.length - 1]);
}

function reachesOtherUploads(devRoot, suffix, own) {
  const clean = path.posix.normalize(suffix || '/');
  const segments = clean.split('/').filter(Boolean);
  const parts = segments[0] === KEEP ? segments.slice(1) : segments;
  if (!parts.length || WILDCARD.test(parts[0])) return true;
  if (parts[0] === own) return false;
  return !namesOneFile(devRoot, clean, parts);
}

function expandDevRoot(prefix, cwd) {
  const expanded = prefix.replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, process.env.HOME || '~');
  return path.dirname(path.resolve(cwd || '/', expanded, '.pasted'));
}

function firstReach(text, cwd) {
  for (const [, prefix, suffix] of String(text || '').matchAll(PASTED_PATH)) {
    const devRoot = expandDevRoot(prefix, cwd);
    if (!prefix && !isDir(path.join(devRoot, '.pasted'))) continue;
    const own = projectFolder(cwd, devRoot);
    if (reachesOtherUploads(devRoot, suffix, own)) return own;
  }
  return null;
}

function bashReach(command, cwd) {
  const text = String(command || '');
  if (RUNS_A_SCRIPT.test(text)) return firstReach(text, cwd);
  const commands = text.replace(HEREDOC, ' ').replace(EXCLUDES, ' ').match(ONE_COMMAND) || [];
  const risky = commands.filter(one => !ONLY_MENTIONS.test(one) && SEARCHES_OR_READS.test(one));
  return risky.map(one => firstReach(one, cwd)).find(Boolean) || null;
}

function blockedUse({ tool_name: tool, tool_input: input = {}, cwd }) {
  const folder = tool === 'Bash' ? bashReach(input.command, cwd)
    : tool === 'Grep' ? firstReach(input.path, cwd)
      : tool === 'Glob' ? firstReach(input.path, cwd) || firstReach(input.pattern, cwd)
        : null;
  if (!folder) return null;
  return `.pasted holds uploads from every project. Use only .pasted/${folder}/ or a file the user named. Ask the user before looking anywhere else there.`;
}

module.exports = { UNSORTED, projectFolder, uploadDir, sweep, blockedUse };
