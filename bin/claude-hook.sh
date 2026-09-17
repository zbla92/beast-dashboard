#!/usr/bin/env bash
# claude-hook.sh — Claude Code hook -> Beast Dash.
#
# Wired into ~/.claude/settings.json and ~/.claude-company/settings.json (hooks: SessionStart, UserPromptSubmit,
# PreToolUse, PermissionRequest, Notification, Stop, StopFailure, SessionEnd) as an async command hook, so it never
# blocks Claude. It forwards the event JSON from stdin to the dashboard, tagged with the tmux session it runs in
# (that is how the dashboard knows which card to update) and the account (CLAUDE_CONFIG_DIR => company).
#
# Fire-and-forget: if the dashboard is down, curl fails silently and Claude never notices.
port="${BEAST_DASH_PORT:-8787}"
sess=""
[ -n "$TMUX_PANE" ] && sess=$(tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null)
[ -n "$sess" ] || exit 0                          # not in tmux -> nothing on the dashboard to update
acct=personal; case "$CLAUDE_CONFIG_DIR" in *claude-company*) acct=company;; esac
ts=$(date +%s%3N)
# Big tool inputs (a Write of a whole file) are useless to the dashboard: clip every string to 400 chars.
if command -v jq >/dev/null 2>&1; then
  payload=$(jq -c 'walk(if type=="string" and length>400 then .[0:400]+"…" else . end)' 2>/dev/null)
  [ -n "$payload" ] || payload='{}'
else
  payload=$(head -c 200000)
fi
printf '%s' "$payload" | curl -s -m 3 -o /dev/null -X POST "http://127.0.0.1:${port}/api/hook" \
  -H 'content-type: application/json' -H "x-tmux-session: $sess" -H "x-claude-account: $acct" -H "x-ts: $ts" \
  --data-binary @- >/dev/null 2>&1
exit 0
