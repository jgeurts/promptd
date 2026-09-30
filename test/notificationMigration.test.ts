import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type * as DbModule from '../src/db.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-migration-'));
process.env.PROMPTD_HOME = home;

let dbModule: typeof DbModule;

/** Rows as the code before levels wrote them, and the level each should come out as. */
const OLD_ROWS: Array<{ kind: string; message: string; cronName: string | null; read: 0 | 1; level: string }> = [
  { kind: 'run-failed', message: '"Restart stopped services" failed in 4s', cronName: 'Restart stopped services', read: 0, level: 'action' },
  { kind: 'run-failed', message: '"Nightly" stopped in 3s', cronName: 'Nightly', read: 0, level: 'routine' },
  { kind: 'run-failed', message: 'one-time "Backfill" interrupted', cronName: 'Backfill', read: 0, level: 'action' },
  { kind: 'run-failed', message: 'one-time "Backfill" stopped', cronName: 'Backfill', read: 0, level: 'routine' },
  { kind: 'run-failed', message: '"Stopped clock" failed in 9s', cronName: 'Stopped clock', read: 0, level: 'action' },
  { kind: 'worktree-failed', message: '"Tidy" worktree clean up failed: the process was stopped', cronName: 'Tidy', read: 0, level: 'action' },
  { kind: 'system', message: 'Low disk space: 9% of the volume is free. No crons were running.', cronName: null, read: 0, level: 'action' },
  { kind: 'system', message: 'High CPU: 91% of all cores, averaged over the last minute. No crons were running.', cronName: null, read: 0, level: 'worth' },
  { kind: 'update', message: 'Update script failed (exit 1); schedules resumed', cronName: null, read: 0, level: 'action' },
  { kind: 'update', message: 'Update started from abc1234; the service will restart', cronName: null, read: 0, level: 'worth' },
  { kind: 'update', message: 'Update available: 2 commits behind origin/main', cronName: null, read: 0, level: 'routine' },
  { kind: 'delayed', message: '"Nightly" is waiting on Weekly', cronName: 'Nightly', read: 0, level: 'worth' },
  { kind: 'delayed', message: 'one-time "Backfill" missed its trigger by 5m; running now', cronName: 'Backfill', read: 0, level: 'worth' },
  {
    kind: 'delayed',
    message: '"Report is waiting on data" is queued at position 1 of 2, behind 3 running jobs',
    cronName: 'Report is waiting on data',
    read: 0,
    level: 'routine',
  },
  { kind: 'retrospective', message: '"Nightly" left a retrospective', cronName: 'Nightly', read: 0, level: 'worth' },
  { kind: 'run', message: '"Nightly" succeeded in 3s', cronName: 'Nightly', read: 0, level: 'routine' },
];

beforeAll(async () => {
  dbModule = await import('../src/db.js');
  dbModule.openDatabase(`sqlite:${path.join(home, 'old.sqlite')}`);
  // The store as it stood just before levels, filled with what it held then.
  await dbModule.migrate('20260930_002_notification_nodes');
  for (const [index, row] of OLD_ROWS.entries()) {
    await sql`
      insert into notifications (id, at, kind, message, read, cron_id, cron_name, job_kind)
      values (${`old-${index}`}, ${new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString()}, ${row.kind}, ${row.message}, ${row.read},
              ${row.cronName ? 'job' : null}, ${row.cronName}, 'cron')
    `.execute(dbModule.db());
  }
  await dbModule.migrate();
});

afterAll(async () => {
  await dbModule.closeDatabase();
});

describe('the levels given to notifications written before there were levels', () => {
  it.each(OLD_ROWS.map((row, index) => [row.message, row.level, index] as const))('files %s as %s', async (_message, level, index) => {
    const row = await dbModule.db().selectFrom('notifications').select(['level', 'read']).where('id', '=', `old-${index}`).executeTakeFirstOrThrow();
    expect(row.level).toBe(level);
    // Routine arrives read, so the old routine rows are read now too; the rest keep their state.
    expect(row.read).toBe(level === 'routine' ? 1 : 0);
  });
});
