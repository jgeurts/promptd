import { describe, expect, it } from 'vitest';

import { projectSummaries } from '../src/projects.js';
import type { SummarizedJob } from '../src/projects.js';
import type { Project } from '../src/types.js';

function project(id: string, name: string): Project {
  return { id, name, description: '', createdAt: '2026-09-30T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z' };
}

function job(projectId: string | null, { running = false, unread = false } = {}): SummarizedJob {
  return { projectId, isRunning: running, activity: { unread } };
}

describe('projectSummaries', () => {
  it('counts each project\'s jobs, how many run and how many are updated, in name order', () => {
    const found = projectSummaries(
      [project('p2', 'Writing'), project('p1', 'Billing')],
      [job('p1'), job('p1', { running: true, unread: true }), job('p1', { unread: true }), job('p2'), job(null, { running: true })],
    );
    expect(found.map(({ id, name, jobs, running, updated }) => ({ id, name, jobs, running, updated }))).toEqual([
      { id: 'p1', name: 'Billing', jobs: 3, running: 1, updated: 2 },
      { id: 'p2', name: 'Writing', jobs: 1, running: 0, updated: 0 },
    ]);
  });

  it('keeps a project with nothing in it, at zero', () => {
    expect(projectSummaries([project('p1', 'Empty')], [job(null)])).toMatchObject([{ id: 'p1', jobs: 0, running: 0, updated: 0 }]);
  });
});
