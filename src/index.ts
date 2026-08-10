/**
 * The HTTP entrypoint (the default; `npm run start:stdio` runs dist/stdio.js
 * for the stdio transport).
 */

import { loadConfig, redactedConfig } from "./config/index.js";
import { createLogger } from "./observability/logger.js";
import { Authenticator } from "./auth/authenticator.js";
import { buildDeps } from "./wiring.js";
import { buildHttpServer } from "./http.js";

const config = loadConfig();
const log = createLogger(config.log_level);
log.info({ config: redactedConfig(config) }, "starting rzem-memory http server");

if (!config.auth.enabled) {
  log.warn("AUTH IS DISABLED - every request is anonymous with full scopes. Development only.");
}

const authenticator = new Authenticator(config.auth);
const wired = buildDeps(config, log);
const server = buildHttpServer({ config, authenticator, serverDeps: wired.serverDeps, log });

server.listen(config.http.port, config.http.host, () => {
  log.info({ host: config.http.host, port: config.http.port }, "rzem-memory http server listening");
});

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  server.close();
  await wired.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
