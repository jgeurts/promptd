import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

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
  const usage = new UsageMonitor({ lookup, account: async () => current, freshAccount: async () => current, cacheFile: file });
  return { usage, signIn: (account) => (current = account) };
}

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
