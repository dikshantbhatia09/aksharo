# ---------------------------------------------------------------------------
# Outputs are the handover surface between Terraform and everything downstream:
# the Helm values files, the bootstrap script and the runbooks all read them.
# ---------------------------------------------------------------------------

output "environment" {
  description = "Environment slug."
  value       = var.environment
}

output "region" {
  description = "AWS region (residency region for raw media and the database)."
  value       = var.aws_region
}

output "vpc_id" {
  description = "VPC id."
  value       = module.network.vpc_id
}

output "vpc_cidr_block" {
  description = "VPC CIDR. Copy into the chart's networkPolicy.vpcCidr so worker egress to RDS and Redis is allowed and nothing else is."
  value       = module.network.vpc_cidr_block
}

output "nat_public_ips" {
  description = "Egress addresses. Give these to any provider that IP-allow-lists callers."
  value       = module.network.nat_public_ips
}

output "cluster_name" {
  description = "EKS cluster name. `aws eks update-kubeconfig --name <this> --region <region>`."
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = module.eks.cluster_endpoint
}

output "oidc_provider_arn" {
  description = "IRSA provider ARN for workload roles."
  value       = module.eks.oidc_provider_arn
}

output "postgres_endpoint" {
  description = "PostgreSQL writer endpoint."
  value       = module.postgres.endpoint
}

output "postgres_master_user_secret_arn" {
  description = "Secrets Manager secret holding the RDS-managed master password. The bootstrap script reads it to assemble DATABASE_URL; Terraform never does."
  value       = module.postgres.master_user_secret_arn
}

output "postgres_pitr_window_days" {
  description = "Point-in-time-recovery window in days. Quoted by docs/runbooks/restore-from-pitr.md."
  value       = module.postgres.backup_retention_days
}

output "redis_url" {
  description = "REDIS_URL as written to SSM."
  value       = module.redis.redis_url
}

output "s3_raw_bucket" {
  description = "S3_BUCKET_RAW."
  value       = module.s3_raw.bucket_name
}

output "s3_lifecycle_summary" {
  description = "Lifecycle rules in force on the raw bucket (X05 acceptance criterion 3)."
  value       = module.s3_raw.lifecycle_summary
}

output "r2_derived_bucket" {
  description = "R2_BUCKET_DERIVED."
  value       = module.r2_derived.bucket_name
}

output "r2_lifecycle_summary" {
  description = "R2 lifecycle rules in force. Multipart-abort only: plan retention is enforced by the scheduler (B16), not by lifecycle (Fable ruling, 2026-09-02)."
  value       = module.r2_derived.lifecycle_summary
}

output "r2_retention_enforced_by" {
  description = "Where plan-based retention on derived objects actually happens. Reads \"scheduler (B16)\" while retention_prefixes is empty, so nobody mistakes an empty lifecycle for enforced retention."
  value       = module.r2_derived.retention_enforced_by
}

output "web_origin" {
  description = "WEB_ORIGIN."
  value       = module.dns.web_origin
}

output "api_origin" {
  description = "API_ORIGIN."
  value       = module.dns.api_origin
}

output "dns_targets_are_placeholders" {
  description = "True while app. and api. still point at TEST-NET-1."
  value       = module.dns.targets_are_placeholders
}

output "ssm_parameter_path" {
  description = "SSM path holding every CONTRACTS section 1 variable. The chart's ClusterSecretStore reads from here."
  value       = module.secrets.parameter_path_prefix
}

output "contract_parameters" {
  description = "All 31 CONTRACTS section 1 variables and their SSM parameter names (X05 acceptance criterion 2)."
  value       = module.secrets.parameter_names
}

output "human_supplied_parameters" {
  description = "The [H] parameters: created as placeholders and filled in by a human before the environment can serve traffic."
  value       = module.secrets.human_supplied_variables
}

output "external_secrets_role_arn" {
  description = "IRSA role for the external-secrets controller. Goes into the chart's externalSecrets.serviceAccount.roleArn."
  value       = module.secrets.external_secrets_role_arn
}

output "github_deploy_role_arn" {
  description = "Role GitHub Actions assumes to deploy. Not a secret; paste it into the deploy workflow."
  value       = module.github_oidc.role_arn
}

output "s3_access_policy_arn" {
  description = "IAM policy for ws/-scoped access to the raw bucket. Attach to the api and worker IRSA roles."
  value       = module.s3_raw.access_policy_arn
}

output "workload_role_arns" {
  description = "Workload -> IRSA role ARN. Feed into the chart's per-component serviceAccountAnnotations."
  value       = module.workload_irsa.role_arns
}

output "workload_service_account_annotations" {
  description = "Ready-shaped annotations for values-staging.yaml, so no ARN is hand-copied."
  value       = module.workload_irsa.helm_service_account_annotations
}
