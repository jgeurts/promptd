import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETROSPECTIVE_PROMPT,
  RETROSPECTIVE_MARKER,
  RetrospectiveSplitter,
  hasRetrospectiveSection,
  retrospectivePrompt,
  retrospectiveSection,
  substantiveRetrospective,
} from '../src/retrospective.js';

function split(chunks: string[]): { output: string; retrospective: string | null } {
  const splitter = new RetrospectiveSplitter();
  let output = chunks.map((chunk) => splitter.push(chunk)).join('');
  output += splitter.flush();
  return { output, retrospective: splitter.retrospective };
}

describe('RetrospectiveSplitter', () => {
  it('passes output through untouched when no marker comes', () => {
    expect(split(['Done. See [[links]] ', 'and [x].'])).toEqual({ output: 'Done. See [[links]] and [x].', retrospective: null });
  });

  it('keeps everything after the marker out of the output', () => {
    const { output, retrospective } = split([`Task done.\n\n${RETROSPECTIVE_MARKER}\n1. What went well\nGrep found it.`]);
    expect(output).toBe('Task done.\n\n');
    expect(retrospective).toBe('\n1. What went well\nGrep found it.');
  });

  it('finds a marker split across chunks', () => {
    const marker = RETROSPECTIVE_MARKER;
    const { output, retrospective } = split(['Task done.\n', marker.slice(0, 5), marker.slice(5, 12), `${marker.slice(12)}\nNotes`]);
    expect(output).toBe('Task done.\n');
    expect(retrospective).toBe('\nNotes');
  });
});

describe('substantiveRetrospective', () => {
  const prompt = DEFAULT_RETROSPECTIVE_PROMPT;

  it('is null when the marker never came or nothing follows it', () => {
    expect(substantiveRetrospective(null, prompt)).toBeNull();
    expect(substantiveRetrospective('\n  \n', prompt)).toBeNull();
  });

  it('is null for the no-retrospective answer', () => {
    expect(substantiveRetrospective('\nNO RETROSPECTIVE\n', prompt)).toBeNull();
  });

  it('is null when every section says nothing to report', () => {
    const empty = [
      '## 1. What went well',
      'Nothing to report.',
      '**2. What could have gone better on your side**',
      '- None',
      '3. How I could have prompted better: nothing to report',
      '4. What you would change about what was asked',
      'N/A',
      'Carry forward',
      'Nothing.',
    ].join('\n');
    expect(substantiveRetrospective(empty, prompt)).toBeNull();
  });

  it('keeps a retrospective with one real point, trimmed', () => {
    const text = '\n1. What went well\nNothing to report.\n\n3. How I could have prompted better\nName the branch up front.\n';
    expect(substantiveRetrospective(text, prompt)).toBe(text.trim());
  });
});

describe('retrospectivePrompt', () => {
  it('falls back to the default when the setting is blank', () => {
    expect(retrospectivePrompt('  ')).toBe(DEFAULT_RETROSPECTIVE_PROMPT);
    expect(retrospectivePrompt(undefined)).toBe(DEFAULT_RETROSPECTIVE_PROMPT);
    expect(retrospectivePrompt('Be brief.')).toBe('Be brief.');
  });
});

describe('hasRetrospectiveSection', () => {
  it('finds the section the run writes', () => {
    expect(hasRetrospectiveSection(`--- output ---\nDone.${retrospectiveSection('Name the branch.')}`)).toBe(true);
    expect(hasRetrospectiveSection('--- output ---\nDone.\n')).toBe(false);
  });
});
