#!/usr/bin/env bash
# beast-menubar.sh — xbar / SwiftBar plugin for the Mac menubar: how many Claude sessions need you, how many are
# working, today's API-equivalent cost. Click a line to open that session in chat.
#
# Install: brew install --cask swiftbar   (or xbar), then copy this file into the plugin folder as
#   beast.30s.sh   (the "30s" in the name is the refresh interval) and chmod +x it.
# Needs the beast reachable over Tailscale: https://<host>.<tailnet>.ts.net (or set BEAST_URL).
# <xbar.title>Beast Dash</xbar.title>
# <xbar.desc>Claude sessions that need you</xbar.desc>
URL="${BEAST_URL:-https://<host>.<tailnet>.ts.net}"
j="$(curl -s -m 4 "$URL/api/badge")" || { echo "✦ –"; echo "---"; echo "beast unreachable | color=red"; exit 0; }
need=$(echo "$j" | python3 -c 'import json,sys; print(json.load(sys.stdin)["need"])' 2>/dev/null || echo "?")
work=$(echo "$j" | python3 -c 'import json,sys; print(json.load(sys.stdin)["working"])' 2>/dev/null || echo "?")
cost=$(echo "$j" | python3 -c 'import json,sys; print("$%.0f" % json.load(sys.stdin)["today"])' 2>/dev/null || echo "")
if [ "$need" != "0" ]; then echo "✦ $need | color=#34d399"; else echo "✦ $work"; fi
echo "---"
echo "$need need you · $work working · $cost today"
echo "$j" | python3 -c '
import json,sys,urllib.parse
d=json.load(sys.stdin); u=sys.argv[1]
for s in d["needList"]:
    name=s.get("label") or s["name"].replace("claude-","")
    print("%s · %s | href=%s/?term=%s&mode=chat color=#34d399" % (name, s["state"], u, urllib.parse.quote(s["name"])))
    if s.get("msg"): print("  %s | size=11 color=gray" % s["msg"][:80])
if d.get("crashes"): print("▶ %d dev server(s) died | color=red href=%s/" % (d["crashes"], u))
' "$URL"
echo "---"
echo "Open Beast Dash | href=$URL/"
