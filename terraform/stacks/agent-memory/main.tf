/**
 * The agent-memory stack: one Docker network, Postgres + pgvector, Ollama with
 * its two embedding models, and the MCP server itself — migrated before it
 * serves, health-gated before the apply returns.
 *
 * Read this file as the worked example of the pattern in docs/TERRAFORM.md.
 * The only agent-memory-specific things in it are the config template and the
 * migrate command; everything else is the generic mcp-server module.
 */

provider "docker" {
  host     = var.docker_host
  ssh_opts = var.docker_ssh_opts
}

locals {
  # The image's default config path (see the Dockerfile's CMD).
  config_path        = "/etc/agent-memory/mcp.toml"
  container_port     = 3010
  db_password_file   = "/run/secrets/db-password"
  client_secret_file = { for name in keys(var.clients) : name => "/run/secrets/token-${name}" }

  postgres_volume_name = coalesce(var.postgres_volume_name, "${var.name_prefix}-postgres-data")
  ollama_volume_name   = coalesce(var.ollama_volume_name, "${var.name_prefix}-ollama-data")

  db_password = coalesce(var.database_password, random_password.database.result)

  # A generated token is used unless an existing value was supplied for cutover.
  client_tokens = {
    for name in keys(var.clients) :
    name => coalesce(lookup(var.client_token_overrides, name, null), random_password.client[name].result)
  }

  # Rendered once and uploaded to both the migrate job and the server, so the
  # two can never disagree about which database they are pointed at.
  config_content = templatefile("${path.module}/templates/mcp.toml.tftpl", {
    log_level            = var.log_level
    http_port            = local.container_port
    db_host              = module.postgres.host
    db_port              = module.postgres.port
    db_name              = module.postgres.database
    db_user              = module.postgres.user
    db_password_file     = local.db_password_file
    db_max_connections   = var.database_max_connections
    embeddings_host      = module.ollama.host_url
    thoughts_model       = var.thoughts_model
    thoughts_dimensions  = var.thoughts_dimensions
    documents_model      = var.documents_model
    documents_dimensions = var.documents_dimensions

    search_default_mode       = var.search_default_mode
    search_recency_decay_days = var.search_recency_decay_days
    search_recency_floor      = var.search_recency_floor

    vault_dir = var.vault_host_dir == null ? null : "/srv/vault"

    auth_enabled = var.auth_enabled
    clients = [
      for name, client in var.clients : {
        name        = name
        secret_file = local.client_secret_file[name]
        agents_json = jsonencode(client.agents)
        scopes_json = jsonencode(client.scopes)
      }
    ]

    oauth_enabled = var.oauth != null
    oauth         = var.oauth
  })

  secret_files = merge(
    { (local.db_password_file) = local.db_password },
    { for name, token in local.client_tokens : local.client_secret_file[name] => token },
  )
}

# ---------------------------------------------------------------------------
# Credentials
#
# Generated here so that standing the stack up does not require inventing and
# hand-placing secrets. They live in state — which is why the state file must be
# encrypted or otherwise protected; see terraform/README.md.
# ---------------------------------------------------------------------------

resource "random_password" "database" {
  length = 32
  # The password reaches Postgres through a file and the server through a TOML
  # secret ref, but keeping it alphanumeric avoids quoting surprises for anyone
  # who later pastes it into a connection string.
  special = false
}

resource "random_password" "client" {
  for_each = var.clients

  length  = 32
  special = false
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

resource "docker_network" "this" {
  name = var.name_prefix
}

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

module "postgres" {
  source = "../../modules/pgvector"

  name         = "${var.name_prefix}-postgres"
  image        = var.postgres_image
  network_name = docker_network.this.name
  volume_name  = local.postgres_volume_name

  database  = var.database_name
  user      = var.database_user
  password  = local.db_password
  memory_mb = var.postgres_memory_mb
}

module "ollama" {
  source = "../../modules/ollama"

  name         = "${var.name_prefix}-ollama"
  image        = var.ollama_image
  network_name = docker_network.this.name
  volume_name  = local.ollama_volume_name

  models    = [var.thoughts_model, var.documents_model]
  gpus      = var.ollama_gpus
  memory_mb = var.ollama_memory_mb
}

# ---------------------------------------------------------------------------
# The MCP server
#
# `depends_on` on the module — rather than a variable reference — is what orders
# this after the embedding models are actually present. The database is ordered
# implicitly, through the config template reading module.postgres outputs.
# ---------------------------------------------------------------------------

module "memory" {
  source = "../../modules/mcp-server"

  name         = var.name_prefix
  image        = var.memory_image
  network_name = docker_network.this.name

  files        = { (local.config_path) = local.config_content }
  secret_files = local.secret_files

  bind_mounts = var.vault_host_dir == null ? [] : [{
    host_path      = var.vault_host_dir
    container_path = "/srv/vault"
    read_only      = true
  }]

  published_ports = [{
    internal = local.container_port
    external = var.published_port
    ip       = var.bind_address
  }]

  # The application owns its schema; OpenTofu only invokes the owned runner and
  # fails the apply if it does not exit clean.
  bootstrap = {
    name       = "migrate"
    entrypoint = ["node", "dist/cli/migrate.js"]
    command    = ["--config", local.config_path]
  }

  # The image ships its own HEALTHCHECK against /health, so none is set here.
  wait_for_healthy = true
  memory_mb        = var.memory_server_memory_mb

  depends_on = [module.ollama]
}
