import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { claudeConfigFile, readAccount, reportedAccount } from '../src/account.js';

describe('claudeConfigFile', () => {
  it('reads beside CLAUDE_CONFIG_DIR when it is set', () => {
    expect(claudeConfigFile({ CLAUDE_CONFIG_DIR: '/opt/claude' })).toBe(path.join('/opt/claude', '.claude.json'));
  });

  it('falls back to the home directory', () => {
    expect(claudeConfigFile({})).toBe(path.join(os.homedir(), '.claude.json'));
  });
});

describe('readAccount', () => {
  it('keeps the account id and the email, and nothing else', () => {
    const config = {
      numStartups: 4,
      oauthAccount: { accountUuid: 'acct-1', emailAddress: 'alex@example.com', displayName: 'Alex', organizationName: 'Org' },
    };
    expect(readAccount(config)).toEqual({ id: 'acct-1', email: 'alex@example.com' });
  });

  it('answers null when the CLI is signed out', () => {
    expect(readAccount({ numStartups: 4 })).toBeNull();
    expect(readAccount({ oauthAccount: null })).toBeNull();
    expect(readAccount(null)).toBeNull();
  });

  it('answers null for an account missing either field', () => {
    expect(readAccount({ oauthAccount: { accountUuid: 'acct-1' } })).toBeNull();
    expect(readAccount({ oauthAccount: { emailAddress: 'alex@example.com' } })).toBeNull();
  });
});

describe('reportedAccount', () => {
  it('accepts what a node sends and refuses anything else', () => {
    expect(reportedAccount({ id: 'acct-1', email: 'alex@example.com', extra: true })).toEqual({ id: 'acct-1', email: 'alex@example.com' });
    expect(reportedAccount({ id: 42, email: 'alex@example.com' })).toBeNull();
    expect(reportedAccount(undefined)).toBeNull();
  });
});
