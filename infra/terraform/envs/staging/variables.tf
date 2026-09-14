# ---------------------------------------------------------------------------
# Staging inputs.
#
# Everything that describes the SHAPE of the environment (region, CIDRs, sizes,
# retention) has a default here, so the environment is reviewable from git alone.
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
  description = "CIDRs allowed to reach the public Kubernetes API endpoint: office, VPN and the CI egress range. [H] Leaving this at 0.0.0.0/0 means the API server is reachable from the whole internet (still IAM-authenticated, but it should not be)."
  type        = list(string)
  default     = ["0.0.0.0/0"]
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
  default     = "staging"
}

variable "availability_zones" {
  description = "Availability zones. Two is enough for staging; prod uses three."
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b"]
}

variable "vpc_cidr" {
  description = "VPC CIDR. Staging and prod use different ranges so the two can be peered later without renumbering."
  type        = string
  default     = "10.20.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDRs, one per availability zone."
  type        = list(string)
  default     = ["10.20.0.0/20", "10.20.16.0/20"]
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDRs, one per availability zone. Sized for pod-per-ENI addressing."
  type        = list(string)
  default     = ["10.20.64.0/19", "10.20.96.0/19"]
}

variable "database_subnet_cidrs" {
  description = "Database subnet CIDRs, one per availability zone."
  type        = list(string)
  default     = ["10.20.192.0/24", "10.20.193.0/24"]
}

variable "kubernetes_version" {
  description = "EKS control-plane version. Staging leads prod by at most one minor so an upgrade is proven here first."
  type        = string
  default     = "1.33"
}

variable "postgres_engine_version" {
  description = "PostgreSQL 16 minor version."
  type        = string
  default     = "16.10"
}

variable "postgres_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "postgres_backup_retention_days" {
  description = "Point-in-time-recovery window in days."
  type        = number
  default     = 7
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.small"
}

variable "llm_provider" {
  description = "LLM_PROVIDER (CONTRACTS section 1). Staging defaults to mock so no transcript reaches a third party from a test run (THREAT-MODEL T18)."
  type        = string
  default     = "mock"

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

# --- workload identity (P0-09) ---------------------------------------------

variable "kubernetes_namespace" {
  type        = string
  default     = "montaj"
  description = "Namespace the Helm release runs in. Part of every workload role's trust condition."
}

variable "ses_identity_arn" {
  type        = string
  default     = null
  description = "Verified SES identity the API may send as. Null leaves the SES policy uncreated."
}

variable "ses_configuration_set_arn" {
  type        = string
  default     = null
  description = "Optional SES configuration set carrying the bounce/complaint event destination."
}

variable "mail_from_address" {
  type        = string
  default     = null
  description = "MAIL_FROM. Conditions the SES policy on ses:FromAddress."
}
