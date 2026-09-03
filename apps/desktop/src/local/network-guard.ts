/**
 * The local-mode network guard (brief C04 §2: "no uploads of any kind in
 * local mode"; THREAT-MODEL T25 — a local project's media/transcript must
 * never leave the machine by accident).
 *
 * A pure predicate, wired into `session.defaultSession.webRequest.
 * onBeforeRequest` in `src/main/index.ts` (the main-process request
 * pipeline, not a preload `fetch` override — `contextIsolation` puts the
 * preload's JS in a separate world from the hosted page's, so a page-side
 * `fetch`/`XMLHttpRequest` patch would not even see the page's own calls;
 * `webRequest` sees every request the renderer makes regardless). Pure and
 * dependency-free on the same pattern as `security/allowlist.ts`, so it is
 * unit-testable without an Electron runtime.
 *
 * Scope: this blocks *uploads* (`POST`/`PUT`/`PATCH`) to the hosted API
 * while a local project is open — not every network request, which would
 * also break the app shell's own asset loads, telemetry and auth. A GET is
 * never a leak of local media; only a body-carrying write to the API can be.
 */

import { BRAND } from "@montaj/config/brand";

/** The hosted API origins an upload could target (brand's dual-domain period, same convention as `security/allowlist.ts`). */
export const API_ORIGIN = `https://api.${BRAND.domain}`;
export const ALT_API_ORIGIN = `https://api.${BRAND.altDomain}`;

export interface NetworkGuardCheck {
  readonly method: string;
  readonly url: string;
}

const UPLOAD_METHODS = new Set(["POST", "PUT", "PATCH"]);

function parseOrigin(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/**
 * True if `request` must be blocked because a local project is open.
 * `apiOrigin` is `https://api.<BRAND.domain>` (and its `altDomain` sibling);
 * requests to the local engine (`127.0.0.1`/`localhost`) and everything
 * else (asset CDNs, the hosted app's own origin for page loads, OAuth) are
 * never blocked — this guard's only job is the upload path.
 */
export function isUploadBlocked(
  request: NetworkGuardCheck,
  input: { localModeActive: boolean; apiOrigins: readonly string[] },
): boolean {
  if (!input.localModeActive) return false;
  if (!UPLOAD_METHODS.has(request.method.toUpperCase())) return false;

  const url = parseOrigin(request.url);
  if (url === null) return false;

  return input.apiOrigins.some((origin) => {
    const apiOrigin = parseOrigin(origin);
    return apiOrigin !== null && url.origin === apiOrigin.origin;
  });
}

/**
 * Tracks whether a local project is currently open (main-process module
 * state, mutated by the `desktop:local-*` IPC handlers in `src/main/
 * index.ts` around every open/create/close). A plain mutable holder rather
 * than a bare module-level `let` so it can be constructed fresh per test.
 */
export function createLocalModeState(initial = false): {
  isActive(): boolean;
  setActive(active: boolean): void;
} {
  let active = initial;
  return {
    isActive: () => active,
    setActive: (value: boolean) => {
      active = value;
    },
  };
}
