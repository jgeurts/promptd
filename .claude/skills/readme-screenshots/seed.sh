#!/bin/bash
# Fills a throwaway promptd hub with demo jobs, then runs two of them so their
# log pages have output to show. Every job uses haiku and asks for invented
# details, so a run costs cents and its output says nothing about the person
# running it; a cron that fires before the hub is stopped is just as cheap.
#
#   seed.sh <hub-url> [demo-dir]
#
# demo-dir is the working directory the demo runs use, and it appears in their
# logs, so it defaults to a path that says nothing about this machine.
set -euo pipefail

HUB="${1:?usage: seed.sh <hub-url> [demo-dir]}"
HUB="${HUB%/}"
DEMO_DIR="${2:-/tmp/promptd-demo}"
mkdir -p "$DEMO_DIR"

# The browser's own zone, so the list shows no zone label beside each cron.
ZONE="$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"

api() {
  curl -fsS -X "$1" -H 'content-type: application/json' ${3:+--data "$3"} "$HUB$2"
}
id_of() { python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'; }

cron() { # name, expression, model, active, prompt
  api POST /api/crons "$(python3 -c 'import json,sys; print(json.dumps({
    "name": sys.argv[1], "cron": sys.argv[2], "model": sys.argv[3], "isActive": sys.argv[4] == "1",
    "prompt": sys.argv[5], "timezone": sys.argv[6], "workingDirectory": sys.argv[7]}))' "$@" "$ZONE" "$DEMO_DIR")" | id_of
}

execution() { # name, days from now, prompt
  local at
  at="$(python3 -c 'import datetime,sys; d=datetime.datetime.now().astimezone()+datetime.timedelta(days=int(sys.argv[1])); print(d.replace(hour=8,minute=0,second=0,microsecond=0).isoformat())' "$2")"
  api POST /api/executions "$(python3 -c 'import json,sys; print(json.dumps({
    "name": sys.argv[1], "scheduledAt": sys.argv[2], "prompt": sys.argv[3], "isActive": True,
    "workingDirectory": sys.argv[4]}))' "$1" "$at" "$3" "$DEMO_DIR")" | id_of
}

printf 'waiting for a node to come online'
for _ in $(seq 1 60); do
  api GET /api/nodes | grep -q '"online":true' && break
  printf '.'
  sleep 1
done
printf '\n'
api GET /api/nodes | grep -q '"online":true' || { echo "no node came online at $HUB" >&2; exit 1; }

api PUT /api/settings '{"serverName":"Demo"}' >/dev/null

digest="$(cron 'Nightly digest' '0 6 * * *' haiku 1 'Write a two-line example nightly digest for a small web app, one line on builds and one on open issues. Invent every detail.')"
cron 'Dependency audit' '30 7 * * 1' haiku 1 'List the three dependencies most worth upgrading, and why.' >/dev/null
cron 'Triage new issues' '0 9,13,17 * * 1-5' haiku 1 'Label each issue opened since the last run, and flag anything urgent.' >/dev/null
changelog="$(cron 'Weekly changelog' '0 16 * * 5' haiku 1 'Write a three-bullet example changelog for a small web app. Invent every detail.')"
cron 'Flaky test hunt' '0 2 * * *' haiku 0 'Run the test suite three times and report any test that failed at least once.' >/dev/null
execution 'Backfill October invoices' 1 'Backfill the October invoices and summarize what changed.' >/dev/null
execution 'Release notes for v2.4' 3 'Draft the release notes for v2.4 from the merged pull requests.' >/dev/null

for id in "$digest" "$changelog"; do
  api POST "/api/crons/$id/run" >/dev/null
  printf 'running %s' "$id"
  for _ in $(seq 1 180); do
    status="$(api GET "/api/crons/$id" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("lastRunStatus") or "")')"
    [ -n "$status" ] && break
    printf '.'
    sleep 1
  done
  printf ' %s\n' "${status:-still running}"
done
