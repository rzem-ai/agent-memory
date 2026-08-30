import { AnyOutput, MEMORY_TOOL_SCHEMAS, requireScope, textResult, traced, type RegisterFn } from "./shared.js";

export const register: RegisterFn = (server, ctx) => {
  server.registerTool(
    "memory_forget",
    {
      description: `Soft-delete a thought by ID so it no longer appears in search results. Use this to retire stale or incorrect memories. Scoped to the caller's namespaces: a thought belonging to another agent is reported as not found.

Preconditions:
- 'thought_id' must be a valid UUID (as shown in memory_search results under the 'id' field).

Returns: text 'Forgot thought <uuid>' on success, or 'Thought <uuid> not found or already deleted' if it did not exist, was already soft-deleted, or belongs to a namespace this credential cannot touch.`,
      inputSchema: MEMORY_TOOL_SCHEMAS.memory_forget,
      outputSchema: AnyOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    traced(ctx, "memory_forget", async (args) => {
      const denied = requireScope(ctx, "memory_forget");
      if (denied) return denied;
      const forgotten = await ctx.thoughts.forget(args.thought_id, ctx.identity.agents);
      return textResult(
        forgotten ? `Forgot thought ${args.thought_id}` : `Thought ${args.thought_id} not found or already deleted`,
        { thought_id: args.thought_id, forgotten },
      );
    }),
  );
};
