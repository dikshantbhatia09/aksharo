import "server-only";

/**
 * Configuration the browser needs, read on the server at request time.
 *
 * Deliberately not `NEXT_PUBLIC_*`: those are inlined at build time, which makes
 * one image per environment and puts a value in the bundle that nobody can change
 * without a rebuild. The root layout is a server component, so it can read the
 * process environment on every render and hand the browser a plain object.
 *
 * Only non-secret values belong here. `POSTHOG_KEY` is a write-only ingestion
 * key and `SENTRY_DSN` is designed to be public; nothing else is exposed.
 */

export interface RuntimeConfig {
  /** Origin of the API, e.g. `https://api.aksharo.ai`. */
  apiOrigin: string;
  /** PostHog project key, or `null` when analytics is not configured. */
  posthogKey: string | null;
  posthogHost: string;
  sentryDsn: string | null;
  /** `FEATURE_FLAGS_JSON` (CONTRACTS §1), parsed. */
  flags: Record<string, boolean>;
  environment: string;
  /** Whether both halves of the Google OAuth client are configured. */
  googleOAuthEnabled: boolean;
  /** Whether the complete Razorpay checkout credential set is configured. */
  razorpayEnabled: boolean;
  /** Development-only sign-up shortcut, effective only with the dev mail outbox. */
  authDevAutoVerify: boolean;
}

import { parseFlags } from "./flags";

const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

function optional(name: string): string | null {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
}

export function readRuntimeConfig(): RuntimeConfig {
  const mailProvider = optional("MAIL_PROVIDER") ?? "dev";
  return {
    apiOrigin: optional("API_ORIGIN") ?? "http://localhost:3001",
    posthogKey: optional("POSTHOG_KEY"),
    posthogHost: optional("POSTHOG_HOST") ?? DEFAULT_POSTHOG_HOST,
    sentryDsn: optional("SENTRY_DSN"),
    flags: parseFlags(optional("FEATURE_FLAGS_JSON")),
    environment: optional("NODE_ENV") ?? "development",
    googleOAuthEnabled:
      optional("GOOGLE_OAUTH_CLIENT_ID") !== null &&
      optional("GOOGLE_OAUTH_CLIENT_SECRET") !== null,
    razorpayEnabled:
      optional("RAZORPAY_KEY_ID") !== null &&
      optional("RAZORPAY_KEY_SECRET") !== null &&
      optional("RAZORPAY_WEBHOOK_SECRET") !== null,
    authDevAutoVerify: mailProvider === "dev" && optional("AUTH_DEV_AUTO_VERIFY") === "1",
  };
}
