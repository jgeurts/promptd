import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type * as CronService from '../src/cronService.js';
import type * as Events from '../src/events.js';
import type * as JobCache from '../src/jobCache.js';
import type { BusEvent, RunnableCron as Cron } from '../src/types.js';

/** A stand-in for the claude CLI: replays the recorded event stream named by FAKE_STREAM, byte for byte. */
const FAKE_CLAUDE = `#!/usr/bin/env node
process.stdout.write(require('node:fs').readFileSync(process.env.FAKE_STREAM, 'utf8'));
`;

type Event = Record<string, unknown>;
const stream = (event: Event): Event => ({ type: 'stream_event', event });
const delta = (text: string): Event => stream({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
const usage = { input_tokens: 10, cache_creation_input_tokens: 17022, cache_read_input_tokens: 14172, output_tokens: 3 };
const assistant = (content: unknown[], parent: string | null = null): Event => ({ type: 'assistant', parent_tool_use_id: parent, message: { content, usage } });
const user = (content: unknown[], parent: string | null = null): Event => ({ type: 'user', parent_tool_use_id: parent, message: { content } });
/** A text block as it streams: opened, in pieces of seven characters, closed, then complete. */
const prose = (text: string): Event[] => [
  stream({ type: 'content_block_start', content_block: { type: 'text' } }),
  ...(text.match(/.{1,7}/gs) ?? []).map(delta),
  stream({ type: 'content_block_stop' }),
  assistant([{ type: 'text', text }]),
];
const result = (extra: Event = {}): Event => ({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0.01, duration_ms: 1000, usage: {}, ...extra });
const encode = (events: Event[]): string => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

function init(cwd: string): Event {
  return {
    type: 'system',
    subtype: 'init',
    cwd,
    model: 'claude-test',
    permissionMode: 'default',
    claude_code_version: '2.1.287',
    tools: ['Task', 'Bash', 'Read', 'Grep', 'mcp__claude_ai_Linear__save_issue', 'mcp__probe__ping'],
    mcp_servers: [
      { name: 'claude.ai Linear', status: 'connected', source: 'claudeai' },
      { name: 'probe', status: 'failed', source: 'project' },
    ],
    skills: ['probe-skill', 'ls:tdd'],
    plugins: [{ name: 'ls' }],
    agents: ['Explore'],
  };
}

/** How a run opens: the init, then the first request's size before any of its content. */
const opening = (cwd: string): Event[] => [init(cwd), stream({ type: 'message_start', message: { usage: { ...usage, output_tokens: 1 } } })];

/**
 * One run as the CLI streams it, cut down: the init, a first message whose
 * text streams in pieces before the complete message repeats it, tool calls
 * that stream as partial blocks and then arrive complete, a subagent, a
 * failed result, a last paragraph and the result with one refused call.
 */
function recordedRun(cwd: string): string {
  return encode([
    { type: 'system', subtype: 'status', status: null },
    ...opening(cwd),
    ...prose('Looking at the repo.'),
    stream({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'b1', name: 'Bash' } }),
    stream({ type: 'content_block_stop' }),
    assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test', description: 'Run the test suite' } }]),
    user([{ type: 'tool_result', tool_use_id: 'b1', is_error: false, content: 'ok' }]),
    assistant([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: path.join(cwd, 'src', 'x.ts') } }]),
    user([{ type: 'tool_result', tool_use_id: 'r1', is_error: true, content: 'File does not exist.\nTry another.' }]),
    assistant([{ type: 'tool_use', id: 't1', name: 'Task', input: { description: 'Review the diff', prompt: 'Look at everything.' } }]),
    assistant([{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'TODO' } }], 't1'),
    user([{ type: 'tool_result', tool_use_id: 'g1', is_error: false, content: 'none' }], 't1'),
    assistant([{ type: 'tool_use', id: 'l1', name: 'mcp__claude_ai_Linear__save_issue', input: { title: 'Private title' } }]),
    user([{ type: 'tool_result', tool_use_id: 'l1', is_error: true, content: 'Rejected: Private title is taken' }]),
    ...prose('Done.'),
    result({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'rm -rf /' } }] }),
  ]);
}

let bin: string;
let workDir: string;
let service: typeof CronService;
let cache: typeof JobCache;
let events: typeof Events;

beforeAll(async () => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-claude-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  process.env.CLAUDE_BIN = path.join(bin, 'claude');
  process.env.PROMPTD_NODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-node-'));
  // The job's folder is a repository with one skill of its own.
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-work-'));
  fs.writeFileSync(path.join(workDir, '.git'), '');
  fs.mkdirSync(path.join(workDir, '.claude', 'skills', 'probe-skill'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '.claude', 'skills', 'probe-skill', 'SKILL.md'), '');
  cache = await import('../src/jobCache.js');
  events = await import('../src/events.js');
  service = await import('../src/cronService.js');
});

function cron(id: string, retrospective: boolean): Cron {
  return {
    id,
    name: id,
    nameInferred: false,
    description: '',
    cron: '0 9 * * *',
    timezone: '',
    workingDirectory: workDir,
    useWorktree: false,
    cleanupWorktree: false,
    retrospective,
    model: '',
    effort: '',
    usageDelay: { credits: false, fable: false, session: false, weekly: false },
    prePromptCommands: [],
    prompt: 'Do the task.',
    isActive: false,
    projectId: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
  };
}

/** Runs one job to the end with the fake CLI replaying `recorded`; answers its log and the events it sent. */
async function run(id: string, recorded: string, { retrospective = false } = {}): Promise<{ log: string; types: string[] }> {
  const file = path.join(bin, `${id}.jsonl`);
  fs.writeFileSync(file, recorded);
  process.env.FAKE_STREAM = file;
  cache.replaceJobs({
    crons: [cron(id, retrospective)],
    executions: [],
    settings: {
      maxConcurrentJobs: 0,
      usageDelayThresholds: { credits: 90, fable: 95, session: 90, weekly: 95 },
      defaultWorktreeInclude: '',
      retrospectivePrompt: 'Say what went well.',
    },
  });
  const seen: BusEvent[] = [];
  const onEvent = (event: BusEvent): void => {
    if (event.cronId === id) seen.push(event);
  };
  events.bus.on('event', onEvent);
  const finished = new Promise<void>((resolve) => {
    const check = (event: BusEvent): void => {
      if (event.type === 'run:finished' && event.cronId === id) {
        events.bus.off('event', check);
        resolve();
      }
    };
    events.bus.on('event', check);
  });
  const started = await service.cronService.trigger(id);
  await finished;
  events.bus.off('event', onEvent);
  const logFile = String(started && 'logFile' in started ? started.logFile : '');
  return { log: fs.readFileSync(path.join(cache.logDir(id), logFile), 'utf8'), types: seen.map((event) => event.type) };
}

/** The log between the output heading and the statistics block. */
function output(log: string): string {
  return log.slice(log.indexOf('--- output ---\n') + '--- output ---\n'.length, log.indexOf('\n=-----'));
}

describe('a run from a CLI that reports its tools', () => {
  it('writes the setup block, each call in order between the paragraphs, and the tally', async () => {
    const { log } = await run('tools', recordedRun(workDir));
    expect(output(log)).toBe(
      [
        'setup      claude 2.1.287 · claude-test · permissions default',
        'tools      6 at startup: 4 built-in, 2 from 2 MCP servers',
        'project    mcp: probe (failed) · skills: probe-skill',
        'global     mcp connected: Linear 1',
        'global     1 skill · 1 plugin · 1 agent',
        'built-in   Task, Bash, Read, Grep',
        'context    31k tokens in the first request',
        '',
        'Looking at the repo.',
        '',
        '⏺ Bash  Run the test suite',
        '⏺ Read  src/x.ts',
        '  ✗ Read failed: File does not exist.',
        '⏺ Task  Review the diff',
        '  ⏺ Grep  TODO',
        '⏺ Linear · save_issue',
        '  ✗ Linear · save_issue failed',
        '',
        'Done.',
        '',
        'tools used 5 calls: Bash ×1, Read ×1, Task ×1, Grep ×1, Linear · save_issue ×1',
        'denied     1 call: Bash ×1 (permission mode default)',
        '',
      ].join('\n'),
    );
    expect(log).not.toContain('Private title');
    expect(log).toMatch(/\n--- succeeded after [\d.]+s \(exit code 0\) ---\n$/);
  });

  it('leaves a log from a CLI without these events exactly as before', async () => {
    const { log } = await run('plain', encode([stream({ type: 'content_block_start', content_block: { type: 'text' } }), delta('Task done.'), result({ result: 'Task done.' })]));
    expect(log).toContain('--- output ---\nTask done.\n=-----');
    expect(log).not.toContain('tools used');
  });

  it('writes nothing of an event it cannot read, such as one cut off when the run was killed', async () => {
    const cut = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"z","name":"mcp__x__y","input":{"title":"Private ti';
    const recorded = `${encode([init(workDir), ...prose('Working.')])}[warn] a plain CLI warning\n${cut}`;
    const { log } = await run('cut', recorded);
    expect(log).toContain('[warn] a plain CLI warning\n');
    expect(log).toContain(`(unreadable CLI event, ${Buffer.byteLength(cut)} bytes)\n`);
    expect(log).not.toContain('Private ti');
  });
});

describe('tool lines and a retrospective together', () => {
  const marker = '[[promptd:retrospective]]';

  it('keeps the calls in the output, in order, and the retrospective in its section', async () => {
    const recorded = encode([
      ...opening(workDir),
      ...prose(`Task done.\n\n${marker}\nName the branch up front.\n`),
      assistant([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: path.join(workDir, 'notes.md') } }]),
      result(),
    ]);
    const { log, types } = await run('retro', recorded, { retrospective: true });
    const out = output(log);
    // The call's line sits in the output, before the section; the section holds the prose alone.
    const main = out.slice(0, out.indexOf('--- retrospective ---'));
    expect(main).toContain('Task done.\n\n⏺ Read  notes.md\n');
    expect(main).not.toContain('Name the branch');
    expect(log).toContain('--- retrospective ---\nName the branch up front.\n--- end of retrospective ---');
    expect(log).not.toContain(marker);
    expect(types).toContain('run:retrospective');
  });

  it('does not start a retrospective on a pattern that quotes the marker', async () => {
    const recorded = encode([
      ...opening(workDir),
      ...prose('Task done.'),
      assistant([{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: marker } }]),
      ...prose('Nothing else uses it.'),
      result(),
    ]);
    const { log, types } = await run('pattern', recorded, { retrospective: true });
    expect(output(log)).toContain(`Task done.\n\n⏺ Grep  ${marker}\n\nNothing else uses it.\n`);
    expect(log).not.toContain('--- retrospective ---');
    expect(types).not.toContain('run:retrospective');
  });

  it('does not let a call made during the retrospective make an empty one look like something', async () => {
    const recorded = encode([
      ...opening(workDir),
      ...prose(`Task done.\n${marker}\nNO RETROSPECTIVE\n`),
      assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { description: 'Tidy up' } }]),
      result(),
    ]);
    const { log, types } = await run('empty-retro', recorded, { retrospective: true });
    expect(output(log)).toContain('Task done.\n\n⏺ Bash  Tidy up\n');
    expect(log).not.toContain('--- retrospective ---');
    expect(log).not.toContain('NO RETROSPECTIVE');
    expect(types).not.toContain('run:retrospective');
  });
});
