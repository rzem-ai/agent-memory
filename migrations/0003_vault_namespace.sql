-- 0003: namespace the vault corpus (a 0002-family change).
--
-- memory_documents and memory_tree_nodes carried no owner, so every credential
-- in any namespace could read the whole vault - the "namespace escape"
-- SECURITY.md names first. The thoughts corpus has been namespaced since 0001
-- (metadata->>'agent_id'); the vault tables have no metadata JSONB, so here it
-- is a real column.
--
-- No backfill. Rows with agent_id IS NULL belong to [vault] default_owner
-- (config), decided at query time: an existing database keeps working the day
-- this lands, and the ingestion pipeline - which writes these rows and does not
-- yet know about namespaces - is not broken. memory_chunks is deliberately NOT
-- namespaced: every chunk read inner-joins memory_documents, so the filter
-- lands on the join and the largest table stays as it is.
--
-- Known limit: memory_tree_nodes.path stays UNIQUE, so there is one tree per
-- database. Per-user trees need (agent_id, path) uniqueness, which is an
-- ingestion-side change and out of scope here.

ALTER TABLE memory_documents  ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE memory_tree_nodes ADD COLUMN IF NOT EXISTS agent_id TEXT;

CREATE INDEX IF NOT EXISTS memory_documents_agent_idx
    ON memory_documents (agent_id);
CREATE INDEX IF NOT EXISTS memory_tree_nodes_agent_idx
    ON memory_tree_nodes (agent_id, depth, state);
