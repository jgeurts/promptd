/**
 * The optional retrospective a job can ask for at the end of its run.
 *
 * A run is one headless `claude -p` turn, so the retrospective rides along as
 * an addendum to the prompt. The model is told to open it with a marker line;
 * the run's output is split on that marker, so the job's own output and the
 * retrospective land in separate sections of the log.
 */

/** The line the model writes before its retrospective. */
export const RETROSPECTIVE_MARKER = '[[promptd:retrospective]]';

/** What the model writes after the marker when it has nothing to say. */
export const NO_RETROSPECTIVE = 'NO RETROSPECTIVE';

/** The log section a retrospective with something in it is written under. */
export const RETROSPECTIVE_HEADING = '--- retrospective ---';
export const RETROSPECTIVE_END = '--- end of retrospective ---';

/** Used whenever the Retrospective prompt setting is blank. */
export const DEFAULT_RETROSPECTIVE_PROMPT = `Session retrospective

Review this session from my first message to now, then answer the four questions below in this reply only. Write nothing to disk, memory, or any tracker. Every point cites its moment: quote the message, or name the file, tool call, or error. A point without a citation gets cut. Rank each list by effect on the outcome, biggest first, five points at most. If early context was summarized away, say so and answer from what you can still see.

1. What went well
Which decisions, tools, or instructions produced good work fast, and why? Include any instruction of mine that was unusually clear, so I can reuse the pattern.

2. What could have gone better on your side
Where did you take a wrong turn, guess instead of checking, do more or less than asked, or spend time that bought nothing? For each: what you did, the better move, and the signal you had at the time that pointed to it.

3. How I could have prompted better
Where did my wording, missing context, or timing cost you? For each, write the message I should have sent instead, verbatim. Include anything you had to ask for or infer that I could have stated up front.

4. What you would change about what was asked
Was this the right task at the right scope? Name anything you would add, cut, or reorder, and anything I asked for that turned out unnecessary or risky.

Carry forward
Up to three lessons worth keeping beyond this session, one line each. List them here; I decide where they go.

Blunt beats kind, specific beats general, and "nothing to report" is a valid answer for any section.`;

/** The setting's text, or the default when it is blank. */
export function retrospectivePrompt(setting: unknown): string {
  const text = typeof setting === 'string' ? setting.trim() : '';
  return text || DEFAULT_RETROSPECTIVE_PROMPT;
}

/** Appended after the job's own prompt when the job has Retrospective on. */
export function retrospectiveAddendum(prompt: string): string {
  return [
    'Retrospective: when the task above is complete, and only then, end your final message with a retrospective.',
    'Do the task exactly as you would without one; the retrospective must not change how you work.',
    `Start it on a line of its own reading exactly ${RETROSPECTIVE_MARKER} and write nothing of the task after that line.`,
    `If you would report nothing for every part of the prompt below, write only ${NO_RETROSPECTIVE} after the marker.`,
    'The retrospective prompt:',
    '',
    prompt,
  ].join('\n');
}

/**
 * Splits streamed output on the marker. Text before it passes straight through
 * to the log; text after it is kept back as the retrospective.
 *
 * The marker can arrive split across chunks, so a tail that could be the start
 * of it is held until the next chunk says whether it was.
 */
export class RetrospectiveSplitter {
  private held = '';
  private captured: string | null = null;

  /** Takes one chunk and answers the part of it that belongs to the output. */
  public push(text: string): string {
    if (this.captured !== null) {
      this.captured += text;
      return '';
    }
    const buffer = this.held + text;
    const at = buffer.indexOf(RETROSPECTIVE_MARKER);
    if (at >= 0) {
      this.held = '';
      this.captured = buffer.slice(at + RETROSPECTIVE_MARKER.length);
      return buffer.slice(0, at);
    }
    const keep = partialMarkerLength(buffer);
    this.held = buffer.slice(buffer.length - keep);
    return buffer.slice(0, buffer.length - keep);
  }

  /** Whatever output is still held back, once no more is coming. */
  public flush(): string {
    const rest = this.held;
    this.held = '';
    return rest;
  }

  /** The text after the marker, or null when the marker never came. */
  public get retrospective(): string | null {
    return this.captured;
  }
}

/** How much of the end of `text` is the start of the marker. */
function partialMarkerLength(text: string): number {
  for (let length = Math.min(text.length, RETROSPECTIVE_MARKER.length - 1); length > 0; length -= 1) {
    if (RETROSPECTIVE_MARKER.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

function normalizeLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[#*_`>]/g, '')
    .replace(/^\s*(\d+[.)]|[-•])\s*/, '')
    .replace(/[\s:.!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Nothing to report", alone or after a heading such as "What went well:".
const EMPTY_ANSWER = /^(.{0,80}?[:—–-]\s*)?(nothing to report|nothing|none|n\/a|no notes|nothing notable)$/;

/**
 * The retrospective worth keeping, trimmed, or null when it says nothing.
 *
 * Nothing means the marker never came, the model wrote NO RETROSPECTIVE, or
 * every line is either a heading from the prompt or a "nothing to report".
 * Such a run gets no retrospective section, no mark in the log list, and no
 * notification.
 */
export function substantiveRetrospective(captured: string | null, prompt: string): string | null {
  const text = (captured ?? '').trim();
  if (!text) return null;
  if (normalizeLine(text) === normalizeLine(NO_RETROSPECTIVE)) return null;
  const headings = new Set(prompt.split('\n').map(normalizeLine).filter(Boolean));
  const saysSomething = text.split('\n').some((line) => {
    const normalized = normalizeLine(line);
    if (!normalized || line.trim().startsWith('#')) return false;
    if (headings.has(normalized) || EMPTY_ANSWER.test(normalized)) return false;
    return normalized !== normalizeLine(NO_RETROSPECTIVE);
  });
  return saysSomething ? text : null;
}

/** The log section for a retrospective with something in it. */
export function retrospectiveSection(text: string): string {
  return `\n\n${RETROSPECTIVE_HEADING}\n${text}\n${RETROSPECTIVE_END}\n`;
}

/** Whether a log's text holds a retrospective section. */
export function hasRetrospectiveSection(log: string): boolean {
  return log.split('\n').includes(RETROSPECTIVE_HEADING);
}
