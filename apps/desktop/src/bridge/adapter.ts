/**
 * Documented interface for the embedded local bridge (brief §6).
 *
 * C01 ("Local bridge v2: `bridge-core` + Node SEA app...") is still `briefed`
 * on `docs/PLAN.md`, not merged to `main`, so there is no `@montaj/bridge-core`
 * package to import yet. This file defines the shape C02 needs and a stub
 * implementation so the rest of the desktop app (tray status, `bridge.pair`
 * preload call, IPC wiring) can be built and tested against it now.
 *
 * When C01 lands, replace `createStubBridgeAdapter` with an adapter that
 * wraps the real `bridge-core` start/stop/pairing/status API — the
 * `BridgeAdapter` interface below is the contract both sides should agree on;
 * do not change its shape without re-checking with C01.
 */

export type BridgeStatus = "stopped" | "starting" | "running" | "error";

export interface BridgePairedClient {
  clientId: string;
  label: string;
  pairedAt: string; // ISO-8601
}

export interface BridgeStatusEvent {
  status: BridgeStatus;
  port?: number;
  pairedClients: BridgePairedClient[];
  error?: string;
}

export interface BridgePairResult {
  clientId: string;
  /** 12h pair token per CONTRACTS-adjacent C01 design; opaque to the desktop shell. */
  expiresAt: string; // ISO-8601
}

/**
 * Minimal surface the desktop shell (tray, preload `bridge.pair`, mutual
 * exclusion handshake with a standalone SEA bridge) needs from `bridge-core`.
 */
export interface BridgeAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Approves an in-flight pairing request (tray "Approve pairing" gesture). */
  approvePairing(pairCode: string): Promise<BridgePairResult>;
  getStatus(): BridgeStatusEvent;
  onStatusChange(listener: (event: BridgeStatusEvent) => void): () => void;
}

/**
 * In-memory stand-in used until C01 ships. Never returns a "running" status
 * (so the tray / preload surface an honest "bridge unavailable" state instead
 * of a fake port) and rejects pairing with a clear, typed error.
 */
export function createStubBridgeAdapter(): BridgeAdapter {
  const listeners = new Set<(event: BridgeStatusEvent) => void>();
  let status: BridgeStatusEvent = { status: "stopped", pairedClients: [] };

  function emit(next: BridgeStatusEvent): void {
    status = next;
    for (const listener of listeners) listener(status);
  }

  return {
    async start() {
      emit({
        status: "error",
        pairedClients: [],
        error:
          "bridge-core is not yet available (C01 not merged); desktop bridge features are disabled",
      });
    },
    async stop() {
      emit({ status: "stopped", pairedClients: [] });
    },
    async approvePairing() {
      throw new Error("bridge-core is not yet available (C01 not merged)");
    },
    getStatus() {
      return status;
    },
    onStatusChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
