import path from 'node:path';

import Database from 'better-sqlite3';
import { CamelCasePlugin, Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely';
import type { Generated } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Migration, MigrationResultSet } from 'kysely/migration';
import pg from 'pg';

import { ROOT } from './paths.js';

/** 0 or 1 in both dialects, so one schema serves SQLite and Postgres. */
type Flag = number;

/** A setting a job may leave to its node's defaults, stored as null when it does. */
type Setting<T> = T | null;

interface JobColumns {
  id: string;
  name: string;
  nameInferred: Flag;
  description: string;
  workingDirectory: string;
  useWorktree: Setting<Flag>;
  cleanupWorktree: Setting<Flag>;
  retrospective: Setting<Flag>;
  model: Setting<string>;
  effort: Setting<string>;
  /** JSON, one key per Delay for usage box; a key missing or null follows the defaults. */
  usageDelay: string;
  prompt: string;
  isActive: Flag;
  nodeId: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunLog: string | null;
  lastRunDurationSeconds: number | null;
  lifetimeRuns: number | null;
  lifetimeCostUsd: number | null;
  lifetimeRuntimeSeconds: number | null;
}

export interface CronTable extends JobColumns {
  cron: string;
  timezone: string;
}

export interface ExecutionTable extends JobColumns {
  scheduledAt: string | null;
  status: string;
  firedAt: string | null;
  stoppedBy: string | null;
}

export interface NotificationTable {
  id: string;
  at: string;
  kind: string;
  level: string;
  message: string;
  read: Flag;
  cronId: string | null;
  cronName: string | null;
  jobKind: string;
  logFile: string | null;
  nodeId: string | null;
  nodeName: string | null;
  groupKey: string | null;
  count: number;
  since: string | null;
  open: Flag;
  alertValue: number | null;
  alertRunning: number | null;
}

export interface SettingTable {
  key: string;
  value: string;
}

export interface SecretTable {
  key: string;
  value: string;
}

export interface ProjectTable {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface NodeTable {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  commit: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  settings: Generated<string>;
}

export interface Tables {
  crons: CronTable;
  executions: ExecutionTable;
  notifications: NotificationTable;
  settings: SettingTable;
  nodes: NodeTable;
  projects: ProjectTable;
  secrets: SecretTable;
}

export type Db = Kysely<Tables>;

export const SQLITE_FILE = path.join(ROOT, 'promptd.sqlite');

function jobTable(db: Kysely<unknown>, name: string) {
  return db.schema
    .createTable(name)
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('working_directory', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('use_worktree', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('cleanup_worktree', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('model', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('effort', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('usage_delay', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('prompt', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('node_id', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .addColumn('last_run_at', 'text')
    .addColumn('last_run_status', 'text')
    .addColumn('last_run_log', 'text')
    .addColumn('last_run_duration_seconds', 'double precision')
    .addColumn('lifetime_runs', 'integer')
    .addColumn('lifetime_cost_usd', 'double precision')
    .addColumn('lifetime_runtime_seconds', 'double precision');
}

interface LegacyNotification {
  id: string;
  kind: string;
  message: string;
  cronName: string | null;
}

/**
 * What a notification's wording says after the job name it was written with:
 * `"Nightly" failed in 4s` is `failed in 4s`. Read off the name rather than
 * searched for, so a job called "Restart stopped services" is not a stop.
 */
function afterJobName({ message, cronName }: LegacyNotification): string | null {
  if (cronName === null) return null;
  for (const prefix of [`"${cronName}" `, `one-time "${cronName}" `]) {
    if (message.startsWith(prefix)) return message.slice(prefix.length);
  }
  return null;
}

/** The level a notification written before there were levels is worth. */
function legacyLevel(row: LegacyNotification): 'action' | 'worth' | 'routine' {
  const { kind, message } = row;
  const rest = afterJobName(row);
  switch (kind) {
    case 'worktree-failed':
    case 'cron-broken':
      return 'action';
    // Everything that did not succeed was written as this kind. Only a run the
    // user stopped is routine; a wording that cannot be read stays a failure.
    case 'run-failed':
      return rest !== null && /^stopped\b/.test(rest) ? 'routine' : 'action';
    case 'retrospective':
      return 'worth';
    case 'system':
      return message.startsWith('Low disk space') ? 'action' : 'worth';
    case 'update':
      if (message.startsWith('Update script failed') || message.startsWith('Update gave up')) return 'action';
      return message.startsWith('Update started') ? 'worth' : 'routine';
    case 'delayed':
      return rest !== null && (rest.startsWith('is waiting on ') || rest.startsWith('missed its trigger by ')) ? 'worth' : 'routine';
    default:
      return 'routine';
  }
}

// Kept in code rather than read from a folder, so the compiled build carries
// them. Column types stay to the set SQLite and Postgres both understand.
const MIGRATIONS: Record<string, Migration> = {
  '20260925_001_initial': {
    async up(db: Kysely<unknown>): Promise<void> {
      await jobTable(db, 'crons').addColumn('cron', 'text', (col) => col.notNull()).execute();
      await jobTable(db, 'executions')
        .addColumn('scheduled_at', 'text')
        .addColumn('status', 'text', (col) => col.notNull().defaultTo('scheduled'))
        .addColumn('fired_at', 'text')
        .addColumn('stopped_by', 'text')
        .execute();
      await db.schema.createIndex('executions_scheduled_at').on('executions').column('scheduled_at').execute();
      await db.schema
        .createTable('notifications')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('at', 'text', (col) => col.notNull())
        .addColumn('kind', 'text', (col) => col.notNull())
        .addColumn('message', 'text', (col) => col.notNull())
        .addColumn('read', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('cron_id', 'text')
        .addColumn('cron_name', 'text')
        .addColumn('job_kind', 'text', (col) => col.notNull().defaultTo('cron'))
        .execute();
      await db.schema.createIndex('notifications_at').on('notifications').column('at').execute();
      await db.schema
        .createTable('settings')
        .addColumn('key', 'text', (col) => col.primaryKey())
        .addColumn('value', 'text', (col) => col.notNull())
        .execute();
      await db.schema
        .createTable('nodes')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('hostname', 'text')
        .addColumn('platform', 'text')
        .addColumn('commit', 'text')
        .addColumn('first_seen_at', 'text', (col) => col.notNull())
        .addColumn('last_seen_at', 'text', (col) => col.notNull())
        .execute();
    },
  },
  // Apart from settings, which the page reads back whole: nothing here may reach a response.
  '20260925_002_secrets': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('secrets')
        .addColumn('key', 'text', (col) => col.primaryKey())
        .addColumn('value', 'text', (col) => col.notNull())
        .execute();
    },
  },
  '20260929_001_node_settings': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('nodes').addColumn('settings', 'text', (col) => col.notNull().defaultTo('{}')).execute();
    },
  },
  '20260929_002_cron_timezone': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('crons').addColumn('timezone', 'text', (col) => col.notNull().defaultTo('')).execute();
    },
  },
  '20260929_003_retrospective': {
    async up(db: Kysely<unknown>): Promise<void> {
      for (const table of ['crons', 'executions']) {
        await db.schema.alterTable(table).addColumn('retrospective', 'integer', (col) => col.notNull().defaultTo(0)).execute();
      }
      // The run a notification is about, so its link can open that log.
      await db.schema.alterTable('notifications').addColumn('log_file', 'text').execute();
    },
  },
  '20260930_001_projects': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('projects')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('description', 'text', (col) => col.notNull().defaultTo(''))
        .addColumn('created_at', 'text', (col) => col.notNull())
        .addColumn('updated_at', 'text', (col) => col.notNull())
        .execute();
      for (const table of ['crons', 'executions']) {
        await db.schema.alterTable(table).addColumn('project_id', 'text').execute();
      }
    },
  },
  // The machine a notification is about. Rows written before this have none,
  // and are left without one rather than credited to a node that is a guess.
  '20260930_002_notification_nodes': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('notifications').addColumn('node_id', 'text').execute();
      await db.schema.alterTable('notifications').addColumn('node_name', 'text').execute();
    },
  },
  // How much each notification asks of its reader. The rows already written
  // are sorted by what they say, which is all they have to go on; the ones
  // that would not be written at all now become routine, and routine is read.
  '20260930_003_notification_levels': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('notifications').addColumn('level', 'text', (col) => col.notNull().defaultTo('routine')).execute();
      const { rows } = await sql<LegacyNotification>`select id, kind, message, cron_name as "cronName" from notifications`.execute(db);
      const raised: Record<'action' | 'worth', string[]> = { action: [], worth: [] };
      for (const row of rows) {
        const level = legacyLevel(row);
        if (level !== 'routine') raised[level].push(row.id);
      }
      for (const [level, ids] of Object.entries(raised)) {
        for (let start = 0; start < ids.length; start += 500) {
          const batch = ids.slice(start, start + 500);
          await sql`update notifications set level = ${level} where id in (${sql.join(batch)})`.execute(db);
        }
      }
      await sql`update notifications set ${sql.ref('read')} = 1 where level = 'routine'`.execute(db);
    },
  },
  // Repeats of one thing — an alert, an update, a held trigger — land on one
  // row. The rows already written each stand alone, and none is left open.
  '20260930_004_notification_groups': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('notifications').addColumn('group_key', 'text').execute();
      await db.schema.alterTable('notifications').addColumn('count', 'integer', (col) => col.notNull().defaultTo(1)).execute();
      await db.schema.alterTable('notifications').addColumn('since', 'text').execute();
      await db.schema.alterTable('notifications').addColumn('open', 'integer', (col) => col.notNull().defaultTo(0)).execute();
    },
  },
  // What a machine alert's row last announced, so a node that restarts into a
  // worse reading than that is not taken for one repeating itself.
  '20260930_005_notification_alert_readings': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('notifications').addColumn('alert_value', 'double precision').execute();
      await db.schema.alterTable('notifications').addColumn('alert_running', 'integer').execute();
    },
  },
  /**
   * A job now stores null for a setting it leaves to its node's defaults. SQLite
   * cannot drop NOT NULL in place, so each column is copied into a nullable one
   * that takes its name, the same statements in both dialects.
   *
   * A blank model or effort already meant "whatever the CLI uses", which is the
   * built-in default, so those become null. Every other stored value is what
   * its job was set to and is kept as the job's own, so nothing runs
   * differently after the upgrade.
   */
  '20260930_006_job_setting_defaults': {
    async up(db: Kysely<unknown>): Promise<void> {
      const columns = [
        ['use_worktree', 'integer'],
        ['cleanup_worktree', 'integer'],
        ['retrospective', 'integer'],
        ['model', 'text'],
        ['effort', 'text'],
      ] as const;
      for (const table of ['crons', 'executions']) {
        for (const [column, type] of columns) {
          const staged = `${column}_setting`;
          const value = type === 'text' ? sql`nullif(${sql.ref(column)}, '')` : sql.ref(column);
          await db.schema.alterTable(table).addColumn(staged, type).execute();
          await sql`update ${sql.table(table)} set ${sql.ref(staged)} = ${value}`.execute(db);
          await db.schema.alterTable(table).dropColumn(column).execute();
          await db.schema.alterTable(table).renameColumn(staged, column).execute();
        }
        // A box left out of the stored JSON used to mean off, and would now
        // mean "follow the default", so every row is written out in full.
        // The camel case plugin renames result columns, raw queries included.
        const rows = await sql<{ id: string; usageDelay: string }>`select id, usage_delay from ${sql.table(table)}`.execute(db);
        for (const row of rows.rows) {
          let stored: Record<string, unknown> = {};
          try {
            stored = (JSON.parse(row.usageDelay) as Record<string, unknown> | null) ?? {};
          } catch {
            // Unreadable read as all off before, and still does.
          }
          const full = JSON.stringify(Object.fromEntries(['session', 'weekly', 'fable', 'credits'].map((id) => [id, Boolean(stored[id])])));
          if (full !== row.usageDelay) await sql`update ${sql.table(table)} set usage_delay = ${full} where id = ${row.id}`.execute(db);
        }
      }
    },
  },
  // Whether a job's name was taken from its prompt, so a title from claude may still replace it.
  '20260930_007_name_inferred': {
    async up(db: Kysely<unknown>): Promise<void> {
      for (const table of ['crons', 'executions']) {
        await db.schema.alterTable(table).addColumn('name_inferred', 'integer', (col) => col.notNull().defaultTo(0)).execute();
      }
    },
  },
};

export interface DatabaseTarget {
  dialect: 'postgres' | 'sqlite';
  /** A file path for SQLite; the URL with its password hidden for Postgres. */
  location: string;
}

let instance: Db | null = null;
let target: DatabaseTarget | null = null;

function redact(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
}

/** Opens the database once. `url` defaults to DATABASE_URL; unset, it is the SQLite file under the storage root. */
export function openDatabase(url = process.env.DATABASE_URL ?? ''): Db {
  if (instance) return instance;
  if (/^postgres(ql)?:\/\//.test(url)) {
    target = { dialect: 'postgres', location: redact(url) };
    instance = new Kysely<Tables>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
      plugins: [new CamelCasePlugin()],
    });
    return instance;
  }
  const file = url.replace(/^sqlite:/, '') || SQLITE_FILE;
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  target = { dialect: 'sqlite', location: file };
  instance = new Kysely<Tables>({ dialect: new SqliteDialect({ database: sqlite }), plugins: [new CamelCasePlugin()] });
  return instance;
}

export function db(): Db {
  return instance ?? openDatabase();
}

export function databaseTarget(): DatabaseTarget {
  db();
  if (!target) throw new Error('the database has not been opened');
  return target;
}

/** Brings the schema up to date, or only as far as `to` — which is how a test sets up an older store. */
export async function migrate(to: string | null = null): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db: db(),
    provider: { getMigrations: async () => MIGRATIONS },
  });
  const result = to ? await migrator.migrateTo(to) : await migrator.migrateToLatest();
  for (const step of result.results ?? []) {
    console.log(`[db] migration ${step.migrationName}: ${step.status}`);
  }
  if (result.error) throw result.error instanceof Error ? result.error : new Error(String(result.error));
  return result;
}

export async function closeDatabase(): Promise<void> {
  const open = instance;
  instance = null;
  target = null;
  await open?.destroy();
}
