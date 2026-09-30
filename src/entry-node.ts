import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINARY_VERSION } from './binary.js';
import { BuildNotReleasedError, GIVE_UP_AFTER_MS, HOLD_AFTER_MS, installVersion, nextUpdateStep, underLaunchd, versionOnDisk } from './binaryUpdate.js';
import { bus } from './events.js';
import { NODE_HOME, NODE_LOGS_DIR, NODE_TOKEN_FILE } from './paths.js';
import { cronService } from './cronService.js';
import {
  acknowledgePatches,
  flushJobCache,
  jobSettings,
  listCrons,
  listExecutions,
  loadJobCache,
  logDir,
  pendingPatches,
  replaceJobs,
} from './jobCache.js';
import { DEFAULT_MAX_CONCURRENT_JOBS, normalizeMaxConcurrentJobs } from './settings.js';
import { browseDirectories } from './browse.js';
import { setUsageThresholds, usageMonitor } from './usage.js';
import { modelCatalog } from './models.js';
import { systemMonitor } from './system.js';
import type {
  BusEvent,
  CommandResult,
  JobView,
  LogChunk,
  NodeCommand,
  NodeIdentity,
  NodeSettings,
  NodeStatus,
  NodeWork,
  PauseState,
} from './types.js';

interface Upload {
  jobId: string;
  file: string;
  offset: number;
}

type RunStartedEvent = BusEvent & { cronId: string; logFile: string };

type SyncFailure = Error & { cause?: { code?: string } };

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB_URL = (process.env.PROMPTD_HUB_URL || `http://127.0.0.1:${process.env.PORT || 4321}`).replace(/\/+$/, '');
const HOSTNAME = os.hostname().replace(/\.local$/, '');
const NODE_ID = slug(process.env.PROMPTD_NODE_ID || HOSTNAME);
const NODE_NAME = process.env.PROMPTD_NODE_NAME || HOSTNAME;
const SYNC_MS = Number(process.env.PROMPTD_SYNC_MS) || 2000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_LOG_BYTES_PER_REPORT = 2 * 1024 * 1024;
const MAX_QUEUED_EVENTS = 2000;
const MAX_REMEMBERED_COMMANDS = 500;
const UPLOADS_FILE = path.join(NODE_HOME, 'uploads.json');
// The hub's token, from trading a join code, on a node away from the hub.
const PAIRED_TOKEN_FILE = path.join(NODE_HOME, 'hub-token');
// A build that failed to install is tried again after an hour.
const UPDATE_RETRY_MS = 60 * 60 * 1000;
const INSTANCE = randomUUID();
const STARTED_AT = new Date().toISOString();

function slug(value: string): string {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'node'
  );
}

let events: BusEvent[] = [];
let commandResults: CommandResult[] = [];
const handledCommands = new Set<string>();
const uploads = new Map<string, Upload>();
let commit: string | null = null;
let reconciled = false;
let appliedPauseKey: string | null = null;
/** The hub's build this binary is installed as and waiting to restart into, and whether new runs are held for it. */
let updatingTo: { version: string; since: number; holding: boolean } | null = null;
/** Checks the wait for runs to finish on its own clock, since the hub may be out of reach. */
let updateDrainTimer: ReturnType<typeof setInterval> | null = null;
let drainStepRunning = false;
const updateFailedAt = new Map<string, number>();
/** A join code the hub refused, which is not sent again. */
let rejectedCode: string | null = null;
interface Download {
  version: string;
  settled: boolean;
  error: Error | null;
}
/** The hub's build being downloaded, while the node carries on. */
let download: Download | null = null;
/** Builds the hub runs that have no release, which are not asked for again. */
const unreleasedBuilds = new Set<string>();
let lastError: string | null = null;

bus.on('event', (event) => {
  if (event.type === 'run:started' && event.logFile) {
    const started = event as RunStartedEvent;
    uploads.set(uploadKey(started.cronId, started.logFile), { jobId: started.cronId, file: started.logFile, offset: 0 });
    saveUploads();
  }
  events.push(event);
  if (events.length > MAX_QUEUED_EVENTS) events = events.slice(-MAX_QUEUED_EVENTS);
});

function uploadKey(jobId: string, file: string): string {
  return `${jobId}/${file}`;
}

async function loadUploads(): Promise<void> {
  try {
    for (const entry of JSON.parse(await fsp.readFile(UPLOADS_FILE, 'utf8')) as Upload[]) {
      uploads.set(uploadKey(entry.jobId, entry.file), entry);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[node] could not read ${UPLOADS_FILE}: ${(err as Error).message}`);
  }
}

function saveUploads(): void {
  const tmp = `${UPLOADS_FILE}.${process.pid}.tmp`;
  fsp
    .mkdir(NODE_HOME, { recursive: true })
    .then(() => fsp.writeFile(tmp, JSON.stringify([...uploads.values()]), 'utf8'))
    .then(() => fsp.rename(tmp, UPLOADS_FILE))
    .catch((err) => console.error(`[node] could not save ${UPLOADS_FILE}: ${(err as Error).message}`));
}

async function readFileToken(file: string): Promise<string | null> {
  try {
    return (await fsp.readFile(file, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

/** Trades the join code for the hub's token, and keeps the token for every restart after. */
async function pair(code: string): Promise<string> {
  const res = await fetch(`${HUB_URL}/api/node/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const answer = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !answer.token) {
    // Asking again with the same code would only use up the hub's wrong-code allowance.
    rejectedCode = code;
    throw new Error(`the hub refused join code ${code}: ${answer.error ?? res.status}`);
  }
  await fsp.writeFile(PAIRED_TOKEN_FILE, `${answer.token}\n`, { mode: 0o600 });
  console.log(`[node] paired with ${HUB_URL}; its token is kept in ${PAIRED_TOKEN_FILE}`);
  return answer.token;
}

async function readToken(): Promise<string> {
  if (process.env.PROMPTD_NODE_TOKEN) return process.env.PROMPTD_NODE_TOKEN.trim();
  const token = (await readFileToken(NODE_TOKEN_FILE)) ?? (await readFileToken(PAIRED_TOKEN_FILE));
  if (token) return token;
  const code = process.env.PROMPTD_JOIN_CODE?.trim();
  if (code && code !== rejectedCode) return pair(code);
  throw new Error(
    code
      ? `join code ${code} was refused; make a new one on the hub and run the installer again`
      : `no token: set PROMPTD_NODE_TOKEN or PROMPTD_JOIN_CODE, or run on the hub's machine where ${NODE_TOKEN_FILE} exists`,
  );
}

async function request<T>(method: string, route: string, body?: unknown): Promise<T> {
  const token = await readToken();
  const res = await fetch(`${HUB_URL}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-promptd-node': NODE_ID,
      'x-promptd-instance': INSTANCE,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(`hub answered ${res.status}: ${payload.error ?? res.statusText}`);
  return payload as T;
}

function identity(): NodeIdentity {
  return {
    id: NODE_ID,
    name: NODE_NAME,
    instance: INSTANCE,
    hostname: os.hostname(),
    platform: process.platform,
    commit,
    startedAt: STARTED_AT,
    processors: DEFAULT_MAX_CONCURRENT_JOBS,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function readLogChunks(): Promise<LogChunk[]> {
  const chunks: LogChunk[] = [];
  let budget = MAX_LOG_BYTES_PER_REPORT;
  for (const [key, entry] of uploads) {
    if (budget <= 0) break;
    const file = path.join(logDir(entry.jobId), entry.file);
    let handle: FileHandle | undefined;
    try {
      handle = await fsp.open(file, 'r');
      const { size } = await handle.stat();
      if (size <= entry.offset) continue;
      const length = Math.min(size - entry.offset, budget);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, entry.offset);
      budget -= length;
      chunks.push({ jobId: entry.jobId, file: entry.file, offset: entry.offset, data: buffer.toString('base64') });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        uploads.delete(key);
        saveUploads();
      } else console.error(`[node] could not read ${file}: ${(err as Error).message}`);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return chunks;
}

async function settleUploads(offsets: Record<string, number> = {}): Promise<void> {
  let changed = false;
  for (const [key, entry] of uploads) {
    if (Number.isFinite(offsets[key]) && offsets[key] !== entry.offset) {
      entry.offset = offsets[key] as number;
      changed = true;
    }
    if (cronService.isRunningLog(entry.jobId, entry.file)) continue;
    const file = path.join(logDir(entry.jobId), entry.file);
    const size = await fsp
      .stat(file)
      .then((stat) => stat.size)
      .catch(() => null);
    if (size !== null && entry.offset < size) continue;
    uploads.delete(key);
    changed = true;
    await fsp.rm(file, { force: true }).catch(() => {});
  }
  if (changed) saveUploads();
}

async function jobViews(): Promise<Record<string, JobView>> {
  const views: Record<string, JobView> = {};
  for (const cron of await listCrons()) {
    const nextRunAt = cronService.nextRun(cron.id);
    const delayed = cronService.delayInfo(cron.id);
    views[cron.id] = {
      nextRunAt,
      currentRun: cronService.currentRun(cron.id),
      delayed,
      delayRisk: nextRunAt && !delayed ? cronService.delayOutlook(cron, nextRunAt) : null,
    };
  }
  for (const execution of await listExecutions()) {
    const armed = execution.isActive && execution.status === 'scheduled';
    const delayed = cronService.delayInfo(execution.id);
    views[execution.id] = {
      nextRunAt: armed ? execution.scheduledAt : null,
      currentRun: cronService.currentRun(execution.id),
      delayed,
      delayRisk: armed && !delayed ? cronService.delayOutlook(execution, execution.scheduledAt as string) : null,
    };
  }
  for (const run of cronService.running.values()) {
    views[run.cronId] ??= { nextRunAt: null, currentRun: run, delayed: null, delayRisk: null };
  }
  return views;
}

async function status(): Promise<NodeStatus> {
  const { samples, ...system } = systemMonitor.state();
  return {
    pause: cronService.pauseInfo(),
    concurrency: cronService.concurrencyInfo(),
    counts: {
      scheduled: cronService.jobs.size,
      running: cronService.runningCount(),
      delayed: cronService.delayedCount(),
      queued: cronService.queuedCount(),
      usageDelayed: cronService.usageDelays().length,
      armedCrons: cronService.armedCrons,
      armedExecutions: cronService.armedExecutions,
      concurrencyLimit: cronService.concurrencyLimit,
    },
    jobs: await jobViews(),
    activeLogs: [...uploads.values()].map(({ jobId, file }) => ({ jobId, file })),
    usage: await usageMonitor.state(),
    models: modelCatalog.state(),
    system,
  };
}

async function report(): Promise<void> {
  const patches = pendingPatches();
  const sentEvents = events.slice();
  const sentResults = commandResults.slice();
  const answer = await request<{ logOffsets?: Record<string, number> }>('POST', '/api/node/report', {
    node: identity(),
    logs: await readLogChunks(),
    patches,
    events: sentEvents,
    commandResults: sentResults,
    status: await status(),
  });
  acknowledgePatches(patches.length);
  events = events.slice(sentEvents.length);
  commandResults = commandResults.slice(sentResults.length);
  await settleUploads(answer.logOffsets);
}

function applySettings(settings: Partial<NodeSettings>): void {
  const limit = settings.maxConcurrentJobs == null ? null : normalizeMaxConcurrentJobs(settings.maxConcurrentJobs);
  cronService.setConcurrencyLimit(limit ?? DEFAULT_MAX_CONCURRENT_JOBS);
  if (settings.usageDelayThresholds) setUsageThresholds(settings.usageDelayThresholds);
}

async function reconcileOnce(): Promise<void> {
  if (reconciled) return;
  reconciled = true;
  await cronService.reconcileInterrupted().catch((err) => console.error(`[cron] reconcile failed: ${(err as Error).message}`));
}

async function applyPause(pause: PauseState | null | undefined): Promise<void> {
  // The node's own update pause holds until it restarts, whatever the hub says.
  if (updatingTo?.holding) return;
  if (!pause) {
    appliedPauseKey = null;
    if (cronService.isPaused()) await cronService.resumeAll('lifted on the hub');
    return;
  }
  const key = `${pause.mode}:${pause.startedAt}`;
  if (key === appliedPauseKey && cronService.isPaused()) return;
  appliedPauseKey = key;
  await cronService.pauseAll({ mode: pause.mode, label: pause.label, option: pause.option, ms: null });
}

async function runCommand(command: NodeCommand): Promise<void> {
  if (handledCommands.has(command.id)) return;
  handledCommands.add(command.id);
  if (handledCommands.size > MAX_REMEMBERED_COMMANDS) handledCommands.delete(handledCommands.values().next().value!);
  try {
    let result: Record<string, unknown> | null = null;
    if (command.type === 'run') {
      const outcome = await cronService.trigger(command.jobId as string, 'manual');
      result = outcome?.delayed ? { delayed: outcome.delayed } : { started: Boolean(outcome) };
    } else if (command.type === 'stop') {
      const cancelled = await cronService.cancelDelay(command.jobId as string, 'user');
      if (!cancelled) await cronService.stop(command.jobId as string, 'user');
    } else if (command.type === 'browse') {
      result = { ...(await browseDirectories(String(command.args?.path ?? ''))) };
    } else if (command.type === 'refreshModels') {
      modelCatalog.refresh();
    } else {
      throw new Error(`unknown command ${command.type}`);
    }
    commandResults.push({ id: command.id, ok: true, result });
  } catch (err) {
    console.error(`[node] ${command.type} ${command.jobId ?? ''} failed: ${(err as Error).message}`);
    commandResults.push({ id: command.id, ok: false, error: (err as Error).message });
  }
}

async function fetchWork(): Promise<void> {
  const work = await request<NodeWork>('GET', '/api/node/work');
  const { jobsChanged, settingsChanged } = replaceJobs(work);
  if (settingsChanged) {
    applySettings(work.settings);
    cronService.reviewDelays().catch((err) => console.error(`[cron] usage delay review failed: ${(err as Error).message}`));
  }
  const firstRebuild = !reconciled;
  await reconcileOnce();
  if (jobsChanged || firstRebuild) await cronService.reload();
  await applyPause(work.pause);
  for (const command of work.commands ?? []) await runCommand(command);
  await followHub(work.hubVersion);
}

async function abandonUpdate(version: string, why: string): Promise<void> {
  console.error(`[update] ${why}; trying again in an hour`);
  updateFailedAt.set(version, Date.now());
  if (!updatingTo) return;
  const { holding } = updatingTo;
  updatingTo = null;
  if (updateDrainTimer) clearInterval(updateDrainTimer);
  updateDrainTimer = null;
  if (!holding) return;
  appliedPauseKey = null;
  await cronService.resumeAll('update abandoned');
}

/**
 * A binary node runs its hub's build, so the two always agree on what they send
 * each other. The new build is downloaded while runs carry on, since the running
 * process keeps its own file, and the node restarts into it the moment nothing
 * is running. Only a node still busy after an hour holds new runs to get there.
 */
async function followHub(version: string | null | undefined): Promise<void> {
  if (!BINARY_VERSION || !version || version === BINARY_VERSION || unreleasedBuilds.has(version)) return;
  // A restart under way finishes first, holding what it holds; the next build is followed after it.
  if (drainStepRunning) return;
  const failedAt = updateFailedAt.get(version);
  if (failedAt !== undefined && Date.now() - failedAt < UPDATE_RETRY_MS) return;

  if (updatingTo?.version !== version) {
    // The download runs beside the sync, so the node keeps reporting and the
    // hub never sees it go quiet; each cycle looks in on it until it settles.
    if (download?.version !== version) {
      const started: Download = { version, settled: false, error: null };
      download = started;
      versionOnDisk()
        .then((onDisk) => (onDisk === version ? undefined : installVersion(version)))
        .catch((err: Error) => {
          started.error = err;
        })
        .finally(() => {
          started.settled = true;
        });
      return;
    }
    if (!download.settled) return;
    const { error } = download;
    download = null;
    if (error instanceof BuildNotReleasedError) {
      unreleasedBuilds.add(version);
      console.error(`[update] the hub runs build ${version}, which has no release to download (${error.message}); staying on ${BINARY_VERSION}`);
      return;
    }
    if (error) return abandonUpdate(version, `could not install the hub's build ${version}: ${error.message}`);
    if (!underLaunchd()) {
      return abandonUpdate(version, `build ${version} is on disk, but launchd is not running this node, so restart it to finish`);
    }
    // A newer build replacing one already waited for keeps its hold, so no run starts in between.
    updatingTo = { version, since: Date.now(), holding: updatingTo?.holding ?? false };
    console.log(`[update] build ${version} installed; restarting into it once nothing is running`);
    if (updateDrainTimer) clearInterval(updateDrainTimer);
    updateDrainTimer = setInterval(() => {
      drainForUpdate().catch((err: Error) => console.error(`[update] ${err.message}`));
    }, SYNC_MS);
    await drainForUpdate();
  }
}

/** Takes the next step towards restarting into the new build; runs on its own timer, since the hub may be out of reach. */
async function drainForUpdate(): Promise<void> {
  // One step at a time: the timer can fire again while a step awaits the pause.
  if (!updatingTo || drainStepRunning) return;
  drainStepRunning = true;
  try {
    await stepTowardsRestart(updatingTo);
  } finally {
    drainStepRunning = false;
  }
}

async function stepTowardsRestart(update: NonNullable<typeof updatingTo>): Promise<void> {
  const running = cronService.activeRunCount();
  const step = nextUpdateStep({ running, waitedMs: Date.now() - update.since, holding: update.holding });
  if (step === 'restart') {
    if (!update.holding) {
      // Held before the first await, so a sync landing meanwhile cannot lift the
      // pause; then counted again, since a trigger may have been on its way to a run.
      update.holding = true;
      await cronService.pauseAll({ mode: 'update', label: 'for update' });
      if (cronService.activeRunCount() > 0) return;
    }
    if (updateDrainTimer) clearInterval(updateDrainTimer);
    updateDrainTimer = null;
    console.log(`[update] nothing running; exiting for launchd to start build ${update.version}`);
    await shutdown('update');
  } else if (step === 'hold') {
    update.holding = true;
    console.log(`[update] ${running} run(s) still going after ${HOLD_AFTER_MS / 3600000}h; holding new runs until they finish`);
    await cronService.pauseAll({ mode: 'update', label: 'for update' });
  } else if (step === 'give up') {
    await abandonUpdate(update.version, `${running} run(s) still going after ${GIVE_UP_AFTER_MS / 3600000}h`);
  }
}

async function cycle(): Promise<void> {
  try {
    await report();
    await fetchWork();
    // Someone is waiting on the page for a folder list; answer now rather than next cycle.
    if (commandResults.length) await report();
    if (lastError) console.log(`[node] reconnected to ${HUB_URL}`);
    lastError = null;
  } catch (err) {
    const failure = err as SyncFailure;
    const message = failure.name === 'TimeoutError' ? 'request timed out' : failure.cause?.code ?? failure.message;
    if (message !== lastError) console.error(`[node] cannot sync with ${HUB_URL}: ${message}`);
    lastError = message;
  } finally {
    setTimeout(cycle, SYNC_MS);
  }
}

function readCommit(): Promise<string | null> {
  if (BINARY_VERSION) return Promise.resolve(BINARY_VERSION);
  return new Promise((resolve) => {
    execFile('git', ['-C', PROJECT_DIR, 'rev-parse', '--short', 'HEAD'], { timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[node] ${signal}; saving state`);
  await flushJobCache().catch((err) => console.error(`[node] could not save state: ${(err as Error).message}`));
  await request('POST', '/api/node/leave', {}).catch(() => {});
  process.exit(0);
}

await fsp.mkdir(NODE_LOGS_DIR, { recursive: true });
await loadUploads();
commit = await readCommit();
if (await loadJobCache()) {
  applySettings(jobSettings());
  await reconcileOnce();
  await cronService.reload();
}
modelCatalog.refresh();
systemMonitor.start({ runningCrons: () => cronService.runningCrons() });
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
console.log(`promptd node "${NODE_NAME}" (${NODE_ID}) syncing with ${HUB_URL} every ${SYNC_MS}ms`);
cycle();
