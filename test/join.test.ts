import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type * as JoinModule from '../src/join.js';

process.env.PROMPTD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-join-'));

let join: typeof JoinModule;

beforeAll(async () => {
  join = await import('../src/join.js');
});

// A port no real `tailscale serve` on the test machine is forwarding to.
const PORT = 49321;

describe('serveUrl', () => {
  it('reads the address tailscale serve shares the hub on over HTTP', () => {
    const config = {
      TCP: { '4321': { HTTP: true } },
      Web: { 'laptop.tail1234.ts.net:4321': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4321' } } } },
    };
    expect(join.serveUrl(config, 4321)).toBe('http://laptop.tail1234.ts.net:4321');
  });

  it('drops the port for HTTPS on 443', () => {
    const config = {
      TCP: { '443': { HTTPS: true } },
      Web: { 'laptop.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://localhost:4321' } } } },
    };
    expect(join.serveUrl(config, 4321)).toBe('https://laptop.tail1234.ts.net');
  });

  it('ignores what is served for another port or another machine', () => {
    const config = {
      TCP: { '443': { HTTPS: true }, '8080': { HTTP: true } },
      Web: {
        'laptop.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
        'laptop.tail1234.ts.net:8080': { Handlers: { '/': { Proxy: 'http://10.0.0.5:4321' } } },
      },
    };
    expect(join.serveUrl(config, 4321)).toBeNull();
  });

  it('answers null when nothing is served', () => {
    expect(join.serveUrl({}, 4321)).toBeNull();
  });
});

describe('joinUrl', () => {
  it('uses the address the browser reached the hub on', async () => {
    expect(await join.joinUrl({ host: '127.0.0.1', port: PORT, origin: `http://roundhead.local:${PORT}` })).toBe(
      `http://roundhead.local:${PORT}`,
    );
  });

  it('answers null for a hub only this machine can reach', async () => {
    expect(await join.joinUrl({ host: '127.0.0.1', port: PORT, origin: `http://127.0.0.1:${PORT}` })).toBeNull();
  });
});

describe('joinCommand', () => {
  it('uses the release installer for a hub that is a binary', () => {
    expect(join.joinCommand('http://laptop.tail1234.ts.net:4321', '1234-5678', 'promptilicious/promptd')).toBe(
      'curl -fsSL https://github.com/promptilicious/promptd/releases/latest/download/install.sh | bash -s -- --hub http://laptop.tail1234.ts.net:4321 --code 1234-5678',
    );
  });

  it('uses the register script for a hub run from a checkout', () => {
    expect(join.joinCommand('http://laptop.tail1234.ts.net:4321', '1234-5678', null)).toBe(
      'NODE_ONLY=1 HUB_URL=http://laptop.tail1234.ts.net:4321 JOIN_CODE=1234-5678 ./scripts/register-app-mac-os.sh',
    );
  });

  it('quotes a value the shell would split', () => {
    expect(join.joinCommand("http://it's here", '1234-5678', null)).toBe(
      `NODE_ONLY=1 HUB_URL='http://it'\\''s here' JOIN_CODE=1234-5678 ./scripts/register-app-mac-os.sh`,
    );
  });
});
