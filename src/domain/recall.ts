/**
 * The pure recall domain - composite ranking, corpus merge and result
 * formatting, ported whole from the prior in-process implementation. No IO
 * anywhere in this module; `now` is always injected so decay is deterministic
 * under test.
 *
 * Two spaces, never mixed: a thought's cosine similarity comes from the 768-d
 * nomic space, a document's from the 1024-d bge-m3 space. The merge never
 * compares vectors across the two - it compares the composite RANK, a
 * dimensionless [0,1]-ish number each corpus computes in its own space:
 *
 *     rank = similarity * freshnessDecay(age) * qualityTerm
 *
 * freshnessDecay is an exponential 30-day half-life on the row's own time (a
 * document's event_at, a thought's created_at); qualityTerm is the admission
 * factor 0.5 + 0.5 * score for documents and a flat 1.0 for thoughts.
 */

import type { RankedResult } from "../repositories/thoughts.js";
import type { DocumentChunkHit } from "../repositories/vault.js";
import type { DocumentProvenance, DocumentTaint, MemoryTreeNode, SyncSourceKind } from "../db/schema.js";

// --- Composite ranking (pure) ---

/** Freshness half-life for the corpus decay, in days (a locked decision). */
export const FRESHNESS_HALF_LIFE_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * The exponential freshness multiplier: `0.5 ^ (ageDays / halfLife)`. A
 * zero-or-negative age is a flat 1.0 (never a boost above 1); a non-finite age
 * (missing/unparseable time) is fully decayed (0), so a row with no usable time
 * never outranks a dated one.
 */
export function freshnessDecay(ageMs: number, halfLifeDays: number = FRESHNESS_HALF_LIFE_DAYS): number {
  if (!Number.isFinite(ageMs)) {
    return 0;
  }
  if (ageMs <= 0) {
    return 1;
  }
  return Math.pow(0.5, ageMs / MS_PER_DAY / halfLifeDays);
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** A document's admission-quality term, `0.5 + 0.5 * score`: a top-scored
 *  document weighs 1.0, a bottom-scored one 0.5 - quality shades the rank but
 *  never zeroes a strong, fresh match. Defaults to 1.0 when the gate stored none. */
export function documentQualityTerm(score: number | null | undefined): number {
  return 0.5 + 0.5 * clamp01(score ?? 1);
}

/** The composite rank of one candidate row, in its own embedding space. */
export function compositeRank(input: { similarity: number; ageMs: number; qualityTerm: number }): number {
  return input.similarity * freshnessDecay(input.ageMs) * input.qualityTerm;
}

const ageMsFrom = (now: number, iso: string): number => now - Date.parse(iso);

/** The candidate pool a recall leg pulls before dedup + composite re-rank, so a
 *  fresher-but-lower ANN neighbour is not lost before decay is applied. */
export const RECALL_CANDIDATE_MULTIPLIER = 4;
export const RECALL_CANDIDATE_FLOOR = 20;
export function recallCandidatePool(limit: number): number {
  return Math.max(limit * RECALL_CANDIDATE_MULTIPLIER, RECALL_CANDIDATE_FLOOR);
}

/** The hotness boost ceiling for tree-node search: a node appended to today
 *  ranks up to +25% over an identical-similarity cold node. */
export const TREE_HOTNESS_BOOST = 0.25;

// --- Merged results (labelled) ---

/** Which corpus (or both) a memory_search call sweeps. */
export type RecallCorpus = "thoughts" | "documents" | "all";

/** A ranked thought result. `taint` is always `internal`: thoughts are Alex's
 *  own conversational captures, not synced external content. */
export interface ThoughtRecallResult {
  corpus: "thoughts";
  taint: "internal";
  rank: number;
  similarity: number;
  createdAt: string;
  agentId: string;
  id: string;
  content: string;
  tags: string[];
}

/** A ranked document result. `taint` is the stored provenance label, surfaced
 *  verbatim (`external` for synced content). */
export interface DocumentRecallResult {
  corpus: "documents";
  taint: DocumentTaint;
  rank: number;
  similarity: number;
  eventAt: string;
  documentId: string;
  title: string;
  sourceKind: SyncSourceKind;
  vaultPath: string;
  excerpt: string;
  provenance: DocumentProvenance;
}

export type MergedRecallResult = ThoughtRecallResult | DocumentRecallResult;

const EXCERPT_MAX_CHARS = 240;

export function excerpt(text: string, max: number = EXCERPT_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/**
 * Merge thoughts and documents into one ranked, labelled list. Each corpus
 * computes its composite rank in its own space, documents are deduped to their
 * best-ranked chunk (one row per document), and the union is sorted by rank
 * descending and cut to `limit`. No cross-store dedup: a fact held both as a
 * thought and inside a synced document may surface twice, labelled each way.
 */
export function mergeCorpora(input: {
  thoughts: readonly RankedResult[];
  documents: readonly DocumentChunkHit[];
  now: number;
  limit: number;
}): MergedRecallResult[] {
  const { now, limit } = input;

  const thoughtResults: ThoughtRecallResult[] = input.thoughts.map((t) => ({
    corpus: "thoughts",
    taint: "internal",
    rank: compositeRank({ similarity: t.similarity, ageMs: ageMsFrom(now, t.created_at), qualityTerm: 1 }),
    similarity: t.similarity,
    createdAt: t.created_at,
    agentId: t.agent_id,
    id: t.id,
    content: t.content,
    tags: t.tags,
  }));

  // Dedup documents to the single best-ranked chunk per document - the agent
  // wants distinct documents, not several chunks of the same email/article.
  const bestPerDocument = new Map<string, DocumentRecallResult>();
  for (const hit of input.documents) {
    const rank = compositeRank({
      similarity: hit.similarity,
      ageMs: ageMsFrom(now, hit.eventAt),
      qualityTerm: documentQualityTerm(hit.score),
    });
    const current = bestPerDocument.get(hit.documentId);
    if (current && current.rank >= rank) {
      continue;
    }
    bestPerDocument.set(hit.documentId, {
      corpus: "documents",
      taint: hit.taint,
      rank,
      similarity: hit.similarity,
      eventAt: hit.eventAt,
      documentId: hit.documentId,
      title: hit.title,
      sourceKind: hit.sourceKind,
      vaultPath: hit.vaultPath,
      excerpt: excerpt(hit.text),
      provenance: hit.provenance,
    });
  }

  const merged: MergedRecallResult[] = [...thoughtResults, ...bestPerDocument.values()];
  // Sort by rank descending; a tie keeps insertion order (thoughts before
  // documents), deterministic across runs.
  merged.sort((a, b) => b.rank - a.rank);
  return merged.slice(0, limit);
}

// --- Formatting (the frozen text contract, shared by handlers and tests) ---

const fmt = (n: number): string => n.toFixed(3);
const isoDate = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toISOString().slice(0, 10);
};

function formatMergedResult(result: MergedRecallResult, index: number): string {
  const head = `[${index + 1}]`;
  if (result.corpus === "thoughts") {
    const tags = result.tags.length ? ` | tags: ${result.tags.join(", ")}` : "";
    return (
      `${head} corpus: thoughts | taint: ${result.taint} | rank: ${fmt(result.rank)} | sim: ${fmt(result.similarity)} | ` +
      `${isoDate(result.createdAt)} | agent: ${result.agentId} | id: ${result.id}\n    ${result.content}${tags}`
    );
  }
  return (
    `${head} corpus: documents | taint: ${result.taint} | rank: ${fmt(result.rank)} | sim: ${fmt(result.similarity)} | ` +
    `${isoDate(result.eventAt)} | source: ${result.sourceKind} | doc: ${result.documentId} | path: ${result.vaultPath}\n    ` +
    `${result.title}${result.excerpt ? ` - ${result.excerpt}` : ""}`
  );
}

export function formatMergedResults(corpus: RecallCorpus, results: readonly MergedRecallResult[]): string {
  if (results.length === 0) {
    return "No matching memories found.";
  }
  const header = corpus === "all" ? "corpus: all (thoughts + documents)" : `corpus: ${corpus}`;
  return `${header}\n\n${results.map((r, i) => formatMergedResult(r, i)).join("\n\n")}`;
}

/** Format a thoughts-only search response (the historical search_memory shape). */
export function formatThoughtResults(mode: string, results: readonly RankedResult[]): string {
  if (results.length === 0) {
    return "No matching memories found.";
  }
  const formatted = results
    .map((r, i) => {
      const date = new Date(r.created_at).toISOString().slice(0, 10);
      const sim = r.similarity != null ? r.similarity.toFixed(3) : "N/A";
      const scoreStr = r.score != null ? `score: ${r.score.toFixed(3)}, ` : "";
      const tags = r.tags.length ? ` | tags: ${r.tags.join(", ")}` : "";
      return `[${i + 1}] (id: ${r.id}, ${scoreStr}sim: ${sim}, ${date}) [${r.agent_id}] ${r.content}${tags}`;
    })
    .join("\n\n");
  return `mode: ${mode}\n\n${formatted}`;
}

// --- Tree/document views + formatting ---

export interface TreeListEntry {
  path: string;
  depth: number;
  state: MemoryTreeNode["state"];
  docCount: number;
  window: MemoryTreeNode["window"];
  lastAppendedAt: string | null;
  summarised: boolean;
}

export interface TreeNodeView {
  path: string;
  depth: number;
  state: MemoryTreeNode["state"];
  docCount: number;
  window: MemoryTreeNode["window"];
  lastAppendedAt: string | null;
  summaryMd: string | null;
}

export interface TreeSearchResult {
  path: string;
  state: MemoryTreeNode["state"];
  rank: number;
  similarity: number;
  window: MemoryTreeNode["window"];
  summaryExcerpt: string;
}

export interface DocumentView {
  id: string;
  title: string;
  sourceKind: SyncSourceKind;
  externalId: string;
  taint: DocumentTaint;
  score: number;
  eventAt: string;
  ingestedAt: string;
  vaultPath: string;
  provenance: DocumentProvenance;
  /** Where the body came from: the vault file, or the chunk table fallback. */
  bodySource: "vault" | "chunks";
  body: string;
  truncated: boolean;
}

/** The default and hard-maximum body size for memory_read_document (characters). */
export const DOCUMENT_BODY_MAX_CHARS = 20_000;

const windowStr = (w: MemoryTreeNode["window"]): string => `${isoDate(w.from)}..${isoDate(w.to)}`;

export function formatTreeList(scope: string, entries: readonly TreeListEntry[]): string {
  if (entries.length === 0) {
    return `No tree nodes under ${scope}.`;
  }
  const lines = entries.map(
    (e) =>
      `- ${e.path} | ${e.state} | window: ${windowStr(e.window)} | docs: ${e.docCount}` +
      `${e.lastAppendedAt ? ` | last: ${isoDate(e.lastAppendedAt)}` : ""}`,
  );
  return `tree under ${scope} (${entries.length}):\n${lines.join("\n")}`;
}

export function formatTreeNode(view: TreeNodeView): string {
  const meta =
    `path: ${view.path}\nstate: ${view.state}\nwindow: ${windowStr(view.window)}\n` +
    `docs: ${view.docCount}${view.lastAppendedAt ? `\nlast appended: ${view.lastAppendedAt}` : ""}`;
  if (view.state !== "summarised" || !view.summaryMd) {
    return `${meta}\n\n(No summary yet - this node is still ${view.state}.)`;
  }
  return `${meta}\n\n${view.summaryMd}`;
}

export function formatTreeSearch(query: string, results: readonly TreeSearchResult[]): string {
  if (results.length === 0) {
    return "No matching tree nodes found.";
  }
  const lines = results.map(
    (r, i) =>
      `[${i + 1}] ${r.path} | ${r.state} | rank: ${fmt(r.rank)} | sim: ${fmt(r.similarity)} | window: ${windowStr(r.window)}` +
      `${r.summaryExcerpt ? `\n    ${r.summaryExcerpt}` : ""}`,
  );
  return `tree search: ${query}\n\n${lines.join("\n\n")}`;
}

export function formatDocument(view: DocumentView): string {
  const provenanceKeys = Object.keys(view.provenance);
  const provenance = provenanceKeys.length ? JSON.stringify(view.provenance) : "(none)";
  const header =
    `id: ${view.id}\ntitle: ${view.title}\nsource: ${view.sourceKind}\nexternal_id: ${view.externalId}\n` +
    `taint: ${view.taint}\nscore: ${fmt(view.score)}\nevent_at: ${view.eventAt}\ningested_at: ${view.ingestedAt}\n` +
    `vault_path: ${view.vaultPath}\nprovenance: ${provenance}\nbody_source: ${view.bodySource}` +
    `${view.truncated ? `\nnote: body truncated to ${view.body.length} characters` : ""}`;
  return `${header}\n\n${view.body}`;
}
