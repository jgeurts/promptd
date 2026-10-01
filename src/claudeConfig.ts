import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the Claude CLI keeps the account it is signed in as and that account's
 * login, found the way the CLI finds them, so the account a node names and the
 * usage it reads can only ever be the same account.
 *
 * CLAUDE_CONFIG_DIR gives a login a directory of its own, and everything moves
 * with it: the config holding `oauthAccount`, `.credentials.json`, and the macOS
 * Keychain entry, which the CLI names after the directory. Nothing here falls
 * back to the default directory's login, because that is another account's.
 */
export interface ClaudeConfigLocation {
  dir: string;
  /** True when CLAUDE_CONFIG_DIR points the CLI at a directory of its own. */
  custom: boolean;
  /** The config holding `oauthAccount`: inside a custom directory, beside the default one. */
  configFile: string;
  credentialsFile: string;
  keychainService: string;
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * The CLI (checked against 2.1.286) appends the first eight hex digits of the
 * SHA-256 of CLAUDE_CONFIG_DIR, exactly as set and NFC-normalized, to its
 * Keychain service name, so the variable is hashed here as given rather than
 * resolved to a tidier path that would hash differently.
 */
export function claudeConfig(env: NodeJS.ProcessEnv = process.env): ClaudeConfigLocation {
  const given = env.CLAUDE_CONFIG_DIR;
  if (!given) {
    const dir = path.join(os.homedir(), '.claude');
    return {
      dir,
      custom: false,
      configFile: path.join(os.homedir(), '.claude.json'),
      credentialsFile: path.join(dir, '.credentials.json'),
      keychainService: KEYCHAIN_SERVICE,
    };
  }
  const dir = given.normalize('NFC');
  const suffix = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  return {
    dir,
    custom: true,
    configFile: path.join(dir, '.claude.json'),
    credentialsFile: path.join(dir, '.credentials.json'),
    keychainService: `${KEYCHAIN_SERVICE}-${suffix}`,
  };
}
