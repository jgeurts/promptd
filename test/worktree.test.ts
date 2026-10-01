import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { copyWorktreeIncludes, isStuck, prepareWorktree, removeWorktree, worktreeBranch, worktreePath, writeWorktreeInclude } from '../src/worktree.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function branchExists(repo: string, branch: string): boolean {
  return Boolean(git(repo, 'branch', '--list', branch));
}

/** What `claude --worktree <name>` leaves behind: a locked worktree under the main repository. */
function claudeWorktree(mainRepo: string, name: string): string {
  const worktree = path.join(mainRepo, '.claude', 'worktrees', name);
  git(mainRepo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, worktree);
  git(mainRepo, 'worktree', 'lock', '--reason', `claude session ${name} (pid 1)`, worktree);
  return worktree;
}

let mainRepo: string;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-worktree-'));
  mainRepo = path.join(base, 'platform');
  fs.mkdirSync(mainRepo);
  git(mainRepo, 'init', '-q', '-b', 'main');
  git(mainRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
});

describe('removeWorktree', () => {
  it('removes the worktree and its branch for a job in the main checkout', async () => {
    const worktree = claudeWorktree(mainRepo, 'job-1');
    const result = await removeWorktree(mainRepo, 'job-1');
    expect(result).toHaveProperty('cleaned');
    expect(fs.existsSync(worktree)).toBe(false);
    expect(branchExists(mainRepo, 'worktree-job-1')).toBe(false);
  });

  it('finds the worktree under the main repository for a job in a linked worktree', async () => {
    const linked = path.join(path.dirname(mainRepo), 'platform-ci-patrol');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'ci-patrol', linked);
    const worktree = claudeWorktree(mainRepo, 'job-2');

    const result = await removeWorktree(linked, 'job-2');
    expect(result).toHaveProperty('cleaned');
    expect(fs.existsSync(worktree)).toBe(false);
    expect(branchExists(mainRepo, 'worktree-job-2')).toBe(false);
    expect(fs.existsSync(linked)).toBe(true);
  });

  it('works from a subfolder of the checkout', async () => {
    const sub = path.join(mainRepo, 'apps', 'web');
    fs.mkdirSync(sub, { recursive: true });
    const worktree = claudeWorktree(mainRepo, 'job-3');
    await removeWorktree(sub, 'job-3');
    expect(fs.existsSync(worktree)).toBe(false);
  });

  it('says there was nothing to remove when the job never made a worktree', async () => {
    expect(await removeWorktree(mainRepo, 'never-ran')).toEqual({ skipped: expect.stringContaining('no worktree named never-ran') });
  });

  it('leaves a worktree belonging to another job alone', async () => {
    const other = claudeWorktree(mainRepo, 'other-job');
    await removeWorktree(mainRepo, 'job-4');
    expect(fs.existsSync(other)).toBe(true);
    expect(branchExists(mainRepo, 'worktree-other-job')).toBe(true);
  });
});

describe('writeWorktreeInclude', () => {
  it('writes to the main checkout for a job in a linked worktree, where Claude Code reads it', async () => {
    const linked = path.join(path.dirname(mainRepo), 'platform-ci-patrol');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'ci-patrol', linked);
    const result = await writeWorktreeInclude(linked, '.env');
    expect(result).toMatchObject({ written: path.join(fs.realpathSync(mainRepo), '.worktreeinclude') });
    expect(fs.readFileSync(path.join(mainRepo, '.worktreeinclude'), 'utf8')).toBe('.env\n');
    expect(fs.existsSync(path.join(linked, '.worktreeinclude'))).toBe(false);
  });

  it('writes to the checkout root for a job in a subfolder', async () => {
    const sub = path.join(mainRepo, 'apps', 'web');
    fs.mkdirSync(sub, { recursive: true });
    await writeWorktreeInclude(sub, '.env.local');
    expect(fs.readFileSync(path.join(mainRepo, '.worktreeinclude'), 'utf8')).toBe('.env.local\n');
  });
});

function commit(dir: string, message: string): string {
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * A bare origin, a checkout cloned from it, and a second clone that has since
 * pushed one more commit, so the checkout's origin/main is a commit behind.
 */
function behindOrigin(): { app: string; pusher: string; newest: string; cached: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-origin-'));
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const pusher = path.join(base, 'pusher');
  execFileSync('git', ['clone', '-q', origin, pusher], { stdio: 'ignore' });
  const cached = commit(pusher, 'one');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const app = path.join(base, 'app');
  execFileSync('git', ['clone', '-q', origin, app]);
  const newest = commit(pusher, 'two');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  return { app, pusher, newest, cached };
}

describe('prepareWorktree', () => {
  it('makes the tree claude --worktree would, at the newest commit on origin', async () => {
    const { app, newest, cached } = behindOrigin();
    expect(git(app, 'rev-parse', 'origin/main')).toBe(cached);

    const tree = await prepareWorktree(app, 'job-1');
    expect(tree).toMatchObject({ path: worktreePath(fs.realpathSync(app), 'job-1'), branch: 'worktree-job-1', created: true });
    expect(tree.path).toBe(path.join(fs.realpathSync(app), '.claude', 'worktrees', 'job-1'));
    expect(git(tree.path, 'rev-parse', 'HEAD')).toBe(newest);
    expect(git(tree.path, 'symbolic-ref', '--short', 'HEAD')).toBe(worktreeBranch('job-1'));
    expect(tree.notes.join('\n')).toContain('fetched origin main');
  });

  it('notes a fetch that fails and starts from origin/main as last fetched', async () => {
    const { app, cached } = behindOrigin();
    git(app, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'no-such-origin.git'));
    const tree = await prepareWorktree(app, 'job-2');
    expect(git(tree.path, 'rev-parse', 'HEAD')).toBe(cached);
    expect(tree.notes.join('\n')).toContain('could not fetch origin main');
  });

  it('starts from the checkout\'s own HEAD when there is no origin', async () => {
    const head = commit(mainRepo, 'local');
    const tree = await prepareWorktree(mainRepo, 'job-3');
    expect(git(tree.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(tree.notes.join('\n')).toContain('no origin/HEAD');
  });

  it('puts the tree under the main checkout for a job in a linked worktree, as claude does', async () => {
    const linked = path.join(path.dirname(mainRepo), 'platform-linked');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'linked', linked);
    const sub = path.join(linked, 'apps');
    fs.mkdirSync(sub);
    const tree = await prepareWorktree(sub, 'job-4');
    expect(tree.path).toBe(path.join(fs.realpathSync(mainRepo), '.claude', 'worktrees', 'job-4'));
    expect(tree.root).toBe(fs.realpathSync(mainRepo));
  });

  it('reuses a tree as the last run left it, and moves one with no work of its own up to origin', async () => {
    const { app, pusher, newest } = behindOrigin();
    const first = await prepareWorktree(app, 'job-5');
    fs.writeFileSync(path.join(first.path, 'scratch.txt'), 'left behind');

    // Untracked work: reused as it is, not moved.
    const third = commit(pusher, 'three');
    git(pusher, 'push', '-q', 'origin', 'HEAD:main');
    const dirty = await prepareWorktree(app, 'job-5');
    expect(dirty).toMatchObject({ path: first.path, created: false });
    expect(git(dirty.path, 'rev-parse', 'HEAD')).toBe(newest);
    expect(fs.readFileSync(path.join(dirty.path, 'scratch.txt'), 'utf8')).toBe('left behind');

    // Clean, with nothing of its own: moved to the newest commit on origin.
    fs.rmSync(path.join(first.path, 'scratch.txt'));
    const clean = await prepareWorktree(app, 'job-5');
    expect(git(clean.path, 'rev-parse', 'HEAD')).toBe(third);
    expect(clean.notes.join('\n')).toContain('moved it to origin/main');

    // A commit of its own: kept where it is.
    const own = commit(clean.path, 'mine');
    commit(pusher, 'four');
    git(pusher, 'push', '-q', 'origin', 'HEAD:main');
    expect(git((await prepareWorktree(app, 'job-5')).path, 'rev-parse', 'HEAD')).toBe(own);
  });

  it('keeps a reused tree where it is rather than replace a file it holds that the base has started tracking', async () => {
    const { app, pusher, newest } = behindOrigin();
    fs.writeFileSync(path.join(app, '.git', 'info', 'exclude'), '.env\n');
    const first = await prepareWorktree(app, 'job-16');
    fs.writeFileSync(path.join(first.path, '.env'), 'EDITED=1\n');
    fs.writeFileSync(path.join(pusher, '.env'), 'TRACKED=1\n');
    git(pusher, 'add', '.env');
    commit(pusher, 'track .env');
    git(pusher, 'push', '-q', 'origin', 'HEAD:main');

    const again = await prepareWorktree(app, 'job-16');
    expect(git(again.path, 'rev-parse', 'HEAD')).toBe(newest);
    expect(fs.readFileSync(path.join(again.path, '.env'), 'utf8')).toBe('EDITED=1\n');
    expect(again.notes.join('\n')).toContain('git did not move it to origin/main');
  });

  it('is cleaned up by removeWorktree like one claude made', async () => {
    const tree = await prepareWorktree(mainRepo, 'job-6');
    expect(await removeWorktree(mainRepo, 'job-6')).toHaveProperty('cleaned');
    expect(fs.existsSync(tree.path)).toBe(false);
    expect(branchExists(mainRepo, 'worktree-job-6')).toBe(false);
  });

  it('refuses a folder in its place that is not a worktree, and a symlink on the way to it', async () => {
    const stray = worktreePath(mainRepo, 'job-7');
    fs.mkdirSync(stray, { recursive: true });
    await expect(prepareWorktree(mainRepo, 'job-7')).rejects.toThrow('is not a worktree of');

    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-elsewhere-'));
    fs.rmSync(path.join(mainRepo, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(mainRepo, '.claude'));
    fs.symlinkSync(elsewhere, path.join(mainRepo, '.claude', 'worktrees'));
    await expect(prepareWorktree(mainRepo, 'job-8')).rejects.toThrow('is a symlink');
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('keeps the commits on a branch whose folder was deleted, checking it out again rather than resetting it', async () => {
    const { app } = behindOrigin();
    const first = await prepareWorktree(app, 'job-12');
    const own = commit(first.path, 'work kept only on the branch');
    fs.rmSync(first.path, { recursive: true, force: true });

    const again = await prepareWorktree(app, 'job-12');
    expect(again).toMatchObject({ path: first.path, created: true });
    expect(git(again.path, 'rev-parse', 'HEAD')).toBe(own);
    expect(again.notes.join('\n')).toContain('again from the existing worktree-job-12');
  });

  it('removes a tree whose checkout did not finish, and the branch made for it, so the next run does not reuse it', async () => {
    const hook = path.join(mainRepo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await expect(prepareWorktree(mainRepo, 'job-14')).rejects.toThrow();
    expect(fs.existsSync(worktreePath(mainRepo, 'job-14'))).toBe(false);
    expect(branchExists(mainRepo, 'worktree-job-14')).toBe(false);
    expect(git(mainRepo, 'worktree', 'list')).not.toContain('job-14');
  });

  it('fails rather than going on when a fetch leaves processes it cannot end', async () => {
    const { app } = behindOrigin();
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (pid < 0 && signal === 0) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return realKill(pid, signal);
    });
    try {
      const failure = await prepareWorktree(app, 'job-15', { signal: new AbortController().signal }).then(() => null, (err: unknown) => err);
      expect(isStuck(failure)).toBe(true);
      expect(fs.existsSync(worktreePath(fs.realpathSync(app), 'job-15'))).toBe(false);
    } finally {
      kill.mockRestore();
    }
  }, 30_000);

  it('stops when asked, before making anything', async () => {
    const { app } = behindOrigin();
    const controller = new AbortController();
    controller.abort();
    await expect(prepareWorktree(app, 'job-9', { signal: controller.signal })).rejects.toThrow();
    expect(fs.existsSync(worktreePath(app, 'job-9'))).toBe(false);
  });
});

describe('copyWorktreeIncludes', () => {
  it('copies the ignored files .worktreeinclude names, and nothing tracked, unlisted or linked', async () => {
    fs.writeFileSync(path.join(mainRepo, '.gitignore'), 'node_modules/\n.env*\nsecret.txt\n');
    fs.writeFileSync(path.join(mainRepo, 'tracked.env.example'), 'tracked\n');
    git(mainRepo, 'add', '.gitignore', 'tracked.env.example');
    commit(mainRepo, 'ignore');
    fs.writeFileSync(path.join(mainRepo, '.env'), 'A=1\n');
    fs.writeFileSync(path.join(mainRepo, 'secret.txt'), 'not listed\n');
    fs.writeFileSync(path.join(mainRepo, 'untracked.txt'), 'listed but not ignored\n');
    fs.mkdirSync(path.join(mainRepo, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(mainRepo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    fs.symlinkSync('.env', path.join(mainRepo, '.env.link'));
    fs.writeFileSync(path.join(mainRepo, '.worktreeinclude'), '# copied into new worktrees\n.env*\nnode_modules/\nuntracked.txt\ntracked.env.example\n');

    const tree = await prepareWorktree(mainRepo, 'job-10');
    const copy = await copyWorktreeIncludes(tree.root, tree.path);
    expect(copy.copied.sort()).toEqual(['.env', 'node_modules/pkg/index.js']);
    expect(copy.skipped).toEqual(['.env.link']);
    expect(fs.readFileSync(path.join(tree.path, '.env'), 'utf8')).toBe('A=1\n');
    expect(fs.existsSync(path.join(tree.path, 'secret.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tree.path, 'untracked.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(tree.path, 'tracked.env.example'), 'utf8')).toBe('tracked\n');
  });

  it('leaves alone what the tree already has: a file the base tracks, and a committed symlink a copy would write through', async () => {
    const { app, pusher } = behindOrigin();
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-outside-')), 'target');
    fs.writeFileSync(outside, 'untouched\n');
    // origin has since started tracking .env, and committed a symlink where a local file is listed.
    fs.writeFileSync(path.join(pusher, '.env'), 'TRACKED=1\n');
    fs.symlinkSync(outside, path.join(pusher, 'local.json'));
    git(pusher, 'add', '.env', 'local.json');
    commit(pusher, 'track .env and link local.json');
    git(pusher, 'push', '-q', 'origin', 'HEAD:main');
    // This checkout is behind, and ignores its own copies of both.
    fs.writeFileSync(path.join(app, '.git', 'info', 'exclude'), '.env\nlocal.json\n');
    fs.writeFileSync(path.join(app, '.env'), 'LOCAL=1\n');
    fs.writeFileSync(path.join(app, 'local.json'), '{"local":true}\n');
    fs.writeFileSync(path.join(app, '.worktreeinclude'), '.env\nlocal.json\n');

    const tree = await prepareWorktree(app, 'job-13');
    const copy = await copyWorktreeIncludes(tree.root, tree.path);
    expect(copy).toEqual({ copied: [], skipped: ['.env', 'local.json'] });
    expect(fs.readFileSync(path.join(tree.path, '.env'), 'utf8')).toBe('TRACKED=1\n');
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched\n');
  });

  it('copies nothing without a .worktreeinclude', async () => {
    const tree = await prepareWorktree(mainRepo, 'job-11');
    expect(await copyWorktreeIncludes(tree.root, tree.path)).toEqual({ copied: [], skipped: [] });
  });
});
