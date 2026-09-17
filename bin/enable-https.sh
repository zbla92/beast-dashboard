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
if [ "${1:-}" = "off" ]; then sudo tailscale serve reset; echo "serve config removed"; exit 0; fi
echo "==> checking HTTPS certificates for $name"
if ! sudo tailscale cert --cert-file /tmp/bd-cert-test.crt --key-file /tmp/bd-cert-test.key "$name" >/dev/null 2>&1; then
  echo "HTTPS certificates are not enabled for this tailnet."
  echo "Enable them once at https://login.tailscale.com/admin/dns (HTTPS Certificates -> Enable HTTPS), then re-run."
  exit 1
fi
sudo rm -f /tmp/bd-cert-test.crt /tmp/bd-cert-test.key
echo "==> tailscale serve: / -> dashboard, /term -> terminal"
# serve strips the mount path and prepends the target's path, and routes by Host header (the MagicDNS name)
sudo tailscale serve --bg --https=443 --set-path / http://127.0.0.1:8787 >/dev/null
sudo tailscale serve --bg --https=443 --set-path /term http://127.0.0.1:7681/term >/dev/null
sudo tailscale serve status
printf '\n\033[1;32mhttps://%s/\033[0m  (open this on the phone + Mac; then Settings -> Push -> Enable on this device)\n' "$name"
