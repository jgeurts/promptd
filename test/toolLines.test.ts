import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { KEY_WIDTH, TOOL_LINE, ToolLinesReader, callCounts, callList, key, tallyItem, toolsSummary } from '../src/toolLines.js';
import type { ToolRecords } from '../src/toolLines.js';

const HEADER = [
  '=== Nightly review ===',
  'started    2026-10-02T13:49:59.000Z',
  'directory  /Users/me/work/app',
  '--- prompt ---',
  'Review the repository. In an old log a call looked like this:',
  '⏺ Bash  not a call, just the prompt quoting one',
  'setup      claude 0.0.1 · quoted · permissions none',
  '--- output ---',
].join('\n');

// A CLI warning on stderr is piped into the same log and can land first.
const WARNING = '[claude] warning: something on stderr';

const BLOCK = [
  'setup      claude 2.1.287 · claude-opus-5-5 · permissions default',
  'tools      20 at startup: 11 built-in, 9 from 4 MCP servers',
  'project    mcp: probe (failed) · skills: probe-skill',
  'global     mcp connected: Linear 5 · Neon, prod 2',
  'global     mcp needs sign-in (14): Ambient, Canva and 12 more',
  'global     mcp failed (1): Zapier',
  'global     3 skills · 2 plugins · 2 agents',
  'built-in   Task, Bash, Read',
  'context    31k tokens in the first request',
].join('\n');

const OUTPUT = [
  '',
  'Looking at the repository.',
  '',
  '⏺ Bash  Run the test suite',
  WARNING,
  '⏺ Read  src/x.ts',
  '  ✗ Read failed: File does not exist.',
  '⏺ Task  Review the diff',
  '  ⏺ Grep  TODO',
  '⏺ Neon, prod · run_sql',
  '',
  'For the record, another run opened with',
  'setup      claude 1.0.0 · other · permissions plan',
  'global     mcp failed (1): Other',
  'context    1k tokens in the first request',
  'and ended with',
  'tools used 9 calls: Quoted ×9',
  'denied     9 calls: Quoted ×9 (permission mode plan)',
  'and that is all.',
  '',
  '',
  '--- retrospective ---',
  'I should have run',
  '⏺ Bash  the linter',
  'first.',
  '--- end of retrospective ---',
  '',
  'tools used 5 calls: Bash ×1, Read ×1, Task ×1, Grep ×1, Neon, prod · run_sql ×1',
  'denied     2 calls: Bash ×1, Edit ×1 (permission mode default)',
  '',
  '=-----------------------------------=',
  'Model: claude-opus-5-5',
  '=-----------------------------------=',
  '',
  '--- succeeded after 22.1s (exit code 0) ---',
  '',
].join('\n');

const LOG = `${HEADER}\n${WARNING}\n${BLOCK}\n${OUTPUT}`;

/** The records as plain data, so two readers can be compared. */
function plain(records: ToolRecords): unknown {
  return { ...records, calls: [...records.calls], used: records.used ? [...records.used] : null };
}

function read(...pieces: string[]): ToolLinesReader {
  const reader = new ToolLinesReader();
  for (const piece of pieces) reader.feed(piece);
  return reader;
}

describe('ToolLinesReader', () => {
  it('reads the block at the top of the output, the calls after it, and the tally the closing lines confirm', () => {
    const reader = read(LOG);
    expect(reader.active).toBe(true);
    expect(reader.finished).toBe(false);
    expect(plain(reader.records)).toEqual({
      setup: 'claude 2.1.287 · claude-opus-5-5 · permissions default',
      startup: { tools: 20, builtIn: 11 },
      project: { mcp: 'probe (failed)', skills: 'probe-skill' },
      servers: [
        { status: 'connected', count: null, names: 'Linear 5 · Neon, prod 2' },
        { status: 'needs sign-in', count: 14, names: 'Ambient, Canva and 12 more' },
        { status: 'failed', count: 1, names: 'Zapier' },
      ],
      extras: '3 skills · 2 plugins · 2 agents',
      builtIn: 'Task, Bash, Read',
      context: '31k tokens in the first request',
      calls: [
        ['Bash', 1],
        ['Read', 1],
        ['Task', 1],
        ['Grep', 1],
        ['Neon, prod · run_sql', 1],
      ],
      used: [
        ['Bash', 1],
        ['Read', 1],
        ['Task', 1],
        ['Grep', 1],
        ['Neon, prod · run_sql', 1],
      ],
      denied: '2 calls: Bash ×1, Edit ×1 (permission mode default)',
    });
  });

  it('reads the same whatever the chunks were cut at', () => {
    const whole = plain(read(LOG).records);
    for (let at = 0; at <= LOG.length; at += 1) {
      expect(plain(read(LOG.slice(0, at), LOG.slice(at)).records)).toEqual(whole);
    }
    for (let seed = 1; seed <= 50; seed += 1) {
      const first = (seed * 7919) % LOG.length;
      const second = first + ((seed * 104729) % (LOG.length - first));
      expect(plain(read(LOG.slice(0, first), LOG.slice(first, second), LOG.slice(second)).records)).toEqual(whole);
    }
  });

  it('lets a few stray lines come before the block, and more than a few mean there is none', () => {
    const soon = read(`${HEADER}\n${WARNING}\n${WARNING}\n${BLOCK}\n`);
    expect(soon.active).toBe(true);
    expect(soon.records.setup).not.toBeNull();

    const late = read(`${HEADER}\n${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\n${BLOCK}\n⏺ Bash  quoted\n`);
    expect(late.active).toBe(false);
    expect(late.finished).toBe(true);
    expect(late.records.setup).toBeNull();
    expect(late.feed('⏺ Bash  more\n')).toBe(false);
  });

  it('is not fooled by the prompt or an older log, which have no block in their output', () => {
    const reader = read(`${HEADER}\nTask done.\n=-----=\n--- succeeded after 1.0s (exit code 0) ---\n`);
    expect(reader.active).toBe(false);
    expect(reader.records.calls.size).toBe(0);
  });

  it('reads the block only while its keys run on without a break', () => {
    const reader = read(`${HEADER}\nsetup      claude 2.1.287\ntools      3 at startup: 3 built-in\n${WARNING}\nglobal     mcp failed (1): Late\ncontext    2k tokens in the first request\n`);
    expect(reader.records.startup).toEqual({ tools: 3, builtIn: 3 });
    expect(reader.records.servers).toEqual([]);
    expect(reader.records.context).toBeNull();
  });

  it('keeps the first block and the context right after it; quotes further down change nothing', () => {
    const reader = read(LOG);
    expect(reader.records.setup).toBe('claude 2.1.287 · claude-opus-5-5 · permissions default');
    expect(reader.records.context).toBe('31k tokens in the first request');
    expect(reader.records.servers.map((server) => server.names)).not.toContain('Other');
  });

  it('skips the retrospective and counts no call quoted in it', () => {
    expect([...read(LOG).records.calls.keys()]).not.toContain('the');
    const reader = read(`${HEADER}\n${BLOCK}\n\n--- retrospective ---\n⏺ Bash  quoted\n--- end of retrospective ---\n⏺ Read  counted\n`);
    expect([...reader.records.calls]).toEqual([['Read', 1]]);
  });

  it('takes a tally only when the closing lines follow it, blank lines aside', () => {
    const quoted = read(`${HEADER}\n${BLOCK}\n\n⏺ Bash  x\ntools used 9 calls: Quoted ×9\n\nmore prose\n`);
    expect(quoted.records.used).toBeNull();
    expect(quoted.records.denied).toBeNull();

    const stats = read(`${HEADER}\n${BLOCK}\n\n⏺ Bash  x\n\ntools used 1 call: Bash ×1\ndenied     1 call: Edit ×1 (permission mode default)\n\n=----=\n`);
    expect([...stats.records.used!]).toEqual([['Bash', 1]]);
    expect(stats.records.denied).toBe('1 call: Edit ×1 (permission mode default)');

    // A run stopped before the CLI gave statistics closes with the clean-up line alone.
    const stopped = read(`${HEADER}\n${BLOCK}\n\n⏺ Bash  x\n\ntools used 1 call: Bash ×1\n\nWorktree cleanup: not cleaned up: Clean up worktree after execution is off\n`);
    expect([...stopped.records.used!]).toEqual([['Bash', 1]]);
    expect(stopped.records.denied).toBeNull();
  });

  it('tells the items of a tally apart by their counts, so a server name may hold a comma', () => {
    const reader = read(`${HEADER}\n${BLOCK}\n\ntools used 3 calls: Neon, prod · run_sql ×2, Bash ×1\n\n=----=\n`);
    expect([...reader.records.used!]).toEqual([
      ['Neon, prod · run_sql', 2],
      ['Bash', 1],
    ]);
    expect(tallyItem('Neon, prod · run_sql', 2)).toBe('Neon, prod · run_sql ×2');
  });

  it('answers whether a piece changed anything, so the page repaints only then', () => {
    const reader = new ToolLinesReader();
    expect(reader.feed(`${HEADER}\n`)).toBe(false);
    expect(reader.feed(`${BLOCK}\n`)).toBe(true);
    expect(reader.feed('\nPlain prose, two lines\nof it.\n')).toBe(false);
    expect(reader.feed('⏺ Read  x\n')).toBe(true);
    expect(reader.feed('tools used 1 call: Read ×1\n')).toBe(false);
    expect(reader.feed('\n=----=\n')).toBe(true);
  });

  it('holds an unfinished line until the rest of it comes', () => {
    const reader = read(`${HEADER}\n${BLOCK}\n\n⏺ Ba`);
    expect(reader.records.calls.size).toBe(0);
    reader.feed('sh  Run it\n');
    expect([...reader.records.calls]).toEqual([['Bash', 1]]);
  });
});

describe('what the page shows', () => {
  it('counts calls from the ⏺ lines until the tally is confirmed, which then counts for the run', () => {
    const live = read(`${HEADER}\n${BLOCK}\n\n⏺ Bash  one\n⏺ Bash  two\n⏺ Read  x\n`);
    expect(callCounts(live.records)).toEqual([
      ['Bash', 2],
      ['Read', 1],
    ]);
    expect(callList(live.records)).toBe('Bash ×2 · Read');
    expect(toolsSummary(live.records, true)).toBe('Tools · 20 at startup · 3 calls to 2 tools');

    live.feed('A quoted ⏺ does not count here, but this does:\n⏺ Bash  three\n\ntools used 2 calls: Bash ×2\ndenied     1 call: Edit ×1 (permission mode default)\n\n=----=\n');
    expect(callCounts(live.records)).toEqual([['Bash', 2]]);
    expect(toolsSummary(live.records, false)).toBe('Tools · 20 at startup · 2 calls to 1 tool · 1 denied');
  });

  it('says no calls yet while the run streams, and none once the tally says so', () => {
    const reader = read(`${HEADER}\n${BLOCK}\n`);
    expect(toolsSummary(reader.records, true)).toBe('Tools · 20 at startup · no calls yet');
    reader.feed('\ntools used none\n\n=----=\n');
    expect(toolsSummary(reader.records, true)).toBe('Tools · 20 at startup · no calls');
    expect(callList(reader.records)).toBe('');
  });

  it('leaves the startup count out of the summary for a block that never gave one', () => {
    const reader = read(`${HEADER}\nsetup      claude 2.1.287\n\n⏺ Read  x\n`);
    expect(toolsSummary(reader.records, true)).toBe('Tools · 1 call to 1 tool');
  });
});

describe('the line shapes the writer and reader share', () => {
  it('pads a key to the column the header uses', () => {
    expect(KEY_WIDTH).toBe(11);
    expect(key('setup')).toBe('setup      ');
    expect(key('tools used')).toBe('tools used ');
  });

  it('recognises a call or a failure at either depth, and nothing else', () => {
    for (const line of ['⏺ Bash  x', '  ⏺ Grep  y', '  ✗ Read failed: z', '    ✗ Bash failed']) expect(TOOL_LINE.test(line)).toBe(true);
    for (const line of ['Plain text ⏺ with the glyph inside', '      ⏺ too deep', '⏺no space', 'tools used none']) expect(TOOL_LINE.test(line)).toBe(false);
  });
});

describe('the page', () => {
  it('loads the reader apart from itself, so a hub that cannot serve it still shows the log as plain text', () => {
    const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^import .* from '\/shared\/toolLines\.js'/m);
    expect(source).toMatch(/await import\('\/shared\/toolLines\.js'\)\.catch\(/);
  });
});
