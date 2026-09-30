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

## Run it

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
