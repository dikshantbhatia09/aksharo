output "replication_group_id" {
  description = "ElastiCache replication-group id."
  value       = aws_elasticache_replication_group.this.replication_group_id
}

output "primary_endpoint_address" {
  description = "Writer endpoint hostname. Every BullMQ producer and worker connects here."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "reader_endpoint_address" {
  description = "Reader endpoint hostname, for read-only consumers such as the queue-depth exporter."
  value       = aws_elasticache_replication_group.this.reader_endpoint_address
}

output "port" {
  description = "Redis port."
  value       = aws_elasticache_replication_group.this.port
}

output "url_scheme" {
  description = "Scheme REDIS_URL must use: rediss when transit encryption is on, redis otherwise."
  value       = var.transit_encryption_enabled ? "rediss" : "redis"
}

output "redis_url" {
  description = "REDIS_URL (CONTRACTS section 1) assembled from the endpoint. No credential is embedded: access is by security group."
  value       = "${var.transit_encryption_enabled ? "rediss" : "redis"}://${aws_elasticache_replication_group.this.primary_endpoint_address}:${aws_elasticache_replication_group.this.port}"
}

output "security_group_id" {
  description = "Security group in front of the replication group."
  value       = aws_security_group.this.id
}

output "kms_key_arn" {
  description = "KMS key encrypting data at rest."
  value       = aws_kms_key.this.arn
}
