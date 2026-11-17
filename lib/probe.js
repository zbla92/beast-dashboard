'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, '..', 'probe', 'target', 'release', 'beast-probe');
const TIMEOUT_MS = 2000;
const MAX_FAILS = 3;
// macOS: the process table and listening ports come from lib/mac/procs.js (ps + netstat), same shapes as the probe's
const mac = process.platform === 'darwin' ? require('./mac/procs') : null;

let off = mac ? 'macOS' : process.env.BD_PROBE === 'node' ? 'BD_PROBE=node' : !fs.existsSync(BIN) ? 'binary missing (cd probe && cargo build --release)' : null;
let child = null, waiting = [], fails = 0, gpuFails = 0, gpuOff = false, lastError = null;
console.log(mac ? 'probe: macOS (ps, netstat, lsof)' : off ? `probe: node (${off})` : `probe: rust (${BIN})`);

function start() {
  const c = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  child = c; let buf = '';
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', d => {
    if (child !== c) return;
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const w = waiting.shift(); if (w) w(line); }
  });
  c.stdin.on('error', () => {});
  c.on('error', e => { if (child === c) fail(e.message); });
  c.on('exit', (code, sig) => { if (child === c) fail(`exited ${code ?? sig}`); });
}

function fail(why, cmd) {
  lastError = why;
  if (cmd === 'gpu') { gpuFails++; if (gpuFails >= MAX_FAILS && !gpuOff) { gpuOff = true; console.error(`probe: gpu via nvidia-smi from now on until restart (${why})`); } }
  else fails++;
  const c = child; child = null;
  if (c) { try { c.kill('SIGKILL'); } catch {} }
  for (const w of waiting.splice(0)) w(null);
  if (fails >= MAX_FAILS && !off) { off = `${fails} failures in a row, last: ${why}`; console.error(`probe: node from now on until restart (${off})`); }
  else console.error(`probe: ${why} — this call uses the node path`);
}

function ask(cmd) {
  if (off) return Promise.resolve(null);
  return new Promise(resolve => {
    const timer = setTimeout(() => fail(`no answer to "${cmd}" in ${TIMEOUT_MS} ms`, cmd), TIMEOUT_MS);
    waiting.push(line => {
      clearTimeout(timer);
      if (line == null) return resolve(null);
      let d; try { d = JSON.parse(line); } catch { fail('unreadable output', cmd); return resolve(null); }
      if (d && d.error === 'unknown command') return resolve(null);
      try { d = convert(cmd, d); } catch (e) { fail('bad answer: ' + e.message, cmd); return resolve(null); }
      if (cmd === 'gpu') gpuFails = 0; else fails = 0;
      resolve(d);
    });
    try { if (!child) start(); child.stdin.write(cmd + '\n'); } catch (e) { fail('spawn/write: ' + e.message, cmd); }
  });
}

function procTable(rows) {
  const procs = new Map();
  for (const [pid, ppid, cpuTicks, rss, start, uid, comm] of rows) procs.set(pid, { pid, comm, ppid, cpuTicks, rss, start, uid });
  return procs;
}

function convert(cmd, d) {
  if (d.error) throw new Error(d.error);
  if (cmd === 'gpu') { if (!('gpu' in d)) throw new Error('no gpu field'); return d.gpu; }
  if (!Array.isArray(d.procs)) throw new Error('no procs');
  if (cmd === 'procs') return procTable(d.procs);
  if (!Array.isArray(d.ports)) throw new Error('no ports');
  return { procs: procTable(d.procs), ports: d.ports.map(([addr, port, pid, proc]) => ({ addr, port, pid, proc })) };
}

function procs() { return mac ? mac.table() : ask('procs'); }
function snap() { return mac ? mac.snap() : ask('snap'); }
function gpu() { return gpuOff ? Promise.resolve(null) : ask('gpu'); }
function status() {
  if (mac) return { mode: 'macos', reason: null, gpu: 'ioreg', lastError: mac.lastError() };
  return { mode: off ? 'node' : 'rust', reason: off, gpu: off || gpuOff ? 'nvidia-smi' : 'nvml', lastError };
}

module.exports = { procs, snap, gpu, status };
