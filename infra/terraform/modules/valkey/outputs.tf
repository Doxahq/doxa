output "url" {
  description = "TLS connection URL of the primary endpoint."
  value       = "rediss://${aws_elasticache_serverless_cache.this.endpoint[0].address}:${aws_elasticache_serverless_cache.this.endpoint[0].port}"
}

output "security_group_id" {
  description = "Security group of the cache."
  value       = aws_security_group.this.id
}
