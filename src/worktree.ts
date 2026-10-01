import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { runInGroup } from './processGroup.js';

const execFileAsync = promisify(execFile);

type GitError = Error & { stderr?: string; code?: number | string };

export type WorktreeCleanup = { cleaned: string } | { skipped: string };

export type WorktreeIncludeWrite = { written: string; text: string } | { skipped: string };

export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

interface GitOptions {
  timeout?: number;
  /** Stops git when the run it is for is stopped. */
  signal?: AbortSignal;
  /** Untrimmed, for output that is NUL separated. */
  raw?: boolean;
  input?: string;
}

/** True for a git failure that left processes running which would not end, so its folder must be left alone. */
export function isStuck(err: unknown): boolean {
  return err instanceof Error && Boolean((err.cause as { stuck?: boolean } | undefined)?.stuck);
}

// A fetch that wants a password would otherwise wait for one forever.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

/**
 * git for a step a Stop can cut short: in a process group of its own, so
 * stopping it ends git and anything git started, such as a filter, and it
 * does not answer until they are gone. Nothing is then still writing in a
 * tree that is about to be removed.
 */
async function stoppableGit(dir: string, args: string[], options: GitOptions): Promise<string> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const result = await runInGroup('git', ['-C', dir, ...args], {
    env: GIT_ENV,
    input: options.input,
    signal: options.signal,
    timeoutMs: options.timeout ?? 60_000,
    onOutput: (chunk, from) => (from === 'stdout' ? stdout : stderr).push(chunk),
  });
  if (result.leftRunning) throw new Error(`git ${args[0]} left processes running that would not end`, { cause: { stuck: true } });
  if (result.aborted) throw new Error(`git ${args[0]} was stopped`);
  if (result.error !== null) throw new Error(result.error);
  if (result.timedOut) throw new Error(`git ${args[0]} took longer than ${((options.timeout ?? 60_000) / 1000).toFixed(0)}s`);
  if (result.code !== 0) {
    const message = Buffer.concat(stderr).toString('utf8').trim();
    throw new Error(message || `git ${args[0]} ${result.signal ? `was ended by ${result.signal}` : `exited with ${result.code}`}`, { cause: { code: result.code } });
  }
  const out = Buffer.concat(stdout).toString('utf8');
  return options.raw ? out : out.trim();
}

/** Runs git in `dir` and returns its trimmed stdout; a failure throws with git's own message. */
async function git(dir: string, args: string[], timeout: number | GitOptions = 60_000): Promise<string> {
  const options: GitOptions = typeof timeout === 'number' ? { timeout } : timeout;
  if (options.signal || options.input !== undefined || options.raw) return stoppableGit(dir, args, options);
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, ...args], { timeout: options.timeout ?? 60_000 });
    return stdout.trim();
  } catch (err) {
    throw new Error((err as GitError).stderr?.trim() || (err as GitError).message, { cause: err });
  }
}

/**
 * The top of the git repository `dir` sits in, or null when it is not in one.
 *
 * Claude Code reads .worktreeinclude from the repository root whatever folder
 * the session starts in, so a job whose working directory is a subfolder still
 * has to write it at the top.
 */
export async function repoRoot(dir: string): Promise<string | null> {
  return (await git(dir, ['rev-parse', '--show-toplevel'], 10_000).catch(() => '')) || null;
}

/**
 * The main checkout of the repository `dir` belongs to: the folder holding the
 * shared `.git`. It differs from `repoRoot` when `dir` is inside a linked
 * worktree, and it is where Claude Code makes worktrees and reads
 * .worktreeinclude from.
 */
export async function mainCheckoutRoot(dir: string): Promise<string | null> {
  const commonDir = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000).catch(() => '');
  if (!commonDir) return null;
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : repoRoot(dir);
}

/** Every worktree git knows of in the repository `dir` belongs to, with the branch each one has checked out. */
async function listWorktrees(dir: string): Promise<Array<{ path: string; branch: string | null }>> {
  const worktrees: Array<{ path: string; branch: string | null }> = [];
  for (const block of (await git(dir, ['worktree', 'list', '--porcelain'])).split('\n\n')) {
    const lines = block.split('\n');
    const worktreePath = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (!worktreePath) continue;
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length) ?? null;
    worktrees.push({ path: worktreePath, branch });
  }
  return worktrees;
}

/**
 * Force-removes the worktree Claude Code makes for `--worktree <name>`, and
 * deletes its `worktree-<name>` branch. Uncommitted files in it are not kept.
 * The branch's last commit goes in the result, so work committed only there
 * can still be recovered from it.
 *
 * The worktree is found through git rather than by building its path: Claude
 * Code puts it under the main checkout's `.claude/worktrees`, which is not the
 * folder `dir` is in when the job runs inside a linked worktree.
 *
 * @returns {Promise<{ cleaned: string } | { skipped: string }>} What was removed,
 *   or why there was nothing to remove.
 */
export async function removeWorktree(dir: string, name: string): Promise<WorktreeCleanup> {
  const root = await repoRoot(dir);
  if (!root) return { skipped: `${dir} is not in a git repository` };
  const branch = `worktree-${name}`;
  const removed: string[] = [];

  const registered = (await listWorktrees(root)).find((worktree) => worktree.branch === `refs/heads/${branch}`)?.path;
  const fallback = path.join((await mainCheckoutRoot(root)) ?? root, '.claude', 'worktrees', name);
  const worktreePath = registered ?? ((await fsp.stat(fallback).then(() => true, () => false)) ? fallback : null);

  if (worktreePath) {
    // Claude Code locks the worktrees it makes, and git refuses to remove a locked one.
    await git(root, ['worktree', 'unlock', worktreePath]).catch(() => {});
    // node_modules can hold hundreds of thousands of files, so this can take a while.
    await git(root, ['worktree', 'remove', '--force', worktreePath], 10 * 60_000);
    removed.push(`removed ${worktreePath}`);
  }

  const tip = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '');
  if (tip) {
    await git(root, ['branch', '-D', branch]);
    removed.push(`deleted branch ${branch} (was ${tip.slice(0, 10)})`);
  }

  if (!removed.length) return { skipped: `no worktree named ${name} in ${root}` };
  return { cleaned: removed.join(', ') };
}

/**
 * Where `dir` sits inside its repository, such as `apps/web`, or null at the
 * top of one or outside git. The root git reports has its symlinks resolved,
 * so `dir` is resolved too before the two are compared.
 */
export async function pathInRepo(dir: string): Promise<string | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  const relative = path.relative(root, await fsp.realpath(dir).catch(() => dir));
  return relative && !relative.startsWith('..') ? relative : null;
}

/**
 * Writes the default .worktreeinclude to the main checkout of the repository
 * `dir` is in, replacing whatever file is there. Claude Code reads it from
 * there even when the job runs inside a linked worktree.
 *
 * Empty text writes nothing rather than blanking a file the repo may rely on,
 * and a folder outside git writes nothing because there is no worktree to make.
 *
 * @returns {Promise<{ written: string, text: string } | { skipped: string }>} The
 *   path written and the exact text now in the file, or why nothing was written.
 */
export async function writeWorktreeInclude(dir: string, text: string): Promise<WorktreeIncludeWrite> {
  if (!text.trim()) return { skipped: 'the default on the Settings page is empty' };
  const root = await mainCheckoutRoot(dir);
  if (!root) return { skipped: `${dir} is not in a git repository` };
  const target = path.join(root, WORKTREE_INCLUDE_FILE);
  const content = text.endsWith('\n') ? text : `${text}\n`;
  await fsp.writeFile(target, content, 'utf8');
  return { written: target, text: content };
}

/** The folder Claude Code makes `--worktree <name>` in, under the main checkout, with `name` spelled as it spells it. */
export function worktreePath(mainRoot: string, name: string): string {
  return path.join(mainRoot, '.claude', 'worktrees', name.replaceAll('/', '+'));
}

/** The branch Claude Code gives that worktree. */
export function worktreeBranch(name: string): string {
  return `worktree-${name.replaceAll('/', '+')}`;
}

export interface PreparedWorktree {
  path: string;
  branch: string;
  /** The main checkout it belongs to, where `.worktreeinclude` is read and its files are copied from. */
  root: string;
  /** False when an existing worktree was reused, which keeps the files it has. */
  created: boolean;
  /** What happened, a line each, for the run's log. */
  notes: string[];
}

async function lstat(target: string): Promise<fs.Stats | null> {
  return fsp.lstat(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
}

function short(commit: string): string {
  return commit.slice(0, 10);
}

/**
 * The branch a fresh worktree starts from, picked as Claude Code picks it: the
 * one `origin/HEAD` names, or else a `main` or `master` the remote has. Null
 * when this checkout knows of none.
 */
async function defaultBranch(root: string): Promise<string | null> {
  const known = async (branch: string): Promise<boolean> =>
    Boolean(await git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`]).catch(() => ''));
  const named = (await git(root, ['symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => '')).replace(/^origin\//, '');
  if (named && (await known(named))) return named;
  for (const branch of ['main', 'master']) if (await known(branch)) return branch;
  return null;
}

interface Base {
  commit: string;
  label: string;
  fromRemote: boolean;
}

/**
 * Where a new worktree starts, as `claude --worktree` picks it: the remote's
 * default branch, fetched first so the tree has its newest commit, or this
 * checkout's own HEAD when there is no `origin/HEAD` to go on. A fetch that
 * fails is noted, and the branch as last fetched is used.
 */
async function freshBase(root: string, checkout: string, signal: AbortSignal | undefined, notes: string[]): Promise<Base> {
  const branch = await defaultBranch(root);
  if (!branch) {
    notes.push(`no origin/HEAD, so it starts from the HEAD of ${checkout}`);
    return { commit: await git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}']), label: 'HEAD', fromRemote: false };
  }
  const failure = await git(root, ['fetch', '--quiet', 'origin', branch], { timeout: 60_000, signal }).then(
    () => null,
    (err: Error) => err.message.replace(/\s+/g, ' '),
  );
  signal?.throwIfAborted();
  notes.push(failure === null ? `fetched origin ${branch}` : `could not fetch origin ${branch}, so it starts from origin/${branch} as last fetched: ${failure}`);
  return { commit: await git(root, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]), label: `origin/${branch}`, fromRemote: true };
}

/** git's common directory for a checkout, resolved, which is the same for a repository and each of its worktrees. */
async function commonDir(dir: string): Promise<string | null> {
  return git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    .then((found) => fsp.realpath(found))
    .catch(() => null);
}

/**
 * Makes, or finds again, the worktree `claude --worktree <name>` would use for
 * a job in `dir`, so promptd can set it up before Claude starts in it: the
 * same folder under the main checkout's `.claude/worktrees`, on the same
 * `worktree-<name>` branch, from the same base. `removeWorktree` cleans it up
 * as it does one Claude Code made, and a later run left to Claude Code
 * reopens it.
 *
 * An existing worktree is reused as it is, the way Claude Code reopens one,
 * except that one with no work of its own (clean, still on its branch, every
 * commit already on the base) is moved up to the newest base. A folder there
 * that is not a worktree of this repository, or a symlink on the way to it, is
 * refused, since either could put the checkout somewhere else.
 */
export async function prepareWorktree(dir: string, name: string, { signal }: { signal?: AbortSignal } = {}): Promise<PreparedWorktree> {
  const checkout = await repoRoot(dir);
  const root = checkout ? await mainCheckoutRoot(checkout) : null;
  if (!checkout || !root) throw new Error(`${dir} is not in a git repository`);
  const tree = worktreePath(root, name);
  const branch = worktreeBranch(name);
  const notes: string[] = [];

  for (const step of [path.join(root, '.claude'), path.dirname(tree), tree]) {
    if ((await lstat(step))?.isSymbolicLink()) throw new Error(`${step} is a symlink, which could put the worktree outside the repository; remove it and run again`);
  }

  const base = await freshBase(root, checkout, signal, notes);
  const existing = await lstat(tree);
  if (existing) {
    const top = existing.isDirectory() ? await git(tree, ['rev-parse', '--show-toplevel']).then((found) => fsp.realpath(found), () => null) : null;
    if (top !== (await fsp.realpath(tree)) || (await commonDir(tree)) !== (await commonDir(root))) {
      throw new Error(`${tree} already exists but is not a worktree of ${root}; move it aside and run again`);
    }
    notes.push(await catchUp(tree, branch, base, signal, `reused ${tree}`));
    return { path: tree, branch, root, created: false, notes };
  }

  // A worktree whose folder was deleted by hand is still registered, and git
  // refuses its path until it is forgotten.
  await git(root, ['worktree', 'prune']);
  await fsp.mkdir(path.dirname(tree), { recursive: true });
  // A branch left from an earlier tree may hold commits nothing else has, so
  // it is checked out again as it is rather than reset to the base.
  const kept = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '');
  const add = kept ? ['worktree', 'add', '--quiet', tree, branch] : ['worktree', 'add', '--quiet', '--no-track', '-b', branch, tree, base.commit];
  try {
    await git(root, add, { timeout: 10 * 60_000, signal });
  } catch (err) {
    // Not while something git started may still be writing there.
    if (!isStuck(err)) await discardHalfMade(root, tree, kept ? null : branch);
    throw err;
  }
  if (kept) {
    notes.push(await catchUp(tree, branch, base, signal, `made ${tree} again from the existing ${branch}`));
    return { path: tree, branch, root, created: true, notes };
  }
  notes.push(`created ${tree} on ${branch} from ${base.label} (${short(base.commit)})`);
  return { path: tree, branch, root, created: true, notes };
}

/**
 * A checkout cut short, by a Stop or a failure, would be found by the next
 * run as a worktree with most of its files missing. So it is removed, with
 * the branch made for it, while a branch that was already there is kept.
 */
async function discardHalfMade(root: string, tree: string, newBranch: string | null): Promise<void> {
  await git(root, ['worktree', 'remove', '--force', tree], 10 * 60_000).catch(() => {});
  await fsp.rm(tree, { recursive: true, force: true }).catch(() => {});
  await git(root, ['worktree', 'prune']).catch(() => {});
  if (newBranch) await git(root, ['branch', '-D', newBranch]).catch(() => {});
}

/**
 * Moves a tree that has no work of its own up to the newest base, as Claude
 * Code does when it reopens one: only when it is clean, still on its branch,
 * and every commit on it is already on the base. Anything else is left as it
 * is. Answers what it did, for the log, after `what` it says happened first.
 */
async function catchUp(tree: string, branch: string, base: Base, signal: AbortSignal | undefined, what: string): Promise<string> {
  const head = await git(tree, ['rev-parse', 'HEAD']);
  const onBranch = (await git(tree, ['symbolic-ref', '--short', '--quiet', 'HEAD']).catch(() => '')) === branch;
  const clean = onBranch && !(await git(tree, ['status', '--porcelain']));
  const upstream = clean && (await git(tree, ['merge-base', '--is-ancestor', head, base.commit]).then(() => true, () => false));
  if (base.fromRemote && upstream && head !== base.commit) {
    await git(tree, ['reset', '--quiet', '--hard', base.commit], { signal });
    return `${what} and moved it to ${base.label} (${short(base.commit)}), since it had no work of its own`;
  }
  return `${what} at ${short(head)}${onBranch ? '' : ', off its branch'}, as it was left`;
}

export interface IncludeCopy {
  copied: string[];
  skipped: string[];
}

/** True when a folder on the way from `tree` down to `target` is a symlink, which could carry a copy outside the tree. */
async function crossesSymlink(tree: string, target: string): Promise<boolean> {
  let at = tree;
  for (const part of path.relative(tree, path.dirname(target)).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    const stat = await lstat(at);
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Copies into a new worktree what `.worktreeinclude` in the main checkout
 * names, as Claude Code does when it makes one: each file that matches a
 * pattern and that git ignores. A symlink is left out, and so is any file
 * whose place in the tree is already taken or is reached through a symlink,
 * so a copy never replaces what the tree checked out or writes outside it.
 */
export async function copyWorktreeIncludes(sourceRoot: string, tree: string, { signal }: { signal?: AbortSignal } = {}): Promise<IncludeCopy> {
  const result: IncludeCopy = { copied: [], skipped: [] };
  const list = path.join(sourceRoot, WORKTREE_INCLUDE_FILE);
  const text = await fsp.readFile(list, 'utf8').catch(() => '');
  if (!text.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith('#'))) return result;
  const names = (out: string): string[] => out.split('\0').filter(Boolean);
  // Untracked files the list matches, then the ones of those git ignores.
  const matching = names(await git(sourceRoot, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${list}`], { raw: true, signal }));
  if (!matching.length) return result;
  const ignored = names(
    await git(sourceRoot, ['check-ignore', '-z', '--stdin'], { raw: true, signal, input: `${matching.join('\0')}\0` }).catch((err: Error) => {
      // It exits 1 when it ignores none of them.
      if ((err.cause as GitError | undefined)?.code === 1) return '';
      throw err;
    }),
  );
  for (const file of ignored) {
    signal?.throwIfAborted();
    const from = path.join(sourceRoot, file);
    const to = path.join(tree, file);
    // Something already at `to` is the tree's own, such as a file the base
    // tracks that this checkout ignores, or a committed symlink a copy would
    // write through; either way it is left alone.
    if ((await lstat(from))?.isSymbolicLink() || (await crossesSymlink(tree, to)) || (await lstat(to))) {
      result.skipped.push(file);
      continue;
    }
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    result.copied.push(file);
  }
  return result;
}
