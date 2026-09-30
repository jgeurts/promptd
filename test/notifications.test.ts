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
