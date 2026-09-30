import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';
import { BINARY_REPO } from './binary.js';

const execFileAsync = promisify(execFile);

// Every commit on main is released as build-<commit>, so a version and its
// release are one lookup apart.
const TAG_PREFIX = 'build-';

export function releaseTag(version: string): string {
  return `${TAG_PREFIX}${version}`;
}

export function versionOfTag(tag: string): string | null {
  return tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : null;
}

/** The release file: promptd is built for Apple silicon Macs only. */
export const ASSET = 'promptd-darwin-arm64';

/** The sha256 that a `shasum -a 256` listing gives for `file`, or null when it lists no such file. */
export function checksumFor(sums: string, file: string): string | null {
  for (const line of sums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name === file) return hash.toLowerCase();
  }
  return null;
}

/**
 * Whether exiting brings this process straight back: launchd names the job it
 * runs in XPC_SERVICE_NAME, and a terminal sets it to 0.
 */
export function underLaunchd(env: NodeJS.ProcessEnv = process.env): boolean {
  const name = env.XPC_SERVICE_NAME;
  return Boolean(name && name !== '0');
}

async function github<T>(route: string): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${BINARY_REPO}${route}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'promptd' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${route}`);
  return (await res.json()) as T;
}

/** A build with no release: made from a commit that was never on main, or pruned since. */
export class BuildNotReleasedError extends Error {}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'user-agent': 'promptd' }, signal: AbortSignal.timeout(300_000) });
  if (res.status === 404) throw new BuildNotReleasedError(`no release has ${url.split('/').slice(-2).join('/')}`);
  if (!res.ok) throw new Error(`could not download ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The newest build's version, or null when the newest release is not a build. */
export async function latestVersion(): Promise<string | null> {
  return versionOfTag((await github<{ tag_name: string }>('/releases/latest')).tag_name);
}

/** How many commits `to` has that `from` does not, and the other way round. */
export async function compareBuilds(from: string, to: string): Promise<{ behind: number; ahead: number }> {
  const comparison = await github<{ ahead_by: number; behind_by: number }>(`/compare/${from}...${to}`);
  return { behind: comparison.ahead_by, ahead: comparison.behind_by };
}

/** Which build the file on disk is, which after an update is not the one running. */
export async function versionOnDisk(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ['version'], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Puts `version`'s binary for this Mac in place of the running one, once it
 * matches the release's checksum. A rename, so this process keeps running the
 * file it started from until it restarts.
 */
export async function installVersion(version: string): Promise<void> {
  const base = `https://github.com/${BINARY_REPO}/releases/download/${releaseTag(version)}`;
  const name = ASSET;
  const [binary, sums] = await Promise.all([download(`${base}/${name}`), download(`${base}/sha256sums.txt`)]);
  const expected = checksumFor(sums.toString('utf8'), name);
  const actual = createHash('sha256').update(binary).digest('hex');
  if (!expected) throw new Error(`build ${version} lists no checksum for ${name}`);
  if (expected !== actual) throw new Error(`build ${version}'s ${name} does not match its checksum`);
  // A name of its own, so no other install can truncate it before the rename.
  const next = `${process.execPath}.${randomBytes(6).toString('hex')}.new`;
  try {
    await fsp.writeFile(next, binary, { mode: 0o755, flag: 'wx' });
    await fsp.rename(next, process.execPath);
  } catch (err) {
    await fsp.rm(next, { force: true });
    throw err;
  }
}
