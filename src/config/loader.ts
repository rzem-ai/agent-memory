/**
 * Config loading: `--config <path>` / `--config=<path>` argv, else `mcp.toml`
 * beside the working directory, else pure defaults. The parsed TOML is validated
 * strictly by ConfigSchema - unknown keys fail loudly.
 */

import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { ConfigSchema, type AppConfig } from "./schema.js";

export function configPathFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") return argv[i + 1];
    if (arg?.startsWith("--config=")) return arg.slice("--config=".length);
  }
  return undefined;
}

export function loadConfig(argv: readonly string[] = process.argv.slice(2)): AppConfig {
  const explicit = configPathFromArgv(argv);
  const path = explicit ?? "mcp.toml";
  let raw: unknown = {};
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing default file means "run on defaults"; a missing EXPLICIT file
    // (or a parse error anywhere) is an operator mistake and must fail loudly.
    if (!(code === "ENOENT" && explicit === undefined)) {
      throw new Error(
        `Failed to load config ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid config ${path}: ${issues}`);
  }
  return parsed.data;
}

/** The config with anything secret-adjacent masked, safe to log at startup. */
export function redactedConfig(config: AppConfig): Record<string, unknown> {
  return {
    ...config,
    database: { ...config.database, password: config.database.password ? "[secret-ref]" : undefined },
    auth: {
      ...config.auth,
      tokens: config.auth.tokens.map((t) => ({ ...t, secret: "[secret-ref]" })),
    },
  };
}
