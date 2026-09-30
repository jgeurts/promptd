import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_JOB_DEFAULTS,
  JobDefaultsError,
  effectiveJobDefaults,
  effectiveJobSettings,
  patchJobDefaults,
  readJobDefaults,
} from '../src/jobDefaults.js';
import type { JobSettingOverrides } from '../src/types.js';

const leavesAll: JobSettingOverrides = {
  useWorktree: null,
  cleanupWorktree: null,
  retrospective: null,
  model: null,
  effort: null,
  usageDelay: { session: null, weekly: null, fable: null, credits: null },
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
