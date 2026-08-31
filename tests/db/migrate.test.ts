/**
 * The migration runner core: ordering, skip-applied, per-file transaction
 * framing, rollback on failure, and the shipped migration files themselves
 * (present, ordered, idempotent style).
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyMigrations, loadMigrationFiles, type MigrationFile } from "../../src/db/migrate.js";
import type { MemoryQuery } from "../../src/db/pool.js";

function fakeSession(options: { applied?: string[]; failOn?: string } = {}) {
  const calls: string[] = [];
  const query: MemoryQuery = async (text) => {
    calls.push(text.trim().split(/\s+/).slice(0, 4).join(" "));
    if (text.startsWith("SELECT name FROM")) {
      return { rows: (options.applied ?? []).map((name) => ({ name })) as never[], rowCount: 0 };
    }
    if (options.failOn && text.includes(options.failOn)) {
      throw new Error(`boom on ${options.failOn}`);
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, calls };
}

const FILES: MigrationFile[] = [
  { name: "0001_a.sql", sql: "CREATE TABLE IF NOT EXISTS a (id int)" },
  { name: "0002_b.sql", sql: "CREATE TABLE IF NOT EXISTS b (id int)" },
];

describe("applyMigrations", () => {
  it("applies pending files in order, each framed BEGIN..COMMIT with its record", async () => {
    const { query, calls } = fakeSession();
    const result = await applyMigrations(query, FILES);
    expect(result.applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(result.skipped).toEqual([]);
    const first = calls.indexOf("BEGIN");
    expect(calls.slice(first, first + 4)).toEqual([
      "BEGIN",
      "CREATE TABLE IF NOT",
      "INSERT INTO agent_memory_migrations (name)",
      "COMMIT",
    ]);
  });

  it("skips already-recorded files", async () => {
    const { query } = fakeSession({ applied: ["0001_a.sql"] });
    const result = await applyMigrations(query, FILES);
    expect(result.applied).toEqual(["0002_b.sql"]);
    expect(result.skipped).toEqual(["0001_a.sql"]);
  });

  it("rolls back and stops on a failing migration", async () => {
    // Must not also match the tracking table's own CREATE TABLE IF NOT EXISTS
    // agent_memory_migrations, which runs outside the per-file transaction.
    const { query, calls } = fakeSession({ failOn: "EXISTS a (id int)" });
    await expect(applyMigrations(query, FILES)).rejects.toThrow(/0001_a\.sql failed/);
    expect(calls).toContain("ROLLBACK");
    // The second file must not have been attempted.
    expect(calls.some((c) => c.includes("EXISTS b"))).toBe(false);
  });
});

describe("the shipped migration files", () => {
  const dir = fileURLToPath(new URL("../../migrations", import.meta.url));

  it("exist, in corpus order", async () => {
    const files = await loadMigrationFiles(dir);
    expect(files.map((f) => f.name)).toEqual([
      "0001_thoughts_corpus.sql",
      "0002_vault_corpus.sql",
      "0003_vault_namespace.sql",
    ]);
  });

  it("0003 namespaces the vault corpus without touching chunks", async () => {
    const files = await loadMigrationFiles(dir);
    const sql = files.find((f) => f.name === "0003_vault_namespace.sql")?.sql ?? "";
    expect(sql).toMatch(/ALTER TABLE memory_documents\s+ADD COLUMN IF NOT EXISTS agent_id TEXT/);
    expect(sql).toMatch(/ALTER TABLE memory_tree_nodes\s+ADD COLUMN IF NOT EXISTS agent_id TEXT/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS memory_documents_agent_idx/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS memory_tree_nodes_agent_idx/);
    // Chunks are read only through an inner join on documents; the filter
    // lands on the join, and the largest table stays untouched.
    expect(sql).not.toMatch(/ALTER TABLE memory_chunks/);
    // No backfill: NULL rows are owned by [vault] default_owner at query time.
    expect(sql).not.toMatch(/\bUPDATE\b/);
  });

  it("are idempotent in style - adoption must not break", async () => {
    const files = await loadMigrationFiles(dir);
    for (const file of files) {
      const creates = file.sql.match(/CREATE (TABLE|INDEX|UNIQUE INDEX)(?! IF NOT EXISTS)/g) ?? [];
      expect(creates, `${file.name} has non-idempotent CREATE statements`).toEqual([]);
      expect(file.sql).not.toMatch(/\bDROP TABLE\b/);
    }
  });

  it("cover the load-bearing shapes", async () => {
    const files = await loadMigrationFiles(dir);
    const all = files.map((f) => f.sql).join("\n");
    expect(all).toContain("VECTOR(768)");
    expect(all).toContain("VECTOR(1024)");
    expect(all).toContain("memory_match_thoughts");
    expect(all).toContain("time_window");
    expect(all).toContain("hnsw");
  });
});
