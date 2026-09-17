#!/usr/bin/env bash
# build-term-index.sh — sklapa index.html koji ttyd servira.
#
#   term/ttyd-base.html   netaknut ttyd index (700KB, xterm ugradjen unutra)
# + term/mobile.html      nas sloj: Esc/Tab/strelice + skrol prstom
# = term/index.html       ono sto ide u `ttyd --index`
#
# Odvojeno da nadogradnja ttyd-a ne pojede izmjene:
#
#   systemctl --user stop beast-term
#   /usr/bin/ttyd -p 7681 ... &            # bez --index, da servira svoj
#   curl -s localhost:7681/ > term/ttyd-base.html
#   kill %1 && ./bin/build-term-index.sh && systemctl --user start beast-term
#
# Za povratak na goli ttyd dovoljno je skinuti `--index` iz beast-term.service.
set -euo pipefail

cd "$(dirname "$0")/.."

osnova="term/ttyd-base.html"
sloj="term/mobile.html"
izlaz="term/index.html"

[ -f "$osnova" ] || { echo "nema $osnova — skini ga sa golog ttyd-a"; exit 1; }
[ -f "$sloj" ]   || { echo "nema $sloj"; exit 1; }

grep -q "window.term" "$osnova" || {
  echo "UPOZORENJE: $osnova ne izlaze 'window.term' — slanje tipki nece raditi."
  echo "Provjeri je li ttyd nadogradjen i je li se to promijenilo."
  exit 1
}

# Sloj ide PRIJE </body>, dakle poslije ttyd-ove skripte — `window.term`
# tada vec postoji.
python3 - "$osnova" "$sloj" "$izlaz" <<'PY'
import sys
osnova, sloj, izlaz = sys.argv[1:4]
b = open(osnova, encoding="utf-8").read()
m = open(sloj, encoding="utf-8").read()
kraj = b.rfind("</body>")
if kraj == -1:
    sys.exit("u osnovi nema </body>")
open(izlaz, "w", encoding="utf-8").write(b[:kraj] + "\n" + m + "\n" + b[kraj:])
PY

echo "napravljen $izlaz ($(wc -c < "$izlaz") bajta)"
