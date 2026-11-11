'use strict';
// macOS "Sleep" button: the pmset counterpart of lib/sleep.js. Schedules the wake (root: needs the sudoers line
// below), reads it back from `pmset -g sched`, then sleeps a few seconds later so the HTTP answer goes out first.
// Same rule as Linux: never sleep without a verified wake.
//   <user> ALL=(root) NOPASSWD: /usr/bin/pmset schedule wake *
// A MacBook with its lid closed and no display goes back to sleep after a scheduled wake; open, it stays up.
const { spawn } = require('child_process');
const { exec } = require('./exec');

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function scheduled(text, d) {
  // "[0]  wake at 11/12/2026 07:00:00 by 'pmset'" (the year may print with 2 or 4 digits)
  return [...text.matchAll(/wake(?:orpoweron)? at (\d\d)\/(\d\d)\/(\d{2,4}) (\d\d:\d\d:\d\d)/g)]
    .some(m => +m[1] === d.getMonth() + 1 && +m[2] === d.getDate() && +m[3] % 100 === d.getFullYear() % 100 && m[4] === stamp(d).split(' ')[1]);
}

async function suspend(at) {
  if (!at) return { ok: false, error: 'could not work out the next wake time' };
  const r = await exec('sudo', ['-n', '/usr/bin/pmset', 'schedule', 'wake', stamp(at)], 8000);
  if (!r.ok) return { ok: false, error: `pmset schedule failed: ${(r.stderr || 'no sudo').trim().split('\n').pop()} — add to sudoers: ${process.env.USER} ALL=(root) NOPASSWD: /usr/bin/pmset schedule wake *` };
  const s = await exec('pmset', ['-g', 'sched'], 5000);
  if (!scheduled(s.stdout, at)) return { ok: false, error: `the wake at ${stamp(at)} is not in pmset's schedule — NOT sleeping` };
  spawn('/bin/sh', ['-c', 'sleep 4; /usr/bin/pmset sleepnow'], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, wakeAt: at.getTime(), epoch: Math.floor(at.getTime() / 1000) };
}

module.exports = { suspend, stamp, scheduled };
