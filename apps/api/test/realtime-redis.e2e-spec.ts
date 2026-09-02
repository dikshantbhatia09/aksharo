/**
 * The realtime fan-out over the **real** Redis (A08c).
 *
 * `realtime.e2e-spec.ts` runs the gateway over `InMemoryRealtimeBus`, which is
 * what let A08 ship a `RedisRealtimeBus` that could not subscribe at all: the
 * shared client is built with `lazyConnect: true` and `enableOfflineQueue: false`,
 * `duplicate()` inherits both, and the subscriber's first `SUBSCRIBE` was rejected
 * with `Stream isn't writeable and enableOfflineQueue options is false` before the
 * socket ever opened. Every test here is therefore on the production path:
 *
 * - the bus is the real `RedisRealtimeBus`;
 * - its connections come from the real `RedisService`, so the lazy/offline-queue
 *   options are the deployed ones rather than something this file chose;
 * - the two gateways hold **separate** `RedisService` instances, which is what
 *   makes them two API processes rather than one with two objects in it.
 *
 * Skips with an explanation when the compose Redis is not up
 * (`MONTAJ_SKIP_REDIS_TESTS=1` skips deliberately).
 */
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { type HttpAdapterHost } from "@nestjs/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { Env } from "@montaj/config";

import { createFakePrisma, FakeDb } from "./fakes.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { type PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { queuePrefix } from "../src/jobs/jobs.config.js";
import { AccessTokenService } from "../src/realtime/auth/access-token.service.js";
import { RedisRealtimeBus } from "../src/realtime/realtime.bus.js";
import { RealtimeGateway } from "../src/realtime/realtime.gateway.js";
import {
  BEARER_SUBPROTOCOL_PREFIX,
  REALTIME_PATH,
  REALTIME_SUBPROTOCOL,
  projectRoom,
  roomChannel,
  workspaceRoom,
} from "../src/realtime/realtime.protocol.js";
import { RealtimePublisher } from "../src/realtime/realtime.publisher.js";
import { RoomAccessService } from "../src/realtime/room-access.service.js";

const REDIS_READY = isRedisAvailable();
if (!REDIS_READY) {
  console.warn(`[realtime-redis.e2e] skipped — ${redisSkipReason}`);
}

const WS_ID = "01JCWS0000000000000000000A";
const USER = "01JCUS3R00000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

function token(): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signed = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    sub: USER,
    ws: WS_ID,
    role: "editor",
    kind: "web",
    jti: "01JCJT1000000000000000000A",
    iat: now,
    exp: now + 900,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signed);
  signer.end();
  return `${signed}.${signer.sign(privateKey).toString("base64url")}`;
}

/** A test client that queues frames so a test can await the next one. */
class Client {
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: ((frame: Record<string, unknown>) => void)[] = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.queue.push(frame);
      else waiter(frame);
    });
  }

  static async connect(port: number): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${REALTIME_PATH}`, [
      REALTIME_SUBPROTOCOL,
      `${BEARER_SUBPROTOCOL_PREFIX}${token()}`,
    ]);
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return client;
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  async next(timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

interface Instance {
  readonly name: string;
  readonly gateway: RealtimeGateway;
  readonly publisher: RealtimePublisher;
  readonly bus: RedisRealtimeBus;
  readonly redis: RedisService;
  readonly server: Server;
  readonly port: number;
}

const db = new FakeDb();
const instances: Instance[] = [];
const clients: Client[] = [];
const loose: RedisService[] = [];

/** A `RedisService` with the deployed options, pointed at the test Redis. */
function redisService(): RedisService {
  const service = new RedisService({ REDIS_URL: testRedisUrl() } as Env);
  loose.push(service);
  return service;
}

/** One API instance: its own Redis connections, bus, gateway and HTTP server. */
async function startInstance(name: string): Promise<Instance> {
  const server = createServer((_request, response) => {
    response.statusCode = 426;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const redis = redisService();
  const bus = new RedisRealtimeBus(redis);
  const gateway = new RealtimeGateway(
    { httpAdapter: { getHttpServer: () => server } } as unknown as HttpAdapterHost,
    new AccessTokenService({ JWT_PUBLIC_KEY: PEM_PUBLIC } as Env),
    new RoomAccessService(createFakePrisma(db) as unknown as PrismaService),
    bus,
  );
  gateway.onApplicationBootstrap();

  const instance: Instance = {
    name,
    gateway,
    publisher: new RealtimePublisher(bus),
    bus,
    redis,
    server,
    port: (server.address() as AddressInfo).port,
  };
  instances.push(instance);
  return instance;
}

async function connect(instance: Instance): Promise<Client> {
  const client = await Client.connect(instance.port);
  clients.push(client);
  await client.next(); // welcome
  return client;
}

/** Subscribe and assert the join, so a refusal fails here and not 5 s later. */
async function join(client: Client, room: string): Promise<void> {
  client.send({ t: "subscribe", rooms: [room] });
  await expect(client.next()).resolves.toMatchObject({ t: "subscribed", rooms: [room] });
}

let alpha: Instance;
let beta: Instance;

beforeAll(async () => {
  if (!REDIS_READY) return;
  db.memberships.push({ id: "m1", workspaceId: WS_ID, userId: USER, status: "active" });
  db.projects.push({ id: PROJECT, workspaceId: WS_ID, deletedAt: null });
  alpha = await startInstance("alpha");
  beta = await startInstance("beta");
}, 60_000);

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  if (!REDIS_READY) return;
  for (const instance of instances.splice(0)) {
    await instance.gateway.onApplicationShutdown();
    await new Promise<void>((resolve) => instance.server.close(() => resolve()));
  }
  for (const service of loose.splice(0)) await service.onModuleDestroy();
}, 30_000);

describe.skipIf(!REDIS_READY)("RedisRealtimeBus against a real Redis", () => {
  it("subscribes on a cold, lazily-connected duplicate (the A08c regression)", async () => {
    // The exact shape of the defect: a brand-new bus over a `RedisService` that
    // has never issued a command. Before the fix this rejected with
    // "Stream isn't writeable and enableOfflineQueue options is false".
    const bus = new RedisRealtimeBus(redisService());
    const channel = roomChannel(queuePrefix(), `workspace:${WS_ID}`);
    const seen: string[] = [];
    bus.onMessage((_channel, payload) => seen.push(payload));

    await expect(bus.subscribe(channel)).resolves.toBeUndefined();
    await bus.publish(channel, "hello");

    await expect.poll(() => seen, { timeout: 5_000 }).toEqual(["hello"]);
    await bus.close();
  });

  it("publishes from a cold shared client without dropping the event", async () => {
    const listener = new RedisRealtimeBus(redisService());
    const channel = roomChannel(queuePrefix(), `workspace:${WS_ID}`);
    const seen: string[] = [];
    listener.onMessage((_channel, payload) => seen.push(payload));
    await listener.subscribe(channel);

    // A separate instance whose very first Redis traffic is this publish.
    const publisher = new RedisRealtimeBus(redisService());
    await expect(publisher.publish(channel, "from a cold client")).resolves.toBeUndefined();

    await expect.poll(() => seen, { timeout: 5_000 }).toEqual(["from a cold client"]);
    await listener.close();
    await publisher.close();
  });

  it("stops delivering after unsubscribe", async () => {
    const bus = new RedisRealtimeBus(redisService());
    const channel = roomChannel(queuePrefix(), `project:${PROJECT}`);
    const seen: string[] = [];
    bus.onMessage((_channel, payload) => seen.push(payload));

    await bus.subscribe(channel);
    await bus.publish(channel, "one");
    await expect.poll(() => seen, { timeout: 5_000 }).toEqual(["one"]);

    await bus.unsubscribe(channel);
    await bus.publish(channel, "two");
    await bus.publish(channel, "three");
    // Nothing more arrives; give Redis a beat to prove it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual(["one"]);

    await bus.close();
  });

  it("unsubscribes safely on a connection that never came up", async () => {
    const bus = new RedisRealtimeBus(redisService());
    await expect(bus.unsubscribe("never:subscribed")).resolves.toBeUndefined();
    await bus.close();
  });
});

describe.skipIf(!REDIS_READY)("two gateway instances over one Redis", () => {
  it("delivers an event published on alpha to a socket held by beta", async () => {
    const client = await connect(beta);
    await join(client, projectRoom(PROJECT));

    expect(alpha.gateway.connectionCount).toBe(0);
    expect(beta.gateway.connectionCount).toBe(1);

    await alpha.publisher.jobCompleted(
      { workspaceId: WS_ID, projectId: PROJECT },
      { jobId: "01JCJOB0000000000000000001", status: "succeeded" },
    );

    await expect(client.next()).resolves.toMatchObject({
      t: "event",
      room: projectRoom(PROJECT),
      event: "job.completed",
      data: { jobId: "01JCJOB0000000000000000001", status: "succeeded" },
    });
  });

  it("delivers to sockets on both instances at once", async () => {
    const onAlpha = await connect(alpha);
    const onBeta = await connect(beta);
    await join(onAlpha, workspaceRoom(WS_ID));
    await join(onBeta, workspaceRoom(WS_ID));

    await beta.publisher.jobProgress(
      { workspaceId: WS_ID },
      { jobId: "01JCJOB0000000000000000002", progress: 42 },
    );

    for (const client of [onAlpha, onBeta]) {
      await expect(client.next()).resolves.toMatchObject({
        room: workspaceRoom(WS_ID),
        event: "job.progress",
        data: { jobId: "01JCJOB0000000000000000002", progress: 42 },
      });
    }
  });

  it("does not deliver a room the other instance is not subscribed to", async () => {
    const client = await connect(beta);
    await join(client, workspaceRoom(WS_ID));

    // alpha holds no socket in the project room, and beta joined only the
    // workspace room, so this reaches nobody.
    await alpha.publisher.edgOps(PROJECT, { revision: 3, ops: [], source: "web" });

    client.send({ t: "ping" });
    // The pong arriving first is what proves the event did not.
    await expect(client.next()).resolves.toEqual({ t: "pong" });
  });

  it("stops delivering to a socket that left the room", async () => {
    const client = await connect(beta);
    await join(client, projectRoom(PROJECT));

    client.send({ t: "unsubscribe", rooms: [projectRoom(PROJECT)] });
    await expect(client.next()).resolves.toEqual({ t: "subscribed", rooms: [] });

    await alpha.publisher.jobProgress(
      { workspaceId: WS_ID, projectId: PROJECT },
      { jobId: "01JCJOB0000000000000000003", progress: 90 },
    );

    client.send({ t: "ping" });
    await expect(client.next()).resolves.toEqual({ t: "pong" });
  });
});
