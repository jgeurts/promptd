import { describe, expect, it } from 'vitest';

import { MAX_FEEDBACK_LENGTH, feedbackExecution, feedbackPrompt, readFeedbackForm } from '../src/feedback.js';

describe('readFeedbackForm', () => {
  it('accepts a bug or a suggestion with details', () => {
    expect(readFeedbackForm({ kind: 'bug', details: '  Run now does nothing  ' })).toEqual({
      errors: [],
      value: { kind: 'bug', details: 'Run now does nothing' },
    });
    expect(readFeedbackForm({ kind: 'suggestion', details: 'Dark mode' }).value?.kind).toBe('suggestion');
  });

  it('rejects an unknown type, empty details, and details past the limit', () => {
    expect(readFeedbackForm({ kind: 'question', details: 'x' }).value).toBeNull();
    expect(readFeedbackForm({ kind: 'toString', details: 'x' }).value).toBeNull();
    expect(readFeedbackForm({ kind: 'bug', details: '   ' }).errors).toEqual(['Details are required.']);
    expect(readFeedbackForm({ kind: 'bug', details: 'x'.repeat(MAX_FEEDBACK_LENGTH + 1) }).value).toBeNull();
  });
});

describe('feedbackPrompt', () => {
  it('asks for the tagged title on the checkout remote and fences the report', () => {
    const prompt = feedbackPrompt('suggestion', 'Add a dark mode');
    expect(prompt).toContain('"[SUGGESTION] "');
    expect(prompt).toContain('git remote get-url origin');
    expect(prompt).toContain('gh issue create');
    expect(prompt).toContain('<report>\nAdd a dark mode\n</report>');
  });
});

describe('feedbackExecution', () => {
  it('is armed, dated now, and runs in the project folder', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const input = feedbackExecution('bug', 'The bell badge never clears\nmore detail', '/srv/promptd', now);
    expect(input.name).toBe('[BUG] The bell badge never clears');
    expect(input.scheduledAt).toBe(now.toISOString());
    expect(input.workingDirectory).toBe('/srv/promptd');
    expect(input.isActive).toBe(true);
    expect(input.useWorktree).toBe(false);
  });

  it('shortens a long first line for the name', () => {
    const input = feedbackExecution('bug', 'a'.repeat(200), '/srv/promptd');
    expect(input.name.length).toBeLessThanOrEqual('[BUG] '.length + 60);
  });
});
