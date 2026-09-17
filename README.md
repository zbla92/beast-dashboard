# Beast Dash

Zero-dependency Node dashboard for a personal dev server. Runs on the server, you open it from your
laptop or phone over Tailscale: **http://100.x.y.z:8787** (or `http://<host>.<tailnet>.ts.net:8787`).

**Installing it?** Read [AGENT-SETUP.md](AGENT-SETUP.md) first — requirements, the access/security
model, and a verification checklist. It is written for someone (or some agent) setting this up on a
machine that is not the author's.

## What it does
- **Discovers projects** in `~/dev` (git repos / package.json / pyproject / compose; plus runnable sub-projects
  like `acme-ops/api`). Classifies them: frontend/backend/mobile/lib/infra + framework + tags.
- **Shows what's running**: tmux sessions started from the dashboard, processes you started by hand
  (attributed by cwd), docker containers (attributed by compose working dir), their ports, CPU%, RAM.
- **Start / stop / restart / rebuild** any package.json script, Makefile target, compose up/down, poetry
  command or your own custom command. Everything runs in a **tmux session** (`bd_<project>__<name>`) with an
  interactive bash, so nvm/.bashrc env is identical to a manual terminal. Output is logged and streamed live
  (ANSI colours). `ssh beast -t tmux attach -t <session>` attaches to any of them.
- **Git**: branch, dirty/untracked count, ahead/behind, stashes, last commit; switch/create branches
  (creates tracking branches from remote), fetch, pull `--rebase --autostash`, stash/pop.
- **Docker**: start/stop/restart/rm containers, compose up/down/logs, live container logs.
- **Tunnels** (⇄): any project port bound only to `127.0.0.1`/`::1` is automatically forwarded to the
  tailscale IP with `socat`, so the Mac reaches it at `100.x.y.z:PORT`. No SSH tunnels needed —
  Tailscale survives wifi changes. "Rebuild all" re-creates every forward. Manual expose supported.
- **VS Code**: every card has a button that opens the folder on the Mac via
  `vscode://vscode-remote/ssh-remote+beast/<path>` (Remote-SSH). Set the SSH alias in ⚙ Settings.
- **System**: CPU (per core + temp), RAM, GPU (nvidia-smi), disk, network, uptime, sparkline history.

## Claude sessions: what each one is doing
Every Claude card shows the session's **state**, sorted so the ones that need you come first:
`working` (current tool shown, e.g. "Bash: npm test") · `done · needs you` (Claude's last message shown) ·
`needs permission` · `error` · `idle`. Plus the session **title** (Claude's own), the last lines of the pane
(**peek**, click to collapse), the unsent **draft** in the prompt box, and the session's API-equivalent **cost**.

- **Quick reply** on the card: type + Enter sends to that session (tmux send-keys) — from the phone without
  opening the terminal. `Esc` interrupts, `^C`, and `y`/`n` when a permission prompt is up.
- **Where the state comes from**: Claude Code hooks (`bin/claude-hook.sh`, installed into `~/.claude/settings.json`
  and `~/.claude-company/settings.json` by `bin/install-hooks.js`) POST every event to `/api/hook` tagged with
  the tmux session; `tmux capture-pane` is the fallback (status line "esc to interrupt" = working, "❯" = waiting)
  and provides the peek. Sessions started by hand (`claude` in any tmux session) are picked up by process name.
- **Restore after reboot**: `state/claude-sessions.json` remembers dir, account and Claude session id of every
  session; when their tmux sessions are gone a banner offers "Restore all" (`claude --resume <id>` in the same dir).
- **More than one Claude per project**: ✦ Claude ▾ → "Another instance" (`claude-<dir>-2`) or "in a git worktree…"
  (`claude --worktree <name>` → `claude-<dir>-wt-<name>`), so two Claudes don't step on each other's files.
- **Cost**: `lib/usage.js` reads the transcripts (`<config>/projects/*/*.jsonl`, incrementally) and prices the
  tokens at API list price — the "Claude today" tile (personal / company / 7 days) and the per-card number. On a
  subscription nothing is billed per token; it measures how much work the sessions did.
- **Push notifications** (Claude finished / needs permission / error) to the phone and Mac: Settings → Push →
  "Enable on this device". Needs HTTPS (below). `lib/push.js` is a dependency-free Web Push (VAPID + aes128gcm).
- **Conversation without the terminal**: 📜 on the card opens the session's transcript (your prompts, Claude's
  replies, tool calls collapsed, reply box at the bottom) read from the JSONL; "Files edited" lists every file
  Claude touched (from Edit/Write hook events), each opening its diff in the project's Files tab.
- **Rename a card** (✎ next to the name): a label of your own; the position never changes (order is tmux's).
- **Changes tab**: commits expand into their files and diffs; commit box with Stage all / Commit / Commit & push /
  Push, so a session's leftover changes don't need a terminal. **Files tab**: tree with change marks, diff or
  syntax-colored content, download, in-place editor (save refuses if the file changed meanwhile).
- **Health**: every port chip carries a dot — green HTTP ok, blue accepts TCP (postgres, redis), amber 5xx / no
  answer, red nothing listening. A dev server started from the dashboard that exits non-zero raises a banner + push.
- **Logs**: filter (regex), error lines tinted, "⚠ last error" jumps to it.
- **Chat mode**: Terminal / Chat switch in the terminal panel; 📷 attach a photo (uploaded, path sent), 🎤 hold to
  talk (Web Speech), ⏰ schedule a message or a chain (`---` between messages; each waits for the previous to finish),
  review card when Claude finished with edited files (diff / revert / approve / request changes).
- **Search conversations**: `⌘K` then `? words` — every session, both accounts; opens the live session or a read-only
  view of a past one with "Resume here" (`claude --resume` in that folder).
- **Usage limit**: detected from the pane → ⏳ state + push; "Hand off" starts the other account in the same folder
  with a summary (recent prompts, last reply, files edited). **Version**: cards show ↻ x.y.z when a newer Claude Code is
  installed; click = /exit + relaunch with --resume. **Notifications**: per-event toggles, quiet hours, per-session
  mute (🔔 on the card), sound on this device, Monday digest. **Auto-restore** after reboot (setting).
- **▶▶ Start all** on a project card brings up what you last started there (commands + Claude). Nightly state backup in
  `state-backups/` (download in Settings). `mac/beast-menubar.sh` = xbar/SwiftBar plugin (needs-you count in the menubar).
- **Keyboard**: `⌘K`/`Ctrl+K` palette (jump to any session/project, start Claude, actions), `t` terminals,
  `n` next session that needs you, `s` new shell, `1-9` switch session in the panel. Inside a terminal (the iframe
  has focus): `Ctrl+Shift+←/→` switch, `Ctrl+Shift+1-9` jump, `Ctrl+Shift+↑` dashboard, `Ctrl+Shift+P` palette.
- Hidden terminal iframes are dropped after 10 min unused: every iframe is a tmux client, and two clients
  (phone + Mac) fight over the pane size.

## HTTPS (one origin for dashboard + terminal, push notifications, PWA)
1. Once, in the Tailscale admin console: https://login.tailscale.com/admin/dns → HTTPS Certificates → Enable.
2. `./bin/enable-https.sh` — sets up `tailscale serve`: `https://<host>.<tailnet>.ts.net/` → dashboard,
   `/term/` → ttyd (which runs with `--base-path /term`). Tailnet-only, not Funnel.
3. Open the https URL on the phone/Mac, Settings → Push → Enable on this device.
Plain http://IP:8787 keeps working exactly as before (terminal at :7681/term/).

## Claude sessions & web terminal
- Card button **✦ Claude ▾** → Personal / Company: creates (or reuses) tmux session `claude-<dir>[-company]` in the
  project dir running `claude --dangerously-skip-permissions` (company = `CLAUDE_CONFIG_DIR=~/.claude-company`) and
  opens it in the browser via **ttyd** (`beast-term.service`, port 7681, `bin/term.sh` only allows attaching to existing
  tmux sessions or a plain shell). Same sessions are reachable from the Mac with `cs <name>` / `cs -c <name>` (mosh + tmux).
- ⌨ on any session row / running chip = live terminal for that tmux session; header **⌨ Shell** = bash in ~/dev.

## Install / run
```bash
~/beast-dash/install.sh        # systemd --user service + linger + ufw allow on tailscale0
systemctl --user status beast-dash
journalctl --user -u beast-dash -f
```
Dev mode: `node ~/beast-dash/server.js`.

Security: the server only answers to 127.0.0.1 and the tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48);
ufw additionally blocks everything that isn't tailscale0/SSH.

## Files
- `server.js` HTTP + SSE API · `lib/discovery.js` project scan · `lib/runtime.js` procs/ports/tmux/docker
- `lib/actions.js` run/stop (tmux) · `lib/gitinfo.js` · `lib/expose.js` socat forwards · `lib/sys.js` stats
- `lib/claude.js` Claude session state (hooks + pane) · `lib/usage.js` transcript cost · `lib/push.js` Web Push
- `bin/claude-hook.sh` + `bin/install-hooks.js` Claude Code hooks · `bin/enable-https.sh` tailscale serve
- `public/` UI (vanilla JS) · `state/` settings.json, runs.json, logs/, cmds/
- `mac/beast-tunnel.sh` optional Mac-side SSH `-L` tunnel (only if something must be `localhost` on the Mac);
  `--watch` mode re-syncs ports and reconnects after wifi changes.

## Mac ~/.ssh/config (for VS Code Remote-SSH + tunnel script)
```
Host beast
    HostName 100.x.y.z      # or <host>.<tailnet>.ts.net
    User youruser
    ServerAliveInterval 15
    ServerAliveCountMax 3
```
