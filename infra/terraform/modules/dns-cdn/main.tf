# ---------------------------------------------------------------------------
# dns-cdn — Cloudflare records and zone settings for the brand domain.
#
# Hostnames follow BRAND (decision D59, CONTRACTS section 0): aksharo.ai for
# marketing, app.aksharo.ai for the studio, api.aksharo.ai for the API. The
# engineering codename `montaj` never appears in a hostname.
#
# Record targets default to a TEST-NET-1 address, which cannot route anywhere,
# so the module is safe to plan before the cluster exists. Point them at the
# real ingress once the load balancer is up (docs/runbooks/deploy.md).
# ---------------------------------------------------------------------------

locals {
  prefix = var.subdomain_prefix == "" ? "" : "${var.subdomain_prefix}-"

  app_hostname = "${local.prefix}app.${var.zone_name}"
  api_hostname = "${local.prefix}api.${var.zone_name}"

  # A hostname target is a CNAME; a literal IPv4 is an A record.
  ingress_record_type = can(cidrhost("${var.ingress_target}/32", 0)) ? "A" : "CNAME"
  apex_record_type    = can(cidrhost("${var.apex_target}/32", 0)) ? "A" : "CNAME"

  is_placeholder = var.ingress_target == "192.0.2.1"
}

resource "cloudflare_dns_record" "app" {
  zone_id = var.zone_id
  name    = local.app_hostname
  type    = local.ingress_record_type
  content = var.ingress_target
  proxied = var.proxied
  ttl     = var.record_ttl
  comment = "Web studio (WEB_ORIGIN). Managed by infra/terraform/modules/dns-cdn.${local.is_placeholder ? " PLACEHOLDER TARGET." : ""}"
}

resource "cloudflare_dns_record" "api" {
  zone_id = var.zone_id
  name    = local.api_hostname
  type    = local.ingress_record_type
  content = var.ingress_target
  proxied = var.proxied
  ttl     = var.record_ttl
  comment = "API (API_ORIGIN). Managed by infra/terraform/modules/dns-cdn.${local.is_placeholder ? " PLACEHOLDER TARGET." : ""}"
}

resource "cloudflare_dns_record" "apex" {
  count = var.manage_apex ? 1 : 0

  zone_id = var.zone_id
  name    = var.zone_name
  type    = local.apex_record_type
  content = var.apex_target
  proxied = var.proxied
  ttl     = var.record_ttl
  comment = "Marketing site. Managed by infra/terraform/modules/dns-cdn."
}

resource "cloudflare_dns_record" "www" {
  count = var.manage_apex ? 1 : 0

  zone_id = var.zone_id
  name    = "www.${var.zone_name}"
  type    = "CNAME"
  content = var.zone_name
  proxied = var.proxied
  ttl     = var.record_ttl
  comment = "Redirects to the apex. Managed by infra/terraform/modules/dns-cdn."
}

# --- mail-spoofing defence -------------------------------------------------
# The domain does not send mail from this zone. Publishing a null MX plus a
# reject-everything SPF and DMARC costs nothing and removes an easy phishing
# vector against our own users (THREAT-MODEL T3, device-code phishing).

resource "cloudflare_dns_record" "null_mx" {
  count = var.manage_email_security_records ? 1 : 0

  zone_id  = var.zone_id
  name     = var.zone_name
  type     = "MX"
  content  = "."
  priority = 0
  ttl      = 3600
  comment  = "Null MX (RFC 7505): this domain accepts no mail."
}

resource "cloudflare_dns_record" "spf" {
  count = var.manage_email_security_records ? 1 : 0

  zone_id = var.zone_id
  name    = var.zone_name
  type    = "TXT"
  content = "\"v=spf1 -all\""
  ttl     = 3600
  comment = "SPF: nothing is authorised to send mail as this domain."
}

resource "cloudflare_dns_record" "dmarc" {
  count = var.manage_email_security_records ? 1 : 0

  zone_id = var.zone_id
  name    = "_dmarc.${var.zone_name}"
  type    = "TXT"
  content = "\"v=DMARC1; p=reject; rua=mailto:${var.dmarc_report_email}; aspf=s; adkim=s\""
  ttl     = 3600
  comment = "DMARC: reject anything that fails alignment."
}

resource "cloudflare_dns_record" "extra" {
  for_each = var.extra_records

  zone_id = var.zone_id
  name    = each.value.name
  type    = each.value.type
  content = each.value.content
  proxied = each.value.proxied
  ttl     = each.value.ttl
  comment = each.value.comment
}

# --- zone settings ---------------------------------------------------------

resource "cloudflare_zone_setting" "always_use_https" {
  count = var.manage_zone_settings ? 1 : 0

  zone_id    = var.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "ssl" {
  count = var.manage_zone_settings ? 1 : 0

  zone_id    = var.zone_id
  setting_id = "ssl"
  # "strict" means Cloudflare validates the origin certificate. "flexible" would
  # leave the Cloudflare-to-origin hop in plaintext.
  value = "strict"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  count = var.manage_zone_settings ? 1 : 0

  zone_id    = var.zone_id
  setting_id = "min_tls_version"
  value      = var.min_tls_version
}

resource "cloudflare_zone_setting" "tls_1_3" {
  count = var.manage_zone_settings ? 1 : 0

  zone_id    = var.zone_id
  setting_id = "tls_1_3"
  value      = "on"
}

resource "cloudflare_zone_setting" "automatic_https_rewrites" {
  count = var.manage_zone_settings ? 1 : 0

  zone_id    = var.zone_id
  setting_id = "automatic_https_rewrites"
  value      = "on"
}

resource "cloudflare_zone_setting" "security_header" {
  count = var.manage_zone_settings ? 1 : 0

  zone_id    = var.zone_id
  setting_id = "security_header"

  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = 31536000
      include_subdomains = true
      preload            = false
      nosniff            = true
    }
  }
}

# Uploads go straight to S3 through a presigned URL, so nothing large ever
# transits the proxy; 100 MB is generous headroom for API payloads.
resource "cloudflare_zone_setting" "max_upload" {
  count = var.manage_zone_settings ? 1 : 0

  zone_id    = var.zone_id
  setting_id = "max_upload"
  value      = 100
}

resource "cloudflare_zone_setting" "websockets" {
  count = var.manage_zone_settings ? 1 : 0

  zone_id    = var.zone_id
  setting_id = "websockets"
  # CONTRACTS section 7: the realtime gateway and the bridge relay are both
  # WebSocket transports through this zone.
  value = "on"
}
