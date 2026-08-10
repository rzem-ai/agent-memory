import { primaryAgent } from "../auth/identity.js";
import { AnyOutput, MEMORY_TOOL_SCHEMAS, errorResult, requireScope, textResult, type RegisterFn } from "./shared.js";

export const register: RegisterFn = (server, ctx) => {
  server.registerTool(
    "memory_kv_list",
    {
      description: `List all key-value pairs in the caller's namespace. Takes no parameters.

Returns: text with one line per entry formatted as '<key>: <json-value>'. If the namespace is empty, returns 'No KV entries'.`,
      inputSchema: MEMORY_TOOL_SCHEMAS.memory_kv_list,
      outputSchema: AnyOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const denied = requireScope(ctx, "memory_kv_list");
      if (denied) return denied;
      const agentId = primaryAgent(ctx.identity);
      if (!agentId) {
        return errorResult("This credential has no concrete namespace for KV access (wildcard-only identity).");
      }
      const entries = await ctx.kv.list(agentId);
      const keys = Object.keys(entries);
      if (keys.length === 0) {
        return textResult("No KV entries", { count: 0, entries: {} });
      }
      return textResult(keys.map((k) => `${k}: ${JSON.stringify(entries[k])}`).join("\n"), { count: keys.length, entries });
    },
  );
};
