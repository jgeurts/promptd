# promptd

A lightweight web UI to schedule, manage, and run Claude prompts, either as a cron that repeats on a schedule or as a one-time execution at a date and time you pick. A small Node.js hub holds a set of crons and one-time executions and serves the web page. One or more nodes, on this machine or others, fetch their jobs from it, spawn `claude -p` on each one's schedule, and report the output back as it happens. Jobs, settings and notifications live in a SQLite file under `~/.claude/promptd`, with nothing to install; run logs are plain files beside it.

- Two tabs on the home page: **Crons**, which run on a schedule, and **One-time Execution**, which run once at a date you pick.
- Add, edit and delete crons in the browser. They are kept in a SQLite file by default, or in Postgres when `DATABASE_URL` is set.
- Follow a run's output as it is produced, or read back any of the last 50 runs per cron.
- Stop a run in progress. The schedule stays armed for its next trigger.
- Pause everything for 30 minutes, an hour, 3 hours, or until the next restart — crons and one-time executions together.
- A one-time execution survives a restart. If its moment passed while the server was down, it runs as soon as the server is back.
- Hold a cron until your Claude usage resets, per limit, instead of firing it into a spent quota.
- Choose the model per cron, from whatever the installed CLI recognises.
- Every finished run records the model, runtime, tokens and cost that the CLI reported.
- An optional retrospective per job, off by default. Claude reviews the run at the end, using a prompt set in Settings. A retrospective with something in it gets its own section in the log, a sub-item in the run list, and a notification.
- Lifetime totals per cron — runs completed, what they cost, how long they took, and the average of each.
- Machine stats in the header — CPU, memory, storage throughput and disk space, sampled every 5 seconds, with a 15-minute chart on hover.
- A notification centre behind the bell: everything the server announces, kept on disk, with an unread count and a drawer that marks what you have actually read.
- Alerts when the machine is in trouble — CPU, memory, unusual disk throughput, low disk space — each one naming the crons that were running at the time.

## Install

The installer is for macOS; a hub on a server is covered in [Deploying a hub](docs/ADVANCED.md#deploying-a-hub). Every Mac that runs jobs needs Claude Code installed and signed in: `claude --version` should answer.

One Mac runs the **hub**, which keeps your jobs and serves the web page. Every Mac that runs jobs is a **node**, the hub's Mac included. Nodes connect to the hub; the hub never connects to them.

### On one Mac

```bash
curl -fsSL https://github.com/promptilicious/promptd/releases/latest/download/install.sh | bash
```

Open http://127.0.0.1:4321. promptd is one file, `~/.local/bin/promptd`. It starts at every login and updates itself from the latest release once a day.

Already running promptd from a checkout? Put `FORCE=1` before `bash` to switch its services to the binary.

### Adding more Macs, with Tailscale

With [Tailscale](https://tailscale.com) on every Mac, the nodes reach the hub by its tailnet name, at home or away, and the hub stays closed to whatever network you are on.

1. Install promptd on the hub's Mac as above, then share it on your tailnet:

   ```bash
   tailscale serve --bg --http=4321 4321
   ```

   If `tailscale` is not found, it lives at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

2. Open Settings (the ⚙ button) → Nodes on the hub's page, and press **Add a Mac**. It shows a command with the hub's tailnet address and a join code.

3. Run that command in a terminal on the other Mac:

   ```bash
   curl -fsSL https://github.com/promptilicious/promptd/releases/latest/download/install.sh | bash -s -- --hub http://<hub-mac>.<tailnet>.ts.net:4321 --code 1234-5678
   ```

   A join code works once, for 15 minutes, so press **Add a Mac** again for the next one. `promptd join-command` on the hub's Mac prints the same command.

The new node shows under Settings → Nodes within a few seconds, and from then on it runs the same build as the hub. promptd starts at login, so each Mac needs to stay logged in. While the hub's Mac is asleep or away, nodes keep running the jobs they already have, and catch the hub up when it is back.

`tailscale serve` shares the page with your tailnet only; `tailscale funnel` is the one that would put it on the internet. With no password set, every device on your tailnet can open the page. If you share your tailnet with anyone, run `promptd set-password` on the hub's Mac; it takes effect within a few seconds, and nodes are unaffected.

### Adding more Macs, on one network

Without Tailscale, the hub listens on your network, which needs a password first. Install on the hub's Mac as above, then:

```bash
promptd set-password
curl -fsSL https://github.com/promptilicious/promptd/releases/latest/download/install.sh | HOST=0.0.0.0 FORCE=1 bash
```

**Add a Mac** then fills in the hub's `.local` address. The password and session cookie cross your network unencrypted; read [Network access](docs/ADVANCED.md#network-access) before doing this anywhere but home.

### From a checkout

To run the source instead, clone it and register it with launchd; it updates itself with `git pull` rather than from releases. This needs Node 20 or newer:

```bash
git clone https://github.com/promptilicious/promptd.git
cd promptd
./scripts/register-app-mac-os.sh
```

### Stopping and removing

| Task    | Command                                                                      |
| ------- | ---------------------------------------------------------------------------- |
| Restart | `launchctl kickstart -k gui/$(id -u)/local.promptd`                          |
| Stop    | `launchctl bootout gui/$(id -u)/local.promptd`                               |
| Remove  | `launchctl bootout gui/$(id -u)/local.promptd && rm ~/Library/LaunchAgents/local.promptd.plist` |
| Logs    | `tail -f ~/Library/Logs/promptd/server.log ~/Library/Logs/promptd/node.log` |

A node's service is `local.promptd.node`. The installer prints every command for both when it finishes, and `rm ~/.local/bin/promptd` removes the binary; [Start and stop](docs/ADVANCED.md#start-and-stop) has the rest.

## Developing

Needs Node 20 or newer, and Claude Code installed and signed in — `claude --version` should answer.

```bash
npm install
npm start          # the hub on http://127.0.0.1:4321, plus one node on this machine
npm run dev        # same, restarts on file changes
npm run start:hub  # the hub alone
npm run start:node # a node alone
```

The server is TypeScript, compiled from `src/` into `dist/`. Every start command compiles first when any source has changed since the last build, so a `git pull` needs nothing extra. `npm run dev` also keeps the compiler running and restarts on each change.

```bash
npm run build      # compile src/ into dist/
npm run typecheck  # type-check sources and tests without writing dist/
npm run lint
npm test
```

## More

[docs/ADVANCED.md](docs/ADVANCED.md) covers how the hub and nodes work, signing in and network access, the launchd agents, every feature in detail, configuration and the API.

## Disclaimer

promptd is an independent project. It is not affiliated with, endorsed by, or sponsored by Anthropic. It runs prompts through Claude Code, which you install and sign in to separately. Claude, Claude Code and Anthropic are trademarks of Anthropic, PBC.

## License

Copyright 2026 Promptilicious. Licensed under the [Apache License, Version 2.0](LICENSE).
