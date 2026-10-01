import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runInGroup } from '../src/processGroup.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A shell line that leaves a sleep behind which ignores SIGTERM, and notes its pid. */
function stubborn(pidFile: string, rest = 'exit 0'): string[] {
  return ['-c', `trap '' TERM; sleep 30 & echo $! > ${pidFile}; ${rest}`];
}

describe('runInGroup', () => {
  it('answers with the exit code and the output', async () => {
    const output: string[] = [];
    const result = await runInGroup('/bin/bash', ['-c', 'echo out; echo err >&2; exit 3'], { onOutput: (chunk) => output.push(chunk.toString()) });
    expect(result).toMatchObject({ code: 3, aborted: false, timedOut: false, error: null });
    expect(output.join('')).toContain('out');
    expect(output.join('')).toContain('err');
  });

  it('does not answer until what the command left running is gone, even what ignores SIGTERM', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-group-')), 'pid');
    const started = Date.now();
    const result = await runInGroup('/bin/bash', stubborn(pidFile), {});
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
    expect(alive(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(false);
  }, 20_000);

  it('ends the whole group when stopped, and answers only once it has', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-group-')), 'pid');
    const controller = new AbortController();
    const running = runInGroup('/bin/bash', stubborn(pidFile, 'wait'), { signal: controller.signal });
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(alive(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(false);
  }, 20_000);

  it('ends the group at the timeout', async () => {
    const result = await runInGroup('/bin/bash', ['-c', 'sleep 30'], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
  });

  it('says so when the command cannot start', async () => {
    expect((await runInGroup('/no/such/shell', [], {})).error).toMatch(/ENOENT/);
  });

  it('does not start once already stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runInGroup('/bin/bash', ['-c', 'sleep 30'], { signal: controller.signal })).toMatchObject({ aborted: true, code: null });
  });
});
