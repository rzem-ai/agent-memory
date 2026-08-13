output "host" {
  description = "Hostname other containers on the network reach the database on."
  value       = docker_container.this.name
}

output "port" {
  description = "Port the database listens on inside the network."
  value       = 5432
}

output "database" {
  description = "Database name."
  value       = var.database
}

output "user" {
  description = "Role name."
  value       = var.user
}

output "volume_name" {
  description = "Name of the data volume, for backup tooling."
  value       = docker_volume.data.name
}

output "container_id" {
  description = "ID of the database container."
  value       = docker_container.this.id
}
