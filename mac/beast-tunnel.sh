#!/usr/bin/env bash
# beast-tunnel.sh — OPTIONAL laptop-side SSH tunnel helper (macOS / Linux).
#
# Normally you don't need this: Tailscale gives you direct access and Beast Dash
# exposes loopback-only ports on the tailscale IP via socat. Use this only when a
# service must appear as "localhost" on the laptop (cookies, CORS, OAuth redirects…).
#
# Usage:  beast-tunnel.sh            # forwards every port currently in use by your projects
#         beast-tunnel.sh 5173 3001  # forwards only these ports
#         beast-tunnel.sh --watch    # re-syncs the port list every 20s, auto-reconnects on wifi change
# Env:    BEAST_HOST (ssh alias of the server, default "myserver")  BEAST_DASH_PORT (default 8787)
set -uo pipefail
HOST="${BEAST_HOST:-myserver}"; DASH="${BEAST_DASH_PORT:-8787}"
WATCH=0; PORTS=()
for a in "$@"; do case "$a" in --watch) WATCH=1;; *) PORTS+=("$a");; esac; done

fetch_ports() {
  # ask the dashboard which ports project processes/containers are listening on
  ssh -o ConnectTimeout=5 "$HOST" "curl -s http://127.0.0.1:$DASH/api/state" 2>/dev/null \
    | python3 -c '
import json,sys
try: s=json.load(sys.stdin)
except Exception: sys.exit(0)
rt=s["runtime"]; ports=set()
for x in rt["sessions"]+rt["external"]:
    for p in x["ports"]:
        if not p.get("ephemeral"): ports.add(p["port"])
for c in rt["containers"]:
    if c["state"]=="running":
        for p in c["ports"]:
            if p.get("host"): ports.add(p["host"])
print(" ".join(str(p) for p in sorted(ports)))'
}

run_tunnel() {
  local ports=("$@"); [ ${#ports[@]} -gt 0 ] || { echo "no ports to forward"; return 1; }
  local args=()
  for p in "${ports[@]}"; do args+=(-L "$p:127.0.0.1:$p"); done
  echo "→ tunnel via $HOST: ${ports[*]}   (Ctrl-C to stop)"
  ssh -N -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=no -o ConnectTimeout=8 "${args[@]}" "$HOST"
}

if [ $WATCH -eq 0 ]; then
  [ ${#PORTS[@]} -gt 0 ] || read -r -a PORTS <<< "$(fetch_ports)"
  run_tunnel "${PORTS[@]}"; exit $?
fi

# --watch: keep a tunnel up; restart it when the port set changes or the connection drops (wifi switch)
CUR=""; PID=""
trap '[ -n "$PID" ] && kill "$PID" 2>/dev/null; exit 0' INT TERM
while true; do
  if [ ${#PORTS[@]} -gt 0 ]; then NEW="${PORTS[*]}"; else NEW="$(fetch_ports)"; fi
  if [ -n "$NEW" ] && { [ "$NEW" != "$CUR" ] || [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; }; then
    [ -n "$PID" ] && kill "$PID" 2>/dev/null
    CUR="$NEW"; read -r -a arr <<< "$CUR"
    run_tunnel "${arr[@]}" & PID=$!
  fi
  sleep 20
done
