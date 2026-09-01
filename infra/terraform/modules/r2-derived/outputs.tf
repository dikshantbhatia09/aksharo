output "bucket_name" {
  description = "R2_BUCKET_DERIVED (CONTRACTS section 1)."
  value       = cloudflare_r2_bucket.this.name
}

output "location" {
  description = "R2 location hint actually applied."
  value       = cloudflare_r2_bucket.this.location
}

output "s3_api_endpoint" {
  description = "R2_ENDPOINT (CONTRACTS section 1): the account-scoped S3-compatible endpoint the SDK talks to."
  value       = "https://${var.account_id}.r2.cloudflarestorage.com"
}

output "public_base_url" {
  description = "Base URL clients fetch derived objects from, or null when no custom domain is configured."
  value       = var.custom_domain != "" ? "https://${var.custom_domain}" : null
}

output "retention_prefixes" {
  description = "Prefix to retention-days map enforced by lifecycle. Empty under Fable's 2026-09-02 ruling: plan retention is enforced by the scheduler (B16), not by storage lifecycle."
  value       = var.retention_prefixes
}

output "retention_enforced_by" {
  description = "Where plan-based retention actually happens, so a reader of `terraform output` is not left believing the bucket enforces it."
  value       = length(var.retention_prefixes) > 0 ? "r2-lifecycle" : "scheduler (B16)"
}

output "lifecycle_summary" {
  description = "Every lifecycle rule the module created, for the runbooks and for X05 acceptance criterion 3."
  value = {
    multipart_abort_prefixes        = var.multipart_abort_prefixes
    abort_incomplete_multipart_days = var.abort_incomplete_multipart_days
    lifecycle_retention_prefixes    = var.retention_prefixes
  }
}
