/**
 * The shared Ollama embedding client core, ported from the prior in-process
 * implementation with the proxy transport branch dropped (this server always dials Ollama
 * directly). Both vector spaces run through this one implementation with
 * different parameters; the dimension assert and L2-normalise are load-bearing -
 * a wrong-space vector silently returns zero rows from cosine search, so it must
 * die here instead.
 */

export interface EmbeddingClient {
  /** Text in, unit vector out. Throws `EmbeddingError` on failure. */
  embed(text: string): Promise<number[]>;
}

export interface EmbeddingClientConfig {
  host: string;
  model: string;
  dimensions: number;
  /** Cap on input characters (surrogate-safe); omit for no cap. */
  maxInputChars?: number;
  /** Ollama num_ctx override (bge-m3 needs 8192 to avoid a spurious 500). */
  numCtx?: number;
}

const EMBED_TIMEOUT_MS = 30_000;

/** Neutral embedding-layer error. `transient` marks a retryable backend fault (429/5xx/network). */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly transient: boolean = true,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** L2-normalise; throws on a non-finite or zero-norm vector. Cosine queries assume unit vectors. */
function normalise(vector: number[], model: string): number[] {
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new EmbeddingError(`${model} embedding contains a non-finite value`, false);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingError(`${model} embedding has zero norm`, false);
  }
  return vector.map((value) => value / norm);
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** A prefix that never splits a surrogate pair (ported from ingest/text.ts safePrefix). */
export function safePrefix(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function createEmbeddingClient(config: EmbeddingClientConfig): EmbeddingClient {
  const host = config.host.replace(/\/$/, "");
  return {
    async embed(text: string): Promise<number[]> {
      const prompt = config.maxInputChars ? safePrefix(text, config.maxInputChars) : text;
      let response: Response;
      try {
        response = await fetch(`${host}/api/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: config.model,
            prompt,
            ...(config.numCtx ? { options: { num_ctx: config.numCtx } } : {}),
          }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
      } catch (error) {
        throw new EmbeddingError(
          `Ollama embeddings request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) {
        throw new EmbeddingError(
          `Ollama embeddings returned HTTP ${response.status}`,
          isTransientStatus(response.status),
          response.status,
        );
      }
      const data = (await response.json().catch(() => null)) as { embedding?: number[] } | null;
      const vector = data?.embedding;
      if (!Array.isArray(vector)) {
        throw new EmbeddingError("Ollama embeddings response had no embedding array", false);
      }
      if (vector.length !== config.dimensions) {
        throw new EmbeddingError(
          `embedding dimension mismatch: expected ${config.dimensions}, received ${vector.length}`,
          false,
        );
      }
      return normalise(vector, config.model);
    },
  };
}
