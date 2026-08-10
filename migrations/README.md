# Migrations - this server OWNS these tables

As of 2026-08-06 this repository is the single owner of the memory
family's DDL. The files here are the source of truth for:

| Migration | Tables |
| --- | --- |
| `0001_thoughts_corpus.sql` | `memory_thoughts`, `memory_kv_store`, `memory_observations`, `memory_patterns`, `agent_state`, `memory_match_thoughts()`, the touch-updated_at trigger |
| `0002_vault_corpus.sql` | `memory_sync_sources`, `memory_documents`, `memory_chunks`, `memory_tree_nodes` |

Apply with `npm run migrate` (`-- --config <path>` for a non-default config;
DDL usually needs an admin-capable database user).

## Adoption semantics

Every statement is idempotent (`IF NOT EXISTS` / `OR REPLACE`), so the first
run against the live database **adopts** it: existing relations are untouched,
missing ones are filled in (on the live database that means
`memory_match_thoughts()` and `agent_state`, which were absent). Fresh
databases get everything. Applied files are recorded in
`rzem_memory_migrations`, each file committing atomically with its record.

## Rules

- New schema changes = a new numbered file here. Never edit an applied file.
- Keep statements idempotent where possible; the adopt-don't-break property is
  worth preserving.
- The two corpora have deliberately different conventions (0001: uuid PKs +
  timestamptz; 0002: ULID text PKs + ISO-text timestamps). Do not harmonise.
- `src/db/schema.ts` (the Drizzle read model for the vault tables) must be
  updated in the same commit as any 0002-family change.

## Ownership

Both corpora were **adopted**, not created here: the thoughts family and the
vault family each predate this repo and were taken over idempotently, so an
existing database is adopted unchanged.

That makes this repo the single owner of every `memory_*` relation. Any other
codebase that once migrated them - an ingestion pipeline, an in-process memory
implementation - must stop. Their schema definitions become read models of
shapes owned here, and their migration sets must not touch `memory_*` tables.

Adopting a database that already holds the tables changes no rows; it records
the baseline and fills in anything missing.
