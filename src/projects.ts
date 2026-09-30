import { randomUUID } from 'node:crypto';

import { db } from './db.js';
import type { Project, ProjectInput } from './types.js';

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
