import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type * as CronService from '../src/cronService.js';
import type * as Events from '../src/events.js';
import type * as JobCache from '../src/jobCache.js';
import type { BusEvent, Cron } from '../src/types.js';

/**
 * A stand-in for the claude CLI: writes the prompt it was given next to itself,
 * then streams FAKE_REPLY in small chunks, as the real one does, and a result.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'prompt.txt'), process.argv[process.argv.indexOf('-p') + 1]);
const reply = process.env.FAKE_REPLY;
for (let i = 0; i < reply.length; i += 7) {
  const text = reply.slice(i, i + 7);
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }));
}
console.log(JSON.stringify({ type: 'result', result: reply, total_cost_usd: 0.01, duration_ms: 1000, usage: {} }));
`;

let bin: string;
let service: typeof CronService;
let cache: typeof JobCache;
let events: typeof Events;

beforeAll(async () => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-claude-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  process.env.CLAUDE_BIN = path.join(bin, 'claude');
  process.env.PROMPTD_NODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-node-'));
  cache = await import('../src/jobCache.js');
  events = await import('../src/events.js');
  service = await import('../src/cronService.js');
});

function cron(id: string): Cron {
  return {
    id,
    name: id,
    description: '',
    cron: '0 9 * * *',
    timezone: '',
    workingDirectory: os.tmpdir(),
    useWorktree: false,
    cleanupWorktree: false,
    retrospective: true,
    model: '',
    effort: '',
    usageDelay: { credits: false, fable: false, session: false, weekly: false },
    prompt: 'Do the task.',
    isActive: false,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
  };
}

/** Runs one job to the end with the fake CLI answering `reply`; answers its log and the events it sent. */
async function run(id: string, reply: string): Promise<{ log: string; types: string[] }> {
  process.env.FAKE_REPLY = reply;
  cache.replaceJobs({
    crons: [cron(id)],
    executions: [],
    settings: { maxConcurrentJobs: 0, usageDelayThresholds: { credits: 90, fable: 95, session: 90, weekly: 95 }, defaultWorktreeInclude: '', retrospectivePrompt: 'Say what went well.' },
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
  const file = String(started && 'logFile' in started ? started.logFile : '');
  return { log: fs.readFileSync(path.join(cache.logDir(id), file), 'utf8'), types: seen.map((event) => event.type) };
}

describe('a run with Retrospective on', () => {
  it('asks for the retrospective after the job prompt', async () => {
    await run('prompted', 'Task done.');
    const prompt = fs.readFileSync(path.join(bin, 'prompt.txt'), 'utf8');
    expect(prompt.indexOf('Do the task.')).toBeLessThan(prompt.indexOf('[[promptd:retrospective]]'));
    expect(prompt.endsWith('Say what went well.')).toBe(true);
  });

  it('writes a retrospective with something in it as its own section, and announces it', async () => {
    const { log, types } = await run('said', 'Task done.\n\n[[promptd:retrospective]]\nName the branch up front.\n');
    const output = log.slice(log.indexOf('--- output ---'), log.indexOf('--- retrospective ---'));
    expect(output).toContain('Task done.');
    expect(log).not.toContain('[[promptd:retrospective]]');
    expect(log).toContain('--- retrospective ---\nName the branch up front.\n--- end of retrospective ---');
    expect(log).toContain('Retrospective     true');
    expect(types).toContain('run:retrospective');
  });

  it('leaves no trace when the retrospective says nothing', async () => {
    const { log, types } = await run('silent', 'Task done.\n[[promptd:retrospective]]\nNO RETROSPECTIVE\n');
    expect(log).toContain('Task done.');
    expect(log).not.toContain('--- retrospective ---');
    expect(log).not.toContain('NO RETROSPECTIVE');
    expect(types).not.toContain('run:retrospective');
  });
});
