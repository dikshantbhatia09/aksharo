/**
 * Desktop-shell detection hook (C02 file boundary: the one `apps/web` file
 * this WP may touch, agreed with A13). The desktop shell loads the hosted app
 * with a `?desktop=1` marker and a `User-Agent` suffix `AksharoDesktop/<version>`
 * (`apps/desktop/src/main/index.ts`); this module is the single place the web
 * app checks for either signal, and the typed accessor for the preload API
 * the desktop shell exposes at `window.aksharoDesktop`
 * (`apps/desktop/src/preload/api-types.ts` — kept in sync by hand until both
 * sides share a types package).
 *
 * Pure / no server dependency so it works in both client components and tests.
 */

const USER_AGENT_MARKER = /AksharoDesktop\/([\w.-]+)/;

export interface DesktopEnvironment {
  isDesktop: boolean;
  version: string | null;
}

/** Detects the desktop shell from a `?desktop=1` query flag and/or User-Agent suffix. */
export function detectDesktopEnvironment(input: {
  searchParams?: URLSearchParams | null;
  userAgent?: string | null;
}): DesktopEnvironment {
  const fromQuery = input.searchParams?.get("desktop") === "1";
  const match = input.userAgent ? USER_AGENT_MARKER.exec(input.userAgent) : null;
  return {
    isDesktop: fromQuery || match !== null,
    version: match?.[1] ?? null,
  };
}

/** Type of the API the desktop preload exposes (subset the web app is allowed to rely on). */
export interface AksharoDesktopWindowApi {
  version: string;
  platform: string;
  openMediaDialog(): Promise<string[]>;
  engine: { status(): Promise<{ state: string }> };
  bridge: { pair(pairCode: string): Promise<{ ok: boolean; error?: string }> };
  updates: { check(): Promise<{ channel: string; available: boolean; version?: string }> };
  deepLink: { onOpen(listener: (url: string) => void): () => void };
}

/** Returns the desktop preload API when running inside the desktop shell, else `null`. */
export function getDesktopApi(): AksharoDesktopWindowApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { aksharoDesktop?: AksharoDesktopWindowApi }).aksharoDesktop;
  return api ?? null;
}
