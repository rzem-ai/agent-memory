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
import type { Mesh } from "../../src/observability/mesh.js";
import type { MeshEvent } from "../../src/observability/mesh-events.js";
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

async function connect(identity: AgentIdentity, deps: ServerDeps = fakeDeps()) {
  const server = createServer(deps, identity);
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

/** A mesh that records instead of posting. `agent`, `id` and `ts` are the emitter's job, so they are faked here. */
function recordingMesh(): Mesh & { events: MeshEvent[] } {
  const events: MeshEvent[] = [];
  return {
    events,
    emit: (event) => {
      events.push({ ...event, agent: "memory", id: `e${events.length}`, ts: new Date().toISOString() });
    },
    announce: () => undefined,
    farewell: () => Promise.resolve(),
  };
}

describe("mesh telemetry", () => {
  it("every call is bracketed by tool.called and tool.result, seen from this side", async () => {
    const mesh = recordingMesh();
    const server = createServer({ ...fakeDeps(), mesh }, FULL);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "telemetry-test", version: "0.0.0" });
    await client.connect(clientTransport);

    await client.callTool({ name: "memory_search", arguments: { query: "retry backoff", corpus: "thoughts", limit: 3 } });
    expect(mesh.events.map((e) => e.type)).toEqual(["tool.called", "tool.result"]);
    expect(mesh.events[0]?.payload).toEqual({ name: "memory_search", inputSummary: 'query="retry backoff" corpus="thoughts" limit=3' });
    expect(mesh.events[1]?.payload).toMatchObject({ name: "memory_search", ok: true });
    expect(typeof mesh.events[1]?.payload.durationMs).toBe("number");
    expect(mesh.events.every((e) => e.correlationId === "")).toBe(true);
    await client.close();
  });

  it("a scope refusal is a tool.result with ok:false, and a capture body never appears in the summary", async () => {
    const mesh = recordingMesh();
    const server = createServer({ ...fakeDeps(), mesh }, { name: "reader", agents: ["default"], scopes: ["memory:read"] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "telemetry-test", version: "0.0.0" });
    await client.connect(clientTransport);

    const body = "x".repeat(400);
    await client.callTool({ name: "memory_capture", arguments: { content: body, tags: ["a", "b"] } });
    expect(mesh.events[1]?.payload).toMatchObject({ name: "memory_capture", ok: false });
    const summary = String(mesh.events[0]?.payload.inputSummary);
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary).toContain("tags=[2]");
    expect(summary).not.toContain(body);
    await client.close();
  });

  it("without a mesh on the context, tools run untouched", async () => {
    const client = await connect(FULL);
    const result = await client.callTool({ name: "memory_kv_list", arguments: {} });
    expect(result.isError).not.toBe(true);
    await client.close();
  });
});

describe("vault reads carry the credential's namespaces", () => {
  it("memory_search (documents), memory_read_document and every memory_tree op", async () => {
    const seen: string[][] = [];
    const deps = fakeDeps();
    deps.vault = {
      searchDocuments: async (_q, o) => {
        seen.push([...o.agents]);
        return [];
      },
      treeList: async (o) => {
        seen.push([...o.agents]);
        return [];
      },
      treeRead: async (_p, o) => {
        seen.push([...o.agents]);
        return null;
      },
      treeSearch: async (_q, o) => {
        seen.push([...o.agents]);
        return [];
      },
      readDocument: async (_id, o) => {
        seen.push([...o.agents]);
        return null;
      },
    };
    const client = await connect({ name: "alex-token", agents: ["alex"], scopes: ["memory:read"] }, deps);
    await client.callTool({ name: "memory_search", arguments: { query: "q", corpus: "documents" } });
    await client.callTool({ name: "memory_read_document", arguments: { document_id: "doc-1" } });
    await client.callTool({ name: "memory_tree", arguments: { op: "list" } });
    await client.callTool({ name: "memory_tree", arguments: { op: "list", path: "mail/2026" } });
    await client.callTool({ name: "memory_tree", arguments: { op: "read", path: "mail/2026" } });
    await client.callTool({ name: "memory_tree", arguments: { op: "search", query: "q" } });
    expect(seen).toEqual([["alex"], ["alex"], ["alex"], ["alex"], ["alex"], ["alex"]]);
  });
});
