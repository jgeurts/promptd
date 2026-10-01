import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Runs one command in a process group of its own and answers only once every
 * process in that group is gone, so nothing it started is still writing when
 * the caller moves on: to the next command, to Claude, or to removing the
 * worktree.
 *
 * Ending it, by abort or timeout, sends the group SIGTERM, then SIGKILL five
 * seconds later. When the command exits by itself, whatever it left running
 * in the group is ended the same way. Should anything outlast SIGKILL, the
 * answer says so in `leftRunning`. A process that leaves the group on purpose
 * (a daemon that calls setsid) is beyond its reach.
 */

export const KILL_AFTER_MS = 5000;
const POLL_MS = 50;

export interface GroupOptions {
  /** Where it starts; this process's own folder when left out. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is otherwise closed. */
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Each chunk of stdout and stderr as it arrives. */
  onOutput?: (chunk: Buffer, from: 'stderr' | 'stdout') => void;
}

export interface GroupResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when it could not be started at all. */
  error: string | null;
  timedOut: boolean;
  aborted: boolean;
  /**
   * Something in the group was still there five seconds after SIGKILL, or
   * could not be signalled at all, so it may still be writing. What comes
   * next should not touch the folder it was working in.
   */
  leftRunning: boolean;
}

/**
 * Whether anything is left in the group. Only ESRCH says nothing is: EPERM
 * means a member this process may not signal, such as one run through sudo.
 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function send(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* gone, or not ours to signal; groupAlive tells which */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** Waits for the group to empty, up to `ms`; true once it has. */
async function emptied(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= until) return false;
    await sleep(POLL_MS);
  }
  return true;
}

/** SIGTERM to the group, then SIGKILL if anything is left; answers whether it is gone. */
async function endGroup(pid: number): Promise<boolean> {
  if (!groupAlive(pid)) return true;
  send(pid, 'SIGTERM');
  if (await emptied(pid, KILL_AFTER_MS)) return true;
  send(pid, 'SIGKILL');
  return emptied(pid, KILL_AFTER_MS);
}

export function runInGroup(command: string, args: string[], options: GroupOptions): Promise<GroupResult> {
  const { cwd, env = process.env, input, signal, timeoutMs, onOutput } = options;
  return new Promise((resolve) => {
    const result: GroupResult = { code: null, signal: null, error: null, timedOut: false, aborted: false, leftRunning: false };
    if (signal?.aborted) {
      resolve({ ...result, aborted: true });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      resolve({ ...result, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let ending: Promise<boolean> | null = null;
    const end = (): Promise<boolean> => {
      ending ??= child.pid === undefined ? Promise.resolve(true) : endGroup(child.pid);
      return ending;
    };
    const onAbort = (): void => {
      result.aborted = true;
      void end();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = timeoutMs === undefined ? null : setTimeout(() => {
      result.timedOut = true;
      void end();
    }, Math.max(0, timeoutMs));

    child.stdout?.on('data', (chunk: Buffer) => onOutput?.(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => onOutput?.(chunk, 'stderr'));
    child.stdin?.on('error', () => {
      /* it stopped reading; its exit says how it went */
    });
    if (input !== undefined) child.stdin?.end(input);

    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    child.once('error', (err) => {
      // Only a failure to start arrives without an exit to follow.
      if (child.pid !== undefined) return;
      result.error = err.message;
      settle();
    });
    child.once('exit', (code, exitSignal) => {
      result.code = code;
      result.signal = exitSignal;
      const closed = new Promise<void>((done) => {
        if (child.stdout?.closed !== false && child.stderr?.closed !== false) done();
        else child.once('close', () => done());
      });
      // Whatever it left behind goes too, and only then is the run over. A
      // process outside the group can still hold the output open, so that is
      // given up on once the group is empty.
      void end()
        .then((gone) => {
          result.leftRunning = !gone;
          return Promise.race([closed, sleep(KILL_AFTER_MS)]);
        })
        .then(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle();
        });
    });
  });
}
