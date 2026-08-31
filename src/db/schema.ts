/**
 * Drizzle definitions for the vault corpus tables - the query-side read model
 * of shapes OWNED by this repo's migrations/0002_vault_corpus.sql and 0003_vault_namespace.sql. Any change
 * to that migration family must update this file in the same commit.
 *
 * Conventions (deliberate, historical):
 * - ULID text primary keys.
 * - ISO-8601 UTC timestamps stored as TEXT, not timestamptz. Every window
 *   comparison must cast BOTH sides: `event_at::timestamptz >= $1::timestamptz`.
 *   (memory_thoughts, in the 0001 family, uses real timestamptz - a different
 *   convention in the same database. Do not copy patterns across.)
 */

import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, vector } from "drizzle-orm/pg-core";

const ulidPrimaryKey = () => text("id").primaryKey();
const isoTimestamp = (name: string) => text(name);

export const SYNC_SOURCE_KINDS = ["mail", "github", "folder", "articles", "calendar"] as const;
export type SyncSourceKind = (typeof SYNC_SOURCE_KINDS)[number];
export type SyncSourceStatus = "ok" | "error";
export const DOCUMENT_TAINTS = ["internal", "external"] as const;
export type DocumentTaint = (typeof DOCUMENT_TAINTS)[number];
export const TREE_NODE_STATES = ["open", "sealed", "summarised"] as const;
export type TreeNodeState = (typeof TREE_NODE_STATES)[number];

export type DocumentProvenance = Record<string, unknown>;
export type SyncSourceConfig = Record<string, unknown>;
export type SyncSourceCursor = Record<string, unknown>;

export interface TreeNodeWindow {
  from: string;
  to: string;
}

export const memorySyncSources = pgTable(
  "memory_sync_sources",
  {
    id: ulidPrimaryKey(),
    kind: text("kind").$type<SyncSourceKind>().notNull(),
    enabled: boolean("enabled").notNull().default(false),
    config: jsonb("config").$type<SyncSourceConfig>().notNull().default({}),
    cursor: jsonb("cursor").$type<SyncSourceCursor>(),
    lastSyncAt: isoTimestamp("last_sync_at"),
    lastStatus: text("last_status").$type<SyncSourceStatus>(),
    lastError: text("last_error"),
    createdAt: isoTimestamp("created_at").notNull(),
    updatedAt: isoTimestamp("updated_at").notNull(),
  },
  (table) => [uniqueIndex("memory_sync_sources_kind_idx").on(table.kind)],
);

export const memoryDocuments = pgTable(
  "memory_documents",
  {
    id: ulidPrimaryKey(),
    sourceId: text("source_id").notNull(),
    sourceKind: text("source_kind").$type<SyncSourceKind>().notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    vaultPath: text("vault_path").notNull(),
    contentHash: text("content_hash").notNull(),
    taint: text("taint").$type<DocumentTaint>().notNull(),
    provenance: jsonb("provenance").$type<DocumentProvenance>().notNull().default({}),
    score: doublePrecision("score").notNull(),
    eventAt: isoTimestamp("event_at").notNull(),
    ingestedAt: isoTimestamp("ingested_at").notNull(),
    deletedAt: isoTimestamp("deleted_at"),
    // 0003: the owning namespace. NULL = pre-0003 or ingestion-written; owned
    // by [vault] default_owner at query time (repositories/namespace.ts).
    agentId: text("agent_id"),
  },
  (table) => [
    uniqueIndex("memory_documents_source_external_idx").on(table.sourceKind, table.externalId),
    index("memory_documents_agent_idx").on(table.agentId),
  ],
);

export const memoryChunks = pgTable(
  "memory_chunks",
  {
    // sha256(documentId:seq:contentHash) - deterministic, not a ULID.
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => memoryDocuments.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
    // Nullable by design: the tree-build sweep backfills embedding IS NULL rows.
    embedding: vector("embedding", { dimensions: 1024 }),
    score: doublePrecision("score").notNull(),
    taint: text("taint").$type<DocumentTaint>().notNull(),
    eventAt: isoTimestamp("event_at").notNull(),
  },
  (table) => [
    index("memory_chunks_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("memory_chunks_document_idx").on(table.documentId),
  ],
);

export const memoryTreeNodes = pgTable(
  "memory_tree_nodes",
  {
    id: ulidPrimaryKey(),
    path: text("path").notNull().unique(),
    depth: integer("depth").notNull(),
    state: text("state").$type<TreeNodeState>().notNull().default("open"),
    summaryMd: text("summary_md"),
    embedding: vector("embedding", { dimensions: 1024 }),
    docCount: integer("doc_count").notNull().default(0),
    // TRAP: the Drizzle property is `window` but the COLUMN is `time_window`
    // (`window` is a PG reserved word). Raw SQL must say time_window.
    window: jsonb("time_window").$type<TreeNodeWindow>().notNull(),
    lastAppendedAt: isoTimestamp("last_appended_at"),
    createdAt: isoTimestamp("created_at").notNull(),
    updatedAt: isoTimestamp("updated_at").notNull(),
    // 0003: see memoryDocuments.agentId. path stays UNIQUE - one tree per database.
    agentId: text("agent_id"),
  },
  (table) => [
    index("memory_tree_nodes_depth_state_idx").on(table.depth, table.state),
    index("memory_tree_nodes_agent_idx").on(table.agentId, table.depth, table.state),
  ],
);

export type MemoryDocument = typeof memoryDocuments.$inferSelect;
export type MemoryChunk = typeof memoryChunks.$inferSelect;
export type MemoryTreeNode = typeof memoryTreeNodes.$inferSelect;
export type MemorySyncSource = typeof memorySyncSources.$inferSelect;
