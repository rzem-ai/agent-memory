/**
 * Ollama, plus a run-to-completion job that guarantees the required embedding
 * models are present before anything tries to embed.
 *
 * The model list is load-bearing, not a preference. agent-memory's two corpora
 * live in two vector spaces — 768-d nomic-embed-text for thoughts, 1024-d
 * bge-m3 for document chunks — and the column widths are fixed. A model whose
 * output width differs makes cosine search return nothing at all rather than
 * failing, so the pull is a gate on the deploy: if it cannot fetch the models,
 * the apply fails here instead of at the first user query.
 */

# The daemon does not pull implicitly on container create.
resource "docker_image" "this" {
  name         = var.image
  keep_locally = true
}

resource "docker_volume" "data" {
  name = var.volume_name

  lifecycle {
    # Model blobs are large and slow to refetch; losing them is an outage, not
    # a data loss, but there is no reason to accept either.
    prevent_destroy = true
  }
}

resource "docker_container" "this" {
  name  = var.name
  image = docker_image.this.image_id

  restart = var.restart_policy
  memory  = var.memory_mb

  # Passed straight through to the daemon; "all" exposes every visible GPU.
  # Null keeps Ollama on CPU, which is adequate for embedding-only use.
  gpus = var.gpus

  volumes {
    volume_name    = docker_volume.data.name
    container_path = "/root/.ollama"
  }

  security_opts = ["no-new-privileges:true"]

  networks_advanced {
    name = var.network_name
  }

  dynamic "ports" {
    for_each = var.published_port == null ? [] : [var.published_port]
    content {
      internal = 11434
      external = ports.value
      ip       = var.publish_ip
    }
  }

  healthcheck {
    test         = ["CMD", "ollama", "list"]
    interval     = "10s"
    timeout      = "5s"
    retries      = 30
    start_period = "10s"
  }

  dynamic "labels" {
    for_each = merge({
      "com.rzem.managed-by" = "opentofu"
      "com.rzem.component"  = "ollama"
    }, var.labels)
    content {
      label = labels.key
      value = labels.value
    }
  }

  wait         = true
  wait_timeout = var.wait_timeout_seconds
}

# `command` is ForceNew, so changing the model list re-runs the pull; an
# unchanged list never re-runs it. The first apply downloads several GB and
# blocks for as long as that takes.
resource "docker_container" "models" {
  name  = "${var.name}-models"
  image = docker_image.this.image_id

  entrypoint = ["/bin/sh", "-c"]
  command    = [join(" && ", [for m in var.models : "ollama pull ${m}"])]
  env        = ["OLLAMA_HOST=http://${docker_container.this.name}:11434"]

  start    = true
  attach   = true
  logs     = true
  must_run = false
  rm       = false
  restart  = "no"

  security_opts = ["no-new-privileges:true"]

  networks_advanced {
    name = var.network_name
  }

  dynamic "labels" {
    for_each = merge({
      "com.rzem.managed-by" = "opentofu"
      "com.rzem.component"  = "ollama-models"
    }, var.labels)
    content {
      label = labels.key
      value = labels.value
    }
  }

  lifecycle {
    postcondition {
      condition     = self.exit_code == 0
      error_message = "Model pull exited ${self.exit_code}. Inspect it with: docker logs ${self.name}"
    }
  }
}
