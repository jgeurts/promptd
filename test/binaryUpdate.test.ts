import { describe, expect, it } from 'vitest';

import { GIVE_UP_AFTER_MS, HOLD_AFTER_MS, checksumFor, nextUpdateStep, releaseTag, underLaunchd, versionOfTag } from '../src/binaryUpdate.js';

describe('release tags', () => {
  it('name a build after its commit, and read it back', () => {
    expect(releaseTag('a91f126')).toBe('build-a91f126');
    expect(versionOfTag('build-a91f126')).toBe('a91f126');
  });

  it('are not builds when they lack the prefix', () => {
    expect(versionOfTag('v1.0.0')).toBeNull();
  });
});

describe('checksumFor', () => {
  const sums = [
    'AAA111  promptd-darwin-arm64',
    'ccc333  install.sh',
    '',
  ].join('\n');

  it('finds the file, lowercased', () => {
    expect(checksumFor(sums, 'promptd-darwin-arm64')).toBe('aaa111');
    expect(checksumFor(sums, 'install.sh')).toBe('ccc333');
  });

  it('answers null for a file it does not list', () => {
    expect(checksumFor(sums, 'promptd-darwin-arm')).toBeNull();
  });
});

describe('underLaunchd', () => {
  it('is true for a launchd job and false in a terminal', () => {
    expect(underLaunchd({ XPC_SERVICE_NAME: 'local.promptd.node' })).toBe(true);
    expect(underLaunchd({ XPC_SERVICE_NAME: '0' })).toBe(false);
    expect(underLaunchd({})).toBe(false);
  });
});

describe('nextUpdateStep', () => {
  it('restarts the moment nothing is running, however long it has waited', () => {
    expect(nextUpdateStep({ running: 0, waitedMs: 0, holding: false })).toBe('restart');
    expect(nextUpdateStep({ running: 0, waitedMs: GIVE_UP_AFTER_MS, holding: true })).toBe('restart');
  });

  it('waits while runs go on, without holding new ones for the first hour', () => {
    expect(nextUpdateStep({ running: 2, waitedMs: HOLD_AFTER_MS - 1, holding: false })).toBe('wait');
  });

  it('holds new runs once it has waited an hour, and only once', () => {
    expect(nextUpdateStep({ running: 1, waitedMs: HOLD_AFTER_MS, holding: false })).toBe('hold');
    expect(nextUpdateStep({ running: 1, waitedMs: HOLD_AFTER_MS, holding: true })).toBe('wait');
  });

  it('gives up after four hours of runs', () => {
    expect(nextUpdateStep({ running: 1, waitedMs: GIVE_UP_AFTER_MS, holding: true })).toBe('give up');
  });
});
