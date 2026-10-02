import { describe, expect, it } from 'vitest';

import { activityView, byActivity, jobUpdate, readRequests } from '../src/jobActivity.js';
import type { JobActivity, RankedJob } from '../src/jobActivity.js';
import type { BusEvent } from '../src/types.js';

function event(type: string, fields: Record<string, unknown> = {}): BusEvent {
  return { type, at: '2026-10-01T12:00:00.000Z', cronId: 'job-1', cronName: 'Nightly', kind: 'cron', ...fields };
}

describe('what counts as an update', () => {
  it('is a run starting', () => {
    expect(jobUpdate(event('run:started', { logFile: 'run.txt' }))).toEqual({
      jobId: 'job-1',
      jobKind: 'cron',
      kind: 'started',
      at: '2026-10-01T12:00:00.000Z',
      logFile: 'run.txt',
    });
  });

  it.each(['succeeded', 'failed', 'stopped', 'interrupted'])('is a run that ended %s', (status) => {
    expect(jobUpdate(event('run:finished', { status, logFile: 'run.txt' }))).toMatchObject({ kind: status, logFile: 'run.txt' });
  });

  it('is a trigger starting to wait on a usage limit, and again once it is late', () => {
    expect(jobUpdate(event('run:delayed', { hold: 'usage' }))).toMatchObject({ kind: 'waiting', logFile: null });
    expect(jobUpdate(event('run:delayed', { hold: 'usage', late: true }))).toMatchObject({ kind: 'late' });
  });

  it('names the kind of job it happened to', () => {
    expect(jobUpdate(event('run:started', { kind: 'execution' }))).toMatchObject({ jobKind: 'execution' });
  });

  it.each([
    ['a place in the queue for a slot', 'run:delayed', { hold: 'concurrency', position: 0 }],
    ['a skipped trigger', 'run:skipped', { reason: 'already running' }],
    ['a trigger a pause dropped', 'run:dropped', { reason: 'all crons are paused' }],
    ['a held trigger let go', 'run:released', { ran: true }],
    ['a stop being asked for', 'run:stopping', {}],
    ['a retrospective, which comes with the end of its run', 'run:retrospective', { logFile: 'run.txt' }],
    ['a missed one-time trigger, which comes with its run starting', 'execution:overdue', { lateBy: '5m' }],
    ['a worktree that could not be cleaned away, which comes with the end of its run', 'worktree:cleanup-failed', { error: 'busy' }],
    ['an edit', 'crons:changed', {}],
    ['a notification', 'notification:new', {}],
  ])('is not %s', (_what, type, fields) => {
    expect(jobUpdate(event(type, fields))).toBeNull();
  });

  it('is not a run ending in a way it does not know', () => {
    expect(jobUpdate(event('run:finished', { status: 'exploded' }))).toBeNull();
  });

  it('is not an event about no job', () => {
    expect(jobUpdate(event('run:started', { cronId: undefined }))).toBeNull();
  });
});

describe('a job as the API shows its activity', () => {
  const job = { createdAt: '2026-09-01T00:00:00.000Z', lastRunAt: '2026-09-20T00:00:00.000Z' };

  it('is read, and as recent as its last run, when nothing has happened since this existed', () => {
    expect(activityView(job, undefined)).toEqual({ revision: 0, unread: false, lastActivityAt: '2026-09-20T00:00:00.000Z', update: null });
    expect(activityView({ createdAt: job.createdAt, lastRunAt: null }, undefined).lastActivityAt).toBe(job.createdAt);
  });

  it('is unread while its revision is ahead of the one last read, and says what the latest update was', () => {
    const row = {
      jobId: 'job-1',
      revision: 3,
      readRevision: 2,
      lastActivityAt: '2026-10-01T12:00:01.000Z',
      updateKind: 'failed',
      updateAt: '2026-10-01T12:00:00.000Z',
      updateLogFile: 'run.txt',
    };
    expect(activityView(job, row)).toEqual({
      revision: 3,
      unread: true,
      lastActivityAt: '2026-10-01T12:00:01.000Z',
      update: { kind: 'failed', at: '2026-10-01T12:00:00.000Z', logFile: 'run.txt' },
    });
    expect(activityView(job, { ...row, readRevision: 3 }).unread).toBe(false);
  });
});

describe('the Activity sort', () => {
  const activity = (at: string, unread = false): JobActivity => ({ revision: unread ? 1 : 0, unread, lastActivityAt: at, update: null });
  const job = (id: string, fields: Partial<RankedJob> & { at?: string; unread?: boolean } = {}): RankedJob => ({
    id,
    isRunning: false,
    isDelayed: false,
    ...fields,
    activity: activity(fields.at ?? '2026-10-01T00:00:00.000Z', fields.unread),
  });
  const order = (jobs: RankedJob[]) => [...jobs].sort(byActivity).map((ranked) => ranked.id);

  it('puts running first, then waiting, then unread, then the rest', () => {
    const jobs = [
      job('read', { at: '2026-10-01T09:00:00.000Z' }),
      job('unread', { unread: true, at: '2026-10-01T01:00:00.000Z' }),
      job('waiting', { isDelayed: true, at: '2026-09-01T00:00:00.000Z' }),
      job('running', { isRunning: true, at: '2026-08-01T00:00:00.000Z' }),
    ];
    expect(order(jobs)).toEqual(['running', 'waiting', 'unread', 'read']);
  });

  it('orders each tier newest activity first', () => {
    const jobs = [
      job('old-unread', { unread: true, at: '2026-10-01T01:00:00.000Z' }),
      job('new-read', { at: '2026-10-01T09:00:00.000Z' }),
      job('new-unread', { unread: true, at: '2026-10-01T05:00:00.000Z' }),
      job('old-read', { at: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(order(jobs)).toEqual(['new-unread', 'old-unread', 'new-read', 'old-read']);
  });

  it('keeps two equal jobs in one order, whatever order they came in', () => {
    expect(order([job('b'), job('a')])).toEqual(['a', 'b']);
    expect(order([job('a'), job('b')])).toEqual(['a', 'b']);
  });
});

describe('a request to mark jobs read', () => {
  it('takes each id with the revision it was shown at', () => {
    expect(readRequests({ items: [{ id: 'a', revision: 3 }, { id: 'b', revision: 0 }] })).toEqual({
      items: [
        { id: 'a', revision: 3 },
        { id: 'b', revision: 0 },
      ],
    });
  });

  it.each([
    ['no items', {}],
    ['an empty list', { items: [] }],
    ['an item without its revision', { items: [{ id: 'a' }] }],
    ['a revision that is not a count', { items: [{ id: 'a', revision: 1.5 }] }],
    ['a negative revision', { items: [{ id: 'a', revision: -1 }] }],
    ['an item without its id', { items: [{ revision: 2 }] }],
  ])('refuses %s', (_what, body) => {
    expect(readRequests(body)).toHaveProperty('error');
  });
});
