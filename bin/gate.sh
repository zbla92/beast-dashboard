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
(cd "$REPO" && tar --exclude=./state --exclude=./state-backups --exclude=./.git --exclude=./whisper/.venv -cf - .) | (cd "$TMP" && tar -xf -)
mkdir -p "$TMP/state" && printf '{"port": %s, "autoExpose": false}\n' "$PORT" > "$TMP/state/settings.json"
cp "$REPO/state/claude-sessions.json" "$TMP/state/" 2>/dev/null   # read-only copy: lets /api/subagents resolve the live sessions' transcripts
PLANS="$TMP/plans-store"; cp -r "$TMP/test/fixtures/plans/store" "$PLANS"
(cd "$TMP" && BD_TEST=1 BEAST_PLANS_DIR="$PLANS" BD_SPECIALISTS_DIR="$TMP/specialists" exec node server.js > "$TMP/server.log" 2>&1) & PID=$!
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
for ep in step complete; do
  for d in '{"id":"demo-docs/nope"}' '{"id":"../../etc"}' '{"id":5}' '{}'; do
    r="$(pl "$ep" "$d")"; [ "$r" = 404 ] && ok "POST plan-$ep $d -> 404" || fail "POST plan-$ep $d -> $r $(head -c 200 /tmp/gate-$$.body)"
  done
  d="{\"id\":\"demo-app/_archive/$ARCH\",\"task\":\"T1\",\"done\":true}"
  r="$(pl "$ep" "$d")"; [ "$r" = 400 ] && ok "POST plan-$ep archived id -> 400" || fail "POST plan-$ep archived id -> $r $(head -c 200 /tmp/gate-$$.body)"
  for h in "Origin: https://evil.example" "Sec-Fetch-Site: cross-site"; do
    r="$(pl "$ep" '{"id":"demo-docs/style-guide","task":"T1","done":true}' -H "$h")"; [ "$r" = 403 ] && ok "POST plan-$ep with $h -> 403" || fail "POST plan-$ep with $h -> $r"
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
for c in '409 {"id":"demo-docs/release-notes","task":"T99","done":true}' '409 {"id":"demo-docs/release-notes","task":"1;rm","done":true}' '400 {"id":"demo-docs/release-notes","task":"T1","done":"yes"}'; do
  want="${c%% *}"; r="$(pl step "${c#* }")"; [ "$r" = "$want" ] && ok "POST plan-step ${c#* } -> $r" || fail "POST plan-step ${c#* } -> $r (want $want) $(head -c 200 /tmp/gate-$$.body)"
done
r="$(pl step '{"id":"demo-docs/release-notes","task":"T1","done":false}' -H "Origin: $B")"
[ "$r" = 200 ] && grep -q '^status: active$' "$PLANS/demo-docs/release-notes/plan.md" && grep -q '^- \[ \] T1 ' "$PLANS/demo-docs/release-notes/plan.md" && ok "POST plan-step untick -> open, plan active" || fail "POST plan-step untick -> $r $(head -c 200 /tmp/gate-$$.body)"
r="$(pl step '{"id":"demo-docs/release-notes","task":"T1","done":true}' -H "Origin: $B")"
[ "$r" = 200 ] && grep -q '^status: finished$' "$PLANS/demo-docs/release-notes/plan.md" && ok "POST plan-step tick -> done, plan finished" || fail "POST plan-step tick -> $r $(head -c 200 /tmp/gate-$$.body)"
r="$(pl complete '{"id":"demo-docs/release-notes"}' -H "Origin: $B")"
[ "$r" = 200 ] && [ "$(jq_ 'd.id.startsWith("demo-docs/_archive/")')" = true ] && [ ! -e "$PLANS/demo-docs/release-notes" ] && ok "POST plan-complete -> archived" || fail "POST plan-complete -> $r $(head -c 200 /tmp/gate-$$.body)"
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
r=""; for d in '{"text":"x","cwd":"/etc"}' '{"text":"x","cwd":"relative/dir"}' '{"text":"x","cwd":"/nope/gate-gone"}' '{"empty":true,"cwd":7}'; do r="$r $(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "$d" "$B/api/chat-new")"; done
[ "$r" = " 400 400 400 400" ] && ok "POST chat-new with a cwd outside the dev folder -> 400" || fail "POST chat-new bad cwd ->$r"
out="$(cd / && BEAST_DASH_PORT="$PORT" "$TMP/bin/bd-chat" new --cwd /etc 'gate' 2>&1)"; rc=$?
[ $rc = 1 ] && [[ "$out" == *"inside the dev folder"* ]] && ok "bd-chat new outside the dev folder -> refused by the dashboard" || fail "bd-chat new /etc -> rc=$rc $out"
sp() { local p="$1" d="$2"; shift 2; curl -s -m 10 -o /tmp/gate-$$.body -w '%{http_code}' -X POST -H 'content-type: application/json' "$@" -d "$d" "$B/api/$p"; }
r="$(get /api/specialists)"
[[ "$r" == "200 application/json"* ]] && node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(j.ok&&Array.isArray(j.specialists)&&j.specialists.length===0&&j.templates.some(t=>t.id==="writer")?0:1)' /tmp/gate-$$.body && ok "GET specialists -> empty list with templates" || fail "GET specialists -> $r $(head -c 200 /tmp/gate-$$.body)"
r="$(sp specialist '{"name":"gate-writer","template":"writer","model":"haiku"}')"
[ "$r" = 201 ] && grep -q '"name":"gate-writer"' /tmp/gate-$$.body && ok "POST specialist create -> 201" || fail "POST specialist create -> $r $(head -c 200 /tmp/gate-$$.body)"
UPD="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).specialist.updatedAt)' /tmp/gate-$$.body 2>/dev/null)"
r="$(sp specialist '{"name":"gate-writer"}') $(sp specialist '{"name":"Bad Name"}') $(sp specialist '{"name":"run"}') $(sp specialist '{"name":"gate-x","template":"nope"}')"
[ "$r" = "409 400 400 400" ] && ok "POST specialist duplicate -> 409, bad name / reserved / unknown template -> 400" || fail "POST specialist bad create -> $r"
r="$(get /api/specialist/gate-writer)"
[[ "$r" == "200 application/json"* ]] && grep -q '"instructions":' /tmp/gate-$$.body && ok "GET specialist/<name> -> profile with instructions" || fail "GET specialist/<name> -> $r"
r="$(sp specialist/gate-writer "{\"title\":\"Gate\",\"ifUpdatedAt\":\"$UPD\"}") $(sp specialist/gate-writer "{\"title\":\"Again\",\"ifUpdatedAt\":\"$UPD\"}") $(sp specialist/gate-writer '{"model":"bad model;x"}')"
[ "$r" = "200 409 400" ] && ok "POST specialist update -> 200, stale ifUpdatedAt -> 409, bad model -> 400" || fail "POST specialist update -> $r"
r="$(get /api/specialist/gate-nope | cut -d' ' -f1) $(get '/api/specialist/..%2F..%2Fetc' | cut -d' ' -f1) $(get /api/specialist/run/claude-spec-gate-nope-261111-0930 | cut -d' ' -f1) $(get '/api/specialist/gate-writer?runs=0' | cut -d' ' -f1) $(get /api/specialist/run/gate-bad-id | cut -d' ' -f1)"
[ "$r" = "404 400 404 400 400" ] && ok "GET specialist unknown -> 404, traversal -> 400, unknown run -> 404, bad runs / bad runId -> 400" || fail "GET specialist bad input -> $r"
r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' --path-as-is "$B/api/specialist/../../../etc/passwd")"; [[ "$r" == 4* ]] && ok "specialist raw traversal -> $r" || fail "specialist raw traversal -> $r"
head -c 100010 /dev/zero | tr '\0' 'a' | sed 's/^/{"text":"/;s/$/"}/' > /tmp/gate-$$.big
r="$(sp specialist/gate-writer/ask '{"text":"  "}') $(sp specialist/gate-writer/ask '{"text":"x","files":["relative.txt"]}') $(sp specialist/gate-writer/ask '{"text":"x","files":["/etc"]}') $(sp specialist/gate-writer/ask '{"text":"x","wait":"yes"}') $(sp specialist/gate-writer/ask '{"text":"x","extra":1}') $(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'Expect:' --data-binary @/tmp/gate-$$.big "$B/api/specialist/gate-writer/ask") $(sp specialist/gate-nope/ask '{"text":"x"}')"
[ "$r" = "400 400 400 400 400 413 404" ] && ok "POST specialist ask bad input -> 400, long text -> 413, unknown -> 404" || fail "POST specialist ask bad input -> $r"
r="$(sp specialist/run/claude-spec-gate-nope-261111-0930/send '{"text":"x"}') $(sp specialist/gate-writer/nope '{}')"
[ "$r" = "404 404" ] && ok "POST specialist run send unknown -> 404, unknown route -> 404" || fail "POST specialist run send / unknown route -> $r"
r="$(sp specialist/gate-writer '{"title":"x"}' -H 'Origin: https://evil.example')"
[ "$r" = 403 ] && ok "POST specialist from a foreign Origin -> 403" || fail "POST specialist foreign Origin -> $r"
r="$(sp specialist/gate-writer/archive '')"
[ "$r" = 200 ] && grep -q '"archivedAs":"_archive/gate-writer-' /tmp/gate-$$.body && [ -d "$TMP/specialists/_archive" ] && [ "$(get /api/specialist/gate-writer | cut -d' ' -f1)" = 404 ] && ok "POST specialist archive -> moved to _archive" || fail "POST specialist archive -> $r $(head -c 200 /tmp/gate-$$.body)"
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
gop() { local id="$1" d="$2"; shift 2; curl -s -m 30 -o /tmp/gate-$$.body -w '%{http_code}' -X POST -H 'content-type: application/json' "$@" -d "$d" "$B/api/git/$id/op"; }
json /api/git/gate-nope/branches 404
json /api/git/gate-nope/log 404
r="$(gop gate-nope '{"op":"stage","all":true}')"; [ "$r" = 404 ] && ok "POST git op on unknown root -> 404" || fail "POST git op on unknown root -> $r $(head -c 200 /tmp/gate-$$.body)"
for id in %2e%2e "$GITP~deadbeef"; do
  r="$(gop "$id" '{"op":"nope"}')"; [ "$r" = 404 ] && ok "POST git op on unknown root $id -> 404" || fail "POST git op on unknown root $id -> $r $(head -c 200 /tmp/gate-$$.body)"
done
head -c 1100000 /dev/zero | tr '\0' 'x' > /tmp/gate-$$.big
r="$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'Expect:' --data-binary @/tmp/gate-$$.big "$B/api/git/gate-nope/op")"
[ "$r" = 413 ] && ok "POST git op over 1 MB -> 413" || fail "POST git op over 1 MB -> $r"
if [ -n "$GITP" ]; then
  json "/api/git/$GITP/branches"
  [ "$(jq_ 'Array.isArray(d.local)&&Array.isArray(d.remote)&&"default" in d&&"current" in d&&Array.isArray(d.branches)&&d.branches.every(b=>typeof b.name==="string"&&typeof b.remote==="boolean"&&typeof b.current==="boolean"&&"worktree" in b&&"upstream" in b&&typeof b.ahead==="number"&&typeof b.behind==="number"&&typeof b.at==="number")&&d.branches.length<=600')" = true ] && ok "git branches shape" || fail "git branches shape $(head -c 200 /tmp/gate-$$.body)"
  json "/api/git/$GITP/log?skip=0&limit=5"
  [ "$(jq_ 'Array.isArray(d.commits)&&d.commits.length<=5&&typeof d.more==="boolean"&&d.commits.every(c=>typeof c.hash==="string"&&typeof c.subject==="string"&&typeof c.author==="string"&&typeof c.at==="number"&&typeof c.unpushed==="boolean"&&Array.isArray(c.parents))')" = true ] && ok "git log shape" || fail "git log shape $(head -c 200 /tmp/gate-$$.body)"
  json "/api/git/$GITP/log?limit=100000"
  [ "$(jq_ 'd.commits.length<=200')" = true ] && ok "git log limit capped at 200" || fail "git log limit not capped"
  json "/api/git/$GITP/diff?file=gate-nope.txt&kind=unstaged&ws=1"
  json "/api/git/$GITP/headdiff?file=gate-nope.txt&ws=1"
  r="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$B/api/git/$GITP/diff?file=../../etc/passwd")"; [ "$r" = 400 ] && ok "git diff traversal -> 400" || fail "git diff traversal -> $r"
  for d in '{"op":"nope"}' '{"op":"constructor"}'; do
    r="$(gop "$GITP" "$d")"; [ "$r" = 400 ] && ok "POST git op $d -> 400" || fail "POST git op $d -> $r $(head -c 200 /tmp/gate-$$.body)"
  done
  for h in "Origin: https://evil.example" "Sec-Fetch-Site: cross-site"; do
    r="$(gop "$GITP" '{"op":"nope"}' -H "$h")"; [ "$r" = 403 ] && ok "POST git op with $h -> 403" || fail "POST git op with $h -> $r"
  done
fi

echo "== guards"
r="$(curl -s -m 5 "$B/api/transcribe?warm=1")"
[ "$r" = '{"ok":false,"installed":false}' ] && ok "GET transcribe without a venv -> not installed, nothing started" || fail "GET transcribe without a venv -> $r"
r="$(curl -s -m 2 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/octet-stream' -H "Origin: http://127.0.0.1:$PORT" --data-binary 'x' "$B/api/transcribe")"
[ "$r" = 503 ] && ok "POST transcribe without a venv -> 503 at once" || fail "POST transcribe without a venv -> $r"
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

echo "== git ops on a temp repo"
GD="$TMP/gate-dev/gate-repo"; GO="$TMP/gate-origin.git"
mkdir -p "$GD" && git init -q --bare -b main "$GO" && git -C "$GD" init -q -b main
git -C "$GD" config user.name gate; git -C "$GD" config user.email gate@example.invalid; git -C "$GD" config commit.gpgsign false; git -C "$GD" remote add origin "$GO"
printf 'one\n' > "$GD/a.txt"; git -C "$GD" add -A; git -C "$GD" commit -qm init; git -C "$GD" push -q -u origin main 2>/dev/null
r="$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "{\"devRoot\":\"$TMP/gate-dev\"}" "$B/api/settings")"
json /api/state
GR="$(jq_ "(d.projects.find(p=>p.path===\"$GD\")||{}).id")"
if [ "$r" != 200 ] || [ -z "$GR" ]; then fail "temp repo not discovered ($r), write ops skipped"; else
  ok "temp repo discovered as $GR"
  commits() { git -C "$GD" rev-list --count HEAD; }
  opok() { local want="$1" d="$2" r; r="$(gop "$GR" "$d")"; [ "$r" = 200 ] && [ "$(jq_ 'd.ok')" = "$want" ]; }
  printf 'two\n' > "$GD/b.txt"
  opok true '{"op":"stage","files":["b.txt"]}' && [ "$(git -C "$GD" diff --cached --name-only)" = b.txt ] && ok "stage" || fail "stage $(head -c 200 /tmp/gate-$$.body)"
  json /api/state
  [ "$(jq_ "(d.wip.roots.find(x=>x.id===\"$GR\")||{}).staged")" = 1 ] && ok "state shows the stage right after the op" || fail "state not refreshed after stage"
  for h in "Origin: https://evil.example" "Sec-Fetch-Site: cross-site"; do
    r="$(gop "$GR" '{"op":"commit","message":"evil"}' -H "$h")"; [ "$r" = 403 ] && [ "$(commits)" = 1 ] && ok "commit with $h -> 403, no commit" || fail "commit with $h -> $r, commits $(commits)"
  done
  for d in '{"op":"stage","files":["../../x"]}' '{"op":"branch","name":"-x"}' '{"op":"commit","message":"  "}'; do
    r="$(gop "$GR" "$d")"; [ "$r" = 400 ] && ok "POST git op $d -> 400" || fail "POST git op $d -> $r $(head -c 200 /tmp/gate-$$.body)"
  done
  opok true '{"op":"commit","message":"gate commit"}' && [ "$(commits)" = 2 ] && ok "commit" || fail "commit $(head -c 200 /tmp/gate-$$.body)"
  opok false '{"op":"commit","message":"again"}' && [ "$(jq_ 'd.error')" = "Nothing is staged" ] && [ "$(commits)" = 2 ] && ok "second commit -> Nothing is staged" || fail "second commit $(head -c 200 /tmp/gate-$$.body)"
  json "/api/git/$GR/log?limit=1"
  [ "$(jq_ 'd.commits[0].subject==="gate commit"&&d.commits[0].unpushed===true&&d.more===true')" = true ] && ok "log shows the commit as unpushed" || fail "log unpushed $(head -c 200 /tmp/gate-$$.body)"
  opok true '{"op":"push"}' && [ "$(git -C "$GO" rev-parse main)" = "$(git -C "$GD" rev-parse HEAD)" ] && ok "push reaches origin" || fail "push $(head -c 200 /tmp/gate-$$.body)"
  json "/api/git/$GR/log?limit=1"
  [ "$(jq_ 'd.commits[0].unpushed')" = false ] && ok "log after push" || fail "log after push $(head -c 200 /tmp/gate-$$.body)"
  opok true '{"op":"pull"}' && ok "pull" || fail "pull $(head -c 200 /tmp/gate-$$.body)"
  opok true '{"op":"branch","name":"gate-side"}' && [ "$(git -C "$GD" branch --show-current)" = gate-side ] && ok "branch" || fail "branch $(head -c 200 /tmp/gate-$$.body)"
  opok true '{"op":"checkout","branch":"main"}' && [ "$(git -C "$GD" branch --show-current)" = main ] && ok "checkout" || fail "checkout $(head -c 200 /tmp/gate-$$.body)"
  json "/api/git/$GR/branches"
  [ "$(jq_ 'd.current==="main"&&d.branches[0].remote===false&&d.branches.some(b=>b.name==="gate-side"&&!b.current)')" = true ] && ok "branches after the ops" || fail "branches after the ops $(head -c 200 /tmp/gate-$$.body)"
  printf 'keep\n' > "$GD/u.txt"
  opok false '{"op":"discard","files":["u.txt"]}' && [ -f "$GD/u.txt" ] && ok "discard untracked without the flag refused" || fail "discard untracked without the flag $(head -c 200 /tmp/gate-$$.body)"
  opok true '{"op":"discard","files":["u.txt"],"untracked":true}' && [ ! -e "$GD/u.txt" ] && ok "discard untracked with the flag" || fail "discard untracked with the flag $(head -c 200 /tmp/gate-$$.body)"
  curl -s -m 15 -D /tmp/gate-$$.hdr -o /dev/null -X POST -H 'content-type: application/json' -H "Origin: $B" -d '{"op":"stage","all":true}' "$B/api/git/$GR/op"
  curl -s -m 15 -D - -o /dev/null -H "Origin: $B" "$B/api/git/$GR/log" >> /tmp/gate-$$.hdr
  grep -qi '^access-control-allow-origin' /tmp/gate-$$.hdr && fail "git routes send access-control-allow-origin" || ok "git routes send no access-control-allow-origin"
fi

if grep -qiE 'TypeError|ReferenceError|SyntaxError|UnhandledPromise' "$TMP/server.log"; then fail "errors in server log:"; grep -iE 'TypeError|ReferenceError|SyntaxError|UnhandledPromise' "$TMP/server.log" | head -5 | sed 's/^/      /'; fi
echo
[ $FAIL = 0 ] && echo "GATE GREEN" || echo "GATE RED"
exit $FAIL
