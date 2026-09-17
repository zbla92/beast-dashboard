#!/usr/bin/env bash
# term.sh — ttyd entrypoint. Arg = tmux session name to attach, or "shell" for a fresh bash in ~/dev.
# Validates the name so only tmux sessions can be targeted (this is reachable from the whole tailnet).
name="${1:-shell}"
export TERM=xterm-256color
if [ "$name" = "shell" ]; then cd "$HOME/dev" && exec bash -l; fi
if ! [[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]]; then echo "bad session name"; sleep 2; exit 1; fi
if ! tmux has-session -t "=$name" 2>/dev/null; then echo "tmux session '$name' does not exist (anymore)."; echo "Sessions:"; tmux ls 2>/dev/null; sleep 5; exit 1; fi
exec tmux attach -t "=$name"
