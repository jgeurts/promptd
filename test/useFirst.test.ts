import { describe, expect, it } from 'vitest';

import { useFirst, type UseFirstComputer, type UseFirstLimit } from '../src/useFirst.js';

const NOW = Date.parse('2026-10-08T14:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const inHours = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

function week(usedPercent: number, resetsInHours: number, status = 'ok'): UseFirstLimit {
  return { kind: 'weekly_all', usedPercent, status, resetsAt: inHours(resetsInHours) };
}

function session(usedPercent: number, resetsInHours: number | null, status = 'ok'): UseFirstLimit {
  return { kind: 'session', usedPercent, status, resetsAt: resetsInHours === null ? null : inHours(resetsInHours) };
}

function computer(id: string, accountKey: string | null, windows: UseFirstLimit[], extra: Partial<UseFirstComputer> = {}): UseFirstComputer {
  return { id, online: true, accountKey, reading: { stale: false, windows }, ...extra };
}

/** Thursday morning: galaxy's week resets Friday with 28% left, the others on Saturday and Sunday. */
const thursday = (galaxy: UseFirstLimit[] = [session(0, null), week(72, 17)]) => [
  computer('roundhead', 'account:a', [session(12, 4), week(30, 53)]),
  computer('galaxy', 'account:b', galaxy),
  computer('nebula', 'account:c', [session(5, 2), week(18, 70)]),
];

describe('the account to use first', () => {
  it('is the one whose week resets a day or more before the others, with what it has left', () => {
    expect(useFirst(thursday(), NOW)).toEqual({ accountKey: 'account:b', nodeIds: ['galaxy'], leftPercent: 28, resetsAt: inHours(17) });
  });

  it('names every online computer on that account', () => {
    const computers = [...thursday(), computer('laptop', 'account:b', [session(0, null), week(72, 17)]), computer('old-mac', 'account:b', [], { online: false })];
    expect(useFirst(computers, NOW)?.nodeIds).toEqual(['galaxy', 'laptop']);
  });

  it('is nobody when the soonest reset is less than a day ahead of the next', () => {
    expect(useFirst(thursday([session(0, null), week(72, 40)]), NOW)).toBeNull();
  });

  it('is nobody when only one account has room, since there is nothing to compare', () => {
    const today = [
      computer('roundhead', 'account:a', [session(0, null), week(100, 11, 'reached')]),
      computer('galaxy', 'account:b', [session(0, null), week(39, 144)]),
      computer('nebula', 'account:c', [session(0, null), week(100, 29, 'reached')]),
    ];
    expect(useFirst(today, NOW)).toBeNull();
  });

  it('skips a week with less than 10% left, or one near its hold line', () => {
    expect(useFirst(thursday([session(0, null), week(91, 17)]), NOW)).toBeNull();
    expect(useFirst(thursday([session(0, null), week(80, 17, 'near')]), NOW)).toBeNull();
    // 10% left still counts.
    expect(useFirst(thursday([session(0, null), week(90, 17)]), NOW)?.accountKey).toBe('account:b');
  });

  it('skips an account whose session is near or used up, unless it resets by the time the work starts', () => {
    const full = thursday([session(100, 3, 'reached'), week(72, 17)]);
    expect(useFirst(full, NOW)).toBeNull();
    expect(useFirst(full, NOW + 3 * HOUR)?.accountKey).toBe('account:b');
    expect(useFirst(thursday([session(92, 3, 'near'), week(72, 17)]), NOW)).toBeNull();
    // A full session with no reset time reported stays ruled out.
    expect(useFirst(thursday([session(100, null, 'reached'), week(72, 17)]), NOW + 3 * HOUR)).toBeNull();
  });

  it('skips a week that resets before the work starts, which the pick could not help', () => {
    const computers = [...thursday().slice(0, 2), computer('nebula', 'account:c', [session(5, 2), week(18, 80)])];
    expect(useFirst(computers, NOW)?.accountKey).toBe('account:b');
    // Run on Friday afternoon, after galaxy's week has reset: RoundHead's resets next, more than a day before nebula's.
    expect(useFirst(computers, NOW + 30 * HOUR)?.accountKey).toBe('account:a');
  });

  it('leaves out offline computers, stale readings and computers with no account', () => {
    const computers = thursday();
    expect(useFirst([{ ...computers[1]!, online: false }, computers[0]!, computers[2]!], NOW)).toBeNull();
    expect(useFirst([{ ...computers[1]!, reading: { stale: true, windows: [week(72, 17)] } }, computers[0]!, computers[2]!], NOW)).toBeNull();
    expect(useFirst([{ ...computers[1]!, accountKey: null }, computers[0]!, computers[2]!], NOW)).toBeNull();
  });

  it('reads a limit\'s kind from its key when an older reading has no kind', () => {
    const galaxy = [{ key: 'session:1', usedPercent: 0, status: 'ok', resetsAt: null }, { key: 'weekly_all:1', usedPercent: 72, status: 'ok', resetsAt: inHours(17) }];
    expect(useFirst(thursday(galaxy), NOW)?.accountKey).toBe('account:b');
  });
});
