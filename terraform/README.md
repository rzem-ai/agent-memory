# terraform/

OpenTofu configuration for deploying agent-memory — and other MCP servers built
the same way — onto a Docker host.

The reasoning behind the layout, the secret handling and the limits is in
[docs/TERRAFORM.md](../docs/TERRAFORM.md). This file is the operator's copy:
what to run, in what order, and what to do when something needs changing.

```
terraform/
├── modules/
│   ├── mcp-server/   generic: any config-file-driven containerised MCP server
│   ├── pgvector/     Postgres + pgvector, and the data volume
│   └── ollama/       Ollama, plus a gate that the embedding models exist
└── stacks/
    └── agent-memory/ the root module that composes the three
```

## Requirements

- [OpenTofu](https://opentofu.org) >= 1.6 (>= 1.7 for state encryption).
- A Docker daemon, local or reachable over SSH.
- An agent-memory image, built and pushed by CI. OpenTofu never builds.

Terraform 1.5.7 — the last MPL-licensed release — will also run this
configuration, minus state encryption. Nothing here uses HCL newer than 1.5.

## First deployment

```bash
cd terraform/stacks/agent-memory
cp terraform.tfvars.example terraform.tfvars   # edit: image digest, database name

# Encrypt state before anything is written to it. The passphrase cannot come
# from a variable — OpenTofu reads this block before variables exist — so it
# arrives through the environment.
export TF_ENCRYPTION='key_provider "pbkdf2" "main" { passphrase = "'"$(cat ~/.config/agent-memory/tofu-passphrase)"'" }
method "aes_gcm" "main" { keys = key_provider.pbkdf2.main }
state { method = method.aes_gcm.main }'

tofu init
tofu plan
tofu apply
```

The first apply pulls two embedding models (several GB) and blocks while it
does. Afterwards:

```bash
curl --fail "$(tofu output -raw health_endpoint)"
tofu output -json client_tokens
```

Register the endpoint with a client using one of those tokens — the token
carries the namespace, so there is nothing else to configure.

## Routine changes

| Change | How |
| --- | --- |
| Deploy a new version | Set `memory_image` to the new digest, `tofu apply`. Migrations re-run, then the server is replaced. |
| Change server config | Edit the variable, `tofu apply`. The rendered TOML changes, which replaces the container. |
| Add a client | Add an entry to `clients`, `tofu apply`, read the new token from outputs. |
| Revoke a client | Delete its entry, `tofu apply`. |
| Rotate one token | `tofu apply -replace='random_password.client["claude-code"]'` |
| Rotate the DB password | Two steps — see below. Not a `-replace` on its own. |
| Back up | `docker exec <prefix>-postgres pg_dump -U agent_user -d memory --format=custom > memory.dump` |

Every one of these replaces a container rather than mutating it, so expect a
few seconds of downtime. Clients are expected to treat a missing memory server
as "no memory this turn" (see docs/DEPLOY.md), which is what makes that
acceptable.

### Rotating the database password

`POSTGRES_PASSWORD_FILE` is read by `initdb` on the *first* start of an empty
volume, and ignored on every start after that. So replacing the password
resource alone gives you a config pointing at a password the database has never
heard of, and the server fails to authenticate. Change it in the database
first, then tell OpenTofu:

```bash
NEW=$(openssl rand -hex 32)
docker exec -i <prefix>-postgres psql -U agent_user -d memory \
  -c "ALTER ROLE agent_user PASSWORD '${NEW}';"
TF_VAR_database_password="${NEW}" tofu apply
```

Setting `database_password` explicitly also takes the generated password out of
play — leave it set from then on.

### When the migrate job fails

A non-zero exit fails the apply through a postcondition, and the stopped
container is kept so you can read it:

```bash
docker logs <prefix>-migrate
```

The postcondition is re-evaluated on later runs, so an apply keeps failing on
the recorded failure until the job is re-run. Once the cause is fixed, force it:

```bash
tofu apply -replace='module.memory.docker_container.bootstrap[0]'
```

## Adopting an existing Compose deployment

The data volumes outlive the tooling that made them. Point the stack at the
existing volume names, import them, then let OpenTofu take over:

```bash
docker compose down          # containers only — do NOT pass --volumes
docker volume ls | grep agent-memory
```

Set the names in `terraform.tfvars`:

```hcl
postgres_volume_name = "agent-memory_postgres-data"
ollama_volume_name   = "agent-memory_ollama-data"
```

**Carry the existing credentials across.** This is the step that bites if you
skip it. An adopted volume already holds an initialised cluster, and Postgres
only ever reads `POSTGRES_PASSWORD_FILE` at `initdb` — so a freshly generated
password would be one the database has never heard of, and the migrate job
would fail to authenticate on the very first apply. Reuse what Compose was
using, from the environment rather than from a file on disk:

```bash
export TF_VAR_database_password="$(cat .secrets/db-password)"
export TF_VAR_client_token_overrides="{\"claude-code\":\"$(cat .secrets/memory-token)\"}"
```

Carrying the bearer token over is optional but worth it: clients keep working
through the cutover instead of needing to be reconfigured. Keep
`TF_VAR_database_password` set for the life of the deployment — dropping it
later reintroduces exactly the same mismatch. To move to a generated password
afterwards, follow
[Rotating the database password](#rotating-the-database-password).

Then import the volumes so OpenTofu adopts rather than creates:

```bash
tofu import 'module.postgres.docker_volume.data' agent-memory_postgres-data
tofu import 'module.ollama.docker_volume.data'   agent-memory_ollama-data
tofu plan    # should show containers to add, and no volume changes
tofu apply
```

To roll back, remove the containers and leave the data where it is. Both
volumes carry `prevent_destroy`, which makes a plain `tofu destroy` *fail
outright* rather than partially proceed — so target the containers:

```bash
tofu destroy \
  -target=module.memory \
  -target=module.postgres.docker_container.this \
  -target=module.ollama.docker_container.this
docker compose up -d
```

Compose picks the same volumes back up. A full teardown, data included, means
deleting the `lifecycle` blocks first — which is the point of them.

## Deploying to a remote host

No daemon port is exposed; the provider tunnels over SSH.

```hcl
docker_host     = "ssh://deploy@memory.internal"
docker_ssh_opts = ["-o", "StrictHostKeyChecking=yes", "-i", "/home/me/.ssh/deploy"]
```

Two things change once the daemon is remote: `vault_host_dir` and any
`bind_mounts` refer to paths on *that* machine, and the SSH key becomes a
deployment credential worth protecting accordingly.

## Adding another MCP server

A second server on the same host is a module block, not a new module — it can
share the network, the database (with its own `database_name`) and Ollama:

```hcl
module "some_other_mcp" {
  source = "../../modules/mcp-server"

  name         = "some-other-mcp"
  image        = "ghcr.io/example/some-other-mcp@sha256:..."
  network_name = docker_network.this.name

  files        = { "/etc/some-other/config.toml" = local.other_config }
  secret_files = { "/run/secrets/token" = random_password.other.result }

  published_ports = [{ internal = 8080, external = 3011, ip = var.bind_address }]

  healthcheck = {
    test = ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/health"]
  }
}
```

What that server has to provide to fit is listed in
[docs/TERRAFORM.md](../docs/TERRAFORM.md#the-contract-a-server-has-to-meet).

## What is not here

- **Building images.** CI builds, scans and pushes; OpenTofu consumes a digest.
- **The host itself.** Docker, the firewall, TLS termination and DNS are
  outside this stack. On a cloud host they belong in a separate root module
  that runs before this one.
- **Schema.** `migrations/` owns the memory tables' DDL and the migrate CLI
  applies it. OpenTofu invokes that runner and fails the apply if it exits
  non-zero; it never models a table itself.
