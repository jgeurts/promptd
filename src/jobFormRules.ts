/**
 * The job form's rules: what the one-time execution form sends for its date
 * and for Is Active when it saves, and what the Node field reads off the
 * cluster for each computer. The page loads the compiled module, as it does
 * naming.js, so these rules are tested here rather than only in a browser.
 *
 * Nothing here imports anything at runtime, for the same reason.
 */

import type { AccountLimit, ClusterSummary, UsageSummary } from './cluster.js';

/** What the Node field shows for one computer, from the cluster summary that /api/health and /api/nodes carry. */
export interface NodeReading {
  online: boolean;
  running: number;
  /** 0 is no limit. */
  concurrencyLimit: number;
  lastSeenAt: string | null;
  /** The account's email, "Account unknown" for a computer that reports usage without naming one, or null with no block to draw. */
  account: string | null;
  /** The other computers signed in to the same account: one reading serves them all. */
  sharedWith: string[];
  /** The 5-hour session and the weekly all-models limit, with the bottleneck added when it is another: the tile's own pick. */
  limits: AccountLimit[];
  checkedAt: string | null;
  stale: boolean;
  /** Why there is no reading, when the account has none. */
  reason: string | null;
}

/** The parts of the summary the Node field draws from. */
export type NodeBlocks = Pick<ClusterSummary, 'accounts' | 'computers' | 'unknownAccountUsage'>;

/** The window that stops work first: most used, then the one the API calls worse, then by key. The same order as `bottleneckWindow` in cluster.ts. */
const SEVERITY_RANK: Record<AccountLimit['severity'], number> = { normal: 0, warning: 1, critical: 2 };
function bottleneck(windows: AccountLimit[]): AccountLimit | null {
  return [...windows].sort((a, b) => b.usedPercent - a.usedPercent || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.key.localeCompare(b.key))[0] ?? null;
}

/** The same pick as the tile's `best.limits` (`availability` in cluster.ts): session and weekly, in the reading's own order, plus the bottleneck when it is another. */
function shownLimits(usage: UsageSummary): AccountLimit[] {
  const kind = (limit: AccountLimit): string => limit.kind ?? limit.key.split(':')[0] ?? '';
  const worst = bottleneck(usage.windows);
  return usage.windows.filter((limit) => ['session', 'weekly_all'].includes(kind(limit)) || limit === worst);
}

/**
 * One reading per computer, by id. A computer's usage sits under its account
 * block, or under its own entry when it has not named an account; computers
 * on one account read the same block, and name each other as sharing it.
 */
export function nodeReadings(cluster: NodeBlocks): Map<string, NodeReading> {
  const names = new Map(cluster.computers.map((node) => [node.id, node.name]));
  const blocks = new Map<string, { title: string; nodeIds: string[]; usage: UsageSummary }>();
  for (const account of cluster.accounts) blocks.set(`account:${account.id}`, { title: account.email, nodeIds: account.nodeIds, usage: account });
  for (const entry of cluster.unknownAccountUsage) blocks.set(`unknown:${entry.nodeId}`, { title: 'Account unknown', nodeIds: [entry.nodeId], usage: entry });
  return new Map(
    cluster.computers.map((node) => {
      const block = node.accountKey ? (blocks.get(node.accountKey) ?? null) : null;
      return [
        node.id,
        {
          online: node.online,
          running: node.running,
          concurrencyLimit: node.concurrencyLimit,
          lastSeenAt: node.lastSeenAt,
          account: block?.title ?? null,
          sharedWith: (block?.nodeIds ?? []).filter((id) => id !== node.id).map((id) => names.get(id) ?? id),
          limits: block ? shownLimits(block.usage) : [],
          checkedAt: block?.usage.checkedAt ?? null,
          stale: Boolean(block?.usage.stale),
          reason: block?.usage.reason ?? null,
        },
      ];
    }),
  );
}

/**
 * The `scheduledAt` a save sends.
 *
 * The date field only shows minutes, while a job saved as soon as possible is
 * dated to the millisecond. Sending the field back would move that date a few
 * seconds, and the hub takes a moved date as a new one, re-arming a job that
 * has already run. So unless the field was changed from what it showed when
 * the form opened, the saved instant goes back exactly as it was.
 *
 * `typed` is the field's local "YYYY-MM-DDTHH:mm", read in this clock's zone.
 */
export function scheduledAtForSave(saved: string | null | undefined, shownAtOpen: string, typed: string): string {
  const value = typed.trim();
  if (saved && value === shownAtOpen.trim()) return saved;
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}


/**
 * The `isActive` a save sends. The form has no Is Active box for a one-time
 * execution: a new one is saved active, and an edit keeps what the execution
 * had, so opening an inactive one and saving it does not set it running.
 */
export function isActiveForSave(existing: { isActive: boolean } | null | undefined): boolean {
  return existing ? Boolean(existing.isActive) : true;
}
