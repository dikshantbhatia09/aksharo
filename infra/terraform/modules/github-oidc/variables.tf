variable "name" {
  description = "Role name prefix (for example \"montaj-staging\")."
  type        = string
}

variable "github_owner" {
  description = "GitHub organisation or user that owns the repository."
  type        = string
}

variable "github_repository" {
  description = "Repository name, without the owner."
  type        = string
}

variable "create_oidc_provider" {
  description = "Create the account-level GitHub OIDC provider. Exactly one Terraform state in the account should own it; every other environment sets this false and passes existing_oidc_provider_arn."
  type        = bool
  default     = true
}

variable "existing_oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider, used when create_oidc_provider is false."
  type        = string
  default     = ""
}

variable "allowed_subjects" {
  description = <<-EOT
    GitHub OIDC `sub` claims allowed to assume the deploy role. This is the whole
    security boundary of the deploy path: a wildcard here would let any workflow
    in any repository deploy.

    Prefer environment subjects — repo:owner/repo:environment:staging — because a
    GitHub environment can require a reviewer, while a branch subject cannot.
  EOT

  type = list(string)

  validation {
    condition     = length(var.allowed_subjects) > 0
    error_message = "allowed_subjects must not be empty."
  }

  validation {
    condition     = !contains(var.allowed_subjects, "*")
    error_message = "allowed_subjects must not contain a bare \"*\": that would let any GitHub Actions workflow anywhere assume this role."
  }

  validation {
    condition     = alltrue([for s in var.allowed_subjects : startswith(s, "repo:")])
    error_message = "Every subject must start with \"repo:\", for example repo:aksharo/montaj:environment:staging."
  }
}

variable "ecr_repository_arns" {
  description = "ECR repositories the deploy role may push to. Empty list grants no push rights at all."
  type        = list(string)
  default     = []
}

variable "eks_cluster_arns" {
  description = "EKS clusters the deploy role may describe (to build a kubeconfig). Cluster-internal permissions come from the EKS access entry, not from IAM."
  type        = list(string)
  default     = []
}

variable "terraform_state_bucket_arn" {
  description = "S3 bucket holding Terraform state, if CI is allowed to run plans. Empty string withholds state access entirely."
  type        = string
  default     = ""
}

variable "ssm_parameter_path_arn" {
  description = "ARN pattern of SSM parameters the deploy role may read (usually the non-secret ones needed to template a release). Empty string withholds parameter access."
  type        = string
  default     = ""
}

variable "max_session_duration_seconds" {
  description = "Maximum lifetime of a session assumed by CI. One hour is plenty for a deploy and limits the blast radius of a leaked token."
  type        = number
  default     = 3600
}

variable "tags" {
  description = "Tags merged into every resource."
  type        = map(string)
  default     = {}
}
