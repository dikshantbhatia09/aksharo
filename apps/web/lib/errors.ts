import { ApiError, isApiError } from "@montaj/api-client";

/**
 * The one place a code becomes a sentence.
 *
 * 08 §6: "errors say what to do next". A raw `auth/invalid_credentials` does
 * not; "That email and password did not match. Try again, or use a sign-in
 * link." does. Anything without a mapping falls back to the API's own message,
 * which the API writes for humans, and only then to a generic line.
 */

const MESSAGES: Record<string, string> = {
  "auth/invalid_credentials":
    "That email and password did not match. Try again, or ask for a sign-in link.",
  "auth/invalid_token": "That link no longer works. Ask for a new one and use the newest email.",
  "auth/expired": "Your session has ended. Sign in again to carry on.",
  "auth/email_unverified": "Confirm your email address first — check your inbox for the link.",
  "auth/weak_password": "Pick a longer password: at least 12 characters, and not one you reuse.",
  "auth/age_restricted":
    "We cannot open an account for you yet. Join the waiting list and we will write when a parental-consent flow is ready.",
  "common/rate_limited": "Too many attempts. Wait a moment and try again.",
  "common/validation_failed": "Some of that did not look right. Check the highlighted fields.",
  "common/forbidden": "You do not have access to that.",
  "common/not_found": "We could not find that.",
  "common/unavailable": "We are having trouble right now. Try again in a minute.",
  "common/internal": "Something went wrong on our side. Try again — we have been told.",
  "network/unreachable": "We could not reach the server. Check your connection and try again.",
  "network/malformed_response": "The server sent something we could not read. Try again.",
  "client/not_implemented": "That part of Aksharo is not switched on yet.",
  "credits/insufficient":
    "You are out of credits for this. Top up and this will run straight away.",
  "entitlement/upgrade_required": "Your plan does not include that yet.",
  "billing/plan_not_found": "That plan is not available.",
  "billing/plan_inactive": "That plan is no longer sold.",
  "billing/interval_unavailable": "That billing interval is not available for this plan.",
  "billing/tax_profile_required":
    "Confirm the workspace's billing country and State before checkout.",
  "billing/subscription_not_found": "There is no subscription to change.",
  "billing/subscription_not_cancellable":
    "This subscription is already set to cancel at period end.",
  "billing/subscription_not_resumable": "There is nothing to resume on this subscription.",
  "billing/pause_limit_reached": "A subscription can be paused once every 12 months.",
  "billing/already_paused": "This subscription is already paused.",
  "billing/mandate_not_found": "That mandate could not be found.",
  "billing/mandate_already_revoked": "That mandate was already revoked.",
  "billing/topup_invalid": "Choose a valid top-up amount.",
  "billing/pass_kind_unavailable": "That pass is not available right now.",
  "billing/webhook_signature_invalid": "The payment provider's signature could not be verified.",
  "billing/provider_rejected": "The payment provider refused that request.",
  "workspace/tax_profile_invalid": "Check the billing details — something did not look right.",
  "workspace/tax_profile_locked":
    "The billing currency is fixed for the life of a subscription. Cancel it first, or contact support.",
};

const FALLBACK = "Something went wrong. Try again.";

export function messageForError(error: unknown): string {
  if (isApiError(error)) {
    const mapped = MESSAGES[error.code];
    if (mapped !== undefined) return mapped;
    if (error.message !== "") return error.message;
    return FALLBACK;
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return FALLBACK;
}

/** How long to wait before the "try again" button becomes useful, in seconds. */
export function retryAfterSeconds(error: unknown): number | undefined {
  if (!(error instanceof ApiError) || error.retryAfterMs === undefined) return undefined;
  return Math.ceil(error.retryAfterMs / 1000);
}

/** Field-level messages from a `common/validation_failed` envelope. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error) || error.code !== "common/validation_failed") return {};
  const details = error.details;
  if (typeof details !== "object" || details === null) return {};
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return {};

  const result: Record<string, string> = {};
  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    const field = Array.isArray(path)
      ? path.join(".")
      : typeof path === "string"
        ? path
        : undefined;
    if (field !== undefined && typeof message === "string") result[field] = message;
  }
  return result;
}
