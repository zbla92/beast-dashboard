#!/bin/sh
input=$(cat)
case "$input" in
  *.pasted*) printf '%s' "$input" | node "$(dirname "$0")/pasted-guard.js"; exit $? ;;
esac
exit 0
