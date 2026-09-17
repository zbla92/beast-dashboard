'use strict';
// Scans devRoot for projects and classifies them (kind, framework, package manager, commands).
const fs = require('fs');
const path = require('path');
const { readJson, readText, exists, slugify, run } = require('./util');
const settings = require('./settings');

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.expo', '.turbo', '.idea', '.vscode', 'target', 'Pods', 'DerivedData']);
const MARKERS = ['package.json', 'pyproject.toml', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Cargo.toml', 'go.mod', 'pubspec.yaml', 'requirements.txt', 'Package.swift'];
const COMPOSE_RE = /^(docker-)?compose[.\w-]*\.ya?ml$/;

function isProjectDir(dir) {
  if (exists(path.join(dir, '.git'))) return true;
  return MARKERS.some(m => exists(path.join(dir, m)));
}

function walk(dir, depth, maxDepth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (isProjectDir(full)) out.push(full);
    else if (depth + 1 < maxDepth) walk(full, depth + 1, maxDepth, out);
  }
}

function detectPm(dir, pkg) {
  if (pkg && typeof pkg.packageManager === 'string') { const m = pkg.packageManager.match(/^(pnpm|yarn|npm|bun)/); if (m) return m[1]; }
  if (exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock'))) return 'bun';
  if (exists(path.join(dir, 'package-lock.json'))) return 'npm';
  return pkg ? 'npm' : null;
}
function pmRun(pm, script) {
  if (pm === 'yarn') return `yarn ${script}`;
  if (pm === 'pnpm') return `pnpm run ${script}`;
  if (pm === 'bun') return `bun run ${script}`;
  return `npm run ${script}`;
}
function pmInstall(pm) {
  if (pm === 'yarn') return 'yarn install';
  if (pm === 'pnpm') return 'pnpm install';
  if (pm === 'bun') return 'bun install';
  return 'npm install';
}

const SCRIPT_ORDER = ['dev', 'start', 'serve', 'preview', 'build', 'test', 'lint', 'type-check', 'typecheck', 'storybook', 'android', 'ios', 'web'];
function orderScripts(scripts) {
  const names = Object.keys(scripts || {});
  const rank = n => { const i = SCRIPT_ORDER.indexOf(n); if (i >= 0) return i; const j = SCRIPT_ORDER.findIndex(s => n.startsWith(s + ':') || n.startsWith(s + '-')); return j >= 0 ? j + 0.5 : 99; };
  return names.filter(n => !/^(pre|post)[a-z]/.test(n) || SCRIPT_ORDER.includes(n)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function classify(dir, pkg, pyproject, composeFiles) {
  const tags = new Set();
  let stack = 'other', framework = null, primary = null;
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) } : {};
  const has = (...names) => names.some(n => n in deps);
  const base = path.basename(dir);

  if (pkg) {
    stack = 'node';
    if (has('expo', 'react-native')) { primary = 'mobile'; framework = has('expo') ? 'expo' : 'react-native'; }
    else if (has('next')) { primary = 'frontend'; framework = 'next'; }
    else if (has('nuxt')) { primary = 'frontend'; framework = 'nuxt'; }
    else if (has('@angular/core')) { primary = 'frontend'; framework = 'angular'; }
    else if (has('@nestjs/core')) { primary = 'backend'; framework = 'nest'; }
    else if (has('fastify')) { primary = 'backend'; framework = 'fastify'; }
    else if (has('express')) { primary = 'backend'; framework = 'express'; }
    else if (has('koa', 'hono', '@hapi/hapi')) { primary = 'backend'; framework = has('koa') ? 'koa' : has('hono') ? 'hono' : 'hapi'; }
    else if (has('vite') && has('react', 'vue', 'svelte', 'preact', 'solid-js')) { primary = 'frontend'; framework = 'vite'; }
    else if (has('react-scripts')) { primary = 'frontend'; framework = 'cra'; }
    else if (has('vite')) { primary = 'frontend'; framework = 'vite'; }
    if (has('prisma', '@prisma/client', 'typeorm', 'mongoose', 'sequelize', 'knex', 'drizzle-orm', 'mysql2', 'pg')) tags.add('db');
    if (has('turbo') || pkg.workspaces || exists(path.join(dir, 'pnpm-workspace.yaml'))) { tags.add('monorepo'); if (!primary) primary = 'monorepo'; }
    if (has('storybook', '@storybook/react')) tags.add('storybook');
    if (has('bullmq', 'bull')) tags.add('queue');
    if (has('socket.io', 'ws')) tags.add('ws');
    if (!primary) {
      if (/sdk|client-sdk|shared|commons|standards|models/.test(base) || (pkg.main || pkg.exports) && !pkg.scripts?.start && !pkg.scripts?.dev) primary = 'lib';
      else if (pkg.scripts?.start || pkg.scripts?.dev) primary = 'backend';
      else primary = 'node';
    }
    if (/design-system|ui-kit|components/.test(base)) tags.add('design-system');
  } else if (pyproject !== null) {
    stack = 'python'; primary = 'backend';
    const py = pyproject || '';
    if (/django/i.test(py)) framework = 'django';
    else if (/fastapi/i.test(py)) framework = 'fastapi';
    else if (/flask/i.test(py)) framework = 'flask';
    if (/celery/i.test(py)) tags.add('celery');
    if (/sqlalchemy|psycopg|asyncpg|alembic/i.test(py)) tags.add('db');
    if (/commons|shared|models/.test(base) && !framework) primary = 'lib';
  } else if (composeFiles.length) { stack = 'docker'; primary = 'infra'; }
  else if (exists(path.join(dir, 'Cargo.toml'))) { stack = 'rust'; primary = 'backend'; }
  else if (exists(path.join(dir, 'go.mod'))) { stack = 'go'; primary = 'backend'; }
  else if (exists(path.join(dir, 'Package.swift')) || /-ios$/.test(base)) { stack = 'swift'; primary = 'mobile'; framework = 'ios'; }
  else if (exists(path.join(dir, 'pubspec.yaml'))) { stack = 'dart'; primary = 'mobile'; framework = 'flutter'; }
  else if (/mobile|ios|android/.test(base)) { primary = 'mobile'; }
  else if (/web|frontend|panel|app/.test(base)) { primary = 'frontend'; }
  else primary = 'repo';
  if (composeFiles.length) tags.add('compose');
  if (exists(path.join(dir, 'Dockerfile'))) tags.add('dockerfile');
  return { stack, primary, framework, tags: [...tags] };
}

function makefileTargets(dir) {
  const txt = readText(path.join(dir, 'Makefile'));
  if (!txt) return [];
  const t = new Set();
  for (const line of txt.split('\n')) { const m = line.match(/^([a-zA-Z0-9_][a-zA-Z0-9_.-]*):(?!=)/); if (m && !m[1].startsWith('.')) t.add(m[1]); }
  return [...t].slice(0, 20);
}
function poetryScripts(py) {
  const m = py && py.match(/\[tool\.poetry\.scripts\]([\s\S]*?)(\n\[|$)/);
  if (!m) return [];
  return m[1].split('\n').map(l => l.match(/^\s*([\w-]+)\s*=/)).filter(Boolean).map(x => x[1]);
}

function buildCommands(dir, pkg, pyproject, composeFiles, cls) {
  const cmds = [];
  const add = (name, cmd, kind = 'task', primary = false) => cmds.push({ name, cmd, kind, primary });
  if (pkg) {
    const pm = detectPm(dir, pkg);
    const scripts = pkg.scripts || {};
    const ordered = orderScripts(scripts);
    const startName = ['dev', 'start', 'serve'].find(s => s in scripts) || ordered.find(s => /^dev[:-]/.test(s));
    for (const s of ordered) {
      const kind = /^(dev|start|serve|preview|storybook|android|ios|web|mock)([:-]|$)/.test(s) ? 'serve' : /^(build|compile)([:-]|$)/.test(s) ? 'build' : /^(test|lint|type-?check|format|e2e)([:-]|$)/.test(s) ? 'check' : 'task';
      add(s, pmRun(pm, s), kind, s === startName);
    }
    add('install', pmInstall(pm), 'install');
    if (scripts.build) add('rebuild', `${pmInstall(pm)} && ${pmRun(pm, 'build')}`, 'build');
  }
  if (cls.stack === 'python') {
    const usesPoetry = /\[tool\.poetry\]/.test(pyproject || '');
    const usesUv = exists(path.join(dir, 'uv.lock'));
    const runner = usesPoetry ? 'poetry run ' : usesUv ? 'uv run ' : '';
    add('install', usesPoetry ? 'poetry install' : usesUv ? 'uv sync' : 'pip install -r requirements.txt', 'install');
    if (exists(path.join(dir, 'manage.py'))) add('runserver', `${runner}python manage.py runserver 0.0.0.0:8000`, 'serve', true);
    for (const s of poetryScripts(pyproject)) add(s, `poetry run ${s}`, 'serve');
    if (exists(path.join(dir, 'make_celery.py'))) add('celery worker', `${runner}celery -A make_celery worker -l info`, 'serve');
    if (exists(path.join(dir, 'pytest.ini')) || /pytest/.test(pyproject || '')) add('pytest', `${runner}pytest`, 'check');
  }
  for (const t of makefileTargets(dir)) add(`make ${t}`, `make ${t}`, /run|dev|serve|start|up/.test(t) ? 'serve' : 'task');
  for (const f of composeFiles) {
    const suffix = composeFiles.length > 1 ? ` (${f})` : '';
    const ff = f === 'docker-compose.yml' || f === 'compose.yml' ? '' : ` -f ${f}`;
    add(`compose up${suffix}`, `docker compose${ff} up -d`, 'compose', cls.primary === 'infra' && f === composeFiles[0]);
    add(`compose down${suffix}`, `docker compose${ff} down`, 'compose');
    add(`compose logs${suffix}`, `docker compose${ff} logs -f --tail 200`, 'compose');
  }
  return cmds;
}

async function gitRemote(dir) {
  const r = await run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 4000 });
  const url = r.stdout.trim();
  if (!url) return { remote: null, remoteRepo: null };
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
  return { remote: url, remoteRepo: m ? m[1] : url };
}

async function scan() {
  const s = settings.get();
  const root = s.devRoot;
  const dirs = [];
  walk(root, 0, s.scanDepth, dirs);
  dirs.sort();
  // sub-projects inside a repo: direct children + apps/*, packages/*, services/* that have their own manifest
  const subs = [];
  for (const dir of dirs) {
    const cands = [];
    const push = d => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) cands.push(path.join(d, e.name)); } catch {} };
    push(dir); for (const g of ['apps', 'packages', 'services', 'libs']) if (exists(path.join(dir, g))) push(path.join(dir, g));
    for (const c of cands) if (exists(path.join(c, 'package.json')) || exists(path.join(c, 'pyproject.toml'))) subs.push({ dir: c, parent: dir });
  }
  const parentOf = Object.fromEntries(subs.map(x => [x.dir, x.parent]));
  const projects = [];
  for (const dir of [...dirs, ...subs.map(x => x.dir)].sort()) {
    const rel = path.relative(root, dir);
    const parentDir = parentOf[dir] || null;
    const parts = (parentDir ? path.relative(root, parentDir) : rel).split(path.sep);
    const id = slugify(rel);
    const pkg = readJson(path.join(dir, 'package.json'), null);
    const pyproject = exists(path.join(dir, 'pyproject.toml')) ? readText(path.join(dir, 'pyproject.toml')) : null;
    let composeFiles = [];
    try { composeFiles = fs.readdirSync(dir).filter(f => COMPOSE_RE.test(f)).sort((a, b) => (a === 'docker-compose.yml' ? -1 : b === 'docker-compose.yml' ? 1 : a.localeCompare(b))); } catch {}
    const cls = classify(dir, pkg, pyproject, composeFiles);
    const commands = buildCommands(dir, pkg, pyproject, composeFiles, cls);
    const isGit = exists(path.join(dir, '.git'));
    const remote = isGit ? await gitRemote(dir) : { remote: null, remoteRepo: null };
    if (parentDir && !commands.some(c => c.kind === 'serve' || c.kind === 'compose')) continue; // sub-projects only if runnable
    const ov = settings.projectOverride(id);
    projects.push({
      id, name: ov.label || path.basename(dir), dirName: path.basename(dir), path: dir, rel,
      parent: parentDir ? slugify(path.relative(root, parentDir)) : null, parentName: parentDir ? path.basename(parentDir) : null,
      org: parts[0], group: parts.length > 2 ? parts.slice(1, -1).join('/') : null,
      ...cls, pm: pkg ? detectPm(dir, pkg) : null, pkgName: pkg?.name || null,
      composeFiles, isGit, ...remote,
      commands: [...(ov.commands || []).map(c => ({ ...c, kind: c.kind || 'custom', custom: true })), ...commands],
      hidden: !!ov.hidden, pinned: !!ov.pin,
      hasReadme: exists(path.join(dir, 'README.md')), hasClaude: exists(path.join(dir, 'CLAUDE.md')),
    });
  }
  return projects;
}

module.exports = { scan };
