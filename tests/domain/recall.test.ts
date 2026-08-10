/**
 * The pure recall domain, ported from the prior in-process implementation:
 * decay, quality term, composite rank, merge ordering, per-document dedup,
 * formatting, and the merged-recall degradation branches.
 */

import { describe, expect, it } from "vitest";
import {
  FRESHNESS_HALF_LIFE_DAYS,
  compositeRank,
  documentQualityTerm,
  formatMergedResults,
  freshnessDecay,
  mergeCorpora,
  recallCandidatePool,
} from "../../src/domain/recall.js";
import { runMergedRecall } from "../../src/services/recall.js";
import type { DocumentChunkHit } from "../../src/repositories/vault.js";
import type { RankedResult } from "../../src/repositories/thoughts.js";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-08-01T00:00:00Z");

const thought = (over: Partial<RankedResult> = {}): RankedResult => ({
  id: "t-1",
  agent_id: "default",
  content: "a thought",
  tags: [],
  similarity: 0.9,
  score: null,
  created_at: new Date(NOW - DAY_MS).toISOString(),
  ...over,
});

const hit = (over: Partial<DocumentChunkHit> = {}): DocumentChunkHit => ({
  documentId: "d-1",
  seq: 0,
  text: "chunk text",
  similarity: 0.9,
  score: 1,
  taint: "external",
  eventAt: new Date(NOW - DAY_MS).toISOString(),
  title: "Doc",
  sourceKind: "mail",
  provenance: {},
  vaultPath: "sources/mail/2026/07/doc.md",
  externalId: "x-1",
  sourceId: "s-1",
  ...over,
});

describe("freshnessDecay", () => {
  it("is 1.0 at age zero and for future timestamps", () => {
    expect(freshnessDecay(0)).toBe(1);
    expect(freshnessDecay(-5000)).toBe(1);
  });
  it("halves at the half-life", () => {
    expect(freshnessDecay(FRESHNESS_HALF_LIFE_DAYS * DAY_MS)).toBeCloseTo(0.5, 10);
    expect(freshnessDecay(2 * FRESHNESS_HALF_LIFE_DAYS * DAY_MS)).toBeCloseTo(0.25, 10);
  });
  it("treats a non-finite age as fully decayed", () => {
    expect(freshnessDecay(Number.NaN)).toBe(0);
    expect(freshnessDecay(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("documentQualityTerm", () => {
  it("maps score 1 -> 1.0, score 0 -> 0.5, missing -> 1.0", () => {
    expect(documentQualityTerm(1)).toBe(1);
    expect(documentQualityTerm(0)).toBe(0.5);
    expect(documentQualityTerm(null)).toBe(1);
    expect(documentQualityTerm(undefined)).toBe(1);
  });
  it("clamps out-of-range scores", () => {
    expect(documentQualityTerm(2)).toBe(1);
    expect(documentQualityTerm(-1)).toBe(0.5);
  });
});

describe("compositeRank", () => {
  it("multiplies similarity, freshness and quality", () => {
    const rank = compositeRank({ similarity: 0.8, ageMs: FRESHNESS_HALF_LIFE_DAYS * DAY_MS, qualityTerm: 0.75 });
    expect(rank).toBeCloseTo(0.8 * 0.5 * 0.75, 10);
  });
});

describe("recallCandidatePool", () => {
  it("multiplies by 4 with a floor of 20", () => {
    expect(recallCandidatePool(5)).toBe(20);
    expect(recallCandidatePool(3)).toBe(20);
    expect(recallCandidatePool(10)).toBe(40);
  });
});

describe("mergeCorpora", () => {
  it("labels thoughts internal and documents with their stored taint", () => {
    const merged = mergeCorpora({ thoughts: [thought()], documents: [hit()], now: NOW, limit: 10 });
    const corpora = merged.map((m) => m.corpus).sort();
    expect(corpora).toEqual(["documents", "thoughts"]);
    expect(merged.find((m) => m.corpus === "thoughts")?.taint).toBe("internal");
    expect(merged.find((m) => m.corpus === "documents")?.taint).toBe("external");
  });

  it("dedups documents to the single best-ranked chunk per document", () => {
    const merged = mergeCorpora({
      thoughts: [],
      documents: [hit({ seq: 0, similarity: 0.7, text: "weak" }), hit({ seq: 1, similarity: 0.95, text: "strong" })],
      now: NOW,
      limit: 10,
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.corpus).toBe("documents");
    expect((merged[0] as { excerpt: string }).excerpt).toBe("strong");
  });

  it("sorts by rank descending and cuts to limit", () => {
    const fresh = thought({ id: "fresh", created_at: new Date(NOW).toISOString(), similarity: 0.8 });
    const stale = thought({ id: "stale", created_at: new Date(NOW - 90 * DAY_MS).toISOString(), similarity: 0.9 });
    const merged = mergeCorpora({ thoughts: [stale, fresh], documents: [], now: NOW, limit: 1 });
    expect(merged).toHaveLength(1);
    expect((merged[0] as { id: string }).id).toBe("fresh");
  });

  it("a document's admission score shades its rank", () => {
    const strong = hit({ documentId: "strong", score: 1 });
    const weak = hit({ documentId: "weak", score: 0 });
    const merged = mergeCorpora({ thoughts: [], documents: [weak, strong], now: NOW, limit: 10 });
    expect((merged[0] as { documentId: string }).documentId).toBe("strong");
  });
});

describe("formatMergedResults", () => {
  it("returns the no-hits sentinel", () => {
    expect(formatMergedResults("all", [])).toBe("No matching memories found.");
  });

  it("renders the frozen labelled-line contract", () => {
    const merged = mergeCorpora({ thoughts: [thought({ tags: ["a", "b"] })], documents: [hit()], now: NOW, limit: 10 });
    const text = formatMergedResults("all", merged);
    expect(text).toContain("corpus: all (thoughts + documents)");
    expect(text).toMatch(/\[1\] corpus: /);
    expect(text).toContain("| taint: internal |");
    expect(text).toContain("| taint: external |");
    expect(text).toContain("| agent: default | id: t-1");
    expect(text).toContain("| doc: d-1 | path: sources/mail/2026/07/doc.md");
    expect(text).toContain("tags: a, b");
  });
});

describe("runMergedRecall degradation", () => {
  const thoughtsOk = { searchRanked: async () => [thought()] };
  const vaultDown = { searchDocuments: async () => Promise.reject(new Error("ollama down")) };
  const vaultOk = { searchDocuments: async () => [hit()] };

  it("corpus all + healthy vault merges both", async () => {
    const out = await runMergedRecall({ thoughts: thoughtsOk, vault: vaultOk }, { query: "q", agents: ["default"], limit: 5, corpus: "all", now: NOW });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("corpus: thoughts");
    expect(out.text).toContain("corpus: documents");
  });

  it("corpus all + down vault degrades with the note", async () => {
    const out = await runMergedRecall({ thoughts: thoughtsOk, vault: vaultDown }, { query: "q", agents: ["default"], limit: 5, corpus: "all", now: NOW });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("documents corpus was unavailable");
  });

  it("corpus documents + down vault + no hits is an error", async () => {
    const out = await runMergedRecall({ thoughts: thoughtsOk, vault: vaultDown }, { query: "q", agents: ["default"], limit: 5, corpus: "documents", now: NOW });
    expect(out.isError).toBe(true);
  });

  it("corpus documents never runs the thoughts leg", async () => {
    let thoughtsCalled = false;
    const spy = {
      searchRanked: async () => {
        thoughtsCalled = true;
        return [];
      },
    };
    await runMergedRecall({ thoughts: spy, vault: vaultOk }, { query: "q", agents: ["default"], limit: 5, corpus: "documents", now: NOW });
    expect(thoughtsCalled).toBe(false);
  });
});
