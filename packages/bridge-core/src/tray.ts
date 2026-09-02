import type { PendingPairing, TrayGesture } from "./pairing.js";

/**
 * The tray abstraction `apps/bridge` implements with a real system tray icon.
 * `bridge-core` never talks to a native tray API directly, so it stays testable
 * (and portable to the desktop shell, C02, which may host its own tray instead).
 */
export interface TrayController extends TrayGesture {
  setStatus(status: string): void;
  showNotification(title: string, body: string): void;
  onQuitRequested(listener: () => void): void;
  onRevokeRequested(listener: (clientId: string) => void): void;
}

/**
 * A console-based tray for headless environments (CI, servers, the SEA build's
 * default before a real tray module is wired in `apps/bridge`). Approval always
 * falls back to the 8-character code, matching the brief's documented headless
 * fallback path.
 */
export function createConsoleTray(
  log: (line: string) => void = (line) => console.warn(line),
): TrayController {
  return {
    requestApproval(pairing: PendingPairing): Promise<"approved" | "denied"> {
      log(
        `[bridge] pairing request from ${pairing.clientName} (${pairing.clientKind}); code: ${pairing.code}`,
      );
      return Promise.reject(new Error("no tray gesture available; use the code"));
    },
    setStatus(status: string): void {
      log(`[bridge] status: ${status}`);
    },
    showNotification(title: string, body: string): void {
      log(`[bridge] ${title}: ${body}`);
    },
    onQuitRequested(): void {
      // No tray menu to wire a quit item into; the SEA host handles SIGINT/SIGTERM.
    },
    onRevokeRequested(): void {
      // Nothing to revoke from headlessly; revocation still works via the web
      // devices page (B08) or a direct `PairingService.revoke` call.
    },
  };
}
