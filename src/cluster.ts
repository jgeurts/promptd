import { SYSTEM_ALERTS, SYSTEM_METRICS } from './system.js';
import type { SystemMetric, SystemMetricId } from './system.js';
import { USAGE_DELAY_CATEGORIES, kindOf } from './usage.js';
import type { ClaudeAccount, DelayEntry, JobKind, SystemSample, UsageReading, UsageThresholds, UsageWindow } from './types.js';

/**
 * The header's view of the whole cluster: what is running and waiting, which
 * computers answer, one entry per Claude account rather than one per node,
 * only those machine readings worth interrupting for, and the words the header
 * says all of that in.
 *
 * Pure functions over what the hub already holds, so the rules that decide what
 * the header says live in one place and are tested without a hub.
 */

/** What the summary needs to know about one node, online or not. */
export interface ClusterNode {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  commit: string | null;
  account: ClaudeAccount | null;
  usage: UsageReading | null;
  running: number;
  /** 0 is no limit, as a node reports it. */
  concurrencyLimit: number;
  /** The percentages at which this node holds a job set to wait for usage. */
  thresholds: UsageThresholds;
  /** The triggers this node is holding, for usage or for a free slot. */
  waiting: DelayEntry[];
  samples: SystemSample[];
  intervalMs: number;
}

/**
 * How close one limit is to stopping work, as the header words it.
 *
 * - `reached`: used up, at 100%. Nothing on the account can use that limit
 *   until it resets.
 * - `near`: not used up, but Claude's usage API marks it as a warning or as
 *   critical, or it is at or past the percentage where a node holds jobs set to
 *   wait for that limit (the node's `usageDelayThresholds`). Past that line
 *   those jobs are already held, so it is near however much is left.
 * - `ok`: neither.
 */
export type LimitStatus = 'near' | 'ok' | 'reached';

/** An account's worst limit, or `unknown` when there is no reading to judge. */
export type AccountStatus = LimitStatus | 'unknown';

/** One limit on an account, as the panel lists it. */
export interface AccountLimit extends UsageWindow {
  /** The plain name: "5-hour session", "Weekly, all models", "Weekly, Fable", "Credits". */
  name: string;
  status: LimitStatus;
  /** The lowest percentage at which a node on the account holds jobs set to wait for this limit; null when no setting covers it. */
  waitsAt: number | null;
}

/** One reading as the panel draws it. */
export interface UsageSummary {
  windows: AccountLimit[];
  status: AccountStatus;
  /**
   * Session and the tightest other window, and the tightest alone, by key: what
   * the chip header drew. Nothing here reads them; a tab still open on that
   * header does until it reloads, and fails without them.
   */
  headline: string[];
  tightest: string | null;
  /** The worst severity the API gives any of the windows. */
  severity: UsageWindow['severity'];
  checkedAt: string | null;
  stale: boolean;
  reason: string | null;
}

export interface AccountSummary extends UsageSummary {
  id: string;
  email: string;
  nodeIds: string[];
}

/**
 * Usage from a node that has not said which account it is on, typically one on
 * an older build. It stays with its node: two such nodes may be on different
 * accounts, so they are never merged.
 */
export interface UnknownAccountUsage extends UsageSummary {
  nodeId: string;
  nodeName: string;
}

/** One node over one metric's alert line. */
export interface MachineException {
  nodeId: string;
  nodeName: string;
  metric: SystemMetricId;
  label: string;
  unit: string;
  kind: SystemMetric['kind'];
  value: number;
  threshold: number;
  severity: 'critical' | 'warning';
  /** The reading in words: "CPU 94%", "Disk 91% full". */
  reading: string;
}

/** A trigger a node is holding, and what for. */
export interface WaitingJob {
  id: string;
  name: string;
  kind: JobKind;
  nodeId: string;
  nodeName: string;
  /** `usage` waits for an account limit to clear; `concurrency` for a free slot under its node's job limit. */
  hold: DelayEntry['hold'];
  /** The limits a usage hold waits on, by their plain names. */
  limits: Array<{ name: string; usedPercent: number | null; threshold: number | null; resetsAt: string | null }>;
  resumeAt: string | null;
  /** When the trigger first had to wait, for whatever reason: its place in line, which the nodes queue by. */
  since: string;
  /** Its place in line, counting from 1, while it waits for a free slot. */
  position: number | null;
  queueLength: number | null;
}

/** Where in the panel a warning, or a part of the summary row, opens it. */
export type HeaderSection = 'accounts' | 'computers' | 'jobs';

export interface HeaderWarning {
  id: 'accounts' | 'machines' | 'offline' | 'waiting-slot' | 'waiting-usage';
  section: HeaderSection;
  text: string;
}

/** What the header says, decided here so the wording and the rules are tested together. */
export interface HeaderSummary {
  /** "No jobs running", "1 job running", "3 jobs running". */
  jobs: string;
  /** What the job limit is, labelled: "up to 36 at once across online computers". */
  capacity: string;
  /** "3 of 3 computers online", or "No computers connected". */
  computers: string;
  /** Accounts by their worst limit; an account counts once, under its worst. */
  accounts: { reached: number; near: number };
  /**
   * Only what needs attention, in the order the header shows it: jobs held
   * first, then account limits, machine warnings and computers offline. Empty is
   * all clear. The page adds its own connection on the end, which only it knows.
   */
  warnings: HeaderWarning[];
}

/** One thing wrong, as the sidebar's availability tile words it. */
export interface AvailabilityAlert {
  id: 'accounts-near' | 'accounts-reached' | 'machines' | 'offline' | 'waiting-slot' | 'waiting-usage';
  /** Where on the status page it is explained. */
  section: HeaderSection;
  /** `critical` stops work now; `warning` is about to, or is worth a look. */
  severity: 'critical' | 'warning';
  text: string;
}

/** The account with the most room, as the tile draws it. */
export interface BestAccount {
  /** `account:<id>`, or `unknown:<nodeId>` for a reading with no account named: the block's anchor on the status page. */
  key: string;
  /** The email, or "Account unknown". */
  title: string;
  /** The computers signed in to it, which the tile names it by. */
  nodeNames: string[];
  status: AccountStatus;
  /** The limit closest to stopping work on it. */
  tightest: AccountLimit;
  /** The session and the weekly all-models limits, plus the tightest when it is another: what the tile draws meters for. */
  limits: AccountLimit[];
  checkedAt: string | null;
  stale: boolean;
}

/**
 * Where work can still go, over every account at once: the account with the
 * most room on its tightest limit, how the other accounts stand, and what is
 * wrong, worst first.
 */
export interface Availability {
  /** Null when no online computer has a usage reading. */
  best: BestAccount | null;
  /** How many accounts have a reading; `best` is the best of these. */
  accounts: number;
  /**
   * The accounts other than the best, by their worst limit. `text` is the
   * sentence under the meters, "2 other accounts at their weekly limit", or
   * null when there is no other account; `firstResetAt` is the earliest any of
   * their reached limits frees, for the page to add in local time.
   */
  others: { count: number; reached: number; near: number; text: string | null; firstResetAt: string | null };
  /**
   * Limits reached, then jobs held, accounts near a limit, machine trouble and
   * computers offline. Empty is all clear. The page adds its own on the end:
   * its connection and an update on offer, which only it knows.
   */
  alerts: AvailabilityAlert[];
}

export interface ClusterSummary {
  nodes: { total: number; online: number; offline: Array<{ id: string; name: string; lastSeenAt: string | null }> };
  /**
   * Every node, in display order, for the panel to name them by, with what the
   * sidebar's node list draws: how busy it is, and the key of the account block
   * its usage is under, or null when it has none to show.
   */
  computers: Array<{
    id: string;
    name: string;
    online: boolean;
    lastSeenAt: string | null;
    running: number;
    /** 0 is no limit. */
    concurrencyLimit: number;
    accountKey: string | null;
  }>;
  running: number;
  /** Summed over online nodes; 0 when any of them has no limit. */
  concurrencyLimit: number;
  /** Held for usage first, then held for a slot, each oldest first. */
  waiting: WaitingJob[];
  accounts: AccountSummary[];
  /** Nodes that have not said which account they are on: signed out, or older than the field. */
  unknownAccountNodeIds: string[];
  /** The readings those nodes do report, one per online node that has one. */
  unknownAccountUsage: UnknownAccountUsage[];
  /** Worst first. */
  exceptions: MachineException[];
  builds: { hubCommit: string | null; differing: string[] };
  header: HeaderSummary;
  availability: Availability;
}

const SEVERITY_RANK: Record<UsageWindow['severity'], number> = { normal: 0, warning: 1, critical: 2 };
const STATUS_RANK: Record<AccountStatus, number> = { unknown: 0, ok: 1, near: 2, reached: 3 };

const METRICS = new Map(SYSTEM_METRICS.map((metric) => [metric.id, metric]));

/** Closer to trouble first: the API's own severity, then how much of the window is used. */
function tighter(a: UsageWindow, b: UsageWindow): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.usedPercent - a.usedPercent;
}

/** The window closest to its limit, or null when there are none. */
export function tightestWindow(windows: UsageWindow[]): UsageWindow | null {
  return [...windows].sort(tighter)[0] ?? null;
}

/**
 * Session, because it is the one that moves by the hour, and whichever other
 * window is tightest, because that is the one that stops work for days.
 */
export function headlineWindows(windows: UsageWindow[]): UsageWindow[] {
  const session = windows.find((window) => kindOf(window) === 'session') ?? null;
  const other = tightestWindow(windows.filter((window) => window !== session));
  return [session, other].filter((window): window is UsageWindow => window !== null);
}

/** A limit by what it is, in the words Claude's own usage page uses, whatever label the reading came with. */
export function limitName(window: UsageWindow): string {
  switch (kindOf(window)) {
    case 'session':
      return '5-hour session';
    case 'weekly_all':
      return 'Weekly, all models';
    case 'weekly_scoped':
      return window.scope ? `Weekly, ${window.scope}` : 'Weekly';
    case 'spend':
      return 'Credits';
    default:
      return window.label;
  }
}

/** The usage-delay categories by those same names, for a held job's reasons. */
const CATEGORY_NAMES: Record<string, string> = {
  session: '5-hour session',
  weekly: 'Weekly, all models',
  fable: 'Weekly, Fable',
  credits: 'Credits',
};

/** See `LimitStatus` for what each answer means. `waitsAt` is null when no node holds jobs on this limit. */
export function limitStatus(window: Pick<UsageWindow, 'severity' | 'usedPercent'>, waitsAt: number | null): LimitStatus {
  if (window.usedPercent >= 100) return 'reached';
  if (window.severity !== 'normal') return 'near';
  if (waitsAt !== null && window.usedPercent >= waitsAt) return 'near';
  return 'ok';
}

/** The earliest any of these nodes holds a job on this limit, or null when no category covers it. */
function waitsAt(window: UsageWindow, thresholds: UsageThresholds[]): number | null {
  const category = USAGE_DELAY_CATEGORIES.find((candidate) => candidate.matches(window));
  if (!category || !thresholds.length) return null;
  return Math.min(...thresholds.map((given) => given[category.id]));
}

/** The worst of an account's limits; `unknown` with none to judge. */
export function accountStatus(limits: Array<{ status: LimitStatus }>): AccountStatus {
  return limits.reduce<AccountStatus>((worst, limit) => (STATUS_RANK[limit.status] > STATUS_RANK[worst] ? limit.status : worst), limits.length ? 'ok' : 'unknown');
}

/** Every node on one account reads the same numbers, so the freshest reading with any in it speaks for all. */
function freshest(readings: Array<UsageReading | null>): UsageReading | null {
  const at = (reading: UsageReading): number => Date.parse(reading.checkedAt ?? '') || 0;
  return (
    readings
      .filter((reading): reading is UsageReading => reading !== null)
      .sort((a, b) => Number(b.windows.length > 0) - Number(a.windows.length > 0) || at(b) - at(a))[0] ?? null
  );
}

/** `thresholds` are those of the online nodes the reading speaks for. */
function usageSummary(reading: UsageReading | null, thresholds: UsageThresholds[]): UsageSummary {
  const windows = (reading?.windows ?? []).map((window): AccountLimit => {
    const line = waitsAt(window, thresholds);
    return { ...window, name: limitName(window), status: limitStatus(window, line), waitsAt: line };
  });
  const tightest = tightestWindow(windows);
  return {
    windows,
    status: accountStatus(windows),
    headline: headlineWindows(windows).map((window) => window.key),
    tightest: tightest?.key ?? null,
    severity: tightest?.severity ?? 'normal',
    checkedAt: reading?.checkedAt ?? null,
    stale: Boolean(reading?.stale),
    reason: reading?.reason ?? null,
  };
}

/**
 * A node's reading, if it may be drawn under the account the node names. A
 * node that says whose numbers they are and names someone else is between
 * sign-ins, and its numbers wait until the two agree.
 */
function readingOf(node: ClusterNode): UsageReading | null {
  if (!node.online || !node.usage) return null;
  if (node.usage.accountId !== undefined && (node.usage.accountId ?? null) !== (node.account?.id ?? null)) return null;
  return node.usage;
}

/**
 * One entry per account, however many nodes are signed in to it. Usage comes
 * from online nodes only: an offline one's last reading is as old as the node's
 * silence. Its node still counts towards the account, so the panel can list it.
 * Only nodes that name their account are merged; see `unknownAccountUsage`.
 */
export function accountSummaries(nodes: ClusterNode[]): AccountSummary[] {
  const groups = new Map<string, ClusterNode[]>();
  for (const node of nodes) {
    if (!node.account) continue;
    groups.set(node.account.id, [...(groups.get(node.account.id) ?? []), node]);
  }
  return [...groups.entries()]
    .map(([id, members]) => {
      const online = members.filter((node) => node.online);
      return {
        id,
        // An address can change on one account; the one an online node reports is the current one.
        email: (online[0] ?? members[0])!.account!.email,
        ...usageSummary(freshest(members.map(readingOf)), online.map((node) => node.thresholds)),
        nodeIds: members.map((node) => node.id),
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** Each online node with no account named but a reading to show, kept apart, in node order. */
export function unknownAccountUsage(nodes: ClusterNode[]): UnknownAccountUsage[] {
  return nodes
    .filter((node) => !node.account)
    .map((node) => ({ nodeId: node.id, nodeName: node.name, ...usageSummary(readingOf(node), [node.thresholds]) }))
    .filter((entry) => entry.windows.length > 0);
}

/** Each node enforces its own limit, so the cluster's is their total, or none (0) when any node has none. */
export function clusterLimit(limits: number[]): number {
  return limits.includes(0) ? 0 : limits.reduce((total, limit) => total + limit, 0);
}

/** Critical before warning, then furthest past its line, then by node name so the order holds still. */
function worse(a: MachineException, b: MachineException): number {
  const rank = (exception: MachineException): number => SEVERITY_RANK[exception.severity];
  return rank(b) - rank(a) || b.value / b.threshold - a.value / a.threshold || a.nodeName.localeCompare(b.nodeName);
}

/** A machine reading in words that say what it measures: a full disk and a busy one are not the same trouble. */
const READINGS: Record<SystemMetricId, (value: number) => string> = {
  cpu: (value) => `CPU ${Math.round(value)}%`,
  memory: (value) => `Memory ${Math.round(value)}% used`,
  io: (value) => `Disk activity ${value < 10 ? value.toFixed(1) : Math.round(value)} MB/s`,
  disk: (value) => `Disk ${Math.round(value)}% full`,
};

/**
 * Every online node's metrics that are over the line the machine alerts use
 * (SYSTEM_ALERTS), worst first. The same rules, so the header never shows a
 * reading the notifications would call normal, or the other way round.
 */
export function machineExceptions(nodes: ClusterNode[]): MachineException[] {
  const found: MachineException[] = [];
  for (const node of nodes) {
    if (!node.online) continue;
    for (const alert of SYSTEM_ALERTS) {
      const reading = alert.read(node.samples, node.intervalMs);
      const metric = METRICS.get(alert.id as SystemMetricId);
      if (!reading?.breached || !metric) continue;
      const value = Math.round(reading.value * 10) / 10;
      found.push({
        nodeId: node.id,
        nodeName: node.name,
        metric: metric.id,
        label: metric.label,
        unit: metric.unit,
        kind: metric.kind,
        value,
        threshold: reading.threshold,
        severity: metric.critical !== undefined && reading.value >= metric.critical ? 'critical' : 'warning',
        reading: READINGS[metric.id](value),
      });
    }
  }
  return found.sort(worse);
}

/**
 * Usage holds first, because they wait on the clock rather than on a job
 * finishing, then in the order the nodes queue them: by when each trigger first
 * had to wait, which a trigger moved from a usage hold into the slot queue
 * keeps. Ties go by node, and two that arrived in the same instant on one node
 * keep that node's own order, its queue position, rather than their names. The
 * node id is in the key because two nodes may share a name.
 */
function queueOrder(a: WaitingJob, b: WaitingJob): number {
  const kind = (job: WaitingJob): number => (job.hold === 'usage' ? 0 : 1);
  const place = a.position !== null && b.position !== null ? a.position - b.position : 0;
  return (
    kind(a) - kind(b) ||
    Date.parse(a.since) - Date.parse(b.since) ||
    a.nodeName.localeCompare(b.nodeName) ||
    a.nodeId.localeCompare(b.nodeId) ||
    place ||
    a.name.localeCompare(b.name)
  );
}

/** Every trigger the online nodes are holding, in `queueOrder`. */
export function waitingJobs(nodes: ClusterNode[]): WaitingJob[] {
  return nodes
    .filter((node) => node.online)
    .flatMap((node) =>
      node.waiting.map(
        (entry): WaitingJob => ({
          id: entry.cronId,
          name: entry.cronName,
          kind: entry.kind,
          nodeId: node.id,
          nodeName: node.name,
          hold: entry.hold,
          limits:
            entry.hold === 'usage'
              ? (entry.reasons ?? []).map((reason) => ({
                  name: CATEGORY_NAMES[reason.id] ?? reason.label,
                  usedPercent: reason.usedPercent ?? null,
                  threshold: reason.threshold ?? null,
                  resetsAt: reason.resetsAt ?? null,
                }))
              : [],
          resumeAt: entry.resumeAt ?? null,
          since: entry.arrivedAt ?? entry.delayedAt,
          position: entry.hold === 'concurrency' && Number.isInteger(entry.position) ? entry.position! + 1 : null,
          queueLength: entry.hold === 'concurrency' ? entry.queueLength ?? null : null,
        }),
      ),
    )
    .sort(queueOrder);
}

/** "1 job", "3 jobs". */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The header's words. Every number carries its unit, a warning appears only
 * while there is something to say, and they come in a fixed order so the row
 * does not reshuffle as counts change.
 */
export function headerSummary(summary: Omit<ClusterSummary, 'availability' | 'header'>): HeaderSummary {
  const { nodes, running, concurrencyLimit, waiting, exceptions } = summary;
  const accounts = { reached: 0, near: 0 };
  for (const entry of [...summary.accounts, ...summary.unknownAccountUsage]) {
    if (entry.status === 'reached') accounts.reached += 1;
    else if (entry.status === 'near') accounts.near += 1;
  }
  const forUsage = waiting.filter((job) => job.hold === 'usage').length;
  const forSlot = waiting.length - forUsage;
  const offline = nodes.offline.length;

  const warnings: HeaderWarning[] = [];
  if (forUsage) warnings.push({ id: 'waiting-usage', section: 'jobs', text: `${count(forUsage, 'job')} waiting for account limits` });
  if (forSlot) warnings.push({ id: 'waiting-slot', section: 'jobs', text: `${count(forSlot, 'job')} queued behind the job limit` });
  if (accounts.reached || accounts.near) {
    const parts = [accounts.reached ? `${accounts.reached} reached` : null, accounts.near ? `${accounts.near} near` : null];
    warnings.push({ id: 'accounts', section: 'accounts', text: `Account limits: ${parts.filter(Boolean).join(', ')}` });
  }
  if (exceptions.length) warnings.push({ id: 'machines', section: 'computers', text: `Machine warnings: ${exceptions.length}` });
  if (!nodes.total) warnings.push({ id: 'offline', section: 'computers', text: 'No computers connected' });
  else if (offline) warnings.push({ id: 'offline', section: 'computers', text: `${count(offline, 'computer')} offline` });

  let capacity = `up to ${concurrencyLimit} at once across online computers`;
  if (!nodes.online) capacity = 'no computer is online to run them';
  else if (!concurrencyLimit) capacity = 'no limit on how many run at once';

  return {
    jobs: running ? `${count(running, 'job')} running` : 'No jobs running',
    capacity,
    computers: nodes.total ? `${nodes.online} of ${count(nodes.total, 'computer')} online` : 'No computers connected',
    accounts,
    warnings,
  };
}

/** A limit in the middle of a sentence: "weekly limit", "session limit", "Fable weekly limit", "credit limit". */
function limitPhrase(window: UsageWindow): string {
  switch (kindOf(window)) {
    case 'session':
      return 'session limit';
    case 'weekly_all':
      return 'weekly limit';
    case 'weekly_scoped':
      return window.scope ? `${window.scope} weekly limit` : 'weekly limit';
    case 'spend':
      return 'credit limit';
    default:
      return 'limit';
  }
}

/** One account as `availability` weighs it, from either kind of entry. */
interface Candidate {
  key: string;
  title: string;
  nodeNames: string[];
  usage: UsageSummary;
  tightest: AccountLimit;
}

/**
 * "2 accounts at their weekly limit" when every reached limit is the same
 * one, "2 accounts at a limit" when they differ; `other` puts "other" in.
 */
function reachedPhrase(reached: Candidate[], other: boolean): string {
  const noun = `${other ? 'other ' : ''}account${reached.length === 1 ? '' : 's'}`;
  const limits = new Set(reached.flatMap((candidate) => candidate.usage.windows.filter((limit) => limit.status === 'reached').map(limitPhrase)));
  const which = limits.size === 1 ? `${reached.length === 1 ? 'its' : 'their'} ${[...limits][0]}` : 'a limit';
  return `${reached.length} ${noun} at ${which}`;
}

function nearPhrase(near: number, other: boolean): string {
  return `${near} ${other ? 'other ' : ''}account${near === 1 ? '' : 's'} near ${near === 1 ? 'its' : 'a'} limit`;
}

/**
 * The best case over every account: the one whose tightest limit has the most
 * room, named by its computers, then how the rest stand and what is wrong.
 * Pure over the rest of the summary, so the tile's words are tested here with
 * the header's.
 */
export function availability(summary: Omit<ClusterSummary, 'availability' | 'header'>): Availability {
  const names = new Map(summary.computers.map((node) => [node.id, node.name]));
  // An account with no reading has no limit to weigh, so it is not a candidate.
  const candidate = (key: string, title: string, nodeNames: string[], usage: UsageSummary): Candidate | null => {
    const tightest = tightestWindow(usage.windows) as AccountLimit | null;
    return tightest ? { key, title, nodeNames, usage, tightest } : null;
  };
  const candidates = [
    ...summary.accounts.map((account) => candidate(`account:${account.id}`, account.email, account.nodeIds.map((id) => names.get(id) ?? id), account)),
    ...summary.unknownAccountUsage.map((entry) => candidate(`unknown:${entry.nodeId}`, 'Account unknown', [entry.nodeName], entry)),
  ]
    .filter((found): found is Candidate => found !== null)
    // Most room first; with the same room, the one whose status is better, then by name so the pick holds still.
    .sort(
      (a, b) =>
        b.tightest.usedPercent - a.tightest.usedPercent === 0
          ? STATUS_RANK[a.usage.status] - STATUS_RANK[b.usage.status] || a.title.localeCompare(b.title)
          : a.tightest.usedPercent - b.tightest.usedPercent,
    );

  const [bestOf, ...rest] = candidates;
  let best: BestAccount | null = null;
  if (bestOf) {
    const headline = bestOf.usage.windows.filter((limit) => ['session', 'weekly_all'].includes(kindOf(limit) ?? ''));
    best = {
      key: bestOf.key,
      title: bestOf.title,
      nodeNames: bestOf.nodeNames,
      status: bestOf.usage.status,
      tightest: bestOf.tightest,
      // In the reading's own order, with the tightest added only when it is not a headline limit already.
      limits: bestOf.usage.windows.filter((limit) => headline.includes(limit) || limit === bestOf.tightest),
      checkedAt: bestOf.usage.checkedAt,
      stale: bestOf.usage.stale,
    };
  }

  const reachedOthers = rest.filter((candidate) => candidate.usage.status === 'reached');
  const nearOthers = rest.filter((candidate) => candidate.usage.status === 'near').length;
  const resets = reachedOthers
    .flatMap((candidate) => candidate.usage.windows.filter((limit) => limit.status === 'reached').map((limit) => limit.resetsAt))
    .filter((at): at is string => Boolean(at))
    .sort();
  let othersText: string | null = null;
  if (reachedOthers.length && nearOthers) othersText = `${reachedPhrase(reachedOthers, true)}, ${nearOthers} near`;
  else if (reachedOthers.length) othersText = reachedPhrase(reachedOthers, true);
  else if (nearOthers) othersText = nearPhrase(nearOthers, true);
  else if (rest.length) othersText = `${rest.length} other account${rest.length === 1 ? '' : 's'} with room`;

  const reached = candidates.filter((candidate) => candidate.usage.status === 'reached');
  const near = candidates.filter((candidate) => candidate.usage.status === 'near').length;
  const forUsage = summary.waiting.filter((job) => job.hold === 'usage').length;
  const forSlot = summary.waiting.length - forUsage;
  const alerts: AvailabilityAlert[] = [];
  if (reached.length) alerts.push({ id: 'accounts-reached', section: 'accounts', severity: 'critical', text: reachedPhrase(reached, false) });
  if (forUsage) alerts.push({ id: 'waiting-usage', section: 'jobs', severity: 'warning', text: `${count(forUsage, 'job')} waiting for account limits` });
  if (forSlot) alerts.push({ id: 'waiting-slot', section: 'jobs', severity: 'warning', text: `${count(forSlot, 'job')} queued behind the job limit` });
  if (near) alerts.push({ id: 'accounts-near', section: 'accounts', severity: 'warning', text: nearPhrase(near, false) });
  if (summary.exceptions.length) {
    const [worst] = summary.exceptions;
    alerts.push({
      id: 'machines',
      section: 'computers',
      severity: worst!.severity,
      text: summary.exceptions.length === 1 ? `${worst!.nodeName}: ${worst!.reading}` : `Machine warnings: ${summary.exceptions.length}`,
    });
  }
  if (!summary.nodes.total) alerts.push({ id: 'offline', section: 'computers', severity: 'critical', text: 'No computers connected' });
  else if (summary.nodes.offline.length) {
    alerts.push({ id: 'offline', section: 'computers', severity: 'warning', text: `${count(summary.nodes.offline.length, 'computer')} offline` });
  }

  return {
    best,
    accounts: candidates.length,
    others: { count: rest.length, reached: reachedOthers.length, near: nearOthers, text: othersText, firstResetAt: resets[0] ?? null },
    alerts,
  };
}

export function clusterSummary(nodes: ClusterNode[], hubCommit: string | null): ClusterSummary {
  const online = nodes.filter((node) => node.online);
  const accounts = accountSummaries(nodes);
  const unknown = unknownAccountUsage(nodes);
  const accountKey = (node: ClusterNode): string | null => {
    if (node.account) return `account:${node.account.id}`;
    return unknown.some((entry) => entry.nodeId === node.id) ? `unknown:${node.id}` : null;
  };
  const summary: Omit<ClusterSummary, 'availability' | 'header'> = {
    nodes: {
      total: nodes.length,
      online: online.length,
      offline: nodes.filter((node) => !node.online).map(({ id, name, lastSeenAt }) => ({ id, name, lastSeenAt })),
    },
    computers: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      online: node.online,
      lastSeenAt: node.lastSeenAt,
      running: node.online ? node.running : 0,
      concurrencyLimit: node.online ? node.concurrencyLimit : 0,
      accountKey: accountKey(node),
    })),
    running: online.reduce((total, node) => total + node.running, 0),
    concurrencyLimit: clusterLimit(online.map((node) => node.concurrencyLimit)),
    waiting: waitingJobs(nodes),
    accounts,
    unknownAccountNodeIds: nodes.filter((node) => !node.account).map((node) => node.id),
    unknownAccountUsage: unknown,
    exceptions: machineExceptions(nodes),
    builds: {
      hubCommit,
      differing: online.filter((node) => node.commit && hubCommit && node.commit !== hubCommit).map((node) => node.id),
    },
  };
  return { ...summary, header: headerSummary(summary), availability: availability(summary) };
}
