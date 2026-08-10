/**
 * The recall services - the IO layer under the memory_search / memory_tree /
 * memory_read_document tools, ported from the service half of the prior
 * in-process implementation.
 *
 * VaultRecall is optional at wiring time in the source; here the vault tables
 * always exist in the shared database, but the vault DIRECTORY may not be on
 * this host - readDocument falls back to concatenated chunk text, and a down
 * bge-m3 backend degrades the documents leg rather than failing the call.
 */

import {
  DOCUMENT_BODY_MAX_CHARS,
  TREE_HOTNESS_BOOST,
  freshnessDecay,
  excerpt,
  formatMergedResults,
  mergeCorpora,
  recallCandidatePool,
  type DocumentView,
  type TreeListEntry,
  type TreeNodeView,
  type TreeSearchResult,
} from "../domain/recall.js";
import { VaultDocumentError, readVaultBody } from "../vault/read.js";
import type { DocumentChunkHit, VaultReadRepository } from "../repositories/vault.js";
import type { RankedResult, ThoughtsRepository } from "../repositories/thoughts.js";
import type { EmbeddingClient } from "../embeddings/index.js";

const YEAR_DEPTH = 1;

export interface VaultRecall {
  searchDocuments(query: string, opts: { limit: number; threshold?: number }): Promise<DocumentChunkHit[]>;
  treeList(path?: string): Promise<TreeListEntry[]>;
  treeRead(path: string): Promise<TreeNodeView | null>;
  treeSearch(query: string, opts: { limit: number; threshold?: number }): Promise<TreeSearchResult[]>;
  readDocument(documentId: string, opts?: { maxChars?: number }): Promise<DocumentView | null>;
}

export interface VaultRecallDeps {
  repo: VaultReadRepository;
  documentEmbeddings: EmbeddingClient;
  /** Vault root when mounted on this host; absent = always the chunk fallback. */
  vaultDir?: string;
  now?: () => number;
}

export function createVaultRecall(deps: VaultRecallDeps): VaultRecall {
  const { repo } = deps;
  const now = deps.now ?? Date.now;

  return {
    async searchDocuments(query, opts) {
      const embedding = await deps.documentEmbeddings.embed(query);
      return repo.searchChunks(embedding, {
        limit: recallCandidatePool(opts.limit),
        ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      });
    },

    async treeList(path) {
      const nodes = path === undefined ? await repo.listNodesByDepth(YEAR_DEPTH) : await repo.listChildrenOf(path);
      return nodes.map((node) => ({
        path: node.path,
        depth: node.depth,
        state: node.state,
        docCount: node.docCount,
        window: node.window,
        lastAppendedAt: node.lastAppendedAt,
        summarised: node.state === "summarised",
      }));
    },

    async treeRead(path) {
      const node = await repo.getNodeByPath(path);
      if (!node) {
        return null;
      }
      return {
        path: node.path,
        depth: node.depth,
        state: node.state,
        docCount: node.docCount,
        window: node.window,
        lastAppendedAt: node.lastAppendedAt,
        summaryMd: node.summaryMd,
      };
    },

    async treeSearch(query, opts) {
      const embedding = await deps.documentEmbeddings.embed(query);
      const hits = await repo.searchNodes(embedding, {
        limit: recallCandidatePool(opts.limit),
        ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      });
      const at = now();
      const ranked = hits.map((hit) => {
        const ageMs = hit.node.lastAppendedAt == null ? null : at - Date.parse(hit.node.lastAppendedAt);
        const boost = ageMs == null ? 0 : TREE_HOTNESS_BOOST * freshnessDecay(ageMs);
        return {
          path: hit.node.path,
          state: hit.node.state,
          rank: hit.similarity * (1 + boost),
          similarity: hit.similarity,
          window: hit.node.window,
          summaryExcerpt: excerpt(hit.node.summaryMd ?? ""),
        };
      });
      ranked.sort((a, b) => b.rank - a.rank);
      return ranked.slice(0, opts.limit);
    },

    async readDocument(documentId, opts) {
      const doc = await repo.getDocument(documentId);
      if (!doc) {
        return null;
      }
      // Defence in depth alongside the schema's .max(): clamp a caller-supplied
      // cap so a tainted document cannot instruct the model past the ceiling.
      const maxChars = Math.min(opts?.maxChars ?? DOCUMENT_BODY_MAX_CHARS, DOCUMENT_BODY_MAX_CHARS);

      // Prefer the vault file (canonical body); fall back to the chunk table's
      // text when the vault is not mounted here or the file is missing.
      let body: string;
      let bodySource: "vault" | "chunks";
      try {
        if (!deps.vaultDir) {
          throw new VaultDocumentError("vault not mounted on this host");
        }
        body = await readVaultBody(deps.vaultDir, doc.vaultPath);
        bodySource = "vault";
      } catch (err) {
        if (!(err instanceof VaultDocumentError) && (err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw err;
        }
        const rows = await repo.listChunksByDocument(documentId);
        body = rows.map((c) => c.text).join("\n\n");
        bodySource = "chunks";
      }

      const truncated = body.length > maxChars;
      return {
        id: doc.id,
        title: doc.title,
        sourceKind: doc.sourceKind,
        externalId: doc.externalId,
        taint: doc.taint,
        score: doc.score,
        eventAt: doc.eventAt,
        ingestedAt: doc.ingestedAt,
        vaultPath: doc.vaultPath,
        provenance: doc.provenance,
        bodySource,
        body: truncated ? body.slice(0, maxChars) : body,
        truncated,
      };
    },
  };
}

// --- The merged (documents/all) recall orchestration ---

export interface MergedRecallDeps {
  thoughts: Pick<ThoughtsRepository, "searchRanked">;
  vault?: Pick<VaultRecall, "searchDocuments">;
}

export interface MergedRecallOutput {
  text: string;
  isError: boolean;
}

const DOCUMENTS_UNAVAILABLE_NOTE =
  "note: the documents corpus was unavailable (vault not mounted or its embedding backend was unreachable).";

/**
 * Run the merged (documents/all) recall path. The thoughts leg (only for 'all')
 * is pure cosine + created_at so the composite re-rank owns freshness/quality.
 * The documents leg tolerates a down/absent embedding backend, returning null
 * (not []) so 'all' notes the degradation while 'documents' flags an error. The
 * thoughts leg is deliberately NOT wrapped: a thoughts-embedding failure fails
 * the whole call - the accepted asymmetry.
 */
export async function runMergedRecall(
  deps: MergedRecallDeps,
  args: { query: string; agents: readonly string[]; limit: number; corpus: "documents" | "all"; now?: number },
): Promise<MergedRecallOutput> {
  const thoughts: RankedResult[] =
    args.corpus === "all"
      ? await deps.thoughts.searchRanked(args.query, {
          mode: "similarity",
          agents: args.agents,
          limit: recallCandidatePool(args.limit),
        })
      : [];

  let documents: DocumentChunkHit[] | null = null;
  if (deps.vault) {
    try {
      documents = await deps.vault.searchDocuments(args.query, { limit: args.limit });
    } catch {
      documents = null;
    }
  }

  const merged = mergeCorpora({ thoughts, documents: documents ?? [], now: args.now ?? Date.now(), limit: args.limit });
  const body = formatMergedResults(args.corpus, merged);
  if (documents === null) {
    if (args.corpus === "documents" && merged.length === 0) {
      return { text: DOCUMENTS_UNAVAILABLE_NOTE, isError: true };
    }
    return { text: `${body}\n\n${DOCUMENTS_UNAVAILABLE_NOTE}`, isError: false };
  }
  return { text: body, isError: false };
}
