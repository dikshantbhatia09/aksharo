import "server-only";

import { readRuntimeConfig } from "./runtime-config";

/**
 * Server-side fetch of `GET /plugins/manifest` (C10) for the marketing `/plugins` and
 * `/download` pages (`apps/web/app/(site)/(marketing)/{plugins,download}`). These pages
 * are server components with no user session, so they call the API directly rather than
 * going through the authenticated `@montaj/api-client` React-Query hooks the signed-in
 * `/plugins-app` page uses (`usePluginManifest`) -- same endpoint, two different call
 * sites for two different audiences (C11's brief note: "do not duplicate" refers to the
 * activation-card UI, not to which surface is allowed to read this public endpoint).
 *
 * Never throws: a network error, non-2xx, or unexpected shape all resolve to `undefined`,
 * and callers render their static placeholder copy instead -- the API itself already does
 * the same "unavailable" fallback (`plugin-manifest-source.ts`) when nothing is published,
 * so this is a second, independent safety net for when the API itself is unreachable from
 * the web server (build time, an outage, local dev with no API running).
 */
export interface PluginManifestChannelView {
  available: boolean;
  version: string | null;
  minHostVersion: string | null;
  maxHostVersion: string | null;
  downloadUrl: string | null;
  channel: "alpha" | "beta" | "stable" | null;
  notes: string | null;
}

export interface PluginManifestView {
  channels: {
    "premiere-uxp": PluginManifestChannelView;
    "ae-cep": PluginManifestChannelView;
    "resolve-script": PluginManifestChannelView;
  };
  desktop: {
    available: boolean;
    version: string | null;
    channel: "alpha" | "beta" | "stable" | null;
    notes: string | null;
    downloadUrl: { win: string | null; mac: string | null; linux: string | null };
  };
}

export async function fetchPluginManifest(): Promise<PluginManifestView | undefined> {
  try {
    const { apiOrigin } = readRuntimeConfig();
    const res = await fetch(new URL("/plugins/manifest", apiOrigin), {
      signal: AbortSignal.timeout(2000),
      // Marketing pages are static-ish; a 5-minute revalidate matches the API's own
      // 5-minute manifest cache instead of fetching on every request.
      next: { revalidate: 300 },
    });
    if (!res.ok) return undefined;
    return (await res.json()) as PluginManifestView;
  } catch {
    return undefined;
  }
}
