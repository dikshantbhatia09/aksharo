variable "name" {
  description = "Identifier prefix (for example \"montaj-staging\")."
  type        = string
}

variable "vpc_id" {
  description = "VPC the instance lives in."
  type        = string
}

variable "database_subnet_ids" {
  description = "Subnets with no default route, one per availability zone."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups permitted to open TCP 5432. In practice: the EKS node group and the EKS cluster security group. Nothing else, ever."
  type        = list(string)
}

variable "engine_version" {
  description = "PostgreSQL version. Pinned to a 16.x release because CONTRACTS and the Prisma schema target PostgreSQL 16."
  type        = string
  default     = "16.10"

  validation {
    condition     = startswith(var.engine_version, "16.")
    error_message = "engine_version must be a 16.x release: the data model targets PostgreSQL 16."
  }
}

variable "instance_class" {
  description = "RDS instance class. db.m7g.* is Graviton: cheaper per vCPU than the Intel equivalent at the same memory."
  type        = string
}

variable "allocated_storage_gb" {
  description = "Initial gp3 storage in GiB."
  type        = number
  default     = 100
}

variable "max_allocated_storage_gb" {
  description = "Ceiling for storage autoscaling in GiB. 0 disables autoscaling."
  type        = number
  default     = 500
}

variable "multi_az" {
  description = "Synchronous standby in a second availability zone. Roughly doubles the instance cost; prod only."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "Automated-backup retention in days. This IS the point-in-time-recovery window: docs/runbooks/restore-from-pitr.md can only reach back this far, and the privacy commitment in 05 section 9 depends on the number being documented."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be between 1 and 35. 0 would disable point-in-time recovery entirely."
  }
}

variable "backup_window" {
  description = "Daily backup window in UTC. Default is 18:30-19:30 UTC, which is 00:00-01:00 IST: the quietest hour for an India-first product."
  type        = string
  default     = "18:30-19:30"
}

variable "maintenance_window" {
  description = "Weekly maintenance window in UTC (Sunday 19:30-20:30 UTC = Monday 01:00-02:00 IST)."
  type        = string
  default     = "sun:19:30-sun:20:30"
}

variable "deletion_protection" {
  description = "Refuse to delete the instance through the API. Always true in prod."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy. Only ever true for a throwaway environment."
  type        = bool
  default     = false
}

variable "performance_insights_retention_days" {
  description = "Performance Insights retention. 7 is the free tier; 465 is the paid long-term tier."
  type        = number
  default     = 7
}

variable "monitoring_interval_seconds" {
  description = "Enhanced monitoring granularity in seconds. 0 disables it."
  type        = number
  default     = 60
}

variable "create_read_replica" {
  description = "Create an in-region read replica. 05 section 10 puts read traffic (admin views, the daily COGS rollup) on a replica behind PgBouncer."
  type        = bool
  default     = false
}

variable "read_replica_instance_class" {
  description = "Instance class for the read replica. Empty string reuses instance_class."
  type        = string
  default     = ""
}

variable "database_name" {
  description = "Initial database name. DATABASE_URL in CONTRACTS section 1 points at this."
  type        = string
  default     = "montaj"
}

variable "master_username" {
  description = "Master user name. The password is never in Terraform: manage_master_user_password puts an AWS-rotated secret in Secrets Manager instead (THREAT-MODEL T21)."
  type        = string
  default     = "montaj_admin"
}

variable "allowed_extensions" {
  description = <<-EOT
    Extensions `CREATE EXTENSION` may install, written to the RDS-specific
    `rds.allowed_extensions` parameter. An explicit list (rather than the RDS
    default of `*`) means a compromised application role cannot install an
    extension that widens its own reach.

    `vector` is mandatory: `audio_assets.embedding` is `vector(512)` with an HNSW
    index (A03, decision D44), and the first migration opens with
    `CREATE EXTENSION IF NOT EXISTS vector`. pgvector needs no entry in
    shared_preload_libraries — it is a plain extension available on RDS
    PostgreSQL 15.2 and later — so listing it here is the whole requirement.
  EOT

  type = list(string)

  default = [
    "vector",             # pgvector: audio_assets.embedding vector(512), HNSW (A03, D44)
    "pg_stat_statements", # query latency panels and the slow-query runbook step
    "pgcrypto",           # gen_random_uuid, digest
    "uuid-ossp",          # legacy uuid generation, kept for portability
    "pg_trgm",            # trigram search over transcripts and project names
    "btree_gin",          # composite GIN indexes on (workspace_id, jsonb)
    "citext",             # case-insensitive email
    "unaccent",           # accent-insensitive search over Indic transliterations
  ]

  validation {
    condition     = contains(var.allowed_extensions, "vector")
    error_message = "\"vector\" must stay in allowed_extensions: the first migration creates audio_assets.embedding as vector(512) and will fail without pgvector."
  }

  validation {
    condition     = contains(var.allowed_extensions, "pg_stat_statements")
    error_message = "\"pg_stat_statements\" must stay in allowed_extensions: it is preloaded by shared_preload_libraries and the dashboards depend on it."
  }
}

variable "hnsw_maintenance_work_mem_kb" {
  description = "maintenance_work_mem in kilobytes. An HNSW build on pgvector is memory-hungry: a graph that does not fit spills to disk and the build goes from minutes to hours. 1 GiB is a reasonable floor for a 512-dimension index; raise it on a larger instance."
  type        = number
  default     = 1048576
}

variable "parameters" {
  description = "Extra PostgreSQL parameters merged over the module defaults. Key is the parameter name; apply_method is \"immediate\" or \"pending-reboot\". Merged last, so it can override anything above."
  type = map(object({
    value        = string
    apply_method = optional(string, "immediate")
  }))
  default = {}
}

variable "tags" {
  description = "Tags merged into every resource."
  type        = map(string)
  default     = {}
}
