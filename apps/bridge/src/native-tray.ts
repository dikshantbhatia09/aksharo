import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PendingPairing, TrayController } from "@montaj/bridge-core";

/**
 * The real system tray icon for standalone `apps/bridge` installs (brief
 * scope item 1). C02's Electron shell has its own tray (via `apps/desktop/
 * src/bridge/adapter.ts`) built on Electron's own `Tray` API and does not use
 * this module — this one exists only for the plugin-only install path, where
 * there is no Electron shell to host a tray icon.
 *
 * Library choice: `systray2` (MIT, https://www.npmjs.com/package/systray2).
 * It is a thin, dependency-light (`debug`, `fs-extra`) wrapper that spawns a
 * small prebuilt per-OS helper binary and talks to it over stdio — no native
 * Node addon, no compiler needed at install time. That matters specifically
 * because `apps/bridge` ships as a Node SEA: a native `.node` addon has no
 * stable path once esbuild bundles everything into one `dist/bundle.cjs`
 * (`scripts/build-sea.mjs`), so any tray library built as a native addon
 * (the only other realistic option on npm today — see the WP report for the
 * packages surveyed) cannot work here at all. `systray2`'s own last npm
 * release predates this WP by several years (documented in the WP report as
 * a known risk, not hidden); it was still the only maintained-enough,
 * SEA-compatible, cross-platform tray implementation found. Its helper
 * binaries are copied out of `node_modules` by `scripts/build-sea.mjs` at
 * build time into `dist/traybin/` next to the packaged executable — never
 * committed to the repo.
 *
 * Fallback: if the helper binary is missing (e.g. `dist/traybin` was not
 * shipped alongside this executable), spawning it fails (no display, no
 * window manager — the common case for a server/CI box), or the platform is
 * unsupported, `createNativeTray` resolves to `undefined` and the caller
 * (`main.ts`) falls back to `bridge-core`'s `createConsoleTray`, matching the
 * headless fallback path already documented in `apps/bridge/README.md`.
 */

export interface NativeTrayHandle extends TrayController {
  close(): Promise<void>;
}

/** The subset of `systray2`'s API this module actually uses (for test injection). */
export interface SysTrayLike {
  onReady(listener: () => void): unknown;
  onClick(listener: (action: { item: { title: string }; seq_id: number }) => void): Promise<unknown>;
  onError(listener: (err: Error) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  sendAction(action: unknown): Promise<unknown>;
  kill(exitNode?: boolean): Promise<void>;
  ready(): Promise<void>;
}

export type SysTrayFactory = (conf: {
  menu: { icon: string; title: string; tooltip: string; items: unknown[] };
  copyDir: string | boolean;
}) => SysTrayLike;

const STATUS_ITEM = "status";
const APPROVE_ITEM = "approve";
const DENY_ITEM = "deny";
const QUIT_ITEM = "quit";
const READY_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** 1x1 transparent PNG, base64 — `systray2` requires a non-empty icon string. */
const BLANK_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function traybinDirectories(): string[] {
  // Packaged: `dist/traybin/` next to the executable, copied there by
  // `scripts/build-sea.mjs`. Dev/test: `node_modules/systray2/traybin`,
  // resolved relative to this file rather than `process.cwd()` so `pnpm
  // --filter @montaj/bridge test` works from any directory.
  const dirs = [join(dirname(process.execPath), "traybin")];
  try {
    dirs.push(join(dirname(require.resolve("systray2/package.json")), "traybin"));
  } catch {
    // systray2 not resolvable (shouldn't happen once it's a dependency) — the
    // packaged-binary candidate above is still tried.
  }
  return dirs;
}

/**
 * Attempts to start a native tray icon reflecting `bridge`'s pairing/status
 * events. Resolves `undefined` (never rejects) if a native tray cannot be
 * shown here — the caller should fall back to the console tray.
 */
export async function createNativeTray(
  options: {
    factory?: SysTrayFactory;
    log?: (line: string) => void;
  } = {},
): Promise<NativeTrayHandle | undefined> {
  const log = options.log ?? (() => {});

  if (process.platform === "linux" && process.env["DISPLAY"] === undefined) {
    log("no DISPLAY; skipping native tray");
    return undefined;
  }
  // CI runners (including Windows/macOS ones) report a session but have no
  // real interactive desktop backing the notification area: spawning the
  // tray helper there was observed to hang indefinitely rather than fail
  // fast (see the WP report), which would wedge the SEA smoke test. Treat
  // `CI` the same as "no display" rather than let that hang reach `ready()`.
  if (options.factory === undefined && process.env["CI"] !== undefined) {
    log("CI environment; skipping native tray");
    return undefined;
  }
  let SysTray: SysTrayFactory;
  if (options.factory !== undefined) {
    // Test injection: bypasses the helper-binary check below, since a test
    // fake never spawns a real process.
    SysTray = options.factory;
  } else {
    if (!traybinDirectories().some((dir) => existsSync(dir))) {
      log("no systray2 helper binary found (packaged build missing dist/traybin?)");
      return undefined;
    }
    try {
      const mod = (await import("systray2")) as unknown as {
        default: new (conf: unknown) => SysTrayLike;
      };
      SysTray = (conf) => new mod.default(conf);
    } catch (error) {
      log(`systray2 not available: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  let approvalListener: ((decision: "approved" | "denied") => void) | undefined;
  let currentPairing: PendingPairing | undefined;
  let statusText = "Starting…";

  const menu = () => ({
    icon: BLANK_ICON_BASE64,
    title: "Aksharo Bridge",
    tooltip: "Aksharo Bridge",
    items: [
      { title: statusText, tooltip: "", enabled: false, __id: STATUS_ITEM },
      currentPairing !== undefined
        ? {
            title: `Approve pairing (code ${currentPairing.code})`,
            tooltip: currentPairing.clientName,
            enabled: true,
            __id: APPROVE_ITEM,
          }
        : { title: "No pending pairing requests", tooltip: "", enabled: false, __id: APPROVE_ITEM },
      currentPairing !== undefined
        ? { title: "Deny pairing", tooltip: "", enabled: true, __id: DENY_ITEM }
        : { title: "Deny pairing", tooltip: "", enabled: false, __id: DENY_ITEM },
      { title: "Quit", tooltip: "", enabled: true, __id: QUIT_ITEM },
    ],
  });

  let started: SysTrayLike | undefined;
  try {
    started = SysTray({ menu: menu(), copyDir: true });
    await withTimeout(started.ready(), READY_TIMEOUT_MS, "tray did not become ready in time");
  } catch (error) {
    log(`native tray failed to start: ${error instanceof Error ? error.message : String(error)}`);
    // Best-effort: a helper process may already have spawned even though
    // `ready()` never resolved — do not leave it running in the background.
    try {
      await started?.kill(false);
    } catch {
      // Nothing to clean up, or already gone.
    }
    return undefined;
  }
  const tray = started;

  const idOf = (item: { __id?: string }): string | undefined => item.__id;

  void tray.onClick((action) => {
    const id = idOf(action.item as { __id?: string });
    if (id === QUIT_ITEM) {
      for (const listener of quitListeners) listener();
    } else if (id === APPROVE_ITEM && approvalListener !== undefined) {
      approvalListener("approved");
    } else if (id === DENY_ITEM && approvalListener !== undefined) {
      approvalListener("denied");
    }
  });
  tray.onError((error) => log(`tray error: ${error.message}`));
  tray.onExit(() => log("tray helper exited"));

  const refresh = (): void => {
    void tray
      .sendAction({ type: "update-menu", menu: menu() })
      .catch((error: unknown) => log(`tray refresh failed: ${String(error)}`));
  };

  const quitListeners = new Set<() => void>();
  const revokeListeners = new Set<(clientId: string) => void>();

  return {
    requestApproval(pairing: PendingPairing): Promise<"approved" | "denied"> {
      currentPairing = pairing;
      refresh();
      return new Promise((resolve) => {
        approvalListener = (decision) => {
          currentPairing = undefined;
          approvalListener = undefined;
          refresh();
          resolve(decision);
        };
      });
    },
    setStatus(status: string): void {
      statusText = status;
      refresh();
    },
    showNotification(_title: string, _body: string): void {
      // systray2 has no native notification API; the status line already
      // surfaces the same information, so this is a documented no-op here.
    },
    onQuitRequested(listener: () => void): void {
      quitListeners.add(listener);
    },
    onRevokeRequested(listener: (clientId: string) => void): void {
      revokeListeners.add(listener);
    },
    async close(): Promise<void> {
      await tray.kill(false);
    },
  };
}
