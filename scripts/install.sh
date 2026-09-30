#!/bin/bash
# Installs promptd from a GitHub release and starts it at every login.
#
# The hub and a node on this Mac:
#   curl -fsSL https://github.com/promptilicious/promptd/releases/latest/download/install.sh | bash
#
# A node of a hub on another Mac:
#   curl -fsSL https://github.com/promptilicious/promptd/releases/latest/download/install.sh | bash -s -- --hub <url> --token <token>
#
# The binary goes to ~/.local/bin/promptd and updates itself from then on.
# Registering it with launchd is register-app-mac-os.sh's job, from the same release.
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

die() { printf '\n\033[31mFailed:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --hub) [ $# -ge 2 ] || die "--hub needs the hub's address"; export NODE_ONLY=1 HUB_URL="$2"; shift 2 ;;
    --token) [ $# -ge 2 ] || die "--token needs the hub's node token"; export NODE_TOKEN="$2"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done

[ "$(uname -s)" = Darwin ] || die "this installer is for macOS"
case "$(uname -m)" in
  arm64) ASSET=promptd-darwin-arm64 ;;
  x86_64) ASSET=promptd-darwin-x64 ;;
  *) die "no promptd build for $(uname -m)" ;;
esac

if [ "$RELEASE" = latest ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$RELEASE"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

printf '\nDownloading promptd from %s\n' "$REPO"
for file in "$ASSET" register-app-mac-os.sh sha256sums.txt; do
  curl -fsSL --retry 3 -o "$TMP/$file" "$BASE/$file" || die "could not download $BASE/$file"
done
(cd "$TMP" && grep -E "  ($ASSET|register-app-mac-os\.sh)\$" sha256sums.txt | shasum -a 256 -c - >/dev/null) ||
  die "the download does not match the release's checksums; try again"

mkdir -p "$BIN_DIR"
# A rename, so a promptd already running keeps the file it started from.
install -m 755 "$TMP/$ASSET" "$BIN_DIR/promptd.new"
mv -f "$BIN_DIR/promptd.new" "$BIN_DIR/promptd"

PROMPTD_BIN="$BIN_DIR/promptd" bash "$TMP/register-app-mac-os.sh"
