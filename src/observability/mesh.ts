/**
 * Fire-and-forget telemetry to the mesh observatory, so this server appears
 * on its canvas as a node - present, stale or gone - with its own tool
 * activity. A port of the agents runtime's `host/mesh.ts`.
 *
 * Two rules this must never break:
 *   1. With no config it is a no-op, so the server runs standalone.
 *   2. It is never awaited and never throws, so a slow or dead hub cannot
 *      degrade a memory call. Observability that can break the thing it
 *      observes is worse than none.
 *
 * What this server cannot supply is a correlation id: the MCP calls come
 * from a Claude subprocess that does not forward one, so every event here
 * carries an empty `correlationId`. The observatory shows such events on the
 * node itself rather than inside a request's transcript.
 */

import { randomUUID } from "node:crypto";
import type { HelloPayload, MeshEvent, MeshEventInput, SurfaceInfo } from "./mesh-events.js";
import type { Logger } from "./logger.js";

export interface Mesh {
  emit(event: Omit<MeshEventInput, "agent">): void;
  /**
   * Tells the hub this process exists and how it is reached. Emits
   * `agent.hello` now and every `heartbeatMs` after, until `farewell`. A
   * second call adds a surface to the same hello; it does not start a second
   * timer.
   */
  announce(surface: SurfaceInfo): void;
  /** Emits `agent.bye` and stops the heartbeat. Idempotent. */
  farewell(): void;
}

export interface MeshConfig {
  url: string;
  /** The name the observatory files this process under - match the caller's mcpServers key so the edge draws. */
  name: string;
  role?: string;
  /** Sent as `Authorization: Bearer ...` on every post. */
  token?: string;
}

/** Everything in a hello that is fixed for the life of the process. */
export interface MeshIdentity {
  pid: number;
  startedAt: string;
  peers: { name: string; url: string }[];
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface MeshOptions {
  fetchImpl?: FetchLike;
  heartbeatMs?: number;
  log?: Logger;
}

export const HEARTBEAT_MS = 15_000;

/** Shared, frozen: the no-op every unconfigured server gets. */
export const inertMesh: Mesh = Object.freeze({
  emit: () => undefined,
  announce: () => undefined,
  farewell: () => undefined,
});

export function createMesh(cfg: MeshConfig | undefined, identity: MeshIdentity, opts: MeshOptions = {}): Mesh {
  if (!cfg) return inertMesh;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const endpoint = `${cfg.url.replace(/\/+$/, "")}/events`;
  const agent = cfg.name;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;

  const post = (event: Omit<MeshEventInput, "agent">): void => {
    const full: MeshEvent = { ...event, agent, id: randomUUID(), ts: new Date().toISOString() };
    // try/catch as well as .catch: a fetch implementation is free to throw
    // synchronously, and that would escape a bare `void fetch(...).catch()`.
    try {
      void fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(full),
        signal: AbortSignal.timeout(2000),
      }).catch((error: unknown) => {
        opts.log?.debug({ err: error instanceof Error ? error.message : String(error) }, "mesh post failed");
      });
    } catch {
      /* telemetry must never surface an error into a memory call */
    }
  };

  const surfaces: SurfaceInfo[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let gone = false;

  const hello = (): void => {
    const payload: HelloPayload = {
      name: agent,
      ...(cfg.role ? { role: cfg.role } : {}),
      pid: identity.pid,
      startedAt: identity.startedAt,
      peers: identity.peers,
      surfaces: [...surfaces],
    };
    post({ correlationId: "", taskId: "", type: "agent.hello", payload: payload as unknown as Record<string, unknown> });
  };

  return {
    emit: post,
    announce(surface) {
      if (gone) return;
      surfaces.push(surface);
      hello();
      if (!timer) {
        timer = setInterval(hello, heartbeatMs);
        // The heartbeat must never be the reason the process stays alive.
        timer.unref();
      }
    },
    farewell() {
      if (gone) return;
      gone = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      post({ correlationId: "", taskId: "", type: "agent.bye", payload: { name: agent, reason: "shutdown" } });
    },
  };
}
