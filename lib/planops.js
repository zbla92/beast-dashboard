'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const pf = require('./planfile');

const BIN = path.join(__dirname, '..', 'bin', 'plan');
const TIMEOUT_MS = 10000;
const ERROR_MAX = 300;
const TEXT_MAX = 2000;
const QID_RE = /^q\d{1,6}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const STATUS = { 0: 200, 1: 409, 2: 400, 3: 404 };
const ARCHIVED_RE = /^archived \S+ -> (\S+\/_archive\/\S+)$/;
const NO_STORE = 'test copy has no plan store';

const reply = (status, body) => ({ status, body });
const refuse = (status, error) => reply(status, { ok: false, error });
const errorText = stderr => String(stderr || '').replace(/^plan: /, '').split('\n')[0].slice(0, ERROR_MAX);

function childEnv(root) {
  const env = { ...process.env, BEAST_PLANS_DIR: root };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function planStoreAllowed(env) {
  if (env.BD_TEST !== '1') return true;
  if (!env.BEAST_PLANS_DIR) return false;
  const live = realOrResolved(path.join(os.userInfo().homedir, '.beast', 'plans'));
  const store = realOrResolved(env.BEAST_PLANS_DIR);
  return store !== live && !store.startsWith(live + path.sep);
}

function createPlanOps({ store, root = pf.storeRoot(), bin = BIN, env = process.env } = {}) {
  const queue = { tail: Promise.resolve() };

  function exec(argv) {
    return new Promise(resolve => {
      try {
        execFile(process.execPath, [bin, ...argv], { cwd: root, env: childEnv(root), timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr });
          if (err.killed) return resolve({ code: null, stdout, stderr: 'plan timed out' });
          if (typeof err.code !== 'number') return resolve({ code: null, stdout: '', stderr: `plan did not start (${err.code || 'error'})` });
          return resolve({ code: err.code, stdout, stderr });
        });
      } catch (e) {
        resolve({ code: null, stdout: '', stderr: `plan did not start (${e.code || 'error'})` });
      }
    });
  }

  function run(argv) {
    const job = queue.tail.then(() => exec(argv));
    queue.tail = job.catch(() => {});
    return job;
  }

  function outcome(r, id) {
    if (r.code === 0) return reply(200, { ok: true, id });
    return refuse((r.code !== null && STATUS[r.code]) || 500, errorText(r.stderr) || `plan exited with ${r.code}`);
  }

  async function answer(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const plan = typeof b.id === 'string' ? store.find(b.id) : null;
    if (!plan) return refuse(404, 'no such plan');
    if (plan.archived) return refuse(400, 'plan is archived');
    if (!plan.repo) return refuse(409, 'plan has no repo marker');
    if (typeof b.q !== 'string' || !QID_RE.test(b.q)) return refuse(409, `no open question ${typeof b.q === 'string' ? b.q.slice(0, 20) : ''}`.trimEnd());
    if (typeof b.text !== 'string') return refuse(400, 'text must be a string');
    const text = b.text.trim();
    if (!text || text.length > TEXT_MAX) return refuse(400, `answer must be 1-${TEXT_MAX} characters`);
    if (CONTROL_RE.test(b.text)) return refuse(400, 'answer must be one line without control characters');
    if (!pf.questions(plan.doc).some(x => x.id === b.q)) return refuse(409, `no open question ${b.q}`);
    return outcome(await run(['answer', '--repo', plan.repo, '--plan', plan.topic, '--', b.q, text]), plan.id);
  }

  function target(body, archived) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const plan = typeof b.id === 'string' ? store.find(b.id) : null;
    if (!plan) return { refused: refuse(404, 'no such plan') };
    if (plan.archived !== archived) return { refused: refuse(400, archived ? 'plan is not archived' : 'plan is archived') };
    if (!plan.repo) return { refused: refuse(409, 'plan has no repo marker') };
    return { plan };
  }

  async function finish(body) {
    const { plan, refused } = target(body, false);
    if (refused) return refused;
    return outcome(await run(['finish', '--repo', plan.repo, '--plan', plan.topic]), plan.id);
  }

  async function archive(body) {
    const { plan, refused } = target(body, false);
    if (refused) return refused;
    const r = await run(['archive', '--repo', plan.repo, '--plan', plan.topic]);
    if (r.code !== 0) return outcome(r);
    const m = ARCHIVED_RE.exec(r.stdout.trim());
    return m ? outcome(r, m[1]) : refuse(500, 'plan did not name the archive folder');
  }

  async function restore(body) {
    const { plan, refused } = target(body, true);
    if (refused) return refused;
    return outcome(await run(['restore', '--repo', plan.repo, '--', plan.folder]), `${plan.repoDir}/${plan.topic}`);
  }

  const guarded = op => async body => (planStoreAllowed(env) ? op(body) : refuse(403, NO_STORE));

  return { answer: guarded(answer), finish: guarded(finish), archive: guarded(archive), restore: guarded(restore) };
}

module.exports = { createPlanOps };
