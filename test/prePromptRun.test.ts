import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type * as CronService from '../src/cronService.js';
import type * as Events from '../src/events.js';
import type * as JobCache from '../src/jobCache.js';
import type { BusEvent, RunnableCron } from '../src/types.js';

/** A stand-in for the claude CLI: notes where it ran and with what, then reports a result. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'claude.json'), JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
fs.appendFileSync(path.join(__dirname, 'order'), 'claude\\n');
console.log(JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0, duration_ms: 10, usage: {} }));
`;

let bin: string;
let base: string;
let service: typeof CronService;
let cache: typeof JobCache;
let events: typeof Events;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

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

beforeEach(() => {
  for (const file of ['claude.json', 'order']) fs.rmSync(path.join(bin, file), { force: true });
  delete process.env.PROMPTD_PRE_PROMPT_TIMEOUT_SECONDS;
});

let jobs = 0;

function cron(workingDirectory: string, prePromptCommands: string[], overrides: Partial<RunnableCron> = {}): RunnableCron {
  jobs += 1;
  const id = `job-${jobs}`;
  return {
    id,
    name: id,
    nameInferred: false,
    description: '',
    cron: '0 9 * * *',
    timezone: '',
    workingDirectory,
    useWorktree: true,
    cleanupWorktree: false,
    retrospective: false,
    model: '',
    effort: '',
    usageDelay: { credits: false, fable: false, session: false, weekly: false },
    prePromptCommands,
    prompt: 'Do the task.',
    isActive: false,
    projectId: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
    ...overrides,
  };
}

function finished(id: string): Promise<BusEvent> {
  return new Promise((resolve) => {
    const check = (event: BusEvent): void => {
      if (event.type === 'run:finished' && event.cronId === id) {
        events.bus.off('event', check);
        resolve(event);
      }
    };
    events.bus.on('event', check);
  });
}

interface Ran {
  log: string;
  event: BusEvent;
  claude: { cwd: string; args: string[] } | null;
  order: string[];
  /** How long trigger took to answer, which is not how long the run took. */
  answeredInMs: number;
}

function readLog(id: string, file: string): string {
  return fs.readFileSync(path.join(cache.logDir(id), file), 'utf8');
}

async function start(job: RunnableCron): Promise<{ file: string; done: Promise<BusEvent>; answeredInMs: number }> {
  cache.replaceJobs({
    crons: [job],
    executions: [],
    settings: { maxConcurrentJobs: 0, usageDelayThresholds: { credits: 90, fable: 95, session: 90, weekly: 95 }, defaultWorktreeInclude: '', retrospectivePrompt: '' },
  });
  const done = finished(job.id);
  const asked = Date.now();
  const started = await service.cronService.trigger(job.id);
  const answeredInMs = Date.now() - asked;
  return { file: String(started && 'logFile' in started ? started.logFile : ''), done, answeredInMs };
}

async function run(job: RunnableCron): Promise<Ran> {
  const { file, done, answeredInMs } = await start(job);
  const event = await done;
  const claudeFile = path.join(bin, 'claude.json');
  return {
    log: readLog(job.id, file),
    event,
    claude: fs.existsSync(claudeFile) ? (JSON.parse(fs.readFileSync(claudeFile, 'utf8')) as Ran['claude']) : null,
    order: fs.existsSync(path.join(bin, 'order')) ? fs.readFileSync(path.join(bin, 'order'), 'utf8').trim().split('\n') : [],
    answeredInMs,
  };
}

/** A checkout cloned from a bare origin that has since had another commit pushed, with a package.json. */
function repoBehindOrigin(): { app: string; newest: string } {
  const root = fs.mkdtempSync(path.join(base, 'repo-'));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const pusher = path.join(root, 'pusher');
  execFileSync('git', ['clone', '-q', origin, pusher], { stdio: 'ignore' });
  fs.writeFileSync(path.join(pusher, 'package.json'), '{"name":"demo"}\n');
  git(pusher, 'add', 'package.json');
  git(pusher, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'one');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const app = path.join(root, 'app');
  execFileSync('git', ['clone', '-q', origin, app]);
  git(pusher, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  return { app, newest: git(pusher, 'rev-parse', 'HEAD') };
}

const record = (word: string): string => `echo ${word} >> ${path.join(bin, 'order')}`;

describe('commands before the prompt', () => {
  it('make the worktree claude would, run in it first, then start claude there without --worktree', async () => {
    const { app, newest } = repoBehindOrigin();
    const job = cron(app, [record('first'), `pwd > ${path.join(bin, 'pwd')}; ${record('second')}`, 'test -f package.json']);
    const ran = await run(job);
    const tree = path.join(fs.realpathSync(app), '.claude', 'worktrees', job.id);

    expect(ran.event.status).toBe('succeeded');
    expect(ran.order).toEqual(['first', 'second', 'claude']);
    expect(fs.readFileSync(path.join(bin, 'pwd'), 'utf8').trim()).toBe(tree);
    expect(ran.claude?.cwd).toBe(tree);
    expect(ran.claude?.args).not.toContain('--worktree');
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(newest);
    expect(git(tree, 'symbolic-ref', '--short', 'HEAD')).toBe(`worktree-${job.id}`);

    // The header names the commands, and their section comes before claude's output.
    expect(ran.log).toContain('Before prompt     3 commands, each through /bin/bash -e -o pipefail -c, 10m 0s for all of them');
    expect(ran.log).toContain(`  1  ${record('first')}`);
    const setup = ran.log.indexOf('--- before the prompt ---');
    const output = ran.log.indexOf('--- output ---');
    expect(setup).toBeGreaterThan(ran.log.indexOf('--- prompt ---'));
    expect(output).toBeGreaterThan(setup);
    expect(ran.log.slice(setup, output)).toContain(`worktree   created ${tree} on worktree-${job.id} from origin/main`);
    expect(ran.log.slice(setup, output)).toMatch(/\$ test -f package\.json\nexit 0 after [\d.]+s\n/);
    expect(ran.log.slice(output)).toContain('done');
  });

  it('answer the trigger at once and set up afterwards, so a long install holds nothing up', async () => {
    const job = cron(fs.mkdtempSync(path.join(base, 'plain-')), ['sleep 1.5'], { useWorktree: false });
    const { done, answeredInMs } = await start(job);
    expect(answeredInMs).toBeLessThan(1000);
    expect(service.cronService.isRunning(job.id)).toBe(true);
    expect((await done).status).toBe('succeeded');
  });

  it('fail the run on a command that fails, naming it, and never start claude', async () => {
    const { app } = repoBehindOrigin();
    const ran = await run(cron(app, [record('first'), 'false', record('never')]));
    expect(ran.event).toMatchObject({ status: 'failed', reason: 'false exited with 1 before the prompt' });
    expect(ran.order).toEqual(['first']);
    expect(ran.claude).toBeNull();
    expect(ran.log).toMatch(/\$ false\nexit 1 after [\d.]+s\n/);
    expect(ran.log).toMatch(/--- failed after [\d.]+s \(command 2 of 3 before the prompt exited with 1: false\) ---\n$/);
    expect(ran.log).not.toContain('--- output ---');
  });

  it('fail a line whose pipe fails part way, since they run with pipefail', async () => {
    const ran = await run(cron(fs.mkdtempSync(path.join(base, 'plain-')), ['false | cat'], { useWorktree: false }));
    expect(ran.event.status).toBe('failed');
    expect(ran.claude).toBeNull();
  });

  it('fail the run when they take longer than the time allowed', async () => {
    process.env.PROMPTD_PRE_PROMPT_TIMEOUT_SECONDS = '1';
    const started = Date.now();
    const ran = await run(cron(fs.mkdtempSync(path.join(base, 'plain-')), ['sleep 30'], { useWorktree: false }));
    expect(Date.now() - started).toBeLessThan(8000);
    expect(ran.event).toMatchObject({ status: 'failed', reason: 'its commands before the prompt ran past 1.0s, during sleep 30' });
    expect(ran.claude).toBeNull();
    expect(ran.log).toContain('stopped after');
  });

  it('stop on Stop, taking the command and what it started with it', async () => {
    const pidFile = path.join(bin, 'sleeper');
    const job = cron(fs.mkdtempSync(path.join(base, 'plain-')), [`sleep 60 & echo $! > ${pidFile}; wait`], { useWorktree: false });
    const { file, done } = await start(job);
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const sleeper = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(sleeper, 0)).not.toThrow();

    const asked = Date.now();
    await service.cronService.stop(job.id, 'tester');
    const event = await done;
    expect(Date.now() - asked).toBeLessThan(6000);
    expect(event.status).toBe('stopped');
    expect(fs.existsSync(path.join(bin, 'claude.json'))).toBe(false);
    expect(() => process.kill(sleeper, 0)).toThrow();
    expect(readLog(job.id, file)).toMatch(/--- stopped after [\d.]+s \(killed by tester during command 1 of 1 before the prompt\) ---\n$/);
  });

  it('run in the job\'s folder when it has no worktree, or no git repository', async () => {
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(base, 'notes-')));
    const ran = await run(cron(folder, [`pwd > ${path.join(bin, 'pwd')}`]));
    expect(ran.event.status).toBe('succeeded');
    expect(fs.readFileSync(path.join(bin, 'pwd'), 'utf8').trim()).toBe(folder);
    expect(ran.claude?.cwd).toBe(folder);
    expect(ran.log).toContain('(on for this job, but');
  });

  it('fail without touching a checkout elsewhere that already has the worktree branch', async () => {
    const { app } = repoBehindOrigin();
    const job = cron(app, ['true'], { cleanupWorktree: true });
    const elsewhere = path.join(path.dirname(app), 'elsewhere');
    git(app, 'worktree', 'add', '-q', '-b', `worktree-${job.id}`, elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'unsaved.txt'), 'work in progress\n');

    const ran = await run(job);
    expect(ran.event.status).toBe('failed');
    expect(ran.claude).toBeNull();
    expect(ran.log).toContain('Worktree cleanup: not cleaned up: this run did not get a worktree of its own');
    expect(fs.readFileSync(path.join(elsewhere, 'unsaved.txt'), 'utf8')).toBe('work in progress\n');
    expect(git(app, 'branch', '--list', `worktree-${job.id}`)).not.toBe('');
  });

  it('clean up only the tree they ran in, when the worktree branch is checked out somewhere else', async () => {
    const { app } = repoBehindOrigin();
    const job = cron(app, ['true'], { cleanupWorktree: true });
    const tree = path.join(app, '.claude', 'worktrees', job.id);
    git(app, 'worktree', 'add', '-q', '-b', 'feature', tree);
    const elsewhere = path.join(path.dirname(app), 'elsewhere-too');
    git(app, 'worktree', 'add', '-q', '-b', `worktree-${job.id}`, elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'unsaved.txt'), 'work in progress\n');

    const ran = await run(job);
    expect(ran.event.status).toBe('succeeded');
    expect(fs.existsSync(tree)).toBe(false);
    expect(fs.readFileSync(path.join(elsewhere, 'unsaved.txt'), 'utf8')).toBe('work in progress\n');
    expect(ran.log).toContain(`kept branch worktree-${job.id}, which ${fs.realpathSync(elsewhere)} has checked out`);
  });

  it('copy what .worktreeinclude names into a new worktree before the commands run', async () => {
    const { app } = repoBehindOrigin();
    fs.writeFileSync(path.join(app, '.git', 'info', 'exclude'), '.env\n');
    fs.writeFileSync(path.join(app, '.env'), 'TOKEN=demo\n');
    fs.writeFileSync(path.join(app, '.worktreeinclude'), '.env\n');
    const ran = await run(cron(app, ['grep -q TOKEN=demo .env']));
    expect(ran.event.status).toBe('succeeded');
    expect(ran.log).toContain('.worktreeinclude  copied 1 file: .env');
  });

  it('cap what one command can put in the log, keeping its end', async () => {
    const ran = await run(cron(fs.mkdtempSync(path.join(base, 'plain-')), ['head -c 1000000 /dev/zero | tr "\\0" x; echo; echo the-last-line'], { useWorktree: false }));
    expect(ran.event.status).toBe('succeeded');
    expect(ran.log).toMatch(/\[\.\.\. [\d,]+ bytes of output left out of this log \.\.\.\]/);
    expect(ran.log).toContain('the-last-line');
    expect(ran.log.length).toBeLessThan(400_000);
  });
});

describe('a run with no commands before the prompt', () => {
  it('starts claude with --worktree as it always has, and its log says nothing of them', async () => {
    const { app } = repoBehindOrigin();
    const ran = await run(cron(app, []));
    expect(ran.event.status).toBe('succeeded');
    expect(ran.claude?.args).toEqual(expect.arrayContaining(['--worktree', `job-${jobs}`]));
    expect(ran.claude?.cwd).toBe(fs.realpathSync(app));
    expect(ran.log).not.toContain('Before prompt');
    expect(ran.log).not.toContain('--- before the prompt ---');
    expect(ran.log).toMatch(/^pid {8}\d+$/m);
  });
});
