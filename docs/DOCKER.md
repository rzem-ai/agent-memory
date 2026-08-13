# Docker deployment

The repository ships one application image and a complete Compose stack. The
application image contains the HTTP server and migration CLI; it does not store
data. Durable state belongs in PostgreSQL and, when Compose manages Ollama, in
named Docker volumes.

## Complete stack with Docker Compose

The default stack starts:

- `postgres`: PostgreSQL 16 with pgvector 0.8.6;
- `ollama`: the embedding service;
- `ollama-models`: a one-shot job that ensures `nomic-embed-text` and `bge-m3`
  are present;
- `migrate`: a one-shot schema migration job;
- `memory`: the authenticated MCP HTTP server.

Create local credentials first:

```bash
cp .env.docker.example .env
openssl rand -hex 32  # use this for POSTGRES_PASSWORD
openssl rand -hex 32  # use this for AGENT_MEMORY_TOKEN
```

Replace both placeholder values in `.env`, then start the stack:

```bash
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs -f memory
```

Compose presents these values to the containers as read-only files under
`/run/secrets`; they are not copied into the image or exposed as container
environment variables.

The first run downloads two embedding models and can take several minutes.
Subsequent runs reuse the `ollama-data` volume. The server is published on
`127.0.0.1:3010` by default:

```bash
curl --fail http://127.0.0.1:3010/health
```

Configure an MCP client with `http://127.0.0.1:3010/mcp` and the bearer token
from `AGENT_MEMORY_TOKEN`.

To stop the containers without deleting data:

```bash
docker compose down
```

To deliberately remove all memory, database, and model data:

```bash
docker compose down --volumes
```

That final command is destructive and cannot be undone unless the PostgreSQL
volume has been backed up.

### Binding beyond localhost

Set `AGENT_MEMORY_BIND=0.0.0.0` only when the host firewall or a TLS reverse
proxy controls access. HTTP authentication is enabled in the Compose config,
but bearer tokens still require TLS when traffic leaves the machine.

The checked-in `docker/mcp.compose.toml` is deliberately non-secret. To change
namespaces, scopes, search settings, or OAuth configuration, copy it to another
ignored TOML file and change the two Compose volume mounts to that file.

### Upgrades and backups

Pull or build the new application version, then recreate the stack:

```bash
docker compose pull
docker compose up --build -d
```

The migration job runs before the new server becomes healthy. Back up the
database before upgrades:

```bash
docker compose exec -T postgres \
  pg_dump -U agent_user -d memory --format=custom > memory.dump
```

Restore into a fresh, stopped application stack with PostgreSQL running:

```bash
docker compose exec -T postgres \
  pg_restore -U agent_user -d memory --clean --if-exists < memory.dump
```

## Standalone application container

Use this mode when PostgreSQL/pgvector and Ollama already run elsewhere. Copy
`mcp.example.toml`, set `[http].host = "0.0.0.0"`, and point the database and
embedding hosts at addresses reachable from inside the container. Keep secret
values as environment references.

Build the image:

```bash
docker build -t agent-memory:local .
```

Apply migrations with a database role allowed to create tables and the vector
extension:

```bash
docker run --rm \
  --network your-network \
  -v "$PWD/mcp.docker.toml:/etc/agent-memory/mcp.toml:ro" \
  -e AGENT_MEMORY_DB_PASSWORD \
  --entrypoint node \
  agent-memory:local \
  dist/cli/migrate.js --config /etc/agent-memory/mcp.toml
```

Run the server with the less-privileged serving credential:

```bash
docker run -d --name agent-memory \
  --restart unless-stopped \
  --read-only --tmpfs /tmp:size=16m,mode=1777 \
  --security-opt no-new-privileges --cap-drop ALL \
  --network your-network \
  -p 127.0.0.1:3010:3010 \
  -v "$PWD/mcp.docker.toml:/etc/agent-memory/mcp.toml:ro" \
  -e AGENT_MEMORY_DB_PASSWORD \
  -e AGENT_MEMORY_TOKEN \
  agent-memory:local
```

On Docker Desktop, a host service is reachable as `host.docker.internal`. On
Linux, add `--add-host host.docker.internal:host-gateway` when a database or
Ollama process runs directly on the host.

## Image contract

- Built on Alpine from a digest-pinned `node:24` base, and scanned in CI: the
  build fails on any CRITICAL or HIGH finding.
- Ships no package manager. `npm`, `npx`, `yarn`, and `corepack` are removed
  from the runtime stage, so nothing in a running container can install code —
  production modules are installed at build time and copied in.
- Runs as the unprivileged `node` user.
- Listens on container port `3010` when the mounted config uses
  `[http].host = "0.0.0.0"`.
- Reads `/etc/agent-memory/mcp.toml` by default.
- Exposes `/health` through an image-level health check.
- Writes logs as JSON lines to stderr.
- Writes no application data to the container filesystem.
- Includes `dist/` and `migrations/`, so the same image can serve and migrate.

For production, pin deployed images by digest and place TLS in front of the
MCP endpoint. Never bake `.env`, TOML files containing values, or secret files
into the image.
