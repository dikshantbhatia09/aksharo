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

/** Shape the tray/approval-window UI needs to render "Approve pairing for <client>?"
 * (`apps/desktop/src/bridge/adapter.ts`'s `BridgePendingPairing`, mirrored here since the
 * preload boundary can't import that module's Node-only types directly). */
export interface DesktopPendingPairing {
  readonly pairingId: string;
  readonly clientKind: string;
  readonly clientName: string;
  readonly code: string;
  readonly expiresAt: string;
}

export interface DesktopClientConnected {
  readonly clientId: string;
  readonly clientKind: string;
}

export interface AksharoDesktopApi {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  openMediaDialog(): Promise<string[]>;
  engine: {
    status(): Promise<EngineStatus>;
  };
  bridge: {
    /** Approves a pending pairing by id (brief §1, ruling ①: the adapter never returns a
     * `clientId` synchronously — see `onClientConnected`). */
    pair(pairingId: string): Promise<{ ok: true } | { ok: false; error: string }>;
    /** Denies a pending pairing by id. */
    deny(pairingId: string): Promise<{ ok: true } | { ok: false; error: string }>;
    /** Hands the signed-in user's access token down so the shell can bootstrap its
     * device/bridge-token (B08/B08b) — never logged, never returned. */
    provideAccessToken(token: string): Promise<{ ok: true }>;
    onPairingRequested(listener: (pairing: DesktopPendingPairing) => void): () => void;
    onClientConnected(listener: (client: DesktopClientConnected) => void): () => void;
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
