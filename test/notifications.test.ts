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
