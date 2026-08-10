/**
 * The vault read repositories - the read-only subset of the upstream ingestion
 * stores (chunk search and listing, document fetch) and the tree store (path
 * lookup, depth and child listing, node search). Every write path is
 * deliberately absent: ingestion stays with the pipeline that owns it.
 */

import { and, asc, eq, isNotNull, isNull, like, sql } from "drizzle-orm";
import type { VaultDb } from "../db/pool.js";
import { memoryChunks, memoryDocuments, memoryTreeNodes } from "../db/schema.js";
import type { DocumentProvenance, DocumentTaint, MemoryChunk, MemoryDocument, MemoryTreeNode, SyncSourceKind } from "../db/schema.js";

/** One chunk-level ANN hit joined to its live parent document. */
export interface DocumentChunkHit {
  documentId: string;
  seq: number;
  text: string;
  similarity: number;
  score: number;
  taint: DocumentTaint;
  eventAt: string;
  title: string;
  sourceKind: SyncSourceKind;
  provenance: DocumentProvenance;
  vaultPath: string;
  externalId: string;
  sourceId: string;
}

/** A summarised tree node's identity + summary, without its embedding vector. */
export type TreeNodeSummary = Pick<
  MemoryTreeNode,
  "id" | "path" | "depth" | "state" | "summaryMd" | "docCount" | "window" | "lastAppendedAt"
>;

export interface TreeNodeHit {
  node: TreeNodeSummary;
  similarity: number;
}

const vectorParam = (vector: readonly number[]): string => `[${vector.join(",")}]`;

export interface VaultReadRepository {
  /** ANN over memory_chunks in the 1024-d bge-m3 space, joined to live documents. */
  searchChunks(embedding: readonly number[], opts: { limit: number; threshold?: number }): Promise<DocumentChunkHit[]>;
  /** Every chunk of a document, ascending by seq - the body fallback for readDocument. */
  listChunksByDocument(documentId: string): Promise<MemoryChunk[]>;
  getDocument(id: string): Promise<MemoryDocument | undefined>;
  getNodeByPath(path: string): Promise<MemoryTreeNode | undefined>;
  listNodesByDepth(depth: number): Promise<MemoryTreeNode[]>;
  listChildrenOf(parentPath: string): Promise<MemoryTreeNode[]>;
  /** ANN over summarised tree-node embeddings (1024-d). Raw similarity; the
   *  recall service applies the hotness boost and final cut. */
  searchNodes(embedding: readonly number[], opts: { limit: number; threshold?: number }): Promise<TreeNodeHit[]>;
}

export function createVaultReadRepository(db: VaultDb): VaultReadRepository {
  return {
    searchChunks(embedding, opts) {
      const vec = vectorParam(embedding);
      const threshold = opts.threshold ?? 0.3;
      const similarity = sql<number>`1 - (${memoryChunks.embedding} <=> ${vec}::vector)`;
      return db
        .select({
          documentId: memoryChunks.documentId,
          seq: memoryChunks.seq,
          text: memoryChunks.text,
          score: memoryChunks.score,
          taint: memoryChunks.taint,
          eventAt: memoryChunks.eventAt,
          similarity,
          title: memoryDocuments.title,
          sourceKind: memoryDocuments.sourceKind,
          provenance: memoryDocuments.provenance,
          vaultPath: memoryDocuments.vaultPath,
          externalId: memoryDocuments.externalId,
          sourceId: memoryDocuments.sourceId,
        })
        .from(memoryChunks)
        .innerJoin(memoryDocuments, eq(memoryDocuments.id, memoryChunks.documentId))
        .where(and(isNotNull(memoryChunks.embedding), isNull(memoryDocuments.deletedAt), sql`${similarity} > ${threshold}`))
        .orderBy(sql`${memoryChunks.embedding} <=> ${vec}::vector`)
        .limit(opts.limit)
        .then((rows) =>
          rows.map((r) => ({
            documentId: r.documentId,
            seq: r.seq,
            text: r.text,
            similarity: Number(r.similarity),
            score: Number(r.score),
            taint: r.taint,
            eventAt: r.eventAt,
            title: r.title,
            sourceKind: r.sourceKind,
            provenance: r.provenance,
            vaultPath: r.vaultPath,
            externalId: r.externalId,
            sourceId: r.sourceId,
          })),
        );
    },

    listChunksByDocument(documentId) {
      return db.select().from(memoryChunks).where(eq(memoryChunks.documentId, documentId)).orderBy(asc(memoryChunks.seq));
    },

    async getDocument(id) {
      const [row] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, id));
      return row;
    },

    async getNodeByPath(path) {
      const [row] = await db.select().from(memoryTreeNodes).where(eq(memoryTreeNodes.path, path));
      return row;
    },

    listNodesByDepth(depth) {
      return db.select().from(memoryTreeNodes).where(eq(memoryTreeNodes.depth, depth)).orderBy(asc(memoryTreeNodes.path));
    },

    /** The child depth is the parent's segment count ('mail/2026' -> depth-2
     *  months); the '<parent>/%' prefix keeps a sibling month from leaking in. */
    listChildrenOf(parentPath) {
      const childDepth = parentPath.split("/").length;
      return db
        .select()
        .from(memoryTreeNodes)
        .where(and(eq(memoryTreeNodes.depth, childDepth), like(memoryTreeNodes.path, `${parentPath}/%`)))
        .orderBy(asc(memoryTreeNodes.path));
    },

    searchNodes(embedding, opts) {
      const vec = vectorParam(embedding);
      const threshold = opts.threshold ?? 0.3;
      const similarity = sql<number>`1 - (${memoryTreeNodes.embedding} <=> ${vec}::vector)`;
      return db
        .select({
          id: memoryTreeNodes.id,
          path: memoryTreeNodes.path,
          depth: memoryTreeNodes.depth,
          state: memoryTreeNodes.state,
          summaryMd: memoryTreeNodes.summaryMd,
          docCount: memoryTreeNodes.docCount,
          window: memoryTreeNodes.window,
          lastAppendedAt: memoryTreeNodes.lastAppendedAt,
          similarity,
        })
        .from(memoryTreeNodes)
        .where(and(isNotNull(memoryTreeNodes.embedding), sql`${similarity} > ${threshold}`))
        .orderBy(sql`${memoryTreeNodes.embedding} <=> ${vec}::vector`)
        .limit(opts.limit)
        .then((rows) =>
          rows.map((r) => {
            const { similarity: sim, ...node } = r;
            return { node, similarity: Number(sim) };
          }),
        );
    },
  };
}
