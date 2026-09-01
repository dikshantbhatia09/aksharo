variable "name" {
  description = "Identifier prefix (for example \"montaj-staging\"). ElastiCache replication-group ids are limited to 40 characters."
  type        = string

  validation {
    condition     = length(var.name) <= 32
    error_message = "name must be 32 characters or fewer: the module appends a suffix to the replication-group id."
  }
}

variable "vpc_id" {
  description = "VPC the cluster lives in."
  type        = string
}

variable "database_subnet_ids" {
  description = "Subnets with no default route, one per availability zone."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups permitted to open TCP 6379. In practice: the EKS node group and the EKS cluster security group."
  type        = list(string)
}

variable "engine_version" {
  description = "Redis version. BullMQ requires Redis 6.2 or newer; CONTRACTS section 3 and the local docker-compose stack both pin 7."
  type        = string
  default     = "7.1"

  validation {
    condition     = startswith(var.engine_version, "7.")
    error_message = "engine_version must be a 7.x release to match the queue contract."
  }
}

variable "node_type" {
  description = "ElastiCache node type. cache.m7g.* is Graviton."
  type        = string
}

variable "num_cache_clusters" {
  description = "Total nodes in the replication group, primary included. 1 = no replica (staging); 2 or more enables automatic failover."
  type        = number
  default     = 2

  validation {
    condition     = var.num_cache_clusters >= 1 && var.num_cache_clusters <= 6
    error_message = "num_cache_clusters must be between 1 and 6."
  }
}

variable "multi_az_enabled" {
  description = "Place replicas in other availability zones. Requires num_cache_clusters of at least 2."
  type        = bool
  default     = true
}

variable "snapshot_retention_days" {
  description = "Daily snapshot retention. Queues are not a system of record, but a snapshot is what makes a DLQ replay possible after a total loss (docs/runbooks/dlq-replay.md)."
  type        = number
  default     = 3
}

variable "snapshot_window" {
  description = "Daily snapshot window in UTC (17:30-18:30 UTC = 23:00-00:00 IST)."
  type        = string
  default     = "17:30-18:30"
}

variable "maintenance_window" {
  description = "Weekly maintenance window in UTC."
  type        = string
  default     = "sun:20:30-sun:21:30"
}

variable "transit_encryption_enabled" {
  description = "TLS between clients and nodes. When true, REDIS_URL must use the rediss:// scheme."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the slow log and the engine log."
  type        = number
  default     = 30
}

variable "parameters" {
  description = "Extra Redis parameters merged over the module defaults."
  type        = map(string)
  default     = {}
}

variable "tags" {
  description = "Tags merged into every resource."
  type        = map(string)
  default     = {}
}
