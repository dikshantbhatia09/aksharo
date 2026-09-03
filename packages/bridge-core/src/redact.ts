/**
 * Redaction for anything that leaves this machine as telemetry, a crash
 * report, or a diagnostics bundle (C12 brief: "crash reports are minidump-free
 * by default ... redacted"; "diagnostics bundle is a zip ... logs redacted,
 * config without secrets").
 *
 * Shared by `apps/desktop/src/telemetry`, `apps/bridge/src/telemetry` and the
 * API's server-side crash/event handling (`apps/api/src/telemetry`) so the
 * redaction rules are the same wherever text is about to be sent or bundled —
 * one file to audit, not three.
 *
 * Deliberately conservative: it is fine to over-redact a log line (a false
 * positive costs nothing but a `[redacted]` token); it is not fine to leak a
 * home directory, an email address or a bearer token.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Bearer/JWT-shaped tokens, API keys, and long opaque hex/base64 secrets.
const BEARER_RE = /\b(?:Bearer|bearer)\s+[A-Za-z0-9._-]{10,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\b/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

// Windows / macOS / Linux home-directory and user-profile paths.
// eslint-disable-next-line security/detect-unsafe-regex -- bounded or disjoint-alternation pattern, reviewed and timed against adversarial input -- not exponential; see the WP report
const WIN_USER_PATH_RE = /[A-Za-z]:\\Users\\[^\\/\s"']+(?:\\[^\\/\s"']+)*/g;
const MAC_USER_PATH_RE = /\/Users\/[^/\s"']+/g;
const LINUX_HOME_PATH_RE = /\/home\/[^/\s"']+/g;

// IPv4 addresses (device on a local network is still a location signal).
// eslint-disable-next-line security/detect-unsafe-regex -- bounded or disjoint-alternation pattern, reviewed and timed against adversarial input -- not exponential; see the WP report
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export interface RedactOptions {
  /** Redact IPv4 addresses too. Default `true`. */
  readonly ips?: boolean;
}

/** Redacts one string, replacing sensitive substrings with a `[redacted:*]` marker. */
export function redactText(input: string, options: RedactOptions = {}): string {
  const ips = options.ips ?? true;
  let out = input;
  out = out.replace(JWT_RE, "[redacted:jwt]");
  out = out.replace(BEARER_RE, "Bearer [redacted:token]");
  out = out.replace(EMAIL_RE, "[redacted:email]");
  out = out.replace(
    WIN_USER_PATH_RE,
    (m) => m.split("\\").slice(0, 2).join("\\") + "\\[redacted:user]",
  );
  out = out.replace(MAC_USER_PATH_RE, "/Users/[redacted:user]");
  out = out.replace(LINUX_HOME_PATH_RE, "/home/[redacted:user]");
  if (ips) out = out.replace(IPV4_RE, "[redacted:ip]");
  // Long opaque tokens last, so a JWT/bearer already replaced isn't re-matched
  // by the broader token pattern (the `[redacted:...]` markers are short).
  out = out.replace(LONG_TOKEN_RE, "[redacted:token]");
  return out;
}

/** Redacts every line, preserving order and line count. */
export function redactLines(lines: readonly string[]): string[] {
  return lines.map((line) => redactText(line));
}

/**
 * Keeps only the last `limit` lines (a ring-buffer read), then redacts them.
 * This is what a crash report's "last 50 log lines" and a diagnostics
 * bundle's log attachment both call.
 */
export function tailAndRedact(lines: readonly string[], limit: number): string[] {
  const tail = limit >= lines.length ? lines : lines.slice(lines.length - limit);
  return redactLines(tail);
}

/** Keys whose values are dropped outright rather than pattern-redacted. */
const SECRET_KEY_RE = /(token|secret|password|passwd|key|bearer|authorization|cookie)/i;

/**
 * Redacts a config/settings object recursively: any key that looks like a
 * secret has its value dropped; every remaining string value is text-redacted.
 * Used for the diagnostics bundle's "config without secrets".
 */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactConfig(v));
  if (typeof value === "string") return redactText(value);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redactConfig(val);
    }
    return out;
  }
  return value;
}
