/**
 * The transport gate, over a real port with fake repositories:
 *
 * - a v1 SDK client (pinned @modelcontextprotocol/sdk@1.29.0, protocol
 *   <= 2025-11-25) completes initialize -> tools/list -> tools/call
 * - a raw modern-era (2026-07-28) request gets server/discover and
 *   resultType-carrying results
 * - no credential -> 401 with the RFC 9728 WWW-Authenticate challenge
 * - /health and /.well-known/oauth-protected-resource are public
 * - a scoped token is denied out-of-scope tools THROUGH the wire
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Client as V1Client } from "v1sdk/client/index.js";
import { StreamableHTTPClientTransport as V1Transport } from "v1sdk/client/streamableHttp.js";
import { buildHttpServer } from "../src/http.js";
import { Authenticator } from "../src/auth/authenticator.js";
import { ConfigSchema, PLACEHOLDER_AUDIENCE, PLACEHOLDER_ISSUER } from "../src/config/index.js";
import { createLogger } from "../src/observability/logger.js";
import type { ServerDeps } from "../src/server.js";
import type { CaptureResult, RankedResult } from "../src/repositories/thoughts.js";

const ENV = { HTTP_TEST_TOKEN: "full-token", HTTP_TEST_READONLY: "read-token" };

const config = ConfigSchema.parse({
  database: { database: "memory_test" },
  auth: {
    enabled: true,
    tokens: [
      { name: "full", secret: { env: "HTTP_TEST_TOKEN" }, agents: ["default"], scopes: ["memory:read", "memory:write", "memory:admin"] },
      { name: "reader", secret: { env: "HTTP_TEST_READONLY" }, agents: ["default"], scopes: ["memory:read"] },
    ],
  },
});

function fakeDeps(): ServerDeps {
  return {
    thoughts: {
      searchRanked: async (): Promise<RankedResult[]> => [],
      capture: async (): Promise<CaptureResult> => ({ id: "http-cap", skipped: false, superseded: 0, duplicate_of: null }),
      forget: async () => true,
    },
    kv: { get: async () => null, set: async () => undefined, delete: async () => false, list: async () => ({}) },
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

let baseUrl = "";
let server: ReturnType<typeof buildHttpServer>;

beforeAll(async () => {
  const authenticator = new Authenticator(config.auth, ENV);
  server = buildHttpServer({ config, authenticator, serverDeps: fakeDeps(), log: createLogger("error") });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("public routes", () => {
  it("serves /health without auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("serves the RFC 9728 document without auth, on bare and prefixed paths", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/memory/.well-known/oauth-protected-resource"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.resource).toBe(PLACEHOLDER_AUDIENCE);
      expect(doc.authorization_servers).toEqual([PLACEHOLDER_ISSUER]);
    }
  });
});

describe("the 401 challenge", () => {
  it("rejects an uncredentialled /mcp POST with the resource_metadata challenge", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate");
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(`resource_metadata="${PLACEHOLDER_AUDIENCE}/.well-known/oauth-protected-resource"`);
  });
});

describe("v1 (2025-era) client leg", () => {
  it("initialize -> tools/list -> tools/call with a bearer header", async () => {
    const transport = new V1Transport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: "Bearer full-token" } },
    });
    const client = new V1Client({ name: "v1-leg", version: "0.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(9);
    const result = await client.callTool({ name: "memory_capture", arguments: { content: "via v1", tags: [] } });
    expect(JSON.stringify(result.content)).toContain("Memory captured successfully (id: http-cap)");
    await client.close();
  });

  it("enforces scopes through the wire", async () => {
    const transport = new V1Transport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: "Bearer read-token" } },
    });
    const client = new V1Client({ name: "v1-reader", version: "0.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "memory_capture", arguments: { content: "denied", tags: [] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("memory:write");
    await client.close();
  });
});

describe("modern (2026-07-28) era leg", () => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "raw-modern", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  it("answers server/discover with the modern advertisement", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer full-token",
        "Mcp-Method": "server/discover",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result.supportedVersions).toEqual(["2026-07-28"]);
    expect(body.result.resultType).toBe("complete");
    expect(body.result).toHaveProperty("ttlMs");
    expect(body.result).toHaveProperty("cacheScope");
  });

  it("serves a modern tools/call with resultType on the result", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer full-token",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "memory_capture",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memory_capture", arguments: { content: "via modern", tags: [] }, _meta: meta },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { resultType: string; content: { text: string }[] } };
    expect(body.result.resultType).toBe("complete");
    expect(body.result.content[0]?.text).toContain("Memory captured successfully (id: http-cap)");
  });
});
