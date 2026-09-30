import { describe, expect, it } from 'vitest';

import { assetName, checksumFor, releaseTag, underLaunchd, versionOfTag } from '../src/binaryUpdate.js';

describe('release tags', () => {
  it('name a build after its commit, and read it back', () => {
    expect(releaseTag('a91f126')).toBe('build-a91f126');
    expect(versionOfTag('build-a91f126')).toBe('a91f126');
  });

  it('are not builds when they lack the prefix', () => {
    expect(versionOfTag('v1.0.0')).toBeNull();
  });
});

describe('assetName', () => {
  it('picks the file for the architecture', () => {
    expect(assetName('arm64')).toBe('promptd-darwin-arm64');
    expect(assetName('x64')).toBe('promptd-darwin-x64');
  });
});

describe('checksumFor', () => {
  const sums = [
    'AAA111  promptd-darwin-arm64',
    'bbb222  promptd-darwin-x64',
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
