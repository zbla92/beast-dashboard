'use strict';
// execFile for the macOS modules: never rejects, C locale so `ps` dates and numbers parse the same on every Mac.
const { execFile } = require('child_process');

const ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

function exec(cmd, args = [], timeout = 5000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: ENV }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

module.exports = { exec };
