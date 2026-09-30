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

class AccountMonitor {
  private current: ClaudeAccount | null;
  private readAt: number;
  private reading: Promise<ClaudeAccount | null> | null;

  public constructor() {
    this.current = null;
    this.readAt = 0;
    this.reading = null;
  }

  /** The account as last read, re-read once the last read is a minute old. Never throws. */
  public async state(): Promise<ClaudeAccount | null> {
    if (Date.now() - this.readAt < REREAD_MS) return this.current;
    return this.reread();
  }

  /**
   * Reads the config now. A usage lookup calls this just before it reads the
   * login, so its numbers are recorded against the account they belong to and
   * this monitor learns of a new sign-in at the same moment.
   */
  public reread(): Promise<ClaudeAccount | null> {
    this.reading ??= fsp
      .readFile(claudeConfig().configFile, 'utf8')
      .then((text) => readAccount(JSON.parse(text)))
      // No file is no account. One that will not parse is most likely the CLI
      // halfway through rewriting it, so the account read last time stands.
      .catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : this.current))
      .then((account) => {
        this.current = account;
        this.readAt = Date.now();
        this.reading = null;
        return account;
      });
    return this.reading;
  }
}

export const accountMonitor = new AccountMonitor();
