output "url" {
  description = "TLS connection URL of the primary endpoint."
  value       = "rediss://${aws_elasticache_serverless_cache.this.endpoint[0].address}:${aws_elasticache_serverless_cache.this.endpoint[0].port}"
}

output "security_group_id" {
  description = "Security group of the cache."
  value       = aws_security_group.this.id
}

output "cache_name" {
  description = "Name of the serverless cache, the clusterId of its CloudWatch metrics."
  value       = aws_elasticache_serverless_cache.this.name
}

output "max_data_storage_gb" {
  description = "Upper limit of stored data, in GB."
  value       = var.max_data_storage_gb
}

output "max_ecpu_per_second" {
  description = "Upper limit of ElastiCache Processing Units per second."
  value       = var.max_ecpu_per_second
}
