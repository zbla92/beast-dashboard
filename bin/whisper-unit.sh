#!/bin/bash
set -e
cd "$(dirname "$0")/.."
REPO=$(pwd)
if [ "$(uname)" = Darwin ]; then
  # macOS: a launchd agent, loaded but not started (lib/whisper.js kickstarts it when the mic is pressed)
  PLIST="$HOME/Library/LaunchAgents/com.beastdash.whisper.plist"
  if [ -x whisper/.venv/bin/python ]; then
    mkdir -p "$(dirname "$PLIST")" "$HOME/Library/Logs/beast-dash"
    sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" mac/launchd/com.beastdash.whisper.plist > "$PLIST"
    mac/agent.sh load com.beastdash.whisper "$PLIST"
  elif grep -qsF "<string>$REPO/whisper/run.sh</string>" "$PLIST"; then
    mac/agent.sh unload com.beastdash.whisper
  fi
  exit 0
fi
UNIT="$HOME/.config/systemd/user/beast-whisper.service"
if [ -x whisper/.venv/bin/python ]; then
  mkdir -p "$(dirname "$UNIT")"
  sed -e "s#__REPO__#$REPO#g" beast-whisper.service > "$UNIT"
elif grep -qsxF "ExecStart=$REPO/whisper/run.sh" "$UNIT"; then
  systemctl --user stop beast-whisper 2>/dev/null || true
  systemctl --user reset-failed beast-whisper 2>/dev/null || true
  rm -f "$UNIT"
fi
