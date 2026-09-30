import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanTitle, titlePrompt } from './naming.js';

export const TITLE_TIMEOUT_MS = 60 * 1000;

/**
 * Asks claude, on the cheapest model, for a short title for a job's prompt.
 *
 * Run in a folder of its own that is removed afterwards, so the call sees no
 * project and leaves nothing behind. Answers the title, tidied, or throws when
 * claude fails, runs past the timeout, or answers with something that is not a
 * title.
 */
export async function suggestTitle(
  prompt: string,
  { bin = process.env.CLAUDE_BIN || 'claude', timeoutMs = TITLE_TIMEOUT_MS }: { bin?: string; timeoutMs?: number } = {},
): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'promptd-title-'));
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, ['-p', titlePrompt(prompt), '--model', 'haiku'], {
        cwd: dir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`claude did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim().split('\n').at(-1) || `claude exited with code ${code}`));
      });
    });
    const title = cleanTitle(answer);
    if (!title) throw new Error(answer.trim() ? `the answer was not a title: ${answer.trim().slice(0, 80)}` : 'the answer was empty');
    return title;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
