import { primaryAgent } from "../auth/identity.js";
import { AnyOutput, MEMORY_TOOL_SCHEMAS, errorResult, requireScope, textResult, type RegisterFn } from "./shared.js";

export const register: RegisterFn = (server, ctx) => {
  server.registerTool(
    "memory_kv_get",
    {
      description: `Get a value from the persistent key-value store. The namespace is the caller's credential; there is no agent parameter.

Preconditions:
- 'key' is a required, non-empty string. The key need not exist; a miss is not an error.

Returns: pretty-printed JSON of the stored value as text. If the key is absent, returns 'No value found for key '<key>''.`,
      inputSchema: MEMORY_TOOL_SCHEMAS.memory_kv_get,
      outputSchema: AnyOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const denied = requireScope(ctx, "memory_kv_get");
      if (denied) return denied;
      const agentId = primaryAgent(ctx.identity);
      if (!agentId) {
        return errorResult("This credential has no concrete namespace for KV access (wildcard-only identity).");
      }
      const value = await ctx.kv.get(agentId, args.key);
      return value === null
        ? textResult(`No value found for key '${args.key}'`, { key: args.key, found: false })
        : textResult(JSON.stringify(value, null, 2), { key: args.key, found: true, value });
    },
  );
};
