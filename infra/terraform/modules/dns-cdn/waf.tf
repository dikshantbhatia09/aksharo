# ---------------------------------------------------------------------------
# Edge protection: WAF managed rules, route rate limits, and the challenge
# policy for the endpoints that cost money to abuse.
#
# The module proxied DNS through Cloudflare and stopped there. Proxying alone
# buys TLS, caching and volumetric DDoS absorption; it buys no WAF rule, no bot
# control, no endpoint rate limit and no challenge. Every application-layer
# control — credential stuffing, signup abuse, upload-init floods, provider
# credit burn — rested entirely on the in-app limiter, which is per-IP, shares
# one bucket across everyone behind a proxy unless TRUST_PROXY is right, and
# until P0-08 failed fully open whenever Redis blinked (launch-readiness P0-08).
#
# Rate limits here are DEFENCE IN DEPTH, not a replacement for the application's
# own per-account limits: an attacker rotating source addresses defeats an
# IP-keyed edge rule, and only the per-account bucket sees that. Both, always.
#
# Everything is off by default (`manage_waf = false`) so this plans cleanly
# before a zone exists on a paid plan. Rate-limiting rules need Pro or above.
# ---------------------------------------------------------------------------

locals {
  waf_enabled = var.manage_waf

  # Endpoints where one request is cheap for the caller and expensive for us: a
  # password hash (argon2id at 64 MiB), an email, a provider call, a job.
  auth_paths = [
    "/auth/login",
    "/auth/signup",
    "/auth/magic-link",
    "/auth/password-reset",
    "/auth/verify-email",
  ]

  auth_path_expression = join(" or ", [
    for path in local.auth_paths : format("starts_with(http.request.uri.path, %q)", path)
  ])
}

# --- Managed rulesets ------------------------------------------------------

resource "cloudflare_ruleset" "managed_waf" {
  count = local.waf_enabled ? 1 : 0

  zone_id = var.zone_id
  name    = "montaj-managed-waf"
  kind    = "zone"
  phase   = "http_request_firewall_managed"

  rules = [
    {
      # Cloudflare's own managed ruleset: the signatures nobody should be
      # hand-maintaining.
      action      = "execute"
      description = "Cloudflare Managed Ruleset"
      expression  = "true"
      enabled     = true
      action_parameters = {
        id = var.managed_ruleset_id
      }
    },
    {
      # OWASP Core Rule Set. Watch the sampled logs for a week before
      # tightening the paranoia level: CRS false positives on a media product
      # are usually base64 inside a JSON body.
      action      = "execute"
      description = "Cloudflare OWASP Core Ruleset"
      expression  = "true"
      enabled     = true
      action_parameters = {
        id = var.owasp_ruleset_id
      }
    },
  ]
}

# --- Rate limiting ---------------------------------------------------------

resource "cloudflare_ruleset" "rate_limit" {
  count = local.waf_enabled ? 1 : 0

  zone_id = var.zone_id
  name    = "montaj-rate-limits"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules = [
    {
      description = "Auth endpoints"
      expression  = format("(http.host eq %q and (%s))", local.api_hostname, local.auth_path_expression)
      action      = "block"
      enabled     = true
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 60
        requests_per_period = var.rate_limit_auth_per_minute
        mitigation_timeout  = 600
      }
    },
    {
      # Creating an upload ticket or a job reserves nothing but costs a presign,
      # a row and — for transcription — a provider call.
      description = "Upload init, transcription and export creation"
      expression = format(
        "(http.host eq %q and http.request.method eq \"POST\" and (http.request.uri.path contains \"/media/init\" or http.request.uri.path contains \"/transcribe\" or http.request.uri.path contains \"/exports\"))",
        local.api_hostname,
      )
      action  = "block"
      enabled = true
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 60
        requests_per_period = var.rate_limit_jobs_per_minute
        mitigation_timeout  = 600
      }
    },
    {
      # Share tokens are guessable only at enormous cost, but the attempt is
      # free to make and a burst of 404s is the only signal anyone is trying.
      description = "Public share viewer"
      expression  = format("(http.host eq %q and starts_with(http.request.uri.path, \"/s/\"))", local.app_hostname)
      action      = "managed_challenge"
      enabled     = true
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 60
        requests_per_period = var.rate_limit_share_per_minute
        mitigation_timeout  = 600
      }
    },
  ]
}

# --- Custom rules: challenges, admin, and the surfaces that are not public --

resource "cloudflare_ruleset" "custom" {
  count = local.waf_enabled ? 1 : 0

  zone_id = var.zone_id
  name    = "montaj-custom-rules"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules = concat(
    [
      {
        # Challenge only above a threat score, so an ordinary sign-up is
        # untouched and a host that Cloudflare already distrusts has to work
        # for it. Generic either way: the challenge must not reveal whether an
        # account exists.
        description = "Challenge suspicious clients on the auth surface"
        expression = format(
          "(http.host eq %q and starts_with(http.request.uri.path, \"/auth/\") and cf.threat_score > %d)",
          local.api_hostname,
          var.challenge_threat_score,
        )
        action  = "managed_challenge"
        enabled = true
      },
      {
        # Staff-only. Until Cloudflare Access is in front of it, an allow-list
        # is the containment: the P0 bar is "not reachable from the open
        # internet", not "reachable but behind TOTP".
        description = "Admin console is not public"
        expression = length(var.admin_allowed_cidrs) > 0 ? format(
          "(starts_with(http.request.uri.path, \"/admin\") and not ip.src in {%s})",
          join(" ", var.admin_allowed_cidrs),
        ) : "starts_with(http.request.uri.path, \"/admin\")"
        action  = length(var.admin_allowed_cidrs) > 0 ? "block" : "managed_challenge"
        enabled = var.protect_admin_paths
      },
      {
        # API docs describe every route, DTO and error code; `/internal/*` is
        # the signed worker callback surface and the metrics scrape. The
        # application also refuses to mount docs under NODE_ENV=production —
        # this is the second lock, not the only one.
        description = "API docs and internal routes are not public"
        expression = format(
          "(http.host eq %q and (starts_with(http.request.uri.path, \"/docs\") or starts_with(http.request.uri.path, \"/internal/\")))",
          local.api_hostname,
        )
        action  = "block"
        enabled = true
      },
    ],
    var.admin_allowed_countries == null ? [] : [
      {
        description = "Admin console only from the operating countries"
        expression = format(
          "(starts_with(http.request.uri.path, \"/admin\") and not ip.geoip.country in {%s})",
          join(" ", formatlist("%q", var.admin_allowed_countries)),
        )
        action  = "block"
        enabled = true
      },
    ],
  )
}

# --- Turnstile -------------------------------------------------------------
#
# A widget, not a rule: the application decides when to show it (on sign-up,
# after repeated failure, on resend and reset) and verifies the token
# server-side. Creating it here provisions the secret with the rest of the
# infrastructure rather than pasting it in from a dashboard.

resource "cloudflare_turnstile_widget" "auth" {
  count = local.waf_enabled && var.manage_turnstile ? 1 : 0

  account_id = var.account_id
  name       = "montaj-auth"
  domains    = distinct([var.zone_name, local.app_hostname, local.api_hostname])
  # "managed" lets Cloudflare choose between invisible and interactive per
  # request. An always-interactive widget on every login is a conversion cost
  # every legitimate user pays to inconvenience an attacker briefly.
  mode = "managed"
}
