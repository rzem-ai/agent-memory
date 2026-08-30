import { primaryAgent } from "../auth/identity.js";
import { AnyOutput, MEMORY_TOOL_SCHEMAS, errorResult, requireScope, textResult, traced, type RegisterFn } from "./shared.js";

export const register: RegisterFn = (server, ctx) => {
  server.registerTool(
    "memory_kv_set",
    {
      description: `Set a value in the persistent key-value store (versioned upsert). The namespace is the caller's credential; there is no agent parameter.

Preconditions:
- 'key' is a required, non-empty string.
- 'value' must be JSON-serialisable (any JSON type including null, object, array, string, number, boolean). Setting null stores null - it does not delete the key.

Returns: text 'Set '<key>''.`,
      inputSchema: MEMORY_TOOL_SCHEMAS.memory_kv_set,
      outputSchema: AnyOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    traced(ctx, "memory_kv_set", async (args) => {
      const denied = requireScope(ctx, "memory_kv_set");
      if (denied) return denied;
      const agentId = primaryAgent(ctx.identity);
      if (!agentId) {
        return errorResult("This credential has no concrete namespace for KV access (wildcard-only identity).");
      }
      await ctx.kv.set(agentId, args.key, args.value ?? null);
      return textResult(`Set '${args.key}'`, { key: args.key, set: true });
    }),
  );
};
