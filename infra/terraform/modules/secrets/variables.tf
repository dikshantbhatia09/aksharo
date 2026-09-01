variable "name" {
  description = "Environment-scoped name prefix (for example \"montaj-staging\")."
  type        = string
}

variable "environment" {
  description = "Environment slug used in the SSM path: /montaj/{environment}/{VAR}."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be lowercase alphanumeric with hyphens, 2 to 16 characters."
  }
}

variable "parameter_prefix" {
  description = "Root of the SSM parameter path. The full name is {parameter_prefix}/{environment}/{VAR}."
  type        = string
  default     = "/montaj"
}

variable "values" {
  description = <<-EOT
    Values Terraform can compute for itself, keyed by CONTRACTS section 1
    variable name — bucket names, endpoints, origins, the Redis URL, the feature
    flag document. Any contract variable absent from this map is created as a
    placeholder parameter that a human fills in once (see the [H] items in
    infra/README.md); Terraform then ignores its value forever, so a real secret
    never enters the state file or a plan output (THREAT-MODEL T21).
  EOT

  type      = map(string)
  default   = {}
  sensitive = true
}

variable "placeholder" {
  description = "Value written to a human-supplied parameter at creation. Chosen so an application that boots against an unfilled parameter fails loudly instead of half-working."
  type        = string
  default     = "REPLACE_ME_SEE_infra_README_H_ITEMS"
}

variable "reader_role_arns" {
  description = "Extra IAM role ARNs allowed to read these parameters (for example a break-glass admin role). The external-secrets IRSA role is created by this module and does not need listing here."
  type        = list(string)
  default     = []
}

variable "oidc_provider_arn" {
  description = "EKS IAM OIDC provider ARN, from the eks module. Empty string skips creating the external-secrets IRSA role (useful when the cluster does not exist yet)."
  type        = string
  default     = ""
}

variable "oidc_provider_url" {
  description = "EKS OIDC issuer URL without the https:// scheme, from the eks module."
  type        = string
  default     = ""
}

variable "external_secrets_namespace" {
  description = "Kubernetes namespace the external-secrets controller runs in."
  type        = string
  default     = "external-secrets"
}

variable "external_secrets_service_account" {
  description = "Kubernetes service account the external-secrets controller runs as."
  type        = string
  default     = "external-secrets"
}

variable "tags" {
  description = "Tags merged into every resource."
  type        = map(string)
  default     = {}
}
