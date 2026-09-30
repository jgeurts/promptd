import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { TITLE_INSTRUCTION } from '../src/naming.js';
import { suggestTitle } from '../src/title.js';

/**
 * A stand-in for the claude CLI: records its arguments and the folder it ran
 * in next to itself, then answers FAKE_TITLE, or hangs when FAKE_HANG is set.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'call.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
if (process.env.FAKE_HANG) setTimeout(() => {}, 60000);
else process.stdout.write(process.env.FAKE_TITLE ?? '');
`;

let bin: string;
let claude: string;

beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-title-bin-'));
  claude = path.join(bin, 'claude');
  fs.writeFileSync(claude, FAKE_CLAUDE, { mode: 0o755 });
});

function lastCall(): { args: string[]; cwd: string } {
  return JSON.parse(fs.readFileSync(path.join(bin, 'call.json'), 'utf8')) as { args: string[]; cwd: string };
}

describe('suggestTitle', () => {
  it('asks haiku, in a folder of its own that is removed afterwards', async () => {
    process.env.FAKE_TITLE = '"Rotate staging keys"\n';
    delete process.env.FAKE_HANG;
    expect(await suggestTitle('Rotate the staging keys, then tell me.', { bin: claude })).toBe('Rotate staging keys');
    const { args, cwd } = lastCall();
    expect(args).toEqual(['-p', `${TITLE_INSTRUCTION}\n\nRotate the staging keys, then tell me.`, '--model', 'haiku']);
    expect(path.basename(cwd)).toMatch(/^promptd-title-/);
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it('refuses an answer that is not a title', async () => {
    process.env.FAKE_TITLE = '';
    await expect(suggestTitle('x', { bin: claude })).rejects.toThrow('the answer was empty');
    process.env.FAKE_TITLE = 'a'.repeat(61);
    await expect(suggestTitle('x', { bin: claude })).rejects.toThrow('not a title');
  });

  it('gives up when claude does not answer in time', async () => {
    process.env.FAKE_HANG = '1';
    await expect(suggestTitle('x', { bin: claude, timeoutMs: 300 })).rejects.toThrow('did not answer');
    delete process.env.FAKE_HANG;
  });
});
