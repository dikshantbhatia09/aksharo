# ---------------------------------------------------------------------------
# r2-derived — Cloudflare R2 bucket for every client-facing derived object.
#
# Decision D35: proxies, 16 kHz and 48 kHz audio, waveforms, thumbnails, exports,
# fonts and model downloads live on R2 because egress there is free, and egress
# (not compute) is what dominates the render bill. Raw uploads stay on S3
# ap-south-1 for residency (module s3-raw).
#
# Retention is NOT enforced here. Fable's ruling (2026-09-02): CONTRACTS section
# 6 keys stay exactly as frozen, so the plan cannot appear in a key prefix, and
# R2 lifecycle can only match a literal prefix. Plan-based retention (7/30/90/365
# days) is the scheduler's job in B16. What remains is the one rule that is both
# expressible and worth having: aborting abandoned multipart uploads under `ws/`.
# See this module's README.
# ---------------------------------------------------------------------------

locals {
  # R2 lifecycle conditions are expressed in seconds, not days.
  seconds_per_day = 86400

  # Empty unless a later ADR moves the retention class into the key; see the
  # retention_prefixes variable.
  retention_rules = [
    for prefix, days in var.retention_prefixes : {
      id     = "retention-${replace(trimsuffix(prefix, "/"), "/", "-")}"
      prefix = prefix
      days   = days
    }
  ]
}

resource "cloudflare_r2_bucket" "this" {
  account_id    = var.account_id
  name          = var.bucket_name
  location      = var.location_hint
  storage_class = var.storage_class
}

resource "cloudflare_r2_bucket_cors" "this" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this.name

  rules = [
    {
      id = "browser-playback-and-download"

      allowed = {
        origins = var.web_origins
        methods = ["GET", "HEAD", "PUT"]
        headers = ["*"]
      }

      # Range and ETag are what make proxy scrubbing and resumable downloads work.
      expose_headers = [
        "ETag",
        "Content-Length",
        "Content-Range",
        "Accept-Ranges",
        "Content-Type",
      ]

      max_age_seconds = var.cors_max_age_seconds
    },
  ]
}

resource "cloudflare_r2_bucket_lifecycle" "this" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this.name

  rules = concat(
    # Aborting abandoned multipart uploads. An upload the browser never finished
    # leaves parts that are billed and do not appear in a listing, so nobody ever
    # notices them.
    [
      for prefix in var.multipart_abort_prefixes : {
        id      = "abort-multipart-${replace(trimsuffix(prefix, "/"), "/", "-")}"
        enabled = true

        conditions = {
          prefix = prefix
        }

        abort_multipart_uploads_transition = {
          condition = {
            type    = "Age"
            max_age = var.abort_incomplete_multipart_days * local.seconds_per_day
          }
        }
      }
    ],
    # Empty by default. Plan retention is the scheduler's job (B16); these rules
    # only exist if a future ADR puts the retention class into the key.
    [
      for rule in local.retention_rules : {
        id      = rule.id
        enabled = true

        conditions = {
          prefix = rule.prefix
        }

        delete_objects_transition = {
          condition = {
            type    = "Age"
            max_age = rule.days * local.seconds_per_day
          }
        }
      }
    ],
  )
}

resource "cloudflare_r2_custom_domain" "this" {
  count = var.custom_domain != "" ? 1 : 0

  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this.name
  domain      = var.custom_domain
  zone_id     = var.custom_domain_zone_id
  enabled     = true
  min_tls     = var.min_tls_version

  lifecycle {
    precondition {
      condition     = var.custom_domain_zone_id != ""
      error_message = "custom_domain_zone_id is required when custom_domain is set."
    }
  }
}
