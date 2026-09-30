import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type * as CronService from '../src/cronService.js';
import type * as Events from '../src/events.js';
import type * as JobCache from '../src/jobCache.js';
import type { BusEvent, RunnableCron } from '../src/types.js';

/** A stand-in for the claude CLI: records its arguments next to itself, then reports a result. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0, duration_ms: 10, usage: {} }));
`;

let bin: string;
let base: string;
let service: typeof CronService;
let cache: typeof JobCache;
let events: typeof Events;

beforeAll(async () => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-claude-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  process.env.CLAUDE_BIN = path.join(bin, 'claude');
  process.env.PROMPTD_NODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-node-'));
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-folders-'));
  cache = await import('../src/jobCache.js');
  events = await import('../src/events.js');
  service = await import('../src/cronService.js');
});

function cron(id: string, workingDirectory: string): RunnableCron {
  return {
    id,
    name: id,
    nameInferred: false,
    description: '',
    cron: '0 9 * * *',
    timezone: '',
    workingDirectory,
    // What a job that leaves the setting to a default of worktrees on arrives with.
    useWorktree: true,
    cleanupWorktree: false,
    retrospective: false,
    model: '',
    effort: '',
    usageDelay: { credits: false, fable: false, session: false, weekly: false },
    prompt: 'Do the task.',
    isActive: false,
    projectId: null,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
  };
}

/** Runs one job to the end; answers its log and the arguments claude was started with. */
async function run(job: RunnableCron): Promise<{ log: string; args: string[] }> {
  cache.replaceJobs({
    crons: [job],
    executions: [],
    settings: { maxConcurrentJobs: 0, usageDelayThresholds: { credits: 90, fable: 95, session: 90, weekly: 95 }, defaultWorktreeInclude: 'node_modules/\n', retrospectivePrompt: '', jobDefaults: { useWorktree: true, cleanupWorktree: true, retrospective: false, model: '', effort: '', usageDelay: { session: true, weekly: false, fable: false, credits: false } } },
  });
  const finished = new Promise<void>((resolve) => {
    const check = (event: BusEvent): void => {
      if (event.type === 'run:finished' && event.cronId === job.id) {
        events.bus.off('event', check);
        resolve();
      }
    };
    events.bus.on('event', check);
  });
  const started = await service.cronService.trigger(job.id);
  await finished;
  const file = String(started && 'logFile' in started ? started.logFile : '');
  return {
    log: fs.readFileSync(path.join(cache.logDir(job.id), file), 'utf8'),
    args: JSON.parse(fs.readFileSync(path.join(bin, 'args.json'), 'utf8')) as string[],
  };
}

describe('a run with Use worktree on', () => {
  it('goes without a worktree in a folder outside git, and says so in the header', async () => {
    const folder = path.join(base, 'notes');
    fs.mkdirSync(folder);
    const { log, args } = await run(cron('outside', folder));
    expect(args).not.toContain('--worktree');
    expect(log).toContain(`Use worktree      false (on for this job, but ${folder} is not in a git repository, so this run has none)`);
    expect(log).toContain('.worktreeinclude  not written: this run has no worktree');
    expect(log).not.toContain('--- worktree notice ---');
    expect(fs.existsSync(path.join(folder, '.worktreeinclude'))).toBe(false);
  });

  it('uses one in a folder inside git', async () => {
    const repo = path.join(base, 'app');
    fs.mkdirSync(repo);
    execFileSync('git', ['-C', repo, 'init', '-q']);
    const { log, args } = await run(cron('inside', repo));
    expect(args).toEqual(expect.arrayContaining(['--worktree', 'inside']));
    expect(log).toContain('Use worktree      true');
    expect(log).toContain('--- worktree notice ---');
  });
});
