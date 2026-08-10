import { primaryAgent } from "../auth/identity.js";
import { AnyOutput, MEMORY_TOOL_SCHEMAS, errorResult, requireScope, textResult, type RegisterFn } from "./shared.js";

export const register: RegisterFn = (server, ctx) => {
  server.registerTool(
    "memory_capture",
    {
      description: `Store a thought/memory in the shared memory store. The row is namespaced to the caller's credential; there is no agent parameter.

Preconditions:
- 'content' must be a non-empty string (whitespace-only is rejected).
- 'tags' is an array of strings (may be empty []).

Dedup and supersession (cosine similarity over 768-dim embeddings, scoped to the caller's namespace):
- Near-duplicate within 48h (cosine >= 0.85) -> skip entirely; no row written.
- Older near-match outside 48h (cosine >= 0.80) -> soft-delete up to 3 stale rows, then insert the new one.

Returns text:
- 'Memory captured successfully (id: <uuid>)' on insert.
- 'Memory captured successfully (id: <uuid>, superseded N stale thoughts)' when older near-matches were retired.
- 'Memory skipped - near-duplicate of an existing thought (id: <uuid>, cosine >= 0.85 within 48h).' when deduped; the id is the existing near-match (pass it to memory_forget to remove that one).`,
      inputSchema: MEMORY_TOOL_SCHEMAS.memory_capture,
      outputSchema: AnyOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const denied = requireScope(ctx, "memory_capture");
      if (denied) return denied;
      if (!args.content.trim()) {
        return errorResult("Error: 'content' must be a non-empty string.");
      }
      const agentId = primaryAgent(ctx.identity);
      if (!agentId) {
        return errorResult("This credential has no concrete namespace to capture into (wildcard-only identity).");
      }
      try {
        const r = await ctx.thoughts.capture(args.content, agentId, args.tags);
        if (r.skipped) {
          return textResult(
            `Memory skipped - near-duplicate of an existing thought (id: ${r.duplicate_of}, cosine >= 0.85 within 48h).`,
            { id: null, skipped: true, duplicate_of: r.duplicate_of },
          );
        }
        const text =
          r.superseded > 0
            ? `Memory captured successfully (id: ${r.id}, superseded ${r.superseded} stale thoughts)`
            : `Memory captured successfully (id: ${r.id})`;
        return textResult(text, { id: r.id, skipped: false, superseded: r.superseded });
      } catch (err) {
        return errorResult(`Capture failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
};
