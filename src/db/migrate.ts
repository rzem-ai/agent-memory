/**
 * The migration runner core. This server OWNS the memory tables' DDL (both
 * corpora) as of 2026-08-06; the migrations under migrations/ are the single
 * source of truth for their shapes.
 *
 * Semantics:
 * - A tracking table (agent_memory_migrations) records applied file names.
 * - Files apply in name order; already-recorded names are skipped.
 * - Each file runs in ONE transaction together with its tracking insert, so a
 *   half-applied migration cannot be recorded (and the idempotent DDL style
 *   means re-running a failed one converges rather than erroring).
 * - Every migration is written to ADOPT an existing database: first run
 *   against the live database records the baseline without changing rows.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { MemoryQuery } from "./pool.js";

const TRACKING_TABLE = "agent_memory_migrations";

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    entries.map(async (name) => ({ name, sql: await readFile(path.join(dir, name), "utf8") })),
  );
}

/** Apply pending migrations. `query` must dispatch each call on one session
 *  (a single pg client, not a pool) so BEGIN/COMMIT frame correctly. */
export async function applyMigrations(query: MemoryQuery, files: readonly MigrationFile[]): Promise<MigrateResult> {
  await query(
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
       name       TEXT        PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );
  const done = await query<{ name: string }>(`SELECT name FROM ${TRACKING_TABLE}`);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (done.rows.some((r) => r.name === file.name)) {
      skipped.push(file.name);
      continue;
    }
    await query("BEGIN");
    try {
      await query(file.sql);
      await query(`INSERT INTO ${TRACKING_TABLE} (name) VALUES ($1)`, [file.name]);
      await query("COMMIT");
    } catch (error) {
      await query("ROLLBACK");
      throw new Error(
        `Migration ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    applied.push(file.name);
  }
  return { applied, skipped };
}
