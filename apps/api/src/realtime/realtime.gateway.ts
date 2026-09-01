import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { ulid } from "ulid";
import { WebSocketServer, type WebSocket } from "ws";

import { queuePrefix } from "../jobs/jobs.config.js";
import { extractBearer } from "./auth/access-token.js";
import { AccessTokenService } from "./auth/access-token.service.js";
import { REALTIME_BUS } from "./realtime.bus.js";
import {
  BEARER_SUBPROTOCOL_PREFIX,
  CLOSE_CODES,
  ClientFrameSchema,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSES_BEFORE_CLOSE,
  MAX_ROOMS_PER_CONNECTION,
  REALTIME_PATH,
  REALTIME_SUBPROTOCOL,
  parseRoom,
  roomChannel,
  roomFromChannel,
} from "./realtime.protocol.js";
import { RoomAccessService } from "./room-access.service.js";

import type { AccessTokenClaims } from "./auth/access-token.js";
import type { RealtimeBus } from "./realtime.bus.js";
import type { RoomMessage, ServerFrame } from "./realtime.protocol.js";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

/** Largest frame a client may send. Subscribe lists are tiny; anything else is abuse. */
const MAX_CLIENT_FRAME_BYTES = 8 * 1024;

interface Connection {
  readonly id: string;
  readonly socket: WebSocket;
  readonly claims: AccessTokenClaims;
  readonly rooms: Set<string>;
  missedPongs: number;
}

/**
 * The `/realtime` WebSocket gateway (CONTRACTS §7).
 *
 * Attached to the HTTP server Nest already owns via a `noServer` `ws` instance and
 * an `upgrade` listener, rather than through `@nestjs/websockets`: the protocol is
 * three verbs (`subscribe`, `unsubscribe`, `ping`) and the adapter would add a
 * dependency and an abstraction for none of it.
 *
 * Responsibilities, in order:
 *  - **authenticate at the handshake.** No token, no socket — the upgrade is
 *    refused with 401 before a WebSocket exists at all.
 *  - **authorise every room join** through {@link RoomAccessService}.
 *  - **fan out across instances** through a {@link RealtimeBus}: publishes go to
 *    Redis and come back to every instance holding the room, this one included, so
 *    there is a single delivery path rather than a local shortcut and a remote one.
 *  - **heartbeat.** A server ping every {@link HEARTBEAT_INTERVAL_MS}; two missed
 *    pongs and the socket is terminated, because a half-open TCP connection looks
 *    exactly like an idle one.
 *
 * Protocol and reconnection semantics: `src/realtime/README.md`.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_FRAME_BYTES,
    handleProtocols: (protocols: Set<string>) =>
      protocols.has(REALTIME_SUBPROTOCOL) ? REALTIME_SUBPROTOCOL : false,
  });
  private readonly connections = new Map<string, Connection>();
  /** room -> connection ids on THIS instance. */
  private readonly rooms = new Map<string, Set<string>>();
  private readonly prefix = queuePrefix();
  private heartbeat?: NodeJS.Timeout;
  private upgradeListener?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private attachedTo?: HttpServer;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly tokens: AccessTokenService,
    private readonly access: RoomAccessService,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
  ) {}

  onApplicationBootstrap(): void {
    this.bus.onMessage((channel, payload) => {
      this.deliver(channel, payload);
    });
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
      // A unit-test module with no HTTP adapter: everything else still works, and
      // `attach()` can be called by hand.
      this.logger.debug("no HTTP server to attach to; realtime upgrades are not served");
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
      connection.socket.close(CLOSE_CODES.serverShutdown, "server shutting down");
    }
    this.connections.clear();
    this.rooms.clear();
    this.server.close();
    await this.bus.close();
  }

  /** Serve `/realtime` upgrades on `server`. Exposed so tests can attach directly. */
  attach(server: HttpServer): void {
    if (this.attachedTo === server) return;
    const listener = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
      void this.handleUpgrade(request, socket, head);
    };
    this.upgradeListener = listener;
    this.attachedTo = server;
    server.on("upgrade", listener);
  }

  /** Connections currently held by this instance. Diagnostics and tests. */
  get connectionCount(): number {
    return this.connections.size;
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const path = (request.url ?? "").split("?")[0];
    if (path !== REALTIME_PATH) {
      // Another gateway may own this path; only reject when nothing else can.
      if (this.attachedTo !== undefined && this.attachedTo.listenerCount("upgrade") > 1) return;
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const subprotocols = (request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");

    const token = extractBearer({
      authorization: request.headers.authorization,
      subprotocols,
      bearerPrefix: BEARER_SUBPROTOCOL_PREFIX,
    });
    const claims = token === undefined ? undefined : this.tokens.tryVerify(token);
    if (claims === undefined) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    this.server.handleUpgrade(request, socket, head, (socketInstance) => {
      this.register(socketInstance, claims);
    });
  }

  private register(socket: WebSocket, claims: AccessTokenClaims): void {
    const connection: Connection = {
      id: ulid(),
      socket,
      claims,
      rooms: new Set<string>(),
      missedPongs: 0,
    };
    this.connections.set(connection.id, connection);

    socket.on("pong", () => {
      connection.missedPongs = 0;
    });
    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      void this.onFrame(connection, raw);
    });
    socket.on("close", () => {
      void this.drop(connection);
    });
    socket.on("error", () => {
      void this.drop(connection);
    });

    send(socket, {
      t: "welcome",
      connectionId: connection.id,
      userId: claims.sub,
      workspaceId: claims.ws,
      heartbeatMs: HEARTBEAT_INTERVAL_MS,
      protocol: REALTIME_SUBPROTOCOL,
    });
  }

  // -------------------------------------------------------------------------
  // Client frames
  // -------------------------------------------------------------------------

  private async onFrame(
    connection: Connection,
    raw: Buffer | ArrayBuffer | Buffer[],
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toText(raw));
    } catch {
      send(connection.socket, {
        t: "error",
        code: "realtime/bad_frame",
        message: "Frame is not JSON.",
      });
      return;
    }

    const frame = ClientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      send(connection.socket, {
        t: "error",
        code: "realtime/bad_frame",
        message: "Unknown or malformed frame.",
      });
      return;
    }

    switch (frame.data.t) {
      case "ping":
        send(connection.socket, { t: "pong" });
        return;
      case "subscribe":
        await this.subscribe(connection, frame.data.rooms);
        return;
      case "unsubscribe":
        await this.unsubscribe(connection, frame.data.rooms);
        return;
    }
  }

  private async subscribe(connection: Connection, requested: readonly string[]): Promise<void> {
    const refused: { room: string; reason: string }[] = [];

    for (const room of requested) {
      if (connection.rooms.has(room)) continue;
      if (connection.rooms.size >= MAX_ROOMS_PER_CONNECTION) {
        refused.push({ room, reason: "too_many_rooms" });
        continue;
      }
      const parsedRoom = parseRoom(room);
      if (parsedRoom === undefined) {
        refused.push({ room, reason: "unknown_room" });
        continue;
      }
      const decision = await this.access.canJoin(connection.claims, parsedRoom);
      if (!decision.allowed) {
        refused.push({ room, reason: decision.reason });
        continue;
      }
      await this.join(connection, room);
    }

    send(connection.socket, {
      t: "subscribed",
      rooms: [...connection.rooms],
      ...(refused.length === 0 ? {} : { refused }),
    });
  }

  private async unsubscribe(connection: Connection, rooms: readonly string[]): Promise<void> {
    for (const room of rooms) await this.leave(connection, room);
    send(connection.socket, { t: "subscribed", rooms: [...connection.rooms] });
  }

  private async join(connection: Connection, room: string): Promise<void> {
    connection.rooms.add(room);
    const members = this.rooms.get(room);
    if (members === undefined) {
      this.rooms.set(room, new Set([connection.id]));
      // First socket for this room on this instance: start listening for it.
      await this.bus.subscribe(roomChannel(this.prefix, room));
      return;
    }
    members.add(connection.id);
  }

  private async leave(connection: Connection, room: string): Promise<void> {
    connection.rooms.delete(room);
    const members = this.rooms.get(room);
    if (members === undefined) return;
    members.delete(connection.id);
    if (members.size > 0) return;
    this.rooms.delete(room);
    await this.bus.unsubscribe(roomChannel(this.prefix, room));
  }

  private async drop(connection: Connection): Promise<void> {
    if (!this.connections.has(connection.id)) return;
    this.connections.delete(connection.id);
    for (const room of [...connection.rooms]) await this.leave(connection, room);
  }

  // -------------------------------------------------------------------------
  // Fan-out
  // -------------------------------------------------------------------------

  private deliver(channel: string, payload: string): void {
    const room = roomFromChannel(this.prefix, channel);
    if (room === undefined) return;
    const members = this.rooms.get(room);
    if (members === undefined || members.size === 0) return;

    let message: RoomMessage;
    try {
      message = JSON.parse(payload) as RoomMessage;
    } catch {
      this.logger.warn({ channel }, "dropping unparseable realtime payload");
      return;
    }

    const frame: ServerFrame = {
      t: "event",
      room,
      event: message.event,
      data: message.data,
      at: message.at,
    };
    for (const id of members) {
      const connection = this.connections.get(id);
      if (connection !== undefined) send(connection.socket, frame);
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined) return;
    this.heartbeat = setInterval(() => {
      this.sweep();
    }, HEARTBEAT_INTERVAL_MS);
    // A liveness timer must never be the reason a process refuses to exit.
    this.heartbeat.unref?.();
  }

  /** One heartbeat round. Exposed so a test can drive it without waiting 30 s. */
  sweep(): void {
    for (const connection of this.connections.values()) {
      if (connection.missedPongs >= HEARTBEAT_MISSES_BEFORE_CLOSE) {
        connection.socket.close(CLOSE_CODES.heartbeatTimeout, "heartbeat timeout");
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
}

function toText(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

function send(socket: WebSocket, frame: ServerFrame): void {
  // 1 === WebSocket.OPEN; comparing the numeric constant avoids importing the
  // class only to read a static.
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify(frame));
}

/** Refuse an upgrade with a real HTTP response, so a client sees a status, not a reset. */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
