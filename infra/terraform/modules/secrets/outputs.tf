output "parameter_path_prefix" {
  description = "SSM path every CONTRACTS section 1 parameter sits under. The Helm chart's ExternalSecret reads from here."
  value       = local.path_prefix
}

output "parameter_names" {
  description = "Contract variable name to full SSM parameter name, for all 31 CONTRACTS section 1 variables."
  value = {
    for name, _ in local.contract_parameters :
    name => "${local.path_prefix}/${name}"
  }
}

output "contract_variables" {
  description = "Sorted list of the contract variables this module manages. The infra-validate CI job diffs it against docs/CONTRACTS.md section 1 (acceptance criterion 2)."
  value       = sort(keys(local.contract_parameters))
}

output "human_supplied_variables" {
  description = "The [H] parameters: created as placeholders, filled in by a human, never touched by Terraform again."
  value       = sort(keys(local.human_parameters))
}

output "kms_key_arn" {
  description = "KMS key encrypting the SecureString parameters."
  value       = aws_kms_key.this.arn
}

output "kms_key_alias" {
  description = "Alias of the secrets KMS key."
  value       = aws_kms_alias.this.name
}

output "read_policy_arn" {
  description = "IAM policy granting read plus decrypt on this environment's parameters."
  value       = aws_iam_policy.read.arn
}

output "external_secrets_role_arn" {
  description = "IRSA role for the external-secrets controller, or null when no OIDC provider was supplied. Goes into the chart's serviceAccount annotation."
  value       = var.oidc_provider_arn != "" ? aws_iam_role.external_secrets[0].arn : null
}
