/**
 * Authentication: the static bearer table, the façade's resolution order, the
 * development override, and the RFC 9728 metadata document.
 */

import { describe, expect, it } from "vitest";
import { BearerTable, constantTimeEqual } from "../../src/auth/bearer.js";
import { Authenticator } from "../../src/auth/authenticator.js";
import { primaryAgent } from "../../src/auth/identity.js";
import { ConfigSchema, PLACEHOLDER_AUDIENCE, PLACEHOLDER_ISSUER } from "../../src/config/index.js";

const ENV = { TEST_TOKEN_A: "secret-a", TEST_TOKEN_B: "secret-b" };

const TOKENS = [
  { name: "claude-code", secret: { env: "TEST_TOKEN_A" }, agents: ["default"], scopes: ["memory:read", "memory:write"] },
  { name: "admin", secret: { env: "TEST_TOKEN_B" }, agents: ["*"], scopes: ["memory:read", "memory:write", "memory:admin"] },
];

function authConfig(over: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    database: { database: "memory_test" },
    auth: { enabled: true, tokens: TOKENS, ...over },
  }).auth;
}

describe("constantTimeEqual", () => {
  it("matches equal strings and rejects unequal ones", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("BearerTable", () => {
  it("maps a matched secret to its identity", () => {
    const table = new BearerTable(authConfig().tokens, ENV);
    expect(table.match("secret-a")).toEqual({
      name: "claude-code",
      agents: ["default"],
      scopes: ["memory:read", "memory:write"],
    });
    expect(table.match("secret-b")?.agents).toEqual(["*"]);
    expect(table.match("wrong")).toBeNull();
  });

  it("fails construction on a missing secret", () => {
    expect(() => new BearerTable(authConfig().tokens, {})).toThrow(/empty or unavailable/);
  });
});

describe("Authenticator", () => {
  it("rejects a missing or malformed Authorization header", async () => {
    const auth = new Authenticator(authConfig(), ENV);
    expect(await auth.authenticate(undefined)).toBeNull();
    expect(await auth.authenticate("Basic Zm9v")).toBeNull();
    expect(await auth.authenticate("Bearer ")).toBeNull();
  });

  it("resolves a static bearer before trying OAuth", async () => {
    const auth = new Authenticator(authConfig(), ENV);
    const identity = await auth.authenticate("Bearer secret-a");
    expect(identity?.name).toBe("claude-code");
  });

  it("returns null for an unknown token when OAuth is disabled", async () => {
    const auth = new Authenticator(authConfig(), ENV);
    expect(await auth.authenticate("Bearer not-a-token")).toBeNull();
  });

  it("auth disabled grants a full-scope wildcard identity", async () => {
    const auth = new Authenticator(authConfig({ enabled: false }), ENV);
    const identity = await auth.authenticate(undefined);
    expect(identity?.agents).toEqual(["*"]);
    expect(identity?.scopes).toContain("memory:admin");
  });

  it("serves the RFC 9728 protected-resource metadata", () => {
    const auth = new Authenticator(authConfig(), ENV);
    const doc = auth.protectedResourceMetadata();
    expect(doc.resource).toBe(PLACEHOLDER_AUDIENCE);
    expect(doc.authorization_servers).toEqual([PLACEHOLDER_ISSUER]);
    expect(doc.scopes_supported).toEqual(["memory:read", "memory:write", "memory:admin"]);
  });

  it("derives the challenge metadata URL from the audience", () => {
    const auth = new Authenticator(authConfig(), ENV);
    expect(auth.resourceMetadataUrl()).toBe(`${PLACEHOLDER_AUDIENCE}/.well-known/oauth-protected-resource`);
  });
});

describe("primaryAgent", () => {
  it("returns the first concrete agent, skipping wildcards", () => {
    expect(primaryAgent({ name: "x", agents: ["default"], scopes: [] })).toBe("default");
    expect(primaryAgent({ name: "x", agents: ["*", "default"], scopes: [] })).toBe("default");
    expect(primaryAgent({ name: "x", agents: ["*"], scopes: [] })).toBeNull();
  });
});
