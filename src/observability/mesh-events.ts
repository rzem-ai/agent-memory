/**
 * The mesh telemetry contract, as the observatory in the agents repo defines
 * it (`observatory/src/events.ts`, mirrored in the runtime as
 * `runtime/src/host/mesh-events.ts`). Copied, not imported: the mesh has no
 * shared package by design. Types only - keep the three in step.
 */

export type MeshEventType =
  | "request.received"
  | "turn.started"
  | "turn.completed"
  | "tool.called"
  | "tool.result"
  | "delegation.sent"
  | "delegation.received"
  | "status"
  | "context.snapshot"
  | "error"
  /** Lifecycle: on boot and every heartbeat. */
  | "agent.hello"
  /** Lifecycle: during shutdown. */
  | "agent.bye";

/** One way a process can be reached. Only `a2a` and `mcp-http` carry a `url`. */
export interface SurfaceInfo {
  kind: "a2a" | "mcp-http" | "mcp-stdio" | "repl" | "once";
  url?: string;
  /** MCP surfaces: the tool a client calls to ask this agent. Tool servers leave it out. */
  toolName?: string;
}

/** `agent.hello` payload - what the observatory needs to draw the node and dial it. */
export interface HelloPayload {
  name: string;
  role?: string;
  model?: string;
  profile?: string;
  pid: number;
  /** ISO 8601, fixed for the life of the process. */
  startedAt: string;
  surfaces: SurfaceInfo[];
  peers: { name: string; url: string }[];
}

export interface MeshEvent {
  id: string;
  ts: string;
  agent: string;
  /** Ties one request across the mesh. Empty when the emitter cannot know it. */
  correlationId: string;
  taskId: string;
  type: MeshEventType;
  payload: Record<string, unknown>;
}

/** What an emitter supplies; `id` and `ts` are stamped on the way out. */
export type MeshEventInput = Omit<MeshEvent, "id" | "ts">;
