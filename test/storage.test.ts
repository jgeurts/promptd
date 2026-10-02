import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sql } from 'kysely';
import pg from 'pg';

import type * as DbModule from '../src/db.js';
import type * as ExecutionsModule from '../src/executions.js';
import type * as JobActivityModule from '../src/jobActivity.js';
import type * as JobDefaultsModule from '../src/jobDefaults.js';
import type * as JobFormsModule from '../src/jobForms.js';
import type * as ProjectsModule from '../src/projects.js';
import type * as SettingsModule from '../src/settings.js';
import type * as StoreModule from '../src/store.js';
import type { BusEvent, CronInput, Execution } from '../src/types.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-storage-'));
process.env.PROMPTD_HOME = home;

let dbModule: typeof DbModule;
let store: typeof StoreModule;
let executions: typeof ExecutionsModule;
let projects: typeof ProjectsModule;
let settings: typeof SettingsModule;
let jobForms: typeof JobFormsModule;
let jobDefaults: typeof JobDefaultsModule;
let activity: typeof JobActivityModule;

beforeAll(async () => {
  dbModule = await import('../src/db.js');
  store = await import('../src/store.js');
  executions = await import('../src/executions.js');
  projects = await import('../src/projects.js');
  settings = await import('../src/settings.js');
  jobForms = await import('../src/jobForms.js');
  jobDefaults = await import('../src/jobDefaults.js');
  activity = await import('../src/jobActivity.js');
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
  prePromptCommands: null,
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
    for (const table of ['crons', 'executions', 'notifications', 'settings', 'nodes', 'projects', 'jobActivity'] as const) {
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

  it('keeps a name inferred while it is saved back unchanged', async () => {
    const created = await store.createCron({ ...cronInput, name: 'Tidy up', nameInferred: true });
    expect(await store.getCron(created.id)).toMatchObject({ name: 'Tidy up', nameInferred: true });
    expect((await store.updateCron(created.id, { ...cronInput, name: 'Tidy up' }))?.nameInferred).toBe(true);
    expect((await store.updateCron(created.id, { ...cronInput, name: 'Mine' }))?.nameInferred).toBe(false);
  });

  it('puts a title in place only while the name is still the inferred one, for both kinds', async () => {
    const inferred = { ...cronInput, name: 'Rotate the staging keys', nameInferred: true, prompt: 'Rotate the staging keys.' };
    const title = { askedName: 'Rotate the staging keys', prompt: 'Rotate the staging keys.', title: 'Staging key rotation' };

    const cron = await store.createCron(inferred);
    expect(await store.applyInferredTitle('cron', cron.id, title)).toBe(true);
    expect(await store.getCron(cron.id)).toMatchObject({ name: 'Staging key rotation', nameInferred: true });

    const execution = await executions.createExecution({ ...inferred, scheduledAt: '2026-01-01T00:00:00.000Z' });
    expect(await store.applyInferredTitle('execution', execution.id, title)).toBe(true);
    expect((await executions.getExecution(execution.id))?.name).toBe('Staging key rotation');

    // A person renamed it while claude was thinking.
    const renamed = await store.createCron(inferred);
    await store.updateCron(renamed.id, { ...inferred, name: 'Keys', nameInferred: false });
    expect(await store.applyInferredTitle('cron', renamed.id, title)).toBe(false);
    expect((await store.getCron(renamed.id))?.name).toBe('Keys');

    // Saved again with another prompt, so this title is for a prompt it no longer has.
    const reprompted = await store.createCron(inferred);
    await store.updateCron(reprompted.id, { ...inferred, prompt: 'Rotate the production keys.' });
    expect(await store.applyInferredTitle('cron', reprompted.id, title)).toBe(false);

    // Named by a person from the start, under the very same words.
    const named = await store.createCron({ ...inferred, nameInferred: false });
    expect(await store.applyInferredTitle('cron', named.id, title)).toBe(false);
    expect(await store.applyInferredTitle('cron', 'no-such-job', title)).toBe(false);
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

  it("keeps one project's executions before cutting the page, so the page and its counts are the project's own", async () => {
    const billing = await projects.createProject({ name: 'Billing', description: '' });
    const other = await projects.createProject({ name: 'Other', description: '' });
    const first = await executions.createExecution({ ...cronInput, projectId: billing.id, scheduledAt: '2026-03-01T00:00:00.000Z' });
    await executions.createExecution({ ...cronInput, projectId: other.id, scheduledAt: '2026-03-02T00:00:00.000Z' });
    const second = await executions.createExecution({ ...cronInput, projectId: billing.id, scheduledAt: '2026-03-03T00:00:00.000Z' });
    await executions.createExecution({ ...cronInput, projectId: null, scheduledAt: '2026-03-04T00:00:00.000Z' });
    await executions.patchExecution(first.id, { status: 'done', firedAt: '2026-03-01T00:00:01.000Z' });

    // Newest first within the project; the other project's and the unfiled one never appear, whatever page is asked for.
    const page = await executions.pageExecutions({ limit: 1, project: billing.id });
    expect(page.items.map((item) => item.id)).toEqual([second.id]);
    expect(page).toMatchObject({ total: 2, scheduled: 1 });
    const next = await executions.pageExecutions({ before: page.nextBefore, limit: 1, project: billing.id });
    expect(next.items.map((item) => item.id)).toEqual([first.id]);
    expect(next.nextBefore).toBeNull();
    // The filter is applied before another order, not over the page it cuts.
    const reversed = await executions.pageExecutions({ limit: 1, project: billing.id, order: (all) => [...all].reverse() });
    expect(reversed.items.map((item) => item.id)).toEqual([first.id]);
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
      prePromptCommands: [],
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

  it('keeps commands before the prompt apart from following the defaults, in both tables', async () => {
    const lists: Array<string[] | null> = [null, [], ['pnpm install --frozen-lockfile', 'pnpm build']];
    for (const prePromptCommands of lists) {
      const cron = await store.createCron({ ...cronInput, prePromptCommands });
      expect((await store.getCron(cron.id))?.prePromptCommands).toEqual(prePromptCommands);
      const execution = await executions.createExecution({ ...cronInput, prePromptCommands, scheduledAt: '2026-01-01T00:00:00.000Z' });
      expect((await executions.getExecution(execution.id))?.prePromptCommands).toEqual(prePromptCommands);
    }
    // An edit can go back to following, or to running nothing.
    const cron = await store.createCron({ ...cronInput, prePromptCommands: ['make'] });
    await store.updateCron(cron.id, { ...cronInput, prePromptCommands: [] });
    expect((await store.getCron(cron.id))?.prePromptCommands).toEqual([]);
    await store.updateCron(cron.id, { ...cronInput, prePromptCommands: null });
    expect((await store.getCron(cron.id))?.prePromptCommands).toBeNull();
  });

  it('keeps the cluster\'s commands through a save of another default', async () => {
    const current = await settings.loadSettings();
    await settings.patchSettings({ jobDefaults: jobDefaults.patchJobDefaults(current.jobDefaults, { prePromptCommands: ['pnpm install'] }) });
    const after = await settings.loadSettings();
    await settings.patchSettings({ jobDefaults: jobDefaults.patchJobDefaults(after.jobDefaults, { model: 'opus' }) });
    expect((await settings.loadSettings()).jobDefaults).toMatchObject({ model: 'opus', prePromptCommands: ['pnpm install'] });
  });
});

describe('the job forms\' commands before the prompt', () => {
  const body = { name: 'Build', cron: '0 9 * * *', prompt: 'Build it.', isActive: true };

  it('follow the defaults when left out or null, and keep a list, empty or not', () => {
    expect(jobForms.readCronForm(body).value.prePromptCommands).toBeNull();
    expect(jobForms.readCronForm({ ...body, prePromptCommands: null }).value.prePromptCommands).toBeNull();
    expect(jobForms.readCronForm({ ...body, prePromptCommands: [] }).value.prePromptCommands).toEqual([]);
    expect(jobForms.readExecutionForm({ ...body, asSoonAsPossible: true, prePromptCommands: [' make ', ''] }).value.prePromptCommands).toEqual(['make']);
  });

  it('refuse a list that is not one line per command', () => {
    expect(jobForms.readCronForm({ ...body, prePromptCommands: ['make\nmake test'] }).errors).toEqual([
      'Commands before the prompt must each be one line, with no line breaks or NUL characters.',
    ]);
    expect(jobForms.readCronForm({ ...body, prePromptCommands: 'make' }).errors).toEqual(['Commands before the prompt must be a list of strings.']);
  });
});

describe.each(targets)('job activity on $name', ({ url }) => {
  let log: InstanceType<(typeof JobActivityModule)['JobActivityLog']>;

  beforeAll(async () => {
    await dbModule.closeDatabase();
    dbModule.openDatabase(url);
    await dbModule.migrate();
  });

  beforeEach(async () => {
    const db = dbModule.db();
    for (const table of ['crons', 'executions', 'projects', 'jobActivity'] as const) await db.deleteFrom(table).execute();
    log = new activity.JobActivityLog();
  });

  const update = (jobId: string, kind: JobActivityModule.UpdateKind = 'started', jobKind: 'cron' | 'execution' = 'cron') => ({
    jobId,
    jobKind,
    kind,
    at: new Date().toISOString(),
    logFile: kind === 'waiting' ? null : 'run.txt',
  });
  const unread = async (id: string) => activity.activityView({ createdAt: '' }, await log.row(id)).unread;

  it('counts a run starting and ending against its job, and makes it unread', async () => {
    const { id } = await store.createCron(cronInput);
    expect(await log.record(update(id, 'started'))).toBe(1);
    expect(await log.record(update(id, 'failed'))).toBe(2);
    expect(await log.row(id)).toMatchObject({ revision: 2, readRevision: 0, updateKind: 'failed', updateLogFile: 'run.txt' });
    expect(await unread(id)).toBe(true);
    expect((await log.summary()).counts).toEqual({ cron: 1, execution: 0 });
  });

  it('writes nothing for a job that is not there, so a late report cannot bring one back', async () => {
    expect(await log.record(update('deleted-job'))).toBeNull();
    expect((await log.rows()).size).toBe(0);
  });

  it('marks a job read at the revision the page showed it at', async () => {
    const { id } = await store.createCron(cronInput);
    await log.record(update(id, 'started'));
    await log.record(update(id, 'succeeded'));
    expect(await log.markRead([{ id, revision: 2 }])).toEqual({ marked: 1, counts: { cron: 0, execution: 0 } });
    expect(await unread(id)).toBe(false);
    // Said twice, as two tabs might: nothing more to do.
    expect((await log.markRead([{ id, revision: 2 }])).marked).toBe(0);
  });

  it('keeps a job unread when its run ended after the page drew it', async () => {
    const { id } = await store.createCron(cronInput);
    const shown = await log.record(update(id, 'started'));
    // The run finishes while that page is still open, then the page says what it saw.
    await log.record(update(id, 'succeeded'));
    expect((await log.markRead([{ id, revision: shown! }])).marked).toBe(0);
    expect(await unread(id)).toBe(true);
    // The page draws the job again, now at its new revision.
    expect((await log.markRead([{ id, revision: 2 }])).marked).toBe(1);
    expect(await unread(id)).toBe(false);
  });

  it('makes a read job unread again on its next update', async () => {
    const { id } = await store.createCron(cronInput);
    await log.record(update(id, 'started'));
    await log.markRead([{ id, revision: 1 }]);
    await log.record(update(id, 'waiting'));
    expect(await unread(id)).toBe(true);
    expect(await log.row(id)).toMatchObject({ updateKind: 'waiting', updateLogFile: null });
  });

  it('reads only what Mark all read was shown', async () => {
    const first = await store.createCron(cronInput);
    const second = await store.createCron({ ...cronInput, name: 'Second' });
    const once = await executions.createExecution({ ...cronInput, scheduledAt: '2026-01-01T00:00:00.000Z' });
    await log.record(update(first.id));
    await log.record(update(second.id));
    await log.record(update(once.id, 'started', 'execution'));
    const shown = await log.summary();
    expect(shown.counts).toEqual({ cron: 2, execution: 1 });
    // The second cron's run ends after the list was drawn and before the button is pressed.
    await log.record(update(second.id, 'succeeded'));
    const crons = shown.unread.filter((job) => job.kind === 'cron').map(({ id, revision }) => ({ id, revision }));
    expect(await log.markRead(crons)).toEqual({ marked: 1, counts: { cron: 1, execution: 1 } });
    expect(await unread(second.id)).toBe(true);
    expect(await unread(once.id)).toBe(true);
  });

  it('counts each kind, and only the jobs that are still there', async () => {
    const cron = await store.createCron(cronInput);
    const once = await executions.createExecution({ ...cronInput, scheduledAt: '2026-01-01T00:00:00.000Z' });
    await log.record(update(cron.id));
    await log.record(update(once.id, 'started', 'execution'));
    await dbModule
      .db()
      .insertInto('jobActivity')
      .values({ jobId: 'orphan', revision: 4, readRevision: 0, lastActivityAt: new Date().toISOString(), updateKind: 'failed', updateAt: null, updateLogFile: null })
      .execute();
    expect(await log.summary()).toEqual({
      counts: { cron: 1, execution: 1 },
      unread: [
        { id: cron.id, kind: 'cron', revision: 1 },
        { id: once.id, kind: 'execution', revision: 1 },
      ],
    });
    await executions.deleteExecution(once.id);
    expect((await log.summary()).counts).toEqual({ cron: 1, execution: 0 });
    await log.forget(once.id);
    expect(await log.row(once.id)).toBeUndefined();
  });

  it('ranks every execution before paging, so an unread one rises onto the first page', async () => {
    const dated = async (scheduledAt: string) => (await executions.createExecution({ ...cronInput, scheduledAt })).id;
    const newest = await dated('2026-03-01T00:00:00.000Z');
    await dated('2026-02-01T00:00:00.000Z');
    const oldest = await dated('2026-01-01T00:00:00.000Z');
    await log.record(update(oldest, 'failed', 'execution'));
    const rows = await log.rows();
    const ranked = (all: Execution[]) =>
      all
        .map((execution) => ({
          execution,
          rank: { id: execution.id, isRunning: false, isDelayed: false, activity: activity.activityView(execution, rows.get(execution.id)) },
        }))
        .sort((a, b) => activity.byActivity(a.rank, b.rank))
        .map(({ execution }) => execution);
    const page = await executions.pageExecutions({ limit: 1, order: ranked });
    expect(page.items.map((item) => item.id)).toEqual([oldest]);
    expect(page).toMatchObject({ total: 3, scheduled: 3 });
    expect((await executions.pageExecutions({ limit: 1 })).items.map((item) => item.id)).toEqual([newest]);
  });

  it('takes updates off the bus in the order they came, and announces each once it is written', async () => {
    const { id } = await store.createCron(cronInput);
    const { bus, emit } = await import('../src/events.js');
    const heard: Array<Promise<{ announced: number; stored: number | undefined }>> = [];
    const onEvent = (event: BusEvent) => {
      // What the row says at the moment a page hears of it.
      if (event.type === 'job:activity') heard.push(log.row(id).then((row) => ({ announced: Number(event.revision), stored: row?.revision })));
    };
    bus.on('event', onEvent);
    activity.jobActivity.start();
    emit('run:started', { cronId: id, cronName: 'Nightly digest', kind: 'cron', logFile: 'a.txt' });
    emit('run:skipped', { cronId: id, cronName: 'Nightly digest', kind: 'cron' });
    emit('run:finished', { cronId: id, cronName: 'Nightly digest', kind: 'cron', logFile: 'a.txt', status: 'succeeded', seconds: 3 });
    await activity.jobActivity.settled();
    bus.off('event', onEvent);
    expect((await Promise.all(heard)).map(({ announced }) => announced)).toEqual([1, 2]);
    for (const { announced, stored } of await Promise.all(heard)) expect(stored).toBeGreaterThanOrEqual(announced);
    expect(await log.row(id)).toMatchObject({ revision: 2, updateKind: 'succeeded', updateLogFile: 'a.txt' });
  });
});

/**
 * An upgrade from the schema before job defaults, on an empty database: a
 * fresh SQLite file, or the test Postgres with its public schema rebuilt.
 * That Postgres is the suite's own; the storage tests above clear its tables
 * anyway, and a schema of its own would not do, since the migrator finds its
 * bookkeeping table in public whatever the search path says.
 */
let upgrades = 0;

async function freshUpgradeTarget(url: string): Promise<string> {
  upgrades += 1;
  if (!url.startsWith('postgres')) return `sqlite:${path.join(home, `upgrade-${upgrades}.sqlite`)}`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('drop schema if exists public cascade');
  await client.query('create schema public');
  await client.end();
  return url;
}

describe.each(targets)('the migration to job setting defaults on $name', ({ url }) => {
  beforeAll(async () => {
    await dbModule.closeDatabase();
    dbModule.openDatabase(await freshUpgradeTarget(url));
    await dbModule.migrate('20260930_001_projects');
    const db = dbModule.db();
    const columns = sql`id, name, description, working_directory, use_worktree, cleanup_worktree, retrospective, model, effort, usage_delay, prompt, is_active, node_id, created_at, updated_at`;
    const values = (id: string, model: string, effort: string, flags: [number, number, number], usageDelay: string) =>
      sql`${id}, ${id}, '', '~/', ${flags[0]}, ${flags[1]}, ${flags[2]}, ${model}, ${effort}, ${usageDelay}, 'Do it.', 1, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'`;
    const seed = async (id: string, model: string, effort: string, flags: [number, number, number], usageDelay: string) => {
      await sql`insert into crons (${columns}, cron, timezone) values (${values(id, model, effort, flags, usageDelay)}, '0 9 * * *', '')`.execute(db);
      await sql`insert into executions (${columns}, scheduled_at, status) values (${values(`${id}-once`, model, effort, flags, usageDelay)}, '2026-01-02T00:00:00.000Z', 'done')`.execute(db);
    };
    await seed('blank', '', '', [0, 0, 0], '{"session":false,"weekly":false,"fable":false,"credits":false}');
    await seed('set', 'opus', 'high', [1, 1, 1], '{"session":true}');
    await dbModule.migrate();
  });

  const both = async (id: string) => [await store.getCron(id), await executions.getExecution(`${id}-once`)];

  it('turns a blank model and effort into following the defaults, in both tables', async () => {
    for (const job of await both('blank')) expect(job).toMatchObject({ model: null, effort: null });
  });

  it('keeps every other stored value as the job\'s own, so nothing runs differently', async () => {
    for (const job of await both('blank')) {
      expect(job).toMatchObject({
        useWorktree: false,
        cleanupWorktree: false,
        retrospective: false,
        usageDelay: { session: false, weekly: false, fable: false, credits: false },
      });
    }
    for (const job of await both('set')) {
      expect(job).toMatchObject({
        useWorktree: true,
        cleanupWorktree: true,
        retrospective: true,
        model: 'opus',
        effort: 'high',
        // A box the stored set left out meant off, and still does.
        usageDelay: { session: true, weekly: false, fable: false, credits: false },
      });
    }
    expect(await executions.getExecution('set-once')).toMatchObject({ status: 'done', scheduledAt: '2026-01-02T00:00:00.000Z' });
  });

  it('lets a job store null once migrated', async () => {
    await store.patchCron('set', { model: null, useWorktree: null });
    await executions.patchExecution('set-once', { effort: null, retrospective: null });
    expect(await store.getCron('set')).toMatchObject({ model: null, useWorktree: null });
    expect(await executions.getExecution('set-once')).toMatchObject({ effort: null, retrospective: null });
  });
});

describe.each(targets)('the migration to commands before the prompt on $name', ({ url }) => {
  beforeAll(async () => {
    await dbModule.closeDatabase();
    dbModule.openDatabase(await freshUpgradeTarget(url));
    await dbModule.migrate('20260930_007_name_inferred');
    const db = dbModule.db();
    const columns = sql`id, name, description, working_directory, use_worktree, model, usage_delay, prompt, is_active, node_id, created_at, updated_at`;
    const values = (id: string) => sql`${id}, ${id}, '', '~/', 1, 'opus', '{}', 'Do it.', 1, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'`;
    await sql`insert into crons (${columns}, cron, timezone) values (${values('before')}, '0 9 * * *', '')`.execute(db);
    await sql`insert into executions (${columns}, scheduled_at, status) values (${values('before-once')}, '2026-01-02T00:00:00.000Z', 'scheduled')`.execute(db);
    await dbModule.migrate();
  });

  it('leaves every job in both tables following the defaults, which run nothing', async () => {
    const cron = await store.getCron('before');
    const execution = await executions.getExecution('before-once');
    for (const job of [cron, execution]) expect(job).toMatchObject({ prePromptCommands: null, useWorktree: true, model: 'opus' });
    expect(jobForms.withEffective(cron!, jobDefaults.BUILT_IN_JOB_DEFAULTS).effective.prePromptCommands).toEqual([]);
  });

  it('lets both tables store a list, or none, once migrated', async () => {
    await store.patchCron('before', { prePromptCommands: ['pnpm install'] });
    await executions.patchExecution('before-once', { prePromptCommands: [] });
    expect((await store.getCron('before'))?.prePromptCommands).toEqual(['pnpm install']);
    expect((await executions.getExecution('before-once'))?.prePromptCommands).toEqual([]);
  });
});

describe.each(targets)('the migration to job activity on $name', ({ url }) => {
  beforeAll(async () => {
    await dbModule.closeDatabase();
    dbModule.openDatabase(await freshUpgradeTarget(url));
    // The migration just before job activity, so the store's own writes have every column they use.
    await dbModule.migrate('20261001_001_pre_prompt_commands');
    await store.createCron(cronInput);
    const ran = await store.createCron({ ...cronInput, name: 'Ran' });
    await store.patchCron(ran.id, { createdAt: '2026-09-01T00:00:00.000Z', lastRunAt: '2026-09-30T12:00:00.000Z', lastRunStatus: 'failed' });
    await dbModule.migrate();
  });

  it('starts every job already there as read, as recent as its last run', async () => {
    const log = new activity.JobActivityLog();
    expect(await log.summary()).toEqual({ counts: { cron: 0, execution: 0 }, unread: [] });
    const ran = (await store.listCrons()).find((cron) => cron.name === 'Ran')!;
    expect(activity.activityView(ran, await log.row(ran.id))).toEqual({ revision: 0, unread: false, lastActivityAt: '2026-09-30T12:00:00.000Z', update: null });
    expect(await log.record({ jobId: ran.id, jobKind: 'cron', kind: 'started', at: new Date().toISOString(), logFile: 'run.txt' })).toBe(1);
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
