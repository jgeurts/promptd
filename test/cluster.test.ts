import { describe, expect, it } from 'vitest';

import { accountSummaries, clusterLimit, clusterSummary, headlineWindows, machineExceptions, tightestWindow } from '../src/cluster.js';
import type { ClusterNode } from '../src/cluster.js';
import type { SystemSample, UsageReading, UsageWindow } from '../src/types.js';

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
    commit: 'abc1234',
    account: ALEX,
    usage: null,
    running: 0,
    concurrencyLimit: 12,
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

describe('headlineWindows', () => {
  it('is Session and the tightest other window, in that order', () => {
    const windows = [usageWindow('weekly_all', 40), usageWindow('session', 95), usageWindow('weekly_scoped', 70, 'normal', 'Fable')];
    expect(headlineWindows(windows).map((window) => window.label)).toEqual(['Session', 'Weekly · Fable']);
  });

  it('is the tightest window alone when the account reports no session', () => {
    expect(headlineWindows([usageWindow('spend', 20), usageWindow('weekly_all', 30)]).map((window) => window.label)).toEqual(['Weekly']);
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

  it('carries the worst severity and the headline pick', () => {
    const [account] = accountSummaries([
      node({ usage: reading([usageWindow('session', 38), usageWindow('weekly_all', 83, 'warning'), usageWindow('weekly_scoped', 52, 'normal', 'Fable')]) }),
    ]);
    expect(account?.severity).toBe('warning');
    expect(account?.tightest).toBe('weekly_all:0');
    expect(account?.headline).toEqual(['session:0', 'weekly_all:0']);
  });

  it('leaves out nodes that have not said which account they are on', () => {
    expect(accountSummaries([node({ account: null, usage: reading([usageWindow('session', 10)]) })])).toEqual([]);
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
    expect(summary.nodes).toEqual({ total: 3, online: 2, offline: [{ id: 'studio', name: 'studio' }] });
  });
});

describe('machineExceptions', () => {
  it('reports only metrics over their alert line', () => {
    expect(machineExceptions([node({ samples: minuteOf({ disk: 79 }) })])).toEqual([]);
    const [exception] = machineExceptions([node({ name: 'air', samples: minuteOf({ disk: 91 }) })]);
    expect(exception).toMatchObject({ nodeName: 'air', metric: 'disk', label: 'Disk', value: 91, threshold: 80, severity: 'warning' });
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
