# ---------------------------------------------------------------------------
# The frozen environment contract.
#
# This map IS docs/CONTRACTS.md section 1, in contract order. Every variable
# there gets exactly one SSM parameter here; the CI job `infra-validate` diffs
# this file against CONTRACTS section 1 and fails the build if they drift, which
# is the evidence for acceptance criterion 2 of the X05 brief.
#
# secret = true  -> SecureString, encrypted with the module's KMS key
# human  = true  -> Terraform creates a placeholder and never reads or writes
#                   the value again ([H] item in infra/README.md)
#
# Adding a variable here without adding it to CONTRACTS section 1 (or the other
# way round) breaks CI on purpose: the contract is changed by an ADR, not by an
# infrastructure commit.
# ---------------------------------------------------------------------------

locals {
  contract_parameters = {
    DATABASE_URL = {
      secret      = true
      human       = true
      description = "PostgreSQL connection string. Assembled by scripts/bootstrap-secrets.sh from the RDS-managed master secret; never handled by Terraform."
    }
    REDIS_URL = {
      secret      = false
      human       = false
      description = "Redis connection string for BullMQ and pub/sub. No credential: access is by security group, TLS enforced by the rediss scheme."
    }
    S3_ENDPOINT = {
      secret      = false
      human       = false
      description = "Region-pinned S3 endpoint for raw uploads."
    }
    S3_REGION = {
      secret      = false
      human       = false
      description = "Residency region for raw media (THREAT-MODEL T24)."
    }
    S3_BUCKET_RAW = {
      secret      = false
      human       = false
      description = "Raw upload bucket name."
    }
    S3_ACCESS_KEY = {
      secret      = true
      human       = true
      description = "Static S3 access key id. Prefer IRSA: leave the placeholder in place unless a workload genuinely cannot assume a role."
    }
    S3_SECRET_KEY = {
      secret      = true
      human       = true
      description = "Static S3 secret access key. See S3_ACCESS_KEY."
    }
    R2_ENDPOINT = {
      secret      = false
      human       = false
      description = "Cloudflare R2 S3-compatible endpoint for derived objects."
    }
    R2_BUCKET_DERIVED = {
      secret      = false
      human       = false
      description = "Derived object bucket name on R2."
    }
    R2_ACCESS_KEY = {
      secret      = true
      human       = true
      description = "R2 API token access key id. R2 has no IRSA equivalent, so this one is genuinely static."
    }
    R2_SECRET_KEY = {
      secret      = true
      human       = true
      description = "R2 API token secret access key."
    }
    JWT_PRIVATE_KEY = {
      secret      = true
      human       = true
      description = "RS256 signing key (CONTRACTS section 5). Generated offline, pasted once, rotated per docs/runbooks/rotate-secrets.md."
    }
    JWT_PUBLIC_KEY = {
      secret      = false
      human       = true
      description = "RS256 verification key. Public by construction, stored as a plain String so a verifier needs no KMS grant."
    }
    INTERNAL_CALLBACK_SECRET = {
      secret      = true
      human       = true
      description = "HMAC key for worker to API completion callbacks (CONTRACTS section 3, THREAT-MODEL T8). 32 random bytes."
    }
    INTERNAL_CALLBACK_SECRET_NEXT = {
      secret      = true
      human       = true
      description = <<-EOT
        [H] Second valid verification key during a rotation of INTERNAL_CALLBACK_SECRET.
        Optional in CONTRACTS section 1: the API accepts a callback signed with either
        key while this holds a real value, which is what lets workers and the API swap
        keys without rejecting in-flight completions (THREAT-MODEL T8).

        It is created here as a placeholder and left that way outside a rotation, so
        the parameter always exists for external-secrets to read. The runbook resets
        it to the placeholder rather than deleting it: a deleted parameter would make
        the whole ExternalSecret fail and take every pod's environment with it.
        See docs/runbooks/rotate-secrets.md section B.
      EOT
    }
    GOOGLE_OAUTH_CLIENT_ID = {
      secret      = false
      human       = true
      description = "Google OAuth client id. Public in the authorisation URL."
    }
    GOOGLE_OAUTH_CLIENT_SECRET = {
      secret      = true
      human       = true
      description = "Google OAuth client secret."
    }
    WEB_ORIGIN = {
      secret      = false
      human       = false
      description = "Public origin of the web studio. Also the CORS allow-list entry on both buckets."
    }
    API_ORIGIN = {
      secret      = false
      human       = false
      description = "Public origin of the API. Workers post completion callbacks here."
    }
    RAZORPAY_KEY_ID = {
      secret      = false
      human       = true
      description = "Razorpay key id. Public: the checkout script receives it."
    }
    RAZORPAY_KEY_SECRET = {
      secret      = true
      human       = true
      description = "Razorpay API secret."
    }
    RAZORPAY_WEBHOOK_SECRET = {
      secret      = true
      human       = true
      description = "Razorpay webhook signing secret (THREAT-MODEL T16)."
    }
    SARVAM_API_KEY = {
      secret      = true
      human       = true
      description = "Sarvam Saaras ASR key. Only populate once the DPA in A00-06 is signed (THREAT-MODEL T18)."
    }
    ELEVENLABS_API_KEY = {
      secret      = true
      human       = true
      description = "ElevenLabs Scribe ASR key. DPA-gated (A00-06)."
    }
    ASSEMBLYAI_API_KEY = {
      secret      = true
      human       = true
      description = "AssemblyAI ASR key. DPA-gated (A00-06)."
    }
    LLM_PROVIDER = {
      secret      = false
      human       = false
      description = "anthropic | openai | mock. Set per environment; staging defaults to mock so no transcript leaves the account by accident."
    }
    ANTHROPIC_API_KEY = {
      secret      = true
      human       = true
      description = "Anthropic API key. DPA-gated (A00-06)."
    }
    OPENAI_API_KEY = {
      secret      = true
      human       = true
      description = "OpenAI API key. DPA-gated (A00-06)."
    }
    GPU_PROVIDER = {
      secret      = false
      human       = false
      description = "runpod | modal | replicate | none. See infra/gpu."
    }
    GPU_PROVIDER_URL = {
      secret      = false
      human       = false
      description = "Endpoint the serverless GPU pool is invoked at. Not a credential: it is the address, and the token beside it is what authorises the call."
    }
    GPU_PROVIDER_TOKEN = {
      secret      = true
      human       = true
      description = "Bearer token for the serverless GPU endpoint. Pasted once by a human, like the other provider keys."
    }
    SENTRY_DSN = {
      secret      = true
      human       = true
      description = "Sentry DSN. Not strictly a credential, but a leaked DSN lets anyone forge events into the project, so it is stored encrypted."
    }
    POSTHOG_KEY = {
      secret      = false
      human       = true
      description = "PostHog project key. Public: it ships in the browser bundle. Consent-gated at runtime."
    }
    FEATURE_FLAGS_JSON = {
      secret      = false
      human       = false
      description = "JSON object of feature flags. Terraform owns the default; the admin console overrides at runtime."
    }
    MAIL_PROVIDER = {
      secret      = false
      human       = false
      description = "ses | smtp | dev. Cloud environments use ses, which authenticates with the pod's IRSA role and takes its region from S3_REGION, so there is no mail access key in this contract."
    }
    MAIL_FROM = {
      secret      = false
      human       = true
      description = "Envelope sender for transactional mail, e.g. `Aksharo <hello@aksharo.ai>`. Public, but a human fills it in once because it must match a verified SES identity."
    }
    SMTP_URL = {
      secret      = true
      human       = true
      description = "SMTP connection URL for self-hosted and local delivery (Mailpit). Carries credentials, so it is a SecureString. Left as the placeholder wherever MAIL_PROVIDER is ses."
    }
  }

  # Parameters Terraform computes and keeps up to date.
  managed_parameters = {
    for name, meta in local.contract_parameters :
    name => meta if !meta.human
  }

  # Parameters a human fills in once. Terraform creates the placeholder and then
  # ignores the value forever.
  human_parameters = {
    for name, meta in local.contract_parameters :
    name => meta if meta.human
  }
}
