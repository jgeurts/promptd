import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type * as CronService from '../src/cronService.js';
import type * as Events from '../src/events.js';
import type * as JobCache from '../src/jobCache.js';
import type { BusEvent, RunnableCron as Cron } from '../src/types.js';

/** A stand-in for the claude CLI: replays the recorded event stream named by FAKE_STREAM. */
const FAKE_CLAUDE = `#!/usr/bin/env node
process.stdout.write(require('node:fs').readFileSync(process.env.FAKE_STREAM, 'utf8'));
`;

const stream = (event: Record<string, unknown>): Record<string, unknown> => ({ type: 'stream_event', event });
const delta = (text: string): Record<string, unknown> => stream({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
const assistant = (content: unknown[], parent: string | null = null): Record<string, unknown> => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content, usage: { input_tokens: 10, cache_creation_input_tokens: 17022, cache_read_input_tokens: 14172, output_tokens: 3 } },
});
const user = (content: unknown[], parent: string | null = null): Record<string, unknown> => ({ type: 'user', parent_tool_use_id: parent, message: { content } });

/**
 * One run as the CLI streams it, cut down: the init, a first message whose
 * text streams in pieces before the complete message repeats it, tool calls
 * that stream as partial blocks and then arrive complete, a subagent, a
 * failed result, a last paragraph and the result with one refused call.
 */
function recordedRun(cwd: string): string {
  const events: Record<string, unknown>[] = [
    { type: 'system', subtype: 'status', status: null },
    {
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
    },
    stream({ type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 17022, cache_read_input_tokens: 14172, output_tokens: 1 } } }),
    stream({ type: 'content_block_start', content_block: { type: 'text' } }),
    delta('Looking at '),
    delta('the repo.'),
    stream({ type: 'content_block_stop' }),
    assistant([{ type: 'text', text: 'Looking at the repo.' }]),
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
    stream({ type: 'content_block_start', content_block: { type: 'text' } }),
    delta('Done.'),
    stream({ type: 'content_block_stop' }),
    assistant([{ type: 'text', text: 'Done.' }]),
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      total_cost_usd: 0.01,
      duration_ms: 1000,
      usage: {},
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'rm -rf /' } }],
    },
  ];
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
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

function cron(id: string): Cron {
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
    retrospective: false,
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

/** Runs one job to the end with the fake CLI replaying `recorded`; answers its log. */
async function run(id: string, recorded: string): Promise<string> {
  const file = path.join(bin, `${id}.jsonl`);
  fs.writeFileSync(file, recorded);
  process.env.FAKE_STREAM = file;
  cache.replaceJobs({
    crons: [cron(id)],
    executions: [],
    settings: { maxConcurrentJobs: 0, usageDelayThresholds: { credits: 90, fable: 95, session: 90, weekly: 95 }, defaultWorktreeInclude: '', retrospectivePrompt: '' },
  });
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
  const logFile = String(started && 'logFile' in started ? started.logFile : '');
  return fs.readFileSync(path.join(cache.logDir(id), logFile), 'utf8');
}

describe('a run from a CLI that reports its tools', () => {
  it('writes the setup block, each call in order between the paragraphs, and the tally', async () => {
    const log = await run('tools', recordedRun(workDir));
    const output = log.slice(log.indexOf('--- output ---\n') + '--- output ---\n'.length, log.indexOf('\n=-----'));
    expect(output).toBe(
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
        '',
        'Done.',
        '',
        'tools used 5 calls: Bash, Read, Task, Grep, Linear · save_issue',
        'denied     1 call: Bash (permission mode default)',
        '',
      ].join('\n'),
    );
    expect(log).not.toContain('Private title');
    expect(log).toMatch(/\n--- succeeded after [\d.]+s \(exit code 0\) ---\n$/);
  });

  it('leaves a log from a CLI without these events exactly as before', async () => {
    const plain = [
      stream({ type: 'content_block_start', content_block: { type: 'text' } }),
      delta('Task done.'),
      { type: 'result', subtype: 'success', result: 'Task done.', total_cost_usd: 0.01, duration_ms: 1000, usage: {} },
    ];
    const log = await run('plain', `${plain.map((event) => JSON.stringify(event)).join('\n')}\n`);
    expect(log).toContain('--- output ---\nTask done.\n=-----');
    expect(log).not.toContain('tools used');
  });
});
