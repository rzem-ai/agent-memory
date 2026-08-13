variable "name" {
  description = "Container name, and the hostname other containers reach it on."
  type        = string
}

variable "image" {
  description = "pgvector-enabled Postgres image. Pin by digest in production."
  type        = string
  default     = "pgvector/pgvector:0.8.6-pg16-bookworm"
}

variable "network_name" {
  description = "Name of an existing Docker network to attach to."
  type        = string
}

variable "volume_name" {
  description = <<-EOT
    Name of the Docker volume holding the cluster. Set this to an existing
    volume — Compose names them `<project>_<volume>`, e.g.
    `agent-memory_postgres-data` — to adopt data from an earlier deployment
    instead of starting empty. Import it first (see terraform/README.md); the
    volume is `prevent_destroy`.
  EOT
  type        = string
}

variable "database" {
  description = "Database to create on first initialisation. Required, and deliberately not defaulted: a memory server pointed at the wrong database fails silently, returning no results rather than an error."
  type        = string
}

variable "user" {
  description = "Role created on first initialisation."
  type        = string
  default     = "agent_user"
}

variable "password" {
  description = "Password for that role. Held in state — encrypt state."
  type        = string
  sensitive   = true
}

variable "published_port" {
  description = "Host port to publish Postgres on, or null to keep it reachable only from the Docker network. Null is the right answer unless you need psql from the host."
  type        = number
  default     = null
}

variable "publish_ip" {
  description = "Host interface to publish on when `published_port` is set."
  type        = string
  default     = "127.0.0.1"
}

variable "restart_policy" {
  description = "Docker restart policy."
  type        = string
  default     = "unless-stopped"
}

variable "memory_mb" {
  description = "Memory limit in MiB. Null means unlimited."
  type        = number
  default     = null
}

variable "wait_timeout_seconds" {
  description = "How long to wait for the first healthy report. First boot runs initdb."
  type        = number
  default     = 180
}

variable "labels" {
  description = "Extra container labels."
  type        = map(string)
  default     = {}
}
