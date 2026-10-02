import { describe, expect, it } from 'vitest';

import type { AccountLimit, UsageSummary } from '../src/cluster.js';
import { isActiveForSave, nodeReadings, scheduledAtForSave } from '../src/jobFormRules.js';
import type { NodeBlocks } from '../src/jobFormRules.js';

/** The field's value for an instant, in this clock's zone, as the page fills it. */
function shown(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe('the date an edit sends', () => {
  const saved = '2026-09-30T18:00:47.123Z';

  it('is the saved instant, seconds and all, while the field is left as it opened', () => {
    expect(scheduledAtForSave(saved, shown(saved), shown(saved))).toBe(saved);
  });

  it('is the field\'s time once it is changed', () => {
    const later = shown('2026-10-01T09:30:00.000Z');
    expect(scheduledAtForSave(saved, shown(saved), later)).toBe(new Date(later).toISOString());
  });

  it('is the field\'s time for a new or duplicated execution, which has nothing saved', () => {
    const typed = shown(saved);
    expect(scheduledAtForSave(null, typed, typed)).toBe(new Date(typed).toISOString());
    expect(scheduledAtForSave(null, typed, '')).toBe('');
  });
});

describe('Is Active on a one-time execution', () => {
  it('is on for a new one, and what it was for an edit', () => {
    expect(isActiveForSave(null)).toBe(true);
    expect(isActiveForSave({ isActive: false })).toBe(false);
    expect(isActiveForSave({ isActive: true })).toBe(true);
  });
});

describe('what the Node field reads for each computer', () => {
  const limit = (key: string, usedPercent: number, status: AccountLimit['status'] = 'ok', resetsAt: string | null = null): AccountLimit => ({
    key,
    kind: key.split(':')[0]!,
    scope: key.startsWith('weekly_scoped:') ? key.split(':')[1]! : null,
    label: key,
    detail: '',
    usedPercent,
    severity: status === 'ok' ? 'normal' : 'critical',
    resetsAt,
    name: key,
    status,
    waitsAt: null,
  });
  const usage = (windows: AccountLimit[], tightest: string | null, extra: Partial<UsageSummary> = {}): UsageSummary => ({
    windows,
    status: windows.some((window) => window.status === 'reached') ? 'reached' : windows.length ? 'ok' : 'unknown',
    headline: [],
    tightest,
    severity: 'normal',
    checkedAt: windows.length ? '2026-10-02T12:00:00.000Z' : null,
    stale: false,
    reason: null,
    ...extra,
  });
  const computer = (id: string, accountKey: string | null, online = true): NodeBlocks['computers'][number] => ({
    id,
    name: id,
    online,
    lastSeenAt: '2026-10-02T11:58:00.000Z',
    running: online ? 1 : 0,
    concurrencyLimit: online ? 4 : 0,
    accountKey,
  });
  const kim = { id: 'acct-kim', email: 'kim@example.com', nodeIds: ['galaxy', 'mini'] };
  const sam = { id: 'acct-sam', email: 'sam@example.com', nodeIds: ['studio'] };

  it('gives computers on one account the same reading, and names the others sharing it', () => {
    const shared = usage([limit('session:0', 38), limit('weekly_all:1', 100, 'reached', '2026-10-04T16:00:00.000Z')], 'weekly_all:1');
    const readings = nodeReadings({
      computers: [computer('galaxy', 'account:acct-kim'), computer('mini', 'account:acct-kim'), computer('studio', 'account:acct-sam')],
      accounts: [
        { ...kim, ...shared },
        { ...sam, ...usage([limit('session:0', 12), limit('weekly_all:1', 21)], 'weekly_all:1') },
      ],
      unknownAccountUsage: [],
    });
    expect(readings.get('galaxy')?.limits).toEqual(readings.get('mini')?.limits);
    expect(readings.get('galaxy')?.limits.map((entry) => entry.key)).toEqual(['session:0', 'weekly_all:1']);
    expect(readings.get('galaxy')).toMatchObject({ account: 'kim@example.com', sharedWith: ['mini'], online: true, running: 1, concurrencyLimit: 4 });
    expect(readings.get('mini')?.sharedWith).toEqual(['galaxy']);
    expect(readings.get('studio')).toMatchObject({ account: 'sam@example.com', sharedWith: [] });
  });

  it('shows the session and weekly limits, and another only when it is the most used', () => {
    const blocks = (scopedUsed: number): NodeBlocks => ({
      computers: [computer('galaxy', 'account:acct-kim')],
      // The severity-first `tightest` names the weekly limit either way; the tile goes by what is most used.
      accounts: [{ ...kim, nodeIds: ['galaxy'], ...usage([limit('session:0', 38), limit('weekly_all:1', 61, 'near'), limit('weekly_scoped:Fable', scopedUsed)], 'weekly_all:1') }],
      unknownAccountUsage: [],
    });
    expect(nodeReadings(blocks(95)).get('galaxy')?.limits.map((entry) => entry.key)).toEqual(['session:0', 'weekly_all:1', 'weekly_scoped:Fable']);
    expect(nodeReadings(blocks(50)).get('galaxy')?.limits.map((entry) => entry.key)).toEqual(['session:0', 'weekly_all:1']);
  });

  it('keeps an offline computer under its account, reading as offline', () => {
    const readings = nodeReadings({
      computers: [computer('galaxy', 'account:acct-kim'), computer('mini', 'account:acct-kim', false)],
      accounts: [{ ...kim, ...usage([limit('session:0', 38), limit('weekly_all:1', 61)], 'weekly_all:1') }],
      unknownAccountUsage: [],
    });
    expect(readings.get('mini')).toMatchObject({ online: false, running: 0, lastSeenAt: '2026-10-02T11:58:00.000Z', account: 'kim@example.com', sharedWith: ['galaxy'] });
    expect(readings.get('mini')?.limits).toHaveLength(2);
  });

  it('leaves a computer with nothing to show empty, with the reason when there is one', () => {
    const readings = nodeReadings({
      computers: [computer('lab', null), computer('studio', 'account:acct-sam')],
      accounts: [{ ...sam, ...usage([], null, { reason: 'reading usage for the account now signed in' }) }],
      unknownAccountUsage: [],
    });
    expect(readings.get('lab')).toMatchObject({ account: null, sharedWith: [], limits: [], reason: null });
    expect(readings.get('studio')).toMatchObject({ account: 'sam@example.com', limits: [], reason: 'reading usage for the account now signed in' });
  });

  it('keeps a computer that has not named its account on its own', () => {
    const readings = nodeReadings({
      computers: [computer('old', 'unknown:old')],
      accounts: [],
      unknownAccountUsage: [{ nodeId: 'old', nodeName: 'old', ...usage([limit('session:0', 50)], 'session:0') }],
    });
    expect(readings.get('old')).toMatchObject({ account: 'Account unknown', sharedWith: [] });
    expect(readings.get('old')?.limits.map((entry) => entry.key)).toEqual(['session:0']);
  });
});
