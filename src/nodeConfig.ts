import type { NodeConfig, UsageThresholds } from './types.js';
import { DEFAULT_USAGE_THRESHOLDS, USAGE_DELAY_CATEGORIES, normalizeUsageThresholds, parseUsageThreshold } from './usage.js';
import { normalizeMaxConcurrentJobs } from './settings.js';

export const DEFAULT_WORKING_DIRECTORY = '~/';


/** Settings keys that were hub-wide before each node had its own. */
export const LEGACY_NODE_KEYS = ['maxConcurrentJobs', 'usageDelayThresholds', 'defaultWorkingDirectory'] as const;

export interface EffectiveNodeConfig {
  maxConcurrentJobs: number;
  usageDelayThresholds: UsageThresholds;
  defaultWorkingDirectory: string;
}

export class NodeConfigError extends Error {}

function sameThresholds(a: UsageThresholds, b: UsageThresholds): boolean {
  return USAGE_DELAY_CATEGORIES.every((category) => a[category.id] === b[category.id]);
}

/** A stored config with anything unreadable dropped, so it falls back to the default. */
export function readNodeConfig(input: unknown): NodeConfig {
  let raw: unknown = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const config: NodeConfig = {};
  const limit = given.maxConcurrentJobs === undefined ? null : normalizeMaxConcurrentJobs(given.maxConcurrentJobs);
  if (limit !== null) config.maxConcurrentJobs = limit;
  if (typeof given.usageDelayThresholds === 'object' && given.usageDelayThresholds !== null) {
    config.usageDelayThresholds = normalizeUsageThresholds(given.usageDelayThresholds);
  }
  if (typeof given.defaultWorkingDirectory === 'string' && given.defaultWorkingDirectory.trim()) {
    config.defaultWorkingDirectory = given.defaultWorkingDirectory.trim();
  }
  return config;
}

/**
 * Applies a change from the node's page. Null resets a key to the node's default;
 * a partial set of thresholds keeps the categories it leaves out.
 */
export function patchNodeConfig(current: NodeConfig, patch: Record<string, unknown>): NodeConfig {
  const next: NodeConfig = { ...current };
  if ('maxConcurrentJobs' in patch) {
    if (patch.maxConcurrentJobs === null) delete next.maxConcurrentJobs;
    else {
      const limit = normalizeMaxConcurrentJobs(patch.maxConcurrentJobs);
      if (limit === null) throw new NodeConfigError('maxConcurrentJobs must be 0 or a positive whole number');
      next.maxConcurrentJobs = limit;
    }
  }
  if ('usageDelayThresholds' in patch) {
    if (patch.usageDelayThresholds === null) delete next.usageDelayThresholds;
    else {
      const given = (patch.usageDelayThresholds ?? {}) as Record<string, unknown>;
      const thresholds = { ...(next.usageDelayThresholds ?? DEFAULT_USAGE_THRESHOLDS) };
      for (const category of USAGE_DELAY_CATEGORIES) {
        if (!(category.id in given)) continue;
        const value = parseUsageThreshold(given[category.id]);
        if (value === null) throw new NodeConfigError(`usageDelayThresholds.${category.id} must be a whole number from 1 to 100`);
        thresholds[category.id] = value;
      }
      if (sameThresholds(thresholds, DEFAULT_USAGE_THRESHOLDS)) delete next.usageDelayThresholds;
      else next.usageDelayThresholds = thresholds;
    }
  }
  if ('defaultWorkingDirectory' in patch) {
    if (patch.defaultWorkingDirectory !== null && typeof patch.defaultWorkingDirectory !== 'string') {
      throw new NodeConfigError('defaultWorkingDirectory must be a string');
    }
    const directory = String(patch.defaultWorkingDirectory ?? '').trim();
    if (!directory || directory === DEFAULT_WORKING_DIRECTORY) delete next.defaultWorkingDirectory;
    else next.defaultWorkingDirectory = directory;
  }
  return next;
}

export function effectiveNodeConfig(config: NodeConfig, processors: number): EffectiveNodeConfig {
  return {
    maxConcurrentJobs: config.maxConcurrentJobs ?? processors,
    usageDelayThresholds: config.usageDelayThresholds ?? DEFAULT_USAGE_THRESHOLDS,
    defaultWorkingDirectory: config.defaultWorkingDirectory ?? DEFAULT_WORKING_DIRECTORY,
  };
}

/**
 * What the old hub-wide settings carry over to a node. A value still at its old
 * default is left behind: the limit defaulted to the hub's processor count,
 * which on a hosted hub says nothing about the machine running the jobs.
 */
export function legacyNodeConfig(settings: Record<string, unknown>, hubProcessors: number): NodeConfig {
  const config = readNodeConfig({
    maxConcurrentJobs: settings.maxConcurrentJobs,
    usageDelayThresholds: settings.usageDelayThresholds,
    defaultWorkingDirectory: settings.defaultWorkingDirectory,
  });
  if (config.maxConcurrentJobs === hubProcessors) delete config.maxConcurrentJobs;
  if (config.usageDelayThresholds && sameThresholds(config.usageDelayThresholds, DEFAULT_USAGE_THRESHOLDS)) delete config.usageDelayThresholds;
  if (config.defaultWorkingDirectory === DEFAULT_WORKING_DIRECTORY) delete config.defaultWorkingDirectory;
  return config;
}
