output "host_url" {
  description = "Base URL other containers on the network use to reach Ollama."
  value       = "http://${docker_container.this.name}:11434"
}

output "container_id" {
  description = "ID of the Ollama container."
  value       = docker_container.this.id
}

output "models" {
  description = "Models this module guarantees are present."
  value       = var.models
}

output "models_job_exit_code" {
  description = "Exit code of the model pull job. Zero is asserted by a postcondition."
  value       = docker_container.models.exit_code
}

output "volume_name" {
  description = "Name of the model volume."
  value       = docker_volume.data.name
}
