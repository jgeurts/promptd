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
 * while the run is between whatever came before and starting claude.
 */
const probe = vi.hoisted(() => {
  let onBegin: (() => void) | null = null;
  const waiting: (() => void)[] = [];
  return {
    /** Resolves when the next probe begins; that probe then waits for release(). */
    begun: (): Promise<void> =>
      new Promise<void>((resolve) => {
        onBegin = resolve;
      }),
    release: (): void => {
      for (const go of waiting.splice(0)) go();
    },
    hold: async (): Promise<void> => {
      onBegin?.();
      onBegin = null;
      await new Promise<void>((resolve) => waiting.push(resolve));
    },
  };
});

vi.mock('../src/runTools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RunToolsModule>();
  return {
    ...actual,
    projectScope: async (): Promise<{ skills: string[]; agents: string[] }> => {
      await probe.hold();
      return { skills: [], agents: [] };
    },
  };
});

/** A stand-in claude that leaves a mark when it runs, which these tests expect it never to. */
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

function cron(id: string, prePromptCommands: string[]): Cron {
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
    prePromptCommands,
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

/** Triggers the job, Stops it while its probe is held open, lets the probe go, and answers how the run ended. */
async function stopDuringProbe(id: string, prePromptCommands: string[]): Promise<{ log: string; status: unknown; stopping: boolean | undefined }> {
  cache.replaceJobs({
    crons: [cron(id, prePromptCommands)],
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
  // Not awaited yet: a run without commands before the prompt answers its
  // trigger only once the probe is over, and the probe waits on this test.
  const begun = probe.begun();
  const triggered = service.cronService.trigger(id);
  await begun;
  const stopped = await service.cronService.stop(id);
  probe.release();
  const started = await triggered;
  const event = await finished;
  const logFile = String(started && 'logFile' in started ? started.logFile : '');
  return { log: fs.readFileSync(path.join(cache.logDir(id), logFile), 'utf8'), status: 'status' in event ? event.status : null, stopping: stopped?.stopping };
}

describe('a Stop while the project is being looked at', () => {
  it('ends a run with commands before the prompt as stopped, without starting claude', async () => {
    const { log, status, stopping } = await stopDuringProbe('probe-stop-setup', ['true']);
    expect(stopping).toBe(true);
    expect(status).toBe('stopped');
    expect(fs.existsSync(path.join(bin, 'started.txt'))).toBe(false);
    expect(log).toContain('--- stop requested by user at ');
    expect(log).toMatch(/\n--- stopped after [\d.]+s \(killed by user before claude started\) ---\n$/);
  });

  it('ends a run without commands before the prompt the same way', async () => {
    const { log, status, stopping } = await stopDuringProbe('probe-stop-plain', []);
    expect(stopping).toBe(true);
    expect(status).toBe('stopped');
    expect(fs.existsSync(path.join(bin, 'started.txt'))).toBe(false);
    expect(log).toContain('--- stop requested by user at ');
    expect(log).toMatch(/\n--- stopped after [\d.]+s \(killed by user before claude started\) ---\n$/);
  });
});
