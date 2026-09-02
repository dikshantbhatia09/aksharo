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
}

declare global {
  interface Window {
    aksharoDesktop?: AksharoDesktopApi;
  }
}
