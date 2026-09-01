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
