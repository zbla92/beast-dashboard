#!/usr/bin/env bash
# install.sh — installs Beast Dash as a systemd --user service, opens the tailnet in ufw, enables linger.
# Idempotent. Re-run after changing node version (updates the service PATH).
set -euo pipefail
cd "$(dirname "$0")"
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found in PATH (nvm?)"; exit 1; }
NODE_DIR="$(dirname "$NODE")"
# The units ship with this repo's own default location; rewrite both the node dir and the repo dir
# so a clone that lives anywhere (or under another name) still starts.
REPO="$(pwd)"

log "systemd user service (node: $NODE, repo: $REPO)"
mkdir -p ~/.config/systemd/user
for u in beast-dash beast-term; do
  sed -e "s#%h/.nvm/versions/node/v24.19.0/bin#$NODE_DIR#g" -e "s#%h/beast-dash#$REPO#g" \
    "$u.service" > ~/.config/systemd/user/"$u.service"
done
systemctl --user daemon-reload
systemctl --user enable --now beast-dash.service beast-term.service
systemctl --user restart beast-dash.service beast-term.service

log "Claude Code hooks (session state on the cards) -> ~/.claude and ~/.claude-company settings"
node bin/install-hooks.js

log "linger (service runs without an active login session)"
sudo loginctl enable-linger "$USER"

if command -v tailscale >/dev/null && command -v ufw >/dev/null; then
  log "ufw: allow everything in on tailscale0 (dashboard + project ports reachable from the client)"
  sudo ufw allow in on tailscale0 comment 'tailnet: beast-dash + dev ports' >/dev/null
  sudo ufw status | grep -i tailscale0 || true
else
  log "no tailscale/ufw — skipping the firewall step (reach the dashboard over localhost or an SSH tunnel)"
fi

log "deps check"
for t in tmux socat docker tailscale git; do command -v "$t" >/dev/null && printf "  %-10s ok\n" "$t" || printf "  %-10s MISSING (sudo apt install %s)\n" "$t" "$t"; done

sleep 1.5
IP="$(tailscale ip -4 2>/dev/null | head -1 || echo 127.0.0.1)"
PORT="$(node -e "console.log(require('./lib/settings').get().port)")"
log "status"
systemctl --user --no-pager status beast-dash.service | head -5 || true
printf '\n\033[1;32mBeast Dash: http://%s:%s\033[0m   (also http://%s:%s if MagicDNS works)\n\n' "$IP" "$PORT" "$(tailscale status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).Self.DNSName.replace(/\.$/,""))}catch{console.log("beast")}})')" "$PORT"
