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

/**
 * What the cluster starts with: worktrees on and cleaned up, the CLI's model
 * and effort, waiting out the session limit, and nothing run before the prompt.
 */
export const BUILT_IN_JOB_DEFAULTS: JobDefaults = {
  useWorktree: true,
  cleanupWorktree: true,
  retrospective: false,
  model: '',
  effort: '',
  usageDelay: { session: true, weekly: false, fable: false, credits: false },
  prePromptCommands: [],
};

/**
 * What a node says in its identity when it can run commands before the
 * prompt. A node without it would run such a job without them, so the hub
 * does not send it one.
 */
export const PRE_PROMPT_COMMANDS_FEATURE = 'prePromptCommands';

/** Bounds on a list of commands run before the prompt. Anything longer belongs in a script in the repository. */
export const MAX_PRE_PROMPT_COMMANDS = 50;
export const MAX_PRE_PROMPT_COMMAND_LENGTH = 4096;
const MAX_PRE_PROMPT_TOTAL_LENGTH = 16384;

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
  return { ...BUILT_IN_JOB_DEFAULTS, usageDelay: { ...BUILT_IN_JOB_DEFAULTS.usageDelay }, prePromptCommands: [] };
}

/**
 * A list of commands to run before the prompt, or what is wrong with it,
 * worded to follow the name of the field. Each is one line of shell; blank
 * ones are dropped and the rest trimmed, in order. A line break inside one is
 * refused rather than split, since the form shows one command per line and
 * would save it back as two.
 */
export function parsePrePromptCommands(input: unknown): { commands: string[] } | { error: string } {
  if (!Array.isArray(input) || input.some((command) => typeof command !== 'string')) return { error: 'must be a list of strings' };
  const commands = (input as string[]).map((command) => command.trim()).filter(Boolean);
  if (commands.some((command) => /[\0\r\n]/.test(command))) return { error: 'must each be one line, with no line breaks or NUL characters' };
  if (commands.length > MAX_PRE_PROMPT_COMMANDS) return { error: `can be at most ${MAX_PRE_PROMPT_COMMANDS} commands` };
  if (commands.some((command) => command.length > MAX_PRE_PROMPT_COMMAND_LENGTH)) {
    return { error: `must each be ${MAX_PRE_PROMPT_COMMAND_LENGTH} characters or fewer` };
  }
  if (commands.reduce((total, command) => total + command.length, 0) > MAX_PRE_PROMPT_TOTAL_LENGTH) {
    return { error: `must come to ${MAX_PRE_PROMPT_TOTAL_LENGTH} characters or fewer in all` };
  }
  return { commands };
}

/** A stored list, or null when it is missing or not one, so whatever reads it falls back to what it follows. */
function readCommands(input: unknown): string[] | null {
  const parsed = parsePrePromptCommands(input);
  return 'commands' in parsed ? parsed.commands : null;
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
  defaults.prePromptCommands = readCommands(given.prePromptCommands) ?? defaults.prePromptCommands;
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
  if ('prePromptCommands' in patch) next.prePromptCommands = patch.prePromptCommands === null ? initial.prePromptCommands : commandsFrom(patch.prePromptCommands);
  return next;
}

/** A list the API was sent, or an error saying why it is not one. */
function commandsFrom(input: unknown): string[] {
  const parsed = parsePrePromptCommands(input);
  if ('error' in parsed) throw new JobDefaultsError(`jobDefaults.prePromptCommands ${parsed.error}`);
  return parsed.commands;
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
  // An empty list is a change of its own: this node runs nothing before the prompt.
  const commands = readCommands(given.prePromptCommands);
  if (commands) override.prePromptCommands = commands;
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
  if ('prePromptCommands' in patch) {
    if (patch.prePromptCommands === null) delete next.prePromptCommands;
    else next.prePromptCommands = commandsFrom(patch.prePromptCommands);
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
    prePromptCommands: [...(override.prePromptCommands ?? base.prePromptCommands)],
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

/**
 * Commands a job keeps for itself: null or missing follows the defaults, a
 * list is the job's own, empty included. A list that is not one also follows
 * them; the form reader is where it is refused.
 */
export function readCommandsOverride(input: unknown): string[] | null {
  return input === null || input === undefined ? null : readCommands(input);
}

/** All four Delay for usage boxes, each on, off, or null to follow the defaults. */
export function readUsageDelayOverride(input: unknown): UsageDelayOverride {
  const given = asRecord(input);
  return Object.fromEntries(usageIds().map((id) => [id, readFlagOverride(given[id])])) as UsageDelayOverride;
}

/** The settings as a job stores them, each its own value or null. */
export function jobSettingOverrides(input: Partial<JobSettingOverrides>): JobSettingOverrides {
  return {
    useWorktree: readFlagOverride(input.useWorktree),
    cleanupWorktree: readFlagOverride(input.cleanupWorktree),
    retrospective: readFlagOverride(input.retrospective),
    model: readTextOverride(input.model),
    effort: readTextOverride(input.effort),
    usageDelay: readUsageDelayOverride(input.usageDelay),
    prePromptCommands: readCommandsOverride(input.prePromptCommands),
  };
}

/** Just the settings of a job, with what it leaves to the defaults filled in from them. */
export function effectiveJobSettings(job: JobSettingOverrides, defaults: JobDefaults): JobSettings {
  const delay = readUsageDelayOverride(job.usageDelay);
  return {
    useWorktree: job.useWorktree ?? defaults.useWorktree,
    cleanupWorktree: job.cleanupWorktree ?? defaults.cleanupWorktree,
    retrospective: job.retrospective ?? defaults.retrospective,
    model: job.model ?? defaults.model,
    effort: job.effort ?? defaults.effort,
    usageDelay: Object.fromEntries(usageIds().map((id) => [id, delay[id] ?? defaults.usageDelay[id]])) as UsageDelay,
    prePromptCommands: [...(readCommandsOverride(job.prePromptCommands) ?? defaults.prePromptCommands ?? [])],
  };
}

/** The whole job as a run uses it. */
export function resolveJob<T extends JobSettingOverrides>(job: T, defaults: JobDefaults): Resolved<T> {
  return { ...job, ...effectiveJobSettings(job, defaults) };
}
