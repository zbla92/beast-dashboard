#!/usr/bin/env bash
# install.sh — installs Beast Dash as a systemd --user service (dashboard + web terminal), enables linger so it
# keeps running without a login session, and opens the tailnet interface in ufw when tailscale + ufw are present.
# Idempotent: re-run after moving the repo or changing the node version.
#
#   ./install.sh            install / update
#   ./install.sh --uninstall  stop and remove the services (state/ and the Claude hooks are left in place)
set -euo pipefail
cd "$(dirname "$0")"
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now beast-dash.service beast-term.service 2>/dev/null || true
  rm -f ~/.config/systemd/user/beast-dash.service ~/.config/systemd/user/beast-term.service
  systemctl --user daemon-reload
  echo "removed. Claude hooks: node bin/install-hooks.js --remove"
  exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found in PATH (install Node 18+; nvm users: run this from a shell where 'node' works)"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "Node $NODE_MAJOR is too old — 18+ required"; exit 1; }
NODE_DIR="$(dirname "$NODE")"
REPO="$(pwd)"
command -v tmux >/dev/null || { echo "tmux is required (sudo apt install tmux)"; exit 1; }

log "systemd user services (node: $NODE, repo: $REPO)"
mkdir -p ~/.config/systemd/user
for u in beast-dash beast-term; do
  sed -e "s#__NODE_DIR__#$NODE_DIR#g" -e "s#__REPO__#$REPO#g" "$u.service" > ~/.config/systemd/user/"$u.service"
done
systemctl --user daemon-reload
systemctl --user enable beast-dash.service >/dev/null
systemctl --user restart beast-dash.service
if command -v ttyd >/dev/null; then
  systemctl --user enable beast-term.service >/dev/null
  systemctl --user restart beast-term.service
else
  echo "ttyd not found — the dashboard runs, the embedded terminal does not (sudo apt install ttyd, then re-run)"
fi

log "Claude Code hooks (session state on the cards)"
node bin/install-hooks.js

log "linger (the services keep running without an active login session)"
sudo loginctl enable-linger "$USER"

if command -v tailscale >/dev/null && command -v ufw >/dev/null; then
  log "ufw: allow everything in on tailscale0 (dashboard + project ports reachable from your devices)"
  sudo ufw allow in on tailscale0 comment 'tailnet: beast-dash + dev ports' >/dev/null
  sudo ufw status | grep -i tailscale0 || true
else
  log "no tailscale/ufw — skipping the firewall step (reach the dashboard over localhost or an SSH tunnel)"
fi

log "optional tools"
for t in ttyd socat docker tailscale git jq; do command -v "$t" >/dev/null && printf "  %-10s ok\n" "$t" || printf "  %-10s missing (sudo apt install %s)\n" "$t" "$t"; done

sleep 1.5
PORT="$(node -e "console.log(require('./lib/settings').get().port)")"
log "status"
systemctl --user --no-pager status beast-dash.service | head -5 || true
if command -v tailscale >/dev/null; then
  IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  NAME="$(tailscale status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).Self.DNSName.replace(/\.$/,""))}catch{console.log("")}})')"
  printf '\n\033[1;32mBeast Dash: http://%s:%s\033[0m' "${IP:-127.0.0.1}" "$PORT"
  [ -n "$NAME" ] && printf '   (also http://%s:%s)' "$NAME" "$PORT"
  printf '\n\n'
else
  printf '\n\033[1;32mBeast Dash: http://127.0.0.1:%s\033[0m   (from another machine: ssh -L %s:localhost:%s -L 7681:localhost:7681 <server>)\n\n' "$PORT" "$PORT" "$PORT"
fi
