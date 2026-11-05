#!/bin/bash
set -e
cd "$(dirname "$0")/.."
REPO=$(pwd)
UNIT="$HOME/.config/systemd/user/beast-whisper.service"
if [ -x whisper/.venv/bin/python ]; then
  mkdir -p "$(dirname "$UNIT")"
  sed -e "s#__REPO__#$REPO#g" beast-whisper.service > "$UNIT"
elif grep -qsxF "ExecStart=$REPO/whisper/run.sh" "$UNIT"; then
  systemctl --user stop beast-whisper 2>/dev/null || true
  systemctl --user reset-failed beast-whisper 2>/dev/null || true
  rm -f "$UNIT"
fi
