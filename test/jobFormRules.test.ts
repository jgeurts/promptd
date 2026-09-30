import { describe, expect, it } from 'vitest';

import { scheduledAtForSave } from '../src/jobFormRules.js';

/** The field's value for an instant, in this clock's zone, as the page fills it. */
function shown(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe('the date an edit sends', () => {
  const saved = '2026-09-30T18:00:47.123Z';

  it('is the saved instant, seconds and all, while the field is left as it opened', () => {
    expect(scheduledAtForSave(saved, shown(saved), shown(saved))).toBe(saved);
  });

  it('is the field\'s time once it is changed', () => {
    const later = shown('2026-10-01T09:30:00.000Z');
    expect(scheduledAtForSave(saved, shown(saved), later)).toBe(new Date(later).toISOString());
  });

  it('is the field\'s time for a new or duplicated execution, which has nothing saved', () => {
    const typed = shown(saved);
    expect(scheduledAtForSave(null, typed, typed)).toBe(new Date(typed).toISOString());
    expect(scheduledAtForSave(null, typed, '')).toBe('');
  });
});
