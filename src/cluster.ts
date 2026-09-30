import { SYSTEM_ALERTS, SYSTEM_METRICS } from './system.js';
import type { SystemMetric, SystemMetricId } from './system.js';
import { kindOf } from './usage.js';
import type { ClaudeAccount, SystemSample, UsageReading, UsageWindow } from './types.js';

/**
 * The header's view of the whole cluster: how many nodes answer, how much of
 * their job limit is in use, one entry per Claude account rather than one per
 * node, and only those machine readings worth interrupting for.
 *
 * Pure functions over what the hub already holds, so the rules that decide what
 * the header says live in one place and are tested without a hub.
 */

/** What the summary needs to know about one node, online or not. */
export interface ClusterNode {
  id: string;
  name: string;
  online: boolean;
  commit: string | null;
  account: ClaudeAccount | null;
  usage: UsageReading | null;
  running: number;
  /** 0 is no limit, as a node reports it. */
  concurrencyLimit: number;
  samples: SystemSample[];
  intervalMs: number;
}

/** One reading as the header draws it. */
export interface UsageSummary {
  windows: UsageWindow[];
  /** Keys of Session and the tightest other window: what the header names the reading with. */
  headline: string[];
  /** Key of the one window closest to its limit, for a header with room for one. */
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
}

export interface ClusterSummary {
  nodes: { total: number; online: number; offline: Array<{ id: string; name: string }> };
  running: number;
  /** Summed over online nodes; 0 when any of them has no limit. */
  concurrencyLimit: number;
  accounts: AccountSummary[];
  /** Nodes that have not said which account they are on: signed out, or older than the field. */
  unknownAccountNodeIds: string[];
  /** The readings those nodes do report, one per online node that has one. */
  unknownAccountUsage: UnknownAccountUsage[];
  /** Worst first. */
  exceptions: MachineException[];
  builds: { hubCommit: string | null; differing: string[] };
}

const SEVERITY_RANK: Record<UsageWindow['severity'], number> = { normal: 0, warning: 1, critical: 2 };

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

/** Every node on one account reads the same numbers, so the freshest reading with any in it speaks for all. */
function freshest(readings: Array<UsageReading | null>): UsageReading | null {
  const at = (reading: UsageReading): number => Date.parse(reading.checkedAt ?? '') || 0;
  return (
    readings
      .filter((reading): reading is UsageReading => reading !== null)
      .sort((a, b) => Number(b.windows.length > 0) - Number(a.windows.length > 0) || at(b) - at(a))[0] ?? null
  );
}

function usageSummary(reading: UsageReading | null): UsageSummary {
  const windows = reading?.windows ?? [];
  const tightest = tightestWindow(windows);
  return {
    windows,
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
        ...usageSummary(freshest(members.map(readingOf))),
        nodeIds: members.map((node) => node.id),
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** Each online node with no account named but a reading to show, kept apart, in node order. */
export function unknownAccountUsage(nodes: ClusterNode[]): UnknownAccountUsage[] {
  return nodes
    .filter((node) => !node.account)
    .map((node) => ({ nodeId: node.id, nodeName: node.name, ...usageSummary(readingOf(node)) }))
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
      found.push({
        nodeId: node.id,
        nodeName: node.name,
        metric: metric.id,
        label: metric.label,
        unit: metric.unit,
        kind: metric.kind,
        value: Math.round(reading.value * 10) / 10,
        threshold: reading.threshold,
        severity: metric.critical !== undefined && reading.value >= metric.critical ? 'critical' : 'warning',
      });
    }
  }
  return found.sort(worse);
}

export function clusterSummary(nodes: ClusterNode[], hubCommit: string | null): ClusterSummary {
  const online = nodes.filter((node) => node.online);
  return {
    nodes: {
      total: nodes.length,
      online: online.length,
      offline: nodes.filter((node) => !node.online).map(({ id, name }) => ({ id, name })),
    },
    running: online.reduce((total, node) => total + node.running, 0),
    concurrencyLimit: clusterLimit(online.map((node) => node.concurrencyLimit)),
    accounts: accountSummaries(nodes),
    unknownAccountNodeIds: nodes.filter((node) => !node.account).map((node) => node.id),
    unknownAccountUsage: unknownAccountUsage(nodes),
    exceptions: machineExceptions(nodes),
    builds: {
      hubCommit,
      differing: online.filter((node) => node.commit && hubCommit && node.commit !== hubCommit).map((node) => node.id),
    },
  };
}
