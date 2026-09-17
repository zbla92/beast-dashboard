# Setting up Beast Dash — instructions for an agent

You are installing Beast Dash on the machine it will run on (the **dev server**), for a user who
will open it from another machine (laptop/phone). Read this whole file first, then work top to
bottom and verify after every step. Do not skip the verification lines — most of what goes wrong
here fails silently (a service that restarts in a loop, a hook that never fires).

## What this is

A zero-dependency Node HTTP server (no npm install — everything is Node stdlib) that scans a dev
folder for projects, starts and stops them inside **tmux** sessions, shows processes/ports/docker/git,
and tracks what every **Claude Code** session is doing via Claude Code hooks. A second service
(**ttyd**) serves those tmux sessions as a web terminal embedded in the dashboard.

All mutable state lives in `state/` (gitignored). Nothing in the repo needs editing to run it —
configuration is done in the ⚙ Settings UI, which writes `state/settings.json`.

## Before you start — ask the user

1. **Where is their code?** The default `devRoot` is `~/dev`. Projects are discovered under it, and
   the *first folder level* under `devRoot` becomes the project's "org" (colour-coded grouping).
   So `~/dev/acme/web` → org `acme`, project `web`. If their layout is flat, tell them the org
   grouping will be empty — that is fine, not a failure.
2. **How will they reach it?** This matters most; see *Access* below.
3. **Do they use Claude Code, and with one account or two?** The hook installer writes to both
   `~/.claude/settings.json` (personal) and `~/.claude-company/settings.json` (company). If they only
   use one, the other file simply isn't created.

## Requirements

Node 18+ (no external packages; developed on v24). Then:

| Tool | Needed for | Without it |
|---|---|---|
| `tmux` | **required** — every command the dashboard runs | nothing starts |
| `ttyd` | the embedded web terminal | dashboard works, ⌨ buttons don't |
| `git` | branch/dirty/ahead-behind on cards | git panel stays empty |
| `socat` | auto-forwarding loopback ports onto the tailnet | ⇄ tunnels do nothing |
| `docker` | container list and compose actions | docker section stays empty |
| `tailscale` | the intended remote access path | see *Access* |
| `python3` | only `bin/make-icons.py`, for regenerating PWA icons | nothing at runtime |
| `nvidia-smi` | GPU tile in the system stats | tile is omitted |

`sudo apt install tmux socat git ttyd` covers most of it. Install what's missing, then say which
optional tools you skipped and what the user loses — don't silently install docker or tailscale.

## Access — decide this before installing

The server binds `0.0.0.0:8787` but **rejects every request that is not from `127.0.0.1` or a
Tailscale address** (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) — see `allowed()` in `server.js`. That
check is the security model; the dashboard runs commands and opens shells, so it must not be exposed.

- **Tailscale (what this was built for).** Install tailscale on the server and the client, then reach
  it at `http://<tailscale-ip>:8787`. `install.sh` adds a ufw rule allowing the `tailscale0`
  interface. For push notifications and PWA install you also need HTTPS: run `./bin/enable-https.sh`
  after enabling HTTPS Certificates in the Tailscale admin console (it sets up `tailscale serve`,
  putting the dashboard and the terminal on one origin — required, because the service worker and
  push only work in a secure context).
- **No tailscale.** Everything still works over localhost. From another machine, tunnel:
  `ssh -L 8787:localhost:8787 -L 7681:localhost:7681 <server>` and open `http://localhost:8787`.
  Push notifications will not work (no HTTPS origin) — tell the user this rather than trying to
  widen the `allowed()` check.
- **Do not** put this on a public IP or behind a plain reverse proxy. If the user asks for that,
  stop and tell them what it means: anyone reaching it gets an unauthenticated root-equivalent shell
  on their dev box. There is no login screen.

## Install

```bash
git clone <repo-url> ~/beast-dash      # any path works; the installer adapts
cd ~/beast-dash
./install.sh
```

`install.sh` is idempotent — re-run it after changing node version or moving the repo. It:

1. writes `~/.config/systemd/user/beast-{dash,term}.service`, substituting the real node dir and the
   real repo path into the shipped unit templates;
2. enables and starts both services;
3. registers the Claude Code hooks (`node bin/install-hooks.js`);
4. `sudo loginctl enable-linger $USER` — **needed**, or the services die when the user logs out;
5. adds the ufw rule if both `tailscale` and `ufw` are present, and skips it with a message if not;
6. prints which optional tools are missing.

Steps 4 and 5 use `sudo`. If the agent session cannot sudo, run the rest and tell the user to run
those two lines themselves — don't claim the install succeeded.

**Verify:**

```bash
systemctl --user status beast-dash beast-term   # both active (running), not "activating (auto-restart)"
journalctl --user -u beast-dash -n 30 --no-pager
curl -s localhost:8787/api/state | head -c 200  # JSON, not "forbidden"
```

If `beast-dash` restart-loops, it is almost always the node path in the unit — re-run `./install.sh`
from the repo directory (it reads `$(pwd)`).

## Configure

Open the dashboard and use ⚙ Settings; it writes `state/settings.json`. Worth setting:

- `devRoot` — where projects are scanned (default `~/dev`), and `scanDepth` (default 4).
- `sshHost` / `sshUser` — the client's `~/.ssh/config` alias, which turns the VS Code button into a
  working `vscode://vscode-remote/ssh-remote+<host>/<path>` link. Left empty, the button is useless.
  The README has a matching ssh config block.
- `publicHost` — leave empty to auto-detect the Tailscale IPv4.
- `autoRestore` — bring Claude sessions back after a reboot.
- Notification rules (events, quiet hours, per-session mute) — only relevant once push works.

## Claude Code hooks

`bin/install-hooks.js` adds `bin/claude-hook.sh` to the SessionStart / UserPromptSubmit / PreToolUse /
PermissionRequest / Notification / Stop / StopFailure / SessionEnd hooks. The hook POSTs to the
dashboard, which is how a card knows a session is thinking, waiting for permission, or done. It is
idempotent and `--remove` takes it back out.

**Verify:** start a Claude session from a project card (✦ Claude ▾), send it a prompt, and watch the
card change state. If it stays blank, check `~/.claude/settings.json` really contains the hook path
and that the path exists.

## Verification checklist

- [ ] Both services `active (running)` after a reboot (this is what linger is for).
- [ ] Dashboard reachable from the client machine, and project cards are populated.
- [ ] Starting a package.json script from a card produces live log output.
- [ ] ⌨ opens a working terminal (this is ttyd — separate service, fails independently).
- [ ] A Claude session's card reflects its state.
- [ ] Only if HTTPS is set up: Settings → Push → Enable on this device, then trigger a notification.

## Machine-specific things still in the tree

Not bugs, just assumptions worth knowing before the user reports them:

- `bin/term.sh` opens the plain "⌨ Shell" in `$HOME/dev` literally, not in the configured `devRoot`.
- `server.js` saves pasted images under `~/dev/.pasted`, also independent of `devRoot`.
- The unit templates hardcode node `v24.19.0` and `%h/beast-dash`; `install.sh` rewrites both, so edit
  them only through the installer.
- `term/index.html` and `term/mobile.html` — the phone layer over ttyd (keyboard handling, paste,
  image upload) — are commented in Croatian, and some function and variable names are Croatian too.
  The code works as-is; budget time if you need to modify it.
- The README describes the author's Tailscale setup with placeholders (`100.x.y.z`,
  `<host>.<tailnet>.ts.net`). Substitute the user's real values as you go.

## What is not in this copy

This is a cleaned export of a personal setup. Removed: the author's tailnet address and hostname,
their username, org and project names (org colours are now hashed from the folder name, so any
layout gets stable colours), and all runtime state. There is no git history — one initial commit.
`state/` and `state-backups/` are gitignored and must stay that way: the backups are tarballs of
`state/`, which contains the **VAPID private key** and browser push subscriptions.
