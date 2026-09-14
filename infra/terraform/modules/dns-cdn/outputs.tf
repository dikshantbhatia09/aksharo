output "app_hostname" {
  description = "Web studio hostname."
  value       = local.app_hostname
}

output "api_hostname" {
  description = "API hostname."
  value       = local.api_hostname
}

output "web_origin" {
  description = "WEB_ORIGIN (CONTRACTS section 1)."
  value       = "https://${local.app_hostname}"
}

output "api_origin" {
  description = "API_ORIGIN (CONTRACTS section 1). Workers post completion callbacks here."
  value       = "https://${local.api_hostname}"
}

output "zone_name" {
  description = "Apex domain these records live under."
  value       = var.zone_name
}

output "targets_are_placeholders" {
  description = "True while the records still point at TEST-NET-1. The deploy runbook checks this before declaring an environment reachable."
  value       = local.is_placeholder
}

output "turnstile_site_key" {
  description = "Public Turnstile site key for the web app's auth forms. Null when manage_turnstile is false."
  value       = try(cloudflare_turnstile_widget.auth[0].id, null)
}

output "turnstile_secret_key" {
  description = "Turnstile secret, verified server-side by the API. Null when manage_turnstile is false."
  value       = try(cloudflare_turnstile_widget.auth[0].secret, null)
  sensitive   = true
}

output "waf_managed" {
  description = "Whether the WAF, rate-limit and custom rulesets are managed here. False means the edge has TLS and DDoS absorption and no application-layer control."
  value       = var.manage_waf
}
