#!/bin/bash
# Registers promptd as two macOS LaunchAgents that start at login: the hub (the
# web server) and a node that runs its jobs on this Mac.
#
# Run once, from anywhere:
#   ./scripts/register-app-mac-os.sh
#
# On another Mac, to add it as a node of a hub running elsewhere, with the
# command Settings → Nodes on the hub shows:
#   NODE_ONLY=1 HUB_URL=http://hub-host:4321 JOIN_CODE=<code> ./scripts/register-app-mac-os.sh
#
# Overrides:
#   PORT=4321                 port the hub listens on
#   HOST=0.0.0.0              bind address; 0.0.0.0 accepts connections from your
#                             whole network, and needs an admin password first
#                             (npm run set-password) — see docs/ADVANCED.md.
#   LABEL=local.promptd       launchd name of the hub
#   NODE_LABEL=$LABEL.node    launchd name of the node
#   NODE_ONLY=1               register only the node
#   HUB_URL=http://...        where the node finds the hub (default: this Mac)
#   JOIN_CODE=1234-5678       a one-time code from the hub, which the node trades
#                             for the hub's token on its first connection
#   NODE_TOKEN=...            the hub's node token itself, in place of a join code;
#                             read from the hub's storage folder when the hub is on this Mac
#   NODE_ID, NODE_NAME        how the node names itself (default: this Mac's hostname)
#   FORCE=1                   replace agents that are already registered
#   PROMPTD_BIN=/path/promptd run this promptd binary rather than the checkout;
#                             install.sh sets it
set -uo pipefail

PORT="${PORT:-4321}"
HOST="${HOST:-127.0.0.1}"
LABEL="${LABEL:-local.promptd}"
NODE_LABEL="${NODE_LABEL:-$LABEL.node}"
NODE_ONLY="${NODE_ONLY:-0}"
PROMPTD_BIN="${PROMPTD_BIN:-}"
NODE_TOKEN="${NODE_TOKEN:-}"
JOIN_CODE="${JOIN_CODE:-}"
NODE_ID="${NODE_ID:-}"
NODE_NAME="${NODE_NAME:-}"
FORCE="${FORCE:-0}"
# A node given a code or token is registered with it, whatever was there before.
if [ "$NODE_ONLY" = "1" ] && { [ -n "$JOIN_CODE" ] || [ -n "$NODE_TOKEN" ]; }; then FORCE=1; fi

# 0.0.0.0 and :: listen on every interface; anything else is reachable at itself.
case "$HOST" in
  0.0.0.0|::|"") CHECK_HOST="127.0.0.1" ;;
  *)             CHECK_HOST="$HOST" ;;
esac
HUB_URL="${HUB_URL:-http://$CHECK_HOST:$PORT}"
HUB_URL="${HUB_URL%/}"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORAGE_ROOT="${PROMPTD_HOME:-$HOME/.claude/promptd}"
# Where a node keeps the hub's token once it has traded its join code for it.
PAIRED_TOKEN="${PROMPTD_NODE_HOME:-$STORAGE_ROOT/node}/hub-token"
HUB_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_PLIST="$HOME/Library/LaunchAgents/$NODE_LABEL.plist"
LOG_DIR="$HOME/Library/Logs/promptd"
HUB_LOG="$LOG_DIR/server.log"
NODE_LOG="$LOG_DIR/node.log"
DOMAIN="gui/$(id -u)"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  • %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mFailed:\033[0m %s\n' "$*" >&2; exit 1; }
xml()  { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
registered() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }
# How many times launchd has started the agent since it was registered.
runs_of() { launchctl print "$DOMAIN/$1" 2>/dev/null | sed -nE 's/^[[:space:]]*runs = ([0-9]+).*/\1/p' | head -n 1; }
running() { launchctl print "$DOMAIN/$1" 2>/dev/null | grep -qE '^[[:space:]]*pid = [0-9]+'; }

printf '\nRegistering promptd with launchd\n\n'

[ "$(uname -s)" = "Darwin" ] || die "this script is for macOS; on Linux use systemd user units instead"

# --- what launchd will need to run ------------------------------------

if [ -n "$PROMPTD_BIN" ]; then
  [ -x "$PROMPTD_BIN" ] || die "$PROMPTD_BIN is not an executable promptd binary"
  ok "promptd $("$PROMPTD_BIN" version) at $PROMPTD_BIN"
  SET_PASSWORD="$PROMPTD_BIN set-password"
else
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || die "node is not on your PATH. Install Node 20 or newer, then run this again."
  NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"
  NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || die "Node 20 or newer is required, found $("$NODE_BIN" -v 2>/dev/null || echo none)"
  ok "node $("$NODE_BIN" -v) at $NODE_BIN"

  [ -f "$PROJECT_DIR/src/server.js" ] && [ -f "$PROJECT_DIR/src/node.js" ] || die "$PROJECT_DIR does not look like the project (no src/server.js or src/node.js)"
  ok "project at $PROJECT_DIR"
  SET_PASSWORD="npm run set-password"
fi

if [ "$NODE_ONLY" != "1" ]; then
  case "$HOST" in
    127.0.0.1|localhost|::1)
      ok "binding $HOST — this machine only"
      ;;
    *)
      warn "binding $HOST — reachable from your network."
      warn "The hub will not start without an admin password ($SET_PASSWORD)."
      warn "Anyone who has it can run arbitrary Claude prompts on every node, and it"
      warn "crosses the network unencrypted. Only do this on a network you trust, and"
      warn "see 'Network access' in docs/ADVANCED.md."
      ;;
  esac
fi

if [ -z "$NODE_TOKEN" ] && [ -z "$JOIN_CODE" ] && [ ! -f "$STORAGE_ROOT/node-token" ] && [ "$NODE_ONLY" = "1" ]; then
  die "no join code. Press Add a Mac under Settings → Nodes on the hub, and run the command it shows."
fi

# launchd gets a minimal PATH, so claude has to be findable from the one we set.
CLAUDE_BIN="$(command -v claude || true)"
if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_DIR="$(cd "$(dirname "$CLAUDE_BIN")" && pwd)"
  ok "claude at $CLAUDE_DIR/$(basename "$CLAUDE_BIN")"
else
  CLAUDE_DIR=""
  warn "claude is not on your PATH. The node will start, but every run will fail"
  warn "with 'spawn claude ENOENT' until it can be found. Install Claude Code, then re-run this."
fi

AGENT_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -n "$CLAUDE_DIR" ] && case ":$AGENT_PATH:" in *":$CLAUDE_DIR:"*) ;; *) AGENT_PATH="$CLAUDE_DIR:$AGENT_PATH" ;; esac
if [ -z "$PROMPTD_BIN" ]; then
  NODE_DIR="$(dirname "$NODE_BIN")"
  case ":$AGENT_PATH:" in *":$NODE_DIR:"*) ;; *) AGENT_PATH="$NODE_DIR:$AGENT_PATH" ;; esac

  # --- dependencies ---------------------------------------------------

  if [ ! -d "$PROJECT_DIR/node_modules/typescript" ]; then
    info "dependencies are missing, running npm install"
    (cd "$PROJECT_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1) || die "npm install failed; run it by hand and try again"
    ok "dependencies installed"
  else
    ok "dependencies present"
  fi

  (cd "$PROJECT_DIR" && npm run build >/dev/null 2>&1) || die "the build failed; run npm run build in $PROJECT_DIR to see why"
  ok "built"
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents" || die "could not create $LOG_DIR"

# --- one agent at a time ----------------------------------------------

# Answers 0 when the agent should be written: it is not registered, or FORCE
# asked for it to be replaced.
needs_agent() {
  local label="$1"
  if ! registered "$label"; then return 0; fi
  if [ "$FORCE" = "1" ]; then
    info "$label is already registered, replacing it"
    launchctl bootout "$DOMAIN/$label" 2>/dev/null
    sleep 1
    return 0
  fi
  ok "$label is already registered, leaving it as it is"
  return 1
}

agent_plist() {
  local label="$1" script="$2" log="$3" env="$4"
  # A binary takes its role as an argument; a checkout runs the role's script.
  local program workdir
  if [ -n "$PROMPTD_BIN" ]; then
    local role=node
    [ "$script" = server.js ] && role=hub
    program="    <string>$PROMPTD_BIN</string>
    <string>$role</string>"
    workdir="$(dirname "$PROMPTD_BIN")"
  else
    program="    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/src/$script</string>"
    workdir="$PROJECT_DIR"
  fi
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$program
  </array>
  <key>WorkingDirectory</key><string>$workdir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$AGENT_PATH</string>
$env
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
}

env_entry() {
  printf '    <key>%s</key><string>%s</string>\n' "$1" "$(xml "$2")"
}

# A storage folder other than the default has to reach both processes, or the
# node would look for the hub's token in the wrong place.
STORAGE_ENV=""
[ -n "${PROMPTD_HOME:-}" ] && STORAGE_ENV="$(env_entry PROMPTD_HOME "$PROMPTD_HOME")"

install_agent() {
  local label="$1" plist="$2" script="$3" log="$4" env="$5"
  agent_plist "$label" "$script" "$log" "$env" > "$plist"
  plutil -lint "$plist" >/dev/null 2>&1 || die "generated an invalid plist at $plist"
  ok "wrote $plist"
  launchctl bootstrap "$DOMAIN" "$plist" 2>&1 || die "launchctl bootstrap of $label failed. See $log"
  # Loading a job does not always start it, RunAtLoad or not, so start it now and see that it ran.
  launchctl kickstart "$DOMAIN/$label" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    launchctl print "$DOMAIN/$label" 2>/dev/null | grep -qE '^[[:space:]]*runs = [1-9]' && return 0
    sleep 0.5
  done
  die "launchd registered $label but will not start it. Allow promptd under System Settings → General → Login Items & Extensions → Allow in the Background, then run this again."
}

# A join code works once, so a node given one needs a new command from its hub.
if [ -n "$JOIN_CODE" ]; then
  RUN_AGAIN="press Add a Mac on the hub and run its new command here"
else
  RUN_AGAIN="run the installer again with FORCE=1 in front of bash"
fi

# launchd starting promptd again unaided is what brings it back after a restart or
# login, and some Macs never do. So stop the new agent once and see it come back.
check_relaunch() {
  local label="$1" before
  before="$(runs_of "$label")"
  printf '  • checking that launchd starts %s again by itself' "$label"
  launchctl kill SIGTERM "$DOMAIN/$label" >/dev/null 2>&1
  # launchd waits until 10s after the last start before starting it again.
  for _ in $(seq 1 30); do
    sleep 1
    printf '.'
    if [ "$(runs_of "$label")" -gt "${before:-0}" ] 2>/dev/null && running "$label"; then
      printf '\n'
      ok "launchd starts $label again by itself"
      return 0
    fi
  done
  printf '\n'
  # Started by hand for now, so this Mac is not left without it. -k because the old
  # process may still be stopping, and a plain kickstart would leave it to exit later.
  before="$(runs_of "$label")"
  launchctl kickstart -k "$DOMAIN/$label" >/dev/null 2>&1
  for _ in $(seq 1 20); do
    [ "$(runs_of "$label")" -gt "${before:-0}" ] 2>/dev/null && running "$label" && break
    sleep 0.5
  done
  running "$label" || die "launchd will not start $label, even when asked. Allow promptd under System Settings → General → Login Items & Extensions → Allow in the Background, then $RUN_AGAIN."
  die "macOS is not letting promptd start on its own, so this Mac will drop off after a restart or login. Turn promptd on under System Settings → General → Login Items & Extensions → Allow in the Background, then $RUN_AGAIN."
}

# Waits up to 30s for the hub to answer on its port.
hub_answers() {
  printf '  • waiting for the hub to answer'
  for _ in $(seq 1 30); do
    if curl -fsS "http://$CHECK_HOST:$PORT/api/health" >/dev/null 2>&1; then printf '\n'; return 0; fi
    printf '.'
    sleep 1
  done
  printf '\n'
  return 1
}

HUB_INSTALLED=0
if [ "$NODE_ONLY" != "1" ] && needs_agent "$LABEL"; then
  # Something else already on the port would make the hub exit on boot.
  if lsof -Pi ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    warn "port $PORT is already in use — stop whatever is on it, or re-run with PORT=<other>"
  fi
  HUB_ENV="$(env_entry PORT "$PORT")
$(env_entry HOST "$HOST")
$(env_entry PROMPTD_LAUNCHD_LABEL "$LABEL")
$(env_entry PROMPTD_NODE_LAUNCHD_LABEL "$NODE_LABEL")"
  [ -n "$STORAGE_ENV" ] && HUB_ENV="$HUB_ENV
$STORAGE_ENV"
  install_agent "$LABEL" "$HUB_PLIST" server.js "$HUB_LOG" "$HUB_ENV"
  HUB_INSTALLED=1
fi

NODE_INSTALLED=0
if needs_agent "$NODE_LABEL"; then
  NODE_ENV="$(env_entry PROMPTD_HUB_URL "$HUB_URL")"
  [ -n "$STORAGE_ENV" ] && NODE_ENV="$NODE_ENV
$STORAGE_ENV"
  [ -n "$NODE_TOKEN" ] && NODE_ENV="$NODE_ENV
$(env_entry PROMPTD_NODE_TOKEN "$NODE_TOKEN")"
  [ -n "$JOIN_CODE" ] && NODE_ENV="$NODE_ENV
$(env_entry PROMPTD_JOIN_CODE "$JOIN_CODE")"
  [ -n "$NODE_ID" ] && NODE_ENV="$NODE_ENV
$(env_entry PROMPTD_NODE_ID "$NODE_ID")"
  [ -n "$NODE_NAME" ] && NODE_ENV="$NODE_ENV
$(env_entry PROMPTD_NODE_NAME "$NODE_NAME")"
  # A token kept from pairing with this or another hub would win over the new code.
  [ -n "$JOIN_CODE" ] && rm -f "$PAIRED_TOKEN"
  # What the node writes from here on is this install's, and so is its start time.
  NODE_LOG_START=0
  [ -f "$NODE_LOG" ] && NODE_LOG_START="$(wc -c < "$NODE_LOG" | tr -d ' ')"
  NODE_SINCE="$(date -u +%Y-%m-%dT%H:%M:%S)"
  install_agent "$NODE_LABEL" "$NODE_PLIST" node.js "$NODE_LOG" "$NODE_ENV"
  { [ -n "$NODE_TOKEN" ] || [ -n "$JOIN_CODE" ]; } && chmod 600 "$NODE_PLIST"
  NODE_INSTALLED=1
fi

# --- confirm they answer ----------------------------------------------

if [ "$HUB_INSTALLED" = "1" ]; then
  hub_answers || die "registered, but nothing answered on $CHECK_HOST:$PORT within 30s. Check $HUB_LOG"
  ok "hub serving on http://$CHECK_HOST:$PORT"
  if [ "$CHECK_HOST" = "127.0.0.1" ] && [ "$HOST" != "127.0.0.1" ]; then
    LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    [ -n "$LAN_IP" ] && ok "on your network at http://$LAN_IP:$PORT"
  fi
  check_relaunch "$LABEL"
  hub_answers || die "launchd started the hub again, but nothing answered on $CHECK_HOST:$PORT within 30s. Check $HUB_LOG"
fi

if [ "$NODE_INSTALLED" = "1" ]; then
  # The node's id is this Mac's hostname unless NODE_ID says otherwise, made the way the node makes it.
  CHECK_ID="$(printf '%s' "${NODE_ID:-$(hostname | sed 's/\.local$//')}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//' | cut -c1-64)"
  CHECK_ID="${CHECK_ID:-node}"
  printf '  • waiting for %s to connect' "$CHECK_ID"
  connected=0
  for _ in $(seq 1 30); do
    answer="$(curl -sS -w '\n%{http_code}' "$HUB_URL/api/nodes/$CHECK_ID" 2>/dev/null || true)"
    case "$answer" in
      *$'\n'401) connected=locked; break ;;
      *'"online":true'*$'\n'200)
        # Online as the process started just now, not as another Mac of the same name.
        started="$(printf '%s' "$answer" | grep -o '"startedAt":"[^"]*"' | head -1 | cut -d'"' -f4)"
        [[ -n "$started" && ! "$started" < "$NODE_SINCE" ]] && { connected=1; break; } ;;
    esac
    printf '.'
    sleep 1
  done
  printf '\n'
  if [ "$connected" = "1" ]; then
    ok "$CHECK_ID connected to $HUB_URL"
    check_relaunch "$NODE_LABEL"
  elif [ "$connected" = "locked" ]; then
    ok "node registered; the hub requires a login, so check it under Settings → Nodes"
    # Stopping the node before it keeps the hub's token could spend its join code for nothing.
    paired=0
    for _ in $(seq 1 30); do
      if [ -z "$JOIN_CODE" ] || [ -s "$PAIRED_TOKEN" ]; then paired=1; break; fi
      sleep 1
    done
    if [ "$paired" = "1" ]; then
      check_relaunch "$NODE_LABEL"
    else
      warn "$CHECK_ID has not paired with $HUB_URL yet, so whether launchd starts it again by itself is unchecked"
    fi
  else
    since_install="$(tail -c +$((NODE_LOG_START + 1)) "$NODE_LOG" 2>/dev/null)"
    # A node launchd is not running cannot be trying; say what launchd says.
    job="$(launchctl print "$DOMAIN/$NODE_LABEL" 2>/dev/null)"
    if ! printf '%s' "$job" | grep -qE '^[[:space:]]*pid = [0-9]+'; then
      exit_code="$(printf '%s' "$job" | grep -m1 'last exit code' | sed -E 's/.*= *//')"
      die "launchd is not running the node (last exit: ${exit_code:-none}). See $NODE_LOG, and launchctl print $DOMAIN/$NODE_LABEL"
    fi
    case "$since_install" in
      *"refused join code"*)
        die "the hub refused join code $JOIN_CODE: it was used, has expired, or was mistyped. Press Add a Mac on the hub for a new one, and run its command here." ;;
      *"already syncing as node"*)
        die "another Mac is already connected as $CHECK_ID. Run the command again with NODE_ID=<a name of its own> in front of bash." ;;
      *"no longer takes this node's token"*)
        die "the hub no longer takes this node's token. Press Add a Mac on the hub for a new command, and run it here." ;;
      *)
        warn "$CHECK_ID has not reached $HUB_URL yet. It keeps trying, and shows up under Settings → Nodes once it does."
        last="$(printf '%s\n' "$since_install" | grep -E 'cannot sync|pairing got' | tail -n 1)"
        [ -n "$last" ] && warn "its log says: $last" ;;
    esac
  fi
fi

printf '\nStart at login is on. Useful commands:\n\n'
for label in $([ "$NODE_ONLY" != "1" ] && echo "$LABEL") "$NODE_LABEL"; do
  printf '  %s\n' "$label"
  printf '    Restart   launchctl kickstart -k %s/%s\n' "$DOMAIN" "$label"
  printf '    Stop      launchctl bootout %s/%s\n' "$DOMAIN" "$label"
  printf '    Status    launchctl print %s/%s | grep -E "state =|pid ="\n' "$DOMAIN" "$label"
  printf '    Remove    launchctl bootout %s/%s && rm %s\n' "$DOMAIN" "$label" "$HOME/Library/LaunchAgents/$label.plist"
done
printf '\n  Logs        tail -f %s/*.log\n\n' "$LOG_DIR"
if [ "$HUB_INSTALLED" = "1" ]; then
  if [ -n "$PROMPTD_BIN" ]; then JOIN_COMMAND="$PROMPTD_BIN join-command"; else JOIN_COMMAND="npm run -s join-command"; fi
  printf 'To add another Mac as a node, press Add a Mac under Settings → Nodes at\n'
  printf 'http://%s:%s, or run %s here, and run what it gives you on that Mac.\n\n' "$CHECK_HOST" "$PORT" "$JOIN_COMMAND"
fi
exit 0
