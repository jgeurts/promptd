import { describe, expect, it } from 'vitest';
import { BUILT_IN_JOB_DEFAULTS } from '../src/jobDefaults.js';
import { NodeConfigError, effectiveNodeConfig, patchNodeConfig, readNodeConfig } from '../src/nodeConfig.js';

const DEFAULTS = { session: 90, weekly: 95, fable: 95, credits: 90 };

describe('node config', () => {
  it('falls back to the node processor count, default thresholds and home', () => {
    expect(effectiveNodeConfig({}, 10)).toMatchObject({ maxConcurrentJobs: 10, usageDelayThresholds: DEFAULTS, defaultWorkingDirectory: '~/' });
  });

  it('lays its own job defaults over the cluster\'s, and null puts one back', () => {
    const cluster = { ...BUILT_IN_JOB_DEFAULTS, model: 'opus' };
    const config = patchNodeConfig({}, { jobDefaults: { model: 'sonnet', usageDelay: { weekly: true } } });
    expect(config).toEqual({ jobDefaults: { model: 'sonnet', usageDelay: { weekly: true } } });
    expect(effectiveNodeConfig(config, 4, cluster).jobDefaults).toMatchObject({ model: 'sonnet', useWorktree: true, usageDelay: { session: true, weekly: true } });

    const reset = patchNodeConfig(config, { jobDefaults: { model: null } });
    expect(effectiveNodeConfig(reset, 4, cluster).jobDefaults).toMatchObject({ model: 'opus', usageDelay: { weekly: true } });
    expect(patchNodeConfig(reset, { jobDefaults: { usageDelay: { weekly: null } } })).toEqual({});
    expect(patchNodeConfig(config, { jobDefaults: null })).toEqual({});
  });

  it('keeps a node\'s empty list of commands as its own, apart from following the cluster\'s', () => {
    const cluster = { ...BUILT_IN_JOB_DEFAULTS, prePromptCommands: ['pnpm install'] };
    expect(effectiveNodeConfig({}, 4, cluster).jobDefaults.prePromptCommands).toEqual(['pnpm install']);
    const none = patchNodeConfig({}, { jobDefaults: { prePromptCommands: [] } });
    expect(readNodeConfig(JSON.stringify(none))).toEqual({ jobDefaults: { prePromptCommands: [] } });
    expect(effectiveNodeConfig(none, 4, cluster).jobDefaults.prePromptCommands).toEqual([]);
    expect(patchNodeConfig(none, { jobDefaults: { prePromptCommands: null } })).toEqual({});
    expect(() => patchNodeConfig({}, { jobDefaults: { prePromptCommands: ['a\nb'] } })).toThrow(NodeConfigError);
  });

  it('refuses a job default that is not one', () => {
    expect(() => patchNodeConfig({}, { jobDefaults: { useWorktree: 'yes' } })).toThrow(NodeConfigError);
    expect(() => patchNodeConfig({}, { jobDefaults: { effort: 'enormous' } })).toThrow(NodeConfigError);
  });

  it('keeps the thresholds a patch leaves out, and drops a set back at the defaults', () => {
    const lowered = patchNodeConfig({}, { usageDelayThresholds: { session: 50 } });
    expect(lowered.usageDelayThresholds).toEqual({ ...DEFAULTS, session: 50 });
    expect(patchNodeConfig(lowered, { usageDelayThresholds: { session: 90 } })).toEqual({});
  });

  it('resets a key given null, and treats a home working directory as the default', () => {
    const config = patchNodeConfig({}, { maxConcurrentJobs: 3, defaultWorkingDirectory: ' ~/code ' });
    expect(config).toEqual({ maxConcurrentJobs: 3, defaultWorkingDirectory: '~/code' });
    expect(patchNodeConfig(config, { maxConcurrentJobs: null, defaultWorkingDirectory: '~/' })).toEqual({});
  });

  it('refuses a limit or threshold out of range', () => {
    expect(() => patchNodeConfig({}, { maxConcurrentJobs: -1 })).toThrow(NodeConfigError);
    expect(() => patchNodeConfig({}, { usageDelayThresholds: { weekly: 101 } })).toThrow(NodeConfigError);
  });

  it('reads a stored config, dropping what it cannot use', () => {
    expect(readNodeConfig('{"maxConcurrentJobs":"x","defaultWorkingDirectory":"~/src"}')).toEqual({ defaultWorkingDirectory: '~/src' });
    expect(readNodeConfig('not json')).toEqual({});
  });
});
