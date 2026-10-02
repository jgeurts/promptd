import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type * as CronService from '../src/cronService.js';
import type * as Events from '../src/events.js';
import type * as JobCache from '../src/jobCache.js';
import type * as RunToolsModule from '../src/runTools.js';
import type { BusEvent, RunnableCron as Cron } from '../src/types.js';

/**
 * The project probe, held open until the test lets it go, so a Stop can land
 * while the run is between its commands before the prompt and starting claude.
 */
const probe = vi.hoisted(() => {
  let release = (): void => {};
  let began = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begun = new Promise<void>((resolve) => {
    began = resolve;
  });
  return { gate, begun, release: (): void => release(), began: (): void => began() };
});

vi.mock('../src/runTools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RunToolsModule>();
  return {
    ...actual,
    projectScope: async (): Promise<{ skills: string[]; agents: string[] }> => {
      probe.began();
      await probe.gate;
      return { skills: [], agents: [] };
    },
  };
});

/** A stand-in claude that leaves a mark when it runs, which this test expects it never to. */
const FAKE_CLAUDE = `#!/usr/bin/env node
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'started.txt'), '');
console.log(JSON.stringify({ type: 'result', result: 'ran', total_cost_usd: 0, duration_ms: 1, usage: {} }));
`;

let bin: string;
let service: typeof CronService;
let cache: typeof JobCache;
let events: typeof Events;

beforeAll(async () => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-claude-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  process.env.CLAUDE_BIN = path.join(bin, 'claude');
  process.env.PROMPTD_NODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-node-'));
  cache = await import('../src/jobCache.js');
  events = await import('../src/events.js');
  service = await import('../src/cronService.js');
});

function cron(id: string): Cron {
  return {
    id,
    name: id,
    nameInferred: false,
    description: '',
    cron: '0 9 * * *',
    timezone: '',
    workingDirectory: os.tmpdir(),
    useWorktree: false,
    cleanupWorktree: false,
    retrospective: false,
    model: '',
    effort: '',
    usageDelay: { credits: false, fable: false, session: false, weekly: false },
    prePromptCommands: ['true'],
    prompt: 'Do the task.',
    isActive: false,
    projectId: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
  };
}

describe('a Stop while the project is being looked at', () => {
  it('ends the run as stopped without starting claude', async () => {
    const id = 'probe-stop';
    cache.replaceJobs({
      crons: [cron(id)],
      executions: [],
      settings: { maxConcurrentJobs: 0, usageDelayThresholds: { credits: 90, fable: 95, session: 90, weekly: 95 }, defaultWorktreeInclude: '', retrospectivePrompt: '' },
    });
    const finished = new Promise<BusEvent>((resolve) => {
      const check = (event: BusEvent): void => {
        if (event.type === 'run:finished' && event.cronId === id) {
          events.bus.off('event', check);
          resolve(event);
        }
      };
      events.bus.on('event', check);
    });

    const started = await service.cronService.trigger(id);
    await probe.begun;
    const stopped = await service.cronService.stop(id);
    expect(stopped?.stopping).toBe(true);
    probe.release();

    const event = await finished;
    expect(event).toMatchObject({ status: 'stopped' });
    expect(fs.existsSync(path.join(bin, 'started.txt'))).toBe(false);
    const logFile = String(started && 'logFile' in started ? started.logFile : '');
    const log = fs.readFileSync(path.join(cache.logDir(id), logFile), 'utf8');
    expect(log).toContain('--- stop requested by user at ');
    expect(log).toMatch(/\n--- stopped after [\d.]+s \(killed by user before claude started\) ---\n$/);
  });
});
