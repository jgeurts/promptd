import { runInGroup } from './processGroup.js';

/**
 * Runs a job's commands before the prompt: plain shell, in order, each in a
 * shell of its own, so a `cd` or an export does not carry over to the next.
 * Non-login bash with -e and pipefail, so a failure anywhere in a line fails
 * it, with the node's own environment less BASH_ENV, which bash would
 * otherwise source first. Nothing here reaches Claude: the output goes to the
 * run's log, and a command that fails stops the run before Claude starts.
 *
 * Each command runs in a process group of its own, and the next step waits
 * until that group is empty, so nothing a command started is still running
 * when Claude starts or the worktree is removed.
 */

export const PRE_PROMPT_SHELL = ['/bin/bash', '-e', '-o', 'pipefail', '-c'] as const;

/** How long all of a run's commands may take together, unless the node's environment says otherwise. */
export const DEFAULT_PRE_PROMPT_TIMEOUT_MS = 10 * 60_000;

// What one command's output may put in the log: its start, and then the end
// of whatever followed, which is where an install says what went wrong.
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

/** PROMPTD_PRE_PROMPT_TIMEOUT_SECONDS, read when a run starts, or ten minutes. */
export function prePromptTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(env.PROMPTD_PRE_PROMPT_TIMEOUT_SECONDS);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_PRE_PROMPT_TIMEOUT_MS;
}

export type SetupOutcome =
  | { ok: true }
  | { ok: false; why: 'exit'; index: number; command: string; code: number | null; signal: NodeJS.Signals | null }
  | { ok: false; why: 'spawn'; index: number; command: string; error: string }
  | { ok: false; why: 'stuck' | 'timeout' | 'stopped'; index: number; command: string };

/** Writes a command's output through, up to a point, then keeps only its end. */
class CappedOutput {
  private written = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private left = 0;
  public endsWithNewline = true;

  public constructor(private readonly write: (chunk: Buffer | string) => void) {}

  public push(chunk: Buffer): void {
    if (!chunk.length) return;
    if (this.written < HEAD_BYTES) {
      const part = chunk.subarray(0, HEAD_BYTES - this.written);
      this.out(part);
      this.written += part.length;
      chunk = chunk.subarray(part.length);
      if (!chunk.length) return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tail.length > 1 && this.tailBytes - this.tail[0]!.length >= TAIL_BYTES) {
      const first = this.tail.shift()!;
      this.tailBytes -= first.length;
      this.left += first.length;
    }
  }

  public finish(): void {
    if (!this.tail.length) return;
    let rest = Buffer.concat(this.tail);
    if (rest.length > TAIL_BYTES) {
      this.left += rest.length - TAIL_BYTES;
      rest = rest.subarray(rest.length - TAIL_BYTES);
    }
    this.tail = [];
    if (this.left) this.out(`${this.endsWithNewline ? '' : '\n'}[... ${this.left.toLocaleString('en-US')} bytes of output left out of this log ...]\n`);
    this.out(rest);
  }

  private out(chunk: Buffer | string): void {
    if (!chunk.length) return;
    this.write(chunk);
    const last = typeof chunk === 'string' ? chunk.at(-1) : String.fromCharCode(chunk[chunk.length - 1]!);
    this.endsWithNewline = last === '\n';
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}


/**
 * One run's commands, and the handle that stops them. `stop` ends whatever
 * is going: the git work before the commands through `signal`, and the
 * running command's whole process group, SIGTERM then SIGKILL five seconds
 * later. Neither answers until what it stopped is gone.
 */
export class PrePromptSetup {
  private readonly controller = new AbortController();

  /** For the git work that comes before the commands, so Stop ends that too. */
  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get isStopped(): boolean {
    return this.controller.signal.aborted;
  }

  public stop(): void {
    this.controller.abort();
  }

  /**
   * Runs the commands one after another in `cwd`, writing each one, its
   * output, and how it ended to `write`, and answers how the whole set ended.
   * `timeoutMs` covers all of them together.
   */
  public async run(
    commands: string[],
    { cwd, write, timeoutMs = prePromptTimeoutMs(), env = process.env }: { cwd: string; write: (chunk: Buffer | string) => void; timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<SetupOutcome> {
    const { BASH_ENV: _ignored, ...shellEnv } = env;
    const deadline = Date.now() + timeoutMs;
    for (const [index, command] of commands.entries()) {
      if (this.isStopped) return { ok: false, why: 'stopped', index, command };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, why: 'timeout', index, command };
      write(`$ ${command}\n`);
      const started = Date.now();
      const output = new CappedOutput(write);
      const end = await runInGroup(PRE_PROMPT_SHELL[0], [...PRE_PROMPT_SHELL.slice(1), command], {
        cwd,
        env: shellEnv,
        signal: this.controller.signal,
        timeoutMs: remaining,
        onOutput: (chunk) => output.push(chunk),
      });
      output.finish();
      const took = seconds(Date.now() - started);
      const lead = output.endsWithNewline ? '' : '\n';
      if (end.error !== null) {
        write(`${lead}could not start ${PRE_PROMPT_SHELL[0]}: ${end.error}\n`);
        return { ok: false, why: 'spawn', index, command, error: end.error };
      }
      // Whatever it started may still be writing, so nothing may start after it.
      if (end.leftRunning) {
        write(`${lead}something it started was still running 5s after SIGKILL, so the run stops here\n`);
        return { ok: false, why: 'stuck', index, command };
      }
      if (end.aborted) {
        write(`${lead}stopped after ${took}\n`);
        return { ok: false, why: 'stopped', index, command };
      }
      if (end.timedOut) {
        write(`${lead}stopped after ${took}: the commands before the prompt ran past ${seconds(timeoutMs)}\n`);
        return { ok: false, why: 'timeout', index, command };
      }
      write(`${lead}${end.signal ? `ended by ${end.signal}` : `exit ${end.code}`} after ${took}\n`);
      if (end.code !== 0) return { ok: false, why: 'exit', index, command, code: end.code, signal: end.signal };
    }
    return { ok: true };
  }
}
