import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import type { NotificationTable } from './db.js';
import { bus, emit } from './events.js';
import type { RunningJobSummary } from './system.js';
import type { BusEvent, JobKind, UsageBlocker } from './types.js';

/**
 * How much a notification asks of whoever reads it.
 *
 * - `action`: something is broken or stuck until a person looks — a failed run,
 *   a disk filling up, an update that did not go through.
 * - `worth`: worth knowing, not worth interrupting for — a retrospective, a busy
 *   machine, a trigger held for usage.
 * - `routine`: the record of things going as they should. It arrives read and
 *   the bell never counts it.
 */
export type NotificationLevel = 'action' | 'worth' | 'routine';

export const LEVELS: readonly NotificationLevel[] = ['action', 'worth', 'routine'];

export function isLevel(value: unknown): value is NotificationLevel {
  return (LEVELS as readonly unknown[]).includes(value);
}

export interface NotificationRecord {
  id: string;
  at: string;
  kind: string;
  level: NotificationLevel;
  message: string;
  read: boolean;
  cronId: string | null;
  cronName: string | null;
  jobKind: JobKind;
  /** The run it is about, when it is about one run: the drawer's link opens that log. */
  logFile: string | null;
  /** The machine it happened on, or null on a record written before nodes were named. */
  nodeId: string | null;
  nodeName: string | null;
  writing?: Promise<void> | null;
}

export type NotificationView = Omit<NotificationRecord, 'writing'>;

/** What the bell draws: the unread records that need a person, and the ones worth a look. */
export interface NotificationCounts {
  action: number;
  worth: number;
  /** Unread `action` records by node id, for the drawer's node filter. */
  nodes: Record<string, number>;
}

export interface NotificationPage {
  items: NotificationView[];
  nextBefore: string | null;
  unread: number;
  total: number;
  /** How many of each level pass the unread and node filters: the drawer's section counts. */
  levels: Record<NotificationLevel, number>;
  counts: NotificationCounts;
  /** Every machine a notification can name, or none when there is only one to name. */
  nodes: NotificationNode[];
}

export interface NotificationNode {
  id: string;
  name: string;
}

/** What the hub's own events are credited to: its pauses and its updates happen on no node. */
export const HUB_NODE: NotificationNode = { id: 'hub', name: 'hub' };

interface NotificationDraft {
  kind: string;
  level: NotificationLevel;
  message: string;
  cronId?: string | null;
  cronName?: string | null;
  jobKind?: JobKind;
  logFile?: string | null;
  nodeId?: string | null;
  nodeName?: string | null;
}

type DescribableEvent = BusEvent & {
  cronId?: string | null;
  cronName?: string | null;
  kind?: JobKind;
  logFile?: string;
  status?: string;
  seconds?: number;
  error?: string;
  reason?: string;
  hold?: 'concurrency' | 'usage';
  position?: number;
  queueLength?: number;
  runningCount?: number;
  ran?: boolean;
  lateBy?: string;
  paused?: boolean;
  mode?: string | null;
  label?: string;
  resumedFrom?: string | null;
  resumedMode?: string | null;
  from?: string | null;
  code?: number | null;
  metric?: string;
  summary?: string;
  running?: RunningJobSummary[];
  reasons?: UsageBlocker[];
  /** Stamped by the hub on everything a node reports; absent on the hub's own events. */
  nodeId?: string;
  nodeName?: string;
};

/**
 * Every notice the server produces, kept so it can be read later.
 *
 * The page already toasts these as they happen, but a toast is gone in a few
 * seconds and nobody watches a dashboard all day. This writes the same events
 * down — one row each, in the database — so the answer to
 * "what did I miss overnight" is a scroll rather than a log dig.
 *
 * Read state is the point of the whole thing, and the level decides it: a
 * routine record arrives read, because a cron that ran and succeeded is not
 * news. What is left unread is what a person would want to have been told, and
 * the bell counts only the part of that which needs them to do something.
 */
/** Past this the oldest are deleted as new ones land. */
export const MAX_NOTIFICATIONS = 5000;

/** One screenful for the drawer's infinite scroll. */
export const PAGE_SIZE = 20;

function toRow(record: NotificationRecord): NotificationTable {
  return {
    id: record.id,
    at: record.at,
    kind: record.kind,
    level: record.level,
    message: record.message,
    read: record.read ? 1 : 0,
    cronId: record.cronId,
    cronName: record.cronName,
    jobKind: record.jobKind,
    logFile: record.logFile,
    nodeId: record.nodeId,
    nodeName: record.nodeName,
  };
}

function fromRow(row: NotificationTable): NotificationRecord {
  return {
    ...row,
    level: isLevel(row.level) ? row.level : 'routine',
    read: Boolean(row.read),
    jobKind: row.jobKind === 'execution' ? 'execution' : 'cron',
  };
}

/**
 * What was running when a machine alert fired, and how far into its run each
 * was — the other half of the answer to "why was the CPU pinned".
 *
 * Three names at most. A machine busy enough to alert may have several runs on
 * it, and a notification is a line to read, not a table.
 */
function runningSummary(running: RunningJobSummary[] = []): string {
  if (!running.length) return 'No crons were running.';
  const named = running.slice(0, 3).map((run) => {
    const ms = Date.now() - Date.parse(run.startedAt);
    if (!Number.isFinite(ms) || ms < 0) return `"${run.name}"`;
    const minutes = Math.floor(ms / 60000);
    return `"${run.name}" (${minutes ? `${minutes}m` : `${Math.round(ms / 1000)}s`} in)`;
  });
  const rest = running.length - named.length;
  return `Running: ${named.join(', ')}${rest ? ` and ${rest} more` : ''}.`;
}

/** The limits a held trigger is waiting on, e.g. "Session, Weekly". */
function blockerNames(event: DescribableEvent): string {
  return (event?.reasons ?? []).map((reason) => reason.label).join(', ');
}

/**
 * What one event is worth recording as, credited to the machine it happened on.
 *
 * The hub names the node on everything a node reports. Anything without a name
 * was the hub's own doing — a pause, an update — and is credited to the hub.
 */
export function describe(event: DescribableEvent): NotificationDraft | null {
  const draft = describeEvent(event);
  if (!draft) return null;
  return { ...draft, nodeId: event.nodeId ?? HUB_NODE.id, nodeName: event.nodeName ?? event.nodeId ?? HUB_NODE.name };
}

/** Of the four machine alerts, the one that stops runs when it is ignored. */
const ACTION_METRICS = new Set(['disk']);

/**
 * What one event is worth recording as, or null for the ones that are signals
 * rather than news — a redraw hint, a stats sample, this module's own events,
 * and the steps along the way that the live page shows and nobody needs later.
 *
 * The wording matches the toasts the page shows for the same events. Those are
 * written in the client and these on the server, so the two are kept in step by
 * hand; a difference in wording is a bug, not a feature.
 */
function describeEvent(event: DescribableEvent): NotificationDraft | null {
  // jobKind, not kind: `kind` on a notification is what sort of notice it is,
  // and this is what sort of thing it happened to.
  const cron: Pick<NotificationDraft, 'cronId' | 'cronName' | 'jobKind'> = { cronId: event.cronId ?? null, cronName: event.cronName ?? null, jobKind: event.kind ?? 'cron' };
  // A one-time execution names itself as one, so a line in the drawer is not
  // read as a cron that has started misbehaving.
  const name = event.kind === 'execution' ? `one-time "${event.cronName}"` : `"${event.cronName}"`;
  switch (event.type) {
    case 'run:finished': {
      const succeeded = event.status === 'succeeded';
      return {
        kind: succeeded ? 'run' : 'run-failed',
        // A run the user stopped did what they asked; one that failed, or was
        // cut short by a restart, left work undone that somebody has to look at.
        level: event.status === 'failed' || event.status === 'interrupted' ? 'action' : 'routine',
        // An interrupted run never wrote a footer, so it has no duration to
        // report and must not claim one.
        message: Number.isFinite(event.seconds)
          ? `${name} ${event.status} in ${event.seconds}s`
          : `${name} ${event.status}`,
        ...cron,
      };
    }
    // Only sent when the retrospective said something, so it is always worth reading.
    case 'run:retrospective':
      return { kind: 'retrospective', level: 'worth', message: `${name} left a retrospective`, ...cron, logFile: event.logFile ?? null };
    // A run that could not set up or tear down its worktree may have gone
    // without the files it needed, or left a folder and branch behind.
    case 'worktree:include-failed':
      return { kind: 'worktree-failed', level: 'action', message: `${name} could not write .worktreeinclude: ${event.error}`, ...cron };
    case 'worktree:cleanup-failed':
      return { kind: 'worktree-failed', level: 'action', message: `${name} worktree clean up failed: ${event.error}`, ...cron };
    case 'run:skipped':
      return {
        kind: 'run',
        level: 'routine',
        message: event.reason ? `${name} skipped: ${event.reason}` : `${name} was still running; trigger skipped`,
        ...cron,
      };
    case 'run:dropped':
      return {
        kind: 'pause',
        // The pause that dropped it was asked for, so this is a consequence
        // rather than a surprise.
        level: 'routine',
        message: `${name} trigger dropped: ${event.reason}`,
        ...cron,
      };
    case 'run:delayed':
      return {
        kind: 'delayed',
        // A queue moves on its own within minutes. A usage hold can last hours,
        // and is the reason a run happened later than its schedule said.
        level: event.hold === 'concurrency' ? 'routine' : 'worth',
        // A queued trigger says where it stands rather than what it is waiting
        // on: the limit is the same for every one of them, the place is not.
        message:
          event.hold === 'concurrency'
            ? `${name} is queued at position ${event.position! + 1} of ${event.queueLength}, behind ${event.runningCount} running job${event.runningCount === 1 ? '' : 's'}`
            : `${name} is waiting on ${blockerNames(event)}`,
        ...cron,
      };
    case 'run:released':
      return {
        kind: 'delayed',
        level: 'routine',
        message: event.ran
          ? event.hold === 'concurrency'
            ? `${name} reached the front of the queue, starting now`
            : `${name} usage cleared, starting now`
          : `${name} waiting trigger dropped: ${event.reason}`,
        ...cron,
      };
    case 'execution:overdue':
      return {
        kind: 'delayed',
        // A trigger that was missed and is being made up is exactly the kind of
        // thing you want to find in the morning.
        level: 'worth',
        message: `${name} missed its trigger by ${event.lateBy}; running now`,
        ...cron,
      };
    case 'pause:changed':
      // An update's own pause and resume are steps of the update, and the
      // update's row already says what happened.
      if (event.mode === 'update' || event.resumedMode === 'update') return null;
      return event.paused
        ? { kind: 'pause', level: 'routine', message: `Everything paused ${event.label}` }
        : {
            kind: 'pause',
            level: 'routine',
            message: event.resumedFrom
              ? `Schedules resumed after the "${event.resumedFrom}" pause (${event.reason})`
              : 'Schedules resumed',
          };
    case 'update:launched':
      return { kind: 'update', level: 'worth', message: `Update started from ${event.from ?? 'the current commit'}; the service will restart` };
    case 'update:abandoned':
      return { kind: 'update', level: 'action', message: `Update gave up waiting on ${event.runningCount} run(s); schedules resumed` };
    case 'update:failed':
      return { kind: 'update', level: 'action', message: `Update script failed (exit ${event.code}); schedules resumed` };
    case 'system:alert':
      return {
        kind: 'system',
        // A full disk stops runs; a busy machine only slows them.
        level: ACTION_METRICS.has(String(event.metric)) ? 'action' : 'worth',
        message: `${event.label}: ${event.summary}. ${runningSummary(event.running)}`,
      };
    default:
      return null;
  }
}

export class NotificationCenter {
  public items: NotificationRecord[];
  public ready: Promise<number> | null;
  public listening: boolean;

  public constructor() {
    /** Newest first, which is the order everything reads them in. @type {Array<object>} */
    this.items = [];
    /** The startup read, so the API can wait for it without blocking the server. @type {Promise|null} */
    this.ready = null;
    this.listening = false;
  }

  /**
   * Subscribes immediately and reads the folder in the background.
   *
   * Events arriving during that read are already in `items`, so the records
   * coming off disk are appended under them rather than replacing them: they
   * are older by definition.
   */
  public start(): Promise<number> {
    if (!this.listening) {
      bus.on('event', (event) => {
        try {
          this.record(event);
        } catch (err) {
          console.error(`[notifications] could not record ${event?.type}: ${(err as Error).message}`);
        }
      });
      this.listening = true;
    }
    this.ready = this.load();
    return this.ready;
  }

  public async load(): Promise<number> {
    const rows = await db().selectFrom('notifications').selectAll().orderBy('at', 'desc').execute();
    // Anything past the cap is deleted here rather than kept. A prune
    // interrupted by a restart, or one whose delete lost a race with its own
    // write, leaves rows behind; this is what stops them accumulating.
    for (const stale of rows.splice(MAX_NOTIFICATIONS)) {
      await db().deleteFrom('notifications').where('id', '=', stale.id).execute().catch(() => {});
    }
    this.items = [...this.items, ...rows.map(fromRow)];
    return this.items.length;
  }

  /** Turns one bus event into however many notifications it is worth. */
  public record(event: BusEvent): void {
    const draft = describe(event as DescribableEvent);
    if (draft) this.add(draft);
  }

  /**
   * Adds one, announces it, and writes it down. The disk write is not waited
   * on: a notification that cannot be written is still worth showing, and the
   * event that produced it must not be held up by a filesystem.
   */
  public add({
    kind,
    level,
    message,
    cronId = null,
    cronName = null,
    jobKind = 'cron',
    logFile = null,
    nodeId = null,
    nodeName = null,
  }: NotificationDraft): NotificationRecord {
    const record = {
      id: randomUUID(),
      at: new Date().toISOString(),
      kind,
      level,
      message,
      // Routine is the record of things going right, so nobody has to read it.
      read: level === 'routine',
      cronId,
      cronName,
      // Which page the drawer's link should open: a cron's logs or an execution's.
      jobKind,
      logFile,
      nodeId,
      nodeName,
    } as NotificationRecord;
    this.items.unshift(record);
    const pruned = this.items.length > MAX_NOTIFICATIONS ? this.items.splice(MAX_NOTIFICATIONS) : [];
    emit('notification:new', { notification: this.view(record), unread: this.unreadCount(), counts: this.counts() });
    void this.persist(record);
    for (const old of pruned) void this.remove(old);
    return record;
  }

  /** Marks the given ids read, and answers with what is still unread. */
  public async markRead(ids: string | string[] | null | undefined): Promise<{ marked: number; unread: number; counts: NotificationCounts }> {
    await this.ready;
    const wanted = new Set(([] as string[]).concat(ids ?? []));
    const changed: NotificationRecord[] = [];
    for (const record of this.items) {
      if (!record.read && wanted.has(record.id)) {
        record.read = true;
        changed.push(record);
      }
    }
    await Promise.all(changed.map((record) => this.persist(record)));
    const unread = this.unreadCount();
    // Other open tabs are showing the same badge, so the count travels.
    if (changed.length) emit('notification:read', { ids: changed.map((record) => record.id), unread, counts: this.counts() });
    return { marked: changed.length, unread, counts: this.counts() };
  }

  /** Marks every stored notification read, which is the drawer's one button. */
  public async markAllRead(): Promise<{ marked: number; unread: number; counts: NotificationCounts }> {
    await this.ready;
    const changed = this.items.filter((record) => !record.read);
    for (const record of changed) record.read = true;
    await Promise.all(changed.map((record) => this.persist(record)));
    if (changed.length) emit('notification:read', { ids: changed.map((record) => record.id), unread: 0, counts: this.counts() });
    return { marked: changed.length, unread: 0, counts: this.counts() };
  }

  /**
   * One page, newest first. `before` is the id of the last one already shown,
   * which is a cursor rather than an offset on purpose: notifications arrive
   * while the list is open, and an offset would show one of them twice.
   *
   * `unreadOnly` pages the unread ones alone, for the drawer's filter; `level`
   * pages one of the drawer's sections and `node` one machine's records. The
   * cursor is an id whatever the filters, so it keeps working across a filter
   * being turned on: the records between two that match are simply skipped.
   */
  public async page({
    before = null,
    limit = PAGE_SIZE,
    unreadOnly = false,
    level = null,
    node = null,
    nodes = [],
  }: {
    before?: string | null;
    limit?: unknown;
    unreadOnly?: boolean;
    level?: NotificationLevel | null;
    node?: string | null;
    nodes?: NotificationNode[];
  } = {}): Promise<NotificationPage> {
    await this.ready;
    const size = Math.max(1, Math.min(100, Number(limit) || PAGE_SIZE));
    let start = 0;
    if (before) {
      const index = this.items.findIndex((record) => record.id === before);
      // A cursor that is no longer here — pruned, or from an older run — starts
      // again from the top rather than answering with nothing.
      start = index >= 0 ? index + 1 : 0;
    }
    // The filters are applied after the cursor so the cursor stays an index into
    // the one list everything else — prune, mark read, the event stream — uses.
    const shown = (record: NotificationRecord): boolean => (!unreadOnly || !record.read) && (!node || record.nodeId === node);
    const levels: Record<NotificationLevel, number> = { action: 0, worth: 0, routine: 0 };
    for (const record of this.items) if (shown(record)) levels[record.level] += 1;
    const rest = this.items.slice(start).filter((record) => shown(record) && (!level || record.level === level));
    const items = rest.slice(0, size);
    return {
      items: items.map((record) => this.view(record)),
      // The cursor for the next page, and null when this was the last of them.
      nextBefore: rest.length > size ? items.at(-1)?.id ?? null : null,
      unread: this.unreadCount(),
      total: level ? levels[level] : levels.action + levels.worth + levels.routine,
      levels,
      counts: this.counts(),
      // One node is the drawer as it always was: no names on the rows, nothing
      // to filter by. The hub is only worth naming beside two or more.
      nodes: nodes.length > 1 ? [HUB_NODE, ...nodes.map(({ id, name }) => ({ id, name }))] : [],
    };
  }

  /** The in-flight write is ours, not the reader's. */
  public view(record: NotificationRecord): NotificationView {
    const { writing, ...rest } = record;
    return rest;
  }

  public unreadCount(): number {
    let count = 0;
    for (const record of this.items) if (!record.read) count += 1;
    return count;
  }

  /**
   * The bell's numbers. Routine is never counted, even the odd unread one left
   * from before there were levels: the bell is for what a person has to see.
   */
  public counts(): NotificationCounts {
    const counts: NotificationCounts = { action: 0, worth: 0, nodes: {} };
    for (const record of this.items) {
      if (record.read || record.level === 'routine') continue;
      counts[record.level] += 1;
      if (record.level === 'action' && record.nodeId) counts.nodes[record.nodeId] = (counts.nodes[record.nodeId] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Writes one record, and remembers the write while it is in flight.
   *
   * A burst of notifications can prune a record before its own row has been
   * written, and a delete that lands first deletes nothing — the write then
   * inserts the row and it is there for good. `writing` is what `remove`
   * waits on so that cannot happen.
   */
  public async persist(record: NotificationRecord): Promise<void> {
    const write = this.write(record);
    record.writing = write;
    await write;
    if (record.writing === write) record.writing = null;
  }

  public async write(record: NotificationRecord): Promise<void> {
    try {
      const { id, ...columns } = toRow(record);
      await db()
        .insertInto('notifications')
        .values({ id, ...columns })
        .onConflict((conflict) => conflict.column('id').doUpdateSet(columns))
        .execute();
    } catch (err) {
      console.error(`[notifications] could not write ${record.id}: ${(err as Error).message}`);
    }
  }

  public async remove(record: NotificationRecord): Promise<void> {
    // Never delete ahead of the write that would put it back.
    await record.writing?.catch(() => {});
    await db().deleteFrom('notifications').where('id', '=', record.id).execute().catch(() => {});
  }
}

export const notificationCenter = new NotificationCenter();
