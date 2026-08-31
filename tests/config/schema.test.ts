/**
 * Deployment identity must be explicit. These pin the absence of defaults that
 * would otherwise be invisible in a config file: a database name, the stdio
 * namespace, and an identity provider left at its shipped placeholder.
 */

import { describe, expect, it } from "vitest";
import { ConfigSchema, PLACEHOLDER_AUDIENCE, PLACEHOLDER_ISSUER } from "../../src/config/index.js";

const DATABASE = { database: "memory_test" };

function parse(input: Record<string, unknown>) {
  return ConfigSchema.safeParse(input);
}

describe("database identity", () => {
  it("rejects a config with no [database] block", () => {
    const result = parse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "database")).toBe(true);
  });

  it("rejects a [database] block with no database name", () => {
    const result = parse({ database: { host: "db.internal" } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "database.database")).toBe(true);
  });

  it("accepts a database name with everything else defaulted", () => {
    const result = parse({ database: DATABASE });
    expect(result.success).toBe(true);
    expect(result.data?.database.host).toBe("127.0.0.1");
    expect(result.data?.database.database).toBe("memory_test");
  });
});

describe("stdio namespace", () => {
  it("omits stdio entirely for an HTTP-only config", () => {
    const result = parse({ database: DATABASE });
    expect(result.success).toBe(true);
    expect(result.data?.stdio).toBeUndefined();
  });

  it("rejects a [stdio] block with no agent_id", () => {
    const result = parse({ database: DATABASE, stdio: {} });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "stdio.agent_id")).toBe(true);
  });

  it("accepts an explicit agent_id", () => {
    const result = parse({ database: DATABASE, stdio: { agent_id: "default" } });
    expect(result.success).toBe(true);
    expect(result.data?.stdio?.agent_id).toBe("default");
  });
});

describe("oauth placeholders", () => {
  it("leaves the placeholders alone while oauth is disabled", () => {
    const result = parse({ database: DATABASE });
    expect(result.success).toBe(true);
    expect(result.data?.auth.oauth.issuer).toBe(PLACEHOLDER_ISSUER);
    expect(result.data?.auth.oauth.audience).toBe(PLACEHOLDER_AUDIENCE);
  });

  it("rejects enabling oauth against the placeholder issuer", () => {
    const result = parse({
      database: DATABASE,
      auth: { oauth: { enabled: true, audience: "https://memory.corp.test" } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "auth.oauth.issuer")).toBe(true);
  });

  it("rejects enabling oauth against the placeholder audience", () => {
    const result = parse({
      database: DATABASE,
      auth: { oauth: { enabled: true, issuer: "https://id.corp.test/realms/main" } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "auth.oauth.audience")).toBe(true);
  });

  it("accepts oauth once both are real", () => {
    const result = parse({
      database: DATABASE,
      auth: {
        oauth: {
          enabled: true,
          issuer: "https://id.corp.test/realms/main",
          audience: "https://memory.corp.test",
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.auth.oauth.enabled).toBe(true);
  });
});

describe("secret references", () => {
  it("requires exactly one secret source", () => {
    expect(parse({ database: { ...DATABASE, password: {} } }).success).toBe(false);
    expect(
      parse({
        database: {
          ...DATABASE,
          password: { env: "DB_PASSWORD", file: "/run/secrets/db-password" },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts either an environment variable or a file", () => {
    expect(parse({ database: { ...DATABASE, password: { env: "DB_PASSWORD" } } }).success).toBe(true);
    expect(
      parse({ database: { ...DATABASE, password: { file: "/run/secrets/db-password" } } }).success,
    ).toBe(true);
  });
});

describe("observatory", () => {
  it("is absent by default", () => {
    const result = parse({ database: DATABASE });
    expect(result.success && result.data.observatory).toBeUndefined();
  });

  it("needs only a url; name and role default to what the mesh expects", () => {
    const result = parse({ database: DATABASE, observatory: { url: "http://localhost:41500" } });
    expect(result.success && result.data.observatory).toEqual({
      url: "http://localhost:41500",
      name: "memory",
      role: "memory · postgres + pgvector",
    });
  });

  it("takes the token as a secret ref and rejects unknown keys", () => {
    const ok = parse({ database: DATABASE, observatory: { url: "http://hub", token: { env: "OBSERVATORY_TOKEN" } } });
    expect(ok.success && ok.data.observatory?.token).toEqual({ env: "OBSERVATORY_TOKEN" });
    expect(parse({ database: DATABASE, observatory: { url: "http://hub", token: "plain" } }).success).toBe(false);
    expect(parse({ database: DATABASE, observatory: { url: "http://hub", colour: "purple" } }).success).toBe(false);
  });
});

describe("vault default owner", () => {
  it("is absent by default - NULL-owner rows are then wildcard-only", () => {
    const result = parse({ database: DATABASE });
    expect(result.success).toBe(true);
    expect(result.data?.vault.default_owner).toBeUndefined();
  });

  it("accepts a namespace", () => {
    const result = parse({ database: DATABASE, vault: { default_owner: "angus" } });
    expect(result.success).toBe(true);
    expect(result.data?.vault.default_owner).toBe("angus");
  });

  it("rejects an empty string", () => {
    const result = parse({ database: DATABASE, vault: { default_owner: "" } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "vault.default_owner")).toBe(true);
  });
});
