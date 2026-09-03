import type { EdgHot, Segment } from "@montaj/edg/schemas";

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

// --- C04: local mode -------------------------------------------------------

export type LocalMediaRole = "primary" | "broll" | "audio";
export type LocalExportStatus = "pending" | "done" | "failed";

export interface LocalProjectInfo {
  readonly id: string;
  readonly title: string;
  readonly aspect: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalMediaInfo {
  readonly id: string;
  readonly projectId: string;
  readonly role: LocalMediaRole;
  readonly filePath: string;
  readonly durationMs: number | null;
  readonly fps: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly importedAt: string;
}

export interface LocalEdgSnapshotInfo {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly hot: EdgHot;
  readonly segments: Segment[];
  readonly createdAt: string;
}

export interface LocalExportInfo {
  readonly id: string;
  readonly projectId: string;
  readonly outputPath: string;
  readonly status: LocalExportStatus;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/**
 * Local mode (brief C04): SQLite + files, local export, no uploads. Every
 * method throws `{code: "local/disabled"}` (surfaced to the renderer as a
 * rejected promise) when `desktop:local-set-plan` has not yet reported a
 * Starter+ plan (`src/local/entitlement-gate.ts` — fails closed) — the web
 * app is expected to hide the "Local projects" surface behind the same
 * `localMode` entitlement it already reads for cloud gating (B02/B03), so
 * this is a second, defensive gate rather than the only one.
 */
export interface AksharoDesktopLocalApi {
  isEnabled(): Promise<boolean>;
  createProject(input: { title: string; aspect: string }): Promise<LocalProjectInfo>;
  listProjects(): Promise<LocalProjectInfo[]>;
  openProject(projectId: string): Promise<LocalProjectInfo>;
  deleteProject(projectId: string): Promise<{ ok: true }>;
  /** Opens the native file picker and imports the chosen file (brief §1: "import media"). */
  importMedia(input: {
    projectId: string;
    sourcePath: string;
    role: LocalMediaRole;
  }): Promise<LocalMediaInfo>;
  listMedia(projectId: string): Promise<LocalMediaInfo[]>;
  transcribe(input: { audio: string; language?: string }): Promise<unknown>;
  align(input: { audio: string; words: string[]; language: string }): Promise<unknown>;
  saveEdgSnapshot(input: {
    projectId: string;
    hot: EdgHot;
    segments: Segment[];
  }): Promise<LocalEdgSnapshotInfo>;
  latestSnapshot(projectId: string): Promise<LocalEdgSnapshotInfo | null>;
  runExport(input: {
    projectId: string;
    drawCommandsPath: string;
    width: number;
    height: number;
    fps: number;
    outputPath: string;
  }): Promise<LocalExportInfo>;
  listExports(projectId: string): Promise<LocalExportInfo[]>;
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
  /** Local mode (brief C04). */
  local: AksharoDesktopLocalApi;
}

declare global {
  interface Window {
    aksharoDesktop?: AksharoDesktopApi;
  }
}
