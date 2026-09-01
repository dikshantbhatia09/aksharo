output "instance_identifier" {
  description = "RDS instance identifier, as the PITR runbook needs it."
  value       = aws_db_instance.this.identifier
}

output "instance_arn" {
  description = "RDS instance ARN."
  value       = aws_db_instance.this.arn
}

output "endpoint" {
  description = "host:port of the writer endpoint."
  value       = aws_db_instance.this.endpoint
}

output "address" {
  description = "Hostname of the writer endpoint."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "PostgreSQL port."
  value       = aws_db_instance.this.port
}

output "database_name" {
  description = "Initial database name."
  value       = aws_db_instance.this.db_name
}

output "master_username" {
  description = "Master user name. The password is in the Secrets Manager secret below."
  value       = aws_db_instance.this.username
}

output "master_user_secret_arn" {
  description = "Secrets Manager secret holding the RDS-managed, RDS-rotated master password. The bootstrap script reads it and writes DATABASE_URL into SSM; Terraform never handles the value."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "read_replica_endpoint" {
  description = "host:port of the read replica, or null when create_read_replica is false."
  value       = var.create_read_replica ? aws_db_instance.replica[0].endpoint : null
}

output "security_group_id" {
  description = "Security group in front of the instance."
  value       = aws_security_group.this.id
}

output "kms_key_arn" {
  description = "KMS key encrypting storage, backups and Performance Insights."
  value       = aws_kms_key.this.arn
}

output "allowed_extensions" {
  description = "Extensions CREATE EXTENSION may install (rds.allowed_extensions). Includes `vector` for audio_assets.embedding (A03, decision D44)."
  value       = var.allowed_extensions
}

output "parameter_group_name" {
  description = "Parameter group applied to the instance and to the read replica."
  value       = aws_db_parameter_group.this.name
}

output "backup_retention_days" {
  description = "The point-in-time-recovery window, in days. Quoted verbatim by docs/runbooks/restore-from-pitr.md and by the privacy notice."
  value       = aws_db_instance.this.backup_retention_period
}
