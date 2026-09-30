import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type * as DbModule from '../src/db.js';
import type * as HubModule from '../src/hub.js';
import type * as JobDefaultsModule from '../src/jobDefaults.js';
import type * as SettingsModule from '../src/settings.js';
import type * as StoreModule from '../src/store.js';
import type { NodeWork } from '../src/types.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-hub-work-'));
process.env.PROMPTD_HOME = home;
process.env.PROMPTD_NODE_TOKEN = 'test-token';

let dbModule: typeof DbModule;
let hub: (typeof HubModule)['hub'];
let settings: typeof SettingsModule;
let store: typeof StoreModule;
let jobDefaults: typeof JobDefaultsModule;
let server: Server;
let base: string;

const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json', 'x-promptd-node': 'mini', 'x-promptd-instance': 'one' };

beforeAll(async () => {
  dbModule = await import('../src/db.js');
  dbModule.openDatabase(`sqlite:${path.join(home, 'hub.sqlite')}`);
  await dbModule.migrate();
  settings = await import('../src/settings.js');
  store = await import('../src/store.js');
  jobDefaults = await import('../src/jobDefaults.js');
  ({ hub } = await import('../src/hub.js'));
  await hub.start(await settings.loadSettings());
  const app = express();
  app.use('/api/node', hub.router());
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/node`;
  // The node reports once, as it does before it asks for work.
  const report = await fetch(`${base}/report`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ node: { id: 'mini', name: 'mini', instance: 'one', processors: 4 }, status: { counts: {} } }),
  });
  expect(report.status).toBe(200);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await dbModule.closeDatabase();
});

async function work(): Promise<NodeWork> {
  const answer = await fetch(`${base}/work`, { headers });
  expect(answer.status).toBe(200);
  return (await answer.json()) as NodeWork;
}

async function setClusterDefaults(patch: Record<string, unknown>): Promise<void> {
  const current = await settings.loadSettings();
  hub.setSettings(await settings.patchSettings({ jobDefaults: jobDefaults.patchJobDefaults(current.jobDefaults, patch) }));
}

describe('the work a node is sent', () => {
  it('carries each job with what it leaves to the defaults filled in from that node\'s, and keeps the nulls stored', async () => {
    const cron = await store.createCron({
      name: 'Follows',
      description: '',
      cron: '0 9 * * *',
      timezone: '',
      workingDirectory: '~/',
      useWorktree: null,
      cleanupWorktree: null,
      retrospective: null,
      model: null,
      effort: 'low',
      usageDelay: { session: null, weekly: null, fable: null, credits: false },
      prompt: 'Tidy up.',
      isActive: true,
      nodeId: '',
      projectId: null,
    });
    hub.jobsChanged();
    await setClusterDefaults({ model: 'opus' });
    await hub.setNodeConfig('mini', { jobDefaults: { usageDelay: { weekly: true } } });

    const sent = (await work()).crons.find((job) => job.id === cron.id);
    // What an older node, which knows nothing of defaults, would run as it stands.
    expect(sent).toMatchObject({
      useWorktree: true,
      cleanupWorktree: true,
      retrospective: false,
      model: 'opus',
      effort: 'low',
      usageDelay: { session: true, weekly: true, fable: false, credits: false },
    });
    expect(await store.getCron(cron.id)).toMatchObject({ useWorktree: null, model: null, usageDelay: { session: null, weekly: null } });
  });

  it('follows a changed default on the next fetch, and keeps a job\'s own settings', async () => {
    await setClusterDefaults({ model: 'sonnet', useWorktree: false });
    const [sent] = (await work()).crons;
    expect(sent).toMatchObject({ model: 'sonnet', useWorktree: false, effort: 'low', usageDelay: { credits: false } });
  });

  it('sends no defaults of its own, so a node needs none to run its jobs', async () => {
    expect(Object.keys((await work()).settings).sort()).toEqual(['defaultWorktreeInclude', 'maxConcurrentJobs', 'retrospectivePrompt', 'usageDelayThresholds']);
  });
});
