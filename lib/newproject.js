'use strict';
const fs = require('fs');
const path = require('path');
const { run, inside } = require('./util');
const { isProjectDir, SKIP } = require('./discovery');

const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const segOk = s => typeof s === 'string' && SEG.test(s) && s !== '.' && s !== '..';
const realp = p => { try { return fs.realpathSync(p); } catch { return null; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const fail = (status, error) => ({ ok: false, status, error });

function check(b, opts) {
  const devRoot = path.resolve(opts.devRoot); const { scanDepth } = opts;
  const org = b && b.org, name = b && b.name;
  const group = b && b.group != null && b.group !== '' ? b.group : null;
  if (!segOk(org)) return fail(400, 'org folder: letters, digits, . _ - (max 64), not starting with . or -');
  if (!segOk(name)) return fail(400, 'name: letters, digits, . _ - (max 64), not starting with . or -');
  if (group !== null && (typeof group !== 'string' || !group.split('/').every(segOk))) return fail(400, 'group folder: invalid path');
  const skipped = [org, ...(group ? group.split('/') : []), name].find(x => SKIP.has(x));
  if (skipped) return fail(400, `${skipped} is a folder name the project scan skips`);
  const account = b.account === 'company' ? 'company' : 'personal';
  const relParent = group ? path.join(org, group) : org;
  const rel = path.join(relParent, name);
  const parent = path.join(devRoot, relParent);
  const target = path.join(devRoot, rel);
  if (group && !isDir(parent)) return fail(400, `folder ${relParent} does not exist`);
  const root = realp(devRoot);
  if (!root) return fail(400, 'devRoot does not exist');
  let probe = parent; while (!fs.existsSync(probe) && probe !== devRoot) probe = path.dirname(probe);
  const real = realp(probe);
  if (!real || !inside(real, root) || probe !== devRoot && real === root) return fail(400, `${relParent} is outside ${devRoot}`);
  if (fs.existsSync(path.join(devRoot, org)) && !isDir(path.join(devRoot, org))) return fail(400, `${org} is not a folder`);
  const segs = relParent.split(path.sep);
  for (let i = 1; i <= segs.length; i++) {
    const d = path.join(devRoot, ...segs.slice(0, i)); const at = segs.slice(0, i).join('/');
    let link = false; try { link = fs.lstatSync(d).isSymbolicLink(); } catch {}
    if (link) return fail(400, `${at} is a symlink — the project scan does not follow those`);
    if (isDir(d) && isProjectDir(d)) return fail(400, `inside project ${at}`);
  }
  if (rel.split(path.sep).length > scanDepth) return fail(400, `too deep: ${rel.split(path.sep).length} levels, scanDepth is ${scanDepth}`);
  if (fs.existsSync(target)) return fail(409, `${rel} already exists`);
  return { ok: true, devRoot, org, group, name, account, rel, parent, target, newOrg: !fs.existsSync(path.join(devRoot, org)) };
}

async function create(p) {
  const orgDir = path.join(p.devRoot, p.org);
  let ownOrg = false;
  const undo = () => { try { fs.rmSync(p.target, { recursive: true, force: true }); } catch {} if (ownOrg) try { fs.rmdirSync(orgDir); } catch {} };
  try {
    if (p.newOrg) try { fs.mkdirSync(orgDir); ownOrg = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    fs.mkdirSync(p.target);
  } catch (e) { if (e.code !== 'EEXIST') undo(); return fail(e.code === 'EEXIST' ? 409 : 500, e.code === 'EEXIST' ? `${p.rel} already exists` : 'mkdir failed: ' + e.message); }
  let r = await run('git', ['init', '-q', '-b', 'main'], { cwd: p.target, timeout: 10000 });
  if (!r.ok) {
    r = await run('git', ['init', '-q'], { cwd: p.target, timeout: 10000 });
    if (r.ok) r = await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: p.target, timeout: 5000 });
  }
  if (!r.ok) { undo(); return fail(500, 'git init failed: ' + (r.stderr || r.err?.message || '').trim().slice(0, 300)); }
  return { ok: true };
}

module.exports = { check, create };
