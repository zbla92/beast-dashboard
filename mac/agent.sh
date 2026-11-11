#!/usr/bin/env bash
# agent.sh — load / unload one Beast Dash launchd agent in this user's GUI domain.
#   mac/agent.sh load <label> <plist>    (re)load: bootout if loaded, wait until it's gone, bootstrap
#   mac/agent.sh unload <label>          bootout and delete ~/Library/LaunchAgents/<label>.plist
set -euo pipefail
domain="gui/$(id -u)"
wait_gone() { for _ in $(seq 1 50); do launchctl print "$domain/$1" >/dev/null 2>&1 || return 0; sleep 0.1; done; }
case "${1:-}" in
  load)
    plutil -lint -s "$3" || { echo "bad plist: $3"; exit 1; }
    launchctl bootout "$domain/$2" 2>/dev/null || true; wait_gone "$2"
    launchctl bootstrap "$domain" "$3" ;;
  unload)
    launchctl bootout "$domain/$2" 2>/dev/null || true; wait_gone "$2"
    rm -f "$HOME/Library/LaunchAgents/$2.plist" ;;
  *) echo "usage: $0 load <label> <plist> | unload <label>"; exit 2 ;;
esac
