import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { bus, sseInit, sseSend } from './events.js';
import { assertAuthConfigured, authRouter, requireLogin } from './auth.js';
import { databaseTarget, migrate, openDatabase } from './db.js';
import { LOGS_DIR, NODE_TOKEN_FILE, ROOT, ensureDirs } from './paths.js';
import { EFFORT_LEVELS, PAUSE_OPTIONS, isTimeZone, pauseOption, previewNextRun, validateCronExpression } from './schedule.js';
import { HubError, hub } from './hub.js';
import { joinCommand, joinUrl } from './join.js';
import { SYSTEM_METRICS } from './system.js';
import { sendPublicFile, sendSharedModule, servePublic } from './publicFiles.js';
import { BINARY_REPO } from './binary.js';
import { ownBuild, serveInstaller } from './nodeBuild.js';
import { NodeConfigError } from './nodeConfig.js';
import {
  PAGE_SIZE as EXECUTIONS_PAGE_SIZE,
  createExecution,
  deleteExecution,
  getExecution,
  pageExecutions,
  patchExecution,
  updateExecution,
} from './executions.js';
import { readCronForm, readExecutionForm, withEffective } from './jobForms.js';
import { JobDefaultsError, patchJobDefaults } from './jobDefaults.js';
import { feedbackExecution, readFeedbackForm } from './feedback.js';
import { createProject, deleteProject, getProject, listProjects, updateProject } from './projects.js';
import { DEFAULT_MAX_CONCURRENT_JOBS, loadSettings, patchSettings } from './settings.js';
import { checkForUpdates, currentCommit, selfUpdater, UPDATE_LOG, PROJECT_DIR } from './updater.js';
import { usageDelayOptions } from './usage.js';
import { lifetimeStats } from './stats.js';
import { MAX_NOTIFICATIONS, PAGE_SIZE, isLevel, notificationCenter } from './notifications.js';
import { activityView, byActivity, jobActivity, readRequests } from './jobActivity.js';
import type { JobActivityTable } from './db.js';
import {
  MAX_LOGS_PER_CRON,
  createCron,
  deleteCron,
  filterLogs,
  getCron,
  listCrons,
  listLogs,
  logPath,
  readLog,
  retrospectiveLogs,
  updateCron,
} from './store.js';
import { DEFAULT_RETROSPECTIVE_PROMPT } from './retrospective.js';
import type { BusEvent, Cron, Execution, JobKind, ProjectInput, Settings } from './types.js';

/** When this process came up, which is what the Settings page calls the last boot. */
const STARTED_AT = new Date().toISOString();

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const SELF_UPDATE = process.env.PROMPTD_SELF_UPDATE !== '0';

type JsonRequest = Request<Record<string, string>, unknown, Record<string, unknown>>;

type JobRequest = Request<{ kind: string; id: string }>;

type JobLogRequest = Request<{ kind: string; id: string; file: string }>;

interface FoundRecord {
  record: Cron | Execution;
  kind: JobKind;
  view(record: Cron | Execution, activity?: JobActivityTable): object;
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}

function errorMessage(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined;
}

const app = express();
// Behind a reverse proxy every request arrives from the proxy, which would
// put all sign-in attempts under one address and hide that the visitor used HTTPS.
const trustProxy = process.env.PROMPTD_TRUST_PROXY?.trim();
if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
/** What this hub's nodes install and update from: its own executable, when it is a binary for Apple silicon. */
const nodeBuild = await ownBuild();
// Ahead of the page's body parser: a node's report carries log bytes and outgrows its limit.
app.use('/api/node', hub.router(nodeBuild));
// Ahead of the login too, as the release it stands in for is: the build it fetches needs a join code.
app.get(
  '/install.sh',
  serveInstaller(nodeBuild, async (req) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    // The address Add a Mac would give, else the one the Mac asking reached the hub by.
    return (await joinUrl({ host: HOST, port: PORT, origin })) ?? origin;
  }),
);
app.use(authRouter());
app.use(requireLogin());
app.get('/login', (_req, res) => sendPublicFile(res, 'login.html'));
app.use(express.json({ limit: '1mb' }));
app.use(servePublic());
// Rules the job form shares with the hub, compiled from src/naming.ts and
// src/jobFormRules.ts: the name a blank Name will get, and what a save sends.
app.get('/shared/:module(naming|jobFormRules).js', (req, res) => sendSharedModule(res, req.params.module!));

async function checkProject(projectId: string | null, errors: string[]): Promise<void> {
  if (projectId && !(await getProject(projectId))) errors.push('That project no longer exists.');
}

function readProjectForm(body: Record<string, unknown> | undefined): { errors: string[]; value: ProjectInput } {
  const name = String(body?.name ?? '').trim();
  const errors: string[] = [];
  if (!name) errors.push('Name is required.');
  if (name.length > 120) errors.push('Name must be 120 characters or fewer.');
  return { errors, value: { name, description: String(body?.description ?? '').trim() } };
}

/** `activity` is the job's row of updates, when it has one. */
function decorate(cron: Cron, activity?: JobActivityTable) {
  const view = hub.jobView(cron);
  return {
    ...withEffective(cron, hub.jobDefaultsFor(cron)),
    node: hub.nodeSummary(cron),
    nextRunAt: view?.nextRunAt ?? null,
    isRunning: Boolean(view?.currentRun),
    currentRun: view?.currentRun ?? null,
    isDelayed: Boolean(view?.delayed),
    delayed: view?.delayed ?? null,
    delayRisk: view?.delayRisk ?? null,
    activity: activityView(cron, activity),
  };
}

/**
 * One execution, as the page draws it. `nextRunAt` is the schedule it is still
 * waiting on, so a record that has already run — or been cancelled — reports
 * none, whatever its date says.
 */
function decorateExecution(execution: Execution, activity?: JobActivityTable) {
  const view = hub.jobView(execution);
  const armed = execution.isActive && execution.status === 'scheduled';
  return {
    ...withEffective(execution, hub.jobDefaultsFor(execution)),
    kind: 'execution',
    node: hub.nodeSummary(execution),
    nextRunAt: armed ? execution.scheduledAt : null,
    // Its time has passed and nothing has run it. On the page that is the gap
    // between the trigger being missed and the catch-up starting the run.
    isOverdue: armed && Date.parse(execution.scheduledAt ?? '') <= Date.now(),
    isRunning: Boolean(view?.currentRun),
    currentRun: view?.currentRun ?? null,
    isDelayed: Boolean(view?.delayed),
    delayed: view?.delayed ?? null,
    delayRisk: view?.delayRisk ?? null,
    activity: activityView(execution, activity),
  };
}

/** Executions in the Activity sort's order, judged on what the page draws for each. */
function rankExecutions(all: Execution[], activity: Map<string, JobActivityTable>): Execution[] {
  const views = new Map(all.map((execution) => [execution.id, decorateExecution(execution, activity.get(execution.id))]));
  return [...all].sort((a, b) => byActivity(views.get(a.id)!, views.get(b.id)!));
}

/** What the route was asked about, for an error message a person reads. */
function noun(req: Request): string {
  return req.params.kind === 'executions' ? 'execution' : 'cron';
}

/** Either kind by id, with the routes and helpers each one needs. */
async function findRecord(id: string): Promise<FoundRecord | null> {
  const cron = await getCron(id);
  if (cron) return { record: cron, kind: 'cron', view: decorate };
  const execution = await getExecution(id);
  if (execution) return { record: execution, kind: 'execution', view: decorateExecution };
  return null;
}

app.get('/api/config', (_req, res) => {
  res.json({
    storageRoot: ROOT,
    database: databaseTarget(),
    logsDir: LOGS_DIR,
    maxLogsPerCron: MAX_LOGS_PER_CRON,
    maxNotifications: MAX_NOTIFICATIONS,
    effortLevels: EFFORT_LEVELS,
    // Each with the default node's threshold, which the form draws next to its label.
    usageDelayCategories: usageDelayOptions(hub.nodeConfig(hub.defaultNodeId()).usageDelayThresholds),
    // Off in the container image, where the hub is shipped rather than pulled.
    selfUpdate: SELF_UPDATE,
  });
});

/**
 * One page of notifications, newest first. `before` is the id of the last one
 * already shown rather than an offset: new notices arrive while the list is
 * open, and an offset would show one of them a second time.
 */
app.get('/api/notifications', async (req, res, next) => {
  try {
    const before = String(req.query.before ?? '').trim() || null;
    // `?unread=1` is the drawer's filter: the same pages with the read ones left out.
    const unreadOnly = ['1', 'true', 'yes'].includes(String(req.query.unread ?? '').toLowerCase());
    // `?level=` is one of the drawer's sections, and `?node=` one machine's records.
    const level = isLevel(req.query.level) ? req.query.level : null;
    const node = String(req.query.node ?? '').trim() || null;
    res.json(await notificationCenter.page({ before, limit: req.query.limit ?? PAGE_SIZE, unreadOnly, level, node, nodes: hub.listNodes() }));
  } catch (err) {
    next(err);
  }
});

/**
 * Marks what the reader has actually had on screen. Body `{"ids":[...]}`, or
 * `{"all":true}` for the drawer's "Mark all read" button.
 */
app.post('/api/notifications/read', async (req: JsonRequest, res, next) => {
  try {
    if (req.body?.all === true) return res.json(await notificationCenter.markAllRead());
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
    // What each row's count was when it was seen. Without it nothing is marked:
    // the row may have changed since, and only Mark all read reads it regardless.
    const revisions = req.body?.revisions;
    if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) {
      return res.status(400).json({ error: 'revisions must give the count each id had when it was seen' });
    }
    res.json(await notificationCenter.markRead(ids, revisions as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
});

/** Which jobs have updates nobody has looked at yet: a count per kind, and the revision each is at. */
app.get('/api/job-activity', async (_req, res, next) => {
  try {
    res.json(await jobActivity.summary());
  } catch (err) {
    next(err);
  }
});

/**
 * Marks jobs read. Body `{"items":[{"id":"...","revision":3}]}`, each with the
 * revision the page showed it at: a job that has had an update since stays unread.
 */
app.post('/api/job-activity/read', async (req: JsonRequest, res, next) => {
  try {
    const parsed = readRequests(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    res.json(await jobActivity.markRead(parsed.items));
  } catch (err) {
    next(err);
  }
});

/** The default node's machine stats, from its reports. */
app.get('/api/system', (_req, res) => {
  res.json(hub.systemState());
});

/** Every node with its account, usage and latest machine sample, and the cluster grouped by account: all the header's panel draws. */
app.get('/api/nodes', (_req, res) => {
  res.json({
    nodes: hub.listNodes(),
    cluster: hub.cluster(runningCommit),
    // The machine columns, named and formatted the way the node pages chart them.
    metrics: SYSTEM_METRICS,
    defaultNodeId: hub.defaultNodeId(),
    hubCommit: runningCommit,
    tokenSource: process.env.PROMPTD_NODE_TOKEN?.trim() ? 'environment' : 'file',
    tokenFile: NODE_TOKEN_FILE,
  });
});

/** A fresh join code, and the command that adds another Mac as a node with it and the address it should use. */
app.post('/api/join', async (req, res, next) => {
  try {
    const hubUrl = await joinUrl({ host: HOST, port: PORT, origin: `${req.protocol}://${req.get('host')}` });
    const { code, expiresAt } = hub.createJoinCode();
    const command = joinCommand(hubUrl ?? '<hub-address>', code, { servesBuild: Boolean(nodeBuild), repo: BINARY_REPO });
    res.json({ hubUrl, port: PORT, code, expiresAt, fromCheckout: !BINARY_REPO, command });
  } catch (err) {
    next(err);
  }
});

app.get('/api/nodes/:id', (req, res) => {
  const detail = hub.nodeDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'node not found' });
  res.json({ ...detail, hubCommit: runningCommit });
});

/** A node's own job limit, usage thresholds, default working directory and job defaults. Null resets one to the node's default. */
app.put('/api/nodes/:id/settings', async (req: JsonRequest, res, next) => {
  try {
    res.json(await hub.setNodeConfig(String(req.params.id), (req.body ?? {}) as Record<string, unknown>));
  } catch (err) {
    if (err instanceof HubError) return res.status(err.status).json({ error: err.message });
    if (err instanceof NodeConfigError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

app.delete('/api/nodes/:id', (req, res) => {
  const result = hub.forgetNode(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

/** Folder suggestions for the Working Directory field, from the machine `node` names (blank is the default node). */
app.get('/api/browse', async (req, res, next) => {
  try {
    res.json(await hub.browse(hub.resolveNodeId(String(req.query.node ?? '')), String(req.query.path ?? '')));
  } catch (err) {
    if (err instanceof HubError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    res.json({
      ...(await loadSettings()),
      // What a blank Retrospective prompt runs, so the page can show it.
      defaultRetrospectivePrompt: DEFAULT_RETROSPECTIVE_PROMPT,
      database: databaseTarget(),
      projectDir: PROJECT_DIR,
      updateLog: UPDATE_LOG,
    });
  } catch (err) {
    next(err);
  }
});

/** Only the documented settings are writable; everything else stays as it is on disk. */
app.put('/api/settings', async (req: JsonRequest, res, next) => {
  try {
    const patch: Partial<Settings> = {};
    if ('serverName' in (req.body ?? {})) {
      if (typeof req.body.serverName !== 'string') return res.status(400).json({ error: 'serverName must be a string' });
      patch.serverName = req.body.serverName.trim();
    }
    if ('serverColor' in (req.body ?? {})) {
      const color = typeof req.body.serverColor === 'string' ? req.body.serverColor.trim().toLowerCase() : null;
      if (color === null || (color && !/^#[0-9a-f]{6}$/.test(color))) {
        return res.status(400).json({ error: 'serverColor must be a #rrggbb color, or blank for the default' });
      }
      patch.serverColor = color;
    }
    if ('selfUpdate' in (req.body ?? {})) patch.selfUpdate = Boolean(req.body.selfUpdate);
    if ('updateCheckIntervalHours' in (req.body ?? {})) {
      const hours = Number(req.body.updateCheckIntervalHours);
      if (!Number.isFinite(hours) || hours <= 0) return res.status(400).json({ error: 'updateCheckIntervalHours must be a positive number' });
      patch.updateCheckIntervalHours = hours;
    }
    if ('defaultPrompt' in (req.body ?? {})) {
      if (typeof req.body.defaultPrompt !== 'string') return res.status(400).json({ error: 'defaultPrompt must be a string' });
      patch.defaultPrompt = req.body.defaultPrompt;
    }
    if ('commonCommands' in (req.body ?? {})) {
      if (typeof req.body.commonCommands !== 'string') return res.status(400).json({ error: 'commonCommands must be a string' });
      // Saved sorted, one per line, with blank lines dropped.
      patch.commonCommands = req.body.commonCommands
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
        .join('\n');
    }
    if ('defaultWorktreeInclude' in (req.body ?? {})) {
      if (typeof req.body.defaultWorktreeInclude !== 'string') return res.status(400).json({ error: 'defaultWorktreeInclude must be a string' });
      patch.defaultWorktreeInclude = req.body.defaultWorktreeInclude;
    }
    if ('retrospectivePrompt' in (req.body ?? {})) {
      if (typeof req.body.retrospectivePrompt !== 'string') return res.status(400).json({ error: 'retrospectivePrompt must be a string' });
      // The default saved back unchanged is stored blank, so it keeps following the default.
      const text = req.body.retrospectivePrompt.trim();
      patch.retrospectivePrompt = text === DEFAULT_RETROSPECTIVE_PROMPT.trim() ? '' : req.body.retrospectivePrompt;
    }
    if ('defaultNodeId' in (req.body ?? {})) {
      const id = String(req.body.defaultNodeId ?? '').trim();
      if (!hub.nodes.has(id)) return res.status(400).json({ error: 'defaultNodeId must be a node that has connected' });
      patch.defaultNodeId = id;
    }
    if ('jobDefaults' in (req.body ?? {})) {
      // Only the keys sent change, so the page can save one field at a time.
      try {
        patch.jobDefaults = patchJobDefaults((await loadSettings()).jobDefaults, req.body.jobDefaults);
      } catch (err) {
        if (err instanceof JobDefaultsError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }
    const saved = await patchSettings(patch);
    // Written first, applied second: nodes pick settings up from memory, so a
    // save that did not reach the disk must not change what is running.
    hub.setSettings(saved);
    // What a job shows as its own settings depends on both, so open pages redraw.
    if ('defaultNodeId' in patch || 'jobDefaults' in patch) hub.jobsChanged();
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

/**
 * The concurrent job limit, what is running under it, and what is queued behind
 * it — with the estimated start time of each waiting trigger.
 *
 * Answered from memory: the queue is never written to disk, for the same reason
 * the pause is not. A restart comes back with nothing waiting.
 */
app.get('/api/queue', (req, res) => {
  res.json(hub.concurrencyInfo(String(req.query.node ?? '').trim() || null));
});

/**
 * Whole-app pause. Holding every schedule is a temporary state that is never
 * written to disk: a restart is one of the documented ways out of it.
 */
app.get('/api/pause', (_req, res) => {
  res.json({ ...hub.pauseInfo(), options: PAUSE_OPTIONS, update: selfUpdater.state() });
});

app.post('/api/pause', async (req: JsonRequest, res, next) => {
  try {
    if (hub.isPausedForUpdate()) {
      return res.status(409).json({ error: 'an update is in progress; schedules are already held until it restarts' });
    }
    const option = pauseOption(String(req.body?.option ?? ''));
    if (!option) {
      return res.status(400).json({ error: `option must be one of ${PAUSE_OPTIONS.map((o) => o.id).join(', ')}` });
    }
    res.json(await hub.pauseAll({ mode: 'manual', label: option.label, option: option.id, ms: option.ms }));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/pause', async (_req, res, next) => {
  try {
    if (hub.isPausedForUpdate()) {
      return res.status(409).json({ error: 'this pause is holding schedules for an update and cannot be cancelled' });
    }
    if (!hub.isPaused()) return res.status(409).json({ error: 'not paused' });
    res.json(await hub.resumeAll('cancelled by user'));
  } catch (err) {
    next(err);
  }
});

/** Reports whether main is behind without touching the working tree. */
app.get('/api/update/check', async (_req, res, next) => {
  try {
    res.json(selfUpdater.recordCheck(await checkForUpdates()));
  } catch (err) {
    next(err);
  }
});

/**
 * Applies a pending update now. Works whether or not selfUpdate is on, which is
 * the point: it is how you update when you have chosen to do it by hand.
 */
app.post('/api/update/run', async (_req, res, next) => {
  try {
    const result = await selfUpdater.applyIfBehind();
    if (!result.launched) return res.status(409).json({ error: result.reason ?? 'nothing to update', ...result });
    res.status(202).json({ ...result, updateLog: UPDATE_LOG });
  } catch (err) {
    next(err);
  }
});

/** Models the default node's CLI recognises, for the Model dropdown. */
app.get('/api/models', (_req, res) => {
  res.json(hub.models());
});

/** Re-runs discovery, e.g. after the CLI is updated. */
app.post('/api/models/refresh', async (_req, res, next) => {
  try {
    res.json(await hub.refreshModels());
  } catch (err) {
    next(err);
  }
});

/** Live feedback for the Cron field: is this expression valid, and when does it next fire? */
app.get('/api/next-run', (req, res) => {
  const expression = String(req.query.cron ?? '').trim();
  if (!expression) return res.json({ valid: false, error: 'Cron is required.', nextRunAt: null });
  const check = validateCronExpression(expression);
  if (!check.ok) return res.json({ valid: false, error: check.error, nextRunAt: null });
  // A cron saved before zones were stored fires on its node's clock.
  const asked = String(req.query.timezone ?? '').trim();
  const timezone = (isTimeZone(asked) && asked) || hub.clockTimezone(hub.resolveNodeId(String(req.query.node ?? ''))) || undefined;
  res.json({ valid: true, error: null, nextRunAt: previewNextRun(expression, timezone), timezone: timezone ?? null });
});

/** Every cron, by name; `?sort=activity` puts what is running, waiting or unread first. */
app.get('/api/crons', async (req, res, next) => {
  try {
    const [crons, activity] = await Promise.all([listCrons(), jobActivity.rows()]);
    const views = crons.map((cron) => decorate(cron, activity.get(cron.id)));
    if (req.query.sort === 'activity') views.sort(byActivity);
    res.json(views);
  } catch (err) {
    next(err);
  }
});

app.get('/api/crons/:id', async (req, res, next) => {
  try {
    const cron = await getCron(req.params.id);
    if (!cron) return res.status(404).json({ error: 'cron not found' });
    res.json(decorate(cron, await jobActivity.row(cron.id)));
  } catch (err) {
    next(err);
  }
});

app.post('/api/crons', async (req, res, next) => {
  try {
    const { errors, value } = readCronForm(req.body);
    await checkProject(value.projectId, errors);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const cron = await createCron(value);
    hub.jobsChanged();
    if (value.nameInferred) hub.requestTitle('cron', cron);
    res.status(201).json(decorate(cron));
  } catch (err) {
    next(err);
  }
});

app.put('/api/crons/:id', async (req, res, next) => {
  try {
    const { errors, value } = readCronForm(req.body);
    await checkProject(value.projectId, errors);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const cron = await updateCron(req.params.id, value);
    if (!cron) return res.status(404).json({ error: 'cron not found' });
    hub.jobsChanged();
    if (value.nameInferred) hub.requestTitle('cron', cron);
    res.json(decorate(cron, await jobActivity.row(cron.id)));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/crons/:id', async (req, res, next) => {
  try {
    const removed = await deleteCron(req.params.id);
    if (!removed) return res.status(404).json({ error: 'cron not found' });
    await jobActivity.forget(req.params.id);
    hub.jobsChanged();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/projects', async (_req, res, next) => {
  try {
    res.json(await listProjects());
  } catch (err) {
    next(err);
  }
});

app.post('/api/projects', async (req: JsonRequest, res, next) => {
  try {
    const { errors, value } = readProjectForm(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    res.status(201).json(await createProject(value));
  } catch (err) {
    next(err);
  }
});

app.put('/api/projects/:id', async (req: JsonRequest, res, next) => {
  try {
    const { errors, value } = readProjectForm(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const project = await updateProject(String(req.params.id), value);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json(project);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/projects/:id', async (req, res, next) => {
  try {
    const removed = await deleteProject(req.params.id);
    if (!removed) return res.status(404).json({ error: 'project not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * One page of one-time executions, newest first, with the same cursor the
 * notification drawer uses. `?sort=activity` ranks all of them before taking
 * the page, so one with an update rises onto the first page from anywhere.
 */
app.get('/api/executions', async (req, res, next) => {
  try {
    const before = String(req.query.before ?? '').trim() || null;
    const activity = await jobActivity.rows();
    const order = req.query.sort === 'activity' ? (all: Execution[]) => rankExecutions(all, activity) : undefined;
    const page = await pageExecutions({ before, limit: req.query.limit ?? EXECUTIONS_PAGE_SIZE, order });
    res.json({ ...page, items: page.items.map((execution) => decorateExecution(execution, activity.get(execution.id))) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/executions/:id', async (req, res, next) => {
  try {
    const execution = await getExecution(req.params.id);
    if (!execution) return res.status(404).json({ error: 'execution not found' });
    res.json(decorateExecution(execution, await jobActivity.row(execution.id)));
  } catch (err) {
    next(err);
  }
});

app.post('/api/executions', async (req, res, next) => {
  try {
    const { errors, value } = readExecutionForm(req.body);
    await checkProject(value.projectId, errors);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const execution = await createExecution(value);
    // A date already past is armed and run by the same reload that arms the
    // rest, so saving one is how you say "run this now, behind the queue".
    hub.jobsChanged();
    if (value.nameInferred) hub.requestTitle('execution', execution);
    res.status(201).json(decorateExecution(execution));
  } catch (err) {
    next(err);
  }
});

/**
 * The header's bug and suggestion button. Saves a one-time execution dated now
 * that has claude file a GitHub issue from the project checkout, and answers
 * with it so the page can point at its run.
 */
app.post('/api/feedback', async (req: JsonRequest, res, next) => {
  try {
    const { errors, value } = readFeedbackForm(req.body);
    if (!value) return res.status(400).json({ error: errors.join(' ') });
    const execution = await createExecution(feedbackExecution(value.kind, value.details, PROJECT_DIR));
    hub.jobsChanged();
    res.status(201).json(decorateExecution(execution));
  } catch (err) {
    next(err);
  }
});

app.put('/api/executions/:id', async (req, res, next) => {
  try {
    const { errors, value } = readExecutionForm(req.body);
    await checkProject(value.projectId, errors);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const execution = await updateExecution(req.params.id, value);
    if (!execution) return res.status(404).json({ error: 'execution not found' });
    hub.jobsChanged();
    if (value.nameInferred) hub.requestTitle('execution', execution);
    res.json(decorateExecution(execution, await jobActivity.row(execution.id)));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/executions/:id', async (req, res, next) => {
  try {
    const removed = await deleteExecution(req.params.id);
    if (!removed) return res.status(404).json({ error: 'execution not found' });
    await jobActivity.forget(req.params.id);
    hub.jobsChanged();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Re-arms a one-time execution that has run, been cancelled, or was closed as
 * interrupted, without changing its date. What the list's "Reschedule" offers
 * when the date is still in the future.
 */
app.post('/api/executions/:id/rearm', async (req, res, next) => {
  try {
    const execution = await getExecution(req.params.id);
    if (!execution) return res.status(404).json({ error: 'execution not found' });
    if (execution.status === 'running') return res.status(409).json({ error: 'this execution is running' });
    const rearmed = await patchExecution(req.params.id, { status: 'scheduled', firedAt: null, stoppedBy: null });
    hub.jobsChanged();
    res.json(decorateExecution(rearmed!, await jobActivity.row(rearmed!.id)));
  } catch (err) {
    next(err);
  }
});

app.post('/api/:kind(crons|executions)/:id/run', async (req: JobRequest, res, next) => {
  try {
    const found = await findRecord(req.params.id);
    if (!found) return res.status(404).json({ error: `${noun(req)} not found` });
    const job = found.record;
    // Paused means nothing new starts, by hand or on a schedule — the same rule
    // the disabled Run now buttons show.
    if (hub.isPaused()) {
      return res.status(409).json({
        error: hub.isPausedForUpdate()
          ? 'an update is waiting for runs to finish; nothing new can start'
          : `everything is paused ${hub.pauseInfo().label}; cancel the pause to run one`,
      });
    }
    const node = hub.nodeSummary(job);
    const view = hub.jobView(job);
    if (!node.online) return res.status(409).json({ error: `node "${node.name ?? 'default'}" is offline` });
    if (view?.currentRun) return res.status(409).json({ error: `this ${noun(req)} is already running` });
    if (view?.delayed) {
      return res.status(409).json({
        error:
          view.delayed.hold === 'concurrency'
            ? `a trigger for this ${noun(req)} is already queued behind the ${view.delayed.limit} job limit`
            : `a trigger for this ${noun(req)} is already waiting on usage`,
      });
    }
    hub.command(node.id!, 'run', job.id);
    res.status(202).json({ requested: true, node });
  } catch (err) {
    next(err);
  }
});

app.post('/api/:kind(crons|executions)/:id/stop', async (req: JobRequest, res, next) => {
  try {
    const found = await findRecord(req.params.id);
    if (!found) return res.status(404).json({ error: `${noun(req)} not found` });
    const job = found.record;
    const node = hub.nodeSummary(job);
    const view = hub.jobView(job);
    if (!view?.currentRun && !view?.delayed) return res.status(409).json({ error: `this ${noun(req)} is not running` });
    hub.command(node.id!, 'stop', job.id);
    res.status(202).json({ requested: true, node, nextRunAt: view.nextRunAt ?? null });
  } catch (err) {
    next(err);
  }
});

/**
 * The run history of one job. Crons and one-time executions write into the same
 * logs folder, each under its own id, so this route serves both — only where the
 * lifetime totals are written back differs. `?q=` keeps only the runs whose log
 * contains it, ignoring case; `total` still counts every run kept.
 */
app.get('/api/:kind(crons|executions)/:id/logs', async (req: JobRequest, res, next) => {
  try {
    const found = await findRecord(req.params.id);
    if (!found) return res.status(404).json({ error: `${noun(req)} not found` });
    const cron = found.record;
    // Read before the runs are listed: the page marks this revision read once
    // it shows them, and a run that starts in between is a later revision.
    const activity = await jobActivity.row(cron.id);
    const logs = await listLogs(cron.id);
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const shown = await filterLogs(cron.id, logs, query);
    const withRetrospective = await retrospectiveLogs(cron.id, shown);
    // Read here rather than on the cron list: the first read scans the log
    // folder, and this is the one page that draws the result.
    const stats = await lifetimeStats(cron, found.kind === 'execution' ? patchExecution : undefined);
    hub.jobsCache = null;
    res.json({
      cron: found.view(cron, activity),
      stats,
      total: logs.length,
      logs: shown.map((log) => ({
        ...log,
        isRunning: hub.isRunningLog(cron.id, log.file),
        hasRetrospective: withRetrospective.has(log.file),
      })),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/:kind(crons|executions)/:id/logs/:file', async (req: JobLogRequest, res, next) => {
  try {
    const cron = await findRecord(req.params.id).then((found) => found?.record ?? null);
    if (!cron) return res.status(404).json({ error: `${noun(req)} not found` });
    const text = await readLog(cron.id, req.params.file);
    res.json({ file: req.params.file, text, isRunning: hub.isRunningLog(cron.id, req.params.file) });
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return res.status(404).json({ error: 'log not found' });
    if (errorMessage(err) === 'invalid log file name') return res.status(400).json({ error: errorMessage(err) });
    next(err);
  }
});

/**
 * Streams one log file: everything written so far, then each new chunk as it lands.
 * Polls the file size rather than using fs.watch, which is unreliable on macOS.
 */
app.get('/api/:kind(crons|executions)/:id/logs/:file/stream', async (req: JobLogRequest, res, next) => {
  let target: string;
  let cron: Cron | Execution | null;
  try {
    cron = await findRecord(req.params.id).then((found) => found?.record ?? null);
    if (!cron) return res.status(404).json({ error: `${noun(req)} not found` });
    target = logPath(cron.id, req.params.file);
    await fsp.access(target);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return res.status(404).json({ error: 'log not found' });
    if (errorMessage(err) === 'invalid log file name') return res.status(400).json({ error: errorMessage(err) });
    return next(err);
  }

  sseInit(res);
  let position = 0;
  let closed = false;
  let reading = false;

  const pump = async () => {
    if (closed || reading) return;
    reading = true;
    let handle: FileHandle | undefined;
    try {
      handle = await fsp.open(target, 'r');
      const { size } = await handle.stat();
      if (size > position) {
        const length = size - position;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, position);
        position = size;
        if (!closed) sseSend(res, 'chunk', { text: buffer.toString('utf8') });
      } else if (size < position) {
        // File was replaced or truncated; start over.
        position = 0;
      }
    } catch (err) {
      if (!closed) sseSend(res, 'error', { message: errorMessage(err) });
    } finally {
      await handle?.close().catch(() => {});
      reading = false;
    }
  };

  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    res.end();
  };

  const tick = async () => {
    const live = hub.isRunningLog(cron.id, req.params.file);
    await pump();
    if (!live && !closed) {
      sseSend(res, 'done', { file: req.params.file });
      stop();
    }
  };

  const timer = setInterval(() => {
    tick().catch(() => stop());
  }, 400);
  req.on('close', stop);
  await tick();
});

/** Fans out cron and run activity so the UI can update without polling. */
app.get('/api/events', (req, res) => {
  sseInit(res);
  sseSend(res, 'hello', { at: new Date().toISOString() });
  const onEvent = (event: BusEvent): void => sseSend(res, event.type, event);
  bus.on('event', onEvent);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('event', onEvent);
  });
});

/**
 * The commit is read once at startup, not per request: it identifies the code
 * this process is running, which is what the page needs in order to notice that
 * an update has moved on without it.
 */
let runningCommit: string | null = null;

app.get('/api/health', async (_req, res) => {
  if (res.locals.signedIn === false) return res.json({ ok: true, authRequired: true });
  // The one await that can be slow, and only once: the folder is read at
  // startup, and every poll after that is answered from memory.
  await notificationCenter.ready;
  res.json({
    ok: true,
    ...hub.health(runningCommit),
    commit: runningCommit,
    startedAt: STARTED_AT,
    // What the limit means when it is 0: the header's jobs meter fills against
    // this rather than against "unlimited", which no bar can draw.
    defaultConcurrencyLimit: DEFAULT_MAX_CONCURRENT_JOBS,
    unreadNotifications: notificationCenter.unreadCount(),
    notificationCounts: notificationCenter.counts(),
    ...selfUpdater.availability(),
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server]', err);
  res.status(500).json({ error: errorMessage(err) });
});

await ensureDirs();
openDatabase();
await migrate();
try {
  await assertAuthConfigured(HOST);
} catch (err) {
  console.error(`[auth] ${errorMessage(err)}`);
  process.exit(1);
}
// Subscribes to the event bus before anything can emit, and reads the table
// behind the server coming up.
notificationCenter.start();
jobActivity.start();
runningCommit = await currentCommit();
hub.setVersion(runningCommit);
await hub.start(await loadSettings()); // writes the defaults on first run
if (SELF_UPDATE) selfUpdater.start();

app.listen(PORT, HOST, () => {
  console.log(`promptd listening on http://${HOST}:${PORT}${runningCommit ? ` (${runningCommit})` : ''}`);
  const database = databaseTarget();
  console.log(`Storage: ${ROOT}; ${database.dialect} database at ${database.location}`);
});
