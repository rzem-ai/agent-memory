/**
 * The two embedding spaces, never mixed:
 * - thoughts: 768-d nomic against memory_thoughts/memory_patterns.
 * - documents: 1024-d bge-m3 against memory_chunks/memory_tree_nodes.
 * The merge compares composite RANK, never cross-space cosine.
 */

import type { AppConfig } from "../config/index.js";
import { createEmbeddingClient, type EmbeddingClient } from "./ollama.js";

export { createEmbeddingClient, EmbeddingError, safePrefix } from "./ollama.js";
export type { EmbeddingClient, EmbeddingClientConfig } from "./ollama.js";

export const NOMIC_DIMENSIONS = 768;
export const BGE_M3_DIMENSIONS = 1024;

// bge-m3's native context window; Ollama's default physical batch (2048 tokens)
// commonly overflows within the input cap, causing a spurious HTTP 500.
const BGE_M3_CONTEXT_TOKENS = 8_192;
const EMBED_MAX_INPUT_CHARS = 8_000;

export interface EmbeddingClients {
  thoughts: EmbeddingClient;
  documents: EmbeddingClient;
}

export function createEmbeddings(config: AppConfig["embeddings"]): EmbeddingClients {
  return {
    thoughts: createEmbeddingClient({
      host: config.thoughts.host,
      model: config.thoughts.model,
      dimensions: config.thoughts.dimensions,
    }),
    documents: createEmbeddingClient({
      host: config.documents.host,
      model: config.documents.model,
      dimensions: config.documents.dimensions,
      maxInputChars: EMBED_MAX_INPUT_CHARS,
      numCtx: BGE_M3_CONTEXT_TOKENS,
    }),
  };
}
