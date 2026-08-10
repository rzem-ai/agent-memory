/**
 * CLI: apply the memory-table migrations. `npm run migrate [-- --config path]`.
 *
 * Uses the [database] block of the config. DDL needs more rights than the
 * serving user typically has - point --config at a variant whose user may
 * CREATE (or set the password env to the admin credential).
 */

import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig, resolveSecret } from "../config/index.js";
import { applyMigrations, loadMigrationFiles } from "../db/migrate.js";
import type { MemoryQuery } from "../db/pool.js";

const config = loadConfig();
const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

const client = new pg.Client({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.user,
  ...(config.database.password ? { password: resolveSecret(config.database.password) } : {}),
});

// One session, not a pool: BEGIN/COMMIT must frame on a single connection.
const query: MemoryQuery = async (text, params) => {
  const result = await client.query(text, params ? [...params] : undefined);
  return { rows: result.rows as never, rowCount: result.rowCount };
};

try {
  await client.connect();
  const files = await loadMigrationFiles(migrationsDir);
  const result = await applyMigrations(query, files);
  for (const name of result.skipped) console.error(`skipped  ${name} (already applied)`);
  for (const name of result.applied) console.error(`applied  ${name}`);
  console.error(
    result.applied.length === 0 ? "up to date" : `done: ${result.applied.length} migration(s) applied`,
  );
} finally {
  await client.end();
}
