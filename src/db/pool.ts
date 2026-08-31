/**
 * The one pg.Pool and the two query seams over it:
 *
 * - `MemoryQuery` - the narrow raw-SQL seam the thoughts/KV repositories run
 *   through, carried over from the prior in-process implementation. Kept
 *   minimal so a unit test fakes it with a plain function, no Postgres required.
 * - `VaultDb` - the Drizzle handle the vault read repositories (chunks, tree,
 *   documents) query through.
 *
 * This server OWNS the memory tables' DDL (both corpora) - the source of
 * truth is migrations/, applied via `npm run migrate` (src/cli/migrate.ts).
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AppConfig } from "../config/index.js";
import { resolveSecret } from "../config/index.js";
import * as schema from "./schema.js";

export type MemoryQuery = <R = Record<string, unknown>>(
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: R[]; rowCount: number | null }>;

/** Any Drizzle Postgres handle over the vault schema. Widened from the
 *  node-postgres class so a test can substitute drizzle-orm/pg-proxy's
 *  recording driver - the vault repositories' answer to faking MemoryQuery. */
export type VaultDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Db {
  pool: pg.Pool;
  query: MemoryQuery;
  vault: VaultDb;
  close(): Promise<void>;
}

export function createDb(config: AppConfig["database"]): Db {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    ...(config.password ? { password: resolveSecret(config.password) } : {}),
    max: config.max_connections,
  });
  const query: MemoryQuery = async (text, params) => {
    const result = await pool.query(text, params ? [...params] : undefined);
    return { rows: result.rows as never, rowCount: result.rowCount };
  };
  return {
    pool,
    query,
    vault: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}
