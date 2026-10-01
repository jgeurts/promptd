import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type * as DbModule from '../src/db.js';
import type * as HubModule from '../src/hub.js';
import type * as NodeBuildModule from '../src/nodeBuild.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-nodebuild-'));
process.env.PROMPTD_HOME = home;
delete process.env.PROMPTD_NODE_TOKEN;

const SCRIPTS_DIR = path.join(import.meta.dirname, '..', 'scripts');
const scripts = {
  install: fs.readFileSync(path.join(SCRIPTS_DIR, 'install.sh'), 'utf8'),
  register: fs.readFileSync(path.join(SCRIPTS_DIR, 'register-app-mac-os.sh'), 'utf8'),
};
const binary = randomBytes(300_000);
const binarySha = createHash('sha256').update(binary).digest('hex');

let dbModule: typeof DbModule;
let hub: (typeof HubModule)['hub'];
let nodeBuild: typeof NodeBuildModule;
let server: Server;
let base: string;
let token: string;

beforeAll(async () => {
  dbModule = await import('../src/db.js');
  dbModule.openDatabase(`sqlite:${path.join(home, 'hub.sqlite')}`);
  await dbModule.migrate();
  ({ hub } = await import('../src/hub.js'));
  const { loadSettings } = await import('../src/settings.js');
  await hub.start(await loadSettings());
  token = fs.readFileSync(path.join(home, 'node-token'), 'utf8').trim();
  nodeBuild = await import('../src/nodeBuild.js');

  const file = path.join(home, 'promptd-build');
  fs.writeFileSync(file, binary);
  const build = nodeBuild.buildFromFile(file, 'abc1234', scripts);
  const app = express();
  app.get('/install.sh', nodeBuild.serveInstaller(build, async () => 'http://hub.example:4321'));
  app.use('/api/node', hub.router(build));
  // A hub with nothing to serve, as a checkout or a hub on Linux is.
  app.get('/none/install.sh', nodeBuild.serveInstaller(null, async () => 'http://hub.example:4321'));
  app.use('/none/api/node', hub.router(null));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await dbModule.closeDatabase();
});

function withToken(value = token): RequestInit {
  return { headers: { authorization: `Bearer ${value}` } };
}

describe('GET /api/node/build', () => {
  it('sends the build to a node with the token, named and summed in its headers', async () => {
    const res = await fetch(`${base}/api/node/build`, withToken());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-promptd-version')).toBe('abc1234');
    expect(res.headers.get('x-promptd-sha256')).toBe(binarySha);
    expect(res.headers.get('content-length')).toBe(String(binary.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(binary)).toBe(true);
  });

  it('takes a join code without using it up, so the node can still pair with it', async () => {
    const { code } = hub.createJoinCode();
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${base}/api/node/build?code=${code}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-promptd-sha256')).toBe(binarySha);
      expect(Buffer.from(await res.arrayBuffer()).equals(binary)).toBe(true);
    }
    const paired = await fetch(`${base}/api/node/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(await paired.json()).toEqual({ token });
    expect((await fetch(`${base}/api/node/build?code=${code}`)).status).toBe(401);
  });

  it('refuses a request with neither a good code nor the token', async () => {
    const { code } = hub.createJoinCode();
    const wrong = code === '0000-0000' ? '0000-0001' : '0000-0000';
    expect((await fetch(`${base}/api/node/build`)).status).toBe(401);
    expect((await fetch(`${base}/api/node/build?code=${wrong}`)).status).toBe(401);
    expect((await fetch(`${base}/api/node/build`, withToken('not-the-token'))).status).toBe(401);
  });

  it('answers 404 from a hub that has no build to serve', async () => {
    const res = await fetch(`${base}/none/api/node/build`, withToken());
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('this hub cannot serve a node build');
    expect(res.headers.get('x-promptd-version')).toBeNull();
  });
});

describe('GET /install.sh', () => {
  it('serves the installer pointed at the hub, with the build in its headers', async () => {
    const res = await fetch(`${base}/install.sh`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-promptd-version')).toBe('abc1234');
    expect(res.headers.get('x-promptd-sha256')).toBe(binarySha);
    const script = await res.text();
    expect(script).toContain('\nFROM_HUB=http://hub.example:4321\n');
    expect(script).not.toContain("\nREGISTER_SCRIPT=''\n");
  });

  it('answers 404 from a hub that has no build to serve', async () => {
    const res = await fetch(`${base}/none/install.sh`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('this hub cannot serve a node build');
  });
});

describe('installerScript', () => {
  it('carries the register script exactly, quotes and all', () => {
    const probe = `FROM_HUB=''\nREGISTER_SCRIPT=''\nprintf '%s|%s' "$FROM_HUB" "$REGISTER_SCRIPT"\n`;
    const script = nodeBuild.installerScript({ install: probe, register: scripts.register }, "http://it's here");
    expect(execFileSync('bash', ['-c', script], { encoding: 'utf8' })).toBe(`http://it's here|${scripts.register}`);
  });

  it('fills in the real installer, which bash still parses', () => {
    const script = nodeBuild.installerScript(scripts, 'http://hub.example:4321');
    expect(() => execFileSync('bash', ['-n'], { input: script })).not.toThrow();
  });

  it('refuses an installer with nothing to fill in', () => {
    expect(() => nodeBuild.installerScript({ install: '#!/bin/bash\n', register: '' }, 'http://hub.example:4321')).toThrow('FROM_HUB');
  });
});

describe('buildFromFile', () => {
  it('keeps serving the build it opened after a newer one is renamed over the file', async () => {
    const file = path.join(home, 'promptd-renamed');
    fs.writeFileSync(file, binary);
    const build = nodeBuild.buildFromFile(file, 'abc1234', scripts);
    fs.writeFileSync(`${file}.new`, randomBytes(1000));
    fs.renameSync(`${file}.new`, file);
    const chunks: Buffer[] = [];
    for await (const chunk of build.stream()) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(binary)).toBe(true);
    expect(await build.sha256()).toBe(binarySha);
  });
});
