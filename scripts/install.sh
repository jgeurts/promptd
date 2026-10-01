#!/bin/bash
# Installs promptd and starts it at every login.
#
# The hub and a node on this Mac, from a GitHub release:
#   curl -fsSL https://github.com/promptilicious/promptd/releases/latest/download/install.sh | bash
#
# A node of a hub on another Mac, with the command Settings → Nodes on the hub
# shows. The hub serves this script with its address filled in, and promptd too:
#   curl -fsSL http://<hub-address>:4321/install.sh | bash -s -- --code <code>
#
# The binary goes to ~/.local/bin/promptd and updates itself from then on, a hub
# from the releases and a node from its hub. Registering it with launchd is
# register-app-mac-os.sh's job, which a release ships beside this script and a
# hub's copy carries inside it.
#
# Overrides:
#   PROMPTD_REPO=owner/name     the repository to install from
#   PROMPTD_RELEASE=build-abc1234  a release other than the latest
#   PROMPTD_BIN_DIR=~/.local/bin   where the binary goes
# and every override register-app-mac-os.sh takes, such as PORT or FORCE=1.
set -euo pipefail

REPO="${PROMPTD_REPO:-promptilicious/promptd}"
RELEASE="${PROMPTD_RELEASE:-latest}"
BIN_DIR="${PROMPTD_BIN_DIR:-$HOME/.local/bin}"
# A hub serving this script fills these in: its address, and the register script.
FROM_HUB=''
REGISTER_SCRIPT=''

die() { printf '\n\033[31mFailed:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --hub) [ $# -ge 2 ] || die "--hub needs the hub's address"; export NODE_ONLY=1 HUB_URL="$2"; shift 2 ;;
    --code) [ $# -ge 2 ] || die "--code needs the join code from the hub"; export JOIN_CODE="$2"; shift 2 ;;
    --token) [ $# -ge 2 ] || die "--token needs the hub's node token"; export NODE_TOKEN="$2"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done

[ "$(uname -s)" = Darwin ] || die "this installer is for macOS"
[ "$(uname -m)" = arm64 ] || die "promptd is built for Apple silicon Macs only"
ASSET=promptd-darwin-arm64

if [ -n "$FROM_HUB" ]; then
  # A node of the hub that served this script, installed from it.
  export NODE_ONLY=1 HUB_URL="${HUB_URL:-$FROM_HUB}"
  [ -n "${JOIN_CODE:-}" ] || [ -n "${NODE_TOKEN:-}" ] ||
    die "no join code. Press Add a Mac under Settings → Nodes on the hub, and run the command it shows."
elif [ "$RELEASE" = latest ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$RELEASE"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The binary is about 65 MB and sits on disk twice for a moment, so ask for room
# up front rather than let a half-written download fail.
NEED_MB=200
mkdir -p "$BIN_DIR"
for dir in "$TMP" "$BIN_DIR"; do
  free_mb=$(( $(df -Pk "$dir" | awk 'NR==2 {print $4}') / 1024 ))
  [ "$free_mb" -ge "$NEED_MB" ] ||
    die "$(scutil --get LocalHostName 2>/dev/null || hostname -s) has $free_mb MB free where $dir is; promptd needs about $NEED_MB MB. Free some space and run this again."
done

if [ -n "$FROM_HUB" ]; then
  printf '\nDownloading promptd from %s\n' "$HUB_URL"
  # The hub checks the join code without using it up, for the node to pair with.
  if [ -n "${JOIN_CODE:-}" ]; then
    AUTH=(--get --data-urlencode "code=$JOIN_CODE")
  else
    AUTH=(-H "Authorization: Bearer $NODE_TOKEN")
  fi
  status="$(curl -sSL --retry 3 "${AUTH[@]}" -D "$TMP/headers" -o "$TMP/$ASSET" -w '%{http_code}' "$HUB_URL/api/node/build")" ||
    die "could not reach the hub at $HUB_URL"
  case "$status" in
    200) ;;
    401)
      if [ -n "${JOIN_CODE:-}" ]; then
        die "the hub refused join code $JOIN_CODE: it was used, has expired, or was mistyped. Press Add a Mac on the hub for a new one, and run its command here."
      fi
      die "the hub refused the node token" ;;
    *) die "the hub answered $status for promptd: $(head -c 300 "$TMP/$ASSET")" ;;
  esac
  expected="$(tr -d '\r' < "$TMP/headers" | awk 'tolower($1) == "x-promptd-sha256:" { sum = $2 } END { print sum }')"
  [ -n "$expected" ] || die "the hub sent promptd without its checksum; try again"
  [ "$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')" = "$expected" ] ||
    die "the download does not match the checksum the hub sent; try again"
  printf '%s\n' "$REGISTER_SCRIPT" > "$TMP/register-app-mac-os.sh"
else
  printf '\nDownloading promptd from %s\n' "$REPO"
  for file in "$ASSET" register-app-mac-os.sh sha256sums.txt; do
    curl -fsSL --retry 3 -o "$TMP/$file" "$BASE/$file" || die "could not download $BASE/$file"
  done
  grep -E "^[0-9a-f]{64}  ($ASSET|register-app-mac-os\.sh)\$" "$TMP/sha256sums.txt" > "$TMP/expected" || true
  [ "$(wc -l < "$TMP/expected")" -eq 2 ] || die "the release's checksums do not list $ASSET and register-app-mac-os.sh; try again"
  (cd "$TMP" && shasum -a 256 -c expected >/dev/null) || die "the download does not match the release's checksums; try again"
fi

# A rename, so a promptd already running keeps the file it started from.
NEXT="$(mktemp "$BIN_DIR/promptd.XXXXXX")"
install -m 755 "$TMP/$ASSET" "$NEXT"
mv -f "$NEXT" "$BIN_DIR/promptd"

PROMPTD_BIN="$BIN_DIR/promptd" bash "$TMP/register-app-mac-os.sh"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '%s is not on your PATH, so run promptd as %s/promptd, or add it to PATH.\n\n' "$BIN_DIR" "$BIN_DIR" ;;
esac
