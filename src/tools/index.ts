import type { RegisterFn } from "./shared.js";
import { register as memorySearch } from "./memory-search.js";
import { register as memoryCapture } from "./memory-capture.js";
import { register as memoryForget } from "./memory-forget.js";
import { register as memoryReadDocument } from "./memory-read-document.js";
import { register as memoryTree } from "./memory-tree.js";
import { register as memoryKvGet } from "./memory-kv-get.js";
import { register as memoryKvSet } from "./memory-kv-set.js";
import { register as memoryKvDelete } from "./memory-kv-delete.js";
import { register as memoryKvList } from "./memory-kv-list.js";

/** Registration order = tools/list order (deterministic under 2026-07-28). */
export const allTools: RegisterFn[] = [
  memorySearch,
  memoryCapture,
  memoryForget,
  memoryReadDocument,
  memoryTree,
  memoryKvGet,
  memoryKvSet,
  memoryKvDelete,
  memoryKvList,
];

export { MEMORY_TOOL_SCHEMAS, MEMORY_TOOL_NAMES, textResult, errorResult, requireScope } from "./shared.js";
export type { ToolContext, RegisterFn, MemoryToolName } from "./shared.js";
