import { isEffortLevel } from './schedule.js';
import { USAGE_DELAY_CATEGORIES } from './usage.js';
import type {
  JobDefaults,
  JobDefaultsOverride,
  JobSettingOverrides,
  JobSettings,
  Resolved,
  UsageDelay,
  UsageDelayCategoryId,
  UsageDelayOverride,
} from './types.js';

/**
 * Job defaults: the settings a job leaves to its node rather than setting itself.
 *
 * The cluster has one set, on the Settings page. A node can change any of them
 * for the jobs it runs, on its own page. A job stores null for each setting it
 * leaves alone and is filled in when a trigger fires, so changing a default
 * reaches every job that did not set its own from its next run.
 */

/** What the cluster starts with: worktrees on and cleaned up, the CLI's model and effort, waiting out the session limit. */
export const BUILT_IN_JOB_DEFAULTS: JobDefaults = {
  useWorktree: true,
  cleanupWorktree: true,
  retrospective: false,
  model: '',
  effort: '',
  usageDelay: { session: true, weekly: false, fable: false, credits: false },
};

const FLAGS = ['useWorktree', 'cleanupWorktree', 'retrospective'] as const;

const TEXTS = ['model', 'effort'] as const;

export class JobDefaultsError extends Error {}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function usageIds(): UsageDelayCategoryId[] {
  return USAGE_DELAY_CATEGORIES.map((category) => category.id);
}

function builtIn(): JobDefaults {
  return { ...BUILT_IN_JOB_DEFAULTS, usageDelay: { ...BUILT_IN_JOB_DEFAULTS.usageDelay } };
}

/** A model or effort as given, or null when it is not one: effort must be a level the CLI takes, or blank. */
function readText(key: (typeof TEXTS)[number], value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (key === 'effort' && text && !isEffortLevel(text)) return null;
  return text;
}

/** Stored cluster defaults, with anything missing or unreadable back at its built-in value. */
export function readJobDefaults(input: unknown): JobDefaults {
  const given = asRecord(input);
  const delay = asRecord(given.usageDelay);
  const defaults = builtIn();
  for (const key of FLAGS) if (typeof given[key] === 'boolean') defaults[key] = given[key];
  for (const key of TEXTS) defaults[key] = readText(key, given[key]) ?? defaults[key];
  for (const id of usageIds()) if (typeof delay[id] === 'boolean') defaults.usageDelay[id] = delay[id];
  return defaults;
}

/**
 * A change to the cluster defaults from the Settings page. Only the keys given
 * change; null puts one back to its built-in value.
 */
export function patchJobDefaults(current: JobDefaults, input: unknown): JobDefaults {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new JobDefaultsError('jobDefaults must be an object');
  const patch = input as Record<string, unknown>;
  const next = readJobDefaults(current);
  const initial = builtIn();
  for (const key of FLAGS) {
    if (!(key in patch)) continue;
    if (patch[key] === null) next[key] = initial[key];
    else if (typeof patch[key] === 'boolean') next[key] = patch[key];
    else throw new JobDefaultsError(`jobDefaults.${key} must be true, false or null`);
  }
  for (const key of TEXTS) {
    if (!(key in patch)) continue;
    const value = patch[key] === null ? initial[key] : readText(key, patch[key]);
    if (value === null) throw new JobDefaultsError(`jobDefaults.${key} must be ${key === 'effort' ? 'an effort level' : 'a string'}, blank or null`);
    next[key] = value;
  }
  if ('usageDelay' in patch) {
    const delay = patch.usageDelay === null ? { ...initial.usageDelay } : asRecord(patch.usageDelay);
    for (const id of usageIds()) {
      if (!(id in delay)) continue;
      if (delay[id] === null) next.usageDelay[id] = initial.usageDelay[id];
      else if (typeof delay[id] === 'boolean') next.usageDelay[id] = delay[id];
      else throw new JobDefaultsError(`jobDefaults.usageDelay.${id} must be true, false or null`);
    }
  }
  return next;
}

/** A node's stored changes, with anything unreadable dropped so it follows the cluster. */
export function readJobDefaultsOverride(input: unknown): JobDefaultsOverride {
  const given = asRecord(input);
  const override: JobDefaultsOverride = {};
  for (const key of FLAGS) if (typeof given[key] === 'boolean') override[key] = given[key];
  for (const key of TEXTS) {
    const value = readText(key, given[key]);
    if (value !== null) override[key] = value;
  }
  const delay = asRecord(given.usageDelay);
  const usage: Partial<UsageDelay> = {};
  for (const id of usageIds()) if (typeof delay[id] === 'boolean') usage[id] = delay[id];
  if (Object.keys(usage).length) override.usageDelay = usage;
  return override;
}

/**
 * A change to a node's own defaults from its page. Only the keys given change;
 * null on one puts it back to the cluster's, and null for the whole set puts
 * them all back.
 */
export function patchJobDefaultsOverride(current: JobDefaultsOverride, input: unknown): JobDefaultsOverride {
  if (input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new JobDefaultsError('jobDefaults must be an object or null');
  const patch = input as Record<string, unknown>;
  const next = readJobDefaultsOverride(current);
  for (const key of FLAGS) {
    if (!(key in patch)) continue;
    if (patch[key] === null) delete next[key];
    else if (typeof patch[key] === 'boolean') next[key] = patch[key];
    else throw new JobDefaultsError(`jobDefaults.${key} must be true, false or null`);
  }
  for (const key of TEXTS) {
    if (!(key in patch)) continue;
    if (patch[key] === null) {
      delete next[key];
      continue;
    }
    const value = readText(key, patch[key]);
    if (value === null) throw new JobDefaultsError(`jobDefaults.${key} must be ${key === 'effort' ? 'an effort level' : 'a string'}, blank or null`);
    next[key] = value;
  }
  if ('usageDelay' in patch) {
    const usage: Partial<UsageDelay> = patch.usageDelay === null ? {} : { ...next.usageDelay };
    const delay = asRecord(patch.usageDelay);
    for (const id of usageIds()) {
      if (!(id in delay)) continue;
      if (delay[id] === null) delete usage[id];
      else if (typeof delay[id] === 'boolean') usage[id] = delay[id];
      else throw new JobDefaultsError(`jobDefaults.usageDelay.${id} must be true, false or null`);
    }
    if (Object.keys(usage).length) next.usageDelay = usage;
    else delete next.usageDelay;
  }
  return next;
}

/** The cluster's defaults with one node's changes laid over them. */
export function effectiveJobDefaults(cluster: JobDefaults, override: JobDefaultsOverride = {}): JobDefaults {
  const base = readJobDefaults(cluster);
  return {
    useWorktree: override.useWorktree ?? base.useWorktree,
    cleanupWorktree: override.cleanupWorktree ?? base.cleanupWorktree,
    retrospective: override.retrospective ?? base.retrospective,
    model: override.model ?? base.model,
    effort: override.effort ?? base.effort,
    usageDelay: Object.fromEntries(usageIds().map((id) => [id, override.usageDelay?.[id] ?? base.usageDelay[id]])) as UsageDelay,
  };
}

/** A submitted on/off setting: null or missing follows the defaults. */
export function readFlagOverride(input: unknown): boolean | null {
  return input === null || input === undefined ? null : Boolean(input);
}

/** A submitted model or effort: null or missing follows the defaults, and blank is the CLI's own. */
export function readTextOverride(input: unknown): string | null {
  return input === null || input === undefined ? null : String(input).trim();
}

/** All four Delay for usage boxes, each on, off, or null to follow the defaults. */
export function readUsageDelayOverride(input: unknown): UsageDelayOverride {
  const given = asRecord(input);
  return Object.fromEntries(usageIds().map((id) => [id, readFlagOverride(given[id])])) as UsageDelayOverride;
}

/** The six settings as a job stores them, each its own value or null. */
export function jobSettingOverrides(input: Partial<JobSettingOverrides>): JobSettingOverrides {
  return {
    useWorktree: readFlagOverride(input.useWorktree),
    cleanupWorktree: readFlagOverride(input.cleanupWorktree),
    retrospective: readFlagOverride(input.retrospective),
    model: readTextOverride(input.model),
    effort: readTextOverride(input.effort),
    usageDelay: readUsageDelayOverride(input.usageDelay),
  };
}

/** Just the six settings of a job, with what it leaves to the defaults filled in from them. */
export function effectiveJobSettings(job: JobSettingOverrides, defaults: JobDefaults): JobSettings {
  const delay = readUsageDelayOverride(job.usageDelay);
  return {
    useWorktree: job.useWorktree ?? defaults.useWorktree,
    cleanupWorktree: job.cleanupWorktree ?? defaults.cleanupWorktree,
    retrospective: job.retrospective ?? defaults.retrospective,
    model: job.model ?? defaults.model,
    effort: job.effort ?? defaults.effort,
    usageDelay: Object.fromEntries(usageIds().map((id) => [id, delay[id] ?? defaults.usageDelay[id]])) as UsageDelay,
  };
}

/** The whole job as a run uses it. */
export function resolveJob<T extends JobSettingOverrides>(job: T, defaults: JobDefaults): Resolved<T> {
  return { ...job, ...effectiveJobSettings(job, defaults) };
}
