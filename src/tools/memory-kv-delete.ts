import { primaryAgent } from "../auth/identity.js";
import { AnyOutput, MEMORY_TOOL_SCHEMAS, errorResult, requireScope, textResult, type RegisterFn } from "./shared.js";

export const register: RegisterFn = (server, ctx) => {
  server.registerTool(
    "memory_kv_delete",
    {
      description: `Delete a key from the persistent key-value store. The namespace is the caller's credential; there is no agent parameter.

Preconditions:
- 'key' is a required, non-empty string. The key need not exist; a miss is not an error.

Returns: text 'Deleted '<key>'' on success, or 'Key '<key>' not found' if the key did not exist.`,
      inputSchema: MEMORY_TOOL_SCHEMAS.memory_kv_delete,
      outputSchema: AnyOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const denied = requireScope(ctx, "memory_kv_delete");
      if (denied) return denied;
      const agentId = primaryAgent(ctx.identity);
      if (!agentId) {
        return errorResult("This credential has no concrete namespace for KV access (wildcard-only identity).");
      }
      const deleted = await ctx.kv.delete(agentId, args.key);
      return textResult(deleted ? `Deleted '${args.key}'` : `Key '${args.key}' not found`, { key: args.key, deleted });
    },
  );
};
