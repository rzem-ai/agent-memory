/**
 * The scope model and the per-tool requirement map. Unlike a scope list
 * declared in config and never read, this map is
 * enforced on every tools/call by the tool layer itself.
 */

import type { Scope } from "../config/index.js";

export const SCOPES: readonly Scope[] = ["memory:read", "memory:write", "memory:admin"];

/** Which scope each tool requires. The registry test asserts full coverage. */
export const TOOL_SCOPES: Record<string, Scope> = {
  memory_search: "memory:read",
  memory_read_document: "memory:read",
  memory_tree: "memory:read",
  memory_kv_get: "memory:read",
  memory_kv_list: "memory:read",
  memory_capture: "memory:write",
  memory_kv_set: "memory:write",
  memory_forget: "memory:admin",
  memory_kv_delete: "memory:admin",
};
