/**
 * One containerised MCP server: an optional run-to-completion bootstrap job,
 * then the server itself, both from the same image and the same rendered
 * config.
 *
 * The module is deliberately generic. It assumes only what almost every
 * self-hosted MCP server already is:
 *
 *   - one image running one foreground process;
 *   - configured by a file at a known path, with credentials referenced *from*
 *     that file rather than embedded in it;
 *   - a health check that says whether it is serving;
 *   - optionally, a one-shot command (migrate, seed, warm) that must succeed
 *     before traffic arrives.
 *
 * Nothing here knows what agent-memory is. Adding a second MCP server to a host
 * is another `module` block, not another module.
 */

# The daemon does not pull implicitly on container create — an image that is not
# already local is a "No such image" failure at apply time. This resource is the
# pull, and because the container references its resolved ID rather than the
# name, a tag that moves in the registry becomes a visible container replacement
# rather than a silent no-op.
resource "docker_image" "this" {
  count = var.pull_image ? 1 : 0

  name = var.image

  # Removing the image on destroy would force a re-pull on the next apply and
  # break any other container sharing it.
  keep_locally = true
}

locals {
  image_ref = var.pull_image ? docker_image.this[0].image_id : var.image

  env_list           = [for k, v in var.env : "${k}=${v}"]
  bootstrap_env_list = var.bootstrap == null ? [] : [for k, v in merge(var.env, var.bootstrap.env) : "${k}=${v}"]

  labels = merge({
    "org.opencontainers.image.ref.name" = var.image
    "com.rzem.managed-by"               = "opentofu"
    "com.rzem.component"                = "mcp-server"
  }, var.labels)
}

# ---------------------------------------------------------------------------
# Bootstrap job (optional)
#
# `attach = true` makes the apply block until the process exits and records its
# exit code; the postcondition turns a failed migration into a failed apply
# rather than a healthy-looking server pointed at an unmigrated database.
#
# `image`, `command` and every `upload` are ForceNew, so this container is
# recreated — and the job therefore re-runs — exactly when the deployed version
# or its configuration changes, and never otherwise.
# ---------------------------------------------------------------------------
resource "docker_container" "bootstrap" {
  count = var.bootstrap == null ? 0 : 1

  name  = "${var.name}-${var.bootstrap.name}"
  image = local.image_ref

  entrypoint = var.bootstrap.entrypoint
  command    = var.bootstrap.command
  env        = local.bootstrap_env_list
  user       = var.user

  # Run once, in the foreground, and keep the stopped container so its logs
  # remain inspectable after a failure.
  start    = true
  attach   = true
  logs     = true
  must_run = false
  rm       = false
  restart  = "no"

  read_only     = var.read_only
  tmpfs         = var.tmpfs
  security_opts = ["no-new-privileges:true"]

  capabilities {
    drop = var.cap_drop
    add  = var.cap_add
  }

  networks_advanced {
    name = var.network_name
  }

  dynamic "upload" {
    for_each = var.files
    content {
      file        = upload.key
      content     = upload.value
      permissions = var.file_permissions
    }
  }

  dynamic "upload" {
    for_each = var.secret_files
    content {
      file        = upload.key
      content     = upload.value
      permissions = var.file_permissions
    }
  }

  dynamic "volumes" {
    for_each = var.bind_mounts
    content {
      host_path      = volumes.value.host_path
      container_path = volumes.value.container_path
      read_only      = volumes.value.read_only
    }
  }

  dynamic "labels" {
    for_each = merge(local.labels, { "com.rzem.component" = "mcp-bootstrap" })
    content {
      label = labels.key
      value = labels.value
    }
  }

  lifecycle {
    postcondition {
      condition     = self.exit_code == 0
      error_message = "Bootstrap job exited ${self.exit_code}. Inspect it with: docker logs ${self.name}"
    }
  }
}

# ---------------------------------------------------------------------------
# The server
# ---------------------------------------------------------------------------
resource "docker_container" "this" {
  name  = var.name
  image = local.image_ref

  entrypoint = var.entrypoint
  command    = var.command
  env        = local.env_list
  user       = var.user

  restart      = var.restart_policy
  init         = true
  stop_timeout = var.stop_timeout_seconds

  # Hardening mirrors the shipped compose.yaml and systemd unit: no writable
  # root, no capabilities, no privilege escalation.
  read_only     = var.read_only
  tmpfs         = var.tmpfs
  security_opts = ["no-new-privileges:true"]
  memory        = var.memory_mb

  capabilities {
    drop = var.cap_drop
    add  = var.cap_add
  }

  networks_advanced {
    name    = var.network_name
    aliases = var.network_aliases
  }

  dynamic "ports" {
    for_each = var.published_ports
    content {
      internal = ports.value.internal
      external = ports.value.external
      ip       = ports.value.ip
      protocol = ports.value.protocol
    }
  }

  dynamic "upload" {
    for_each = var.files
    content {
      file        = upload.key
      content     = upload.value
      permissions = var.file_permissions
    }
  }

  dynamic "upload" {
    for_each = var.secret_files
    content {
      file        = upload.key
      content     = upload.value
      permissions = var.file_permissions
    }
  }

  dynamic "volumes" {
    for_each = var.bind_mounts
    content {
      host_path      = volumes.value.host_path
      container_path = volumes.value.container_path
      read_only      = volumes.value.read_only
    }
  }

  dynamic "volumes" {
    for_each = var.volumes
    content {
      volume_name    = volumes.value.volume_name
      container_path = volumes.value.container_path
      read_only      = volumes.value.read_only
    }
  }

  dynamic "healthcheck" {
    for_each = var.healthcheck == null ? [] : [var.healthcheck]
    content {
      test         = healthcheck.value.test
      interval     = healthcheck.value.interval
      timeout      = healthcheck.value.timeout
      retries      = healthcheck.value.retries
      start_period = healthcheck.value.start_period
    }
  }

  dynamic "labels" {
    for_each = local.labels
    content {
      label = labels.key
      value = labels.value
    }
  }

  # A deploy that never reports healthy fails the apply.
  wait         = var.wait_for_healthy
  wait_timeout = var.wait_timeout_seconds

  depends_on = [docker_container.bootstrap]
}
