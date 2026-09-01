output "bucket_name" {
  description = "S3_BUCKET_RAW (CONTRACTS section 1)."
  value       = aws_s3_bucket.this.id
}

output "bucket_arn" {
  description = "Bucket ARN."
  value       = aws_s3_bucket.this.arn
}

output "bucket_regional_domain_name" {
  description = "Regional endpoint host. S3_ENDPOINT is derived from this."
  value       = aws_s3_bucket.this.bucket_regional_domain_name
}

output "s3_endpoint" {
  description = "S3_ENDPOINT (CONTRACTS section 1) for this bucket, region-pinned so a client cannot be redirected out of the residency region."
  value       = "https://s3.${data.aws_region.current.region}.amazonaws.com"
}

output "region" {
  description = "S3_REGION (CONTRACTS section 1)."
  value       = data.aws_region.current.region
}

output "access_policy_arn" {
  description = "IAM policy granting ws/-scoped object access. Attach to the api, worker-media and worker-ai IRSA roles."
  value       = aws_iam_policy.access.arn
}

output "lifecycle_summary" {
  description = "The lifecycle rules in force, for the runbooks and for acceptance criterion 3 of the X05 brief."
  value = {
    abort_incomplete_multipart_days    = var.abort_incomplete_multipart_days
    noncurrent_version_expiration_days = var.noncurrent_version_expiration_days
    tagged_purge_days                  = var.purge_after_days
    tagged_purge_selector              = "${var.purge_tag_key}=${var.purge_tag_value}"
    backstop_expiration_days           = var.backstop_expiration_days
  }
}
