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
3. **Do they use Claude Code, and with one login or two?** The hook installer writes to
   `~/.claude/settings.json` and, only if that folder exists, `~/.claude-company/settings.json`
   (a second login started with `CLAUDE_CONFIG_DIR=~/.claude-company`). If they use two, ask what
   to call them and set `accountLabels` in Settings.

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
git clone https://github.com/zbla92/beast-dashboard.git ~/beast-dash   # any path works; the installer adapts
cd ~/beast-dash
./install.sh
```

`install.sh` is idempotent — re-run it after changing node version or moving the repo. It:

1. writes `~/.config/systemd/user/beast-{dash,term}.service`, substituting the real node dir and the
   real repo path into the shipped unit templates;
2. enables and starts both services (the terminal one only if `ttyd` is installed);
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
- `serverName` — the name in system push titles (CPU too hot, memory, runaway process).
- `voiceLangs` — only if the user wants voice input in more than one language, e.g. `["en", "de"]`.

## Voice input (optional)

Ask the user whether they want voice input transcribed on this server. If yes, run
`./bin/setup-whisper.sh` (a Python venv with faster-whisper; CUDA libraries when `nvidia-smi` works,
otherwise CPU — then set `WHISPER_MODEL='small'` in `whisper/whisper.env`). Put the languages they speak
in `WHISPER_LANGS` there. Nothing runs until the mic is pressed; the first press downloads the model
(~1.6 GB for large-v3-turbo). Without it the mic uses the browser's speech recognition.

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

## Things worth knowing before the user asks

- Both services are `systemd --user` units. They need **linger** to survive logout; `install.sh`
  enables it. Without it the user will report "it stops when I disconnect".
- The unit templates contain `__NODE_DIR__` / `__REPO__` placeholders; `install.sh` fills them in.
  Never copy the templates by hand — always go through the installer.
- The terminal service (`beast-term`) is only enabled when `ttyd` exists. Without it the dashboard
  works and the ⌨ buttons open a blank page — say so.
- `bin/term.sh` and the file upload use `devRoot` from `state/settings.json`; uploads land in
  `<devRoot>/.pasted` (swept after 7 days, `keep/` is not swept — task attachments live there).
- The *Usage limits* tile reads the OAuth token from `~/.claude/.credentials.json` and calls
  Anthropic's usage endpoint every 30 min. It shows "no credentials" until Claude Code has been
  logged in on this machine. It never refreshes the token itself.
- Two Claude logins: `~/.claude` and optionally `~/.claude-company` (`CLAUDE_CONFIG_DIR`). The
  hook installer only touches the second one if the folder exists. Their ids inside the code are
  `personal` / `company` (they name the folders); the names shown in the UI come from
  `accountLabels` in Settings → *Claude accounts* — ask the user what to call them.
- The README uses placeholders for the tailnet (`100.x.y.z`, `<server>.<tailnet>.ts.net`);
  substitute the user's real values when you report the URL.

## What is in this repository

A cleaned, general version of a personal setup: no hostnames, usernames, project names or runtime
state. Org colours are hashed from the folder name, so any layout gets stable colours. `state/` and
`state-backups/` are gitignored and must stay that way: `state/push.json` holds the **VAPID private
key** and the browser push subscriptions, and the backups are tarballs of `state/`.
