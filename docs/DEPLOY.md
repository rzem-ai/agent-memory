# Deployment

What the server needs, how to stand it up, and how to keep it running.

For a container image or a complete Docker Compose stack, see
[DOCKER.md](DOCKER.md).

## Infrastructure requirements

| Component | Requirement | Notes |
| --- | --- | --- |
| Node.js | >= 20 | ESM; no native modules, so no rebuild pain |
| PostgreSQL | 16+ with pgvector 0.8+ | HNSW indexes are assumed by the read paths |
| Ollama | reachable over HTTP | two models pulled: `nomic-embed-text` (768-d) and `bge-m3` (1024-d) |
| Reverse proxy | optional | TLS termination + path prefix; the server binds loopback by default |
| Identity provider | optional | any OAuth 2.1 AS with JWKS (e.g. Keycloak), only if `[auth.oauth]` is enabled |
| Vault directory | optional | the synced Markdown tree, when it lives on this host |

Sizing is modest: the server is a thin head over Postgres and Ollama. One
vCPU and a few hundred MB of RAM serve a single-user deployment comfortably;
embedding latency (Ollama) dominates request time. Cold model loads can take
tens of seconds on first use - warm the models after deploy (see smoke test).

### The database schema

**This server owns the memory tables' DDL.** `migrations/` is the source of
truth for both corpora; apply it before first start:

```bash
npm run migrate                     # uses mcp.toml's [database] block
npm run migrate -- --config /etc/agent-memory/mcp.admin.toml   # or an admin variant
```

Every migration is idempotent (`IF NOT EXISTS` / `OR REPLACE`), so the runner
**adopts** a database that already holds the tables (recording the baseline,
changing no rows) and fully creates a fresh one - including the pgvector
extension, all indexes, the `memory_thoughts` touch trigger and the
`memory_match_thoughts()` helper function. Applied files are tracked in
`agent_memory_migrations`.

Two roles are the clean shape:

- **Migration role** (runs `npm run migrate`): CREATE on the schema, and
  ability to `CREATE EXTENSION vector` on first run (superuser or a
  pre-created extension).
- **Serving role** (runs the server): SELECT/INSERT/UPDATE on the
  thoughts-corpus tables, SELECT/INSERT/UPDATE/DELETE on `memory_kv_store`,
  SELECT on the documents-corpus tables. No DDL rights.

Verify after migrating:

```bash
psql -h DB_HOST -U DB_USER -d DB_NAME -c "\dt memory_*"
psql -h DB_HOST -U DB_USER -d DB_NAME -c "SELECT name, applied_at FROM agent_memory_migrations;"
```

### Ollama models

```bash
ollama pull nomic-embed-text   # 768-d, thoughts corpus
ollama pull bge-m3             # 1024-d, documents corpus
```

The dimensions are load-bearing: the vector columns are `vector(768)` and
`vector(1024)`, and the server hard-asserts the returned width. Swapping
either model for one with a different width (or re-pulling a variant that
changes it) makes cosine search silently return nothing - the assert exists
to turn that into a loud error.

## Configuration

All configuration is one TOML file, validated strictly at boot - an unknown
key is a fatal error, not a silent ignore. Start from the checked-in example:

```bash
cp mcp.example.toml /etc/agent-memory/mcp.toml
```

Secrets never go in the TOML. Every credential field is a reference -
`{ env = "VAR" }` or `{ file = "/path" }` - resolved at startup; a reference
that resolves to nothing fails boot. The startup log prints the config with
every secret masked.

Minimum viable config:

```toml
[http]
host = "127.0.0.1"
port = 3010

[database]
host = "db-host"
port = 5432
database = "memory"          # required; no default
user = "agent_user"
password = { env = "AGENT_MEMORY_DB_PASSWORD" }

[embeddings.thoughts]
host = "http://127.0.0.1:11434"
model = "nomic-embed-text"
dimensions = 768

[embeddings.documents]
host = "http://127.0.0.1:11434"
model = "bge-m3"
dimensions = 1024

[auth]
enabled = true

[[auth.tokens]]
name   = "claude-code"
secret = { env = "AGENT_MEMORY_TOKEN_CLAUDE_CODE" }
agents = ["default"]
scopes = ["memory:read", "memory:write", "memory:admin"]
```

Generate strong token values (`openssl rand -hex 32`) and hand each client its
own named token - per-client names make the access log legible and revocation
surgical (delete the block, restart).

Optional blocks:

- `[vault] dir = "/srv/vault"` - when the synced Markdown tree is mounted on
  this host, `memory_read_document` serves original file bodies; without it,
  bodies are reconstructed from chunks (same text, re-joined).
- `[auth.oauth]` - enable to accept IdP-issued JWTs alongside static tokens.
  Point `issuer`/`audience` at your AS and resource identifier; scopes come
  from the `scope` claim, namespaces from the `memory_agents` claim (both
  configurable). Required for claude.ai remote connectors. The example file
  ships `example.com` placeholders for these two, and enabling OAuth while
  either is still a placeholder is a fatal config error - they are also read
  while OAuth is *disabled*, since the RFC 9728 document and the
  `resource_metadata` hint in every 401 challenge are built from them.
- `[stdio] agent_id = "default"` - the namespace stdio callers act as. The
  whole block is optional; the stdio entrypoint exits with a clear error if it
  is missing.

## Installation (systemd, hardened)

```bash
# 1. user + directories
sudo useradd --system --home /srv/agent-memory --shell /usr/sbin/nologin agent-memory
sudo mkdir -p /srv/agent-memory /etc/agent-memory

# 2. code
sudo git clone <repo-url> /srv/agent-memory/current
cd /srv/agent-memory/current
sudo npm install
sudo npm run build        # or: npm run check, to gate on lint+tests too
sudo npm run migrate -- --config /etc/agent-memory/mcp.toml   # see database section

# 3. config + secrets
sudo cp mcp.example.toml /etc/agent-memory/mcp.toml   # edit
sudo tee /etc/agent-memory/agent-memory.env >/dev/null <<'EOF'
AGENT_MEMORY_DB_PASSWORD=...
AGENT_MEMORY_TOKEN_CLAUDE_CODE=...
EOF
sudo chmod 600 /etc/agent-memory/agent-memory.env
sudo chown -R agent-memory:agent-memory /srv/agent-memory /etc/agent-memory

# 4. service
sudo cp systemd/agent-memory-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-memory-mcp
```

The shipped unit is hardened: dedicated user, `ProtectSystem=strict`,
`ProtectHome=true`, `NoNewPrivileges`, empty capability set, config path
read-only. If you set `[vault].dir`, add a `ReadOnlyPaths=` entry for it (the
server only ever reads the vault).

Logs are JSON lines on stderr, so:

```bash
journalctl -u agent-memory-mcp -f
```

## Reverse proxy (nginx)

The server binds loopback; put TLS and the public hostname in front. It
accepts both bare paths (`/mcp`, `/health`) and a `/memory` prefix, so a
path-prefix mount needs no rewriting:

```nginx
location /memory/ {
    proxy_pass http://127.0.0.1:3010;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;          # SSE responses must stream
    proxy_read_timeout 300s;
}
```

`proxy_buffering off` matters: streamed (SSE) responses stall behind a
buffering proxy.

## Smoke test

```bash
# liveness (public)
curl -s https://host/memory/health                              # {"status":"ok"}

# auth surfaces
curl -s https://host/memory/.well-known/oauth-protected-resource | jq .
curl -si https://host/memory/mcp -X POST -d '{}' | grep -i www-authenticate   # 401 challenge

# a real call (also warms the embedding model)
curl -s https://host/memory/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Method: tools/call" -H "Mcp-Name: memory_search" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"memory_search","arguments":{"query":"smoke test","limit":3},
        "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                 "io.modelcontextprotocol/clientInfo":{"name":"smoke","version":"1"},
                 "io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Then register the server in Claude Code (see [the README](../README.md)) and
confirm `tools/list` shows nine tools.

## Connecting clients

Per-project registration, as an alternative to `claude mcp add`:

```json
{
  "mcpServers": {
    "agent-memory": {
      "type": "http",
      "url": "https://your-host/memory/mcp",
      "headers": { "Authorization": "Bearer ${AGENT_MEMORY_TOKEN}" }
    }
  }
}
```

claude.ai's custom connectors expect a public HTTPS endpoint with OAuth. The
server implements the MCP authorisation specification as a resource server:
enable `[auth.oauth]` against your identity provider and claude.ai discovers the
rest through `/.well-known/oauth-protected-resource`.

## Updates

```bash
sudo -u agent-memory /srv/agent-memory/current/scripts/update.sh
```

(git fetch/pull, `npm install`, build, restart the unit.)

## Upgrading to 0003 (vault namespaces)

`npm run migrate` adds `agent_id` to `memory_documents` and `memory_tree_nodes`
and changes no rows. **Before restarting the service**, set in
`/etc/agent-memory/mcp.toml`:

    [vault]
    default_owner = "angus"

naming whichever namespace should own everything ingested so far. Without it,
every existing document is invisible to every non-wildcard credential the
moment the new build starts. The ingestion pipeline is unaffected either way:
rows it writes without an `agent_id` keep belonging to `default_owner`.

## Operational notes

- **Fail-open clients.** Recommend callers time-bound every request and treat
  a down memory server as "no memory this turn", never a hard failure - the
  server can then be restarted at will.
- **Backups.** All durable state is in Postgres (plus the optional vault
  directory, which is a git repository in its own right). Standard `pg_dump`
  of the target database covers the memory corpora; the server itself is
  stateless.
- **Scaling.** The server holds no session state on either protocol era, so
  N instances behind one proxy work without stickiness. The pool size
  (`[database].max_connections`, default 10) is per instance.
- **Token rotation.** Change the secret value in the env file (or the
  referenced file), restart. Old value dies with the process.
- **What to monitor.** `/health` for liveness; time-to-first-byte on a search
  call for Ollama health; Postgres connection count; journal error lines
  (`level >= 40`).
