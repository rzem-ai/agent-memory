/**
 * PostgreSQL with pgvector — the durable half of the stack.
 *
 * This module owns the *server*, never the schema. Tables, indexes and
 * functions belong to the application's own migration runner (see
 * migrations/README.md: "this repository owns the memory tables' DDL"), which
 * the mcp-server module invokes as a bootstrap job. There is deliberately no
 * postgresql provider here: a second declarative writer of the same DDL is
 * exactly the drift the migration rules exist to prevent.
 *
 * The data volume is the only thing in the whole stack that must survive a
 * `tofu destroy` unread. Its name is a variable so an existing Compose volume
 * can be adopted rather than recreated empty.
 */

# The daemon does not pull implicitly on container create.
resource "docker_image" "this" {
  name         = var.image
  keep_locally = true
}

resource "docker_volume" "data" {
  name = var.volume_name

  lifecycle {
    # The database is the deployment's memory. Losing it to a routine
    # rename-and-replace is not an acceptable failure mode.
    prevent_destroy = true
  }
}

resource "docker_container" "this" {
  name  = var.name
  image = docker_image.this.image_id

  restart = var.restart_policy
  memory  = var.memory_mb

  env = [
    "POSTGRES_DB=${var.database}",
    "POSTGRES_USER=${var.user}",
    "POSTGRES_PASSWORD_FILE=${local.password_file}",
  ]

  upload {
    file        = local.password_file
    content     = var.password
    permissions = "0444"
  }

  volumes {
    volume_name    = docker_volume.data.name
    container_path = "/var/lib/postgresql/data"
  }

  # Unlike the MCP server, this container cannot run with a read-only root
  # filesystem: the Postgres entrypoint writes its socket, PID file and
  # initdb scratch outside the data volume.
  security_opts = ["no-new-privileges:true"]

  networks_advanced {
    name = var.network_name
  }

  dynamic "ports" {
    for_each = var.published_port == null ? [] : [var.published_port]
    content {
      internal = 5432
      external = ports.value
      ip       = var.publish_ip
    }
  }

  healthcheck {
    test         = ["CMD-SHELL", "pg_isready -U ${var.user} -d ${var.database}"]
    interval     = "5s"
    timeout      = "5s"
    retries      = 20
    start_period = "10s"
  }

  dynamic "labels" {
    for_each = merge({
      "com.rzem.managed-by" = "opentofu"
      "com.rzem.component"  = "postgres"
    }, var.labels)
    content {
      label = labels.key
      value = labels.value
    }
  }

  # Nothing downstream may run until the database answers.
  wait         = true
  wait_timeout = var.wait_timeout_seconds
}

locals {
  password_file = "/run/secrets/postgres-password"
}
