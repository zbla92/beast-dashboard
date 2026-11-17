# macOS

Beast Dash runs on a Mac as well as on Linux. The dashboard, chats, Claude sessions, git and plans are the same
code; only the parts that read the machine or manage services differ.

## Install

```bash
git clone <this repo> ~/beast-dash
cd ~/beast-dash && ./install-mac.sh
```

Needs Node 18+ and Homebrew. The installer adds `tmux`, `ttyd` and `socat` with `brew` when they are missing, installs
two launchd agents and the Claude Code hooks, and prints the URL.

| | |
|---|---|
| Agents | `~/Library/LaunchAgents/com.beastdash.dash.plist` (dashboard), `com.beastdash.term.plist` (terminal) |
| Logs | `~/Library/Logs/beast-dash/` (`dash.log`, `term.log`, `whisper.log`) |
| Restart | `launchctl kickstart -k gui/$(id -u)/com.beastdash.dash` |
| Remove | `./install-mac.sh --uninstall` |

The agents run while you are logged in and restart when they crash. tmux sessions keep running when the dashboard
restarts.

## Phone and HTTPS

The terminal (ttyd) has no login of its own, so on a Mac it listens on this machine only. To use the terminal from
your phone, and to get push notifications (they need HTTPS), put both on one tailnet HTTPS address:

```bash
bin/enable-https.sh            # https://<mac>.<tailnet>.ts.net:8443/
bin/enable-https.sh off        # removes only that port
```

On a Mac it uses port 8443, because 443 often serves another app already. `BD_HTTPS_PORT=<port>` picks another
one. It refuses a port that already serves something else, and `off` never resets the whole serve config.

## Sleep

A MacBook sleeps when its lid closes, and the agents stop with it. Keep it open, or closed on an external display
and power, while they work.

The dashboard's Sleep button uses `pmset`. It schedules the next weekday wake (07:00) before it sleeps, and it does
not sleep if it can't. Scheduling a wake needs root, so add one sudoers line (`sudo visudo -f /etc/sudoers.d/beast-dash`):

```
<you> ALL=(root) NOPASSWD: /usr/bin/pmset schedule wake *
```

## Voice

`bin/setup-whisper.sh` works the same. Whisper runs on the CPU on a Mac. For faster answers, set
`WHISPER_MODEL=small` in `whisper/whisper.env`.

## What differs from Linux

| | Linux | macOS |
|---|---|---|
| Services | systemd user units | launchd agents |
| Processes, ports | `probe/` (Rust) or `/proc`, `ss` | `ps`, `netstat`, `lsof` |
| CPU, memory, network | `/proc` | `os.cpus()`, `vm_stat`, `netstat -ib` |
| GPU | NVIDIA (NVML, `nvidia-smi`) | Apple GPU (`ioreg`) |
| Battery | `/sys/class/power_supply` | AppleSmartBattery (`ioreg`) |
| Shell for sessions | `bash -ic` | your login shell, `zsh -lic` |
| Docker socket | `/var/run/docker.sock` | Docker Desktop, OrbStack or Colima socket, whichever exists |
| Android SDK default | `~/Android/Sdk` | `~/Library/Android/sdk` |
| Sleep button | `rtcwake` + `systemctl suspend` | `pmset` |

Not on a Mac yet: CPU temperature, and logs of a process started by launchd rather than by the dashboard.

## For contributors

macOS code lives in `lib/mac/` and `mac/`. The shared modules call it through a one-line branch at the top of the
function that reads the machine, and the Linux code below it stays as it is:

```js
const mac = process.platform === 'darwin' ? require('./mac/sys') : null;
function mem() {
  if (mac) return mac.mem();
  // Linux, unchanged
}
```

Keep it that way: the Linux path keeps working, and changes from upstream merge without conflicts.
