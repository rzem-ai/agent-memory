# Technical reference

The tool contract, the ranking model, the identity model, and the wire
behaviour - everything an integrator or reviewer needs beyond the overview in
[the README](../README.md).

## Identity: the credential is the namespace

Every authentication path resolves to one internal identity:

```
AgentIdentity {
  name:   string        // stable label for logs, e.g. 'claude-code'
  agents: string[]      // namespaces this caller may touch; ['*'] = all
  scopes: Scope[]       // memory:read | memory:write | memory:admin
}
```

- **Reads** (`memory_search`) span every namespace in `agents`; a wildcard
  identity searches all agents.
- **Writes** (`memory_capture`, `memory_kv_*`) land in the **primary agent**:
  the first non-wildcard entry. A wildcard-only identity has no write
  namespace and write tools refuse it explicitly.
- **Deletes** (`memory_forget`) are namespace-guarded in SQL: a thought owned
  by an agent outside the caller's list reports "not found".

No tool takes an agent parameter. The surface-parity test
(`tests/tools/surface.test.ts`) fails the build if `agent_id` appears in any
schema.

### Scopes

| Scope | Tools |
| --- | --- |
| `memory:read` | `memory_search`, `memory_read_document`, `memory_tree`, `memory_kv_get`, `memory_kv_list` |
| `memory:write` | `memory_capture`, `memory_kv_set` |
| `memory:admin` | `memory_forget`, `memory_kv_delete` |

Enforced in code on every call (`src/auth/scopes.ts` + `requireScope`). A
denied call returns an `isError` tool result naming the missing scope - not a
protocol error - so agents can report the situation rather than crash.

## The two corpora and the ranking model

| | Thoughts | Documents |
| --- | --- | --- |
| Tables | `memory_thoughts`, `memory_kv_store` | `memory_documents`, `memory_chunks`, `memory_tree_nodes` |
| Embedding | 768-d nomic-embed-text | 1024-d bge-m3 |
| Time basis | `created_at` (timestamptz) | `event_at` (ISO text, the item's own time) |
| Quality term | flat 1.0 | `0.5 + 0.5 * admission_score` |

The two vector spaces are **never mixed**. Cross-corpus merging compares the
composite rank - a dimensionless number each corpus computes in its own space:

```
rank = similarity * freshnessDecay(age) * qualityTerm
freshnessDecay(age) = 0.5 ^ (ageDays / 30)
```

- Age <= 0 (future/just-now) gives a flat 1.0 - never a boost above 1.
- An unparseable timestamp decays to 0 - a row with no usable time never
  outranks a dated one.
- Both legs over-fetch a candidate pool of `max(limit * 4, 20)` before the
  re-rank, so a fresher-but-slightly-less-similar neighbour is not lost to the
  ANN cut.
- Document hits are deduplicated to the best-ranked chunk per document before
  merging.
- No cross-corpus dedup: a fact stored as a thought and present in a synced
  document may surface twice, labelled each way.

## Tools

All tools return text content (the formats below are a frozen contract - hook
scripts parse them) plus a `structuredContent` mirror for structured-output
clients. Errors return `isError: true` with a human-readable message. Every
tool declares `outputSchema` and behaviour annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint: false`).

### memory_search (memory:read)

Semantic recall. Inputs:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `query` | string, non-empty | required | |
| `corpus` | `thoughts` \| `documents` \| `all` | `all` | |
| `limit` | int > 0 | 5 | |
| `relevance_mode` | `recency_weighted` \| `similarity` \| `recent` \| `since` | server config | thoughts corpus only |
| `relevance_value` | number > 0 | mode-dependent | thoughts corpus only |

**Corpus `thoughts`** ranks by `relevance_mode`:

- `recency_weighted` (default): `similarity * max(floor, 1 - age/decayDays)`;
  `relevance_value` overrides the decay window (default 90 days, floor 0.1).
- `similarity`: pure cosine, no date consideration.
- `recent`: semantic matches, newest first.
- `since`: similarity-ranked, restricted to the last `relevance_value` days
  (default 30).

Output shape (thoughts corpus):

```
mode: <relevance_mode>

[1] (id: <uuid>, score: X.XXX, sim: Y.YYY, YYYY-MM-DD) [agent_id] <content> | tags: a, b
```

`score` appears only for composite modes. `id` feeds `memory_forget`.

**Corpus `documents`/`all`** runs the merged composite recall. The thoughts
leg (only for `all`) uses pure cosine so the composite re-rank owns freshness.
Output shape:

```
corpus: all (thoughts + documents)

[1] corpus: thoughts | taint: internal | rank: R | sim: S | YYYY-MM-DD | agent: <id> | id: <uuid>
    <content> | tags: a, b

[2] corpus: documents | taint: external | rank: R | sim: S | YYYY-MM-DD | source: <kind> | doc: <id> | path: <vault path>
    <title> - <excerpt>
```

`doc` feeds `memory_read_document`. `No matching memories found.` when empty.

**Degradation:** a down documents backend degrades rather than fails - corpus
`all` returns the thoughts leg plus a note; corpus `documents` with nothing to
show returns an error result. A thoughts-embedding failure fails the whole
call (deliberate asymmetry: the primary corpus must not silently vanish).

### memory_capture (memory:write)

Store a thought in the caller's primary namespace. Inputs: `content` (string,
non-empty), `tags` (string array, `[]` allowed).

Write-time hygiene, scoped to the namespace, cosine over 768-d embeddings:

1. **Dedup**: an existing thought with similarity >= 0.85 created within the
   last 48 hours - the capture is skipped entirely, no row written.
2. **Supersession**: existing thoughts with similarity >= 0.80 older than 48
   hours - up to 3 are soft-deleted, then the new thought is inserted.

These thresholds are a contract shared with every other writer to the same
tables; do not tune them in isolation. Dedup is best-effort under concurrency:
two near-simultaneous captures of the same content can both land (each
capture's check runs before the other's insert commits).

Returns one of:

```
Memory captured successfully (id: <uuid>)
Memory captured successfully (id: <uuid>, superseded N stale thoughts)
Memory skipped - near-duplicate of an existing thought (id: <uuid>, cosine >= 0.85 within 48h).
```

The skip message's id is the existing near-match - pass it to `memory_forget`
to clear the way if the old thought is wrong.

### memory_forget (memory:admin)

Soft-delete a thought by UUID (`deleted = TRUE`; rows are never physically
removed). Namespace-guarded. Idempotent: forgetting an already-deleted or
foreign thought returns "not found or already deleted".

### memory_read_document (memory:read)

Full synced document by id. Inputs: `document_id`, `max_chars` (optional,
default and hard ceiling 20 000 - the ceiling is enforced server-side even if
a caller asks for more, so tainted content cannot talk a model into pulling an
unbounded body).

Returns a provenance header then the Markdown body:

```
id / title / source / external_id / taint / score / event_at / ingested_at /
vault_path / provenance (JSON) / body_source / [truncation note]

<body>
```

`body_source` is `vault` when the canonical Markdown file is readable on this
host, else `chunks` (the body reconstructed from the chunk table - same text,
re-joined). File access resolves strictly under the configured vault root;
path escapes are refused.

### memory_tree (memory:read)

The summarised digest tree over the documents corpus. Nodes are
`<kind>/<yyyy>[/<mm>[/<dd>]]` paths with a lifecycle of
`open -> sealed -> summarised`; only summarised nodes carry a summary and an
embedding. One discriminated input:

- `op: "list"` - children of `path`, or the roots (year nodes) when `path` is
  omitted. One line per node: path, state, window, doc count, last append.
- `op: "read"` - one node's metadata and its summary (or a "still open/sealed"
  note). `path` required.
- `op: "search"` - semantic search over summarised node embeddings (1024-d),
  ranked `similarity * (1 + 0.25 * freshnessDecay(now - lastAppendedAt))` -
  a hotness boost of up to +25% for recently-appended nodes. `query` required;
  `limit` default 7.

### memory_kv_get / memory_kv_set / memory_kv_delete / memory_kv_list

Durable key-value state in the caller's primary namespace
(`memory_kv_store`, primary key `(agent_id, key)`).

- `set` is a versioned upsert (`version` increments on every overwrite).
  Storing `null` stores the JSON value null - it does not delete the key.
- `get` on a missing key is not an error: `No value found for key '<key>'`.
- `delete` (memory:admin) reports whether a row was removed.
- `list` renders `<key>: <json-value>` per line.

## Wire behaviour

One `McpServer` factory serves every transport and both protocol eras; a fresh
instance is built per serving unit with the caller's identity closed over.

- **Modern era (2026-07-28)**: stateless. No `initialize`, no session header.
  Requests carry `_meta` (`io.modelcontextprotocol/protocolVersion`,
  `clientInfo`, `clientCapabilities`) and the `Mcp-Method` / `Mcp-Name` HTTP
  headers. `server/discover` advertises `supportedVersions: ["2026-07-28"]`.
  Results carry `resultType`; list/read results carry `ttlMs` and
  `cacheScope`.
- **Legacy era (<= 2025-11-25)**: the `initialize` handshake, served through
  the SDK's stateless per-request fallback. GET/DELETE (2025 session
  operations) answer 405.
- **stdio**: the opening exchange pins the connection to one era for its
  lifetime.

A minimal stateless call from a shell (the shape the hook scripts use):

```bash
curl -s https://host/memory/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Method: tools/call" -H "Mcp-Name: memory_search" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"memory_search","arguments":{"query":"...","limit":5},
        "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                 "io.modelcontextprotocol/clientInfo":{"name":"hook","version":"1"},
                 "io.modelcontextprotocol/clientCapabilities":{}}}}'
```

## Authentication paths

1. **stdio** - no auth; identity from `[stdio].agent_id`, full scopes.
2. **Static bearer** - `[[auth.tokens]]` entries; secrets resolved from
   `{ env = ... }` / `{ file = ... }` refs at startup (a missing secret fails
   boot); constant-time comparison; each token maps to `agents` + `scopes`.
3. **OAuth 2.1 resource server** - JWTs verified against the issuer's JWKS
   (direct `jwks_uri` or OIDC discovery), issuer and audience asserted (bare
   and trailing-slash audience forms both accepted), scopes read from the
   configured claim, namespaces from the `agents_claim` (default
   `memory_agents`). A token with no namespace claim has no identity.

An uncredentialled HTTP request receives
`401` + `WWW-Authenticate: Bearer resource_metadata="<url>"`; the URL serves
the RFC 9728 protected-resource metadata document. `/health` and the metadata
document are the only unauthenticated routes.

## Error taxonomy

| Situation | Behaviour |
| --- | --- |
| Missing/invalid credential | HTTP 401 + challenge (before the protocol layer) |
| Insufficient scope | `isError` tool result naming the scope |
| Invalid input (empty query, bad UUID) | Schema rejection or `isError` result |
| Embeddings backend down | thoughts leg: `isError`; documents leg: degrade + note |
| Vault file missing | silent fallback to chunk-reconstructed body |
| Unknown id / missing key / empty namespace | normal result stating so (not an error) |

## Repository layout

```text
src/
  config/          strict Zod TOML config, SecretRef indirection
  auth/            identity, scopes, bearer table, OAuth verifier, RFC 9728
  db/              pg pool, MemoryQuery seam, Drizzle copies of vault tables
  embeddings/      one Ollama client, two spaces (768 nomic / 1024 bge-m3)
  domain/          pure ranking, merge, formatting (the frozen text contract)
  repositories/    thoughts + KV (raw SQL), vault reads (Drizzle)
  services/        vault recall, merged recall orchestration
  vault/           read-only vault file access (path-escape guarded)
  tools/           one file per tool + the schema registry
  http.ts          node:http + createMcpHandler (both eras) + auth + RFC 9728
  stdio.ts         serveStdio entry
  cli/migrate.ts   the migration runner CLI
migrations/        the memory tables' DDL - owned here, npm run migrate
```

## Invariants for maintainers

- Two vector spaces (768/1024), never mixed; dimension asserts are
  load-bearing - a wrong-space query vector returns zero rows, not an error.
- The server owns the memory tables' DDL: `migrations/` is the source of
  truth (idempotent, adopt-don't-break), and a vault-table change updates
  `src/db/schema.ts` in the same commit.
- Vault-corpus timestamps are ISO text and compare with `::timestamptz` casts
  on both sides; `memory_thoughts` uses real timestamptz.
- `memory_tree_nodes`' window column is `time_window` (Drizzle property
  `window`).
- The text output formats are frozen; change them only in lockstep with every
  consumer that greps them.
