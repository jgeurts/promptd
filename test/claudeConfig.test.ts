import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { claudeConfig } from '../src/claudeConfig.js';
import { accessToken } from '../src/usage.js';

const future = Date.now() + 60 * 60 * 1000;

function credentials(token: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: future } });
}

/** A keychain that holds the given entries and remembers which services were asked for. */
function keychain(entries: Record<string, string>): { asked: string[]; read: (service: string) => Promise<string | null> } {
  const asked: string[] = [];
  return { asked, read: async (service) => (asked.push(service), entries[service] ?? null) };
}

describe('claudeConfig', () => {
  it('uses the default login when CLAUDE_CONFIG_DIR is unset', () => {
    expect(claudeConfig({})).toEqual({
      dir: path.join(os.homedir(), '.claude'),
      custom: false,
      configFile: path.join(os.homedir(), '.claude.json'),
      credentialsFile: path.join(os.homedir(), '.claude', '.credentials.json'),
      keychainService: 'Claude Code-credentials',
    });
  });

  it('moves the config, the credentials file and the Keychain entry into CLAUDE_CONFIG_DIR', () => {
    expect(claudeConfig({ CLAUDE_CONFIG_DIR: '/Users/alex/.claude-work' })).toEqual({
      dir: '/Users/alex/.claude-work',
      custom: true,
      configFile: '/Users/alex/.claude-work/.claude.json',
      credentialsFile: '/Users/alex/.claude-work/.credentials.json',
      // The first eight hex digits of sha256("/Users/alex/.claude-work"), as the CLI names it.
      keychainService: 'Claude Code-credentials-c381b4cb',
    });
  });
});

describe('accessToken with CLAUDE_CONFIG_DIR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-claude-dir-'));
  const location = claudeConfig({ CLAUDE_CONFIG_DIR: dir });

  it("asks the Keychain for the directory's own entry", async () => {
    const store = keychain({ [location.keychainService]: credentials('work-token') });
    expect(await accessToken({ location, keychain: store.read, platform: 'darwin' })).toEqual({ token: 'work-token', reason: null });
    expect(store.asked).toEqual([location.keychainService]);
  });

  it("reads the directory's .credentials.json when the Keychain has no entry for it", async () => {
    fs.writeFileSync(location.credentialsFile, credentials('file-token'));
    try {
      const store = keychain({ 'Claude Code-credentials': credentials('personal-token') });
      expect((await accessToken({ location, keychain: store.read, platform: 'darwin' })).token).toBe('file-token');
    } finally {
      fs.rmSync(location.credentialsFile);
    }
  });

  it("never falls back to the default login, which is another account's", async () => {
    const store = keychain({ 'Claude Code-credentials': credentials('personal-token') });
    const answer = await accessToken({ location, keychain: store.read, platform: 'darwin' });
    expect(answer.token).toBeNull();
    expect(answer.reason).toContain(dir);
    expect(store.asked).not.toContain('Claude Code-credentials');
  });
});
