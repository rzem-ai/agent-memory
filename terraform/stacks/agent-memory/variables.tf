# ---------------------------------------------------------------------------
# Where to deploy
# ---------------------------------------------------------------------------

variable "docker_host" {
  description = <<-EOT
    Docker daemon endpoint. Null uses the local daemon via the environment
    (`DOCKER_HOST`, or the default socket). For a remote host use
    `ssh://deploy@memory.internal`, which needs an `ssh` binary and key-based
    auth on the machine running OpenTofu — no daemon port is exposed.
  EOT
  type        = string
  default     = null
}

variable "docker_ssh_opts" {
  description = "Extra ssh arguments when `docker_host` is an ssh:// URL, e.g. [\"-o\", \"StrictHostKeyChecking=yes\", \"-i\", \"/home/me/.ssh/deploy\"]."
  type        = list(string)
  default     = []
}

variable "name_prefix" {
  description = "Prefix for every container and volume name. Change it to run two independent copies on one host."
  type        = string
  default     = "agent-memory"
}

# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

variable "memory_image" {
  description = <<-EOT
    The agent-memory image to deploy. Required and deliberately not defaulted,
    for the same reason the application refuses to default its database name: a
    deployment identity you cannot see in your config is one you cannot audit.

    Pin by digest — `ghcr.io/rzem-ai/agent-memory@sha256:...`. A tag makes
    `tofu plan` report "no changes" while the registry content moves underneath
    you, which is the failure mode this whole approach exists to remove.
  EOT
  type        = string
}

variable "postgres_image" {
  description = "Postgres + pgvector image."
  type        = string
  default     = "pgvector/pgvector:0.8.6-pg16-bookworm"
}

variable "ollama_image" {
  description = "Ollama image."
  type        = string
  default     = "ollama/ollama:0.11.4"
}

# ---------------------------------------------------------------------------
# Exposure
# ---------------------------------------------------------------------------

variable "bind_address" {
  description = <<-EOT
    Host interface the MCP endpoint is published on. Loopback is the safe
    default: bearer tokens over plain HTTP must not leave the machine. Set
    0.0.0.0 only behind a TLS reverse proxy or a host firewall.
  EOT
  type        = string
  default     = "127.0.0.1"
}

variable "published_port" {
  description = "Host port for the MCP endpoint."
  type        = number
  default     = 3010
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

variable "database_name" {
  description = "Database holding both corpora. Required: a server pointed at the wrong database returns no results rather than an error."
  type        = string
}

variable "database_user" {
  description = "Database role. This stack uses one role for both migrating and serving, matching the shipped Compose stack. Splitting them (DDL rights for migration, DML only for serving) is described in docs/DEPLOY.md and is a worthwhile hardening step."
  type        = string
  default     = "agent_user"
}

variable "database_password" {
  description = "Database password. Null generates one, readable afterwards with `tofu output -raw database_password`."
  type        = string
  default     = null
  sensitive   = true
}

variable "database_max_connections" {
  description = "Server-side pool size, per instance."
  type        = number
  default     = 10
}

variable "postgres_volume_name" {
  description = "Data volume name. Null derives one from `name_prefix`. Set it to an existing volume (e.g. `agent-memory_postgres-data`) to adopt data from a Compose deployment."
  type        = string
  default     = null
}

# ---------------------------------------------------------------------------
# Embeddings
# ---------------------------------------------------------------------------

variable "ollama_volume_name" {
  description = "Model volume name. Null derives one from `name_prefix`."
  type        = string
  default     = null
}

variable "ollama_gpus" {
  description = "Value for the Ollama container's `gpus` setting, e.g. \"all\". Null runs on CPU."
  type        = string
  default     = null
}

variable "thoughts_model" {
  description = "Embedding model for the thoughts corpus. 768-d; the width is asserted at query time."
  type        = string
  default     = "nomic-embed-text"
}

variable "thoughts_dimensions" {
  description = "Vector width for the thoughts corpus. Must match the column width in migrations/0001."
  type        = number
  default     = 768
}

variable "documents_model" {
  description = "Embedding model for the documents corpus. 1024-d; a separate vector space from the thoughts corpus."
  type        = string
  default     = "bge-m3"
}

variable "documents_dimensions" {
  description = "Vector width for the documents corpus. Must match the column width in migrations/0002."
  type        = number
  default     = 1024
}

# ---------------------------------------------------------------------------
# Server configuration
# ---------------------------------------------------------------------------

variable "log_level" {
  description = "One of trace, debug, info, warn, error."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["trace", "debug", "info", "warn", "error"], var.log_level)
    error_message = "log_level must be one of: trace, debug, info, warn, error."
  }
}

variable "search_default_mode" {
  description = "Default search mode: recency_weighted, similarity, recent or since."
  type        = string
  default     = "recency_weighted"

  validation {
    condition     = contains(["recency_weighted", "similarity", "recent", "since"], var.search_default_mode)
    error_message = "search_default_mode must be one of: recency_weighted, similarity, recent, since."
  }
}

variable "search_recency_decay_days" {
  description = "Recency decay constant."
  type        = number
  default     = 90
}

variable "search_recency_floor" {
  description = "Floor for the recency multiplier, so an old but highly relevant memory still surfaces."
  type        = number
  default     = 0.1
}

variable "vault_host_dir" {
  description = "Host path of the synced Markdown vault, mounted read-only. Null makes memory_read_document reconstruct bodies from chunks instead."
  type        = string
  default     = null
}

variable "clients" {
  description = <<-EOT
    Static bearer tokens to issue, keyed by client name. One token per client:
    the names make the access log legible, and revoking one is deleting its
    entry here and applying.

    The token values are generated, not configured — read them afterwards with
    `tofu output -json client_tokens`. Rotate one with
    `tofu apply -replace='random_password.client["claude-code"]'`.

    Reads span every namespace listed in `agents`; writes land in the first
    concrete one. `["*"]` is read-only in practice, so list a real namespace
    first if the token should also write.
  EOT
  type = map(object({
    agents = list(string)
    scopes = list(string)
  }))
  default = {
    claude-code = {
      agents = ["default"]
      scopes = ["memory:read", "memory:write", "memory:admin"]
    }
  }

  validation {
    condition = alltrue([
      for c in values(var.clients) : length(setsubtract(c.scopes, ["memory:read", "memory:write", "memory:admin"])) == 0
    ])
    error_message = "scopes may only contain memory:read, memory:write and memory:admin."
  }

  validation {
    condition     = alltrue([for c in values(var.clients) : length(c.agents) > 0 && length(c.scopes) > 0])
    error_message = "every client needs at least one agent namespace and at least one scope."
  }
}

variable "client_token_overrides" {
  description = <<-EOT
    Pre-existing token values, keyed by client name, used instead of a generated
    one. The reason this exists is cutover: when moving a live deployment from
    Compose to OpenTofu, reusing the current token means clients do not have to
    be reconfigured during the switch.
  EOT
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "auth_enabled" {
  description = "Leave true. False makes every HTTP request anonymous with full scopes, which is a development-only setting."
  type        = bool
  default     = true
}

variable "oauth" {
  description = <<-EOT
    OAuth 2.1 resource-server configuration, for IdP-issued JWTs alongside the
    static tokens — required by claude.ai remote connectors. Null keeps OAuth
    off. The application refuses to start if this is enabled while `issuer` or
    `audience` is still an example.com placeholder.
  EOT
  type = object({
    issuer       = string
    audience     = string
    jwks_uri     = optional(string)
    scope_claim  = optional(string, "scope")
    agents_claim = optional(string, "memory_agents")
  })
  default = null
}

# ---------------------------------------------------------------------------
# Resource limits
# ---------------------------------------------------------------------------

variable "memory_server_memory_mb" {
  description = "Memory limit for the MCP server in MiB. It is a thin head over Postgres and Ollama; a few hundred MiB is ample."
  type        = number
  default     = 512
}

variable "postgres_memory_mb" {
  description = "Memory limit for Postgres in MiB. Null means unlimited."
  type        = number
  default     = null
}

variable "ollama_memory_mb" {
  description = "Memory limit for Ollama in MiB. Null means unlimited — a limit that is too low shows up as OOM-killed containers mid-embed."
  type        = number
  default     = null
}
