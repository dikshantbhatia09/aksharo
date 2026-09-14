output "role_arns" {
  description = <<-EOT
    Workload name -> IAM role ARN. Feed each into the Helm chart as that
    component's `serviceAccountAnnotations`:

      components:
        api:
          serviceAccountAnnotations:
            eks.amazonaws.com/role-arn: <role_arns["api"]>
  EOT
  value       = { for name, role in aws_iam_role.workload : name => role.arn }
}

output "role_names" {
  description = "Workload name -> IAM role name, for `aws iam simulate-principal-policy`."
  value       = { for name, role in aws_iam_role.workload : name => role.name }
}

output "helm_service_account_annotations" {
  description = <<-EOT
    The annotations block, already shaped for `helm --set-json`. Copy it into
    values-<env>.yaml rather than hand-writing ARNs, so a role rename cannot
    leave a pod silently running with no identity.
  EOT
  value = {
    for name, role in aws_iam_role.workload :
    name => { "eks.amazonaws.com/role-arn" = role.arn }
  }
}

output "ses_policy_arn" {
  description = "The SES send policy, or null when no SES identity was given."
  value       = try(aws_iam_policy.ses_send[0].arn, null)
}

output "health_canary_policy_arn" {
  description = "The object-store canary policy, or null when no canary buckets were given."
  value       = try(aws_iam_policy.health_canary[0].arn, null)
}
