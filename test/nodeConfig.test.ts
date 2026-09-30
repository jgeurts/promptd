import { describe, expect, it } from 'vitest';
import { NodeConfigError, effectiveNodeConfig, legacyNodeConfig, patchNodeConfig, readNodeConfig } from '../src/nodeConfig.js';

const DEFAULTS = { session: 90, weekly: 95, fable: 95, credits: 90 };

describe('node config', () => {
  it('falls back to the node processor count, default thresholds and home', () => {
    expect(effectiveNodeConfig({}, 10)).toEqual({ maxConcurrentJobs: 10, usageDelayThresholds: DEFAULTS, defaultWorkingDirectory: '~/' });
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

  it('carries over old hub-wide values, except the ones still at their defaults', () => {
    expect(legacyNodeConfig({ maxConcurrentJobs: 2, usageDelayThresholds: DEFAULTS, defaultWorkingDirectory: '~/' }, 2)).toEqual({});
    expect(legacyNodeConfig({ maxConcurrentJobs: 4, usageDelayThresholds: { ...DEFAULTS, weekly: 80 }, defaultWorkingDirectory: '~/dev' }, 2)).toEqual({
      maxConcurrentJobs: 4,
      usageDelayThresholds: { ...DEFAULTS, weekly: 80 },
      defaultWorkingDirectory: '~/dev',
    });
  });
});
