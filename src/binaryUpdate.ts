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

// A hub hands its build to its nodes with these, naming the build and its sha256.
export const BUILD_VERSION_HEADER = 'x-promptd-version';
export const BUILD_SHA256_HEADER = 'x-promptd-sha256';

/** The sha256 that a `shasum -a 256` listing gives for `file`, or null when it lists no such file. */
export function checksumFor(sums: string, file: string): string | null {
  for (const line of sums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name === file) return hash.toLowerCase();
  }
  return null;
}

/**
 * Whether this process is a launchd job, which launchd can start again: launchd
 * names the job in XPC_SERVICE_NAME and starts it itself, so is its parent. A
 * terminal sets the name to 0, but an app launchd started can hand its own name
 * to a shell, whose processes it is not the parent of.
 */
export function underLaunchd(env: NodeJS.ProcessEnv = process.env, ppid: number = process.ppid): boolean {
  const name = env.XPC_SERVICE_NAME;
  return Boolean(name && name !== '0') && ppid === 1;
}

/** The launchctl arguments that have launchd stop the job `label` and start it again. */
export function kickstartArgs(label: string, uid: number): string[] {
  return ['kickstart', '-k', `gui/${uid}/${label}`];
}

// launchd stops this process with SIGTERM before it starts the new one, so still
// being here this long after asking means no restart is coming.
export const RESTART_WAIT_MS = 5000;

export interface RestartOptions {
  env?: NodeJS.ProcessEnv;
  ppid?: number;
  uid?: number;
  /** Runs launchctl with these arguments, settling when it exits. */
  launchctl?: (args: string[]) => Promise<unknown>;
  exit?: (code: number) => void;
  waitMs?: number;
}

/** Whether the process is on its way out to the new build, and why not when it stays. */
export type RestartOutcome = { restarting: true } | { restarting: false; reason: string };

/**
 * Restarts this process into the build now on disk by asking launchd to restart
 * the job. When launchctl fails or no restart comes, the process keeps running
 * and the reason comes back: exiting would leave the Mac without promptd where
 * macOS never starts it by itself. Outside launchd it exits, but callers check
 * underLaunchd first and keep running there.
 */
export async function restartService({
  env = process.env,
  ppid = process.ppid,
  uid = process.getuid?.() ?? 0,
  launchctl = (args) => execFileAsync('/bin/launchctl', args, { timeout: 10_000 }),
  exit = (code) => process.exit(code),
  waitMs = RESTART_WAIT_MS,
}: RestartOptions = {}): Promise<RestartOutcome> {
  const label = env.XPC_SERVICE_NAME;
  if (!label || !underLaunchd(env, ppid)) {
    exit(0);
    return { restarting: true };
  }
  try {
    await launchctl(kickstartArgs(label, uid));
  } catch (err) {
    return { restarting: false, reason: `launchctl could not restart ${label}: ${(err as Error).message}` };
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return { restarting: false, reason: `launchd did not restart ${label} within ${waitMs / 1000}s of being asked` };
}

export interface Handoff {
  /** Saves state and signs off, so the new process starts from where this one left off. */
  signOff: () => Promise<void>;
  /** Whether a signal asked the process to stop for good, whose handler then exits. */
  stopAsked: () => boolean;
  restart: () => Promise<RestartOutcome>;
  /** Undoes the sign-off and carries on with the build that is running. */
  carryOn: (reason: string) => Promise<void>;
}

/**
 * Hands the process over to the new build. A handoff that fails leaves this
 * process running, since nothing else may start promptd on this Mac.
 */
export async function handOff({ signOff, stopAsked, restart, carryOn }: Handoff): Promise<void> {
  await signOff();
  if (stopAsked()) return;
  const outcome = await restart();
  if (outcome.restarting || stopAsked()) return;
  await carryOn(outcome.reason);
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

// A node with a new build on disk restarts into it the moment nothing is
// running. If it stays busy this long it holds new runs so the running ones
// can finish, and after the second limit it gives up and carries on.
export const HOLD_AFTER_MS = 60 * 60 * 1000;
export const GIVE_UP_AFTER_MS = 4 * 60 * 60 * 1000;

export type UpdateStep = 'restart' | 'hold' | 'wait' | 'give up';

/** What a node waiting to restart into a new build does next. */
export function nextUpdateStep({ running, waitedMs, holding }: { running: number; waitedMs: number; holding: boolean }): UpdateStep {
  if (running === 0) return 'restart';
  if (waitedMs >= GIVE_UP_AFTER_MS) return 'give up';
  if (!holding && waitedMs >= HOLD_AFTER_MS) return 'hold';
  return 'wait';
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
  await replaceExecutable(binary);
}

/** A rename, so the process running `target` keeps the file it started from until it restarts. */
async function replaceExecutable(binary: Buffer, target = process.execPath): Promise<void> {
  // A name of its own, so no other install can truncate it before the rename.
  const next = `${target}.${randomBytes(6).toString('hex')}.new`;
  try {
    await fsp.writeFile(next, binary, { mode: 0o755, flag: 'wx' });
    await fsp.rename(next, target);
  } catch (err) {
    await fsp.rm(next, { force: true });
    throw err;
  }
}

/** The hub has no build to hand out: it is a checkout, or runs on Linux. */
export class HubHasNoBuildError extends Error {}

export interface HubBuildRequest {
  hubUrl: string;
  /** The node token, which the hub serves its build to. */
  token: string;
  /** The build the hub said it runs, which is the one to install. */
  version: string;
  /** The file to replace; the running executable unless a test says otherwise. */
  target?: string;
}

/**
 * Downloads the hub's build and puts it in place of `target`, once it is the
 * version asked for and matches the sha256 the hub sent with it. Nodes never
 * ask GitHub: the hub is the one machine that does.
 */
export async function installHubBuild({ hubUrl, token, version, target }: HubBuildRequest): Promise<void> {
  const res = await fetch(`${hubUrl}/api/node/build`, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'promptd' },
    signal: AbortSignal.timeout(300_000),
  });
  if (res.status === 404) throw new HubHasNoBuildError('the hub cannot serve a node build');
  if (!res.ok) throw new Error(`the hub answered ${res.status} for its build`);
  // The hub may have moved on to another build since it said which one it runs.
  const sent = res.headers.get(BUILD_VERSION_HEADER);
  if (sent !== version) throw new Error(`the hub sent build ${sent ?? 'with no name'} rather than ${version}`);
  const expected = res.headers.get(BUILD_SHA256_HEADER)?.toLowerCase();
  if (!expected) throw new Error(`the hub sent build ${version} without its checksum`);
  const binary = Buffer.from(await res.arrayBuffer());
  if (createHash('sha256').update(binary).digest('hex') !== expected) {
    throw new Error(`build ${version} from the hub does not match the checksum it sent`);
  }
  await replaceExecutable(binary, target);
}
