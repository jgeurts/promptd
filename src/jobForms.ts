import { parseScheduledAt } from './executions.js';
import { effectiveJobSettings, readFlagOverride, readTextOverride, readUsageDelayOverride } from './jobDefaults.js';
import { MAX_NAME_LENGTH, nameFromPrompt } from './naming.js';
import { EFFORT_LEVELS, isEffortLevel, isTimeZone, validateCronExpression } from './schedule.js';
import type { CronInput, ExecutionInput, JobDefaults, JobSettingOverrides, JobSettings } from './types.js';

/**
 * What the job forms send, read into what the store saves, and a saved job as
 * the API answers with it.
 */

type FormBody = Record<string, unknown> | undefined;

export interface FormResult<T> {
  errors: string[];
  value: T;
}

/**
 * The settings a job may leave to its node's defaults. Null or missing leaves
 * one to them; anything else is the job's own, so a form that sends only what
 * the person changed stores nulls for the rest.
 */
function readSettings(body: FormBody, errors: string[]): JobSettingOverrides {
  const effort = readTextOverride(body?.effort);
  if (effort && !isEffortLevel(effort)) {
    errors.push(`Effort must be one of ${EFFORT_LEVELS.map((level) => level.id).join(', ')}.`);
  }
  return {
    useWorktree: readFlagOverride(body?.useWorktree),
    cleanupWorktree: readFlagOverride(body?.cleanupWorktree),
    retrospective: readFlagOverride(body?.retrospective),
    model: readTextOverride(body?.model),
    effort,
    usageDelay: readUsageDelayOverride(body?.usageDelay),
  };
}

/**
 * The name as given, or, left blank, one taken from the prompt's first words
 * and marked inferred, which a title from claude may replace later.
 */
function readName(body: FormBody, errors: string[]): { name: string; nameInferred: boolean } {
  const name = String(body?.name ?? '').trim();
  if (name.length > MAX_NAME_LENGTH) errors.push(`Name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  if (name) return { name, nameInferred: false };
  const prompt = String(body?.prompt ?? '');
  // With no prompt either there is nothing to name it from, and Prompt is required says so.
  return { name: prompt.trim() ? nameFromPrompt(prompt) : '', nameInferred: true };
}

/** Validates and normalizes the cron form payload. */
export function readCronForm(body: FormBody): FormResult<CronInput> {
  const errors: string[] = [];
  const { name, nameInferred } = readName(body, errors);
  const expression = String(body?.cron ?? '').trim();
  if (!expression) errors.push('Cron is required.');
  else {
    const check = validateCronExpression(expression);
    if (!check.ok) errors.push(`Cron expression is not valid: ${check.error}`);
  }
  if (!String(body?.prompt ?? '').trim()) errors.push('Prompt is required.');
  const settings = readSettings(body, errors);
  const timezone = String(body?.timezone ?? '').trim();
  if (timezone && !isTimeZone(timezone)) errors.push(`${timezone} is not a time zone.`);
  return {
    errors,
    value: {
      name,
      nameInferred,
      description: String(body?.description ?? '').trim(),
      cron: expression,
      timezone,
      workingDirectory: String(body?.workingDirectory ?? '').trim(),
      ...settings,
      prompt: String(body?.prompt ?? ''),
      isActive: Boolean(body?.isActive),
      nodeId: String(body?.nodeId ?? '').trim(),
      projectId: String(body?.projectId ?? '').trim() || null,
    },
  };
}

/**
 * Validates and normalizes the one-time execution form payload.
 *
 * The same fields as a cron, with a date where the expression was. A date
 * already in the past is accepted rather than rejected: the same rule that runs
 * a trigger missed over a restart runs this one as soon as it is saved, and a
 * form that refused it would be arguing with a clock the user can see.
 *
 * `asSoonAsPossible` is the form's other choice: dated now by the hub's clock,
 * and waiting for the session limit to have room, whatever the defaults say.
 */
export function readExecutionForm(body: FormBody, now = new Date()): FormResult<ExecutionInput> {
  const errors: string[] = [];
  const { name, nameInferred } = readName(body, errors);
  const asSoonAsPossible = body?.asSoonAsPossible === true;
  const scheduledAt = asSoonAsPossible ? now : parseScheduledAt(body?.scheduledAt);
  if (!asSoonAsPossible && !String(body?.scheduledAt ?? '').trim()) errors.push('Date and time are required.');
  else if (!scheduledAt) errors.push('Date and time is not a valid date.');
  if (!String(body?.prompt ?? '').trim()) errors.push('Prompt is required.');
  const settings = readSettings(body, errors);
  if (asSoonAsPossible) settings.usageDelay.session = true;
  return {
    errors,
    value: {
      name,
      nameInferred,
      description: String(body?.description ?? '').trim(),
      // Stored as UTC ISO, whatever the browser sent, so the record reads the
      // same wherever it is opened from.
      scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
      workingDirectory: String(body?.workingDirectory ?? '').trim(),
      ...settings,
      // Whatever was sent: a job that runs once would only leave its worktree behind.
      cleanupWorktree: true,
      prompt: String(body?.prompt ?? ''),
      isActive: Boolean(body?.isActive),
      nodeId: String(body?.nodeId ?? '').trim(),
      projectId: String(body?.projectId ?? '').trim() || null,
    },
  };
}

/**
 * A job as the API answers it: each setting as the job stores it, null where it
 * follows the defaults, and under `effective` what a run on its node would use.
 */
export function withEffective<T extends JobSettingOverrides>(job: T, defaults: JobDefaults): T & { effective: JobSettings } {
  return { ...job, effective: effectiveJobSettings(job, defaults) };
}
