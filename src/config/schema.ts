/**
 * The configuration schema. Strict throughout: an unknown key is a config error,
 * not a silent ignore - an identity-provider mismatch is the kind of drift that
 * survives indefinitely when TOML is deep-merged unvalidated.
 *
 * Secrets never sit in the TOML. Every credential field is a SecretRef
 * ({ env } or { file }) resolved at load time (see ./secrets.ts).
 *
 * Deployment identity - the database name, the stdio namespace, the OAuth
 * issuer and audience - is never defaulted to a real value. A default you
 * cannot see in your config file is a default you cannot audit.
 */

import { z } from "zod";

/**
 * The identity-provider placeholders shipped in mcp.example.toml. Enabling
 * OAuth without replacing them is a configuration error, not a silent
 * connection attempt against a host you do not control.
 */
export const PLACEHOLDER_ISSUER = "https://id.example.com/realms/main";
export const PLACEHOLDER_AUDIENCE = "https://memory.example.com";

/** An indirection to a secret: an environment variable or a file path. */
export const SecretRefSchema = z
  .object({
    env: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
  })
  .strict()
  .refine((ref) => Number(ref.env !== undefined) + Number(ref.file !== undefined) === 1, {
    message: "a secret ref needs exactly one of 'env' or 'file'",
  });

export const ScopeSchema = z.enum(["memory:read", "memory:write", "memory:admin"]);

/** One static bearer token: a name (for logs), the secret, and the identity it maps to. */
const StaticTokenSchema = z
  .object({
    name: z.string().min(1),
    secret: SecretRefSchema,
    /** Namespaces this token may touch. `['*']` means all namespaces. */
    agents: z.array(z.string().min(1)).min(1),
    scopes: z.array(ScopeSchema).min(1),
  })
  .strict();

const OAuthSchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * Both also feed the RFC 9728 metadata document and the `resource_metadata`
     * hint in every 401 challenge, so they are read even when OAuth is off -
     * which is why they carry placeholders rather than being required outright.
     * Enabling OAuth without replacing them fails validation (see ConfigSchema).
     */
    issuer: z.string().url().default(PLACEHOLDER_ISSUER),
    audience: z.string().url().default(PLACEHOLDER_AUDIENCE),
    jwks_uri: z.string().url().optional(),
    /** Which JWT claim carries scopes. Keycloak uses 'scope' (space-separated). */
    scope_claim: z.enum(["scope", "scp"]).default("scope"),
    /** Which JWT claim carries the agent namespace list. */
    agents_claim: z.string().min(1).default("memory_agents"),
    /** RFC 9728 metadata URL advertised in the 401 challenge. */
    resource_metadata_url: z.string().url().optional(),
  })
  .strict();

const AuthSchema = z
  .object({
    /** false = every HTTP request is anonymous with full scopes (development only). */
    enabled: z.boolean().default(true),
    tokens: z.array(StaticTokenSchema).default([]),
    oauth: OAuthSchema.prefault({}),
  })
  .strict();

const DatabaseSchema = z
  .object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().positive().default(5432),
    /**
     * The database holding both corpora. Required: pointing a memory server at
     * the wrong database is silent - every search simply returns nothing.
     */
    database: z.string().min(1),
    user: z.string().min(1).default("agent_user"),
    password: SecretRefSchema.optional(),
    max_connections: z.number().int().positive().default(10),
  })
  .strict();

const OllamaModelSchema = (defaultModel: string, defaultDimensions: number) =>
  z
    .object({
      host: z.string().url().default("http://127.0.0.1:11434"),
      model: z.string().min(1).default(defaultModel),
      dimensions: z.number().int().positive().default(defaultDimensions),
    })
    .strict();

const EmbeddingsSchema = z
  .object({
    /** 768-d nomic - the thoughts corpus space. */
    thoughts: OllamaModelSchema("nomic-embed-text", 768).prefault({}),
    /** 1024-d bge-m3 - the vault documents/tree space. */
    documents: OllamaModelSchema("bge-m3", 1024).prefault({}),
  })
  .strict();

const SearchSchema = z
  .object({
    default_mode: z.enum(["recency_weighted", "similarity", "recent", "since"]).default("recency_weighted"),
    recency_decay_days: z.number().positive().default(90),
    recency_floor: z.number().min(0).max(1).default(0.1),
  })
  .strict();

const VaultSchema = z
  .object({
    /** Absolute path of the vault root when mounted on this host; absent = chunk fallback. */
    dir: z.string().min(1).optional(),
    /** The namespace that owns vault rows with no agent_id - rows written before
     *  migration 0003, or by an ingestion pipeline that does not set it yet.
     *  Absent = such rows are visible only to a wildcard identity. */
    default_owner: z.string().min(1).optional(),
  })
  .strict();

const HttpSchema = z
  .object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().positive().default(3010),
  })
  .strict();

const StdioSchema = z
  .object({
    /** The namespace stdio callers act as (the OS process boundary is the auth). */
    agent_id: z.string().min(1),
  })
  .strict();

/**
 * The mesh observatory this server announces itself to (see
 * observability/mesh.ts). Absent, no telemetry leaves the process.
 */
const ObservatorySchema = z
  .object({
    url: z.string().url(),
    /**
     * The name the observatory files this process under. It should match the
     * key the calling agent registers this server as in its `mcpServers`, so
     * the caller's declared edge and this node line up.
     */
    name: z.string().min(1).default("memory"),
    role: z.string().min(1).default("memory · postgres + pgvector"),
    /** Required by the observatory when it is reachable off its own machine. */
    token: SecretRefSchema.optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    http: HttpSchema.prefault({}),
    /** Absent for HTTP-only deployments; the stdio entrypoint requires it. */
    stdio: StdioSchema.optional(),
    /** Required: there is no sensible default database for someone else's data. */
    database: DatabaseSchema,
    embeddings: EmbeddingsSchema.prefault({}),
    search: SearchSchema.prefault({}),
    vault: VaultSchema.prefault({}),
    auth: AuthSchema.prefault({}),
    log_level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
    /** Absent for a server that does not report to a mesh observatory. */
    observatory: ObservatorySchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (!config.auth.oauth.enabled) return;
    if (config.auth.oauth.issuer === PLACEHOLDER_ISSUER) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "oauth", "issuer"],
        message: "set auth.oauth.issuer to your identity provider before enabling OAuth",
      });
    }
    if (config.auth.oauth.audience === PLACEHOLDER_AUDIENCE) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "oauth", "audience"],
        message: "set auth.oauth.audience to this server's resource identifier before enabling OAuth",
      });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type StaticToken = z.infer<typeof StaticTokenSchema>;
