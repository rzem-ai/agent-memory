export { ConfigSchema, SecretRefSchema, ScopeSchema, PLACEHOLDER_ISSUER, PLACEHOLDER_AUDIENCE } from "./schema.js";
export type { AppConfig, Scope, StaticToken } from "./schema.js";
export { resolveSecret } from "./secrets.js";
export type { SecretRef } from "./secrets.js";
export { loadConfig, configPathFromArgv, redactedConfig } from "./loader.js";
