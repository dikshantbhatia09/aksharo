/**
 * Stands in for `server-only` under Vitest.
 *
 * The real package throws on import so a server module cannot be pulled into a
 * client bundle by accident — which is exactly what we want in the app and
 * exactly what stops a test from importing `lib/session/cookie.ts`. Next's
 * bundler resolves the harmless `react-server` entry; Vitest has no such
 * condition, so the alias does it here.
 */
export {};
