import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { AccountMonitor } from '../src/account.js';
import { UsageMonitor, readingFor } from '../src/usage.js';
import type { UsageLookup } from '../src/usage.js';
import type { ClaudeAccount, UsageWindow } from '../src/types.js';

const A: ClaudeAccount = { id: 'acct-a', email: 'a@example.com' };
const B: ClaudeAccount = { id: 'acct-b', email: 'b@example.com' };

function session(usedPercent: number, severity: UsageWindow['severity'] = 'normal'): UsageWindow {
  return { key: 'session:0', kind: 'session', scope: null, label: 'Session', detail: 'Current 5-hour session', usedPercent, severity, resetsAt: null };
}

function ok(usedPercent: number, severity: UsageWindow['severity'] = 'normal'): UsageLookup {
  return { ok: true, reason: null, windows: [session(usedPercent, severity)] };
}

function cacheFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-usage-')), 'usage-cache.json');
}

/** A monitor whose signed-in account the test switches, and whose lookups it answers. */
function monitor(lookup: () => Promise<UsageLookup>, file = cacheFile()): { usage: UsageMonitor; signIn: (account: ClaudeAccount | null) => void } {
  let current: ClaudeAccount | null = A;
  const usage = new UsageMonitor({ lookup, account: async () => current, identity: async () => ({ verified: true, account: current }), cacheFile: file });
  return { usage, signIn: (account) => (current = account) };
}

/** A Claude config on disk, read by a real AccountMonitor, as a node reads it. */
function configOnDisk(): { accounts: AccountMonitor; signIn: (account: ClaudeAccount) => void; lockOut: () => void; file: string } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-config-')), '.claude.json');
  const signIn = (account: ClaudeAccount): void => {
    fs.chmodSync(path.dirname(file), 0o700);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: account.id, emailAddress: account.email } }));
  };
  return { accounts: new AccountMonitor(() => file), signIn, lockOut: () => fs.chmodSync(file, 0o000), file };
}

const runsAsRoot = process.getuid?.() === 0;

describe('UsageMonitor across a change of account', () => {
  it("never serves the previous account's reading under the new one", async () => {
    const answers = [ok(99, 'critical'), ok(20)];
    const { usage, signIn } = monitor(async () => answers.shift()!);
    await usage.state();
    expect((await usage.settled()).windows[0]?.usedPercent).toBe(99);

    signIn(B);
    const switched = await usage.state();
    expect(switched.accountId).toBe(B.id);
    expect(switched.windows).toEqual([]);
    const fresh = await usage.settled();
    expect(fresh.windows[0]?.usedPercent).toBe(20);
    expect(fresh.accountId).toBe(B.id);
  });

  it('discards a lookup that lands after the account changed', async () => {
    let answer: (lookup: UsageLookup) => void = () => {};
    const { usage, signIn } = monitor(() => new Promise((resolve) => (answer = resolve)));
    await usage.state();
    await vi.waitFor(() => expect(usage.inFlight).not.toBeNull());

    signIn(B);
    await usage.state();
    answer(ok(99, 'critical'));
    const reading = await usage.settled();
    expect(reading.windows).toEqual([]);
    expect(reading.accountId).toBe(B.id);
    // Not a refresh window later: the new account is asked on the next poll.
    expect(usage.nextFetchAt).toBe(0);
  });

  it('keeps the account with the reading on disk, and ignores one kept for another account', async () => {
    const file = cacheFile();
    const first = monitor(async () => ok(99, 'critical'), file);
    await first.usage.state();
    await first.usage.settled();
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(file, 'utf8')).accountId).toBe(A.id));

    const never = vi.fn(() => new Promise<UsageLookup>(() => {}));
    const restarted = monitor(never, file);
    restarted.signIn(B);
    const reading = await restarted.usage.state();
    expect(reading.windows).toEqual([]);
    expect(reading.accountId).toBe(B.id);

    const same = monitor(never, file);
    expect((await same.usage.state()).windows[0]?.usedPercent).toBe(99);
  });

  // A permission error on the config left the monitor answering with the account
  // read last time, and the lookup then filed the new login's numbers under it.
  it.skipIf(runsAsRoot)('publishes nothing new when the config cannot be read, and marks the last verified reading stale', async () => {
    const config = configOnDisk();
    config.signIn(A);
    const answers = [ok(99, 'critical'), ok(20)];
    const lookup = vi.fn(async () => answers.shift()!);
    const file = cacheFile();
    const usage = new UsageMonitor({ lookup, account: () => config.accounts.state(), identity: () => config.accounts.reread(), cacheFile: file });
    await usage.state();
    expect((await usage.settled()).windows[0]?.usedPercent).toBe(99);

    // The login is now B's, and the config naming B cannot be read.
    config.signIn(B);
    config.lockOut();
    expect(await config.accounts.reread()).toEqual({ verified: false, account: A });
    usage.nextFetchAt = 0;
    await usage.state();
    const reading = await usage.settled();
    expect(reading.windows[0]?.usedPercent).toBe(99);
    expect(reading.accountId).toBe(A.id);
    expect(reading.stale).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ accountId: A.id, windows: [{ usedPercent: 99 }] }));
  });

  // With a readable config, a sign-in landing while the login was being read
  // let the lookup file the new account's numbers under the old one.
  it('discards a reading when the account changed while the login was read', async () => {
    const config = configOnDisk();
    config.signIn(A);
    let release: () => void = () => {};
    const slowLogin = new Promise<void>((resolve) => (release = resolve));
    const lookup = vi.fn(async () => (await slowLogin, ok(20)));
    const usage = new UsageMonitor({ lookup, account: () => config.accounts.state(), identity: () => config.accounts.reread(), cacheFile: cacheFile() });
    await usage.state();
    // A has been read as the account, and the login is being fetched, when B signs in.
    await vi.waitFor(() => expect(lookup).toHaveBeenCalled());

    config.signIn(B);
    release();
    const reading = await usage.settled();
    expect(reading.windows).toEqual([]);
    expect(reading.accountId).toBe(B.id);
    expect(usage.nextFetchAt).toBe(0);
  });

  it('treats a kept reading that names no account as nobody’s', async () => {
    const file = cacheFile();
    fs.writeFileSync(file, JSON.stringify({ windows: [session(99, 'critical')], checkedAt: new Date().toISOString() }));
    const { usage } = monitor(() => new Promise<UsageLookup>(() => {}), file);
    expect((await usage.state()).windows).toEqual([]);
  });
});

describe('readingFor', () => {
  const reading = { ok: true, reason: null, windows: [session(99, 'critical')], checkedAt: '2026-09-30T12:00:00.000Z', stale: false, accountId: A.id };

  it('sends a reading beside the account it belongs to', () => {
    expect(readingFor(A, reading)).toBe(reading);
  });

  it('sends it empty beside any other account', () => {
    expect(readingFor(B, reading)).toMatchObject({ windows: [], accountId: B.id, ok: false });
    expect(readingFor(null, reading).windows).toEqual([]);
  });
});
