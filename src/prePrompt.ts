import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Runs a job's commands before the prompt: plain shell, in order, each in a
 * shell of its own, so a `cd` or an export does not carry over to the next.
 * Non-login bash with -e and pipefail, so a failure anywhere in a line fails
 * it, with the node's own environment less BASH_ENV, which bash would
 * otherwise source first. Nothing here reaches Claude: the output goes to the
 * run's log, and a command that fails stops the run before Claude starts.
 */

export const PRE_PROMPT_SHELL = ['/bin/bash', '-e', '-o', 'pipefail', '-c'] as const;

/** How long all of a run's commands may take together, unless the node's environment says otherwise. */
export const DEFAULT_PRE_PROMPT_TIMEOUT_MS = 10 * 60_000;

const KILL_AFTER_MS = 5000;

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
  | { ok: false; why: 'timeout' | 'stopped'; index: number; command: string };

type CommandEnd = { how: 'exit'; code: number | null; signal: NodeJS.Signals | null } | { how: 'spawn'; error: string };

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
 * is going: git is aborted through `signal`, and the running command's whole
 * process group gets SIGTERM, then SIGKILL five seconds later.
 */
export class PrePromptSetup {
  private readonly controller = new AbortController();
  private child: ChildProcess | null = null;
  private stopped = false;
  private timedOut = false;

  /** For the git work that comes before the commands, so Stop ends that too. */
  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get isStopped(): boolean {
    return this.stopped;
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    this.end();
  }

  /** SIGTERM to the command and everything it started, then SIGKILL if it is still there. */
  private end(): void {
    const child = this.child;
    if (!child?.pid) return;
    const group = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        /* already gone */
      }
    };
    group('SIGTERM');
    setTimeout(() => {
      if (this.child === child) group('SIGKILL');
    }, KILL_AFTER_MS).unref();
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
      if (this.stopped) return { ok: false, why: 'stopped', index, command };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, why: 'timeout', index, command };
      write(`$ ${command}\n`);
      const started = Date.now();
      const output = new CappedOutput(write);
      const end = await this.runOne(command, { cwd, env: shellEnv, output, remaining });
      output.finish();
      const took = seconds(Date.now() - started);
      const lead = output.endsWithNewline ? '' : '\n';
      if (end.how === 'spawn') {
        write(`${lead}could not start ${PRE_PROMPT_SHELL[0]}: ${end.error}\n`);
        return { ok: false, why: 'spawn', index, command, error: end.error };
      }
      if (this.stopped) {
        write(`${lead}stopped after ${took}\n`);
        return { ok: false, why: 'stopped', index, command };
      }
      if (this.timedOut) {
        write(`${lead}stopped after ${took}: the commands before the prompt ran past ${seconds(timeoutMs)}\n`);
        return { ok: false, why: 'timeout', index, command };
      }
      write(`${lead}${end.signal ? `ended by ${end.signal}` : `exit ${end.code}`} after ${took}\n`);
      if (end.code !== 0) return { ok: false, why: 'exit', index, command, code: end.code, signal: end.signal };
    }
    return { ok: true };
  }

  private runOne(
    command: string,
    { cwd, env, output, remaining }: { cwd: string; env: NodeJS.ProcessEnv; output: CappedOutput; remaining: number },
  ): Promise<CommandEnd> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(PRE_PROMPT_SHELL[0], [...PRE_PROMPT_SHELL.slice(1), command], {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Its own process group, so Stop and the timeout reach whatever it starts.
          detached: true,
        });
      } catch (err) {
        resolve({ how: 'spawn', error: err instanceof Error ? err.message : String(err) });
        return;
      }
      this.child = child;
      // A Stop that came between two commands, while this one was starting.
      if (this.stopped) this.end();
      const timer = setTimeout(() => {
        this.timedOut = true;
        this.end();
      }, remaining);
      child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => output.push(chunk));

      let ended: CommandEnd | null = null;
      const settle = (): void => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        resolve(ended ?? { how: 'exit', code: null, signal: null });
      };
      child.on('error', (err) => {
        // Only a failure to start comes here without an exit to follow.
        if (child.pid === undefined) {
          ended = { how: 'spawn', error: err.message };
          settle();
        }
      });
      child.on('exit', (code, signal) => {
        ended = { how: 'exit', code, signal };
        // Something it left running in the background could hold the output
        // open, and would carry on into Claude's run; neither is wanted.
        try {
          process.kill(-child.pid!, 'SIGTERM');
        } catch {
          /* nothing left */
        }
        const grace = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle();
        }, KILL_AFTER_MS);
        grace.unref();
        child.once('close', () => {
          clearTimeout(grace);
          settle();
        });
      });
    });
  }
}
