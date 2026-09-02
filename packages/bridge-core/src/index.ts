import { EventEmitter } from "node:events";

import { loadOrCreateCertificate } from "./cert.js";
import { discoveryFilePath, generateBearerToken, writeDiscoveryFile } from "./discovery.js";
import { PairingService } from "./pairing.js";
import { BRIDGE_PROTOCOL_VERSION } from "./protocol.js";
import { RelayClient } from "./relay-client.js";
import { startLoopbackServer, type BridgeServerHandle, type RpcContext } from "./server.js";
import { createConsoleTray } from "./tray.js";

import type { BridgeCertificate } from "./cert.js";
import type { BridgeMethod } from "./protocol.js";
import type { TrayController } from "./tray.js";

/**
 * `bridge-core`'s public Node API (brief §5/§C02): the only surface `apps/bridge`
 * (the SEA wrapper) and the desktop shell (C02) are meant to import. Everything
 * else in this package (`protocol.ts`, `server.ts`, ...) is an implementation
 * detail this class wires together; C02 never reaches past it.
 *
 * Usage:
 * ```ts
 * const bridge = new BridgeCore({ relayUrl: "wss://api.aksharo.ai/bridge/relay", deviceToken });
 * bridge.on("status", (s) => console.log(s));
 * await bridge.start();
 * // ...
 * await bridge.stop();
 * ```
 */

export type BridgeStatus = "stopped" | "starting" | "running" | "error";

export interface BridgeCoreOptions {
  /** api gateway relay URL, e.g. `wss://api.aksharo.ai/bridge/relay`. Omit to disable relay (tests). */
  readonly relayUrl?: string;
  /** The device token from B08/A04 device registration. Required when `relayUrl` is set. */
  readonly deviceToken?: string;
  readonly tray?: TrayController;
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface BridgeCoreStatusEvent {
  readonly status: BridgeStatus;
  readonly port?: number;
  readonly certFingerprint?: string;
  readonly message?: string;
}

interface BridgeCoreEvents {
  status: [event: BridgeCoreStatusEvent];
  pairingRequested: [pairingId: string, clientName: string];
}

export class BridgeCore extends EventEmitter {
  // See `RelayClient` for why this is a typed override rather than a merged
  // `declare interface`.
  override on<K extends keyof BridgeCoreEvents>(
    event: K,
    listener: (...args: BridgeCoreEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof BridgeCoreEvents>(event: K, ...args: BridgeCoreEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  private readonly bearer: string;
  private readonly tray: TrayController;
  private readonly pairing: PairingService;
  private cert: BridgeCertificate | undefined;
  private server: BridgeServerHandle | undefined;
  private relay: RelayClient | undefined;
  private status: BridgeStatus = "stopped";

  constructor(private readonly options: BridgeCoreOptions = {}) {
    super();
    this.bearer = generateBearerToken();
    this.tray =
      options.tray ?? createConsoleTray((line) => options.log?.({ evt: "bridge.tray", line }));
    this.pairing = new PairingService(this.bearer, this.tray);
  }

  getStatus(): BridgeStatus {
    return this.status;
  }

  /** Starts the loopback server, writes the discovery file, and opens the relay tunnel. */
  async start(): Promise<void> {
    this.setStatus("starting");
    this.cert = await loadOrCreateCertificate();

    this.server = await startLoopbackServer({
      bearer: this.bearer,
      cert: this.cert,
      handleRpc: (method, params, context) => this.handleRpc(method, params, context),
      log: this.options.log,
    });

    writeDiscoveryFile({
      port: this.server.port,
      certFingerprint: this.cert.fingerprint,
      bearer: this.bearer,
      pid: process.pid,
      version: String(BRIDGE_PROTOCOL_VERSION),
      startedAt: new Date().toISOString(),
    });

    if (this.options.relayUrl !== undefined && this.options.deviceToken !== undefined) {
      this.relay = new RelayClient({
        url: this.options.relayUrl,
        deviceToken: this.options.deviceToken,
      });
      this.relay.connect();
    }

    this.setStatus("running", { port: this.server.port, certFingerprint: this.cert.fingerprint });
  }

  async stop(): Promise<void> {
    this.relay?.close();
    this.relay = undefined;
    await this.server?.close();
    this.server = undefined;
    this.setStatus("stopped");
  }

  /** Discovery file location, for a caller that wants to display it. */
  discoveryPath(): string {
    return discoveryFilePath();
  }

  requestPairingRevocation(clientId: string): void {
    this.pairing.revoke(clientId);
  }

  private setStatus(status: BridgeStatus, extra: Partial<BridgeCoreStatusEvent> = {}): void {
    this.status = status;
    this.emit("status", { status, ...extra });
  }

  private async handleRpc(
    method: BridgeMethod,
    params: unknown,
    context: RpcContext,
  ): Promise<unknown> {
    switch (method) {
      case "hello":
        return { bridgeVersion: BRIDGE_PROTOCOL_VERSION, sessionId: context.remoteAddress };
      case "pair.request": {
        const p = params as {
          clientKind: "web" | "desktop" | "premiere" | "ae" | "resolve";
          clientName: string;
          scopes: string[];
        };
        const pairing = this.pairing.request(p.clientKind, p.clientName, p.scopes);
        this.emit("pairingRequested", pairing.pairingId, pairing.clientName);
        return {
          pairingId: pairing.pairingId,
          code: pairing.code,
          expiresAt: new Date(pairing.expiresAt).toISOString(),
        };
      }
      case "pair.confirm": {
        const p = params as { pairingId: string; code?: string };
        const issued = this.pairing.confirm(p.pairingId, p.code);
        return {
          pairToken: this.pairing.encodePairToken(issued),
          clientId: issued.clientId,
          scopes: issued.scopes,
          expiresAt: new Date(issued.exp).toISOString(),
        };
      }
      case "session.exchange": {
        const p = params as { pairToken: string };
        const session = this.pairing.exchangeForSession(p.pairToken);
        context.clientId = session.clientId;
        context.scopes = session.scopes;
        return {
          sessionToken: session.sessionToken,
          clientId: session.clientId,
          scopes: session.scopes,
          expiresAt: new Date(session.exp).toISOString(),
        };
      }
      default:
        // Host/engine/fs/media/apply/events methods are wired by the consumer
        // (C02, C06/C08) via a richer handler; bridge-core's own default is a
        // documented stub so protocol conformance tests can exercise the shape.
        return {};
    }
  }
}

export * from "./protocol.js";
export * from "./security.js";
export * from "./discovery.js";
export * from "./keystore.js";
export * from "./cert.js";
export * from "./pairing.js";
export * from "./server.js";
export * from "./relay-client.js";
export * from "./tray.js";
