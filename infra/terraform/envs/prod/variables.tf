# ---------------------------------------------------------------------------
# Production inputs.
#
# Everything that describes the SHAPE of the environment (region, CIDRs, sizes,
# retention) has a default here, so the environment is reviewable from git alone.
# Production differs from staging in exactly five ways: three availability zones,
# a NAT gateway per zone, Multi-AZ Postgres with a read replica and a 35-day PITR
# window, a two-node Redis replication group, and no default for the Kubernetes
# API allow-list.
# Only account-specific identifiers have no default; put those in terraform.tfvars
# (gitignored — see terraform.tfvars.example).
# ---------------------------------------------------------------------------

# --- identifiers that must come from tfvars --------------------------------

variable "cloudflare_account_id" {
  description = "Cloudflare account id owning the R2 bucket. [H]"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id for aksharo.ai. [H] Created when the domain is registered (Wave 0 item A00-12)."
  type        = string
}

variable "github_owner" {
  description = "GitHub organisation owning the repository."
  type        = string
  default     = "aksharo"
}

variable "github_repository" {
  description = "Repository name."
  type        = string
  default     = "montaj"
}

variable "kubernetes_api_allowed_cidrs" {
  description = "CIDRs allowed to reach the public Kubernetes API endpoint: office, VPN and the CI egress range. [H] No default in production on purpose: a missing value fails the plan rather than quietly exposing the API server to the internet."
  type        = list(string)

  validation {
    condition     = length(var.kubernetes_api_allowed_cidrs) > 0
    error_message = "kubernetes_api_allowed_cidrs must not be empty."
  }

  validation {
    condition     = !contains(var.kubernetes_api_allowed_cidrs, "0.0.0.0/0")
    error_message = "0.0.0.0/0 is not acceptable in production. List the office, VPN and CI egress ranges."
  }
}

# --- environment shape -----------------------------------------------------

variable "aws_region" {
  description = "AWS region. ap-south-1 (Mumbai) is fixed for raw media and the database by THREAT-MODEL T24 and 05 section 9."
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Environment slug. Appears in the SSM path and in every resource name."
  type        = string
  default     = "prod"
}

variable "availability_zones" {
  description = "Availability zones. Three in production: RDS Multi-AZ, ElastiCache automatic failover and a NAT gateway per zone all want the spread."
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
}

variable "vpc_cidr" {
  description = "VPC CIDR. Staging and prod use different ranges so the two can be peered later without renumbering."
  type        = string
  default     = "10.30.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDRs, one per availability zone."
  type        = list(string)
  default     = ["10.30.0.0/20", "10.30.16.0/20", "10.30.32.0/20"]
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDRs, one per availability zone. Sized for pod-per-ENI addressing."
  type        = list(string)
  default     = ["10.30.64.0/19", "10.30.96.0/19", "10.30.128.0/19"]
}

variable "database_subnet_cidrs" {
  description = "Database subnet CIDRs, one per availability zone."
  type        = list(string)
  default     = ["10.30.192.0/24", "10.30.193.0/24", "10.30.194.0/24"]
}

variable "kubernetes_version" {
  description = "EKS control-plane version. Never ahead of staging: every upgrade is proven there first."
  type        = string
  default     = "1.33"
}

variable "postgres_engine_version" {
  description = "PostgreSQL 16 minor version."
  type        = string
  default     = "16.10"
}

variable "postgres_instance_class" {
  description = "RDS instance class. Graviton, and deliberately not burstable: a t-class instance that exhausts its CPU credits during a transcript burst looks exactly like a database outage."
  type        = string
  default     = "db.m7g.large"
}

variable "postgres_backup_retention_days" {
  description = "Point-in-time-recovery window in days. 35 is the RDS maximum, and the number both the privacy notice and docs/runbooks/restore-from-pitr.md quote."
  type        = number
  default     = 35
}

variable "redis_node_type" {
  description = "ElastiCache node type. Not burstable, for the same reason as the database."
  type        = string
  default     = "cache.m7g.large"
}

variable "llm_provider" {
  description = "LLM_PROVIDER (CONTRACTS section 1). Only ever set to a live provider whose DPA is signed (Wave 0 item A00-06, THREAT-MODEL T18)."
  type        = string
  default     = "anthropic"

  validation {
    condition     = contains(["anthropic", "openai", "mock"], var.llm_provider)
    error_message = "llm_provider must be anthropic, openai or mock."
  }
}

variable "gpu_provider" {
  description = "GPU_PROVIDER (CONTRACTS section 1). See infra/gpu."
  type        = string
  default     = "runpod"

  validation {
    condition     = contains(["runpod", "modal", "replicate", "none"], var.gpu_provider)
    error_message = "gpu_provider must be runpod, modal, replicate or none."
  }
}

variable "feature_flags_json" {
  description = "FEATURE_FLAGS_JSON (CONTRACTS section 1). A JSON object; the admin console overrides at runtime."
  type        = string
  default     = "{}"

  validation {
    condition     = can(jsondecode(var.feature_flags_json))
    error_message = "feature_flags_json must be valid JSON."
  }
}

variable "extra_tags" {
  description = "Tags merged into every resource in this environment."
  type        = map(string)
  default     = {}
}

variable "create_github_oidc_provider" {
  description = "Create the account-level GitHub OIDC provider. An AWS account can hold only one provider per issuer URL, so when staging and prod share an account exactly one of them sets this true and the other passes existing_github_oidc_provider_arn."
  type        = bool
  default     = true
}

variable "existing_github_oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider, used when create_github_oidc_provider is false."
  type        = string
  default     = ""
}
