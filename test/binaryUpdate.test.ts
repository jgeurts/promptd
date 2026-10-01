import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GIVE_UP_AFTER_MS,
  HOLD_AFTER_MS,
  checksumFor,
  handOff,
  kickstartArgs,
  nextUpdateStep,
  releaseTag,
  restartService,
  underLaunchd,
  versionOfTag,
} from '../src/binaryUpdate.js';
import type { RestartOutcome } from '../src/binaryUpdate.js';

describe('release tags', () => {
  it('name a build after its commit, and read it back', () => {
    expect(releaseTag('a91f126')).toBe('build-a91f126');
    expect(versionOfTag('build-a91f126')).toBe('a91f126');
  });

  it('are not builds when they lack the prefix', () => {
    expect(versionOfTag('v1.0.0')).toBeNull();
  });
});

describe('checksumFor', () => {
  const sums = [
    'AAA111  promptd-darwin-arm64',
    'ccc333  install.sh',
    '',
  ].join('\n');

  it('finds the file, lowercased', () => {
    expect(checksumFor(sums, 'promptd-darwin-arm64')).toBe('aaa111');
    expect(checksumFor(sums, 'install.sh')).toBe('ccc333');
  });

  it('answers null for a file it does not list', () => {
    expect(checksumFor(sums, 'promptd-darwin-arm')).toBeNull();
  });
});

describe('underLaunchd', () => {
  it('is true for a launchd job and false in a terminal', () => {
    expect(underLaunchd({ XPC_SERVICE_NAME: 'local.promptd.node' }, 1)).toBe(true);
    expect(underLaunchd({ XPC_SERVICE_NAME: '0' }, 1)).toBe(false);
    expect(underLaunchd({}, 1)).toBe(false);
  });

  it('is false in a shell that an app launchd started handed its name to', () => {
    expect(underLaunchd({ XPC_SERVICE_NAME: 'application.com.microsoft.VSCode.1.2' }, 4242)).toBe(false);
  });
});

describe('restartService', () => {
  const NODE_JOB = { XPC_SERVICE_NAME: 'local.promptd.node' };

  function restart(env: NodeJS.ProcessEnv, launchctl: (args: string[]) => Promise<unknown>, ppid = 1) {
    const exit = vi.fn();
    const done = restartService({ env, ppid, uid: 501, launchctl, exit, waitMs: 1000 });
    return { exit, done };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks launchd to stop the job and start it again', () => {
    expect(kickstartArgs('local.promptd.node', 501)).toEqual(['kickstart', '-k', 'gui/501/local.promptd.node']);
  });

  it('kickstarts its own job under launchd, and keeps running once no restart has come', async () => {
    vi.useFakeTimers();
    const launchctl = vi.fn(async () => {});
    let settled = false;
    const { exit, done } = restart(NODE_JOB, launchctl);
    void done.then(() => {
      settled = true;
    });
    expect(launchctl).toHaveBeenCalledWith(['kickstart', '-k', 'gui/501/local.promptd.node']);
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toEqual({ restarting: false, reason: 'launchd did not restart local.promptd.node within 1s of being asked' });
    expect(exit).not.toHaveBeenCalled();
  });

  it('waits for launchctl to return before the wait begins, since launchd may stop it first', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    let settled = false;
    const launchctl = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { exit, done } = restart(NODE_JOB, launchctl);
    void done.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await done).restarting).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('keeps running, and says why, when launchctl fails', async () => {
    const { exit, done } = restart(NODE_JOB, async () => {
      throw new Error('Could not find service');
    });
    expect(await done).toEqual({ restarting: false, reason: 'launchctl could not restart local.promptd.node: Could not find service' });
    expect(exit).not.toHaveBeenCalled();
  });

  it('only exits outside launchd, never restarting a job it is not', async () => {
    const outside: Array<[NodeJS.ProcessEnv, number]> = [
      [{ XPC_SERVICE_NAME: '0' }, 1],
      [{}, 1],
      [{ XPC_SERVICE_NAME: 'application.com.microsoft.VSCode.1.2' }, 4242],
    ];
    for (const [env, ppid] of outside) {
      const launchctl = vi.fn(async () => {});
      const { exit, done } = restart(env, launchctl, ppid);
      expect(await done).toEqual({ restarting: true });
      expect(launchctl).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    }
  });
});

describe('handOff', () => {
  function steps(outcome: RestartOutcome, { stopDuring }: { stopDuring?: 'signOff' | 'restart' } = {}) {
    let stopped = false;
    const calls: string[] = [];
    return {
      calls,
      signOff: vi.fn(async () => {
        calls.push('signOff');
        if (stopDuring === 'signOff') stopped = true;
      }),
      stopAsked: () => stopped,
      restart: vi.fn(async () => {
        calls.push('restart');
        if (stopDuring === 'restart') stopped = true;
        return outcome;
      }),
      carryOn: vi.fn(async (reason: string) => {
        calls.push(`carryOn: ${reason}`);
      }),
    };
  }

  it('signs off, then restarts, and goes no further once a restart is coming', async () => {
    const handoff = steps({ restarting: true });
    await handOff(handoff);
    expect(handoff.calls).toEqual(['signOff', 'restart']);
  });

  it('carries on with the running build, giving the reason, when no restart comes', async () => {
    const handoff = steps({ restarting: false, reason: 'launchd did not restart local.promptd.node within 5s of being asked' });
    await handOff(handoff);
    expect(handoff.calls).toEqual([
      'signOff',
      'restart',
      'carryOn: launchd did not restart local.promptd.node within 5s of being asked',
    ]);
  });

  it('stops for good on a signal during the sign-off, without restarting', async () => {
    const handoff = steps({ restarting: false, reason: 'unused' }, { stopDuring: 'signOff' });
    await handOff(handoff);
    expect(handoff.calls).toEqual(['signOff']);
  });

  it('stops for good on a signal during the wait for the restart, rather than carrying on', async () => {
    const handoff = steps({ restarting: false, reason: 'launchd did not restart' }, { stopDuring: 'restart' });
    await handOff(handoff);
    expect(handoff.carryOn).not.toHaveBeenCalled();
  });
});

describe('nextUpdateStep', () => {
  it('restarts the moment nothing is running, however long it has waited', () => {
    expect(nextUpdateStep({ running: 0, waitedMs: 0, holding: false })).toBe('restart');
    expect(nextUpdateStep({ running: 0, waitedMs: GIVE_UP_AFTER_MS, holding: true })).toBe('restart');
  });

  it('waits while runs go on, without holding new ones for the first hour', () => {
    expect(nextUpdateStep({ running: 2, waitedMs: HOLD_AFTER_MS - 1, holding: false })).toBe('wait');
  });

  it('holds new runs once it has waited an hour, and only once', () => {
    expect(nextUpdateStep({ running: 1, waitedMs: HOLD_AFTER_MS, holding: false })).toBe('hold');
    expect(nextUpdateStep({ running: 1, waitedMs: HOLD_AFTER_MS, holding: true })).toBe('wait');
  });

  it('gives up after four hours of runs', () => {
    expect(nextUpdateStep({ running: 1, waitedMs: GIVE_UP_AFTER_MS, holding: true })).toBe('give up');
  });
});
