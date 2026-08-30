output "container_id" {
  description = "ID of the server container."
  value       = docker_container.this.id
}

output "container_name" {
  description = "Name of the server container, which is also its DNS name on the attached network."
  value       = docker_container.this.name
}

output "bootstrap_exit_code" {
  description = "Exit code of the bootstrap job, or null when no bootstrap was configured."
  value       = var.bootstrap == null ? null : docker_container.bootstrap[0].exit_code
}

output "published_endpoints" {
  description = "Host-side addresses the server was published on."
  value       = [for p in var.published_ports : "${p.ip}:${p.external}"]
}
