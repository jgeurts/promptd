import { db } from './db.js';
import type { JobActivityTable } from './db.js';
import { bus, emit } from './events.js';
import type { BusEvent, JobKind, RunStatus } from './types.js';

/**
 * Which jobs have had something happen since they were last looked at, the way
 * a mail client knows which threads have new mail.
 *
 * Three things are an update: a run starting, a run ending however it ended,
 * and a trigger starting to wait on a usage limit (and again once it is waiting
 * past the time the limit said it would reset). Output is not; nor is anything
 * the page shows only while it lasts, like a place in the queue for a slot.
 *
 * Read state lives here on the hub, in one row per job, so every browser sees
 * the same. A job is read by opening its logs, and the page says which
 * revision it showed: a run that ended after that is a newer revision, and
 * the job stays unread.
 */

export type UpdateKind = 'started' | RunStatus | 'waiting' | 'late';

export interface JobUpdate {
  jobId: string;
  jobKind: JobKind;
  kind: UpdateKind;
  /** When it happened, by the clock of the node that reported it. */
  at: string;
  /** The run it is about, when it is about one. */
  logFile: string | null;
}

/** What a job carries in the API about its updates. */
export interface JobActivity {
  /** What the page sends back to say it has shown the job as it is now. */
  revision: number;
  unread: boolean;
  /** The newest thing known to have happened to it, which the Activity sort orders by. */
  lastActivityAt: string;
  /** The latest update, or null when it has had none since this existed. */
  update: { kind: UpdateKind; at: string; logFile: string | null } | null;
}

export interface UnreadJob {
  id: string;
  kind: JobKind;
  revision: number;
}

export interface ActivitySummary {
  /** How many of each kind are unread, across every job, paged in or not. */
  counts: Record<JobKind, number>;
  unread: UnreadJob[];
}

export interface ReadRequest {
  id: string;
  revision: number;
}

const RUN_ENDINGS: ReadonlySet<string> = new Set<RunStatus>(['succeeded', 'failed', 'stopped', 'interrupted']);

const UPDATE_KINDS: ReadonlySet<string> = new Set([...RUN_ENDINGS, 'started', 'waiting', 'late']);

/**
 * The update one bus event is, or null for every event that is not one.
 *
 * A retrospective and a worktree that could not be set up or cleaned away are
 * not updates of their own: each arrives with the start or the end of the run
 * it belongs to, which already is one.
 */
export function jobUpdate(event: BusEvent): JobUpdate | null {
  const jobId = typeof event.cronId === 'string' ? event.cronId : '';
  if (!jobId) return null;
  const base = {
    jobId,
    jobKind: (event.kind === 'execution' ? 'execution' : 'cron') as JobKind,
    at: typeof event.at === 'string' ? event.at : new Date().toISOString(),
    logFile: typeof event.logFile === 'string' && event.logFile ? event.logFile : null,
  };
  switch (event.type) {
    case 'run:started':
      return { ...base, kind: 'started' };
    case 'run:finished':
      return RUN_ENDINGS.has(String(event.status)) ? { ...base, kind: event.status as RunStatus } : null;
    // A slot coming free is minutes away and needs nobody; a usage limit can
    // hold a run for hours, which is why it ran later than its schedule said.
    case 'run:delayed':
      return event.hold === 'usage' ? { ...base, kind: event.late ? 'late' : 'waiting', logFile: null } : null;
    default:
      return null;
  }
}

/** The newest of several times, any of which may be missing. */
function latest(...times: Array<string | null | undefined>): string {
  let best: string | null = null;
  for (const time of times) {
    if (time && (!best || Date.parse(time) > Date.parse(best))) best = time;
  }
  return best ?? new Date(0).toISOString();
}

/**
 * A job's activity as the API shows it. A job with no row has had no update
 * since this existed: read, and as recent as its last run or its creation.
 */
export function activityView(job: { createdAt: string; lastRunAt?: string | null }, row: JobActivityTable | undefined): JobActivity {
  const revision = Number(row?.revision ?? 0);
  return {
    revision,
    unread: revision > Number(row?.readRevision ?? 0),
    lastActivityAt: latest(row?.lastActivityAt, job.lastRunAt, job.createdAt),
    update:
      row?.updateKind && UPDATE_KINDS.has(row.updateKind)
        ? { kind: row.updateKind as UpdateKind, at: row.updateAt ?? row.lastActivityAt, logFile: row.updateLogFile }
        : null,
  };
}

export interface RankedJob {
  id: string;
  isRunning: boolean;
  isDelayed: boolean;
  activity: JobActivity;
}

/** 0 running, 1 waiting to start, 2 unread, 3 the rest: the Activity sort's tiers. */
function tier(job: RankedJob): number {
  if (job.isRunning) return 0;
  if (job.isDelayed) return 1;
  return job.activity.unread ? 2 : 3;
}

/**
 * The Activity sort: what is running, then what is waiting to start, then what
 * is unread, then everything else; newest activity first inside each, and the
 * id last so two equal jobs keep one order between redraws.
 */
export function byActivity(a: RankedJob, b: RankedJob): number {
  return (
    tier(a) - tier(b) ||
    Date.parse(b.activity.lastActivityAt) - Date.parse(a.activity.lastActivityAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export class JobActivityLog {
  private queue: Promise<unknown> = Promise.resolve();
  private listening = false;

  /** Subscribes to the bus. Updates are written one at a time, in the order they came. */
  public start(): void {
    if (this.listening) return;
    this.listening = true;
    bus.on('event', (event) => {
      const update = jobUpdate(event);
      if (update) void this.enqueue(update);
    });
  }

  public enqueue(update: JobUpdate): Promise<number | null> {
    const next = this.queue.then(() =>
      this.record(update).catch((err: unknown) => {
        console.error(`[activity] could not record ${update.kind} for ${update.jobId}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }),
    );
    this.queue = next;
    return next;
  }

  /**
   * Counts one update against its job, and answers the job's new revision.
   * Nothing is written for a job that is not there: a node reporting late on
   * one deleted meanwhile must not bring a row back for it.
   */
  public async record(update: JobUpdate, now = new Date().toISOString()): Promise<number | null> {
    if (!(await jobExists(update.jobId))) return null;
    const changes = { lastActivityAt: now, updateKind: update.kind, updateAt: update.at, updateLogFile: update.logFile };
    const row = await db()
      .insertInto('jobActivity')
      .values({ jobId: update.jobId, revision: 1, readRevision: 0, ...changes })
      .onConflict((conflict) => conflict.column('jobId').doUpdateSet((eb) => ({ ...changes, revision: eb(eb.ref('jobActivity.revision'), '+', 1) })))
      .returning('revision')
      .executeTakeFirstOrThrow();
    const revision = Number(row.revision);
    // After the write, so a page that reads the job on hearing this sees it.
    emit('job:activity', { id: update.jobId, kind: update.jobKind, revision, counts: (await this.summary()).counts });
    return revision;
  }

  /** Every row, by job id, for drawing a whole list. */
  public async rows(): Promise<Map<string, JobActivityTable>> {
    const rows = await db().selectFrom('jobActivity').selectAll().execute();
    return new Map(rows.map((row) => [row.jobId, row]));
  }

  public async row(jobId: string): Promise<JobActivityTable | undefined> {
    return db().selectFrom('jobActivity').selectAll().where('jobId', '=', jobId).executeTakeFirst();
  }

  /** Every unread job that still exists, with the revision each is at. */
  public async summary(): Promise<ActivitySummary> {
    const unreadIn = (kind: JobKind) =>
      db()
        .selectFrom('jobActivity')
        .select(['jobId', 'revision'])
        .whereRef('revision', '>', 'readRevision')
        .where('jobId', 'in', kind === 'cron' ? db().selectFrom('crons').select('id') : db().selectFrom('executions').select('id'))
        .execute()
        .then((rows) => rows.map((row): UnreadJob => ({ id: row.jobId, kind, revision: Number(row.revision) })));
    const unread = [...(await unreadIn('cron')), ...(await unreadIn('execution'))];
    return {
      counts: { cron: unread.filter((job) => job.kind === 'cron').length, execution: unread.filter((job) => job.kind === 'execution').length },
      unread,
    };
  }

  /**
   * Marks each job read at the revision the page showed it at, and only where
   * that is still its revision. A run that ended after the page drew the job is
   * a revision the reader has not seen, so the job stays unread; that is also
   * what keeps Mark all read from reading what arrived after its list was drawn.
   */
  public async markRead(requests: ReadRequest[]): Promise<{ marked: number; counts: Record<JobKind, number> }> {
    const marked: string[] = [];
    for (const { id, revision } of requests) {
      const result = await db()
        .updateTable('jobActivity')
        .set({ readRevision: revision })
        .where('jobId', '=', id)
        .where('revision', '=', revision)
        .whereRef('readRevision', '<', 'revision')
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) > 0) marked.push(id);
    }
    const { counts } = await this.summary();
    // Other open pages are showing the same jobs as unread.
    if (marked.length) emit('job:read', { ids: marked, counts });
    return { marked: marked.length, counts };
  }

  /** Drops a deleted job's row. */
  public async forget(jobId: string): Promise<void> {
    const result = await db().deleteFrom('jobActivity').where('jobId', '=', jobId).executeTakeFirst();
    if (Number(result.numDeletedRows) > 0) emit('job:read', { ids: [jobId], counts: (await this.summary()).counts });
  }

  /** Resolves once every update taken in so far is written. */
  public settled(): Promise<unknown> {
    return this.queue;
  }
}

async function jobExists(id: string): Promise<boolean> {
  const [cron, execution] = await Promise.all([
    db().selectFrom('crons').select('id').where('id', '=', id).executeTakeFirst(),
    db().selectFrom('executions').select('id').where('id', '=', id).executeTakeFirst(),
  ]);
  return Boolean(cron ?? execution);
}

/**
 * What one read request body says, or an error to answer with. Each item is an
 * id and the revision the page showed it at; without the revision there is no
 * telling whether the reader saw the latest update, so nothing is guessed.
 */
export function readRequests(body: unknown): { items: ReadRequest[] } | { error: string } {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || !items.length) return { error: 'items must be a non-empty array' };
  if (items.length > 5000) return { error: 'at most 5000 items at once' };
  const requests: ReadRequest[] = [];
  for (const item of items as Array<Record<string, unknown> | null>) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const revision = item?.revision;
    if (!id || !Number.isInteger(revision) || (revision as number) < 0) {
      return { error: 'each item needs an id and the revision it was shown at' };
    }
    requests.push({ id, revision: revision as number });
  }
  return { items: requests };
}

export const jobActivity = new JobActivityLog();
