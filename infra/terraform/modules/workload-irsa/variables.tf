variable "name" {
  type        = string
  description = "Name prefix for every role, e.g. montaj-prod. Roles are <name>-<workload>."
}

variable "namespace" {
  type        = string
  description = "Kubernetes namespace the workloads run in. Part of the trust condition."
  default     = "montaj"
}

variable "oidc_provider_arn" {
  type        = string
  description = "EKS OIDC provider ARN: `terraform output oidc_provider_arn` from the eks module."
}

variable "oidc_provider_url" {
  type        = string
  description = "EKS OIDC provider URL, with or without the https:// scheme."
}

variable "workloads" {
  type = map(object({
    # The Kubernetes ServiceAccount this role trusts. The Helm chart names these
    # `<release>-<component>`, e.g. `montaj-api`.
    service_account = string
    description     = string
    # Managed policy ARNs to attach, e.g. the s3-raw module's access_policy_arn.
    policy_arns = optional(list(string), [])
  }))
  description = <<-EOT
    One entry per workload that needs an AWS identity, keyed by the chart's
    component name. Deliberately explicit rather than derived from the chart:
    a workload that gains AWS access should be a reviewed diff in this file,
    not a side effect of adding a component.
  EOT
}

variable "ses_identity_arn" {
  type        = string
  default     = null
  description = "Verified SES identity (domain or address) the API may send as. Null disables the SES policy entirely."
}

variable "ses_configuration_set_arn" {
  type        = string
  default     = null
  description = "Optional SES configuration set, for the bounce/complaint event destination."
}

variable "mail_from_address" {
  type        = string
  default     = null
  description = <<-EOT
    MAIL_FROM. When set, the SES policy is conditioned on `ses:FromAddress`, so a
    compromised API can send as the product and as nothing else.
  EOT
}

variable "ses_sender_workloads" {
  type        = list(string)
  default     = ["api"]
  description = "Workloads that get the SES send policy. Only the API sends mail."
}

variable "canary_bucket_arns" {
  type        = list(string)
  default     = []
  description = <<-EOT
    Buckets the boot-time health canary writes to. Empty disables the policy.
    The API writes one small object, reads it back and deletes it to prove its
    credentials work (apps/api/src/health/health.service.ts).
  EOT
}

variable "canary_prefix" {
  type        = string
  default     = "_montaj-health/"
  description = "Key prefix the canary uses. Must match CANARY_PREFIX in apps/api/src/health/health.service.ts."
}

variable "canary_workloads" {
  type        = list(string)
  default     = ["api"]
  description = "Workloads that run the canary."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags applied to every role and policy."
}
