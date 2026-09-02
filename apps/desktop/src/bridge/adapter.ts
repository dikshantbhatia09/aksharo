import { BridgeCore } from "@montaj/bridge-core";
import type {
  BridgeClientConnectedEvent,
  PendingPairing,
  TrayController,
} from "@montaj/bridge-core";

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
 * **Interface gap resolved (C02b, per the C01b/C02 WP reports):**
 * `approvePairing`'s previous return type (`BridgePairResult`, a real
 * `clientId`/`expiresAt`) predated `bridge-core`'s actual protocol. In that
 * protocol, a tray/local approval only flips the pending pairing to
 * `"approved"`; the pairing client itself is the one that mints its
 * `clientId` and pair token, by calling `pair.confirm` afterwards over its
 * own connection (`PairingService.confirm`, `packages/bridge-core/src/
 * pairing.ts`). `approvePairing` therefore now returns
 * `{ pairingId, approved: true }` only. The desktop learns the real
 * `clientId` later, when `BridgeCore` emits `clientConnected` (fired from its
 * `pair.confirm` handler) — surfaced here as `onClientConnected`, and to the
 * renderer via the preload `bridge.onClientConnected` listener, so the tray/
 * menu can show "<client> connected" after the fact rather than synchronously.
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

/** Result of a tray/approval-window decision. `clientId` is never known synchronously
 * (see the module doc comment) — only `onClientConnected` observes it, later. */
export interface BridgePairApproval {
  readonly pairingId: string;
  readonly approved: true;
}

export interface BridgePairDenial {
  readonly pairingId: string;
  readonly approved: false;
}

/** Shape the tray/approval-window UI needs to render "Approve pairing for <client>?". */
export interface BridgePendingPairing {
  readonly pairingId: string;
  readonly clientKind: string;
  readonly clientName: string;
  /** 8-char base32 code (THREAT-MODEL T12), shown for the user to cross-check. */
  readonly code: string;
  readonly expiresAt: string; // ISO-8601
}

export interface BridgeClientConnected {
  readonly clientId: string;
  readonly clientKind: string;
}

/**
 * Minimal surface the desktop shell (tray, approval window, preload `bridge.*`,
 * mutual exclusion handshake with a standalone SEA bridge) needs from `bridge-core`.
 */
export interface BridgeAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Approves an in-flight pairing request (tray/approval-window "Approve" gesture). */
  approvePairing(pairingId: string): Promise<BridgePairApproval>;
  /** Denies an in-flight pairing request ("Deny" gesture, or the 60s approval-window timeout). */
  denyPairing(pairingId: string): Promise<BridgePairDenial>;
  getStatus(): BridgeStatusEvent;
  onStatusChange(listener: (event: BridgeStatusEvent) => void): () => void;
  /** Fires once per pairing request, synchronously with the tray gesture (brief §1). */
  onPairingRequested(listener: (pairing: BridgePendingPairing) => void): () => void;
  /** Fires once the pairing client completes `pair.confirm` and a real `clientId` exists. */
  onClientConnected(listener: (client: BridgeClientConnected) => void): () => void;
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
    async denyPairing() {
      throw new Error("bridge-core is not yet available (C01 not merged)");
    },
    getStatus() {
      return status;
    },
    onStatusChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onPairingRequested() {
      return () => {
        // Nothing ever fires; no-op unsubscribe.
      };
    },
    onClientConnected() {
      return () => {
        // Nothing ever fires; no-op unsubscribe.
      };
    },
  };
}

export interface CreateBridgeAdapterOptions {
  readonly relayUrl?: string;
  readonly deviceToken?: string;
  readonly log?: (line: Record<string, unknown>) => void;
}

/**
 * The real adapter: wraps a `BridgeCore` instance embedded in the desktop
 * process. The tray implementation this passes to `BridgeCore` is a thin
 * bridge to this adapter's own `approvePairing`/`denyPairing`/status surface
 * — C02's actual tray icon and approval window (`apps/desktop/src/tray`,
 * `src/main/pairing-window.ts`) drive approval through this `BridgeAdapter`,
 * not by talking to `bridge-core` directly.
 */
export function createBridgeAdapter(options: CreateBridgeAdapterOptions = {}): BridgeAdapter {
  const statusListeners = new Set<(event: BridgeStatusEvent) => void>();
  const pairingRequestedListeners = new Set<(pairing: BridgePendingPairing) => void>();
  const clientConnectedListeners = new Set<(client: BridgeClientConnected) => void>();
  const pairedClients: BridgePairedClient[] = [];
  // pairingId -> clientName, recorded on approval so the eventual `clientConnected`
  // event (which only carries pairingId/clientId/clientKind) can label the paired client.
  const awaitingConnection = new Map<string, { clientName: string }>();
  let status: BridgeStatusEvent = { status: "stopped", pairedClients: [] };
  let pending:
    { pairing: PendingPairing; resolve: (decision: "approved" | "denied") => void } | undefined;

  function emit(next: Partial<BridgeStatusEvent>): void {
    status = { ...status, pairedClients: [...pairedClients], ...next };
    for (const listener of statusListeners) listener(status);
  }

  const tray: TrayController = {
    requestApproval(pairing: PendingPairing): Promise<"approved" | "denied"> {
      return new Promise((resolve) => {
        pending = { pairing, resolve };
        const pendingForListeners: BridgePendingPairing = {
          pairingId: pairing.pairingId,
          clientKind: pairing.clientKind,
          clientName: pairing.clientName,
          code: pairing.code,
          expiresAt: new Date(pairing.expiresAt).toISOString(),
        };
        for (const listener of pairingRequestedListeners) listener(pendingForListeners);
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

  core.on("clientConnected", (event: BridgeClientConnectedEvent) => {
    const awaiting = awaitingConnection.get(event.pairingId);
    awaitingConnection.delete(event.pairingId);
    pairedClients.push({
      clientId: event.clientId,
      label: awaiting?.clientName ?? event.clientKind,
      pairedAt: new Date().toISOString(),
    });
    emit({});
    const client: BridgeClientConnected = {
      clientId: event.clientId,
      clientKind: event.clientKind,
    };
    for (const listener of clientConnectedListeners) listener(client);
  });

  return {
    async start(): Promise<void> {
      await core.start();
    },
    async stop(): Promise<void> {
      await core.stop();
      pending = undefined;
    },
    async approvePairing(pairingId: string): Promise<BridgePairApproval> {
      if (pending === undefined || pending.pairing.pairingId !== pairingId) {
        throw new Error("no pending pairing request to approve");
      }
      const { pairing, resolve } = pending;
      pending = undefined;
      resolve("approved");
      awaitingConnection.set(pairing.pairingId, { clientName: pairing.clientName });
      emit({});
      // See the module doc comment: the real `clientId` is never known here —
      // only once `onClientConnected` fires once the client itself confirms.
      return { pairingId: pairing.pairingId, approved: true };
    },
    async denyPairing(pairingId: string): Promise<BridgePairDenial> {
      if (pending === undefined || pending.pairing.pairingId !== pairingId) {
        throw new Error("no pending pairing request to deny");
      }
      const { resolve } = pending;
      pending = undefined;
      resolve("denied");
      emit({});
      return { pairingId, approved: false };
    },
    getStatus(): BridgeStatusEvent {
      return status;
    },
    onStatusChange(listener: (event: BridgeStatusEvent) => void): () => void {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onPairingRequested(listener: (pairing: BridgePendingPairing) => void): () => void {
      pairingRequestedListeners.add(listener);
      return () => pairingRequestedListeners.delete(listener);
    },
    onClientConnected(listener: (client: BridgeClientConnected) => void): () => void {
      clientConnectedListeners.add(listener);
      return () => clientConnectedListeners.delete(listener);
    },
  };
}
