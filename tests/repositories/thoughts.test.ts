/**
 * The dedup/supersession matrix, ported from the prior in-process implementation
 * against a fake MemoryQuery - no Postgres required. These thresholds are the
 * cross-writer contract with every other process writing memory_thoughts.
 */

import { describe, expect, it, vi } from "vitest";
import { CAPTURE, createThoughtsRepository, vectorLiteral } from "../../src/repositories/thoughts.js";
import type { MemoryQuery } from "../../src/db/pool.js";

const HOUR_MS = 60 * 60 * 1000;

const search = { defaultMode: "recency_weighted" as const, recencyDecayDays: 90, recencyFloor: 0.1 };

/** A scripted MemoryQuery: dispatches on SQL shape, records calls. */
function fakeQuery(similarRows: { id: string; created_at: string; similarity: number }[]) {
  const calls: { text: string; params: readonly unknown[] | undefined }[] = [];
  const query: MemoryQuery = async (text, params) => {
    calls.push({ text, params });
    if (text.includes("ORDER BY similarity DESC")) {
      return { rows: similarRows as never[], rowCount: similarRows.length };
    }
    if (text.startsWith("UPDATE memory_thoughts SET deleted")) {
      return { rows: [], rowCount: Array.isArray(params?.[0]) ? (params[0] as unknown[]).length : 1 };
    }
    if (text.includes("INSERT INTO memory_thoughts")) {
      return { rows: [{ id: "new-id" }] as never[], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, calls };
}

function repo(similarRows: { id: string; created_at: string; similarity: number }[]) {
  const { query, calls } = fakeQuery(similarRows);
  const getEmbedding = vi.fn(async () => Array.from({ length: 768 }, () => 0.1));
  const repository = createThoughtsRepository({ query, getEmbedding, search });
  return { repository, calls, getEmbedding };
}

describe("capture dedup/supersession", () => {
  it("skips a near-duplicate at exactly the 0.85 boundary inside 48h", async () => {
    const { repository, calls } = repo([
      { id: "dup-1", created_at: new Date(Date.now() - HOUR_MS).toISOString(), similarity: 0.85 },
    ]);
    const result = await repository.capture("hello", "default", []);
    expect(result).toEqual({ id: null, skipped: true, superseded: 0, duplicate_of: "dup-1" });
    expect(calls.some((c) => c.text.includes("INSERT"))).toBe(false);
  });

  it("does not dedup below the 0.85 threshold", async () => {
    const { repository } = repo([
      { id: "near-1", created_at: new Date(Date.now() - HOUR_MS).toISOString(), similarity: 0.8499 },
    ]);
    const result = await repository.capture("hello", "default", []);
    expect(result.skipped).toBe(false);
    expect(result.id).toBe("new-id");
  });

  it("does not dedup a >= 0.85 match OUTSIDE the 48h window - it supersedes instead", async () => {
    const { repository, calls } = repo([
      { id: "old-1", created_at: new Date(Date.now() - 49 * HOUR_MS).toISOString(), similarity: 0.9 },
    ]);
    const result = await repository.capture("hello", "default", []);
    expect(result).toEqual({ id: "new-id", skipped: false, superseded: 1, duplicate_of: null });
    const update = calls.find((c) => c.text.includes("SET deleted = TRUE WHERE id = ANY"));
    expect(update?.params?.[0]).toEqual(["old-1"]);
  });

  it("caps supersession at 3 stale rows", async () => {
    const old = (n: number) => ({
      id: `old-${n}`,
      created_at: new Date(Date.now() - (49 + n) * HOUR_MS).toISOString(),
      similarity: 0.9 - n * 0.01,
    });
    const { repository } = repo([old(0), old(1), old(2), old(3), old(4)]);
    const result = await repository.capture("hello", "default", []);
    expect(result.superseded).toBe(CAPTURE.supersedeLimit);
  });

  it("ignores weak old matches below 0.80", async () => {
    const { repository } = repo([
      { id: "weak", created_at: new Date(Date.now() - 100 * HOUR_MS).toISOString(), similarity: 0.79 },
    ]);
    const result = await repository.capture("hello", "default", []);
    expect(result.superseded).toBe(0);
  });

  it("embeds exactly once per capture", async () => {
    const { repository, getEmbedding } = repo([]);
    await repository.capture("hello", "default", ["tag"]);
    expect(getEmbedding).toHaveBeenCalledTimes(1);
  });
});

describe("forget namespace guard", () => {
  it("scopes the soft-delete to the identity's agents", async () => {
    const { query, calls } = fakeQuery([]);
    const repository = createThoughtsRepository({ query, getEmbedding: async () => [], search });
    await repository.forget("00000000-0000-0000-0000-000000000000", ["default"]);
    const update = calls[0];
    expect(update?.text).toContain("metadata->>'agent_id' = ANY");
    expect(update?.params?.[1]).toEqual(["default"]);
  });

  it("a wildcard identity forgets without a namespace filter", async () => {
    const { query, calls } = fakeQuery([]);
    const repository = createThoughtsRepository({ query, getEmbedding: async () => [], search });
    await repository.forget("00000000-0000-0000-0000-000000000000", ["*"]);
    expect(calls[0]?.text).toContain("AND TRUE");
  });
});

describe("vectorLiteral", () => {
  it("renders the pgvector literal form", () => {
    expect(vectorLiteral([1, 2.5, -3])).toBe("[1,2.5,-3]");
  });
});
