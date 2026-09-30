import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type * as EventsModule from '../src/events.js';
import type * as SystemModule from '../src/system.js';
import type { BusEvent, SystemSample } from '../src/types.js';

let system: typeof SystemModule;
let events: typeof EventsModule;
let monitor: (typeof SystemModule)['systemMonitor'];
let heard: BusEvent[];
let running: Array<{ name: string; kind: 'cron'; startedAt: string }>;

beforeAll(async () => {
  system = await import('../src/system.js');
  events = await import('../src/events.js');
  monitor = system.systemMonitor;
  events.bus.on('event', (event) => {
    if (event.type === 'system:alert' || event.type === 'system:cleared') heard.push(event);
  });
});

beforeEach(() => {
  heard = [];
  running = [];
  monitor.alerts = new Map();
  monitor.samples = [];
  monitor.runningCrons = () => running;
});

/** A full minute of samples at one reading, ending now. */
function minuteOf(reading: Partial<SystemSample>): SystemSample[] {
  const count = Math.round(60000 / system.SAMPLE_INTERVAL_MS);
  return Array.from({ length: count }, (_, index) => ({
    at: new Date(Date.now() - (count - 1 - index) * system.SAMPLE_INTERVAL_MS).toISOString(),
    cpu: 10,
    memory: 40,
    io: 1,
    disk: 50,
    ...reading,
  }));
}

function check(reading: Partial<SystemSample>): BusEvent[] {
  monitor.samples = minuteOf(reading);
  heard = [];
  monitor.checkAlerts();
  return heard;
}

/** As if the ten-minute cooldown on the last announcement had run out. */
function outlastCooldown(metric: string): void {
  monitor.alerts.get(metric)!.lastSentAt -= system.ALERT_COOLDOWN_MS + 1;
}

/** A node that has been up a while: its first full window was quiet. */
function settled(): void {
  check({});
}

describe('the first window after a start', () => {
  it('reports an alert already over its line as seeded, once', () => {
    expect(check({ disk: 90 }).filter((event) => event.type === 'system:alert')).toMatchObject([
      { metric: 'disk', seeded: true },
    ]);
    expect(check({ disk: 90 })).toEqual([]);
  });

  it('closes what the last process left open when the metric is well under its line', () => {
    expect(check({ disk: 50 }).filter((event) => event.metric === 'disk')).toMatchObject([{ type: 'system:cleared' }]);
  });

  it('treats a seeded alert as the episode it is, so it clears and fires as usual', () => {
    check({ disk: 90 });
    expect(check({ disk: 60 })).toMatchObject([{ type: 'system:cleared', metric: 'disk' }]);
    outlastCooldown('disk');
    expect(check({ disk: 90 })).toMatchObject([{ type: 'system:alert', metric: 'disk' }]);
    expect(heard[0]!.seeded).toBeUndefined();
  });
});

describe('alerts that get worse', () => {
  beforeEach(settled);

  it('says so again when the free disk space halves', () => {
    expect(check({ disk: 90 }).map((event) => event.worse)).toEqual([undefined]);
    outlastCooldown('disk');
    expect(check({ disk: 92 })).toEqual([]);
    expect(check({ disk: 95 })).toMatchObject([{ type: 'system:alert', metric: 'disk', worse: true }]);
    // Judged against what it last said: 5% free now, so 2.5% is the next line.
    outlastCooldown('disk');
    expect(check({ disk: 96 })).toEqual([]);
  });

  it('says so again when crons start running on a busy machine', () => {
    expect(check({ cpu: 95 })).toHaveLength(1);
    outlastCooldown('cpu');
    expect(check({ cpu: 95 })).toEqual([]);
    running = [{ name: 'Nightly', kind: 'cron', startedAt: new Date().toISOString() }];
    expect(check({ cpu: 95 })).toMatchObject([{ type: 'system:alert', metric: 'cpu', worse: true }]);
  });

  it('holds a worsening to the cooldown like any other alert', () => {
    check({ disk: 90 });
    expect(check({ disk: 96 })).toEqual([]);
  });

  it('announces the clear, so the next episode starts a row of its own', () => {
    check({ disk: 90 });
    expect(check({ disk: 60 })).toMatchObject([{ type: 'system:cleared', metric: 'disk' }]);
  });
});
