/**
 * The stdio entrypoint. No auth: the OS process boundary is the auth, matching
 * the MCP authorization spec's guidance for stdio servers. The identity comes
 * from config ([stdio].agent_id) with full scopes - required here, and absent
 * from HTTP-only configs, so it is checked rather than defaulted.
 *
 * serveStdio owns the era decision per connection: a 2025-era `initialize`
 * opening pins a legacy instance, a modern opening serves 2026-07-28+.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./observability/logger.js";
import { buildDeps } from "./wiring.js";
import { createServer } from "./server.js";
import { SCOPES } from "./auth/scopes.js";
import type { Scope } from "./config/index.js";

const config = loadConfig();
const log = createLogger(config.log_level);
const wired = buildDeps(config, log);

if (!config.stdio) {
  log.error("[stdio].agent_id is required by the stdio transport - add a [stdio] block to the config");
  process.exit(1);
}

const agentId = config.stdio.agent_id;

const identity = {
  name: `stdio:${agentId}`,
  agents: [agentId],
  scopes: [...SCOPES] as Scope[],
};

serveStdio(() => createServer(wired.serverDeps, identity), {
  legacy: "serve",
  onerror: (error) => log.warn({ err: error.message }, "stdio serving error"),
});

log.info({ agent: agentId }, "rzem-memory stdio server ready");

process.on("SIGINT", () => {
  void wired.close().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void wired.close().finally(() => process.exit(0));
});
