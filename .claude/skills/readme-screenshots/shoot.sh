#!/bin/bash
# Screenshots one promptd page with headless Chrome, at the width the README uses.
#
#   shoot.sh <url> <out.png> [height]
#
# A throwaway Chrome profile each time, so no extension, cookie or theme of the
# person running it ends up in the picture. A new profile asks the macOS keychain
# for a storage key, and that prompt stalls headless Chrome; the mock keychain
# skips it.
set -euo pipefail

URL="${1:?usage: shoot.sh <url> <out.png> [height]}"
OUT="${2:?usage: shoot.sh <url> <out.png> [height]}"
HEIGHT="${3:-820}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

rm -f "$OUT"
# The page keeps an event stream open, so it never goes idle: a virtual time
# budget would wait on it forever, and Chrome does not exit after writing the
# file. A plain timeout gives the jobs time to load, and this script ends Chrome.
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --use-mock-keychain --password-store=basic \
  --user-data-dir="$PROFILE" --window-size="1280,$HEIGHT" --timeout=6000 \
  --screenshot="$OUT" "$URL" >/dev/null 2>&1 &
chrome=$!
for _ in $(seq 1 60); do
  [ -s "$OUT" ] && break
  sleep 1
done
sleep 1
kill "$chrome" 2>/dev/null || true
wait "$chrome" 2>/dev/null || true
[ -s "$OUT" ] || { echo "shoot.sh: Chrome wrote no screenshot of $URL" >&2; exit 1; }
