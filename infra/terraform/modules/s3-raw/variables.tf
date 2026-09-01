variable "bucket_name" {
  description = "Bucket name. Global namespace, so include the environment (for example \"montaj-raw-staging\")."
  type        = string
}

variable "residency_region" {
  description = "The region the bucket must be in. THREAT-MODEL T24 and 05 section 9 pin raw media to ap-south-1; the module refuses anything else unless the caller consciously overrides this variable."
  type        = string
  default     = "ap-south-1"
}

variable "web_origins" {
  description = "Origins allowed to run a presigned browser upload against this bucket: the value of WEB_ORIGIN (CONTRACTS section 1) for this environment, plus any preview origin. Never \"*\": a wildcard here lets any page on the internet drive an upload with a leaked presigned URL."
  type        = list(string)

  validation {
    condition     = !contains(var.web_origins, "*")
    error_message = "web_origins must not contain \"*\". List the exact origins that may issue presigned PUTs."
  }

  validation {
    condition     = alltrue([for o in var.web_origins : can(regex("^https?://", o))])
    error_message = "Every entry in web_origins must be a full origin including the scheme, for example https://app.aksharo.ai."
  }
}

variable "cors_max_age_seconds" {
  description = "How long a browser may cache the CORS preflight for this bucket."
  type        = number
  default     = 3600
}

variable "noncurrent_version_expiration_days" {
  description = "Days a non-current object version survives after being overwritten or delete-marked. Fixed at 7 by decision D35 and D47: deletion has to be real, and a versioned bucket that keeps old versions forever silently keeps deleted user media forever."
  type        = number
  default     = 7
}

variable "abort_incomplete_multipart_days" {
  description = "Days before an abandoned multipart upload is aborted and its parts deleted. Fixed at 1: multipart parts are invisible in the console and are billed like any other storage."
  type        = number
  default     = 1
}

variable "purge_tag_key" {
  description = "Object tag key the API sets when a raw object has no live job left. Paired with purge_tag_value it drives the 7-day purge in 05 section 9 (\"raw uploads purge 7 days after the last job\"). Tag-driven rather than blanket, because a lifecycle rule cannot know when the last job finished."
  type        = string
  default     = "montaj:lifecycle"
}

variable "purge_tag_value" {
  description = "Object tag value that marks a raw object as purgeable."
  type        = string
  default     = "purge"
}

variable "purge_after_days" {
  description = "Days after tagging before a raw object is deleted. 7 per 05 section 9."
  type        = number
  default     = 7
}

variable "backstop_expiration_days" {
  description = "Safety net: delete any raw object this old regardless of tags, so a bug in the tagging path cannot leave user media in the bucket forever. 0 disables the rule. Must be comfortably longer than the longest sold project retention (365 days)."
  type        = number
  default     = 400

  validation {
    condition     = var.backstop_expiration_days == 0 || var.backstop_expiration_days > 365
    error_message = "backstop_expiration_days must be 0 (disabled) or greater than 365, the longest sold project retention."
  }
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for SSE-KMS. Empty string uses SSE-S3 (AES256) instead, which is still encryption at rest but without a key you control or can audit."
  type        = string
  default     = ""
}

variable "log_bucket_name" {
  description = "Existing bucket to receive S3 server access logs. Empty string disables access logging."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags merged into every resource."
  type        = map(string)
  default     = {}
}
