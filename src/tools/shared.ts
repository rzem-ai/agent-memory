/**
 * Shared tool plumbing: the ToolContext every tool receives, the RegisterFn
 * shape each tool file exports, the result helpers, and the schema registry.
 *
 * MEMORY_TOOL_SCHEMAS is the single source the server build and the
 * surface-parity test both read - the structure that stops the tool surface
 * drifting.
 *
 * No agent_id anywhere: the credential carries the namespace (ctx.identity).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AgentIdentity } from "../auth/identity.js";
import { TOOL_SCOPES } from "../auth/scopes.js";
import { hasScope } from "../auth/identity.js";
import type { ThoughtsRepository, MemorySearchConfig } from "../repositories/thoughts.js";
import type { KvRepository } from "../repositories/kv.js";
import type { VaultRecall } from "../services/recall.js";
import type { Logger } from "../observability/logger.js";
import type { Mesh } from "../observability/mesh.js";
import { DOCUMENT_BODY_MAX_CHARS } from "../domain/recall.js";

export const MODES = ["recency_weighted", "similarity", "recent", "since"] as const;
export const CORPORA = ["thoughts", "documents", "all"] as const;
export const TREE_OPS = ["list", "read", "search"] as const;

/** The nine tools' input schemas, keyed by tool name. The model-facing shape
 *  contract; descriptions live with the handlers (memory_search interpolates
 *  config). */
export const MEMORY_TOOL_SCHEMAS = {
  memory_search: z.object({
    query: z.string().min(1).describe("Natural language search query (required, non-empty)"),
    corpus: z
      .enum(CORPORA)
      .optional()
      .describe("Which corpus to search: 'thoughts' (conversational store), 'documents' (synced vault) or 'all' (both, merged). Default: 'all'."),
    limit: z.number().int().positive().optional().describe("Max results to return. Default: 5."),
    relevance_mode: z.enum(MODES).optional().describe("Ranking strategy for corpus 'thoughts' only. Defaults to server config."),
    relevance_value: z.number().positive().optional().describe("Override value - meaning depends on relevance_mode (corpus 'thoughts' only)."),
  }),
  memory_capture: z.object({
    content: z.string().min(1).describe("The thought or memory content to store (required, non-empty)"),
    tags: z.array(z.string()).describe("Tags for categorising this memory (required; pass [] for none)"),
  }),
  memory_forget: z.object({
    thought_id: z.string().uuid().describe("UUID of the thought to forget (shown as 'id' in memory_search results)"),
  }),
  memory_read_document: z.object({
    document_id: z.string().min(1).describe("The document id (shown as 'doc' in memory_search results under the [documents] label)"),
    max_chars: z
      .number()
      .int()
      .positive()
      .max(DOCUMENT_BODY_MAX_CHARS)
      .optional()
      .describe(`Cap the returned body length. Default and hard maximum: ${DOCUMENT_BODY_MAX_CHARS}. A longer body is truncated with a note.`),
  }),
  memory_tree: z.object({
    op: z
      .enum(TREE_OPS)
      .describe("'list' (children of a path, or the roots when omitted), 'read' (a node's summary + metadata), 'search' (semantic over summaries)"),
    path: z.string().optional().describe("Tree node path, e.g. 'mail/2026/07'. Required for op 'read'; for op 'list' omit to list the roots."),
    query: z.string().optional().describe("Natural-language query. Required for op 'search'; ignored otherwise."),
    limit: z.number().int().positive().optional().describe("Max results for op 'search'. Default: 7."),
  }),
  memory_kv_get: z.object({
    key: z.string().min(1).describe("Key to retrieve (required, non-empty)"),
  }),
  memory_kv_set: z.object({
    key: z.string().min(1).describe("Key to set (required, non-empty)"),
    value: z.unknown().describe("Value to store (any JSON-serialisable type; null is allowed)"),
  }),
  memory_kv_delete: z.object({
    key: z.string().min(1).describe("Key to delete (required, non-empty)"),
  }),
  memory_kv_list: z.object({}),
} as const;

export type MemoryToolName = keyof typeof MEMORY_TOOL_SCHEMAS;
export const MEMORY_TOOL_NAMES = Object.keys(MEMORY_TOOL_SCHEMAS) as MemoryToolName[];

/** Loose structured-output shape: every tool returns
 *  structuredContent alongside its frozen text rendering. */
export const AnyOutput = z.record(z.string(), z.unknown());

export interface ToolContext {
  identity: AgentIdentity;
  thoughts: ThoughtsRepository;
  kv: KvRepository;
  vault: VaultRecall;
  search: MemorySearchConfig;
  log: Logger;
  /** Mesh telemetry. Absent (tests, standalone runs) means no events leave the process. */
  mesh?: Mesh;
}

export type RegisterFn = (server: McpServer, ctx: ToolContext) => void;

interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text }], structuredContent: structured ?? { text } };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }], structuredContent: { error: text }, isError: true };
}

/** The per-call scope gate. Returns null when authorised, an error result when
 *  not - enforced here, in code, not in an unread config field. */
export function requireScope(ctx: ToolContext, toolName: MemoryToolName): ToolResult | null {
  const scope = TOOL_SCOPES[toolName];
  if (!scope) {
    return errorResult(`No scope mapping for tool '${toolName}' - server bug.`);
  }
  if (!hasScope(ctx.identity, scope)) {
    return errorResult(`Insufficient scope: '${toolName}' requires '${scope}' (caller '${ctx.identity.name}' has: ${ctx.identity.scopes.join(", ") || "none"}).`);
  }
  return null;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * One line describing a call's arguments for the observatory's tool card:
 * `query="retry backoff" corpus=all`. Strings are quoted and clipped, arrays
 * and objects summarised by size - a memory capture's body never leaves the
 * process through telemetry.
 */
export function summariseArgs(args: unknown, max = 120): string {
  if (!args || typeof args !== "object") return "";
  const parts = Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    if (typeof value === "string") return `${key}=${JSON.stringify(clip(value, 40))}`;
    if (Array.isArray(value)) return `${key}=[${value.length}]`;
    if (value && typeof value === "object") return `${key}={…}`;
    return `${key}=${String(value)}`;
  });
  return clip(parts.join(" "), max);
}

/**
 * Wraps a tool handler so the mesh sees `tool.called` and `tool.result`
 * around it - from this server's point of view: duration, size, and whether
 * it was an error, including the scope refusals `requireScope` produces. A
 * handler that throws is reported as a failed result and still throws.
 */
export function traced<A>(
  ctx: ToolContext,
  name: MemoryToolName,
  fn: (args: A) => Promise<ToolResult>,
): (args: A) => Promise<ToolResult> {
  const mesh = ctx.mesh;
  if (!mesh) return fn;
  return async (args) => {
    mesh.emit({ correlationId: "", taskId: "", type: "tool.called", payload: { name, inputSummary: summariseArgs(args) } });
    const started = performance.now();
    try {
      const result = await fn(args);
      const text = result.content.map((c) => c.text).join("\n");
      mesh.emit({
        correlationId: "",
        taskId: "",
        type: "tool.result",
        payload: {
          name,
          ok: result.isError !== true,
          durationMs: Math.round(performance.now() - started),
          bytes: Buffer.byteLength(text),
          preview: clip(text.split("\n")[0] ?? "", 140),
        },
      });
      return result;
    } catch (error) {
      mesh.emit({
        correlationId: "",
        taskId: "",
        type: "tool.result",
        payload: {
          name,
          ok: false,
          durationMs: Math.round(performance.now() - started),
          bytes: 0,
          preview: clip(error instanceof Error ? error.message : String(error), 140),
        },
      });
      throw error;
    }
  };
}
