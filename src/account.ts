import fsp from 'node:fs/promises';
import { claudeConfig } from './claudeConfig.js';
import type { ClaudeAccount } from './types.js';

/**
 * The Claude account this machine's CLI is signed in as.
 *
 * Claude Code writes it into its own config under `oauthAccount`, beside a great
 * deal else. Only the account id and the email are read out of it, and only
 * those two reach the hub: enough to tell two nodes on one account from two on
 * different ones, and to name the account in the header.
 */

/** A sign-in can change under a running node, but not often enough to read the file every sync. */
const REREAD_MS = 60 * 1000;

/** The account in a parsed config, or null when it names none: signed out, or a shape we do not know. */
export function readAccount(config: unknown): ClaudeAccount | null {
  const oauth = (config as { oauthAccount?: { accountUuid?: unknown; emailAddress?: unknown } | null } | null)?.oauthAccount;
  const id = typeof oauth?.accountUuid === 'string' ? oauth.accountUuid.trim() : '';
  const email = typeof oauth?.emailAddress === 'string' ? oauth.emailAddress.trim() : '';
  return id && email ? { id, email } : null;
}

/** An account as a node reported it, checked on the hub before anything is drawn from it. */
export function reportedAccount(value: unknown): ClaudeAccount | null {
  const given = value as Partial<ClaudeAccount> | null | undefined;
  const id = typeof given?.id === 'string' ? given.id.trim() : '';
  const email = typeof given?.email === 'string' ? given.email.trim() : '';
  return id && email ? { id, email } : null;
}

/**
 * One read of the config. `verified` says the file itself answered: an account,
 * or none because there is no file or it names none. When it could not be
 * read or parsed, `verified` is false and `account` is the one read last time,
 * which is fine to keep showing but proves nothing about whose login is there now.
 */
export interface IdentityRead {
  verified: boolean;
  account: ClaudeAccount | null;
}

export class AccountMonitor {
  private current: ClaudeAccount | null;
  private readAt: number;
  private reading: Promise<IdentityRead> | null;
  private configFile: () => string;

  public constructor(configFile: () => string = () => claudeConfig().configFile) {
    this.current = null;
    this.readAt = 0;
    this.reading = null;
    this.configFile = configFile;
  }

  /** The account as last read, re-read once the last read is a minute old. Never throws. */
  public async state(): Promise<ClaudeAccount | null> {
    if (Date.now() - this.readAt < REREAD_MS) return this.current;
    this.reading ??= this.reread().finally(() => {
      this.reading = null;
    });
    return (await this.reading).account;
  }

  /**
   * Reads the config now, never joining a read already under way, so a caller
   * checking who is signed in after it has done something gets an answer from
   * after that. A usage lookup reads this on both sides of reading the login.
   */
  public async reread(): Promise<IdentityRead> {
    const read = await fsp
      .readFile(this.configFile(), 'utf8')
      .then((text): IdentityRead => ({ verified: true, account: readAccount(JSON.parse(text)) }))
      // No file is no account. One that cannot be read or will not parse, most
      // likely the CLI halfway through rewriting it, leaves the last account
      // standing for display, unverified.
      .catch((err: NodeJS.ErrnoException): IdentityRead => (err.code === 'ENOENT' ? { verified: true, account: null } : { verified: false, account: this.current }));
    this.current = read.account;
    this.readAt = Date.now();
    return read;
  }
}

export const accountMonitor = new AccountMonitor();
