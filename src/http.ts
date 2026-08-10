/**
 * The HTTP transport: raw node:http in front of the v2 SDK's createMcpHandler.
 *
 * Era handling is the SDK's: modern (2026-07-28, server/discover + _meta
 * envelopes) requests are served natively, 2025-era requests through the
 * stateless legacy fallback - one factory, both eras. Proven in the Phase 0
 * spike (a pinned @modelcontextprotocol/sdk@1.29.0 client negotiates
 * 2025-11-25 against this handler).
 *
 * Auth happens HERE, before the protocol layer: the SDK's handler is strictly
 * pass-through on authInfo and performs no verification of its own. A request
 * with no usable credential gets the RFC 9728 401 challenge (never a 302).
 *
 * Routes:
 *   POST /mcp                                    - the MCP endpoint (auth)
 *   GET  /health                                 - public liveness
 *   GET  /.well-known/oauth-protected-resource   - public RFC 9728 metadata
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import type { AppConfig } from "./config/index.js";
import type { Authenticator } from "./auth/authenticator.js";
import type { ServerDeps } from "./server.js";
import { createServer } from "./server.js";
import type { Logger } from "./observability/logger.js";
import type { AgentIdentity } from "./auth/identity.js";

export interface HttpDeps {
  config: AppConfig;
  authenticator: Authenticator;
  serverDeps: ServerDeps;
  log: Logger;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function buildHttpServer(deps: HttpDeps) {
  const { authenticator, serverDeps, log } = deps;

  // Identity travels from the auth check to the per-request factory via
  // authInfo.extra - the SDK carries it verbatim into McpRequestContext.
  const handler: McpHttpHandler = createMcpHandler(
    (ctx) => {
      const identity = (ctx.authInfo?.extra?.identity ?? null) as AgentIdentity | null;
      if (!identity) {
        // Unreachable when routing is correct: /mcp always authenticates first.
        throw new Error("MCP factory invoked without an authenticated identity");
      }
      return createServer(serverDeps, identity);
    },
    {
      legacy: "stateless",
      onerror: (error) => log.warn({ err: error.message }, "mcp handler error"),
    },
  );
  const nodeHandler = toNodeHandler(handler);

  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      // The nginx prefix mount strips nothing: accept both bare and /memory-prefixed paths.
      const pathname = url.pathname.replace(/^\/memory(?=\/|$)/, "") || "/";

      if (pathname === "/health") {
        return json(res, 200, { status: "ok" });
      }
      if (pathname === "/.well-known/oauth-protected-resource") {
        return json(res, 200, authenticator.protectedResourceMetadata());
      }
      if (pathname !== "/mcp" && pathname !== "/") {
        return json(res, 404, { error: "not_found" });
      }

      const identity = await authenticator.authenticate(req.headers.authorization);
      if (!identity) {
        return json(
          res,
          401,
          { error: "unauthorized" },
          { "www-authenticate": `Bearer resource_metadata="${authenticator.resourceMetadataUrl()}"` },
        );
      }

      log.debug({ caller: identity.name, path: pathname }, "mcp request");
      // toNodeHandler has no per-request authInfo seam, so bridge by hand:
      // IncomingMessage -> Request, fetch with authInfo, Response -> res.
      // (The cast satisfies exactOptionalPropertyTypes: NodeIncomingMessageLike
      // declares `method: string` where node types it `string | undefined`.)
      const request = await toWebRequest(req as Parameters<typeof toWebRequest>[0]);
      const response = await handler.fetch(request, {
        authInfo: {
          token: "resolved",
          clientId: identity.name,
          scopes: identity.scopes,
          extra: { identity },
        },
      });
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        for await (const chunk of response.body) {
          res.write(chunk);
        }
      }
      res.end();
    })().catch((error: unknown) => {
      log.error({ err: error instanceof Error ? error.message : String(error) }, "http request failed");
      if (!res.headersSent) {
        json(res, 500, { error: "internal_error" });
      } else {
        res.end();
      }
    });
  });
  // nodeHandler is kept referenced for the simple no-auth path should it be
  // needed; the hand-bridge above is the authenticated path.
  void nodeHandler;
}
