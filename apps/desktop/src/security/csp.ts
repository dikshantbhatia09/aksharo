/**
 * Strict CSP for the packaged offline page (brief §1). The hosted app itself
 * sets its own CSP headers server-side (A13); this one only governs
 * `offline.html`, which ships inside the app bundle and must render with the
 * network down, so it is 100% self-contained: no remote fetches, no inline
 * script, no eval.
 */
export function offlinePageCsp(): string {
  return [
    "default-src 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
