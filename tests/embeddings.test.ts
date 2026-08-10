/**
 * Embedding client contract, ported from the prior in-process implementation:
 * dimension assert, unit norm, poisoned-vector rejection, transient vs permanent
 * failure classification, surrogate-safe input capping.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingError, createEmbeddingClient, safePrefix } from "../src/embeddings/ollama.js";

const CONFIG = { host: "http://ollama.test", model: "nomic-embed-text", dimensions: 4 };

function mockFetchOnce(response: { status?: number; body?: unknown } | { reject: Error }) {
  const impl =
    "reject" in response
      ? () => Promise.reject(response.reject)
      : () =>
          Promise.resolve(
            new Response(JSON.stringify(response.body ?? {}), {
              status: response.status ?? 200,
              headers: { "content-type": "application/json" },
            }),
          );
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createEmbeddingClient", () => {
  it("returns an L2-normalised vector of the configured dimension", async () => {
    mockFetchOnce({ body: { embedding: [3, 0, 4, 0] } });
    const vector = await createEmbeddingClient(CONFIG).embed("text");
    expect(vector).toHaveLength(4);
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 10);
    expect(vector[0]).toBeCloseTo(0.6, 10);
  });

  it("rejects a wrong-dimension vector as permanent", async () => {
    mockFetchOnce({ body: { embedding: [1, 2, 3] } });
    await expect(createEmbeddingClient(CONFIG).embed("text")).rejects.toMatchObject({
      name: "EmbeddingError",
      transient: false,
    });
  });

  it("rejects a non-finite vector as permanent", async () => {
    mockFetchOnce({ body: { embedding: [1, Number.NaN, 0, 0] } });
    await expect(createEmbeddingClient(CONFIG).embed("text")).rejects.toMatchObject({ transient: false });
  });

  it("rejects a zero-norm vector as permanent", async () => {
    mockFetchOnce({ body: { embedding: [0, 0, 0, 0] } });
    await expect(createEmbeddingClient(CONFIG).embed("text")).rejects.toMatchObject({ transient: false });
  });

  it("rejects a missing embedding array as permanent", async () => {
    mockFetchOnce({ body: { nope: true } });
    await expect(createEmbeddingClient(CONFIG).embed("text")).rejects.toMatchObject({ transient: false });
  });

  it("classifies 5xx as transient and 4xx as permanent", async () => {
    mockFetchOnce({ status: 503 });
    await expect(createEmbeddingClient(CONFIG).embed("text")).rejects.toMatchObject({ transient: true, status: 503 });
    mockFetchOnce({ status: 400 });
    await expect(createEmbeddingClient(CONFIG).embed("text")).rejects.toMatchObject({ transient: false, status: 400 });
  });

  it("classifies network failure as transient", async () => {
    mockFetchOnce({ reject: new Error("ECONNREFUSED") });
    await expect(createEmbeddingClient(CONFIG).embed("text")).rejects.toBeInstanceOf(EmbeddingError);
    mockFetchOnce({ reject: new Error("ECONNREFUSED") });
    await expect(createEmbeddingClient(CONFIG).embed("text")).rejects.toMatchObject({ transient: true });
  });

  it("sends num_ctx only when configured", async () => {
    mockFetchOnce({ body: { embedding: [1, 0, 0, 0] } });
    await createEmbeddingClient({ ...CONFIG, numCtx: 8192 }).embed("text");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(body.options).toEqual({ num_ctx: 8192 });
  });
});

describe("safePrefix", () => {
  it("never splits a surrogate pair", () => {
    const text = "ab\u{1F600}cd"; // the emoji is a surrogate pair at index 2-3
    expect(safePrefix(text, 3)).toBe("ab");
    expect(safePrefix(text, 4)).toBe("ab\u{1F600}");
  });
  it("returns short strings untouched", () => {
    expect(safePrefix("abc", 10)).toBe("abc");
  });
});
