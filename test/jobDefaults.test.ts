import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_JOB_DEFAULTS,
  JobDefaultsError,
  MAX_PRE_PROMPT_COMMANDS,
  effectiveJobDefaults,
  effectiveJobSettings,
  jobSettingOverrides,
  parsePrePromptCommands,
  patchJobDefaults,
  patchJobDefaultsOverride,
  readJobDefaults,
  readJobDefaultsOverride,
} from '../src/jobDefaults.js';
import type { JobSettingOverrides } from '../src/types.js';

const leavesAll: JobSettingOverrides = {
  useWorktree: null,
  cleanupWorktree: null,
  retrospective: null,
  model: null,
  effort: null,
  usageDelay: { session: null, weekly: null, fable: null, credits: null },
  prePromptCommands: null,
};

describe('cluster job defaults', () => {
  it('start with worktrees on and cleaned up, the CLI model and effort, and the session wait', () => {
    expect(readJobDefaults(undefined)).toEqual({
      useWorktree: true,
      cleanupWorktree: true,
      retrospective: false,
      model: '',
      effort: '',
      usageDelay: { session: true, weekly: false, fable: false, credits: false },
      prePromptCommands: [],
    });
  });

  it('keep what a stored set says and fall back on anything it cannot', () => {
    expect(readJobDefaults({ useWorktree: false, model: ' sonnet ', effort: 'enormous', usageDelay: { weekly: true, session: 'x' } })).toMatchObject({
      useWorktree: false,
      model: 'sonnet',
      effort: '',
      usageDelay: { session: true, weekly: true },
    });
  });

  it('change only the keys a save sends, and null puts one back', () => {
    const changed = patchJobDefaults(BUILT_IN_JOB_DEFAULTS, { model: 'opus', usageDelay: { session: false } });
    expect(changed).toMatchObject({ model: 'opus', useWorktree: true, usageDelay: { session: false, weekly: false } });
    expect(patchJobDefaults(changed, { model: null, usageDelay: null })).toEqual(BUILT_IN_JOB_DEFAULTS);
    expect(() => patchJobDefaults(changed, { retrospective: 'on' })).toThrow(JobDefaultsError);
  });
});

describe('effective defaults', () => {
  it('are the cluster\'s where the node sets nothing, the node\'s where it does', () => {
    const cluster = { ...BUILT_IN_JOB_DEFAULTS, model: 'opus' };
    expect(effectiveJobDefaults(cluster, {})).toEqual(cluster);
    expect(effectiveJobDefaults(cluster, { useWorktree: false, usageDelay: { credits: true } })).toEqual({
      ...cluster,
      useWorktree: false,
      usageDelay: { ...cluster.usageDelay, credits: true },
    });
  });
});

describe('a job\'s settings', () => {
  it('follow a changed default where the job left them, and keep the job\'s own where it did not', () => {
    const job: JobSettingOverrides = { ...leavesAll, model: 'haiku', usageDelay: { ...leavesAll.usageDelay, weekly: false } };
    expect(effectiveJobSettings(job, BUILT_IN_JOB_DEFAULTS)).toMatchObject({ useWorktree: true, model: 'haiku', usageDelay: { session: true, weekly: false } });

    const changed = { ...BUILT_IN_JOB_DEFAULTS, useWorktree: false, model: 'opus', usageDelay: { session: false, weekly: true, fable: false, credits: false } };
    expect(effectiveJobSettings(job, changed)).toMatchObject({ useWorktree: false, model: 'haiku', usageDelay: { session: false, weekly: false } });
  });

  it('treat a blank model as the job\'s own choice of the CLI default, not as following', () => {
    expect(effectiveJobSettings({ ...leavesAll, model: '' }, { ...BUILT_IN_JOB_DEFAULTS, model: 'opus' }).model).toBe('');
  });
});

describe('commands before the prompt', () => {
  const install = ['pnpm install --frozen-lockfile'];

  it('are a list of single lines, trimmed and in order, with blank ones dropped', () => {
    expect(parsePrePromptCommands([' pnpm install ', '', '  ', 'pnpm build'])).toEqual({ commands: ['pnpm install', 'pnpm build'] });
    expect(parsePrePromptCommands([])).toEqual({ commands: [] });
    for (const bad of ['pnpm install', [1], ['a\nb'], ['a\rb'], ['a\u0000b'], Array(MAX_PRE_PROMPT_COMMANDS + 1).fill('true'), ['x'.repeat(5000)]]) {
      expect(parsePrePromptCommands(bad)).toHaveProperty('error');
    }
  });

  it('start empty on the cluster, and a stored set from before them reads as empty', () => {
    expect(BUILT_IN_JOB_DEFAULTS.prePromptCommands).toEqual([]);
    expect(readJobDefaults({ model: 'opus' }).prePromptCommands).toEqual([]);
    expect(readJobDefaults({ prePromptCommands: 'not a list' }).prePromptCommands).toEqual([]);
  });

  it('change on the cluster when a save sends them, and null puts them back to none', () => {
    const set = patchJobDefaults(BUILT_IN_JOB_DEFAULTS, { prePromptCommands: install });
    expect(set.prePromptCommands).toEqual(install);
    expect(patchJobDefaults(set, { model: 'opus' }).prePromptCommands).toEqual(install);
    expect(patchJobDefaults(set, { prePromptCommands: null }).prePromptCommands).toEqual([]);
    expect(() => patchJobDefaults(set, { prePromptCommands: ['a\nb'] })).toThrow(JobDefaultsError);
  });

  it('follow the cluster on a node that sets none, and an empty list on a node is its own', () => {
    const cluster = { ...BUILT_IN_JOB_DEFAULTS, prePromptCommands: install };
    expect(effectiveJobDefaults(cluster, {}).prePromptCommands).toEqual(install);
    expect(effectiveJobDefaults(cluster, { prePromptCommands: [] }).prePromptCommands).toEqual([]);
    expect(effectiveJobDefaults(cluster, { prePromptCommands: ['make'] }).prePromptCommands).toEqual(['make']);

    const none = patchJobDefaultsOverride({}, { prePromptCommands: [] });
    expect(none).toEqual({ prePromptCommands: [] });
    expect(readJobDefaultsOverride(none)).toEqual({ prePromptCommands: [] });
    expect(patchJobDefaultsOverride(none, { prePromptCommands: null })).toEqual({});
    expect(() => patchJobDefaultsOverride({}, { prePromptCommands: 'make' })).toThrow(JobDefaultsError);
  });

  it('follow the node for a job that leaves them null, and an empty list on a job runs nothing', () => {
    const defaults = { ...BUILT_IN_JOB_DEFAULTS, prePromptCommands: install };
    expect(effectiveJobSettings(leavesAll, defaults).prePromptCommands).toEqual(install);
    expect(effectiveJobSettings({ ...leavesAll, prePromptCommands: [] }, defaults).prePromptCommands).toEqual([]);
    expect(effectiveJobSettings({ ...leavesAll, prePromptCommands: ['make'] }, defaults).prePromptCommands).toEqual(['make']);
  });

  it('are stored as the job gave them: missing or null follows, and a list is kept, empty or not', () => {
    expect(jobSettingOverrides({}).prePromptCommands).toBeNull();
    expect(jobSettingOverrides({ prePromptCommands: null }).prePromptCommands).toBeNull();
    expect(jobSettingOverrides({ prePromptCommands: [] }).prePromptCommands).toEqual([]);
    expect(jobSettingOverrides({ prePromptCommands: install }).prePromptCommands).toEqual(install);
  });
});
