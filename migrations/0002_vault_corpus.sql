-- 0002: the vault corpus - owned by this repository as of 2026-08-06.
--
-- Ownership migrated here from the Drizzle set that first created these tables.
-- Rewritten idempotently so this migration both creates a fresh database and
-- ADOPTS the live one unchanged: table, index and constraint names match the
-- originals exactly, and IF NOT EXISTS no-ops on everything already present.
-- (The original migration also bundled unrelated tables; those are NOT part of
-- the memory family and stay with the codebase that owns them.)
--
-- Conventions carried from the source, both load-bearing:
-- - ULID text primary keys; ISO-8601 UTC timestamps stored as TEXT, not
--   timestamptz. Window comparisons must cast BOTH sides to ::timestamptz.
-- - memory_tree_nodes' window column is time_window ("window" is reserved).
-- Vectors are 1024-d bge-m3 - a different space from 0001's 768-d nomic.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---- memory_sync_sources ----------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_sync_sources (
    id           TEXT    PRIMARY KEY,
    kind         TEXT    NOT NULL,
    enabled      BOOLEAN NOT NULL DEFAULT FALSE,
    config       JSONB   NOT NULL DEFAULT '{}'::jsonb,
    cursor       JSONB,
    last_sync_at TEXT,
    last_status  TEXT,
    last_error   TEXT,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_sync_sources_kind_idx
    ON memory_sync_sources USING btree (kind);

-- ---- memory_documents -------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_documents (
    id           TEXT             PRIMARY KEY,
    source_id    TEXT             NOT NULL,
    source_kind  TEXT             NOT NULL,
    external_id  TEXT             NOT NULL,
    title        TEXT             NOT NULL,
    vault_path   TEXT             NOT NULL,
    content_hash TEXT             NOT NULL,
    taint        TEXT             NOT NULL,
    provenance   JSONB            NOT NULL DEFAULT '{}'::jsonb,
    score        DOUBLE PRECISION NOT NULL,
    event_at     TEXT             NOT NULL,
    ingested_at  TEXT             NOT NULL,
    deleted_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_documents_source_external_idx
    ON memory_documents USING btree (source_kind, external_id);

-- ---- memory_chunks ----------------------------------------------------------
-- id is sha256(documentId:seq:contentHash) - deterministic, not a ULID.
-- embedding is nullable by design (a sweep backfills embedding IS NULL rows).
-- The FK is declared inline with the original constraint name so a fresh
-- create matches the adopted table exactly.
CREATE TABLE IF NOT EXISTS memory_chunks (
    id          TEXT             PRIMARY KEY,
    document_id TEXT             NOT NULL
        CONSTRAINT memory_chunks_document_id_memory_documents_id_fk
        REFERENCES memory_documents(id) ON DELETE CASCADE,
    seq         INTEGER          NOT NULL,
    text        TEXT             NOT NULL,
    embedding   VECTOR(1024),
    score       DOUBLE PRECISION NOT NULL,
    taint       TEXT             NOT NULL,
    event_at    TEXT             NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_chunks_embedding_idx
    ON memory_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memory_chunks_document_idx
    ON memory_chunks USING btree (document_id);

-- ---- memory_tree_nodes ------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_tree_nodes (
    id               TEXT    PRIMARY KEY,
    path             TEXT    NOT NULL
        CONSTRAINT memory_tree_nodes_path_unique UNIQUE,
    depth            INTEGER NOT NULL,
    state            TEXT    NOT NULL DEFAULT 'open',
    summary_md       TEXT,
    embedding        VECTOR(1024),
    doc_count        INTEGER NOT NULL DEFAULT 0,
    time_window      JSONB   NOT NULL,
    last_appended_at TEXT,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_tree_nodes_depth_state_idx
    ON memory_tree_nodes USING btree (depth, state);
