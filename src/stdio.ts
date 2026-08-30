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

let stopping = false;
function shutdown(reason: string): void {
  if (stopping) return;
  stopping = true;
  log.info({ reason }, "shutting down");
  void wired.close().finally(() => process.exit(0));
}

// An MCP host stops a stdio child by closing the pipe, not by signalling it,
// so EOF on stdin is the normal way this process ends. Registered before
// serveStdio takes stdin, so the goodbye goes out ahead of whatever the SDK
// does on close.
process.stdin.once("end", () => shutdown("stdin closed"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

serveStdio(() => createServer(wired.serverDeps, identity), {
  legacy: "serve",
  onerror: (error) => log.warn({ err: error.message }, "stdio serving error"),
});

log.info({ agent: agentId }, "agent-memory stdio server ready");
wired.mesh.announce({ kind: "mcp-stdio" });
