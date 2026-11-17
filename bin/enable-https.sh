#!/usr/bin/env bash
# enable-https.sh — serve the dashboard AND the terminal on one HTTPS origin via `tailscale serve`:
#
#   https://<host>.<tailnet>.ts.net/        -> 127.0.0.1:8787   (dashboard)
#   https://<host>.<tailnet>.ts.net/term/   -> 127.0.0.1:7681/term (ttyd, --base-path /term)
#
# Why: service workers (push notifications, "Install app" on Android) need a secure origin; the clipboard API
# needs one; and with the terminal on the SAME origin the dashboard can talk to the iframe directly (mobile
# keyboard fit, paste-image without CORS). Tailnet-only — tailscale serve is not Funnel, nothing is public.
#
# ONE-TIME PREREQUISITE (admin console, can't be scripted): https://login.tailscale.com/admin/dns
#   -> "HTTPS Certificates" -> Enable HTTPS. Until then `tailscale cert` answers
#   "your Tailscale account does not support getting TLS certs" and this script stops.
#
# Usage: ./bin/enable-https.sh          # set up (idempotent)
#        ./bin/enable-https.sh off      # remove the serve config again
set -euo pipefail
name="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
# macOS: the Tailscale app's CLI needs no sudo, and 443 often serves another app on a Mac already, so the dashboard
# gets its own port (BD_HTTPS_PORT, default 8443) and `off` removes only that port, never the whole serve config.
S=sudo; PORT=443
if [ "$(uname)" = Darwin ]; then S=; PORT="${BD_HTTPS_PORT:-8443}"; fi
if [ "${1:-}" = "off" ]; then
  if [ "$(uname)" = Darwin ]; then tailscale serve --https="$PORT" --set-path /term off || true; tailscale serve --https="$PORT" off; else sudo tailscale serve reset; fi
  echo "serve config removed"; exit 0
fi
if [ "$(uname)" = Darwin ]; then
  taken="$(tailscale serve status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); p=d.get("Web",{}).get(sys.argv[1],{}).get("Handlers",{}).get("/",{}).get("Proxy",""); print("" if p in ("","http://127.0.0.1:8787") else p)' "$name:$PORT")"
  [ -z "$taken" ] || { echo "https port $PORT already serves $taken — pick another: BD_HTTPS_PORT=<port> $0"; exit 1; }
else
  echo "==> checking HTTPS certificates for $name"
  certdir="$(mktemp -d)"; trap 'sudo rm -rf "$certdir"' EXIT
  if ! sudo tailscale cert --cert-file "$certdir/test.crt" --key-file "$certdir/test.key" "$name" >/dev/null 2>&1; then
    echo "HTTPS certificates are not enabled for this tailnet."
    echo "Enable them once at https://login.tailscale.com/admin/dns (HTTPS Certificates -> Enable HTTPS), then re-run."
    exit 1
  fi
fi
echo "==> tailscale serve: / -> dashboard, /term -> terminal"
# serve strips the mount path and prepends the target's path, and routes by Host header (the MagicDNS name)
$S tailscale serve --bg --https="$PORT" --set-path / http://127.0.0.1:8787 >/dev/null
$S tailscale serve --bg --https="$PORT" --set-path /term http://127.0.0.1:7681/term >/dev/null
$S tailscale serve status
url="https://$name/"; [ "$PORT" = 443 ] || url="https://$name:$PORT/"
printf '\n\033[1;32m%s\033[0m  (open this on the phone + Mac; then Settings -> Push -> Enable on this device)\n' "$url"
