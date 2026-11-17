'use strict';
// The shell a command runs in, so it gets the environment a terminal would (nvm, PATH, …).
//   Linux: `bash -ic` (~/.bashrc), as upstream always did.
//   macOS: the login shell as login + interactive, what Terminal opens: zsh reads ~/.zprofile (Homebrew's shellenv
//   lives there) and ~/.zshrc. DISABLE_AUTO_UPDATE keeps oh-my-zsh from stopping at its "update? [Y/n]" prompt,
//   which would hang every session the dashboard starts.
const fs = require('fs');
const path = require('path');

function loginShell() {
  const s = process.env.SHELL;
  try { if (s && path.isAbsolute(s)) { fs.accessSync(s, fs.constants.X_OK); return s; } } catch {}
  return '/bin/zsh';
}

// prefix for a tmux shell-command string: `${interactive()} ${shq(script)}`
function interactive() {
  return process.platform === 'darwin' ? `DISABLE_AUTO_UPDATE=true ${loginShell()} -lic` : 'bash -ic';
}

module.exports = { interactive, loginShell };
