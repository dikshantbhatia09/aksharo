output "cluster_name" {
  description = "EKS cluster name."
  value       = aws_eks_cluster.this.name
}

output "cluster_arn" {
  description = "EKS cluster ARN."
  value       = aws_eks_cluster.this.arn
}

output "cluster_endpoint" {
  description = "Kubernetes API server endpoint."
  value       = aws_eks_cluster.this.endpoint
}

output "cluster_certificate_authority_data" {
  description = "Base64 CA bundle for the API server, for kubeconfig generation."
  value       = aws_eks_cluster.this.certificate_authority[0].data
}

output "cluster_security_group_id" {
  description = "Security group EKS attached to the control-plane ENIs. Databases allow ingress from this group plus the node group."
  value       = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
}

output "oidc_provider_arn" {
  description = "IAM OIDC provider ARN for IRSA trust policies."
  value       = aws_iam_openid_connect_provider.this.arn
}

output "oidc_provider_url" {
  description = "OIDC issuer URL without the scheme, as IRSA condition keys need it."
  value       = replace(aws_eks_cluster.this.identity[0].oidc[0].issuer, "https://", "")
}

output "node_role_arn" {
  description = "IAM role assumed by every managed node."
  value       = aws_iam_role.node.arn
}

output "node_role_name" {
  description = "IAM role name assumed by every managed node."
  value       = aws_iam_role.node.name
}

output "kms_key_arn" {
  description = "KMS key encrypting Kubernetes secrets at rest."
  value       = aws_kms_key.cluster.arn
}

output "gpu_node_group_enabled" {
  description = "Whether an in-cluster GPU node group exists (decision D15 keeps this false until roughly 150,000 media-minutes a month)."
  value       = var.enable_gpu_node_group
}
