variable "name" {
  description = "Container name, and the prefix for every resource this module creates."
  type        = string
}

variable "image" {
  description = <<-EOT
    Fully qualified image reference. Pin by digest in production
    (`ghcr.io/org/server@sha256:...`): the digest is the deployment's identity,
    and changing it is what triggers a redeploy. A moving tag makes `tofu plan`
    show no change while the running code silently differs from the registry.
  EOT
  type        = string
}

variable "pull_image" {
  description = <<-EOT
    Pull `image` from its registry before creating containers. Set false only
    when the image is built on the host and exists nowhere else — `tofu apply`
    then trusts that it is already present.
  EOT
  type        = bool
  default     = true
}

variable "network_name" {
  description = "Name of an existing Docker network to attach to."
  type        = string
}

variable "network_aliases" {
  description = "Extra DNS aliases for this container on that network."
  type        = list(string)
  default     = []
}

variable "files" {
  description = <<-EOT
    Non-secret files to place in the container, keyed by absolute container
    path. This is where the rendered config file goes. Parent directories are
    created automatically. Changing any content replaces the container, which
    is the redeploy mechanism for a config-only change.
  EOT
  type        = map(string)
  default     = {}
}

variable "secret_files" {
  description = <<-EOT
    Credential files, keyed by absolute container path — typically
    `/run/secrets/<name>`. Separated from `files` only so that plan output stays
    readable: both are uploaded identically.

    Values are held in state, so encrypt state (see the stack's `encryption`
    block). To keep a secret out of state entirely, create the file on the host
    out of band and pass it through `bind_mounts` instead.
  EOT
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "file_permissions" {
  description = <<-EOT
    Octal mode for uploaded files. Uploads land root-owned, so the mode must be
    world-readable for an image that drops to an unprivileged user — 0444, not
    0400. Inside a single-process container the file mode is not the boundary;
    the container is.
  EOT
  type        = string
  default     = "0444"
}

variable "bind_mounts" {
  description = <<-EOT
    Host paths to mount, for data the module should not carry in state (an
    externally managed secret file, a read-only content directory such as the
    memory vault). Host paths are resolved by the Docker daemon, so on a remote
    daemon these refer to the remote host's filesystem.
  EOT
  type = list(object({
    host_path      = string
    container_path = string
    read_only      = optional(bool, true)
  }))
  default = []
}

variable "volumes" {
  description = "Named Docker volumes to mount. MCP servers are usually stateless; state belongs in the database."
  type = list(object({
    volume_name    = string
    container_path = string
    read_only      = optional(bool, false)
  }))
  default = []
}

variable "env" {
  description = "Non-secret environment variables. Prefer file-based config and secret refs; env vars are visible to anything that can inspect the container."
  type        = map(string)
  default     = {}
}

variable "entrypoint" {
  description = "Override the image entrypoint. Null keeps the image's own."
  type        = list(string)
  default     = null
}

variable "command" {
  description = "Override the image command. Null keeps the image's own."
  type        = list(string)
  default     = null
}

variable "published_ports" {
  description = <<-EOT
    Ports to publish on the host. Default `ip` is loopback: an MCP server
    speaking bearer tokens over plain HTTP must not be reachable off-host
    without TLS in front of it.
  EOT
  type = list(object({
    internal = number
    external = number
    ip       = optional(string, "127.0.0.1")
    protocol = optional(string, "tcp")
  }))
  default = []
}

variable "healthcheck" {
  description = <<-EOT
    Overrides the image's own HEALTHCHECK. Leave null when the image ships one
    (agent-memory does). A health check is what `wait_for_healthy` waits on, and
    what makes a broken deploy fail the apply instead of leaving a dead
    container behind.
  EOT
  type = object({
    test         = list(string)
    interval     = optional(string, "30s")
    timeout      = optional(string, "5s")
    retries      = optional(number, 3)
    start_period = optional(string, "10s")
  })
  default = null
}

variable "bootstrap" {
  description = <<-EOT
    A one-shot job run to completion before the server container is created —
    schema migrations, seeding, a warm-up call. It runs the same image with the
    same config and secrets, so it needs no separate build.

    The apply fails if it exits non-zero, and it re-runs whenever the image
    digest or the config changes. This is deliberately a *call into the
    application's own tooling*, not schema modelled in HCL: this repository owns
    the memory tables' DDL (see migrations/README.md), and Terraform must not
    become a second writer of it.

    The apply blocks for as long as the job runs, and there is no way to bound
    that from here — keep bootstrap commands short, or run long one-offs (a bulk
    re-embed, a backfill) outside Terraform.
  EOT
  type = object({
    name       = optional(string, "bootstrap")
    entrypoint = optional(list(string))
    command    = optional(list(string))
    env        = optional(map(string), {})
  })
  default = null
}

variable "user" {
  description = "User to run as. Null keeps the image's own (agent-memory's image already drops to `node`)."
  type        = string
  default     = null
}

variable "read_only" {
  description = "Mount the container root filesystem read-only. An MCP server that writes nothing locally should keep this true."
  type        = bool
  default     = true
}

variable "tmpfs" {
  description = "tmpfs mounts, needed when `read_only` is true and the process needs scratch space."
  type        = map(string)
  default     = { "/tmp" = "size=16m,mode=1777" }
}

variable "cap_drop" {
  description = "Linux capabilities to drop."
  type        = list(string)
  default     = ["ALL"]
}

variable "cap_add" {
  description = "Linux capabilities to add back. Should stay empty for an HTTP server on an unprivileged port."
  type        = list(string)
  default     = []
}

variable "memory_mb" {
  description = "Memory limit in MiB. Null means unlimited."
  type        = number
  default     = null
}

variable "restart_policy" {
  description = "Docker restart policy for the server container."
  type        = string
  default     = "unless-stopped"
}

variable "stop_timeout_seconds" {
  description = "Grace period between SIGTERM and SIGKILL on stop."
  type        = number
  default     = 30
}

variable "wait_for_healthy" {
  description = <<-EOT
    Block the apply until the container reports healthy. Requires a health check
    from the image or from `healthcheck` — with neither, this waits out
    `wait_timeout_seconds` and then fails.
  EOT
  type        = bool
  default     = true
}

variable "wait_timeout_seconds" {
  description = "How long to wait for the health check to pass. Generous by default: a first embedding call can load a cold model."
  type        = number
  default     = 300
}

variable "labels" {
  description = "Labels applied to every container this module creates."
  type        = map(string)
  default     = {}
}
