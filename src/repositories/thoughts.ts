/**
 * The thoughts repository - ported from the prior in-process implementation,
 * stripped to the surface this server exposes (ranked search, capture, forget).
 * Raw SQL over the MemoryQuery seam against memory_thoughts (owned by this
 * repo's migrations/0001_thoughts_corpus.sql) - 768-d nomic vectors, real
 * timestamptz columns.
 *
 * Dedup/supersession preserved verbatim so writes stay consistent with every
 * other writer to these tables (the ingestion pipeline included):
 * near-duplicate within 48h (cosine >= 0.85) skips; older near-match
 * (>= 0.80) outside the window soft-deletes up to 3, then inserts.
 */

import type { MemoryQuery } from "../db/pool.js";

export type RelevanceMode = "similarity" | "recency_weighted" | "recent" | "since";

export interface MemorySearchConfig {
  defaultMode: RelevanceMode;
  recencyDecayDays: number;
  recencyFloor: number;
}

export interface RankedSearchOptions {
  mode: RelevanceMode;
  /** Namespaces to search. Empty or ['*'] means all agents (no filter). */
  agents: readonly string[];
  limit?: number;
  threshold?: number;
  /** recency_weighted: decay period (days). since: days back from now. */
  value?: number;
  /** Minimum recency multiplier for recency_weighted mode. */
  floor?: number;
}

export interface RankedResult {
  id: string;
  agent_id: string;
  content: string;
  tags: string[];
  similarity: number;
  score: number | null;
  created_at: string;
}

export interface CaptureResult {
  id: string | null;
  skipped: boolean;
  superseded: number;
  duplicate_of: string | null;
}

interface ThoughtRow {
  id: string;
  content: string;
  metadata: { agent_id?: string; tags?: string[] } | null;
  created_at: Date | string;
  similarity: string | number;
  score?: string | number;
}

/** The `[a,b,c]` literal form pgvector accepts for a `::vector` cast. */
export function vectorLiteral(value: readonly number[]): string {
  return `[${value.join(",")}]`;
}

const asIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** Dedup + supersession thresholds - the cross-writer contract. Do not tune. */
export const CAPTURE = {
  dedupThreshold: 0.85,
  dedupWindowMs: 48 * 60 * 60 * 1000,
  supersedeThreshold: 0.8,
  supersedeLimit: 3,
} as const;

/** True when the agent list means "no namespace filter". */
const unbounded = (agents: readonly string[]): boolean => agents.length === 0 || agents.includes("*");

/** SQL fragment + params for the namespace filter. With one agent it matches the
 *  historical `metadata->>'agent_id' = $n` shape; with several it is `= ANY`. */
function agentFilter(agents: readonly string[], paramOffset: number): { clause: string; params: unknown[] } {
  if (unbounded(agents)) {
    return { clause: "TRUE", params: [] };
  }
  return { clause: `metadata->>'agent_id' = ANY($${paramOffset}::text[])`, params: [[...agents]] };
}

export interface ThoughtsRepository {
  searchRanked(query: string, opts: RankedSearchOptions): Promise<RankedResult[]>;
  /** Capture into ONE namespace (the identity's primary agent). */
  capture(content: string, agentId: string, tags: string[]): Promise<CaptureResult>;
  /** Soft-delete, scoped to the identity's namespaces. */
  forget(thoughtId: string, agents: readonly string[]): Promise<boolean>;
}

export interface ThoughtsRepositoryDeps {
  query: MemoryQuery;
  getEmbedding: (text: string) => Promise<number[]>;
  search: MemorySearchConfig;
}

export function createThoughtsRepository(deps: ThoughtsRepositoryDeps): ThoughtsRepository {
  const { query, getEmbedding, search } = deps;

  const mapThought = (row: ThoughtRow, withScore: boolean): RankedResult => ({
    id: row.id,
    agent_id: row.metadata?.agent_id ?? "unknown",
    content: row.content,
    tags: row.metadata?.tags ?? [],
    similarity: Number(row.similarity),
    score: withScore && row.score != null ? Number(row.score) : null,
    created_at: asIso(row.created_at),
  });

  return {
    async searchRanked(queryText, opts) {
      const embedding = await getEmbedding(queryText);
      const vectorStr = vectorLiteral(embedding);
      const threshold = opts.threshold ?? 0.3;
      const limit = opts.limit ?? 5;

      switch (opts.mode) {
        case "similarity": {
          // Deliberately inline SQL rather than the memory_match_thoughts()
          // function (which 0001 ships for external callers): the inline query
          // is semantically identical (1 - cosine distance, threshold filter,
          // distance order) and works for multi-agent identities the function
          // cannot express.
          const filter = agentFilter(opts.agents, 4);
          const result = await query<ThoughtRow>(
            `SELECT id, content, metadata, created_at,
                    1 - (embedding <=> $1::vector) AS similarity
               FROM memory_thoughts
              WHERE embedding IS NOT NULL AND deleted = FALSE
                AND 1 - (embedding <=> $1::vector) > $2
                AND ${filter.clause}
              ORDER BY embedding <=> $1::vector
              LIMIT $3`,
            [vectorStr, threshold, limit, ...filter.params],
          );
          return result.rows.map((r) => mapThought(r, false));
        }

        case "recency_weighted": {
          const decayDays = opts.value ?? search.recencyDecayDays;
          const floor = opts.floor ?? search.recencyFloor;
          const filter = agentFilter(opts.agents, 6);
          const result = await query<ThoughtRow>(
            `SELECT
                id, content, metadata, created_at,
                1 - (embedding <=> $1::vector) AS similarity,
                (1 - (embedding <=> $1::vector))
                  * GREATEST($5, 1.0 - EXTRACT(EPOCH FROM (NOW() - created_at)) / ($4::double precision * 86400))
                  AS score
              FROM memory_thoughts
              WHERE embedding IS NOT NULL
                AND deleted = FALSE
                AND 1 - (embedding <=> $1::vector) > $2
                AND ${filter.clause}
              ORDER BY score DESC
              LIMIT $3`,
            [vectorStr, threshold, limit, decayDays, floor, ...filter.params],
          );
          return result.rows.map((r) => mapThought(r, true));
        }

        case "recent": {
          const filter = agentFilter(opts.agents, 4);
          const result = await query<ThoughtRow>(
            `SELECT
                id, content, metadata, created_at,
                1 - (embedding <=> $1::vector) AS similarity
              FROM memory_thoughts
              WHERE embedding IS NOT NULL
                AND deleted = FALSE
                AND 1 - (embedding <=> $1::vector) > $2
                AND ${filter.clause}
              ORDER BY created_at DESC
              LIMIT $3`,
            [vectorStr, threshold, limit, ...filter.params],
          );
          return result.rows.map((r) => mapThought(r, false));
        }

        case "since": {
          const sinceDays = opts.value ?? 30;
          const filter = agentFilter(opts.agents, 5);
          const result = await query<ThoughtRow>(
            `SELECT
                id, content, metadata, created_at,
                1 - (embedding <=> $1::vector) AS similarity
              FROM memory_thoughts
              WHERE embedding IS NOT NULL
                AND deleted = FALSE
                AND 1 - (embedding <=> $1::vector) > $2
                AND ${filter.clause}
                AND created_at >= NOW() - make_interval(days => $4)
              ORDER BY embedding <=> $1::vector
              LIMIT $3`,
            [vectorStr, threshold, limit, sinceDays, ...filter.params],
          );
          return result.rows.map((r) => mapThought(r, false));
        }
      }
    },

    async capture(content, agentId, tags) {
      const embedding = await getEmbedding(content);
      const vectorStr = vectorLiteral(embedding);

      const similar = await query<{ id: string; created_at: Date | string; similarity: string | number }>(
        `SELECT id, created_at,
                1 - (embedding <=> $1::vector) AS similarity
         FROM memory_thoughts
         WHERE embedding IS NOT NULL
           AND deleted = FALSE
           AND metadata->>'agent_id' = $2
           AND 1 - (embedding <=> $1::vector) > $3
         ORDER BY similarity DESC
         LIMIT $4`,
        [vectorStr, agentId, CAPTURE.supersedeThreshold, CAPTURE.supersedeLimit + 3],
      );

      const now = Date.now();

      for (const row of similar.rows) {
        const sim = Number(row.similarity);
        const age = now - new Date(row.created_at).getTime();
        if (sim >= CAPTURE.dedupThreshold && age < CAPTURE.dedupWindowMs) {
          return { id: null, skipped: true, superseded: 0, duplicate_of: row.id };
        }
      }

      const toSupersede = similar.rows
        .filter((row) => {
          const age = now - new Date(row.created_at).getTime();
          return Number(row.similarity) >= CAPTURE.supersedeThreshold && age >= CAPTURE.dedupWindowMs;
        })
        .slice(0, CAPTURE.supersedeLimit)
        .map((row) => row.id);

      if (toSupersede.length > 0) {
        await query(`UPDATE memory_thoughts SET deleted = TRUE WHERE id = ANY($1::uuid[])`, [toSupersede]);
      }

      const metadata = JSON.stringify({
        agent_id: agentId,
        source: "mcp",
        tags,
        timestamp: new Date().toISOString(),
      });

      const result = await query<{ id: string }>(
        `INSERT INTO memory_thoughts (content, embedding, metadata, scope, confidence)
         VALUES ($1, $2::vector, $3::jsonb, $4, $5)
         RETURNING id`,
        [content, vectorStr, metadata, "episodic", 1.0],
      );
      const inserted = result.rows[0];
      if (!inserted) {
        throw new Error("memory_thoughts insert returned no row");
      }
      return { id: inserted.id, skipped: false, superseded: toSupersede.length, duplicate_of: null };
    },

    async forget(thoughtId, agents) {
      // The namespace guard is new relative to the ported source: a credential
      // scoped to one agent must not delete another agent's thought.
      const filter = agentFilter(agents, 2);
      const result = await query(
        `UPDATE memory_thoughts SET deleted = TRUE
          WHERE id = $1 AND deleted = FALSE AND ${filter.clause}`,
        [thoughtId, ...filter.params],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}
