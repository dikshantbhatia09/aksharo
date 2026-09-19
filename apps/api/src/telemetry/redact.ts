/**
 * Inlined redaction utility for telemetry service without external bridge-core dependency.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BEARER_RE = /\b(?:Bearer|bearer)\s+[A-Za-z0-9._-]{10,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\b/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;
const WIN_USER_PATH_RE = /[A-Za-z]:\\Users\\[^\\/\s"']+/g;
const MAC_USER_PATH_RE = /\/Users\/[^/\s"']+/g;
const LINUX_HOME_PATH_RE = /\/home\/[^/\s"']+/g;
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

export interface RedactOptions {
  readonly ips?: boolean;
}

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
  out = out.replace(LONG_TOKEN_RE, "[redacted:token]");
  return out;
}

export function redactLines(lines: readonly string[]): string[] {
  return lines.map((line) => redactText(line));
}

export function tailAndRedact(lines: readonly string[], limit: number): string[] {
  const tail = limit >= lines.length ? lines : lines.slice(lines.length - limit);
  return redactLines(tail);
}

const SECRET_KEY_RE = /(token|secret|password|passwd|key|bearer|authorization|cookie)/i;

export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactConfig(v));
  if (typeof value === "string") return redactText(value);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // eslint-disable-next-line security/detect-object-injection -- building sanitized output object from Object.entries
      out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redactConfig(val);
    }
    return out;
  }
  return value;
}
