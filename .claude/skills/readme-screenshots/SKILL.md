---
name: readme-screenshots
description: Retake the README's screenshots of promptd from a throwaway hub with demo data.
disable-model-invocation: true
---

# README screenshots

The README shows `docs/images/crons.png` (the home page's Crons tab) and `docs/images/run-log.png` (one run's log). Retake both whenever the UI they show changes. Every picture comes from a **throwaway** hub and node: their own storage folder, their own port, demo jobs, and no trace of the machine or Claude account taking them.

Needs a Mac with Google Chrome, Node 20+, and Claude Code signed in (two demo runs on haiku, a few cents).

## Steps

1. **Build.** `npm ci && npm run build`. Done when `dist/.built` exists.

2. **Start the throwaway hub and node.** Pick a scratch folder `$S` (e.g. `S=$(mktemp -d)`) and a free port; 4390 here.

   ```bash
   PROMPTD_HOME=$S/home PORT=4390 HOST=127.0.0.1 SYSTEM_SAMPLE_MS=0 PROMPTD_SELF_UPDATE=0 node src/server.js > $S/hub.log 2>&1 &
   PROMPTD_HOME=$S/home PORT=4390 PROMPTD_NODE_ID=demo-mac PROMPTD_NODE_NAME=demo-mac SYSTEM_SAMPLE_MS=0 node src/node.js > $S/node.log 2>&1 &
   ```

   `SYSTEM_SAMPLE_MS=0` drops the machine meters from the header, and the node id keeps the hostname out of the job list. Done when `curl -s http://127.0.0.1:4390/api/nodes` shows `"online":true`.

3. **Seed.** `.claude/skills/readme-screenshots/seed.sh http://127.0.0.1:4390`. It names the hub Demo, creates five crons and two one-time executions, and runs Nightly digest and Weekly changelog. Every job works in `/tmp/promptd-demo`, which is the directory their logs print. Done when it prints `succeeded` for both runs.

4. **Hide the Claude account.** The header draws usage meters for whichever account the node can read, so restart the node with none:
   - Stop the node (`kill` its pid), then `rm -f $S/home/usage-cache.json`, the reading it saved.
   - `mkdir -p $S/shim && printf '#!/bin/sh\nexit 1\n' > $S/shim/security && chmod +x $S/shim/security`. The node reads the token from the keychain with `security`, and this one finds nothing.
   - Start the node again as in step 2 with `PATH="$S/shim:$PATH"` in front. When `~/.claude/.credentials.json` exists, also give it `HOME` set to an empty folder, since the node reads that file too.

   Done when `curl -s http://127.0.0.1:4390/api/health` shows `usage.windows` empty.

5. **Shoot.** `shoot.sh` takes each page in headless Chrome at 1280 wide:

   ```bash
   .claude/skills/readme-screenshots/shoot.sh 'http://127.0.0.1:4390/#/' docs/images/crons.png 760
   .claude/skills/readme-screenshots/shoot.sh "http://127.0.0.1:4390/#/logs/<cron-id>/<log-file>" docs/images/run-log.png 900
   ```

   `<cron-id>` and `<log-file>` are Nightly digest's `id` and `lastRunLog` from `curl -s http://127.0.0.1:4390/api/crons`. Leave the Settings page out: it prints the machine's hostname and storage paths. Done when both files exist, each under 400 KB (`sips -Z 1280` shrinks one that is not).

6. **Check every picture.** Open each image and read it as a stranger would. It is **clean** when none of these appears anywhere: header usage meters, the machine's real hostname, a home-folder path, an email address, a token. Also `grep -rE "$(whoami)|$(hostname -s)" $S/home/logs` must print nothing. Retake anything that is not clean.

7. **Clean up.** Stop the hub and node before any demo cron's next run comes round, then `rm -rf "$S" /tmp/promptd-demo`. Done when `lsof -iTCP:4390` prints nothing.
