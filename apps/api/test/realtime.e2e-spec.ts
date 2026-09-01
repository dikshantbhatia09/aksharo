/**
 * `/realtime` end to end: a real HTTP server, a real `ws` client and two gateway
 * instances sharing one broker — with no infrastructure at all.
 *
 * The two gateways are the point of the last group: an event published on the
 * instance that has no socket for the room must still reach the socket held by the
 * other instance, which is exactly what breaks first behind a load balancer.
 */
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { type HttpAdapterHost } from "@nestjs/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { Env } from "@montaj/config";

import { createFakePrisma, FakeDb } from "./fakes.js";
import { type PrismaService } from "../src/common/prisma/prisma.service.js";
import { AccessTokenService } from "../src/realtime/auth/access-token.service.js";
import { InMemoryRealtimeBroker, InMemoryRealtimeBus } from "../src/realtime/realtime.bus.js";
import { RealtimeGateway } from "../src/realtime/realtime.gateway.js";
import {
  BEARER_SUBPROTOCOL_PREFIX,
  CLOSE_CODES,
  REALTIME_PATH,
  REALTIME_SUBPROTOCOL,
  projectRoom,
  workspaceRoom,
} from "../src/realtime/realtime.protocol.js";
import { RealtimePublisher } from "../src/realtime/realtime.publisher.js";
import { RoomAccessService } from "../src/realtime/room-access.service.js";


const WS_ID = "01JCWS0000000000000000000A";
const OTHER_WS = "01JCWS0000000000000000000B";
const USER = "01JCUSER00000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const OTHER_PROJECT = "01JCPR0JECT00000000000000B";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

function token(claims: Record<string, unknown> = {}): string {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: USER,
    ws: WS_ID,
    role: "editor",
    kind: "web",
    jti: "01JCJTI000000000000000000A",
    iat: now,
    exp: now + 900,
    ...claims,
  };
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signed = `${b64(header)}.${b64(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signed);
  signer.end();
  return `${signed}.${signer.sign(privateKey).toString("base64url")}`;
}

interface Frame {
  t: string;
  [key: string]: unknown;
}

/** A test client that queues frames so a test can await the next one. */
class Client {
  private readonly queue: Frame[] = [];
  private readonly waiters: ((frame: Frame) => void)[] = [];
  closeCode?: number;

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString("utf8")) as Frame;
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.queue.push(frame);
      else waiter(frame);
    });
    socket.on("close", (code: number) => {
      this.closeCode = code;
    });
  }

  static async connect(port: number, accessToken?: string): Promise<Client> {
    const protocols =
      accessToken === undefined
        ? [REALTIME_SUBPROTOCOL]
        : [REALTIME_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${accessToken}`];
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${REALTIME_PATH}`, protocols);
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        reject(new Error(`HTTP ${String(response.statusCode)}`));
      });
    });
    return client;
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  async next(timeoutMs = 3_000): Promise<Frame> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  async closed(timeoutMs = 3_000): Promise<number> {
    if (this.closeCode !== undefined) return this.closeCode;
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not close")), timeoutMs);
      this.socket.once("close", (code: number) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

interface Instance {
  gateway: RealtimeGateway;
  publisher: RealtimePublisher;
  server: Server;
  port: number;
}

const broker = new InMemoryRealtimeBroker();
const db = new FakeDb();
const clients: Client[] = [];
const instances: Instance[] = [];

async function startInstance(): Promise<Instance> {
  const server = createServer((_request, response) => {
    response.statusCode = 426;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const bus = new InMemoryRealtimeBus(broker);
  const prisma = createFakePrisma(db) as unknown as PrismaService;
  const gateway = new RealtimeGateway(
    { httpAdapter: { getHttpServer: () => server } } as unknown as HttpAdapterHost,
    new AccessTokenService({ JWT_PUBLIC_KEY: PEM_PUBLIC } as Env),
    new RoomAccessService(prisma),
    bus,
  );
  gateway.onApplicationBootstrap();

  const instance = { gateway, publisher: new RealtimePublisher(bus), server, port };
  instances.push(instance);
  return instance;
}

async function connect(port: number, accessToken = token()): Promise<Client> {
  const client = await Client.connect(port, accessToken);
  clients.push(client);
  return client;
}

let primary: Instance;

beforeAll(async () => {
  db.memberships.push({ id: "m1", workspaceId: WS_ID, userId: USER, status: "active" });
  db.projects.push({ id: PROJECT, workspaceId: WS_ID, deletedAt: null });
  db.projects.push({ id: OTHER_PROJECT, workspaceId: OTHER_WS, deletedAt: null });
  primary = await startInstance();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  for (const instance of instances) {
    await instance.gateway.onApplicationShutdown();
    await new Promise<void>((resolve) => instance.server.close(() => resolve()));
  }
});

describe("handshake", () => {
  it("refuses an upgrade with no token — before a WebSocket exists", async () => {
    await expect(Client.connect(primary.port)).rejects.toThrow(/401/);
    expect(primary.gateway.connectionCount).toBe(0);
  });

  it("refuses a token this server did not sign", async () => {
    const forged = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: USER, ws: WS_ID })).toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    const bad = `${header}.${payload}.${signer.sign(forged.privateKey).toString("base64url")}`;

    await expect(Client.connect(primary.port, bad)).rejects.toThrow(/401/);
  });

  it("refuses an expired token", async () => {
    const stale = token({ iat: 0, exp: Math.floor(Date.now() / 1000) - 3_600 });
    await expect(Client.connect(primary.port, stale)).rejects.toThrow(/401/);
  });

  it("accepts a valid token and greets the client", async () => {
    const client = await connect(primary.port);
    expect(client.socket.protocol).toBe(REALTIME_SUBPROTOCOL);
    await expect(client.next()).resolves.toMatchObject({
      t: "welcome",
      userId: USER,
      workspaceId: WS_ID,
      heartbeatMs: 30_000,
      protocol: REALTIME_SUBPROTOCOL,
    });
    expect(primary.gateway.connectionCount).toBe(1);
  });

  it("refuses an upgrade on any other path", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(primary.port)}/not-realtime`, [
      REALTIME_SUBPROTOCOL,
    ]);
    await expect(
      new Promise((resolve, reject) => {
        socket.once("open", () => resolve("open"));
        socket.once("error", reject);
        socket.once("unexpected-response", (_r, response) =>
          reject(new Error(`HTTP ${String(response.statusCode)}`)),
        );
      }),
    ).rejects.toThrow(/404/);
  });
});

describe("rooms", () => {
  it("joins the workspace bound into the token and its projects", async () => {
    const client = await connect(primary.port);
    await client.next();

    client.send({ t: "subscribe", rooms: [workspaceRoom(WS_ID), projectRoom(PROJECT)] });

    await expect(client.next()).resolves.toMatchObject({
      t: "subscribed",
      rooms: [workspaceRoom(WS_ID), projectRoom(PROJECT)],
    });
  });

  it("refuses another workspace's room and another workspace's project", async () => {
    const client = await connect(primary.port);
    await client.next();

    client.send({
      t: "subscribe",
      rooms: [workspaceRoom(OTHER_WS), projectRoom(OTHER_PROJECT), "bridge:whatever"],
    });

    const frame = (await client.next()) as { rooms: string[]; refused: { room: string; reason: string }[] };
    expect(frame.rooms).toEqual([]);
    expect(frame.refused).toEqual([
      { room: workspaceRoom(OTHER_WS), reason: "forbidden" },
      { room: projectRoom(OTHER_PROJECT), reason: "not_found" },
      { room: "bridge:whatever", reason: "unknown_room" },
    ]);
  });

  it("refuses everything once the membership is gone", async () => {
    const removed = db.memberships.splice(0, 1);
    try {
      const client = await connect(primary.port);
      await client.next();
      client.send({ t: "subscribe", rooms: [workspaceRoom(WS_ID)] });
      await expect(client.next()).resolves.toMatchObject({
        rooms: [],
        refused: [{ room: workspaceRoom(WS_ID), reason: "forbidden" }],
      });
    } finally {
      db.memberships.push(...removed);
    }
  });

  it("reports the complete room set, not a delta, after unsubscribe", async () => {
    const client = await connect(primary.port);
    await client.next();
    client.send({ t: "subscribe", rooms: [workspaceRoom(WS_ID), projectRoom(PROJECT)] });
    await client.next();

    client.send({ t: "unsubscribe", rooms: [projectRoom(PROJECT)] });
    await expect(client.next()).resolves.toEqual({
      t: "subscribed",
      rooms: [workspaceRoom(WS_ID)],
    });
  });
});

describe("frames", () => {
  it("answers ping with pong", async () => {
    const client = await connect(primary.port);
    await client.next();
    client.send({ t: "ping" });
    await expect(client.next()).resolves.toEqual({ t: "pong" });
  });

  it("rejects a bad frame without dropping the connection", async () => {
    const client = await connect(primary.port);
    await client.next();

    client.socket.send("not json");
    await expect(client.next()).resolves.toMatchObject({ t: "error", code: "realtime/bad_frame" });

    client.send({ t: "shutdown" });
    await expect(client.next()).resolves.toMatchObject({ t: "error", code: "realtime/bad_frame" });

    client.send({ t: "ping" });
    await expect(client.next()).resolves.toEqual({ t: "pong" });
  });
});

describe("delivery", () => {
  it("delivers job.progress and job.completed to a subscribed client", async () => {
    const client = await connect(primary.port);
    await client.next();
    client.send({ t: "subscribe", rooms: [projectRoom(PROJECT)] });
    await client.next();

    await primary.publisher.jobProgress(
      { workspaceId: WS_ID, projectId: PROJECT },
      { jobId: "01JCJOB0000000000000000000", progress: 55, etaMs: 8_000 },
    );

    const progress = await client.next();
    expect(progress).toMatchObject({
      t: "event",
      room: projectRoom(PROJECT),
      event: "job.progress",
      data: { jobId: "01JCJOB0000000000000000000", progress: 55, etaMs: 8_000 },
    });
    expect(Date.parse(String(progress["at"]))).not.toBeNaN();

    await primary.publisher.jobCompleted(
      { workspaceId: WS_ID, projectId: PROJECT },
      { jobId: "01JCJOB0000000000000000000", status: "succeeded" },
    );
    await expect(client.next()).resolves.toMatchObject({
      event: "job.completed",
      data: { status: "succeeded" },
    });
  });

  it("does not deliver to a client that left the room", async () => {
    const client = await connect(primary.port);
    await client.next();
    client.send({ t: "subscribe", rooms: [projectRoom(PROJECT)] });
    await client.next();
    client.send({ t: "unsubscribe", rooms: [projectRoom(PROJECT)] });
    await client.next();

    await primary.publisher.edgOps(PROJECT, { revision: 1, ops: [], source: "web" });
    client.send({ t: "ping" });
    // The pong arrives instead of the event, which is what proves nothing else did.
    await expect(client.next()).resolves.toEqual({ t: "pong" });
  });

  it("does not deliver a room the client never joined", async () => {
    const client = await connect(primary.port);
    await client.next();
    client.send({ t: "subscribe", rooms: [workspaceRoom(WS_ID)] });
    await client.next();

    await primary.publisher.commentAdded({
      commentId: "01JCCOMMENT000000000000000",
      projectId: PROJECT,
      authorId: USER,
      at: new Date().toISOString(),
    });
    client.send({ t: "ping" });
    await expect(client.next()).resolves.toEqual({ t: "pong" });
  });
});

describe("fan-out across two gateway instances", () => {
  it("delivers an event published on the instance holding no socket for the room", async () => {
    const secondary = await startInstance();

    const client = await connect(secondary.port);
    await client.next();
    client.send({ t: "subscribe", rooms: [projectRoom(PROJECT)] });
    await client.next();

    expect(primary.gateway.connectionCount).toBe(0);
    expect(secondary.gateway.connectionCount).toBe(1);

    // Published on the instance with no socket in that room at all.
    await primary.publisher.jobCompleted(
      { workspaceId: WS_ID, projectId: PROJECT },
      { jobId: "01JCJOB0000000000000000001", status: "failed" },
    );

    await expect(client.next()).resolves.toMatchObject({
      t: "event",
      room: projectRoom(PROJECT),
      event: "job.completed",
      data: { jobId: "01JCJOB0000000000000000001", status: "failed" },
    });
  });
});

describe("heartbeat", () => {
  it("closes a connection that never answers a ping", async () => {
    const client = await connect(primary.port);
    await client.next();
    // Stop the platform pong so the socket looks half-open.
    client.socket.pong = () => undefined;
    client.socket.removeAllListeners("ping");

    primary.gateway.sweep();
    primary.gateway.sweep();
    primary.gateway.sweep();

    await expect(client.closed()).resolves.toBe(CLOSE_CODES.heartbeatTimeout);
    expect(primary.gateway.connectionCount).toBe(0);
  });
});
