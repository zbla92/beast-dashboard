# Install

## Who this is for

You keep your repositories on one always-on Linux machine and work on them from wherever you are.
You run one or more **Claude Code** sessions on it and want to see at a glance what each one is
doing, answer a permission prompt from the phone, start the dev server, check a diff, and get a
push when an agent is done — without opening a laptop or juggling SSH windows.

If that is you, Beast Dash is the page you leave open.

## Requirements

- Linux with **systemd** (Ubuntu/Debian/Fedora/Arch … — the installer uses `systemctl --user`)
- **Node 18+** (developed on 24) — no `npm install` needed
- **tmux** — required; every command the dashboard runs lives in a tmux session, chats included
- **Tailscale** on the server and on your devices — the intended way to reach it (see [Access](access.md))

Optional, each one unlocks a feature and is skipped cleanly when missing:

| Tool | Gives you |
|---|---|
| `ttyd` | the terminal in the browser |
| `git` | branch / changes / commits on the cards; also the Code view, worktrees and checkpoints |
| `socat` | automatic port forwarding onto the tailnet |
| `docker` | container list, compose up/down, container logs |
| `jq` | smaller Claude hook payloads (falls back to a size cap) |
| NVIDIA driver | the GPU tile (read through NVML by the Rust probe, `nvidia-smi` otherwise) |
| `cargo` 1.78+ (Rust, via rustup) | the faster process probe — see [Configuration](configuration.md#process-probe-optional) |
| `python3` | the "⌨ Shell" button reads `devRoot`; icon regeneration |
| **Claude Code** | the agent cards, transcript view, usage limits, and chat sessions (they run `claude -p`) |
| `mise` | the update button for a Claude Code that mise installed (`mise outdated claude`) |
| `sudo` without a password for `rtcwake` and `systemd-run` | only for the optional Sleep button |

```bash
sudo apt install tmux git socat ttyd jq     # Debian / Ubuntu
```

## Quick start

```bash
git clone https://github.com/zbla92/beast-dashboard.git ~/beast-dash
cd ~/beast-dash
./install.sh
```

The installer writes two `systemd --user` units (dashboard + terminal), starts them, registers the
Claude Code hooks, offers the [agent rules](agent-rules.md), enables *linger* (so the services survive logout) and — if `tailscale` and
`ufw` are both present — allows the tailnet interface through the firewall. It prints the URL at
the end, normally `http://<tailscale-ip>:8787`.

Open it, click ⚙ **Settings**:

1. **Projects folder** (`devRoot`) — where to scan. Default `~/dev`. The first folder level below
   it becomes the "org" grouping (`~/dev/acme/web` → org *acme*, project *web*).
2. **SSH host alias** — the name of this server in `~/.ssh/config` on your laptop. It makes the
   *VS Code* button open the folder over Remote-SSH and the *copy ssh command* actions work.

That is the whole setup. Everything else has defaults.

To try it without installing anything: `node server.js` and open `http://localhost:8787`.

Before you open it to other devices, read [Access](access.md).

### The ssh config block

The SSH host alias is an entry like this in `~/.ssh/config` on your laptop (use the Tailscale IP or
the `<server>.<tailnet>.ts.net` name of the server):

```
Host myserver
    HostName 100.x.y.z
    User youruser
```

Then put `myserver` into `sshHost` (and `youruser` into `sshUser`) in ⚙ Settings.

## Setting it up with an AI agent

[AGENT-SETUP.md](../../AGENT-SETUP.md) is written for Claude Code (or any agent) doing the installation on
a machine that is not the author's: what to ask the user first, the access model, every step with
its verification, and what to say when something is missing. Point your agent at it:

> Read AGENT-SETUP.md in this repo and install Beast Dash on this machine.

## Update

```bash
git pull && ./install.sh
```

Then reload the page. A plain `git pull` is not enough: `install.sh` restarts the services, registers new hooks and
offers the [agent rules](agent-rules.md). Nothing in `state/` needs migrating. See [What's new](whats-new.md).

## Uninstall

```bash
./install.sh --uninstall          # stops and removes the two services
node bin/install-hooks.js --remove   # takes our hooks out of Claude Code's settings
node bin/agent-rules.js --remove     # takes the agent rules out of CLAUDE.md, if you added them
./bin/enable-https.sh off         # if you set up tailscale serve
```
