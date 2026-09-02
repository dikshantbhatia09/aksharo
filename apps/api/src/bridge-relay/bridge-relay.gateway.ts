import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { ulid } from "ulid";
import { WebSocketServer, type WebSocket } from "ws";

import {
  BRIDGE_RELAY_BEARER_PREFIX,
  BRIDGE_RELAY_PATH,
  BRIDGE_RELAY_SUBPROTOCOL,
  ClientAttachFrameSchema,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSES_BEFORE_CLOSE,
  MAX_RELAY_FRAME_BYTES,
  RELAY_CLOSE_CODES,
} from "./bridge-relay.protocol.js";
import { RelayRateLimiter } from "./relay-rate-limiter.js";
import { PrismaService } from "../common/index.js";
import { extractBearer } from "../realtime/auth/access-token.js";
import { AccessTokenService } from "../realtime/auth/access-token.service.js";

import type { AccessTokenClaims } from "../realtime/auth/access-token.js";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

interface BridgeConnection {
  readonly kind: "bridge";
  readonly id: string;
  readonly socket: WebSocket;
  readonly claims: AccessTokenClaims;
  readonly sessionRowId: string;
  missedPongs: number;
  peer?: ClientConnection;
}

interface ClientConnection {
  readonly kind: "client";
  readonly id: string;
  readonly socket: WebSocket;
  readonly claims: AccessTokenClaims;
  readonly sessionRowId: string;
  missedPongs: number;
  peer?: BridgeConnection;
}

type Connection = BridgeConnection | ClientConnection;

/**
 * `/bridge/relay` (C01 brief §3): relays JSON-RPC frames between exactly one
 * bridge connection and one client connection per pairing, scoped to a
 * workspace, without ever parsing or storing the payload.
 *
 * Structurally this mirrors `realtime/realtime.gateway.ts` (a `noServer` `ws`
 * instance attached to Nest's own HTTP server via the `upgrade` event) rather
 * than reusing it, because the two protocols differ in shape: realtime fans one
 * publish out to many room members, the bridge relay pairs exactly two sockets
 * and forwards opaque bytes between them.
 */
@Injectable()
export class BridgeRelayGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BridgeRelayGateway.name);
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RELAY_FRAME_BYTES,
  });
  private readonly connections = new Map<string, Connection>();
  /** `workspaceId:deviceId` -> the bridge connection currently registered for it. */
  private readonly bridgesByDevice = new Map<string, BridgeConnection>();
  private readonly rateLimiter = new RelayRateLimiter({ windowMs: 10_000, max: 200 });
  private heartbeat?: NodeJS.Timeout;
  private upgradeListener?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private attachedTo?: HttpServer;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly tokens: AccessTokenService,
    private readonly prisma: PrismaService,
  ) {}

  onApplicationBootstrap(): void {
    this.startHeartbeat();
    const httpServer: unknown = this.adapterHost.httpAdapter?.getHttpServer();
    if (
      httpServer !== undefined &&
      httpServer !== null &&
      typeof httpServer === "object" &&
      "on" in httpServer
    ) {
      this.attach(httpServer as HttpServer);
    } else {
      this.logger.debug("no HTTP server to attach to; bridge-relay upgrades are not served");
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.attachedTo !== undefined && this.upgradeListener !== undefined) {
      this.attachedTo.off("upgrade", this.upgradeListener);
      this.attachedTo = undefined;
      this.upgradeListener = undefined;
    }
    for (const connection of this.connections.values()) {
      connection.socket.close(RELAY_CLOSE_CODES.serverShutdown, "server shutting down");
    }
    this.connections.clear();
    this.bridgesByDevice.clear();
    this.server.close();
  }

  attach(server: HttpServer): void {
    if (this.attachedTo === server) return;
    const listener = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
      void this.handleUpgrade(request, socket, head);
    };
    this.upgradeListener = listener;
    this.attachedTo = server;
    server.on("upgrade", listener);
  }

  /** Diagnostics/admin visibility (B13 hook): live counts, never payloads. */
  getStats(): { readonly connections: number; readonly pairedBridges: number } {
    let paired = 0;
    for (const connection of this.connections.values()) {
      if (connection.peer !== undefined) paired += 1;
    }
    return { connections: this.connections.size, pairedBridges: paired / 2 };
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const path = (request.url ?? "").split("?")[0];
    if (path !== BRIDGE_RELAY_PATH) {
      if (this.attachedTo !== undefined && this.attachedTo.listenerCount("upgrade") > 1) return;
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const subprotocols = (request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
    const token = extractBearer({
      authorization: request.headers.authorization,
      subprotocols,
      bearerPrefix: BRIDGE_RELAY_BEARER_PREFIX,
    });
    const claims = token === undefined ? undefined : this.tokens.tryVerify(token);
    if (claims === undefined) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (claims.kind === "bridge" && (claims.deviceId === undefined || claims.deviceId === "")) {
      // CONTRACTS §5 (amended after C01, B08b): a bridge token always carries
      // `deviceId`. One without it predates the per-device credential (or was
      // forged) and is refused before it ever reaches the connection map.
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    const remote = request.socket.remoteAddress ?? "unknown";
    if (!this.rateLimiter.consume(remote)) {
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }

    this.server.handleUpgrade(request, socket, head, (socketInstance) => {
      void this.register(socketInstance, claims);
    });
  }

  private register(socket: WebSocket, claims: AccessTokenClaims): void {
    // Registration (the connection map, the bridge-by-device index, and the
    // socket's own listeners) happens synchronously, before the `bridge_sessions`
    // audit write: a client's `attach` can arrive within microseconds of the
    // bridge's own handshake completing, and awaiting the database first left a
    // real race where the client's attach found no registered bridge yet.
    const id = ulid();
    const sessionRowId = ulid();
    const connection: Connection =
      claims.kind === "bridge"
        ? { kind: "bridge", id, socket, claims, sessionRowId, missedPongs: 0 }
        : { kind: "client", id, socket, claims, sessionRowId, missedPongs: 0 };
    this.connections.set(id, connection);

    if (connection.kind === "bridge" && claims.deviceId !== undefined) {
      // B08b: keyed by the token's own `deviceId` (CONTRACTS §5), not by
      // `sub` — `handleUpgrade` already refused any bridge token that lacks
      // one, so this is always present here. Multiple devices for the same
      // user each get their own slot; a second connection for the SAME
      // device replaces the first's registration exactly as a reconnect
      // would.
      const key = deviceKey(claims.ws, claims.deviceId);
      this.bridgesByDevice.set(key, connection);
    }

    socket.on("pong", () => {
      connection.missedPongs = 0;
    });
    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      void this.onFrame(connection, raw).catch((error: unknown) => {
        this.logger.warn(
          { connectionId: connection.id, err: describeError(error) },
          "bridge-relay frame handler failed",
        );
      });
    });
    socket.on("close", () => {
      void this.drop(connection);
    });
    socket.on("error", () => {
      void this.drop(connection);
    });

    void this.prisma.bridgeSession
      .create({
        data: {
          id: sessionRowId,
          workspaceId: claims.ws,
          clientKind: claims.kind,
          deviceId: claims.deviceId ?? null,
        },
      })
      .catch((error: unknown) => {
        // The audit row is best effort by design (brief §3: "the relay never
        // stores payloads" — nor does it gate relaying on the audit trail); a
        // failed insert costs one missing row, not a broken pairing.
        this.logger.warn(
          { connectionId: id, err: describeError(error) },
          "could not record bridge-relay connect",
        );
      });
  }

  private async onFrame(
    connection: Connection,
    raw: Buffer | ArrayBuffer | Buffer[],
  ): Promise<void> {
    const text = toText(raw);
    if (Buffer.byteLength(text, "utf8") > MAX_RELAY_FRAME_BYTES) {
      connection.socket.close(1009, "message too large");
      return;
    }

    if (connection.kind === "client" && connection.peer === undefined) {
      // The client's first frame must be `attach`; everything else is opaque
      // and forwarded without inspection.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        connection.socket.close(RELAY_CLOSE_CODES.protocolError, "expected attach frame");
        return;
      }
      const attach = ClientAttachFrameSchema.safeParse(parsed);
      if (!attach.success) {
        connection.socket.close(RELAY_CLOSE_CODES.protocolError, "expected attach frame");
        return;
      }
      const bridge = this.bridgesByDevice.get(
        deviceKey(connection.claims.ws, attach.data.deviceId),
      );
      if (bridge === undefined || bridge.claims.ws !== connection.claims.ws) {
        connection.socket.close(RELAY_CLOSE_CODES.peerUnavailable, "bridge not connected");
        return;
      }
      if (bridge.peer !== undefined) {
        // A bridge accepts one paired client session at a time; a second
        // attach is refused rather than silently displacing the first.
        connection.socket.close(RELAY_CLOSE_CODES.peerUnavailable, "bridge already paired");
        return;
      }
      connection.peer = bridge;
      bridge.peer = connection;
      send(connection.socket, JSON.stringify({ t: "attached" }));
      return;
    }

    if (connection.peer === undefined) {
      connection.socket.close(RELAY_CLOSE_CODES.peerUnavailable, "not paired");
      return;
    }

    send(connection.peer.socket, text);
    await this.prisma.bridgeSession.update({
      where: { id: connection.sessionRowId },
      data: { framesRelayed: { increment: 1 } },
    });
  }

  private async drop(connection: Connection): Promise<void> {
    if (!this.connections.has(connection.id)) return;
    this.connections.delete(connection.id);
    if (connection.kind === "bridge" && connection.claims.deviceId !== undefined) {
      const key = deviceKey(connection.claims.ws, connection.claims.deviceId);
      if (this.bridgesByDevice.get(key) === connection) this.bridgesByDevice.delete(key);
    }
    const peer = connection.peer;
    if (peer !== undefined) {
      // `peer.peer`'s static type is the *other* union member (a bridge's peer
      // is typed `ClientConnection | undefined` and vice versa), so clearing it
      // generically needs one cast; both branches do the same clear-and-close.
      if (peer.kind === "bridge") peer.peer = undefined;
      else peer.peer = undefined;
      peer.socket.close(RELAY_CLOSE_CODES.peerUnavailable, "peer disconnected");
    }
    try {
      await this.prisma.bridgeSession.update({
        where: { id: connection.sessionRowId },
        data: { disconnectedAt: new Date() },
      });
    } catch (error) {
      this.logger.debug({ err: describeError(error) }, "could not record bridge-relay disconnect");
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined) return;
    this.heartbeat = setInterval(() => {
      this.sweep();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  sweep(): void {
    for (const connection of this.connections.values()) {
      if (connection.missedPongs >= HEARTBEAT_MISSES_BEFORE_CLOSE) {
        connection.socket.close(RELAY_CLOSE_CODES.heartbeatTimeout, "heartbeat timeout");
        void this.drop(connection);
        continue;
      }
      connection.missedPongs += 1;
      try {
        connection.socket.ping();
      } catch {
        void this.drop(connection);
      }
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }
}

function deviceKey(workspaceId: string, deviceId: string): string {
  return `${workspaceId}:${deviceId}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toText(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

function send(socket: WebSocket, text: string): void {
  if (socket.readyState !== 1) return;
  socket.send(text);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export { BRIDGE_RELAY_PATH, BRIDGE_RELAY_SUBPROTOCOL };
