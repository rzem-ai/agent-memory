/**
 * The vault read repositories against a recording Drizzle handle - no Postgres.
 * drizzle-orm/pg-proxy hands the driver the same SQL node-postgres would send,
 * so these pin the WHERE clause that 0003 exists to add. The repository's
 * equivalent of thoughts.test.ts faking MemoryQuery.
 */

import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";
import * as schema from "../../src/db/schema.js";
import { createVaultReadRepository } from "../../src/repositories/vault.js";

function recordingDb() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(
    async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
    { schema },
  );
  return { db, calls };
}

const VEC = Array.from({ length: 1024 }, () => 0);
const last = (calls: { sql: string; params: unknown[] }[]) => calls[calls.length - 1]!;

describe("vault read repository namespace scoping", () => {
  it("getDocument filters by the caller's namespaces", async () => {
    const { db, calls } = recordingDb();
    await createVaultReadRepository(db).getDocument("doc-1", ["alex"]);
    expect(last(calls).sql).toContain('"memory_documents"."agent_id" in (');
    expect(last(calls).params).toEqual(["doc-1", "alex"]);
  });

  it("getDocument admits NULL-owner rows when the default owner is in scope", async () => {
    const { db, calls } = recordingDb();
    await createVaultReadRepository(db, { defaultOwner: "alex" }).getDocument("doc-1", ["alex"]);
    expect(last(calls).sql).toContain("is null");
    expect(last(calls).params).toEqual(["doc-1", "alex"]);
  });

  it("getDocument does not admit NULL-owner rows for another namespace", async () => {
    const { db, calls } = recordingDb();
    await createVaultReadRepository(db, { defaultOwner: "alex" }).getDocument("doc-1", ["jackie"]);
    expect(last(calls).sql).not.toContain("is null");
    expect(last(calls).params).toEqual(["doc-1", "jackie"]);
  });

  it("a wildcard identity has no namespace clause at all", async () => {
    const { db, calls } = recordingDb();
    await createVaultReadRepository(db, { defaultOwner: "alex" }).getDocument("doc-1", ["*"]);
    // The projection legitimately lists agent_id (it is a column now); only
    // the WHERE clause must be free of a namespace condition.
    const [, where = ""] = last(calls).sql.split(" where ");
    expect(where).not.toContain("agent_id");
    expect(last(calls).params).toEqual(["doc-1"]);
  });

  it("searchChunks scopes on the joined document, never the chunk", async () => {
    const { db, calls } = recordingDb();
    await createVaultReadRepository(db).searchChunks(VEC, { agents: ["alex"], limit: 5 });
    expect(last(calls).sql).toContain('"memory_documents"."agent_id" in (');
    expect(last(calls).sql).not.toContain('"memory_chunks"."agent_id"');
    expect(last(calls).params).toContain("alex");
  });

  it("every tree read scopes memory_tree_nodes", async () => {
    const { db, calls } = recordingDb();
    const repo = createVaultReadRepository(db);
    await repo.getNodeByPath("mail/2026", ["alex"]);
    await repo.listNodesByDepth(1, ["alex"]);
    await repo.listChildrenOf("mail/2026", ["alex"]);
    await repo.searchNodes(VEC, { agents: ["alex"], limit: 5 });
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.sql).toContain('"memory_tree_nodes"."agent_id" in (');
      expect(call.params).toContain("alex");
    }
  });

  it("listChunksByDocument is deliberately unscoped - it follows a scoped getDocument", async () => {
    const { db, calls } = recordingDb();
    await createVaultReadRepository(db).listChunksByDocument("doc-1");
    expect(last(calls).sql).not.toContain("agent_id");
  });
});
