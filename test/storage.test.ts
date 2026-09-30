import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sql } from 'kysely';

import type * as DbModule from '../src/db.js';
import type * as ExecutionsModule from '../src/executions.js';
import type * as JobDefaultsModule from '../src/jobDefaults.js';
import type * as JobFormsModule from '../src/jobForms.js';
import type * as ProjectsModule from '../src/projects.js';
import type * as SettingsModule from '../src/settings.js';
import type * as StoreModule from '../src/store.js';
import type { CronInput } from '../src/types.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-storage-'));
process.env.PROMPTD_HOME = home;

let dbModule: typeof DbModule;
let store: typeof StoreModule;
let executions: typeof ExecutionsModule;
let projects: typeof ProjectsModule;
let settings: typeof SettingsModule;
let jobForms: typeof JobFormsModule;
let jobDefaults: typeof JobDefaultsModule;

beforeAll(async () => {
  dbModule = await import('../src/db.js');
  store = await import('../src/store.js');
  executions = await import('../src/executions.js');
  projects = await import('../src/projects.js');
  settings = await import('../src/settings.js');
  jobForms = await import('../src/jobForms.js');
  jobDefaults = await import('../src/jobDefaults.js');
});

afterAll(async () => {
  await dbModule.closeDatabase();
});

const targets = [
  { name: 'sqlite', url: `sqlite:${path.join(home, 'test.sqlite')}` },
  ...(process.env.TEST_DATABASE_URL ? [{ name: 'postgres', url: process.env.TEST_DATABASE_URL }] : []),
];

const cronInput: CronInput = {
  name: 'Nightly digest',
  description: 'Summarize the day',
  cron: '0 9 * * *',
  timezone: 'America/Chicago',
  workingDirectory: '~/code',
  useWorktree: true,
  cleanupWorktree: false,
  retrospective: true,
  model: 'sonnet',
  effort: 'high',
  usageDelay: { credits: false, fable: false, session: true, weekly: false },
  prompt: 'Write two lines.',
  isActive: true,
  nodeId: '',
  projectId: null,
};

describe.each(targets)('storage on $name', ({ url }) => {
  beforeAll(async () => {
    await dbModule.closeDatabase();
    dbModule.openDatabase(url);
    await dbModule.migrate();
  });

  beforeEach(async () => {
    const db = dbModule.db();
    for (const table of ['crons', 'executions', 'notifications', 'settings', 'nodes', 'projects'] as const) {
      await db.deleteFrom(table).execute();
    }
  });

  it('keeps a cron exactly as it was saved', async () => {
    const created = await store.createCron(cronInput);
    expect(await store.getCron(created.id)).toEqual(created);
    expect(created.lifetimeRuns).toBeUndefined();
  });

  it('lists crons by name', async () => {
    await store.createCron({ ...cronInput, name: 'b' });
    await store.createCron({ ...cronInput, name: 'a' });
    expect((await store.listCrons()).map((cron) => cron.name)).toEqual(['a', 'b']);
  });

  it('records run bookkeeping and fractional counters', async () => {
    const { id } = await store.createCron(cronInput);
    await store.patchCron(id, { lastRunStatus: 'succeeded', lifetimeRuns: 3, lifetimeCostUsd: 1.2345, lifetimeRuntimeSeconds: 61.5 });
    expect(await store.getCron(id)).toMatchObject({ lastRunStatus: 'succeeded', lifetimeRuns: 3, lifetimeCostUsd: 1.2345, lifetimeRuntimeSeconds: 61.5 });
  });

  it('keeps run bookkeeping through an edit', async () => {
    const { id } = await store.createCron(cronInput);
    await store.patchCron(id, { lifetimeRuns: 4 });
    const updated = await store.updateCron(id, { ...cronInput, name: 'Renamed', isActive: false });
    expect(updated).toMatchObject({ name: 'Renamed', isActive: false, lifetimeRuns: 4 });
    expect(await store.getCron(id)).toEqual(updated);
  });

  it('deletes a cron once', async () => {
    const { id } = await store.createCron(cronInput);
    expect(await store.deleteCron(id)).toBe(true);
    expect(await store.deleteCron(id)).toBe(false);
    expect(await store.getCron(id)).toBeNull();
  });

  it('re-arms an execution whose date moves, and pages newest first', async () => {
    const early = await executions.createExecution({ ...cronInput, scheduledAt: '2026-01-01T00:00:00.000Z' });
    const late = await executions.createExecution({ ...cronInput, scheduledAt: '2026-06-01T00:00:00.000Z' });
    await executions.patchExecution(early.id, { status: 'done', firedAt: '2026-01-01T00:00:01.000Z' });

    const rescheduled = await executions.updateExecution(early.id, { ...cronInput, scheduledAt: '2027-01-01T00:00:00.000Z' });
    expect(rescheduled).toMatchObject({ status: 'scheduled', firedAt: null, cleanupWorktree: true });

    const first = await executions.pageExecutions({ limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual([early.id]);
    expect(first).toMatchObject({ total: 2, scheduled: 2 });
    const second = await executions.pageExecutions({ before: first.nextBefore, limit: 1 });
    expect(second.items.map((item) => item.id)).toEqual([late.id]);
    expect(second.nextBefore).toBeNull();
  });

  it('ungroups a deleted project\'s jobs rather than deleting them', async () => {
    const project = await projects.createProject({ name: 'Billing', description: '' });
    const cron = await store.createCron({ ...cronInput, projectId: project.id });
    const execution = await executions.createExecution({ ...cronInput, projectId: project.id, scheduledAt: '2026-01-01T00:00:00.000Z' });
    expect(await store.getCron(cron.id)).toMatchObject({ projectId: project.id });

    expect(await projects.deleteProject(project.id)).toBe(true);
    expect(await projects.listProjects()).toEqual([]);
    expect(await store.getCron(cron.id)).toMatchObject({ projectId: null });
    expect(await executions.getExecution(execution.id)).toMatchObject({ projectId: null });
  });

  it('writes the default settings once and patches one key without touching others', async () => {
    const defaults = await settings.loadSettings();
    expect(defaults.selfUpdate).toBe(true);
    await settings.patchSettings({ serverName: 'Office' });
    await settings.patchSettings({ updateCheckIntervalHours: 6 });
    expect(await settings.loadSettings()).toMatchObject({ serverName: 'Office', updateCheckIntervalHours: 6, selfUpdate: true });
  });

  it('keeps the settings a job leaves to the defaults as null, and answers what it would use', async () => {
    const body = { name: 'Follows', cron: '0 9 * * *', prompt: 'Tidy up.', isActive: true, model: 'haiku', useWorktree: null, usageDelay: { weekly: true } };
    const { errors, value } = jobForms.readCronForm(body);
    expect(errors).toEqual([]);
    const created = await store.createCron(value);
    const stored = await store.getCron(created.id);
    expect(stored).toMatchObject({
      useWorktree: null,
      cleanupWorktree: null,
      retrospective: null,
      model: 'haiku',
      effort: null,
      usageDelay: { session: null, weekly: true, fable: null, credits: null },
    });

    const cluster = { ...jobDefaults.BUILT_IN_JOB_DEFAULTS, effort: 'low' };
    expect(jobForms.withEffective(stored!, cluster).effective).toEqual({
      useWorktree: true,
      cleanupWorktree: true,
      retrospective: false,
      model: 'haiku',
      effort: 'low',
      usageDelay: { session: true, weekly: true, fable: false, credits: false },
    });

    // Saving the job again with an override, and then with it cleared, lands where it says.
    const edited = jobForms.readCronForm({ ...body, useWorktree: false, model: null });
    await store.updateCron(created.id, edited.value);
    expect(jobForms.withEffective((await store.getCron(created.id))!, cluster)).toMatchObject({
      useWorktree: false,
      model: null,
      effective: { useWorktree: false, model: '', effort: 'low' },
    });
  });
});

describe('the migration to job setting defaults', () => {
  const file = path.join(home, 'upgrade.sqlite');

  beforeAll(async () => {
    await dbModule.closeDatabase();
    dbModule.openDatabase(`sqlite:${file}`);
    await dbModule.migrate('20260930_001_projects');
    const db = dbModule.db();
    const job = (id: string, model: string, effort: string, flags: [number, number, number], usageDelay: string) =>
      sql`insert into crons (id, name, description, working_directory, use_worktree, cleanup_worktree, retrospective, model, effort, usage_delay, prompt, is_active, node_id, created_at, updated_at, cron, timezone)
        values (${id}, ${id}, '', '~/', ${flags[0]}, ${flags[1]}, ${flags[2]}, ${model}, ${effort}, ${usageDelay}, 'Do it.', 1, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '0 9 * * *', '')`.execute(db);
    await job('blank', '', '', [0, 0, 0], '{"session":false,"weekly":false,"fable":false,"credits":false}');
    await job('set', 'opus', 'high', [1, 1, 1], '{"session":true}');
    await dbModule.migrate();
  });

  afterAll(async () => {
    await dbModule.closeDatabase();
  });

  it('turns a blank model and effort into following the defaults', async () => {
    expect(await store.getCron('blank')).toMatchObject({ model: null, effort: null });
  });

  it('keeps every other stored value as the job\'s own, so nothing runs differently', async () => {
    expect(await store.getCron('blank')).toMatchObject({
      useWorktree: false,
      cleanupWorktree: false,
      retrospective: false,
      usageDelay: { session: false, weekly: false, fable: false, credits: false },
    });
    expect(await store.getCron('set')).toMatchObject({
      useWorktree: true,
      cleanupWorktree: true,
      retrospective: true,
      model: 'opus',
      effort: 'high',
      // A box the stored set left out meant off, and still does.
      usageDelay: { session: true, weekly: false, fable: false, credits: false },
    });
  });

  it('lets a job store null once migrated', async () => {
    await store.patchCron('set', { model: null, useWorktree: null });
    expect(await store.getCron('set')).toMatchObject({ model: null, useWorktree: null });
  });
});

describe('log search', () => {
  it('keeps only the runs whose log contains the query, ignoring case', async () => {
    fs.mkdirSync(store.logDir('search-cron'), { recursive: true });
    fs.writeFileSync(store.logPath('search-cron', '2026-01-01T00-00-00.000Z.txt'), 'Build FAILED at step 3');
    fs.writeFileSync(store.logPath('search-cron', '2026-01-02T00-00-00.000Z.txt'), 'all good');
    const logs = await store.listLogs('search-cron');

    const files = async (query: string) => (await store.filterLogs('search-cron', logs, query)).map((log) => log.file);
    expect(await files('failed')).toEqual(['2026-01-01T00-00-00.000Z.txt']);
    expect(await files('  GOOD ')).toEqual(['2026-01-02T00-00-00.000Z.txt']);
    expect(await files('nowhere')).toEqual([]);
    expect(await files('')).toHaveLength(2);
  });
});
