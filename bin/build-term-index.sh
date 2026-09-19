#!/usr/bin/env bash
# build-term-index.sh — assembles the index.html that ttyd serves.
#
#   term/ttyd-base.html   untouched ttyd index (700 KB, xterm bundled inside)
# + term/mobile.html      our layer: Esc/Tab/arrows key bar, finger scroll, paste/upload
# = term/index.html       what goes into `ttyd --index`
#
# Kept separate so a ttyd upgrade never eats the customisations:
#
#   systemctl --user stop beast-term
#   /usr/bin/ttyd -p 7681 ... &            # without --index, so it serves its own page
#   curl -s localhost:7681/ > term/ttyd-base.html
#   kill %1 && ./bin/build-term-index.sh && systemctl --user start beast-term
#
# To go back to plain ttyd, drop `--index` from beast-term.service.
set -euo pipefail

cd "$(dirname "$0")/.."

base="term/ttyd-base.html"
layer="term/mobile.html"
out="term/index.html"

[ -f "$base" ]  || { echo "missing $base — download it from a plain ttyd (see the header of this script)"; exit 1; }
[ -f "$layer" ] || { echo "missing $layer"; exit 1; }

grep -q "window.term" "$base" || {
  echo "WARNING: $base does not expose 'window.term' — sending keys will not work."
  echo "Check whether ttyd was upgraded and that changed."
  exit 1
}

# The layer goes right BEFORE </body>, i.e. after ttyd's own script — `window.term` exists by then.
python3 - "$base" "$layer" "$out" <<'PY'
import sys
base, layer, out = sys.argv[1:4]
b = open(base, encoding="utf-8").read()
m = open(layer, encoding="utf-8").read()
end = b.rfind("</body>")
if end == -1:
    sys.exit("no </body> in the base file")
open(out, "w", encoding="utf-8").write(b[:end] + "\n" + m + "\n" + b[end:])
PY

echo "built $out ($(wc -c < "$out") bytes)"
