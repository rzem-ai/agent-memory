/**
 * The one definition of what a namespace list means, shared by both corpora.
 * The thoughts repository speaks raw SQL (agentFilter); the vault repositories
 * speak Drizzle (namespaceWhere). Same semantics, two dialects - kept together
 * so `*` cannot come to mean two different things.
 */

import { type SQL, inArray, isNull, or } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/** True when the agent list means "no namespace filter". */
export const unbounded = (agents: readonly string[]): boolean => agents.length === 0 || agents.includes("*");

/** SQL fragment + params for the thoughts namespace filter. With one agent it
 *  matches the historical `metadata->>'agent_id' = $n` shape; with several it
 *  is `= ANY`. */
export function agentFilter(agents: readonly string[], paramOffset: number): { clause: string; params: unknown[] } {
  if (unbounded(agents)) {
    return { clause: "TRUE", params: [] };
  }
  return { clause: `metadata->>'agent_id' = ANY($${paramOffset}::text[])`, params: [[...agents]] };
}

/**
 * The vault namespace filter, for `where(and(...))` composition. `undefined`
 * when unbounded - drizzle's and() drops it.
 *
 * Rows with a NULL agent_id predate 0003 or come from an ingestion pipeline
 * that does not set it. They belong to `defaultOwner`, so they are visible
 * exactly when that namespace is in the caller's list - and to nobody else.
 * With no default owner configured, NULL rows are visible only to a wildcard.
 */
export function namespaceWhere(column: PgColumn, agents: readonly string[], defaultOwner?: string): SQL | undefined {
  if (unbounded(agents)) {
    return undefined;
  }
  const owned = inArray(column, [...agents]);
  if (defaultOwner !== undefined && agents.includes(defaultOwner)) {
    return or(owned, isNull(column));
  }
  return owned;
}
