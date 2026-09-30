import { describe, expect, it } from 'vitest';

import { readCronForm, readExecutionForm } from '../src/jobForms.js';
import { MAX_TITLE_LENGTH, TITLE_INSTRUCTION, TITLE_SYSTEM_PROMPT, cleanTitle, nameFromPrompt, titlePrompt } from '../src/naming.js';

describe('nameFromPrompt', () => {
  it('takes the first sentence, cut to about six words', () => {
    expect(nameFromPrompt('Fix the flaky login test. It fails on CI about once a day.')).toBe('Fix the flaky login test');
    expect(nameFromPrompt('Summarize yesterday\'s merged pull requests for the weekly changelog')).toBe('Summarize yesterday\'s merged pull requests');
  });

  it('stops before a word that would leave the name hanging', () => {
    expect(nameFromPrompt('Write a short summary of the release notes')).toBe('Write a short summary');
  });

  it('ends a sentence at a line break and drops a heading or list marker', () => {
    expect(nameFromPrompt('\n\n# review open PRs\nthen post a summary')).toBe('Review open PRs');
    expect(nameFromPrompt('- bump dependencies, run the tests')).toBe('Bump dependencies, run the tests');
  });

  it('keeps a slash command as written', () => {
    expect(nameFromPrompt('/babysit-pr 42')).toBe('/babysit-pr 42');
  });

  it('falls back when the prompt has no words', () => {
    expect(nameFromPrompt('  ...  ')).toBe('Untitled job');
  });
});

describe('the title from claude', () => {
  it('is asked for with the prompt, cut to 4,000 characters, fenced as the task to name', () => {
    const asked = titlePrompt('x'.repeat(5000));
    expect(asked).toBe(`<task>\n${'x'.repeat(4000)}\n</task>`);
    expect(TITLE_SYSTEM_PROMPT.startsWith(TITLE_INSTRUCTION)).toBe(true);
  });

  it('is tidied of quotes and markdown, and refused when empty or too long', () => {
    expect(cleanTitle('  "Flaky Login Test Fix."\n')).toBe('Flaky Login Test Fix');
    expect(cleanTitle('**Title:** Weekly changelog')).toBe('Weekly changelog');
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle('x'.repeat(MAX_TITLE_LENGTH + 1))).toBeNull();
    expect(cleanTitle(undefined)).toBeNull();
  });
});

describe('a job saved without a name', () => {
  it('is named from its prompt and marked inferred', () => {
    const { errors, value } = readCronForm({ name: '  ', cron: '0 9 * * *', prompt: 'Rotate the staging keys. Then tell me.' });
    expect(errors).toEqual([]);
    expect(value).toMatchObject({ name: 'Rotate the staging keys', nameInferred: true });
  });

  it('keeps a name it was given, unmarked', () => {
    const { value } = readExecutionForm({ name: 'Keys', scheduledAt: '2026-10-01T08:00:00.000Z', prompt: 'Rotate the staging keys.' });
    expect(value).toMatchObject({ name: 'Keys', nameInferred: false });
  });

  it('with no prompt either, says the prompt is required', () => {
    expect(readCronForm({ cron: '0 9 * * *' }).errors).toEqual(['Prompt is required.']);
  });
});

describe('a one-time execution saved as soon as possible', () => {
  const now = new Date('2026-09-30T18:00:00.000Z');

  it('is dated now and waits for the session limit, whatever the form sent', () => {
    const { errors, value } = readExecutionForm(
      { asSoonAsPossible: true, scheduledAt: '', prompt: 'Rotate the staging keys.', usageDelay: { session: false, weekly: true } },
      now,
    );
    expect(errors).toEqual([]);
    expect(value.scheduledAt).toBe(now.toISOString());
    expect(value.usageDelay).toEqual({ session: true, weekly: true, fable: null, credits: null });
  });

  it('leaves a job saved for a time to its own date and to the defaults', () => {
    const { value } = readExecutionForm({ scheduledAt: '2026-10-01T08:00:00.000Z', prompt: 'Rotate the staging keys.' }, now);
    expect(value.scheduledAt).toBe('2026-10-01T08:00:00.000Z');
    expect(value.usageDelay.session).toBeNull();
    expect(readExecutionForm({ prompt: 'x' }, now).errors).toEqual(['Date and time are required.']);
  });
});
