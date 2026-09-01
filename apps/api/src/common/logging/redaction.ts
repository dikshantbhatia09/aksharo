/**
 * Log redaction (THREAT-MODEL T21: secrets in code and logs).
 *
 * Two mechanisms, because they catch different mistakes:
 *
 *   1. {@link REDACT_PATHS} is handed to pino's own `redact` option. It covers the
 *      places a secret arrives in a KNOWN shape — an `Authorization` header, a
 *      cookie, a callback signature.
 *   2. {@link redactValue} walks whatever a developer passed to `logger.info(obj)`
 *      and masks anything that LOOKS like a secret or an email address, wherever
 *      it sits. This is the one that catches the mistake nobody predicted.
 *
 * Emails are masked rather than dropped: support needs to tell two users apart in
 * a log, and `d***@example.com` does that without putting personal data in a log
 * aggregator that has a different retention policy from the database (D47).
 */

/** Header and body paths pino redacts outright. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["x-license-key"]',
  'req.headers["x-montaj-signature"]',
  'req.headers["x-razorpay-signature"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.passwordHash",
  "*.refreshToken",
  "*.privateKey",
  "*.mfaSecret",
] as const;

/**
 * Keys whose VALUE is always a secret, matched case-insensitively anywhere in the
 * key. Deliberately broad: a false positive costs a debugging session, a false
 * negative costs a credential.
 */
const SECRET_KEY =
  /(pass(word|hash)?|secret|token|api[-_]?key|auth|credential|signature|private[-_]?key|session|cookie|mfa|otp|pan\b|gstin)/i;

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

export const REDACTED = "[redacted]";

/** `dikshant@example.com` -> `d***@example.com`. */
export function maskEmail(value: string): string {
  return value.replace(EMAIL, (_match, first: string, domain: string) => `${first}***${domain}`);
}

/** How deep {@link redactValue} walks before giving up and dropping the branch. */
const MAX_DEPTH = 8;

/**
 * Deep-copy `value`, masking secrets by key name and emails by shape.
 *
 * Cycles are cut with `[circular]`; depth is capped so a pathological object
 * cannot turn a log line into an outage.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return maskEmail(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: maskEmail(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, depth + 1, seen);
  }
  return out;
}

/**
 * pino `formatters.log` hook: every logged object passes through here, including
 * the ones pino's own `redact` paths do not describe.
 */
export function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  return redactValue(object) as Record<string, unknown>;
}
