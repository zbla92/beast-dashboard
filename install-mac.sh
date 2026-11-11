#!/usr/bin/env bash
# install-mac.sh — installs Beast Dash on macOS as launchd agents (dashboard + web terminal): the macOS counterpart
# of install.sh. The agents run while you're logged in and restart if they crash; tmux sessions outlive them.
# Idempotent: re-run after moving the repo or changing the node version.
#
#   ./install-mac.sh              install / update
#   ./install-mac.sh --uninstall  stop and remove the agents (state/ and the Claude hooks are left in place)
set -euo pipefail
cd "$(dirname "$0")"
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
[ "$(uname)" = Darwin ] || { echo "this is the macOS installer; on Linux run ./install.sh"; exit 1; }

LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/beast-dash"
REPO="$(pwd)"

if [ "${1:-}" = "--uninstall" ]; then
  for a in com.beastdash.dash com.beastdash.term com.beastdash.whisper; do mac/agent.sh unload "$a"; done
  echo "removed. Claude hooks: node bin/install-hooks.js --remove"
  exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found in PATH (install Node 18+; nvm users: run this from a shell where 'node' works)"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "Node $NODE_MAJOR is too old — 18+ required"; exit 1; }

log "tools (Homebrew)"
for t in tmux ttyd socat; do
  if command -v "$t" >/dev/null; then printf "  %-6s ok\n" "$t"
  elif command -v brew >/dev/null; then brew install "$t"
  else printf "  %-6s missing (install Homebrew, then: brew install %s)\n" "$t" "$t"; fi
done
command -v tmux >/dev/null || { echo "tmux is required"; exit 1; }
tmux set-environment -g -u NODE_ENV 2>/dev/null || true

# launchd starts agents with a bare PATH: give them the one a terminal has (node, Homebrew, ~/.local/bin for claude)
AGENT_PATH="$(dirname "$NODE"):$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
USER_SHELL="${SHELL:-/bin/zsh}"
TTYD="$(command -v ttyd || true)"
fill() { sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" -e "s#__PATH__#$AGENT_PATH#g" -e "s#__HOME__#$HOME#g" \
  -e "s#__SHELL__#$USER_SHELL#g" -e "s#__TTYD__#$TTYD#g" -e "s#__LOGS__#$LOGS#g" "mac/launchd/$1.plist" > "$LA/$1.plist"; }

log "launchd agents (node: $NODE, repo: $REPO, logs: $LOGS)"
mkdir -p "$LA" "$LOGS"
fill com.beastdash.dash && mac/agent.sh load com.beastdash.dash "$LA/com.beastdash.dash.plist"
if [ -n "$TTYD" ]; then
  fill com.beastdash.term && mac/agent.sh load com.beastdash.term "$LA/com.beastdash.term.plist"
else
  echo "ttyd not found — the dashboard runs, the embedded terminal does not (brew install ttyd, then re-run)"
fi
bin/whisper-unit.sh

log "Claude Code hooks (session state on the cards)"
node bin/install-hooks.js

log "agent rules for Claude Code (optional, see docs/guide/agent-rules.md)"
node bin/agent-rules.js --ask || { rc=$?; [ "$rc" = 130 ] && exit 130; echo "agent rules skipped, see docs/guide/agent-rules.md"; }

log "optional tools"
for t in docker tailscale git jq; do command -v "$t" >/dev/null && printf "  %-10s ok\n" "$t" || printf "  %-10s missing\n" "$t"; done

sleep 1.5
PORT="$(node -e "console.log(require('./lib/settings').get().port)")"
log "status"
launchctl print "gui/$(id -u)/com.beastdash.dash" 2>/dev/null | grep -E '^\s*(state|pid) =' || echo "  not running — see $LOGS/dash.log"
if command -v tailscale >/dev/null; then
  IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  printf '\n\033[1;32mBeast Dash: http://%s:%s\033[0m\n' "${IP:-127.0.0.1}" "$PORT"
  echo "The terminal listens on this Mac only; for it (and push) on your phone, run bin/enable-https.sh."
else
  printf '\n\033[1;32mBeast Dash: http://127.0.0.1:%s\033[0m\n' "$PORT"
fi
echo "A MacBook sleeps when the lid closes, and the agents stop with it. Keep it open or on a display while they work."
echo
