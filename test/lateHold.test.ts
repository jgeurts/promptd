import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as CronService from '../src/cronService.js';
import type * as Events from '../src/events.js';
import type * as JobCache from '../src/jobCache.js';
import type * as Notifications from '../src/notifications.js';
import type * as Usage from '../src/usage.js';
import type { BusEvent, RunnableCron as Cron, UsageReading } from '../src/types.js';

let service: typeof CronService;
let cache: typeof JobCache;
let events: typeof Events;
let notifications: typeof Notifications;
let usage: typeof Usage;

beforeAll(async () => {
  process.env.PROMPTD_NODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-node-'));
  cache = await import('../src/jobCache.js');
  events = await import('../src/events.js');
  service = await import('../src/cronService.js');
  notifications = await import('../src/notifications.js');
  usage = await import('../src/usage.js');
});

afterEach(async () => {
  await service.cronService.cancelDelay('held');
  vi.restoreAllMocks();
});

/** A cron that waits while the weekly limit is spent. */
function heldCron(): Cron {
  return {
    id: 'held',
    name: 'Weekly cleanup',
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
    usageDelay: { credits: false, fable: false, session: false, weekly: true },
    prePromptCommands: [],
    prompt: 'Tidy up.',
    isActive: true,
    projectId: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
  };
}

/** Every usage read answers with the weekly limit spent, resetting at `resetsAt`. */
function weeklySpent(resetsAt: Date): void {
  const reading: UsageReading = {
    ok: true,
    reason: null,
    checkedAt: new Date().toISOString(),
    stale: false,
    windows: [
      { key: 'weekly_all', kind: 'weekly_all', scope: null, label: 'Weekly', detail: '', usedPercent: 99, severity: 'critical', resetsAt: resetsAt.toISOString() },
    ],
  };
  vi.spyOn(usage.usageMonitor, 'state').mockResolvedValue(reading);
  vi.spyOn(usage.usageMonitor, 'settled').mockResolvedValue(reading);
}

/** The held trigger's announcements while `act` runs, as the drawer would level them. */
async function levelsDuring(act: () => Promise<unknown>): Promise<string[]> {
  const seen: BusEvent[] = [];
  const onEvent = (event: BusEvent): void => {
    if (event.type === 'run:delayed' && event.cronId === 'held') seen.push(event);
  };
  events.bus.on('event', onEvent);
  try {
    await act();
  } finally {
    events.bus.off('event', onEvent);
  }
  return seen.map((event) => notifications.describe(event as never)?.level ?? 'none');
}

const minutes = (count: number): Date => new Date(Date.now() + count * 60 * 1000);

describe('a trigger held for usage', () => {
  it('is worth knowing while its limit is expected to reset, and needs action once that time is well past', async () => {
    cache.replaceJobs({ crons: [heldCron()], executions: [] });
    weeklySpent(minutes(60));
    expect(await levelsDuring(() => service.cronService.trigger('held', 'schedule'))).toEqual(['worth']);

    // Not yet due, then due a moment ago: a reset can read as spent until the next usage refresh.
    expect(await levelsDuring(() => service.cronService.reviewDelays())).toEqual([]);
    weeklySpent(minutes(-1));
    expect(await levelsDuring(() => service.cronService.reviewDelays())).toEqual([]);

    // Past the reset by more than a refresh and a review: something else is holding it.
    weeklySpent(minutes(-10));
    expect(await levelsDuring(() => service.cronService.reviewDelays())).toEqual(['action']);
    // Said once, not on every review after.
    expect(await levelsDuring(() => service.cronService.reviewDelays())).toEqual([]);
  });

  it('is never late when its limit says nothing about when it resets', async () => {
    cache.replaceJobs({ crons: [heldCron()], executions: [] });
    weeklySpent(minutes(60));
    await service.cronService.trigger('held', 'schedule');
    const reading = await usage.usageMonitor.state();
    vi.spyOn(usage.usageMonitor, 'state').mockResolvedValue({ ...reading, windows: reading.windows.map((window) => ({ ...window, resetsAt: null })) });
    expect(await levelsDuring(() => service.cronService.reviewDelays())).toEqual([]);
  });
});
