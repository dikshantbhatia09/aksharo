output "role_arn" {
  description = "Deploy role ARN. Goes into the GitHub Actions workflow as role-to-assume; it is not a secret."
  value       = aws_iam_role.deploy.arn
}

output "role_name" {
  description = "Deploy role name."
  value       = aws_iam_role.deploy.name
}

output "oidc_provider_arn" {
  description = "GitHub OIDC provider ARN, whether created here or supplied."
  value       = local.provider_arn
}

output "allowed_subjects" {
  description = "The exact GitHub OIDC subjects permitted to assume the role."
  value       = var.allowed_subjects
}
