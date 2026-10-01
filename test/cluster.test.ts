import { describe, expect, it } from 'vitest';

import {
  accountStatus,
  accountSummaries,
  clusterLimit,
  clusterSummary,
  limitName,
  limitStatus,
  machineExceptions,
  tightestWindow,
  unknownAccountUsage,
  waitingJobs,
} from '../src/cluster.js';
import type { ClusterNode } from '../src/cluster.js';
import { DEFAULT_USAGE_THRESHOLDS } from '../src/usage.js';
import type { DelayEntry, SystemSample, UsageReading, UsageWindow } from '../src/types.js';

const ALEX = { id: 'acct-alex', email: 'alex@example.com' };
const SAM = { id: 'acct-sam', email: 'sam@example.com' };

function usageWindow(kind: string, usedPercent: number, severity: UsageWindow['severity'] = 'normal', scope: string | null = null): UsageWindow {
  const label = kind === 'session' ? 'Session' : kind === 'spend' ? 'Credits' : 'Weekly';
  return {
    key: `${kind}:${scope ?? 0}`,
    kind,
    scope,
    label: scope ? `${label} · ${scope}` : label,
    detail: label,
    usedPercent,
    severity,
    resetsAt: '2026-10-01T00:00:00.000Z',
  };
}

function reading(windows: UsageWindow[], checkedAt = '2026-09-30T12:00:00.000Z'): UsageReading {
  return { ok: windows.length > 0, reason: null, windows, checkedAt, stale: false };
}

/** A minute of five-second samples, all at the given readings. */
function minuteOf(values: Partial<SystemSample>): SystemSample[] {
  return Array.from({ length: 12 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 8, 30, 12, 0, index * 5)).toISOString(),
    cpu: 10,
    memory: 40,
    io: 1,
    disk: 50,
    ...values,
  }));
}

function node(overrides: Partial<ClusterNode>): ClusterNode {
  return {
    id: 'mini',
    name: 'mini',
    online: true,
    lastSeenAt: '2026-09-30T12:00:00.000Z',
    commit: 'abc1234',
    account: ALEX,
    usage: null,
    running: 0,
    concurrencyLimit: 12,
    thresholds: DEFAULT_USAGE_THRESHOLDS,
    waiting: [],
    samples: [],
    intervalMs: 5000,
    ...overrides,
  };
}

describe('tightestWindow', () => {
  it('picks the most used window', () => {
    const windows = [usageWindow('session', 38), usageWindow('weekly_all', 61), usageWindow('weekly_scoped', 52, 'normal', 'Fable')];
    expect(tightestWindow(windows)?.key).toBe('weekly_all:0');
  });

  it("puts the API's severity ahead of the percentage", () => {
    const windows = [usageWindow('session', 90), usageWindow('weekly_all', 83, 'warning')];
    expect(tightestWindow(windows)?.key).toBe('weekly_all:0');
  });

  it('answers null with nothing to pick from', () => {
    expect(tightestWindow([])).toBeNull();
  });
});

describe('accountSummaries', () => {
  it('gives two nodes on one account one entry, named by the email', () => {
    const accounts = accountSummaries([
      node({ id: 'mini', usage: reading([usageWindow('session', 38)]) }),
      node({ id: 'studio', name: 'studio', usage: reading([usageWindow('session', 38)]) }),
      node({ id: 'air', name: 'air', account: SAM, usage: reading([usageWindow('session', 12)]) }),
    ]);
    expect(accounts.map((account) => [account.email, account.nodeIds])).toEqual([
      ['alex@example.com', ['mini', 'studio']],
      ['sam@example.com', ['air']],
    ]);
  });

  it("reads usage from the freshest online node, never an offline one's", () => {
    const [account] = accountSummaries([
      node({ id: 'mini', usage: reading([usageWindow('session', 30)], '2026-09-30T12:00:00.000Z') }),
      node({ id: 'studio', usage: reading([usageWindow('session', 45)], '2026-09-30T12:04:00.000Z') }),
      node({ id: 'old', online: false, usage: reading([usageWindow('session', 99)], '2026-09-30T12:09:00.000Z') }),
    ]);
    expect(account?.windows[0]?.usedPercent).toBe(45);
    expect(account?.checkedAt).toBe('2026-09-30T12:04:00.000Z');
    expect(account?.nodeIds).toEqual(['mini', 'studio', 'old']);
  });

  it('prefers a reading with windows over a fresher empty one', () => {
    const [account] = accountSummaries([
      node({ id: 'mini', usage: reading([usageWindow('session', 30)], '2026-09-30T12:00:00.000Z') }),
      node({ id: 'studio', usage: reading([], '2026-09-30T12:05:00.000Z') }),
    ]);
    expect(account?.windows).toHaveLength(1);
  });

  it('carries the worst severity and the status of each limit', () => {
    const [account] = accountSummaries([
      node({ usage: reading([usageWindow('session', 38), usageWindow('weekly_all', 83, 'warning'), usageWindow('weekly_scoped', 52, 'normal', 'Fable')]) }),
    ]);
    expect(account?.severity).toBe('warning');
    expect(account?.status).toBe('near');
    expect(account?.windows.map((window) => [window.name, window.status])).toEqual([
      ['5-hour session', 'ok'],
      ['Weekly, all models', 'near'],
      ['Weekly, Fable', 'ok'],
    ]);
  });

  it('judges a limit against the lowest delay percentage of the online nodes on the account', () => {
    const [account] = accountSummaries([
      node({ id: 'mini', usage: reading([usageWindow('session', 72)]), thresholds: { ...DEFAULT_USAGE_THRESHOLDS, session: 80 } }),
      node({ id: 'studio', usage: reading([usageWindow('session', 72)]), thresholds: { ...DEFAULT_USAGE_THRESHOLDS, session: 70 } }),
      node({ id: 'old', online: false, thresholds: { ...DEFAULT_USAGE_THRESHOLDS, session: 50 } }),
    ]);
    expect(account?.windows[0]).toMatchObject({ waitsAt: 70, status: 'near' });
  });

  it('is unknown with no reading to judge', () => {
    expect(accountSummaries([node({ usage: null })])[0]?.status).toBe('unknown');
  });

  it('leaves out nodes that have not said which account they are on', () => {
    expect(accountSummaries([node({ account: null, usage: reading([usageWindow('session', 10)]) })])).toEqual([]);
  });

  it('holds back a reading the node says is for another account', () => {
    const [account] = accountSummaries([node({ usage: { ...reading([usageWindow('session', 99, 'critical')]), accountId: SAM.id } })]);
    expect(account?.windows).toEqual([]);
  });
});

describe('unknownAccountUsage', () => {
  it("keeps the usage of a node that names no account, as an older build's does", () => {
    const summary = clusterSummary([node({ id: 'mini', account: null, usage: reading([usageWindow('session', 38)]) })], null);
    expect(summary.accounts).toEqual([]);
    expect(summary.unknownAccountUsage).toMatchObject([{ nodeId: 'mini', nodeName: 'mini', status: 'ok', severity: 'normal' }]);
    expect(summary.unknownAccountUsage[0]?.windows[0]?.usedPercent).toBe(38);
  });

  it('never merges two such nodes, which may be on different accounts', () => {
    const entries = unknownAccountUsage([
      node({ id: 'mini', account: null, usage: reading([usageWindow('session', 38)]) }),
      node({ id: 'air', name: 'air', account: null, usage: reading([usageWindow('session', 38)]) }),
    ]);
    expect(entries.map((entry) => entry.nodeId)).toEqual(['mini', 'air']);
  });

  it('still merges nodes that name the same account beside them', () => {
    const summary = clusterSummary(
      [
        node({ id: 'mini', usage: reading([usageWindow('session', 38)]) }),
        node({ id: 'studio', name: 'studio', usage: reading([usageWindow('session', 38)]) }),
        node({ id: 'old', name: 'old', account: null, usage: reading([usageWindow('session', 71)]) }),
      ],
      null,
    );
    expect(summary.accounts.map((account) => account.nodeIds)).toEqual([['mini', 'studio']]);
    expect(summary.unknownAccountUsage.map((entry) => entry.nodeId)).toEqual(['old']);
  });

  it('leaves out offline nodes and nodes with no windows', () => {
    expect(
      unknownAccountUsage([
        node({ account: null, online: false, usage: reading([usageWindow('session', 38)]) }),
        node({ id: 'air', account: null, usage: reading([]) }),
      ]),
    ).toEqual([]);
  });
});

describe('clusterLimit', () => {
  it('adds up the limits', () => {
    expect(clusterLimit([12, 16, 8])).toBe(36);
  });

  it('is no limit when any node has none', () => {
    expect(clusterLimit([12, 0])).toBe(0);
  });

  it('counts online nodes only', () => {
    const summary = clusterSummary(
      [
        node({ id: 'mini', running: 2, concurrencyLimit: 12 }),
        node({ id: 'studio', name: 'studio', online: false, running: 0, concurrencyLimit: 0 }),
        node({ id: 'air', name: 'air', running: 1, concurrencyLimit: 8 }),
      ],
      'abc1234',
    );
    expect(summary.running).toBe(3);
    expect(summary.concurrencyLimit).toBe(20);
    expect(summary.nodes).toEqual({ total: 3, online: 2, offline: [{ id: 'studio', name: 'studio', lastSeenAt: '2026-09-30T12:00:00.000Z' }] });
  });
});

describe('machineExceptions', () => {
  it('reports only metrics over their alert line', () => {
    expect(machineExceptions([node({ samples: minuteOf({ disk: 79 }) })])).toEqual([]);
    const [exception] = machineExceptions([node({ name: 'air', samples: minuteOf({ disk: 91 }) })]);
    expect(exception).toMatchObject({ nodeName: 'air', metric: 'disk', label: 'Disk', value: 91, threshold: 80, severity: 'warning', reading: 'Disk 91% full' });
  });

  it('words each reading by what it measures', () => {
    const readings = machineExceptions([node({ samples: minuteOf({ cpu: 94, memory: 86 }) })]).map((exception) => exception.reading);
    expect(readings).toEqual(['CPU 94%', 'Memory 86% used']);
  });

  it('puts the worst first: critical, then furthest past the line', () => {
    const exceptions = machineExceptions([
      node({ id: 'mini', name: 'mini', samples: minuteOf({ memory: 85 }) }),
      node({ id: 'air', name: 'air', samples: minuteOf({ disk: 91 }) }),
      node({ id: 'studio', name: 'studio', samples: minuteOf({ cpu: 96 }) }),
    ]);
    expect(exceptions.map((exception) => `${exception.metric} ${exception.nodeName} ${exception.severity}`)).toEqual([
      'cpu studio critical',
      'disk air warning',
      'memory mini warning',
    ]);
  });

  it('ignores offline nodes and windows too short to judge', () => {
    expect(machineExceptions([node({ online: false, samples: minuteOf({ disk: 99 }) })])).toEqual([]);
    expect(machineExceptions([node({ samples: minuteOf({ cpu: 99 }).slice(-3) })])).toEqual([]);
  });
});

describe('clusterSummary', () => {
  it('names online nodes on a different build than the hub', () => {
    const summary = clusterSummary(
      [node({ id: 'mini', commit: 'abc1234' }), node({ id: 'air', commit: 'old0001' }), node({ id: 'studio', online: false, commit: 'old0001' })],
      'abc1234',
    );
    expect(summary.builds.differing).toEqual(['air']);
  });

  it('lists nodes with no account apart', () => {
    const summary = clusterSummary([node({ id: 'mini' }), node({ id: 'air', account: null })], null);
    expect(summary.unknownAccountNodeIds).toEqual(['air']);
    expect(summary.builds.differing).toEqual([]);
  });
});

describe('limitStatus', () => {
  it('is reached only when the limit is used up', () => {
    expect(limitStatus({ usedPercent: 100, severity: 'critical' }, 95)).toBe('reached');
    expect(limitStatus({ usedPercent: 99.9, severity: 'critical' }, null)).toBe('near');
  });

  it("is near when Claude's API flags it, however low it is", () => {
    expect(limitStatus({ usedPercent: 60, severity: 'warning' }, 95)).toBe('near');
  });

  it('is near at or past the percentage where jobs set to wait are held', () => {
    expect(limitStatus({ usedPercent: 95, severity: 'normal' }, 95)).toBe('near');
    expect(limitStatus({ usedPercent: 94, severity: 'normal' }, 95)).toBe('ok');
  });

  it('is ok with no delay percentage covering the limit', () => {
    expect(limitStatus({ usedPercent: 97, severity: 'normal' }, null)).toBe('ok');
  });
});

describe('accountStatus', () => {
  it('is the worst of the limits, or unknown with none', () => {
    expect(accountStatus([{ status: 'ok' }, { status: 'reached' }, { status: 'near' }])).toBe('reached');
    expect(accountStatus([{ status: 'ok' }, { status: 'near' }])).toBe('near');
    expect(accountStatus([{ status: 'ok' }])).toBe('ok');
    expect(accountStatus([])).toBe('unknown');
  });
});

describe('limitName', () => {
  it('names each limit plainly, whatever label the reading came with', () => {
    expect(
      [usageWindow('session', 1), usageWindow('weekly_all', 1), usageWindow('weekly_scoped', 1, 'normal', 'Fable'), usageWindow('spend', 1)].map(limitName),
    ).toEqual(['5-hour session', 'Weekly, all models', 'Weekly, Fable', 'Credits']);
  });

  it("falls back to the reading's own label for a kind it does not know", () => {
    expect(limitName({ ...usageWindow('monthly_new', 1), label: 'Monthly new' })).toBe('Monthly new');
  });
});

function held(overrides: Partial<DelayEntry>): DelayEntry {
  return {
    cronId: 'digest',
    cronName: 'Digest',
    kind: 'cron',
    source: 'schedule',
    hold: 'usage',
    arrivedAt: '2026-09-30T11:00:00.000Z',
    delayedAt: '2026-09-30T11:00:00.000Z',
    checkedAt: '2026-09-30T11:00:00.000Z',
    reasons: [],
    ...overrides,
  };
}

describe('waitingJobs', () => {
  it('lists usage holds first, then slot holds, each in arrival order, with their reasons in plain names', () => {
    const jobs = waitingJobs([
      node({
        id: 'mini',
        name: 'mini',
        waiting: [
          // Queued first but moved into the queue last: it arrived waiting on usage, which keeps its place.
          held({ cronId: 'q', cronName: 'Queue later', hold: 'concurrency', position: 1, queueLength: 2, arrivedAt: '2026-09-30T10:30:00.000Z', delayedAt: '2026-09-30T10:30:00.000Z' }),
          held({ cronId: 'b', cronName: 'Backup', hold: 'concurrency', position: 0, queueLength: 2, arrivedAt: '2026-09-30T10:00:00.000Z', delayedAt: '2026-09-30T11:45:00.000Z' }),
          held({ cronId: 'r', cronName: 'Report', arrivedAt: '2026-09-30T11:30:00.000Z', delayedAt: '2026-09-30T11:30:00.000Z', reasons: [{ id: 'weekly', label: 'Weekly', usedPercent: 100, threshold: 95, resetsAt: null }] }),
        ],
      }),
      node({ id: 'air', name: 'air', waiting: [held({ cronId: 'd', cronName: 'Digest', arrivedAt: '2026-09-30T11:00:00.000Z', reasons: [{ id: 'fable', label: 'Fable' }] })] }),
      node({ id: 'old', online: false, waiting: [held({ cronId: 'x' })] }),
    ]);
    expect(jobs.map((job) => [job.id, job.hold, job.nodeName, job.position])).toEqual([
      ['d', 'usage', 'air', null],
      ['r', 'usage', 'mini', null],
      ['b', 'concurrency', 'mini', 1],
      ['q', 'concurrency', 'mini', 2],
    ]);
    expect(jobs[1]?.limits).toEqual([{ name: 'Weekly, all models', usedPercent: 100, threshold: 95, resetsAt: null }]);
    expect(jobs[2]).toMatchObject({ queueLength: 2, limits: [], since: '2026-09-30T10:00:00.000Z' });
  });

  it("keeps a node's own queue order for two that arrived in the same instant", () => {
    const at = '2026-09-30T10:00:00.000Z';
    const jobs = waitingJobs([
      node({
        waiting: [
          held({ cronId: 'a', cronName: 'Alpha', hold: 'concurrency', position: 1, queueLength: 2, arrivedAt: at }),
          held({ cronId: 'z', cronName: 'Zulu', hold: 'concurrency', position: 0, queueLength: 2, arrivedAt: at }),
        ],
      }),
    ]);
    expect(jobs.map((job) => [job.name, job.position])).toEqual([
      ['Zulu', 1],
      ['Alpha', 2],
    ]);
  });
});

describe('header summary', () => {
  const sam = (windows: UsageWindow[]): Partial<ClusterNode> => ({ account: SAM, usage: reading(windows) });

  it('is all clear with nothing to say, and words the counts with their units', () => {
    const { header } = clusterSummary([node({ id: 'mini', running: 1 }), node({ id: 'studio', name: 'studio' }), node({ id: 'air', name: 'air' })], null);
    expect(header).toEqual({
      jobs: '1 job running',
      capacity: 'up to 36 at once across online computers',
      computers: '3 of 3 computers online',
      accounts: { reached: 0, near: 0 },
      warnings: [],
    });
  });

  it('says none, one and many', () => {
    expect(clusterSummary([node({ running: 0 })], null).header).toMatchObject({ jobs: 'No jobs running', computers: '1 of 1 computer online' });
    expect(clusterSummary([node({ running: 3 }), node({ id: 'air', online: false })], null).header).toMatchObject({
      jobs: '3 jobs running',
      computers: '1 of 2 computers online',
      warnings: [{ id: 'offline', section: 'computers', text: '1 computer offline' }],
    });
    const twoDown = clusterSummary([node({}), node({ id: 'air', online: false }), node({ id: 'studio', online: false })], null).header;
    expect(twoDown.warnings.map((warning) => warning.text)).toEqual(['2 computers offline']);
  });

  it('says what the limit means when it is none, or when nothing is online', () => {
    expect(clusterSummary([node({ concurrencyLimit: 0 })], null).header.capacity).toBe('no limit on how many run at once');
    expect(clusterSummary([node({ online: false })], null).header.capacity).toBe('no computer is online to run them');
    expect(clusterSummary([], null).header).toMatchObject({
      computers: 'No computers connected',
      warnings: [{ id: 'offline', text: 'No computers connected' }],
    });
  });

  it('counts accounts once each, under their worst limit, including usage with no account named', () => {
    const { header } = clusterSummary(
      [
        node({ id: 'mini', usage: reading([usageWindow('session', 6), usageWindow('weekly_all', 100, 'critical')]) }),
        node({ id: 'air', name: 'air', ...sam([usageWindow('session', 82, 'warning'), usageWindow('weekly_scoped', 98, 'critical', 'Fable')]) }),
        node({ id: 'old', name: 'old', account: null, usage: reading([usageWindow('weekly_all', 84, 'warning')]) }),
      ],
      null,
    );
    expect(header.accounts).toEqual({ reached: 1, near: 2 });
    expect(header.warnings).toEqual([{ id: 'accounts', section: 'accounts', text: 'Account limits: 1 reached, 2 near' }]);
  });

  it('leaves out the half of the account count that is zero', () => {
    const near = clusterSummary([node({ usage: reading([usageWindow('weekly_all', 84, 'warning')]) })], null).header;
    expect(near.warnings.map((warning) => warning.text)).toEqual(['Account limits: 1 near']);
    const reached = clusterSummary([node({ usage: reading([usageWindow('weekly_all', 100, 'critical')]) })], null).header;
    expect(reached.warnings.map((warning) => warning.text)).toEqual(['Account limits: 1 reached']);
  });

  it('puts every warning in its fixed order: held jobs, account limits, machines, computers offline', () => {
    const { header } = clusterSummary(
      [
        node({
          id: 'mini',
          usage: reading([usageWindow('weekly_all', 100, 'critical')]),
          samples: minuteOf({ cpu: 94, memory: 86 }),
          waiting: [held({ cronId: 'a' }), held({ cronId: 'b', hold: 'concurrency' }), held({ cronId: 'c' })],
        }),
        node({ id: 'air', name: 'air', online: false }),
      ],
      null,
    );
    expect(header.warnings).toEqual([
      { id: 'waiting-usage', section: 'jobs', text: '2 jobs waiting for account limits' },
      { id: 'waiting-slot', section: 'jobs', text: '1 job queued behind the job limit' },
      { id: 'accounts', section: 'accounts', text: 'Account limits: 1 reached' },
      { id: 'machines', section: 'computers', text: 'Machine warnings: 2' },
      { id: 'offline', section: 'computers', text: '1 computer offline' },
    ]);
  });

  it('shows a warning only while it has something to say', () => {
    const { header } = clusterSummary([node({ usage: reading([usageWindow('session', 40)]), samples: minuteOf({ cpu: 30 }) })], null);
    expect(header.warnings).toEqual([]);
  });
});
