/**
 * The McpServer factory. Called once per serving unit (per HTTP request under
 * createMcpHandler, per connection under stdio) with the caller's resolved
 * identity - the v2 SDK's intended multi-tenant shape: tools close over the
 * identity, so no tool ever takes an agent parameter.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { allTools } from "./tools/index.js";
import type { ToolContext } from "./tools/index.js";
import type { AgentIdentity } from "./auth/identity.js";

/**
 * The name clients see in serverInfo, and the name their tool namespace is
 * built from (`mcp__agent-memory__*`). Changing it breaks every configured
 * client, so it is deliberately not derived from the package name.
 */
export const SERVER_NAME = "agent-memory";

/**
 * Read rather than imported: `rootDir` is ./src, so a static JSON import of a
 * file above it fails to compile. Resolves from src/ under tsx and from dist/
 * when built, both being one directory below the package root - if the build
 * output is ever nested deeper, this is what breaks.
 */
const pkg = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));

export const SERVER_VERSION = pkg.version;

export type ServerDeps = Omit<ToolContext, "identity">;

export function createServer(deps: ServerDeps, identity: AgentIdentity): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const ctx: ToolContext = { ...deps, identity };
  for (const register of allTools) {
    register(server, ctx);
  }
  return server;
}
