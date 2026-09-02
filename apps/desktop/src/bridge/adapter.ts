import { BridgeCore } from "@montaj/bridge-core";
import type { PendingPairing, TrayController } from "@montaj/bridge-core";

/**
 * Documented interface for the embedded local bridge (brief §6).
 *
 * C01 landed `@montaj/bridge-core` after this file was written against a
 * stub; `createBridgeAdapter` (C01b) is the real implementation, wrapping
 * `BridgeCore` start/stop/pairing/status. `createStubBridgeAdapter` stays for
 * now (still exercised by `adapter.test.ts`, and useful if a caller wants a
 * "bridge disabled" adapter without constructing a real `BridgeCore`).
 *
 * `BridgeAdapter` is the contract both sides (this adapter and C02's tray/
 * IPC/preload code) should agree on; do not change its shape without
 * re-checking with C02's owner.
 *
 * **Known interface gap (see the WP report):** `approvePairing`'s return type
 * (`BridgePairResult`, a real `clientId`/`expiresAt`) predates `bridge-core`'s
 * actual protocol. In that protocol, a tray/local approval only flips the
 * pending pairing to `"approved"`; the pairing client itself is the one that
 * mints its `clientId` and pair token, by calling `pair.confirm` afterwards
 * over its own connection (`PairingService.confirm`, `packages/bridge-core/
 * src/pairing.ts`). The approver never learns that `clientId` synchronously.
 * `createBridgeAdapter` below approves the pairing for real and returns the
 * `pairingId` in place of `clientId` (documented, not the wire `clientId`) —
 * flagged here rather than silently guessing a shape C02 hasn't confirmed.
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

export interface CreateBridgeAdapterOptions {
  readonly relayUrl?: string;
  readonly deviceToken?: string;
  readonly log?: (line: Record<string, unknown>) => void;
}

/**
 * The real adapter (C01b): wraps a `BridgeCore` instance embedded in the
 * desktop process. The tray implementation this passes to `BridgeCore` is a
 * thin bridge to this adapter's own `approvePairing`/status surface — C02's
 * actual tray icon (`apps/desktop/src/tray/index.ts`) drives approval through
 * this `BridgeAdapter`, not by talking to `bridge-core` directly.
 */
export function createBridgeAdapter(options: CreateBridgeAdapterOptions = {}): BridgeAdapter {
  const listeners = new Set<(event: BridgeStatusEvent) => void>();
  const pairedClients: BridgePairedClient[] = [];
  let status: BridgeStatusEvent = { status: "stopped", pairedClients: [] };
  let pending:
    { pairing: PendingPairing; resolve: (decision: "approved" | "denied") => void } | undefined;

  function emit(next: Partial<BridgeStatusEvent>): void {
    status = { ...status, pairedClients: [...pairedClients], ...next };
    for (const listener of listeners) listener(status);
  }

  const tray: TrayController = {
    requestApproval(pairing: PendingPairing): Promise<"approved" | "denied"> {
      return new Promise((resolve) => {
        pending = { pairing, resolve };
      });
    },
    setStatus(): void {
      // Desktop status is driven by `BridgeCore`'s own `status` event below,
      // not by the tray-gesture status string.
    },
    showNotification(): void {
      // C02's tray owns user-facing notifications; nothing to do here.
    },
    onQuitRequested(): void {
      // Quitting the whole desktop app is C02's menu ("Quit"), not this
      // adapter's concern.
    },
    onRevokeRequested(): void {
      // Revocation is driven by `BridgeAdapter` callers (the devices page /
      // tray "Revoke" action), not by a gesture bridge-core originates.
    },
  };

  const core = new BridgeCore({
    ...(options.relayUrl !== undefined ? { relayUrl: options.relayUrl } : {}),
    ...(options.deviceToken !== undefined ? { deviceToken: options.deviceToken } : {}),
    tray,
    ...(options.log !== undefined ? { log: options.log } : {}),
  });

  core.on("status", (event) => {
    emit({
      status: event.status,
      ...(event.port !== undefined ? { port: event.port } : {}),
      ...(event.message !== undefined ? { error: event.message } : { error: undefined }),
    });
  });

  return {
    async start(): Promise<void> {
      await core.start();
    },
    async stop(): Promise<void> {
      await core.stop();
      pending = undefined;
    },
    async approvePairing(pairCode: string): Promise<BridgePairResult> {
      if (pending === undefined) {
        throw new Error("no pending pairing request to approve");
      }
      if (pending.pairing.code !== pairCode) {
        throw new Error("pairing code does not match the pending request");
      }
      const { pairing, resolve } = pending;
      pending = undefined;
      resolve("approved");
      pairedClients.push({
        clientId: pairing.pairingId,
        label: pairing.clientName,
        pairedAt: new Date().toISOString(),
      });
      emit({});
      // See the module doc comment: `clientId` here is the pairing id, not
      // the wire `clientId` bridge-core mints once the pairing client itself
      // completes `pair.confirm` — that value is never observed locally.
      return {
        clientId: pairing.pairingId,
        expiresAt: new Date(pairing.expiresAt).toISOString(),
      };
    },
    getStatus(): BridgeStatusEvent {
      return status;
    },
    onStatusChange(listener: (event: BridgeStatusEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
