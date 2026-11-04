#!/usr/bin/env bash
# gate.sh <port> — pre-merge check for this repo.
#   1. node --check on every .js
#   2. boots an isolated copy of the working tree (temp dir, own state/, BD_TEST=1: loopback only, no Anthropic
#      limits polling, no push, no scheduler, no auto-expose) on <port>
#   3. every API route must answer 200 + valid JSON (emu-screen: a PNG when a device is connected)
#   4. the page must load with every f-*.js / f-*.css stamped (?v=) and served
# Never touches the live dashboard (its port and state/). Exit code 0 = green.
set -u
PORT="${1:?usage: bin/gate.sh <port>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LIVE="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port||8787)}catch{console.log(8787)}' "$REPO/state/settings.json")"
[ "$PORT" = "$LIVE" ] && { echo "gate: $LIVE is the live dashboard — pick another port" >&2; exit 2; }
FAIL=0; fail() { echo "FAIL  $*"; FAIL=1; }; ok() { echo "ok    $*"; }

echo "== syntax"
while IFS= read -r f; do node --check "$f" 2>/tmp/gate-$$.err || { fail "node --check $f"; sed 's/^/      /' /tmp/gate-$$.err | head -5; }; done < <(cd "$REPO" && find server.js lib public bin test -name '*.js' -not -path '*/node_modules/*' | sed "s#^#$REPO/#")
[ $FAIL = 0 ] && ok "node --check"

echo "== unit tests"
if (cd "$REPO" && node --test test/*.test.js > /tmp/gate-$$.unit 2>&1); then ok "node --test ($(grep -c '^✔' /tmp/gate-$$.unit) passed)"; else fail "node --test"; grep -E '^✖|Error|expected|actual' /tmp/gate-$$.unit | head -20 | sed 's/^/      /'; fi

echo "== boot isolated copy on 127.0.0.1:$PORT"
TMP="$(mktemp -d /tmp/bd-gate-XXXX)"
(cd "$REPO" && tar --exclude=./state --exclude=./state-backups --exclude=./.git -cf - .) | (cd "$TMP" && tar -xf -)
mkdir -p "$TMP/state" && printf '{"port": %s, "autoExpose": false}\n' "$PORT" > "$TMP/state/settings.json"
cp "$REPO/state/claude-sessions.json" "$TMP/state/" 2>/dev/null   # read-only copy: lets /api/subagents resolve the live sessions' transcripts
PLANS="$TMP/plans-store"; cp -r "$TMP/test/fixtures/plans/store" "$PLANS"
(cd "$TMP" && BD_TEST=1 BEAST_PLANS_DIR="$PLANS" exec node server.js > "$TMP/server.log" 2>&1) & PID=$!
cleanup() { kill "$PID" 2>/dev/null; sleep 0.3; kill -9 "$PID" 2>/dev/null; rm -rf "$TMP"; rm -f /tmp/gate-$$.*; }
trap cleanup EXIT
B="http://127.0.0.1:$PORT"
for _ in $(seq 1 120); do curl -sf -m 2 "$B/api/version" >/dev/null 2>&1 && break; kill -0 $PID 2>/dev/null || break; sleep 0.5; done
if ! curl -sf -m 2 "$B/api/version" >/dev/null 2>&1; then fail "server did not come up"; tail -20 "$TMP/server.log" | sed 's/^/      /'; exit 1; fi
ok "server up (pid $PID)"

echo "== API"
get() { curl -s -m 30 -o /tmp/gate-$$.body -w '%{http_code} %{content_type}' "$B$1"; }
json() { # path [allowed-status…]
  local p="$1"; shift; local allowed="${*:-200}"; local r code; r="$(get "$p")"; code="${r%% *}"
  if ! [[ " $allowed " == *" $code "* ]]; then fail "GET $p -> $code $(head -c 200 /tmp/gate-$$.body)"; return 1; fi
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' /tmp/gate-$$.body 2>/dev/null || { fail "GET $p -> not JSON"; return 1; }
  ok "GET $p -> $code"
}
jq_() { node -e "const d=JSON.parse(require('fs').readFileSync('/tmp/gate-$$.body','utf8')); const r=($1); if (r != null) console.log(r)" 2>/dev/null; }
json /api/state; STATE="$(cat /tmp/gate-$$.body)"
GITP="$(printf '%s' "$STATE" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); const p=d.projects.find(p=>p.isGit); console.log(p?p.id:"")')"
CLS="$(printf '%s' "$STATE" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log((d.runtime.sessions.find(s=>s.claude&&s.name.startsWith("claude-"))||{}).name||"")')"
json /api/plans
PL="$(jq_ 'Object.entries(d).map(([k,v])=>k+"\t"+v[0].topic)[0]')"
if [ -n "$PL" ]; then json "/api/plan/${PL%%$'\t'*}?topic=${PL#*$'\t'}"; else ok "no plans to open (none found)"; fi
json "/api/plans?v=2"
[ "$(jq_ 'd.plans.some(p=>p.id==="demo-app/search-v2"&&p.repoDir==="demo-app"&&Array.isArray(p.sessions))&&typeof d.legacy==="object"')" = true ] && ok "plans v2 summary lists the fixture plan" || fail "plans v2 summary shape"
json "/api/plan/demo-app/search-v2"
[ "$(jq_ 'd.id==="demo-app/search-v2"&&d.phases.length>0&&Array.isArray(d.timeline)')" = true ] && ok "plans v2 detail shape" || fail "plans v2 detail shape"
ARCH="$(ls "$PLANS/demo-app/_archive" | head -1)"
json "/api/plan/demo-app/_archive/$ARCH"
json "/api/plan/demo-app/nope" 404
for bad in "demo-app/%2e%2e" "%2e%2e/%2e%2e/etc" "demo-app/..%2f..%2f..%2fetc" "%2e%2e%2f%2e%2e/x" "demo-app/search-v2/../x/y/z"; do
  r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$B/api/plan/$bad")"; [ "$r" = 404 ] && ok "plan traversal $bad -> 404" || fail "plan traversal $bad -> $r"
done
r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' --path-as-is "$B/api/plan/../../../etc/passwd")"; [[ "$r" == 4* ]] && ok "plan raw traversal -> $r" || fail "plan raw traversal -> $r"
curl -s -N -m 4 "$B/api/events" > /tmp/gate-$$.sse 2>/dev/null & SSEPID=$!
sleep 1; printf '\n' >> "$PLANS/demo-app/search-v2/events.jsonl"; wait $SSEPID 2>/dev/null
grep -q 'event: plan' /tmp/gate-$$.sse && grep -q '"id":"demo-app/search-v2"' /tmp/gate-$$.sse && ok "SSE event: plan after a plan change" || fail "no plan event on /api/events"
pa() { local d="$1"; shift; curl -s -m 15 -o /tmp/gate-$$.body -w '%{http_code}' -X POST -H 'content-type: application/json' "$@" -d "$d" "$B/api/plan-answer"; }
for c in '404 {"id":"demo-app/nope","q":"q1","text":"x"}' '404 {"id":"../../etc","q":"q1","text":"x"}' '404 {"id":5,"q":"q1","text":"x"}' \
         "400 {\"id\":\"demo-app/_archive/$ARCH\",\"q\":\"q1\",\"text\":\"x\"}" '409 {"id":"demo-app/search-v2","q":"1;rm","text":"x"}' \
         '400 {"id":"demo-app/search-v2","q":"q1","text":"a\nb"}' '400 {"id":"demo-app/search-v2","q":"q1","text":"  "}' '409 {"id":"demo-app/search-v2","q":"q99","text":"x"}'; do
  want="${c%% *}"; r="$(pa "${c#* }")"; [ "$r" = "$want" ] && ok "POST plan-answer ${c#* } -> $r" || fail "POST plan-answer ${c#* } -> $r (want $want) $(head -c 200 /tmp/gate-$$.body)"
done
for h in "Origin: https://evil.example" "Sec-Fetch-Site: cross-site"; do
  r="$(pa '{"id":"demo-app/search-v2","q":"q1","text":"x"}' -H "$h")"; [ "$r" = 403 ] && ok "POST plan-answer with $h -> 403" || fail "POST plan-answer with $h -> $r"
done
r="$(pa '{"id":"demo-app/search-v2","q":"q1","text":"--plan=x copy them"}' -H "Origin: $B")"
if [ "$r" = 200 ] && [ "$(jq_ 'd.ok===true&&d.id==="demo-app/search-v2"')" = true ] && tail -1 "$PLANS/demo-app/search-v2/events.jsonl" | grep -q '"type":"answer","q":"q1","text":"--plan=x copy them"'; then ok "POST plan-answer records the answer through bin/plan"; else fail "POST plan-answer -> $r $(head -c 200 /tmp/gate-$$.body)"; fi
r="$(pa '{"id":"demo-app/search-v2","q":"q1","text":"again"}')"; [ "$r" = 409 ] && [ "$(jq_ 'd.error')" = "no open question q1" ] && ok "POST plan-answer twice -> 409 no open question" || fail "POST plan-answer twice -> $r $(head -c 200 /tmp/gate-$$.body)"
pl() { local ep="$1" d="$2"; shift 2; curl -s -m 15 -o /tmp/gate-$$.body -w '%{http_code}' -X POST -H 'content-type: application/json' "$@" -d "$d" "$B/api/plan-$ep"; }
for ep in finish archive restore; do
  for d in '{"id":"demo-docs/nope"}' '{"id":"../../etc"}' '{"id":5}' '{}'; do
    r="$(pl "$ep" "$d")"; [ "$r" = 404 ] && ok "POST plan-$ep $d -> 404" || fail "POST plan-$ep $d -> $r $(head -c 200 /tmp/gate-$$.body)"
  done
  wrong='{"id":"demo-docs/release-notes"}'; right="{\"id\":\"demo-app/_archive/$ARCH\"}"
  [ "$ep" = restore ] || { wrong="$right"; right='{"id":"demo-docs/release-notes"}'; }
  r="$(pl "$ep" "$wrong")"; [ "$r" = 400 ] && ok "POST plan-$ep $wrong -> 400" || fail "POST plan-$ep $wrong -> $r $(head -c 200 /tmp/gate-$$.body)"
  for h in "Origin: https://evil.example" "Sec-Fetch-Site: cross-site"; do
    r="$(pl "$ep" "$right" -H "$h")"; [ "$r" = 403 ] && ok "POST plan-$ep with $h -> 403" || fail "POST plan-$ep with $h -> $r"
  done
done
json /api/plan/demo-docs/release-notes
[ "$(jq_ 'd.finished===true&&d.status==="finished"&&!("changed" in d)&&!("autoArchiveAt" in d)')" = true ] && ok "finished plan has no auto-archive fields" || fail "finished plan fields"
for i in 1 2; do
  r="$(pl finish '{"id":"demo-docs/old-cleanup"}' -H "Origin: $B")"
  [ "$r" = 200 ] && [ "$(jq_ 'd.ok===true&&d.id==="demo-docs/old-cleanup"')" = true ] && grep -q '^status: finished$' "$PLANS/demo-docs/old-cleanup/plan.md" && ok "POST plan-finish run $i -> finished" || fail "POST plan-finish run $i -> $r $(head -c 200 /tmp/gate-$$.body)"
done
r="$(pl archive '{"id":"demo-docs/release-notes"}' -H "Origin: $B")"
FOLDER="$(jq_ 'd.id.split("/").pop()')"
[ "$r" = 200 ] && [ "$(jq_ 'd.id.startsWith("demo-docs/_archive/")')" = true ] && [ -f "$PLANS/demo-docs/_archive/$FOLDER/plan.md" ] && [ ! -e "$PLANS/demo-docs/release-notes" ] && ok "POST plan-archive -> $FOLDER" || fail "POST plan-archive -> $r $(head -c 200 /tmp/gate-$$.body)"
cp -r "$PLANS/demo-docs/_archive/$FOLDER" "$PLANS/demo-docs/release-notes"
r="$(pl restore "{\"id\":\"demo-docs/_archive/$FOLDER\"}" -H "Origin: $B")"; [ "$r" = 409 ] && ok "POST plan-restore on a taken topic -> 409" || fail "POST plan-restore on a taken topic -> $r $(head -c 200 /tmp/gate-$$.body)"
rm -rf "$PLANS/demo-docs/release-notes"
r="$(pl restore "{\"id\":\"demo-docs/_archive/$FOLDER\"}" -H "Origin: $B")"
[ "$r" = 200 ] && [ "$(jq_ 'd.ok===true&&d.id==="demo-docs/release-notes"')" = true ] && grep -q '^status: finished$' "$PLANS/demo-docs/release-notes/plan.md" && [ ! -e "$PLANS/demo-docs/_archive/$FOLDER" ] && ok "POST plan-restore -> finished again" || fail "POST plan-restore -> $r $(head -c 200 /tmp/gate-$$.body)"
json /api/worktrees
[ -n "$GITP" ] && json "/api/worktrees/$GITP"
json "/api/usage/models?days=7"
if [ -n "$CLS" ]; then json "/api/subagents/$CLS" 200 404; else ok "no claude session for /api/subagents"; fi
json "/api/history-last?id=gate-nope" 404
json /api/emu
SERIAL="$(jq_ '(d.devices.find(x=>x.state==="device")||{}).serial')"
if [ -n "$SERIAL" ]; then
  r="$(get "/api/emu-screen?serial=$SERIAL")"
  if [[ "$r" == "200 image/png"* ]] && head -c 4 /tmp/gate-$$.body | grep -q PNG; then ok "GET /api/emu-screen -> PNG"; else fail "GET /api/emu-screen -> $r"; fi
else ok "no adb device for /api/emu-screen"; fi
r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"nope","path":"/"}' "$B/api/worktree-remove")"
[ "$r" = 404 ] && ok "POST worktree-remove unknown project -> 404" || fail "POST worktree-remove unknown project -> $r"
r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"serial":"bad serial;rm"}' "$B/api/emu-input")"
[ "$r" = 400 ] && ok "POST emu-input bad serial -> 400" || fail "POST emu-input bad serial -> $r"
r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"session":"claude-gate-nope","to":"chat"}' "$B/api/claude-switch")"
[ "$r" = 404 ] && ok "POST claude-switch unknown session -> 404" || fail "POST claude-switch unknown session -> $r"
r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"session":"claude-gate-nope","target":{"kind":"root"}}' "$B/api/chat-move")"
[ "$r" = 404 ] && ok "POST chat-move unknown session -> 404" || fail "POST chat-move unknown session -> $r"
r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"gate-tab-1","session":"claude-gate-nope"}' "$B/api/watching")"
r2="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"gate-tab-1","session":"../x"}' "$B/api/watching")"
[ "$r $r2" = "200 400" ] && ok "POST watching -> 200, bad session -> 400" || fail "POST watching -> $r, bad session -> $r2"
hlpost() { curl -s -m 5 -o /tmp/gate-$$.body -w '%{http_code}' -X POST -H 'content-type: application/json' -d "$2" "$B/api/$1"; }
r="$(hlpost hl-shell '{"session":"claude-gate-nope","cmd":"echo hi"}')"
[ "$r" = 400 ] && grep -q 'run in the terminal for terminal sessions' /tmp/gate-$$.body && ok "POST hl-shell non-chat session -> 400" || fail "POST hl-shell non-chat session -> $r $(head -c 200 /tmp/gate-$$.body)"
r="$(hlpost hl-shell '{"session":"claude-gate-nope","cmd":"   "}') $(hlpost hl-shell '{"session":"claude-gate-nope"}') $(hlpost hl-shell-stop '{"session":"claude-gate-nope","id":"../x"}') $(hlpost hl-shell-drop '{"session":"claude-gate-nope","id":5}')"
[ "$r" = "400 400 400 400" ] && ok "POST hl-shell / -stop / -drop bad input -> 400" || fail "POST hl-shell bad input -> $r"
r="$(hlpost hl-shell-stop '{"session":"claude-gate-nope","id":"s-1"}') $(hlpost hl-shell-drop '{"session":"claude-gate-nope","id":"s-1"}')"
[ "$r" = "400 400" ] && ok "POST hl-shell-stop / -drop non-chat session -> 400" || fail "POST hl-shell-stop / -drop non-chat session -> $r"

echo "== guards"
post403() { local r; r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' "$@" -d '{"id":"nope"}' "$B/api/worktree-prune")"; [ "$r" = 403 ]; }
post403 -H "Origin: http://127.0.0.1:5173" && ok "POST from another port's Origin -> 403" || fail "POST from another port's Origin not blocked"
post403 -H "Sec-Fetch-Site: same-site" && ok "POST with Sec-Fetch-Site same-site -> 403" || fail "same-site POST not blocked"
post403 -H "Origin: https://evil.example" && ok "POST from a foreign Origin -> 403" || fail "foreign Origin POST not blocked"
r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "Origin: http://127.0.0.1:$PORT" -H 'Sec-Fetch-Site: same-origin' -d '{"id":"nope"}' "$B/api/worktree-prune")"
[ "$r" = 404 ] && ok "same-origin POST passes the guard (404 unknown project)" || fail "same-origin POST -> $r"
r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "Origin: http://127.0.0.1:$PORT" -d '{"org":"..","name":"x"}' "$B/api/project-new")"
[ "$r" = 400 ] && ok "POST project-new bad org -> 400" || fail "POST project-new bad org -> $r"
for h in "Sec-Fetch-Site: cross-site" "Origin: https://evil.example"; do
  r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "$h" -d '{"session":"claude-gate-nope","cmd":"id"}' "$B/api/hl-shell")"
  [ "$r" = 403 ] && ok "POST hl-shell with $h -> 403" || fail "POST hl-shell with $h -> $r"; done
for ep in kill unexpose; do r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "Origin: $B" -d '{"pid":1}' "$B/api/$ep")"
  [ "$r" = 403 ] && ok "POST $ep of an unlisted pid -> 403" || fail "POST $ep of an unlisted pid -> $r"; done
r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: http://127.0.0.1:7681" -H 'Sec-Fetch-Site: same-site' "$B/api/paste-image")"
[ "$r" = 204 ] && ok "terminal (:7681) preflight to paste-image still allowed" || fail "paste-image from :7681 -> $r"

echo "== page"
curl -s -m 5 "$B/" > /tmp/gate-$$.html
for f in $(cd "$TMP/public" && ls f-*.js f-*.css 2>/dev/null); do
  grep -q "/${f}?v=" /tmp/gate-$$.html || fail "$f not stamped in index.html"
  c="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$B/$f")"; [ "$c" = 200 ] || fail "GET /$f -> $c"
done
grep -q 'src="/app.js?v=' /tmp/gate-$$.html && ok "page stamped, feature files served" || fail "app.js not stamped"
grep -q 'id="feat-home"' /tmp/gate-$$.html || fail "#feat-home missing"
grep -qE '(src|href)="(https?:)?//' /tmp/gate-$$.html && fail "index.html references a cross-origin URL" || ok "index.html is self-contained"
FONTCSS="$(grep -oE 'href="/vendor/plex-[^"]+\.css"' /tmp/gate-$$.html | head -1 | cut -d'"' -f2)"
FONTS="$(curl -s -m 5 "$B$FONTCSS" | grep -oE '/vendor/fonts/[^)]+\.woff2' | sort -u)"
[ -n "$FONTS" ] || fail "no self-hosted fonts in ${FONTCSS:-the font stylesheet}"
for f in $FONTS; do r="$(curl -s -m 5 -o /dev/null -w '%{http_code} %{content_type}' "$B$f")"; [ "$r" = "200 font/woff2" ] || fail "GET $f -> $r"; done
[ -n "$FONTS" ] && ok "fonts served same-origin ($(echo "$FONTS" | wc -l) woff2)"
shell() { curl -s -m 5 -D - -o /dev/null "$B/" | tr -d '\r' | grep -i '^x-bd-shell:' | cut -d' ' -f2; }
json /api/version
[ "$(jq_ 'd.deviceCache')" = true ] && [ -z "$(shell)" ] && ok "device cache on by default (no x-bd-shell)" || fail "device cache default: deviceCache=$(jq_ 'd.deviceCache') x-bd-shell=$(shell)"
cp "$TMP/state/settings.json" "$TMP/settings.keep"
node -e 'const f=process.argv[1],fs=require("fs");const s=JSON.parse(fs.readFileSync(f,"utf8"));s.deviceCache=false;fs.writeFileSync(f,JSON.stringify(s))' "$TMP/state/settings.json"
json /api/version
[ "$(jq_ 'd.deviceCache')" = false ] && [ "$(shell)" = off ] && ok "deviceCache:false in settings.json -> x-bd-shell: off + /api/version, no restart" || fail "deviceCache:false: deviceCache=$(jq_ 'd.deviceCache') x-bd-shell=$(shell)"
r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"sleepButton":false}' "$B/api/settings")"
json /api/version
[ "$r" = 200 ] && [ "$(jq_ 'd.deviceCache')" = false ] && [ "$(shell)" = off ] && ok "hand-set deviceCache:false survives POST /api/settings" || fail "deviceCache:false after POST /api/settings ($r): deviceCache=$(jq_ 'd.deviceCache') x-bd-shell=$(shell)"
cp "$TMP/settings.keep" "$TMP/state/settings.json"

if grep -qiE 'TypeError|ReferenceError|SyntaxError|UnhandledPromise' "$TMP/server.log"; then fail "errors in server log:"; grep -iE 'TypeError|ReferenceError|SyntaxError|UnhandledPromise' "$TMP/server.log" | head -5 | sed 's/^/      /'; fi
echo
[ $FAIL = 0 ] && echo "GATE GREEN" || echo "GATE RED"
exit $FAIL
