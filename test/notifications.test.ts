import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type * as DbModule from '../src/db.js';
import type * as NotificationsModule from '../src/notifications.js';
import type { BusEvent } from '../src/types.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-notifications-'));
process.env.PROMPTD_HOME = home;

let dbModule: typeof DbModule;
let notifications: typeof NotificationsModule;
let center: InstanceType<(typeof NotificationsModule)['NotificationCenter']>;

beforeAll(async () => {
  dbModule = await import('../src/db.js');
  notifications = await import('../src/notifications.js');
  dbModule.openDatabase(`sqlite:${path.join(home, 'test.sqlite')}`);
  await dbModule.migrate();
});

afterAll(async () => {
  await dbModule.closeDatabase();
});

beforeEach(async () => {
  await dbModule.db().deleteFrom('notifications').execute();
  center = new notifications.NotificationCenter();
  center.ready = center.load();
  await center.ready;
});

function event(type: string, fields: Record<string, unknown> = {}): BusEvent {
  return { type, at: new Date().toISOString(), ...fields };
}

/** What a node reports, as the hub relays it: stamped with the node it came from. */
function fromNode(nodeId: string, type: string, fields: Record<string, unknown> = {}): BusEvent {
  return event(type, { ...fields, nodeId, nodeName: nodeId });
}

const failed = { cronId: 'c1', cronName: 'Nightly', kind: 'cron', status: 'failed', seconds: 4 };

describe('the node a notification names', () => {
  it('keeps the node the hub stamped on a relayed event', () => {
    center.record(fromNode('studio', 'run:finished', failed));
    expect(center.items[0]).toMatchObject({ nodeId: 'studio', nodeName: 'studio' });
  });

  it('credits the hub with its own events', () => {
    center.record(event('update:failed', { code: 1 }));
    expect(center.items[0]).toMatchObject({ nodeId: 'hub', nodeName: 'hub' });
  });

  it('writes the node down, so it survives a restart', async () => {
    center.record(fromNode('studio', 'run:finished', failed));
    await center.items[0]!.writing;
    const reloaded = new notifications.NotificationCenter();
    await reloaded.load();
    expect(reloaded.items[0]).toMatchObject({ nodeId: 'studio', nodeName: 'studio' });
  });

  it('names no machines while there is only one', async () => {
    const page = await center.page({ nodes: [{ id: 'mini', name: 'mini' }] });
    expect(page.nodes).toEqual([]);
  });

  it('names the hub beside two or more nodes', async () => {
    const page = await center.page({ nodes: [{ id: 'mini', name: 'mini' }, { id: 'studio', name: 'studio' }] });
    expect(page.nodes.map((node) => node.id)).toEqual(['hub', 'mini', 'studio']);
  });
});

const job = { cronId: 'c1', cronName: 'Nightly', kind: 'cron' };
const held = { ...job, hold: 'usage', reasons: [{ id: 'weekly', label: 'Weekly' }] };

describe('the level of each kind', () => {
  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    ['a failed run', 'run:finished', { ...job, status: 'failed', seconds: 3 }, 'action'],
    ['an interrupted run', 'run:finished', { ...job, status: 'interrupted', seconds: null }, 'action'],
    ['a worktree include that failed', 'worktree:include-failed', { ...job, error: 'EACCES' }, 'action'],
    ['a worktree clean up that failed', 'worktree:cleanup-failed', { ...job, error: 'locked' }, 'action'],
    ['an update that failed', 'update:failed', { code: 1 }, 'action'],
    ['an update that gave up', 'update:abandoned', { runningCount: 2 }, 'action'],
    ['low disk space', 'system:alert', { metric: 'disk', label: 'Low disk space', summary: '9% free' }, 'action'],
    ['a retrospective', 'run:retrospective', { ...job, logFile: 'a.txt' }, 'worth'],
    ['a missed execution made up', 'execution:overdue', { ...job, kind: 'execution', lateBy: '5m' }, 'worth'],
    ['high CPU', 'system:alert', { metric: 'cpu', label: 'High CPU', summary: '91%' }, 'worth'],
    ['high memory', 'system:alert', { metric: 'memory', label: 'High memory', summary: '88%' }, 'worth'],
    ['unusual I/O', 'system:alert', { metric: 'io', label: 'Unusual storage I/O', summary: '400 MB/s' }, 'worth'],
    ['a usage-held trigger', 'run:delayed', held, 'worth'],
    ['an update applied', 'update:launched', { from: 'abc1234' }, 'worth'],
    ['a run that succeeded', 'run:finished', { ...job, status: 'succeeded', seconds: 3 }, 'routine'],
    ['a run the user stopped', 'run:finished', { ...job, status: 'stopped', seconds: 3 }, 'routine'],
    ['a skipped trigger', 'run:skipped', job, 'routine'],
    ['a dropped trigger', 'run:dropped', { ...job, reason: 'paused' }, 'routine'],
    ['a trigger queued for a slot', 'run:delayed', { ...job, hold: 'concurrency', position: 0, queueLength: 1, runningCount: 2 }, 'routine'],
    ['a held trigger released', 'run:released', { ...held, ran: true }, 'routine'],
    ['a held trigger cancelled', 'run:released', { ...held, ran: false, reason: 'cancelled by user' }, 'routine'],
    ['a pause', 'pause:changed', { paused: true, mode: 'manual', label: 'for 1 hour' }, 'routine'],
    ['a resume', 'pause:changed', { paused: false, resumedFrom: 'for 1 hour', resumedMode: 'manual', reason: 'cancelled' }, 'routine'],
  ];

  it.each(cases)('files %s as %s', (_name, type, fields, level) => {
    expect(notifications.describe(event(type, fields) as never)?.level).toBe(level);
  });

  it.each([
    ['run:started', job],
    ['run:stopping', job],
    ['update:availability', { updateAvailable: true, updateBehind: 3 }],
    ['update:waiting', { runningCount: 1 }],
    ['pause:changed', { paused: true, mode: 'update', label: 'for update' }],
    ['pause:changed', { paused: false, resumedFrom: 'for update', resumedMode: 'update', reason: 'update gave up waiting' }],
  ])('keeps %s out of the drawer', (type, fields) => {
    expect(notifications.describe(event(type, fields) as never)).toBeNull();
  });

  it('delivers routine already read, and the rest unread', () => {
    center.record(event('run:finished', { ...job, status: 'succeeded', seconds: 1 }));
    center.record(event('run:retrospective', job));
    center.record(event('run:finished', failed));
    expect(center.items.map((record) => [record.level, record.read])).toEqual([
      ['action', false],
      ['worth', false],
      ['routine', true],
    ]);
  });
});

describe('the bell counts', () => {
  it('counts unread needs-action and worth-knowing records, never routine', () => {
    center.record(fromNode('studio', 'run:finished', failed));
    center.record(fromNode('studio', 'system:alert', { metric: 'disk', label: 'Low disk space', summary: '9% free' }));
    center.record(fromNode('air', 'run:finished', failed));
    center.record(fromNode('air', 'run:retrospective', job));
    center.record(fromNode('air', 'run:finished', { ...job, status: 'succeeded', seconds: 1 }));
    expect(center.counts()).toEqual({ action: 3, worth: 1, nodes: { studio: 2, air: 1 } });
  });

  it('stops counting what has been read', async () => {
    center.record(event('run:finished', failed));
    center.record(event('run:retrospective', job));
    const [action, worth] = center.items.map((record) => record.id).reverse();
    expect((await center.markRead([action!])).counts).toMatchObject({ action: 0, worth: 1 });
    expect((await center.markRead([worth!])).counts).toMatchObject({ action: 0, worth: 0 });
  });

  it('leaves an old unread routine record out of the count', () => {
    center.add({ kind: 'run', level: 'routine', message: 'written before there were levels' }).read = false;
    expect(center.counts()).toMatchObject({ action: 0, worth: 0 });
  });

  it('pages one section, one node, and says how many each section holds', async () => {
    center.record(fromNode('studio', 'run:finished', failed));
    center.record(fromNode('air', 'run:finished', failed));
    center.record(fromNode('air', 'run:retrospective', job));
    center.record(fromNode('air', 'run:finished', { ...job, status: 'succeeded', seconds: 1 }));
    const page = await center.page({ level: 'action', node: 'air' });
    expect(page.items.map((record) => [record.nodeId, record.level])).toEqual([['air', 'action']]);
    expect(page.levels).toEqual({ action: 1, worth: 1, routine: 1 });
  });
});

const disk = (summary: string, extra: Record<string, unknown> = {}) =>
  ({ metric: 'disk', label: 'Low disk space', summary, value: 90, ...extra });

describe('collapsing repeats', () => {
  it('keys each group by what repeats', () => {
    center.record(fromNode('studio', 'system:alert', disk('10% free')));
    center.record(event('update:launched', { from: 'abc1234', target: 'def5678' }));
    center.record(fromNode('studio', 'run:delayed', held));
    expect(center.items.map((record) => record.groupKey)).toEqual(['hold:c1', 'update:def5678', 'system:disk:studio']);
  });

  it('lands a repeat on the open row: latest wording, one more, moved to now, read kept', async () => {
    center.record(fromNode('studio', 'system:alert', disk('10.5% free')));
    const first = center.items[0]!;
    const firstAt = first.at;
    await center.markRead([first.id]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    center.record(fromNode('studio', 'run:finished', failed));
    center.record(fromNode('studio', 'system:alert', disk('9.8% free')));
    expect(center.items).toHaveLength(2);
    expect(center.items[0]).toMatchObject({ id: first.id, count: 2, read: true, since: firstAt });
    expect(center.items[0]!.message).toContain('9.8% free');
    expect(center.items[0]!.at > firstAt).toBe(true);
  });

  it('keeps each machine to its own row', () => {
    center.record(fromNode('studio', 'system:alert', disk('10% free')));
    center.record(fromNode('air', 'system:alert', disk('12% free')));
    expect(center.items.map((record) => [record.nodeId, record.count])).toEqual([
      ['air', 1],
      ['studio', 1],
    ]);
  });

  it('starts a new, unread row for an episode after a clear', async () => {
    center.record(fromNode('studio', 'system:alert', disk('10% free')));
    await center.markRead([center.items[0]!.id]);
    center.record(fromNode('studio', 'system:cleared', { metric: 'disk' }));
    center.record(fromNode('studio', 'system:alert', disk('11% free')));
    expect(center.items.map((record) => [record.count, record.read, record.open])).toEqual([
      [1, false, true],
      [1, true, false],
    ]);
  });

  it('makes a row unread again when it gets worse', async () => {
    center.record(fromNode('studio', 'system:alert', disk('10% free')));
    await center.markRead([center.items[0]!.id]);
    center.record(fromNode('studio', 'system:alert', disk('5% free', { worse: true })));
    expect(center.items).toHaveLength(1);
    expect(center.items[0]).toMatchObject({ count: 2, read: false });
  });

  it('keeps an update to one row, unread again and closed when it fails', async () => {
    center.record(event('update:launched', { from: 'abc1234', target: 'def5678' }));
    await center.markRead([center.items[0]!.id]);
    center.record(event('update:failed', { code: 1, target: 'def5678' }));
    expect(center.items).toHaveLength(1);
    expect(center.items[0]).toMatchObject({ level: 'action', count: 2, read: false, open: false });
    center.record(event('update:launched', { from: 'abc1234', target: 'def5678' }));
    expect(center.items.map((record) => record.count)).toEqual([1, 2]);
  });

  it('turns a hold that passed its expected start into one that needs action', async () => {
    center.record(fromNode('studio', 'run:delayed', held));
    await center.markRead([center.items[0]!.id]);
    center.record(fromNode('studio', 'run:delayed', { ...held, late: true }));
    expect(center.items).toHaveLength(1);
    expect(center.items[0]).toMatchObject({ level: 'action', count: 2, read: false });
    expect(center.items[0]!.message).toContain('past the time it was expected to start');
  });

  it('closes a hold when it is released, and gives the release a routine row of its own', () => {
    center.record(fromNode('studio', 'run:delayed', held));
    center.record(fromNode('studio', 'run:released', { ...held, ran: true }));
    center.record(fromNode('studio', 'run:delayed', held));
    expect(center.items.map((record) => [record.level, record.groupKey, record.open])).toEqual([
      ['worth', 'hold:c1', true],
      ['routine', null, false],
      ['worth', 'hold:c1', false],
    ]);
  });

  it('keeps the group, the count and the open state through a restart', async () => {
    center.record(fromNode('studio', 'system:alert', disk('10% free')));
    center.record(fromNode('studio', 'system:alert', disk('9% free')));
    await center.items[0]!.writing;
    const reloaded = new notifications.NotificationCenter();
    await reloaded.load();
    expect(reloaded.items[0]).toMatchObject({ groupKey: 'system:disk:studio', count: 2, open: true });
    reloaded.record(fromNode('studio', 'system:alert', disk('8% free')));
    expect(reloaded.items).toHaveLength(1);
    expect(reloaded.items[0]!.count).toBe(3);
  });
});

describe('an alert found still firing after a restart', () => {
  it('adds nothing while the row for its episode is open', async () => {
    center.record(fromNode('studio', 'system:alert', disk('10% free')));
    await center.markRead([center.items[0]!.id]);
    center.record(fromNode('studio', 'system:alert', disk('10% free', { seeded: true })));
    expect(center.items).toHaveLength(1);
    expect(center.items[0]).toMatchObject({ count: 1, read: true, open: true });
  });

  it('is a row of its own when nothing is open for it', () => {
    center.record(fromNode('studio', 'system:alert', disk('10% free', { seeded: true })));
    expect(center.items[0]).toMatchObject({ groupKey: 'system:disk:studio', read: false, open: true });
  });

  it('is a new row after the last episode cleared', async () => {
    center.record(fromNode('studio', 'system:alert', disk('10% free')));
    center.record(fromNode('studio', 'system:cleared', { metric: 'disk' }));
    center.record(fromNode('studio', 'system:alert', disk('10% free', { seeded: true })));
    expect(center.items.map((record) => record.open)).toEqual([true, false]);
  });
});

describe('reading a row that has changed since it was seen', () => {
  it('leaves a worse repeat unread when the acknowledgement was for the version before it', async () => {
    center.record(fromNode('studio', 'system:alert', disk('10% free')));
    const { id } = center.items[0]!;
    center.record(fromNode('studio', 'system:alert', disk('5% free', { worse: true })));
    expect((await center.markRead([id], { [id]: 1 })).marked).toBe(0);
    expect(center.items[0]).toMatchObject({ count: 2, read: false });
    expect((await center.markRead([id], { [id]: 2 })).marked).toBe(1);
    expect(center.items[0]!.read).toBe(true);
  });

  it('leaves a failed update unread when only its launch was seen', async () => {
    center.record(event('update:launched', { from: 'abc1234', target: 'def5678' }));
    const { id } = center.items[0]!;
    center.record(event('update:failed', { code: 1, target: 'def5678' }));
    await center.markRead([id], { [id]: 1 });
    expect(center.items[0]).toMatchObject({ level: 'action', read: false });
  });
});

describe('an alert found worse after a restart', () => {
  const seededDisk = (value: number) => disk(`${100 - value}% free`, { value, seeded: true });

  it('lands on the open row and makes it unread when the reading is worse than the row last said', async () => {
    center.record(fromNode('studio', 'system:alert', disk('20% free', { value: 80 })));
    await center.markRead([center.items[0]!.id]);
    center.record(fromNode('studio', 'system:alert', seededDisk(95)));
    expect(center.items).toHaveLength(1);
    expect(center.items[0]).toMatchObject({ count: 2, read: false, alertValue: 95 });
    expect(center.items[0]!.message).toContain('5% free');
  });

  it('stays quiet when the reading is no worse than that', async () => {
    center.record(fromNode('studio', 'system:alert', disk('20% free', { value: 80 })));
    await center.markRead([center.items[0]!.id]);
    center.record(fromNode('studio', 'system:alert', seededDisk(85)));
    expect(center.items[0]).toMatchObject({ count: 1, read: true, alertValue: 80 });
  });

  it('judges a busy CPU worse once crons are running on it', async () => {
    const cpu = { metric: 'cpu', label: 'High CPU', summary: '91% of all cores', value: 91 };
    center.record(fromNode('mini', 'system:alert', { ...cpu, running: [] }));
    await center.markRead([center.items[0]!.id]);
    center.record(fromNode('mini', 'system:alert', { ...cpu, seeded: true, running: [{ name: 'Nightly', kind: 'cron', startedAt: new Date().toISOString() }] }));
    expect(center.items[0]).toMatchObject({ count: 2, read: false, alertRunning: 1 });
  });

  it('remembers what the row last said through a restart of the hub', async () => {
    center.record(fromNode('studio', 'system:alert', disk('20% free', { value: 80 })));
    await center.markRead([center.items[0]!.id]);
    await center.items[0]!.writing;
    const reloaded = new notifications.NotificationCenter();
    await reloaded.load();
    reloaded.record(fromNode('studio', 'system:alert', seededDisk(95)));
    expect(reloaded.items[0]).toMatchObject({ count: 2, read: false });
  });

  it('never calls a row worse when it kept no reading', async () => {
    center.record(fromNode('studio', 'system:alert', disk('20% free', { value: undefined })));
    await center.markRead([center.items[0]!.id]);
    center.record(fromNode('studio', 'system:alert', seededDisk(99)));
    expect(center.items[0]).toMatchObject({ count: 1, read: true });
  });
});
