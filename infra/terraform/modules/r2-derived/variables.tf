variable "account_id" {
  description = "Cloudflare account id that owns the bucket."
  type        = string
}

variable "bucket_name" {
  description = "R2 bucket name (for example \"montaj-derived-staging\"). Becomes R2_BUCKET_DERIVED in CONTRACTS section 1."
  type        = string
}

variable "location_hint" {
  description = "R2 location hint. APAC keeps derived objects near Indian users and satisfies the residency statement in 05 section 9 (\"derived objects on R2 with an APAC location hint\")."
  type        = string
  default     = "APAC"

  validation {
    condition     = contains(["APAC", "EEUR", "ENAM", "WEUR", "WNAM", "OC"], var.location_hint)
    error_message = "location_hint must be one of APAC, EEUR, ENAM, WEUR, WNAM, OC."
  }
}

variable "storage_class" {
  description = "Default storage class for new objects. Standard is correct for proxies and exports, which are read within days of being written."
  type        = string
  default     = "Standard"
}

variable "web_origins" {
  description = "Origins allowed to fetch and range-request derived objects from a browser: WEB_ORIGIN for this environment plus any preview origin. Never \"*\"."
  type        = list(string)

  validation {
    condition     = !contains(var.web_origins, "*")
    error_message = "web_origins must not contain \"*\". List the exact origins."
  }
}

variable "cors_max_age_seconds" {
  description = "How long a browser may cache the CORS preflight."
  type        = number
  default     = 3600
}

variable "retention_prefixes" {
  description = <<-EOT
    Map of key prefix to retention in days, for lifecycle-enforced expiry.

    **Empty by design.** Fable's ruling (2026-09-02): the CONTRACTS section 6 key
    layout stays exactly as frozen, and plan-based retention (Free 7 d, Starter
    30 d, Creator 90 d, Studio/Agency 365 d) is enforced by the scheduler in B16,
    not by storage lifecycle.

    The mechanism is kept because R2 lifecycle can only ever match a literal key
    prefix: if a later ADR does move the retention class into the key, turning
    this back on is one map. Until then every entry here would have to be a real
    section 6 prefix, and section 6 has exactly one root — `ws/`.

    See this module's README for the ruling and what it costs.
  EOT

  type    = map(number)
  default = {}

  validation {
    condition     = alltrue([for days in values(var.retention_prefixes) : days > 0])
    error_message = "Every retention period must be at least one day."
  }

  validation {
    # A rule on a prefix no object carries is worse than no rule: it reads as
    # enforcement in a plan review and deletes nothing.
    condition     = alltrue([for prefix in keys(var.retention_prefixes) : startswith(prefix, "ws/")])
    error_message = "Every retention prefix must start with \"ws/\": CONTRACTS section 6 puts every derived key under that root, so any other prefix would match no object at all."
  }
}

variable "multipart_abort_prefixes" {
  description = "Prefixes whose abandoned multipart uploads are aborted. Defaults to the single CONTRACTS section 6 root, which covers every derived object, every export and every font. Unfinished parts are billed storage that does not appear in a bucket listing, so this rule earns its place whatever happens to retention."
  type        = list(string)
  default     = ["ws/"]

  validation {
    condition     = alltrue([for prefix in var.multipart_abort_prefixes : startswith(prefix, "ws/")])
    error_message = "Every prefix must start with \"ws/\" (CONTRACTS section 6)."
  }
}

variable "abort_incomplete_multipart_days" {
  description = "Days before an abandoned R2 multipart upload is aborted."
  type        = number
  default     = 1
}

variable "custom_domain" {
  description = "Public hostname serving this bucket over the Cloudflare CDN (for example \"cdn.aksharo.ai\"). Empty string skips the custom domain, in which case clients use signed S3-API URLs against the account endpoint."
  type        = string
  default     = ""
}

variable "custom_domain_zone_id" {
  description = "Cloudflare zone id for custom_domain. Required when custom_domain is set."
  type        = string
  default     = ""
}

variable "min_tls_version" {
  description = "Minimum TLS version on the custom domain."
  type        = string
  default     = "1.2"
}
