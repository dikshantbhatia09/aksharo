/**
 * Shape of `window.aksharoDesktop`, exposed by `src/preload/index.ts` via
 * `contextBridge.exposeInMainWorld` (brief §2). Shared between the preload
 * script and `apps/web/lib/desktop.ts` (the one web-side file this WP may
 * touch) so A13's detection hook stays in sync with what is actually exposed.
 */

export type EngineStatus = { state: "unavailable" }; // stub until C03 (local engine)

export interface DesktopUpdateInfo {
  channel: "alpha" | "beta" | "stable";
  available: boolean;
  version?: string;
}

/** C12: the desktop shell's local mirror of the `telemetry` consent. */
export interface TelemetryConsentState {
  readonly granted: boolean;
  readonly decidedAt?: string;
}

export interface AksharoDesktopApi {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  openMediaDialog(): Promise<string[]>;
  engine: {
    status(): Promise<EngineStatus>;
  };
  bridge: {
    pair(pairCode: string): Promise<{ ok: true } | { ok: false; error: string }>;
  };
  updates: {
    check(): Promise<DesktopUpdateInfo>;
  };
  deepLink: {
    onOpen(listener: (url: string) => void): () => void;
  };
  /**
   * C12: consent-gated telemetry. The hosted web app (the renderer) holds
   * the user's access token and is the one that actually calls the API
   * (`POST /consents`, `POST /telemetry/events`) — this surface is only for
   * what needs the main process: the local consent mirror that gates the
   * crash handler before any network round trip, this run's queued events,
   * and building the diagnostics bundle (filesystem access the renderer's
   * sandbox does not have).
   */
  telemetry: {
    getConsent(): Promise<TelemetryConsentState>;
    setConsent(granted: boolean): Promise<TelemetryConsentState>;
    /** Drains up to `limit` queued events for the renderer to POST itself. */
    drainQueuedEvents(limit: number): Promise<Record<string, unknown>[]>;
    /** Base64-encoded zip bytes (brief §2/§3). */
    buildDiagnosticsBundle(): Promise<string>;
  };
}

declare global {
  interface Window {
    aksharoDesktop?: AksharoDesktopApi;
  }
}
