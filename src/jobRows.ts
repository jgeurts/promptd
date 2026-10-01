import type { CronTable, ExecutionTable } from './db.js';
import { readUsageDelayOverride } from './jobDefaults.js';
import type { Cron, Execution, ExecutionStatus, JobBase, RunStatus } from './types.js';

type JobColumns = Omit<CronTable, 'cron' | 'timezone'>;

/** Null stays null: it is a setting the job leaves to its node's defaults. */
function flag(value: boolean | null | undefined): number | null {
  return value === null || value === undefined ? null : value ? 1 : 0;
}

function readFlag(value: number | null): boolean | null {
  return value === null || value === undefined ? null : Boolean(value);
}

function parseUsageDelay(text: string): JobBase['usageDelay'] {
  try {
    return readUsageDelayOverride(JSON.parse(text));
  } catch {
    return readUsageDelayOverride({});
  }
}

function toColumns(job: JobBase): JobColumns {
  return {
    id: job.id,
    name: job.name,
    nameInferred: job.nameInferred ? 1 : 0,
    description: job.description ?? '',
    workingDirectory: job.workingDirectory ?? '',
    useWorktree: flag(job.useWorktree),
    cleanupWorktree: flag(job.cleanupWorktree),
    retrospective: flag(job.retrospective),
    model: job.model ?? null,
    effort: job.effort ?? null,
    usageDelay: JSON.stringify(readUsageDelayOverride(job.usageDelay)),
    prompt: job.prompt ?? '',
    isActive: job.isActive ? 1 : 0,
    nodeId: job.nodeId ?? '',
    projectId: job.projectId ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastRunAt: job.lastRunAt ?? null,
    lastRunStatus: job.lastRunStatus ?? null,
    lastRunLog: job.lastRunLog ?? null,
    lastRunDurationSeconds: job.lastRunDurationSeconds ?? null,
    lifetimeRuns: job.lifetimeRuns ?? null,
    lifetimeCostUsd: job.lifetimeCostUsd ?? null,
    lifetimeRuntimeSeconds: job.lifetimeRuntimeSeconds ?? null,
  };
}

// A counter never written is left off the record rather than read as zero:
// its absence is what tells the hub to backfill it from the logs.
function fromColumns(row: JobColumns): JobBase {
  const job: JobBase = {
    id: row.id,
    name: row.name,
    nameInferred: Boolean(row.nameInferred),
    description: row.description,
    workingDirectory: row.workingDirectory,
    useWorktree: readFlag(row.useWorktree),
    cleanupWorktree: readFlag(row.cleanupWorktree),
    retrospective: readFlag(row.retrospective),
    model: row.model ?? null,
    effort: row.effort ?? null,
    usageDelay: parseUsageDelay(row.usageDelay),
    prompt: row.prompt,
    isActive: Boolean(row.isActive),
    nodeId: row.nodeId,
    projectId: row.projectId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt,
    lastRunStatus: row.lastRunStatus as RunStatus | null,
    lastRunLog: row.lastRunLog,
  };
  if (row.lastRunDurationSeconds !== null) job.lastRunDurationSeconds = Number(row.lastRunDurationSeconds);
  if (row.lifetimeRuns !== null) job.lifetimeRuns = Number(row.lifetimeRuns);
  if (row.lifetimeCostUsd !== null) job.lifetimeCostUsd = Number(row.lifetimeCostUsd);
  if (row.lifetimeRuntimeSeconds !== null) job.lifetimeRuntimeSeconds = Number(row.lifetimeRuntimeSeconds);
  return job;
}

export function cronToRow(cron: Cron): CronTable {
  return { ...toColumns(cron), cron: cron.cron, timezone: cron.timezone ?? '' };
}

export function rowToCron(row: CronTable): Cron {
  return { ...fromColumns(row), cron: row.cron, timezone: row.timezone ?? '' };
}

export function executionToRow(execution: Execution): ExecutionTable {
  return {
    ...toColumns(execution),
    scheduledAt: execution.scheduledAt ?? null,
    status: execution.status,
    firedAt: execution.firedAt ?? null,
    stoppedBy: execution.stoppedBy ?? null,
  };
}

export function rowToExecution(row: ExecutionTable): Execution {
  return {
    ...fromColumns(row),
    scheduledAt: row.scheduledAt,
    status: row.status as ExecutionStatus,
    firedAt: row.firedAt,
    stoppedBy: row.stoppedBy,
  };
}
