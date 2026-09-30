import { describe, expect, it } from 'vitest';

import { isEffortLevel, isTimeZone, pauseOption, previewNextRun, validateCronExpression } from '../src/schedule.js';

describe('validateCronExpression', () => {
  it('accepts a five-field expression', () => {
    expect(validateCronExpression('0 9 * * *')).toEqual({ ok: true });
  });

  it('rejects garbage with the parser message', () => {
    const result = validateCronExpression('not a cron');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('previewNextRun', () => {
  it('answers a future ISO time for a valid expression', () => {
    const next = previewNextRun('*/5 * * * *');
    expect(next).not.toBeNull();
    expect(Date.parse(next ?? '')).toBeGreaterThan(Date.now());
  });

  it('answers null for an invalid expression', () => {
    expect(previewNextRun('nope')).toBeNull();
  });
});

describe('options', () => {
  it('finds pause lengths by id and rejects unknown ones', () => {
    expect(pauseOption('1h')?.ms).toBe(60 * 60 * 1000);
    expect(pauseOption('restart')?.ms).toBeNull();
    expect(pauseOption('forever')).toBeNull();
  });

  it('knows the CLI effort levels', () => {
    expect(isEffortLevel('xhigh')).toBe(true);
    expect(isEffortLevel('extreme')).toBe(false);
  });
});

describe('previewNextRun in a time zone', () => {
  const hourIn = (zone: string, iso: string): number =>
    Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)));

  it('fires 5:00 written in Chicago at 6:00 in New York, whatever the clock it runs on', () => {
    const next = previewNextRun('0 5 * * *', 'America/Chicago')!;
    expect(hourIn('America/Chicago', next)).toBe(5);
    expect(hourIn('America/New_York', next)).toBe(6);
  });

  it('knows a time zone from a name that is not one', () => {
    expect(isTimeZone('America/Chicago')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});
