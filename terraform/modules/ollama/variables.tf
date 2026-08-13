variable "name" {
  description = "Container name, and the hostname other containers reach it on."
  type        = string
}

variable "image" {
  description = "Ollama image. Pin by digest in production."
  type        = string
  default     = "ollama/ollama:0.11.4"
}

variable "network_name" {
  description = "Name of an existing Docker network to attach to."
  type        = string
}

variable "volume_name" {
  description = "Name of the Docker volume holding model blobs. Point it at an existing volume (Compose: `<project>_ollama-data`) to avoid refetching several GB."
  type        = string
}

variable "models" {
  description = <<-EOT
    Models to pull before the stack is considered up. For agent-memory this is
    exactly `["nomic-embed-text", "bge-m3"]`: 768-d and 1024-d respectively, and
    both widths are asserted by the server at query time.
  EOT
  type        = list(string)
  validation {
    condition     = length(var.models) > 0
    error_message = "At least one model must be listed, or the pull job has nothing to gate on."
  }
}

variable "gpus" {
  description = "Value for the container's `gpus` setting, e.g. \"all\". Null runs on CPU."
  type        = string
  default     = null
}

variable "published_port" {
  description = "Host port to publish Ollama on, or null to keep it network-internal. Ollama has no authentication; null unless you have a reason."
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
  description = "Memory limit in MiB. Null means unlimited. Embedding models need room; a limit that is too low shows up as OOM-killed containers under load."
  type        = number
  default     = null
}

variable "wait_timeout_seconds" {
  description = "How long to wait for Ollama to report healthy."
  type        = number
  default     = 180
}

variable "labels" {
  description = "Extra container labels."
  type        = map(string)
  default     = {}
}
