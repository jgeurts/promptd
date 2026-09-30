import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { browseDirectories } from '../src/browse.js';

let base: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-browse-'));
  fs.mkdirSync(path.join(base, 'app', 'src'), { recursive: true });
  execFileSync('git', ['-C', path.join(base, 'app'), 'init', '-q']);
  fs.mkdirSync(path.join(base, 'notes'));
});

describe('browseDirectories', () => {
  it('says whether the folder is inside a git repository', async () => {
    expect((await browseDirectories(path.join(base, 'app'))).inGitRepository).toBe(true);
    expect((await browseDirectories(`${path.join(base, 'app', 'src')}/`)).inGitRepository).toBe(true);
    expect((await browseDirectories(path.join(base, 'notes'))).inGitRepository).toBe(false);
  });

  it('reports no repository for a folder that does not exist', async () => {
    const result = await browseDirectories(path.join(base, 'missing'));
    expect(result).toMatchObject({ exists: false, inGitRepository: false });
  });
});
