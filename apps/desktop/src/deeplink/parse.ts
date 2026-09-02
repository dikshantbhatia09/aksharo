/**
 * `aksharo://` deep-link parsing and validation (brief §3).
 *
 * Routes:
 *   aksharo://auth/callback?code=<opaque>[&state=<opaque>]
 *   aksharo://project/<ulid>
 *   aksharo://pair?code=<6-8 char pair code>
 *
 * Anything else — unknown host, malformed ids, wrong scheme — is rejected.
 * Pure function: `main/index.ts` wires this to `app.on("open-url" | "second-instance")`.
 */
import { BRAND } from "@montaj/config/brand";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
// Device-code user codes and bridge pair codes are short opaque strings
// (CONTRACTS §5: 8 chars, no ambiguous glyphs); accept a slightly wider
// bound so bridge pairing (C01) can use its own alphabet without a resync.
const PAIR_CODE_RE = /^[A-Z0-9]{4,12}$/i;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9._-]{1,2048}$/;

export type DeepLink =
  | { kind: "auth-callback"; code: string; state?: string }
  | { kind: "open-project"; projectId: string }
  | { kind: "bridge-pair"; code: string };

/**
 * Parses and validates a raw deep-link URL. Returns `null` for anything not
 * matching an allowlisted route — callers must treat `null` as "ignore",
 * never as "best effort navigate".
 */
export function parseDeepLink(rawUrl: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol.replace(/:$/, "") !== BRAND.deepLinkScheme) return null;

  // WHATWG URL treats `scheme://host/path` specially only for a fixed list of
  // "special" schemes; for a custom scheme `aksharo://auth/callback` parses
  // with host="auth" and pathname="/callback" (Windows/macOS/Linux registration
  // all preserve this), so route on host + first path segment.
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "auth" && segments[0] === "callback") {
    const code = url.searchParams.get("code");
    if (!code || !OPAQUE_TOKEN_RE.test(code)) return null;
    const state = url.searchParams.get("state") ?? undefined;
    if (state !== undefined && !OPAQUE_TOKEN_RE.test(state)) return null;
    return { kind: "auth-callback", code, state };
  }

  if (host === "project" && segments.length === 1) {
    const projectId = segments[0];
    if (!projectId || !ULID_RE.test(projectId)) return null;
    return { kind: "open-project", projectId };
  }

  if (host === "pair" && segments.length === 0) {
    const code = url.searchParams.get("code");
    if (!code || !PAIR_CODE_RE.test(code)) return null;
    return { kind: "bridge-pair", code: code.toUpperCase() };
  }

  return null;
}

/** Builds the `aksharo://` URL for a route (used by tests and the web-desktop hand-off). */
export function buildDeepLink(link: DeepLink): string {
  switch (link.kind) {
    case "auth-callback": {
      const params = new URLSearchParams({ code: link.code });
      if (link.state) params.set("state", link.state);
      return `${BRAND.deepLinkScheme}://auth/callback?${params.toString()}`;
    }
    case "open-project":
      return `${BRAND.deepLinkScheme}://project/${link.projectId}`;
    case "bridge-pair":
      return `${BRAND.deepLinkScheme}://pair?code=${link.code}`;
  }
}
