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

# --- Edge protection (P0-08) ------------------------------------------------

variable "manage_waf" {
  type        = bool
  default     = false
  description = <<-EOT
    Create the WAF, rate-limit and custom rulesets in waf.tf.

    Off by default so the module plans against a zone that does not yet exist
    or sits on a plan without rate limiting (Pro or above). Turning it on is a
    P0 launch gate: proxied DNS alone gives TLS and volumetric DDoS absorption
    and no application-layer control whatsoever.
  EOT
}

variable "account_id" {
  type        = string
  default     = null
  description = "Cloudflare account id. Required only when manage_turnstile is true."
}

variable "manage_turnstile" {
  type        = bool
  default     = false
  description = "Create the Turnstile widget the auth flows challenge with."
}

variable "managed_ruleset_id" {
  type        = string
  default     = "efb7b8c949ac4650a09736fc376e9aee"
  description = <<-EOT
    Cloudflare Managed Ruleset id. A well-known constant, exposed as a variable
    so a zone on a different plan can point at the ruleset it actually has
    rather than failing the apply with an opaque id error.
  EOT
}

variable "owasp_ruleset_id" {
  type        = string
  default     = "4814384a9e5d4991b9815dcfc25d2f1f"
  description = "Cloudflare OWASP Core Ruleset id. Same reasoning as managed_ruleset_id."
}

variable "rate_limit_auth_per_minute" {
  type        = number
  default     = 20
  description = <<-EOT
    Requests per minute per address across login, signup, magic-link, reset and
    verify. Deliberately close to the application's own per-IP budget
    (auth.constants.ts RATE_LIMITS) so the edge sheds the flood and the app
    still owns the per-ACCOUNT limit an address-rotating attacker evades.
  EOT
}

variable "rate_limit_jobs_per_minute" {
  type        = number
  default     = 60
  description = "Upload-init, transcribe and export creation per minute per address."
}

variable "rate_limit_share_per_minute" {
  type        = number
  default     = 120
  description = "Public share-viewer requests per minute per address. Challenged, not blocked: a legitimate viewer reloading must not be locked out."
}

variable "challenge_threat_score" {
  type        = number
  default     = 20
  description = <<-EOT
    Cloudflare threat score above which an auth request is challenged. 0 is
    clean, 100 is worst. 20 challenges hosts Cloudflare already distrusts and
    leaves an ordinary sign-up untouched. Lower it if credential stuffing gets
    through; raise it if real users complain.
  EOT
}

variable "protect_admin_paths" {
  type        = bool
  default     = true
  description = "Block or challenge /admin from outside admin_allowed_cidrs."
}

variable "admin_allowed_cidrs" {
  type        = list(string)
  default     = []
  description = <<-EOT
    Source ranges allowed to reach /admin. Empty means every request is
    challenged instead of blocked, because an empty allow-list that blocked
    everything would lock the operators out of their own console during an
    incident. Fill this in, or put Cloudflare Access in front and drop the rule.
  EOT
}

variable "admin_allowed_countries" {
  type        = list(string)
  default     = null
  description = <<-EOT
    ISO-3166-1 alpha-2 countries the admin console may be reached from, e.g.
    ["IN"]. Null disables the geo rule. Geo-blocking is a speed bump, not a
    control — it stops opportunistic scanning, not anyone with a VPN.
  EOT
}
