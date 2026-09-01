variable "zone_id" {
  description = "Cloudflare zone id for the apex domain. [H] The zone is created when the domain is registered (Wave 0 item A00-12); Terraform manages records inside it, not the registration."
  type        = string
}

variable "zone_name" {
  description = "Apex domain. aksharo.ai per BRAND in packages/config/src/brand.ts (decision D59). The engineering codename never appears in a hostname."
  type        = string
  default     = "aksharo.ai"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$", var.zone_name))
    error_message = "zone_name must be a bare domain such as aksharo.ai."
  }
}

variable "subdomain_prefix" {
  description = "Prefix in front of every hostname, so a non-production environment gets staging-app.aksharo.ai rather than app.aksharo.ai. Empty string for production."
  type        = string
  default     = ""
}

variable "ingress_target" {
  description = "Hostname or IPv4 the app and api records point at: the ingress load balancer's DNS name once the cluster exists. Until then leave the TEST-NET-1 placeholder, which is guaranteed never to route anywhere real (RFC 5737)."
  type        = string
  default     = "192.0.2.1"
}

variable "manage_apex" {
  description = "Manage the apex record. Production points the apex at the marketing site; a staging environment should leave it alone."
  type        = bool
  default     = false
}

variable "apex_target" {
  description = "Hostname or IPv4 the apex and www records point at (the marketing site). Placeholder until A24 ships."
  type        = string
  default     = "192.0.2.1"
}

variable "proxied" {
  description = "Serve records through the Cloudflare proxy (orange cloud): CDN, TLS termination, WAF and DDoS protection, and the zero-egress path for R2. Turning this off exposes the origin address."
  type        = bool
  default     = true
}

variable "record_ttl" {
  description = "TTL in seconds. Must be 1 (\"automatic\") for proxied records; Cloudflare rejects anything else."
  type        = number
  default     = 1
}

variable "manage_zone_settings" {
  description = "Manage zone-level TLS and security settings. Set false when the zone is shared with something outside this Terraform state."
  type        = bool
  default     = true
}

variable "min_tls_version" {
  description = "Minimum TLS version accepted at the edge."
  type        = string
  default     = "1.2"
}

variable "manage_email_security_records" {
  description = "Publish the null-MX, SPF and DMARC records that stop the domain being used to spoof mail. Only for a domain that does not send mail from this zone; set false once a real mail provider is configured."
  type        = bool
  default     = true
}

variable "dmarc_report_email" {
  description = "Mailbox receiving DMARC aggregate reports."
  type        = string
  default     = "security@aksharo.ai"
}

variable "extra_records" {
  description = "Additional records: domain verification tokens, a status page, a docs host. Key is a stable label used as the resource key."
  type = map(object({
    name    = string
    type    = string
    content = string
    proxied = optional(bool, false)
    ttl     = optional(number, 1)
    comment = optional(string, "")
  }))
  default = {}
}
