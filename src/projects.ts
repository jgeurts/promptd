import { randomUUID } from 'node:crypto';

import { db } from './db.js';
import type { Project, ProjectInput } from './types.js';

/** What the sidebar draws beside a project's name. */
export interface ProjectSummary extends Project {
  /** Crons and one-time executions in it, together. */
  jobs: number;
  /** How many of them are running now. */
  running: number;
  /** How many have an update nobody has opened yet. */
  updated: number;
}

/** A job as the page lists it, reduced to what the counts need. */
export interface SummarizedJob {
  projectId: string | null;
  isRunning: boolean;
  activity: { unread: boolean };
}

/**
 * Every project with its counts, in name order, judged on the same views the
 * lists draw so a project says "running" exactly when one of its rows does.
 * Pure over what the routes already have, so it is tested without a database.
 */
export function projectSummaries(projects: Project[], jobs: SummarizedJob[]): ProjectSummary[] {
  return [...projects]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((project) => {
      const own = jobs.filter((job) => job.projectId === project.id);
      return {
        ...project,
        jobs: own.length,
        running: own.filter((job) => job.isRunning).length,
        updated: own.filter((job) => job.activity.unread).length,
      };
    });
}

export async function listProjects(): Promise<Project[]> {
  const rows = await db().selectFrom('projects').selectAll().execute();
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProject(id: string): Promise<Project | null> {
  return (await db().selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst()) ?? null;
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const now = new Date().toISOString();
  const project: Project = { id: randomUUID(), name: input.name, description: input.description, createdAt: now, updatedAt: now };
  await db().insertInto('projects').values(project).execute();
  return project;
}

export async function updateProject(id: string, input: ProjectInput): Promise<Project | null> {
  const existing = await getProject(id);
  if (!existing) return null;
  const project: Project = { ...existing, name: input.name, description: input.description, updatedAt: new Date().toISOString() };
  await db().updateTable('projects').set({ name: project.name, description: project.description, updatedAt: project.updatedAt }).where('id', '=', id).execute();
  return project;
}

/** Its jobs stay, with no project. */
export async function deleteProject(id: string): Promise<boolean> {
  return db()
    .transaction()
    .execute(async (trx) => {
      await trx.updateTable('crons').set({ projectId: null }).where('projectId', '=', id).execute();
      await trx.updateTable('executions').set({ projectId: null }).where('projectId', '=', id).execute();
      const result = await trx.deleteFrom('projects').where('id', '=', id).executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    });
}
