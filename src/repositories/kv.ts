/**
 * The KV repository over the external memory_kv_store table (PK (agent_id, key),
 * versioned upsert). Ported unchanged from the prior in-process implementation;
 * the namespace argument now always comes from the caller's credential, never
 * from a tool parameter.
 */

import type { MemoryQuery } from "../db/pool.js";

export interface KvRepository {
  get(agentId: string, key: string): Promise<unknown>;
  set(agentId: string, key: string, value: unknown): Promise<void>;
  delete(agentId: string, key: string): Promise<boolean>;
  list(agentId: string): Promise<Record<string, unknown>>;
}

export function createKvRepository(query: MemoryQuery): KvRepository {
  return {
    async get(agentId, key) {
      const result = await query<{ value: unknown }>(
        `SELECT value FROM memory_kv_store WHERE agent_id = $1 AND key = $2`,
        [agentId, key],
      );
      return result.rows[0]?.value ?? null;
    },

    async set(agentId, key, value) {
      await query(
        `INSERT INTO memory_kv_store (agent_id, key, value)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (agent_id, key) DO UPDATE
         SET value = $3::jsonb, version = memory_kv_store.version + 1, updated_at = NOW()`,
        [agentId, key, JSON.stringify(value)],
      );
    },

    async delete(agentId, key) {
      const result = await query(`DELETE FROM memory_kv_store WHERE agent_id = $1 AND key = $2`, [agentId, key]);
      return (result.rowCount ?? 0) > 0;
    },

    async list(agentId) {
      const result = await query<{ key: string; value: unknown }>(
        `SELECT key, value FROM memory_kv_store WHERE agent_id = $1 ORDER BY key`,
        [agentId],
      );
      return Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
    },
  };
}
