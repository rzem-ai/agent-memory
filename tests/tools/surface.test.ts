/**
 * The surface-parity test - the port's conformance suite, carried from the
 * prior in-process implementation and retargeted at the nine-tool surface:
 * exact names in registration order, no agent_id anywhere, scope coverage,
 * scope enforcement, and the wildcard-identity capture refusal.
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { MEMORY_TOOL_NAMES, MEMORY_TOOL_SCHEMAS } from "../../src/tools/shared.js";
import { TOOL_SCOPES } from "../../src/auth/scopes.js";
import { createServer, type ServerDeps } from "../../src/server.js";
import type { AgentIdentity } from "../../src/auth/identity.js";
import { createLogger } from "../../src/observability/logger.js";
import type { CaptureResult, RankedResult } from "../../src/repositories/thoughts.js";

const EXPECTED_NAMES = [
  "memory_search",
  "memory_capture",
  "memory_forget",
  "memory_read_document",
  "memory_tree",
  "memory_kv_get",
  "memory_kv_set",
  "memory_kv_delete",
  "memory_kv_list",
];

function fakeDeps(): ServerDeps {
  return {
    thoughts: {
      searchRanked: async (): Promise<RankedResult[]> => [],
      capture: async (): Promise<CaptureResult> => ({ id: "cap-1", skipped: false, superseded: 0, duplicate_of: null }),
      forget: async () => true,
    },
    kv: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => false,
      list: async () => ({}),
    },
    vault: {
      searchDocuments: async () => [],
      treeList: async () => [],
      treeRead: async () => null,
      treeSearch: async () => [],
      readDocument: async () => null,
    },
    search: { defaultMode: "recency_weighted", recencyDecayDays: 90, recencyFloor: 0.1 },
    log: createLogger("error"),
  };
}

async function connect(identity: AgentIdentity) {
  const server = createServer(fakeDeps(), identity);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "surface-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

const FULL: AgentIdentity = { name: "test", agents: ["default"], scopes: ["memory:read", "memory:write", "memory:admin"] };

describe("tool surface parity", () => {
  it("registers exactly the nine tools, in order", async () => {
    const client = await connect(FULL);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(EXPECTED_NAMES);
    await client.close();
  });

  it("the schema registry and the registration order agree", () => {
    expect(MEMORY_TOOL_NAMES).toEqual(EXPECTED_NAMES);
  });

  it("no tool schema mentions agent_id - the credential carries the namespace", async () => {
    const client = await connect(FULL);
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain("agent_id");
    }
    await client.close();
  });

  it("every tool has a scope mapping and every mapping is a real tool", () => {
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it("required/optional field split matches the contract", () => {
    const required = (name: keyof typeof MEMORY_TOOL_SCHEMAS): string[] => {
      const shape = MEMORY_TOOL_SCHEMAS[name].shape as Record<string, z.ZodType>;
      return Object.entries(shape)
        .filter(([, schema]) => !schema.safeParse(undefined).success)
        .map(([key]) => key)
        .sort();
    };
    expect(required("memory_search")).toEqual(["query"]);
    expect(required("memory_capture")).toEqual(["content", "tags"]);
    expect(required("memory_forget")).toEqual(["thought_id"]);
    expect(required("memory_read_document")).toEqual(["document_id"]);
    expect(required("memory_tree")).toEqual(["op"]);
    expect(required("memory_kv_get")).toEqual(["key"]);
    expect(required("memory_kv_set")).toEqual(["key"]);
    expect(required("memory_kv_delete")).toEqual(["key"]);
    expect(required("memory_kv_list")).toEqual([]);
  });
});

describe("scope enforcement", () => {
  it("denies memory_capture to a read-only identity", async () => {
    const client = await connect({ name: "reader", agents: ["default"], scopes: ["memory:read"] });
    const result = await client.callTool({ name: "memory_capture", arguments: { content: "x", tags: [] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("memory:write");
    await client.close();
  });

  it("denies memory_forget without memory:admin", async () => {
    const client = await connect({ name: "writer", agents: ["default"], scopes: ["memory:read", "memory:write"] });
    const result = await client.callTool({
      name: "memory_forget",
      arguments: { thought_id: "00000000-0000-0000-0000-000000000000" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("memory:admin");
    await client.close();
  });

  it("allows an authorised capture and returns the frozen text shape", async () => {
    const client = await connect(FULL);
    const result = await client.callTool({ name: "memory_capture", arguments: { content: "hello", tags: [] } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("Memory captured successfully (id: cap-1)");
    await client.close();
  });

  it("refuses capture for a wildcard-only identity", async () => {
    const client = await connect({ name: "admin", agents: ["*"], scopes: ["memory:read", "memory:write", "memory:admin"] });
    const result = await client.callTool({ name: "memory_capture", arguments: { content: "x", tags: [] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("no concrete namespace");
    await client.close();
  });
});
