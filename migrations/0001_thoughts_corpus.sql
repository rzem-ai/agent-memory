-- 0001: the thoughts corpus - owned by this repository as of 2026-08-06.
--
-- Ownership migrated here from the migration set that first created these
-- tables; this server is now their single owner. Every statement is idempotent
-- (IF NOT EXISTS / OR REPLACE), so this migration both creates a fresh
-- database and ADOPTS an existing one unchanged - adoption of the live
-- database is a no-op for everything that already exists there, and fills in
-- anything missing (notably memory_match_thoughts() and agent_state).
--
-- Vectors are 768-d nomic. memory_thoughts uses real timestamptz (unlike the
-- vault corpus in 0002, which stores ISO text - a deliberate, historical
-- difference; do not "fix" either to match the other).

CREATE EXTENSION IF NOT EXISTS vector;

-- ---- memory_thoughts --------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_thoughts (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    content      TEXT         NOT NULL,
    embedding    VECTOR(768),
    metadata     JSONB        NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    confidence   REAL         NOT NULL DEFAULT 1.0,
    access_count BIGINT       NOT NULL DEFAULT 0,
    accessed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    scope        TEXT         NOT NULL DEFAULT 'episodic',
    deleted      BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_memory_thoughts_agent_id
    ON memory_thoughts ((metadata->>'agent_id'));
CREATE INDEX IF NOT EXISTS idx_memory_thoughts_not_deleted
    ON memory_thoughts (deleted) WHERE deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_memory_thoughts_metadata
    ON memory_thoughts USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_memory_thoughts_created
    ON memory_thoughts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_thoughts_embedding
    ON memory_thoughts USING hnsw (embedding vector_cosine_ops);

-- Touch updated_at on any UPDATE.
CREATE OR REPLACE FUNCTION memory_thoughts_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS memory_thoughts_touch_updated_at ON memory_thoughts;
CREATE TRIGGER memory_thoughts_touch_updated_at
    BEFORE UPDATE ON memory_thoughts
    FOR EACH ROW EXECUTE FUNCTION memory_thoughts_touch_updated_at();

-- ---- memory_kv_store --------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_kv_store (
    agent_id   TEXT        NOT NULL,
    key        TEXT        NOT NULL,
    value      JSONB       NOT NULL,
    version    INTEGER     NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, key)
);

-- ---- memory_observations ----------------------------------------------------
-- Not served by this server's tools, but part of the memory family it owns.
CREATE TABLE IF NOT EXISTS memory_observations (
    id               SERIAL       PRIMARY KEY,
    agent_id         TEXT         NOT NULL,
    observed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    observation_type VARCHAR(50)  NOT NULL,
    context          JSONB        NOT NULL,
    action           JSONB        NOT NULL,
    metadata         JSONB
);
CREATE INDEX IF NOT EXISTS idx_memory_observations_agent_id
    ON memory_observations (agent_id);
CREATE INDEX IF NOT EXISTS idx_observations_type
    ON memory_observations (observation_type);
CREATE INDEX IF NOT EXISTS idx_observations_time
    ON memory_observations (observed_at DESC);

-- ---- memory_patterns --------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_patterns (
    id                  SERIAL       PRIMARY KEY,
    agent_id            TEXT         NOT NULL,
    pattern_type        VARCHAR(50)  NOT NULL,
    description         TEXT         NOT NULL,
    confidence          REAL         NOT NULL DEFAULT 0.3,
    observation_count   INTEGER      NOT NULL DEFAULT 1,
    first_observed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_observed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_applied_at     TIMESTAMPTZ,
    context_tags        TEXT[],
    pattern_data        JSONB        NOT NULL,
    embedding           VECTOR(768),
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    source_interactions JSONB
);
CREATE INDEX IF NOT EXISTS idx_memory_patterns_agent_id
    ON memory_patterns (agent_id);
CREATE INDEX IF NOT EXISTS idx_patterns_confidence
    ON memory_patterns (confidence DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_type
    ON memory_patterns (pattern_type);
CREATE INDEX IF NOT EXISTS idx_patterns_tags
    ON memory_patterns USING GIN (context_tags);
CREATE INDEX IF NOT EXISTS idx_patterns_active
    ON memory_patterns (is_active) WHERE is_active = TRUE;

-- ---- agent_state ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_state (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id   TEXT         NOT NULL UNIQUE,
    state      JSONB        NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---- memory_match_thoughts() ------------------------------------------------
-- Kept for external callers (an ingestion pipeline's similarity mode calls it).
-- This server itself uses inline SQL and never depends on the function.
CREATE OR REPLACE FUNCTION memory_match_thoughts(
    query_embedding  vector,
    match_threshold  double precision DEFAULT 0.3,
    match_count      integer          DEFAULT 10,
    filter_agent     text             DEFAULT NULL
)
RETURNS TABLE(
    id          uuid,
    content     text,
    metadata    jsonb,
    similarity  double precision,
    created_at  timestamp with time zone
)
LANGUAGE sql
STABLE
AS $function$
    SELECT
        id,
        content,
        metadata,
        1 - (embedding <=> query_embedding) AS similarity,
        created_at
    FROM memory_thoughts
    WHERE
        embedding IS NOT NULL
        AND deleted = FALSE
        AND 1 - (embedding <=> query_embedding) > match_threshold
        AND (filter_agent IS NULL OR metadata->>'agent_id' = filter_agent)
    ORDER BY embedding <=> query_embedding
    LIMIT match_count;
$function$;
