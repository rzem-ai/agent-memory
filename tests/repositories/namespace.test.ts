/**
 * The one definition of a namespace list, in both dialects: the raw-SQL
 * fragment the thoughts repository interpolates, and the Drizzle clause the
 * vault repositories compose. `agentFilter` is pinned to its historical output
 * so the move out of thoughts.ts changes nothing on the wire.
 */

import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { memoryDocuments } from "../../src/db/schema.js";
import { agentFilter, namespaceWhere, unbounded } from "../../src/repositories/namespace.js";

const render = (clause: SQL) => new PgDialect().sqlToQuery(clause);

describe("unbounded", () => {
  it("is true for an empty list and for the wildcard", () => {
    // [] means "no filter". No credential can carry it today - every identity
    // source forbids it: src/config/schema.ts (.min(1) on static-token agents),
    // src/auth/oauth.ts (an empty claim yields no identity), src/stdio.ts
    // (.min(1) on agent_id), and the auth-disabled path uses ["*"]. If one of
    // those ever loosens, [] must fail closed here instead.
    expect(unbounded([])).toBe(true);
    expect(unbounded(["*"])).toBe(true);
    expect(unbounded(["alex", "*"])).toBe(true);
  });

  it("is false for concrete namespaces", () => {
    expect(unbounded(["alex"])).toBe(false);
    expect(unbounded(["alex", "jackie"])).toBe(false);
  });
});

describe("agentFilter (thoughts corpus, raw SQL)", () => {
  it("is TRUE with no params when unbounded", () => {
    expect(agentFilter(["*"], 4)).toEqual({ clause: "TRUE", params: [] });
  });

  it("is = ANY($n) with the list as the one param when bounded", () => {
    expect(agentFilter(["alex", "jackie"], 4)).toEqual({
      clause: "metadata->>'agent_id' = ANY($4::text[])",
      params: [["alex", "jackie"]],
    });
  });
});

describe("namespaceWhere (vault corpus, Drizzle)", () => {
  it("is undefined when unbounded, so and() drops it", () => {
    expect(namespaceWhere(memoryDocuments.agentId, ["*"])).toBeUndefined();
    expect(namespaceWhere(memoryDocuments.agentId, [])).toBeUndefined();
  });

  it("filters to the list when bounded", () => {
    const clause = namespaceWhere(memoryDocuments.agentId, ["alex", "jackie"]);
    const q = render(clause!);
    expect(q.sql).toContain('"agent_id" in (');
    expect(q.sql).not.toContain("is null");
    expect(q.params).toEqual(["alex", "jackie"]);
  });

  it("admits NULL-owner rows only when the default owner is in the list", () => {
    const q = render(namespaceWhere(memoryDocuments.agentId, ["alex"], "alex")!);
    expect(q.sql).toContain('"agent_id" in (');
    expect(q.sql).toContain("is null");
    expect(q.params).toEqual(["alex"]);
  });

  it("does not admit NULL-owner rows for a list that excludes the default owner", () => {
    const q = render(namespaceWhere(memoryDocuments.agentId, ["jackie"], "alex")!);
    expect(q.sql).not.toContain("is null");
    expect(q.params).toEqual(["jackie"]);
  });
});
