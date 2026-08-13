output "endpoint" {
  description = "MCP endpoint as reachable from the Docker host."
  value       = "http://${var.bind_address}:${var.published_port}/mcp"
}

output "health_endpoint" {
  description = "Liveness URL."
  value       = "http://${var.bind_address}:${var.published_port}/health"
}

output "client_tokens" {
  description = "Bearer token per client. Read with: tofu output -json client_tokens"
  value       = local.client_tokens
  sensitive   = true
}

output "database_password" {
  description = "Generated (or supplied) database password. Read with: tofu output -raw database_password"
  value       = local.db_password
  sensitive   = true
}

output "postgres_volume_name" {
  description = "Volume holding both corpora — the one thing here worth backing up."
  value       = module.postgres.volume_name
}

output "register_with_claude_code" {
  description = "Ready-to-run registration command. The token is redacted; substitute it from the client_tokens output."
  value = join(" ", [
    "claude mcp add --transport http agent-memory",
    "http://${var.bind_address}:${var.published_port}/mcp",
    "--header \"Authorization: Bearer $AGENT_MEMORY_TOKEN\"",
  ])
}
