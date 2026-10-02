import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { bus, emit } from './events.js';
import { db } from './db.js';
import { JOIN_CODES_FILE, NODE_TOKEN_FILE } from './paths.js';
import { JoinCodes } from './joinCodes.js';
import type { JoinCode } from './joinCodes.js';
import { sendBuild, sendNoBuild } from './nodeBuild.js';
import type { NodeBuild } from './nodeBuild.js';
import { applyInferredTitle, listCrons, logPath, patchCron, pruneLogs } from './store.js';
import { STATUSES, getExecution, listExecutions, patchExecution } from './executions.js';
import { DEFAULT_MAX_CONCURRENT_JOBS, patchSettings } from './settings.js';
import { effectiveNodeConfig, patchNodeConfig, readNodeConfig } from './nodeConfig.js';
import { PRE_PROMPT_COMMANDS_FEATURE, readJobDefaults, resolveJob } from './jobDefaults.js';
import { TITLE_PROMPT_LIMIT, cleanTitle } from './naming.js';
import type { EffectiveNodeConfig } from './nodeConfig.js';
import { browseDirectories } from './browse.js';
import type { BrowseResult } from './browse.js';
import { HISTORY_WINDOW_MS, SAMPLE_INTERVAL_MS, SYSTEM_METRICS } from './system.js';
import { reportedAccount } from './account.js';
import { clusterLimit, clusterSummary, machineExceptions } from './cluster.js';
import type { ClusterNode, ClusterSummary, MachineException } from './cluster.js';
import type {
  BusEvent,
  ClaudeAccount,
  CommandResult,
  ConcurrencyInfo,
  Cron,
  DelayEntry,
  Execution,
  JobDefaults,
  JobDefaultsOverride,
  JobKind,
  JobPatch,
  JobView,
  LogChunk,
  ModelCatalogState,
  NodeCommand,
  NodeCommandType,
  NodeConfig,
  NodeCounts,
  NodeSettings,
  NodeStatus,
  PauseInfo,
  PauseState,
  RunnableCron,
  RunnableExecution,
  Settings,
  SystemSample,
  UsageReading,
} from './types.js';

const OFFLINE_AFTER_MS = 15 * 1000;
const COMMAND_TTL_MS = 60 * 1000;
const JOBS_CACHE_MS = 10 * 1000;
const MODEL_REFRESH_WAIT_MS = 90 * 1000;
const BROWSE_WAIT_MS = 8 * 1000;
// Claude's own minute, and a couple of syncs either side of it.
const TITLE_WAIT_MS = 75 * 1000;

const BOOKKEEPING_FIELDS = new Set([
  'lastRunAt',
  'lastRunStatus',
  'lastRunLog',
  'lastRunDurationSeconds',
  'lifetimeRuns',
  'lifetimeCostUsd',
  'lifetimeRuntimeSeconds',
  'status',
  'firedAt',
  'stoppedBy',
]);

const NO_USAGE: UsageReading = { ok: false, reason: 'no node is online to read usage', windows: [], checkedAt: null, stale: false };

const CODE_REFUSED = 'that join code is wrong, used or expired; make a new one on the hub';

export interface HubNode {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  commit: string | null;
  startedAt?: string | null;
  processors?: number | null;
  timezone?: string | null;
  config: NodeConfig;
  firstSeenAt: string;
  lastSeenAt: string;
  instance: string | null;
  status: NodeStatus | null;
  /** Kept apart from the status so a node that signs off is still listed under its account. */
  account: ClaudeAccount | null;
  samples: SystemSample[];
  commands: NodeCommand[];
  /** What the node's build says it can do, from its last report. A node from before this list sends none. */
  features?: string[];
}

export type OnlineHubNode = HubNode & { status: NodeStatus };

export interface NodeListing {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  commit: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  startedAt: string | null;
  online: boolean;
  isDefault: boolean;
  isLocal: boolean;
  running: number;
  scheduled: number;
  queued: number;
  processors: number | null;
  clockTimezone: string | null;
  config: EffectiveNodeConfig;
  customized: Array<keyof NodeConfig>;
  /** The limit the node is enforcing now, as it reports it; null while it is offline. 0 is no limit. */
  concurrencyLimit: number | null;
  account: ClaudeAccount | null;
  usage: UsageReading;
  /** The newest machine sample, while the node is online. */
  latestSample: SystemSample | null;
  /** This node's metrics over their alert line. */
  exceptions: MachineException[];
  /** The job defaults this node sets itself; the rest follow the cluster's. */
  jobDefaultOverrides: JobDefaultsOverride;
}

export interface NodeDetail extends NodeListing {
  concurrency: ConcurrencyInfo | null;
  system: Record<string, unknown>;
}

export interface NodeSummary {
  id: string | null;
  name: string | null;
  online: boolean;
}

export type ForgetResult = { ok: true } | { ok: false; status: number; error: string };

interface JobsCache {
  at: number;
  crons: Cron[];
  executions: Execution[];
}

type ReportedEvent = BusEvent & { sample?: SystemSample; cronId?: string };

export class HubError extends Error {
  public status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}

function errorMessage(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function sum<T>(nodes: T[], read: (node: T) => unknown): number {
  return nodes.reduce((total, node) => total + (Number(read(node)) || 0), 0);
}

function sameSecret(given: unknown, expected: unknown): boolean {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

class Hub {
  private token: string | null;
  private version: string | null;
  private joinCodes: JoinCodes;
  public nodes: Map<string, HubNode>;
  private settings: Partial<Settings>;
  private pauseState: PauseState | null;
  private pauseTimer: ReturnType<typeof setTimeout> | null;
  public jobsCache: JobsCache | null;
  private saveTimer: ReturnType<typeof setTimeout> | null;
  private waiting: Map<string, (result: CommandResult) => void>;

  public constructor() {
    this.token = null;
    this.version = null;
    this.joinCodes = new JoinCodes(JOIN_CODES_FILE);
    this.nodes = new Map();
    this.settings = {};
    this.pauseState = null;
    this.pauseTimer = null;
    this.jobsCache = null;
    this.saveTimer = null;
    this.waiting = new Map();
  }

  public async start(settings: Settings): Promise<void> {
    this.settings = settings;
    this.token = await this.ensureToken();
    await this.loadNodes();
    bus.on('event', (event: BusEvent) => {
      if (event.type === 'crons:changed') this.jobsCache = null;
    });
  }

  public setSettings(settings: Settings): void {
    this.settings = settings;
  }

  /** The build or commit this hub runs, which it tells every node. */
  public setVersion(version: string | null): void {
    this.version = version;
  }

  /** A one-time code a new node trades for the token, for the join command. */
  public createJoinCode(): JoinCode {
    return this.joinCodes.create();
  }

  private async ensureToken(): Promise<string> {
    const fromEnv = process.env.PROMPTD_NODE_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    try {
      const existing = (await fsp.readFile(NODE_TOKEN_FILE, 'utf8')).trim();
      if (existing) return existing;
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
    }
    const token = randomBytes(32).toString('hex');
    await fsp.writeFile(NODE_TOKEN_FILE, `${token}\n`, { mode: 0o600 });
    console.log(`[hub] wrote a new node token to ${NODE_TOKEN_FILE}`);
    return token;
  }

  private async loadNodes(): Promise<void> {
    for (const saved of await db().selectFrom('nodes').selectAll().execute()) {
      this.nodes.set(saved.id, { ...saved, config: readNodeConfig(saved.settings), instance: null, status: null, account: null, samples: [], commands: [] });
    }
  }

  private async writeNodeConfig(node: HubNode, config: NodeConfig): Promise<void> {
    await db().updateTable('nodes').set({ settings: JSON.stringify(config) }).where('id', '=', node.id).execute();
    node.config = config;
  }

  public async setNodeConfig(id: string, patch: Record<string, unknown>): Promise<NodeListing> {
    const node = this.nodes.get(id);
    if (!node) throw new HubError('node not found', 404);
    const config = patchNodeConfig(node.config, patch);
    // Written first, applied second: the node picks its settings up from memory,
    // so a save that did not reach the database must not change what it runs.
    await this.writeNodeConfig(node, config);
    this.saveNodes();
    return this.listing(node);
  }

  private saveNodes(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const rows = [...this.nodes.values()].map(({ id, name, hostname, platform, commit, firstSeenAt, lastSeenAt, config }) => ({
        id,
        name,
        hostname,
        platform,
        commit,
        firstSeenAt,
        lastSeenAt,
        settings: JSON.stringify(config),
      }));
      if (!rows.length) return;
      db()
        .insertInto('nodes')
        .values(rows)
        .onConflict((conflict) =>
          conflict.column('id').doUpdateSet((eb) => ({
            name: eb.ref('excluded.name'),
            hostname: eb.ref('excluded.hostname'),
            platform: eb.ref('excluded.platform'),
            commit: eb.ref('excluded.commit'),
            lastSeenAt: eb.ref('excluded.lastSeenAt'),
            settings: eb.ref('excluded.settings'),
          })),
        )
        .execute()
        .catch((err: unknown) => console.error(`[hub] could not save the node list: ${errorMessage(err)}`));
    }, 1000);
    this.saveTimer.unref?.();
  }

  private isOnline(node: HubNode | undefined | null): node is OnlineHubNode {
    return Boolean(node?.status) && Date.now() - Date.parse(node!.lastSeenAt) < OFFLINE_AFTER_MS;
  }

  private onlineNodes(): OnlineHubNode[] {
    return [...this.nodes.values()].filter((node) => this.isOnline(node));
  }

  public defaultNodeId(): string {
    return this.settings.defaultNodeId || '';
  }

  private defaultNode(): OnlineHubNode | null {
    const node = this.nodes.get(this.defaultNodeId());
    return this.isOnline(node) ? node : null;
  }

  /** A node started with the hub on this machine, as a local install is. */
  private isLocal(node: HubNode): boolean {
    return Boolean(node.hostname) && node.hostname === os.hostname();
  }

  public nodeIsLocal(id: string): boolean {
    const node = this.nodes.get(id);
    return Boolean(node) && this.isLocal(node!);
  }

  /** The node a job with the given node id runs on; blank is the default node. */
  public resolveNodeId(id: string | null | undefined): string {
    return String(id ?? '').trim() || this.defaultNodeId();
  }

  public nodeConfig(id: string): EffectiveNodeConfig {
    const node = this.nodes.get(id);
    return effectiveNodeConfig(node?.config ?? {}, node?.processors ?? DEFAULT_MAX_CONCURRENT_JOBS, readJobDefaults(this.settings.jobDefaults));
  }

  /** What a job leaves to the defaults gets from the node it runs on. */
  public jobDefaultsFor(job: Cron | Execution): JobDefaults {
    return this.nodeConfig(this.nodeIdFor(job)).jobDefaults;
  }

  /** The zone a node's clock is set to, which a cron saved without one fires in. */
  public clockTimezone(id: string): string | null {
    return this.nodes.get(id)?.timezone ?? null;
  }

  private nodeIdFor(job: Cron | Execution): string {
    return job.nodeId || this.defaultNodeId();
  }

  private runsPrePromptCommands(node: HubNode): boolean {
    return Boolean(node.features?.includes(PRE_PROMPT_COMMANDS_FEATURE));
  }

  /**
   * Why a job is not being sent to its node, or null when it is. A node built
   * before commands ran ahead of the prompt would run the job without them,
   * so a job with any is held back from it until it is updated.
   */
  public withheld(job: Cron | Execution): string | null {
    const node = this.nodes.get(this.nodeIdFor(job));
    if (!this.isOnline(node) || this.runsPrePromptCommands(node)) return null;
    if (!resolveJob(job, this.nodeConfig(node.id).jobDefaults).prePromptCommands.length) return null;
    return `Node "${node.name}" runs a promptd too old to run commands before the prompt, so this job is not sent to it. Update the node, or give the job no commands.`;
  }

  public jobView(job: Cron | Execution): JobView | null {
    const node = this.nodes.get(this.nodeIdFor(job));
    if (!this.isOnline(node)) return null;
    return node.status.jobs?.[job.id] ?? null;
  }

  public nodeSummary(job: Cron | Execution): NodeSummary {
    const id = this.nodeIdFor(job);
    const node = this.nodes.get(id);
    return { id: id || null, name: node?.name ?? id ?? null, online: this.isOnline(node) };
  }

  /** How often a node samples its machine, which the alert rules count their windows in. */
  private sampleIntervalMs(node: HubNode): number {
    return Number(node.status?.system?.intervalMs) || SAMPLE_INTERVAL_MS || 5000;
  }

  private clusterNode(node: HubNode): ClusterNode {
    const online = this.isOnline(node);
    return {
      id: node.id,
      name: node.name,
      online,
      lastSeenAt: node.lastSeenAt ?? null,
      commit: node.commit,
      account: node.account,
      usage: online ? node.status.usage ?? null : null,
      running: online ? node.status.counts?.running ?? 0 : 0,
      concurrencyLimit: online ? Number(node.status.counts?.concurrencyLimit) || 0 : 0,
      thresholds: this.nodeConfig(node.id).usageDelayThresholds,
      waiting: online
        ? Object.values(node.status.jobs ?? {})
            .map((view) => view?.delayed ?? null)
            .filter((entry): entry is DelayEntry => entry !== null)
        : [],
      samples: node.samples,
      intervalMs: this.sampleIntervalMs(node),
    };
  }

  /** The default node first, then by name: the order every list of nodes is shown in. */
  private orderedNodes(): HubNode[] {
    const defaultId = this.defaultNodeId();
    return [...this.nodes.values()].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId) || a.name.localeCompare(b.name));
  }

  /** What the header draws: nodes, jobs, one entry per account, and what is out of line. */
  public cluster(hubCommit: string | null): ClusterSummary {
    return clusterSummary(this.orderedNodes().map((node) => this.clusterNode(node)), hubCommit);
  }

  private listing(node: HubNode): NodeListing {
    const online = this.isOnline(node);
    return {
      id: node.id,
      name: node.name,
      hostname: node.hostname,
      platform: node.platform,
      commit: node.commit,
      firstSeenAt: node.firstSeenAt,
      lastSeenAt: node.lastSeenAt,
      startedAt: node.startedAt ?? null,
      online,
      isDefault: node.id === this.defaultNodeId(),
      isLocal: this.isLocal(node),
      running: online ? node.status.counts?.running ?? 0 : 0,
      scheduled: online ? node.status.counts?.scheduled ?? 0 : 0,
      queued: online ? node.status.counts?.queued ?? 0 : 0,
      processors: node.processors ?? null,
      clockTimezone: node.timezone ?? null,
      config: this.nodeConfig(node.id),
      customized: Object.keys(node.config) as Array<keyof NodeConfig>,
      concurrencyLimit: online ? Number(node.status.counts?.concurrencyLimit) || 0 : null,
      account: node.account,
      usage: online ? node.status.usage ?? NO_USAGE : { ...NO_USAGE, reason: 'this node is offline' },
      latestSample: online ? node.samples.at(-1) ?? node.status.system?.latest ?? null : null,
      exceptions: machineExceptions([this.clusterNode(node)]),
      jobDefaultOverrides: node.config.jobDefaults ?? {},
    };
  }

  public listNodes(): NodeListing[] {
    return this.orderedNodes().map((node) => this.listing(node));
  }

  public nodeDetail(id: string): NodeDetail | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    const online = this.isOnline(node);
    return {
      ...this.listing(node),
      concurrency: online ? this.concurrencyInfo(id) : null,
      system: this.systemOf(online ? node : null),
    };
  }

  public forgetNode(id: string): ForgetResult {
    const node = this.nodes.get(id);
    if (!node) return { ok: false, status: 404, error: 'node not found' };
    if (this.isOnline(node)) return { ok: false, status: 409, error: 'this node is online; stop it before removing it' };
    this.nodes.delete(id);
    db()
      .deleteFrom('nodes')
      .where('id', '=', id)
      .execute()
      .catch((err: unknown) => console.error(`[hub] could not remove node "${id}": ${errorMessage(err)}`));
    return { ok: true };
  }

  public isRunningLog(jobId: string, file: string): boolean {
    return this.onlineNodes().some((node) => node.status.activeLogs?.some((log) => log.jobId === jobId && log.file === file));
  }

  public command(nodeId: string, type: NodeCommandType, jobId: string | null = null, args?: Record<string, unknown>): NodeCommand | null {
    const node = this.nodes.get(nodeId);
    if (!this.isOnline(node)) return null;
    const command: NodeCommand = { id: randomUUID(), type, jobId, at: new Date().toISOString(), ...(args ? { args } : {}) };
    node.commands.push(command);
    return command;
  }

  /** Sends a command and waits for the node's next report to answer it. */
  private ask(nodeId: string, type: NodeCommandType, args: Record<string, unknown>, timeoutMs: number): Promise<CommandResult> {
    const command = this.command(nodeId, type, null, args);
    if (!command) return Promise.reject(new HubError('that node is offline', 409));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(command.id);
        reject(new HubError('the node did not answer in time', 504));
      }, timeoutMs);
      timer.unref?.();
      this.waiting.set(command.id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /** Folder suggestions from the machine the job runs on. The hub's own disk answers for a node beside it. */
  public async browse(nodeId: string, typed: string): Promise<BrowseResult> {
    const node = this.nodes.get(nodeId);
    if (!node || this.isLocal(node)) return browseDirectories(typed);
    const answer = await this.ask(nodeId, 'browse', { path: typed }, BROWSE_WAIT_MS);
    if (!answer.ok) throw new HubError(answer.error ?? 'the node could not list folders', 502);
    return answer.result as unknown as BrowseResult;
  }

  /**
   * Asks the job's node for a title from claude, and puts it in place of the
   * name taken from the prompt, if that is still the job's name when it comes.
   * Waits on nothing and never fails the caller: when the node is offline, the
   * call fails, or the answer is not a title, the first words stay.
   */
  public requestTitle(kind: JobKind, job: Cron | Execution): void {
    const askedName = job.name;
    this.ask(this.nodeIdFor(job), 'title', { prompt: job.prompt.slice(0, TITLE_PROMPT_LIMIT) }, TITLE_WAIT_MS)
      .then(async (answer) => {
        const title = answer.ok ? cleanTitle(answer.result?.title) : null;
        if (!title) return;
        if (await applyInferredTitle(kind, job.id, { askedName, prompt: job.prompt, title })) this.jobsChanged();
      })
      .catch((err: unknown) => {
        if (!(err instanceof HubError)) console.error(`[hub] could not title "${askedName}": ${errorMessage(err)}`);
      });
  }

  public jobsChanged(): void {
    this.jobsCache = null;
    emit('crons:changed');
  }

  private async allJobs(): Promise<JobsCache> {
    if (this.jobsCache && Date.now() - this.jobsCache.at < JOBS_CACHE_MS) return this.jobsCache;
    const [crons, executions] = await Promise.all([listCrons(), listExecutions()]);
    this.jobsCache = { at: Date.now(), crons, executions };
    return this.jobsCache;
  }


  private hasToken(req: express.Request): boolean {
    const header = String(req.get('authorization') ?? '');
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    return Boolean(given && this.token) && sameSecret(given, this.token);
  }

  /** The node API. `build` is what a node downloads promptd from, or null when this hub has none to give. */
  public router(build: NodeBuild | null = null): express.Router {
    const router = express.Router();
    router.use(express.json({ limit: '20mb' }));
    // A new node has no token yet: it trades a join code for one.
    router.post('/pair', (req, res) => {
      if (!this.token || !this.joinCodes.redeem(String((req.body as { code?: unknown })?.code ?? ''))) {
        return res.status(401).json({ error: CODE_REFUSED });
      }
      res.json({ token: this.token });
    });
    // The installer downloads promptd with the join code, which stays good for
    // the node to pair with; a node following the hub's build uses its token.
    router.get('/build', (req, res, next) => {
      if (!build) return sendNoBuild(res);
      const { code } = req.query;
      if (!this.hasToken(req) && !(typeof code === 'string' && this.joinCodes.check(code))) {
        return res.status(401).json({ error: typeof code === 'string' ? CODE_REFUSED : 'invalid node token' });
      }
      sendBuild(res, build).catch(next);
    });
    router.use((req, res, next) => {
      if (!this.hasToken(req)) return res.status(401).json({ error: 'invalid node token' });
      next();
    });
    router.post('/report', (req, res, next) => {
      this.ingest(req.body ?? {})
        .then((answer) => res.json(answer))
        .catch((err: unknown) => (err instanceof HubError ? res.status(err.status).json({ error: err.message }) : next(err)));
    });
    router.post('/leave', (req, res) => {
      const node = this.nodes.get(String(req.get('x-promptd-node') ?? ''));
      if (node && node.instance === String(req.get('x-promptd-instance') ?? '')) {
        node.status = null;
        node.instance = null;
        console.log(`[hub] node "${node.id}" signed off`);
      }
      res.json({ ok: true });
    });
    // For `promptd join-command` on the hub's machine, which holds the token already.
    router.post('/join-codes', (_req, res) => res.json(this.joinCodes.create()));
    router.get('/work', (req, res, next) => {
      this.work(String(req.get('x-promptd-node') ?? ''), String(req.get('x-promptd-instance') ?? ''))
        .then((work) => res.json(work))
        .catch((err: unknown) => (err instanceof HubError ? res.status(err.status).json({ error: err.message }) : next(err)));
    });
    return router;
  }

  private claim(input: unknown): HubNode {
    const identity = asRecord(input);
    const id = String(identity?.id ?? '').trim();
    const instance = String(identity?.instance ?? '').trim();
    if (!id || !instance) throw new HubError('node id and instance are required', 400);
    const now = new Date().toISOString();
    let node = this.nodes.get(id);
    if (node && this.isOnline(node) && node.instance && node.instance !== instance) {
      throw new HubError(`another process is already syncing as node "${id}"; give this one its own PROMPTD_NODE_ID`, 409);
    }
    if (!node) {
      node = { id, firstSeenAt: now, config: {}, instance: null, status: null, account: null, samples: [], commands: [] } as unknown as HubNode;
      this.nodes.set(id, node);
      console.log(`[hub] new node "${identity!.name ?? id}" (${id})`);
    }
    if (node.instance !== instance) {
      if (node.instance) console.log(`[hub] node "${id}" restarted`);
      node.samples = [];
      // The previous process may have carried these out without living to report it.
      const bornAt = Date.parse((identity!.startedAt ?? '') as string) || Date.now();
      node.commands = node.commands.filter((command) => Date.parse(command.at) > bornAt);
    }
    Object.assign(node, {
      name: String(identity!.name ?? id),
      hostname: (identity!.hostname ?? null) as string | null,
      platform: (identity!.platform ?? null) as string | null,
      commit: (identity!.commit ?? null) as string | null,
      startedAt: (identity!.startedAt ?? null) as string | null,
      processors: Number(identity!.processors) || null,
      timezone: typeof identity!.timezone === 'string' && identity!.timezone ? identity!.timezone : null,
      features: Array.isArray(identity!.features) ? identity!.features.filter((feature): feature is string => typeof feature === 'string') : [],
      instance,
      lastSeenAt: now,
    });
    this.saveNodes();
    return node;
  }

  private async ingest(body: Record<string, unknown>): Promise<{ ok: true; logOffsets: Record<string, number> }> {
    const node = this.claim(body.node);
    if (!this.defaultNodeId()) {
      this.settings = await patchSettings({ defaultNodeId: node.id });
      console.log(`[hub] "${node.name}" is the default node`);
    }

    const logOffsets: Record<string, number> = {};
    for (const chunk of (Array.isArray(body.logs) ? body.logs : []) as LogChunk[]) {
      const key = `${chunk.jobId}/${chunk.file}`;
      logOffsets[key] = await this.writeLogChunk(chunk).catch((err: unknown) => {
        console.error(`[hub] could not store log ${key} from "${node.id}": ${errorMessage(err)}`);
        return chunk.offset;
      });
    }

    const previous = node.status;
    node.status = (body.status as NodeStatus | null | undefined) ?? node.status;
    // A node older than the field says nothing, which is not the same as saying it is signed out.
    const reported = asRecord(body.status);
    if (reported && 'account' in reported) node.account = reportedAccount(reported.account);
    await this.applyPatches(node, Array.isArray(body.patches) ? body.patches : [], previous);

    const answered = new Set(((Array.isArray(body.commandResults) ? body.commandResults : []) as CommandResult[]).map((result) => result.id));
    for (const result of (body.commandResults ?? []) as CommandResult[]) {
      const waiter = this.waiting.get(result.id);
      if (waiter) {
        this.waiting.delete(result.id);
        waiter(result);
      } else if (!result.ok) console.error(`[hub] node "${node.id}" could not carry out a command: ${result.error}`);
    }
    const cutoff = Date.now() - COMMAND_TTL_MS;
    node.commands = node.commands.filter((command) => !answered.has(command.id) && Date.parse(command.at) > cutoff);

    let queueChanged = false;
    for (const event of (Array.isArray(body.events) ? body.events : []) as ReportedEvent[]) {
      if (event?.type === 'pause:changed') continue;
      if (event?.type === 'queue:changed') {
        queueChanged = true;
        continue;
      }
      // Every node's samples go out, tagged with the node below: its own page charts them live.
      if (event?.type === 'system:sample') {
        node.samples.push(event.sample as SystemSample);
        const oldest = Date.now() - HISTORY_WINDOW_MS;
        while (node.samples.length && Date.parse(node.samples[0]!.at) < oldest) node.samples.shift();
      }
      if (event?.type === 'run:finished' && event.cronId) {
        pruneLogs(event.cronId).catch((err: unknown) => console.error(`[hub] log cleanup failed for ${event.cronId}: ${errorMessage(err)}`));
      }
      bus.emit('event', { ...event, nodeId: node.id, nodeName: node.name });
    }
    if (queueChanged) emit('queue:changed', { ...this.concurrencyInfo() });
    return { ok: true, logOffsets };
  }

  /**
   * Writes one chunk at the offset the node says it starts at, and answers what
   * the hub now holds. A retry of a chunk already written lands on the same
   * bytes; a chunk past the end is refused, and the answer rewinds the node.
   */
  public async writeLogChunk({ jobId, file, offset, data }: LogChunk): Promise<number> {
    const target = logPath(String(jobId), String(file));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const size = await fsp
      .stat(target)
      .then((stat) => stat.size)
      .catch(() => 0);
    const start = Number(offset);
    if (!Number.isInteger(start) || start < 0 || start > size) return size;
    const bytes = Buffer.from(String(data ?? ''), 'base64');
    const handle = await fsp.open(target, size === 0 ? 'w' : 'r+');
    try {
      await handle.write(bytes, 0, bytes.length, start);
      await handle.truncate(start + bytes.length);
    } finally {
      await handle.close();
    }
    return start + bytes.length;
  }

  /**
   * Only run bookkeeping, and only for jobs this node runs or was running: a node
   * holds a token, not the right to rewrite another machine's prompts.
   */
  private async applyPatches(node: HubNode, patches: JobPatch[], previousStatus: NodeStatus | null): Promise<void> {
    if (!patches.length) return;
    const { crons, executions } = await this.allJobs();
    const owned = new Set(
      [...crons, ...executions].filter((job) => this.nodeIdFor(job) === node.id).map((job) => job.id),
    );
    for (const status of [previousStatus, node.status]) {
      for (const id of Object.keys(status?.jobs ?? {})) owned.add(id);
    }
    let wrote = false;
    for (const entry of patches) {
      if (!owned.has(entry?.id)) continue;
      const fields: Partial<Cron & Execution> = Object.fromEntries(Object.entries(entry.patch ?? {}).filter(([key]) => BOOKKEEPING_FIELDS.has(key)));
      if ('status' in fields && !(STATUSES as readonly unknown[]).includes(fields.status)) delete fields.status;
      // The node's copy can be a sync behind: a date saved on the hub mid-run has
      // already put the record back to scheduled, and closing it would undo that.
      if (entry.kind === 'execution' && fields.status === 'done') {
        const current = await getExecution(entry.id).catch(() => null);
        if (current && current.status !== 'running') {
          delete fields.status;
          delete fields.stoppedBy;
        }
      }
      if (!Object.keys(fields).length) continue;
      const write = entry.kind === 'execution' ? patchExecution : patchCron;
      await write(entry.id, fields).catch((err: unknown) => console.error(`[hub] could not record ${entry.id} from "${node.id}": ${errorMessage(err)}`));
      wrote = true;
    }
    if (wrote) this.jobsCache = null;
  }

  /**
   * A node's jobs and settings. Each job goes out with every setting it leaves
   * to the defaults already filled in from this node's, so a node runs exactly
   * what it is sent, whatever version it is: one from before job defaults
   * existed would read a null as off. The stored nulls stay in the database
   * and the API; a changed default reaches the node as changed jobs. A job
   * with commands before the prompt is left out for a node that cannot run
   * them, which disarms it there rather than running it without them.
   */
  private async work(nodeId: string, instance: string): Promise<{
    node: { id: string; isDefault: boolean };
    crons: RunnableCron[];
    executions: RunnableExecution[];
    settings: NodeSettings;
    pause: PauseState | null;
    commands: NodeCommand[];
    hubVersion: string | null;
  }> {
    const node = this.nodes.get(nodeId);
    if (!node || node.instance !== instance) {
      throw new HubError('report before asking for work', 409);
    }
    const { crons, executions } = await this.allJobs();
    const mine = (job: Cron | Execution): boolean => this.nodeIdFor(job) === node.id;
    const config = this.nodeConfig(node.id);
    // An older node would ignore a job's commands and run it without them; see `withheld`.
    const runnable = (job: RunnableCron | RunnableExecution): boolean => !job.prePromptCommands.length || this.runsPrePromptCommands(node);
    const commands = node.commands.slice();
    return {
      node: { id: node.id, isDefault: node.id === this.defaultNodeId() },
      crons: crons.filter(mine).map((cron) => resolveJob(cron, config.jobDefaults)).filter(runnable),
      executions: executions.filter(mine).map((execution) => resolveJob(execution, config.jobDefaults)).filter(runnable),
      settings: {
        maxConcurrentJobs: node.config.maxConcurrentJobs ?? null,
        usageDelayThresholds: config.usageDelayThresholds,
        defaultWorktreeInclude: this.settings.defaultWorktreeInclude ?? '',
        retrospectivePrompt: this.settings.retrospectivePrompt ?? '',
      },
      pause: this.pauseState,
      commands,
      hubVersion: this.version,
    };
  }


  public isPaused(): boolean {
    return this.pauseState !== null;
  }

  public isPausedForUpdate(): boolean {
    return this.pauseState?.mode === 'update';
  }

  public runningCount(): number {
    return sum(this.onlineNodes(), (node) => node.status.counts?.running);
  }

  /** True once every online node has fetched the pause and stopped starting runs. */
  public everyNodeHolding(): boolean {
    return this.onlineNodes().every((node) => node.status.pause?.paused);
  }

  public pauseInfo(): PauseInfo {
    const nodes = this.onlineNodes();
    const runningCount = this.runningCount();
    if (!this.pauseState) {
      return { paused: false, mode: null, label: null, badge: null, until: null, startedAt: null, remainingMs: null, cancellable: false, runningCount, droppedCount: 0 };
    }
    const { mode, label, option, startedAt, until } = this.pauseState;
    return {
      paused: true,
      mode,
      option,
      label,
      badge: `Paused ${label}`,
      startedAt,
      until,
      remainingMs: until ? Math.max(0, Date.parse(until) - Date.now()) : null,
      cancellable: mode === 'manual',
      runningCount,
      droppedCount: sum(nodes, (node) => (node.status.pause?.paused ? node.status.pause.droppedCount : 0)),
    };
  }

  public async pauseAll({
    mode = 'manual',
    label,
    option = null,
    ms = null,
  }: {
    mode?: PauseState['mode'];
    label: string;
    option?: string | null;
    ms?: number | null;
  }): Promise<PauseInfo> {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const startedAt = new Date();
    this.pauseState = {
      mode,
      label,
      option,
      startedAt: startedAt.toISOString(),
      until: ms ? new Date(startedAt.getTime() + ms).toISOString() : null,
    };
    if (ms) {
      this.pauseTimer = setTimeout(() => {
        this.resumeAll('timer expired').catch((err: unknown) => console.error(`[hub] resume failed: ${errorMessage(err)}`));
      }, ms);
      this.pauseTimer.unref?.();
    }
    console.log(`[hub] paused ${label} (${mode})`);
    emit('pause:changed', { ...this.pauseInfo() });
    return this.pauseInfo();
  }

  public async resumeAll(reason = 'cancelled'): Promise<PauseInfo> {
    if (!this.pauseState) return this.pauseInfo();
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const previous = this.pauseState;
    this.pauseState = null;
    console.log(`[hub] resumed after "${previous.label}" pause (${reason})`);
    // What kind of pause ended, which the pause info no longer says once it has.
    emit('pause:changed', { ...this.pauseInfo(), resumedFrom: previous.label, resumedMode: previous.mode, reason });
    return this.pauseInfo();
  }


  /** Each node enforces its own limit, so the fleet's is their total, or none when any node has none. */
  private concurrencyLimit(nodes: OnlineHubNode[] = this.onlineNodes()): number {
    if (!nodes.length) return DEFAULT_MAX_CONCURRENT_JOBS;
    return clusterLimit(nodes.map((node) => Number(node.status.counts?.concurrencyLimit) || 0));
  }

  public health(hubCommit: string | null = null): {
    scheduled: number;
    running: number;
    paused: boolean;
    delayed: number;
    queued: number;
    usageDelayed: number;
    concurrencyLimit: number;
    armedCrons: number;
    armedExecutions: number;
    usage: UsageReading;
    nodes: { total: number; online: number };
    cluster: ClusterSummary;
  } {
    const nodes = this.onlineNodes();
    const count = (key: keyof NodeCounts): number => sum(nodes, (node) => node.status.counts?.[key]);
    return {
      scheduled: count('scheduled'),
      running: count('running'),
      paused: this.isPaused(),
      delayed: count('delayed'),
      queued: count('queued'),
      usageDelayed: count('usageDelayed'),
      concurrencyLimit: this.concurrencyLimit(nodes),
      armedCrons: count('armedCrons'),
      armedExecutions: count('armedExecutions'),
      usage: this.defaultNode()?.status.usage ?? NO_USAGE,
      nodes: { total: this.nodes.size, online: nodes.length },
      cluster: this.cluster(hubCommit),
    };
  }

  public concurrencyInfo(nodeId: string | null = null): ConcurrencyInfo {
    const nodes = this.onlineNodes().filter((node) => !nodeId || node.id === nodeId);
    const infos = nodes.map((node): { node: OnlineHubNode; info: Partial<ConcurrencyInfo> } => ({ node, info: node.status.concurrency ?? {} }));
    const tag =
      (node: OnlineHubNode) =>
      <T extends object>(row: T): T & { nodeId: string; nodeName: string } => ({ ...row, nodeId: node.id, nodeName: node.name });
    const slots = infos.map(({ info }) => info.nextSlotAt).filter(Boolean).sort();
    return {
      limit: this.concurrencyLimit(nodes),
      defaultLimit: (nodeId && this.nodes.get(nodeId)?.processors) || DEFAULT_MAX_CONCURRENT_JOBS,
      runningCount: sum(infos, ({ info }) => info.runningCount),
      queuedCount: sum(infos, ({ info }) => info.queuedCount),
      usageDelayedCount: sum(infos, ({ info }) => info.usageDelayedCount),
      armedCrons: sum(infos, ({ info }) => info.armedCrons),
      armedExecutions: sum(infos, ({ info }) => info.armedExecutions),
      nextSlotAt: slots[0] ?? null,
      running: infos.flatMap(({ node, info }) => (info.running ?? []).map(tag(node))),
      queued: infos.flatMap(({ node, info }) => (info.queued ?? []).map(tag(node))),
    };
  }

  /** The default node's machine stats, which /api/system has always answered with. */
  public systemState(): Record<string, unknown> {
    return this.systemOf(this.defaultNode());
  }

  /** One node's machine stats and the window the hub has kept of its samples, for the charts on its page. */
  private systemOf(node: OnlineHubNode | null): Record<string, unknown> {
    if (!node?.status.system) {
      return {
        enabled: false,
        intervalMs: SAMPLE_INTERVAL_MS,
        windowMs: HISTORY_WINDOW_MS,
        metrics: SYSTEM_METRICS,
        host: null,
        detail: {},
        notes: {},
        latest: null,
        samples: [],
      };
    }
    return { ...node.status.system, latest: node.samples.at(-1) ?? node.status.system.latest ?? null, samples: node.samples };
  }

  public models(): ModelCatalogState {
    return this.defaultNode()?.status.models ?? { models: [], discoveredAt: null, loading: false, error: 'no node is online to ask' };
  }

  public async refreshModels(): Promise<ModelCatalogState> {
    const before = this.models().discoveredAt;
    for (const node of this.onlineNodes()) this.command(node.id, 'refreshModels');
    const deadline = Date.now() + MODEL_REFRESH_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const state = this.models();
      if (!state.loading && state.discoveredAt !== before) return state;
      if (!this.defaultNode()) break;
    }
    return this.models();
  }
}

export const hub = new Hub();
