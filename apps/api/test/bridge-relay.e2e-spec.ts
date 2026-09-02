/**
 * `/bridge/relay` end to end (C01 brief §7 "relay e2e (fake bridge + fake
 * browser client through the api)"): a real HTTP server, two real `ws` clients
 * standing in for the local bridge process and a browser/plugin client, and a
 * real Postgres for the `bridge_sessions` audit rows.
 *
 * Needs Postgres (CONTRACTS §9 / A23a): skips loudly when none is reachable.
 */
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { type HttpAdapterHost } from "@nestjs/core";
import { type PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { Env } from "@montaj/config";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { BridgeRelayGateway } from "../src/bridge-relay/bridge-relay.gateway.js";
import {
  BRIDGE_RELAY_BEARER_PREFIX,
  BRIDGE_RELAY_PATH,
  BRIDGE_RELAY_SUBPROTOCOL,
  RELAY_CLOSE_CODES,
} from "../src/bridge-relay/bridge-relay.protocol.js";
import { type PrismaService } from "../src/common/prisma/prisma.service.js";
import { AccessTokenService } from "../src/realtime/auth/access-token.service.js";

import type { TestDatabase } from "./db-harness.js";

const DB_READY = isDatabaseAvailable();
if (!DB_READY) console.warn(`[bridge-relay.e2e] skipped — database: ${skipReason}`);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function crockford(value: number, length: number): string {
  let out = "";
  let remaining = value;
  while (remaining > 0) {
    out = `${CROCKFORD[remaining % 32] ?? "0"}${out}`;
    remaining = Math.floor(remaining / 32);
  }
  return out.padStart(length, "0").slice(-length);
}
const RUN = crockford(Date.now(), 10);
const id = (kind: string): string => `01JE${kind}${RUN}`.padEnd(26, "0").slice(0, 26);

const WORKSPACE = id("WS01");
const OTHER_WORKSPACE = id("WSX1");
const ADMIN = id("USR1");
const BRIDGE_DEVICE = id("DEV1");
const BRIDGE_DEVICE_2 = id("DEV2");

function token(claims: Record<string, unknown> = {}): string {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: ADMIN,
    ws: WORKSPACE,
    role: "owner",
    kind: "web",
    jti: id("JTI1"),
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

/**
 * `sub` is the user id, exactly like every other kind — B08b's fix is that
 * pairing keys off the token's own `deviceId` claim (CONTRACTS §5), not
 * `sub`, so two devices for the SAME user pair independently (see "two
 * devices, one user" below).
 */
function bridgeToken(deviceId: string, claims: Record<string, unknown> = {}): string {
  return token({ kind: "bridge", deviceId, ...claims });
}

class TestSocket {
  private readonly queue: string[] = [];
  private readonly waiters: ((frame: string) => void)[] = [];
  closeCode?: number;

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: Buffer) => {
      const text = raw.toString("utf8");
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.queue.push(text);
      else waiter(text);
    });
    socket.on("close", (code: number) => {
      this.closeCode = code;
    });
  }

  static async connect(port: number, accessToken: string): Promise<TestSocket> {
    const protocols = [BRIDGE_RELAY_SUBPROTOCOL, `${BRIDGE_RELAY_BEARER_PREFIX}${accessToken}`];
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${BRIDGE_RELAY_PATH}`, protocols);
    const client = new TestSocket(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("unexpected-response", (_r, response) =>
        reject(new Error(`HTTP ${String(response.statusCode)}`)),
      );
    });
    return client;
  }

  send(text: string): void {
    this.socket.send(text);
  }

  async next(timeoutMs = 3_000): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    return new Promise<string>((resolve, reject) => {
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

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let server: Server;
let port: number;
let gateway: BridgeRelayGateway;
const sockets: TestSocket[] = [];

async function connect(accessToken: string): Promise<TestSocket> {
  const socket = await TestSocket.connect(port, accessToken);
  sockets.push(socket);
  return socket;
}

(DB_READY ? describe : describe.skip)("bridge-relay e2e", () => {
  beforeAll(async () => {
    db = await createTestDatabase();
    if (db === null) throw new Error(`could not start a test database: ${skipReason}`);
    prisma = db.prisma;

    await prisma.user.create({
      data: { id: ADMIN, email: `c01-${RUN}@example.test`, isAdmin: false },
    });
    await prisma.workspace.create({
      data: {
        id: WORKSPACE,
        slug: `c01-${RUN}`,
        name: "C01",
        ownerId: ADMIN,
        billingCountry: "IN",
      },
    });
    await prisma.workspace.create({
      data: {
        id: OTHER_WORKSPACE,
        slug: `c01x-${RUN}`,
        name: "C01 other",
        ownerId: ADMIN,
        billingCountry: "IN",
      },
    });

    // The relay keys pairing by `deviceId` (B08b); `bridge_sessions.device_id`
    // is a real FK to `devices`, so the bridge tokens' claimed device ids must
    // name actual B08 device rows, exactly as `POST /devices/{id}/bridge-token`
    // guarantees in production.
    await prisma.device.createMany({
      data: [
        {
          id: BRIDGE_DEVICE,
          workspaceId: WORKSPACE,
          userId: ADMIN,
          name: "Bridge device 1",
          platform: "macOS 15",
          host: "desktop",
          fingerprint: `c01-fp-1-${RUN}`,
          leaseUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        {
          id: BRIDGE_DEVICE_2,
          workspaceId: WORKSPACE,
          userId: ADMIN,
          name: "Bridge device 2",
          platform: "macOS 15",
          host: "desktop",
          fingerprint: `c01-fp-2-${RUN}`,
          leaseUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      ],
    });

    server = createServer((_req, res) => {
      res.statusCode = 426;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;

    gateway = new BridgeRelayGateway(
      { httpAdapter: { getHttpServer: () => server } } as unknown as HttpAdapterHost,
      new AccessTokenService({ JWT_PUBLIC_KEY: PEM_PUBLIC } as Env),
      prisma as unknown as PrismaService,
    );
    gateway.onApplicationBootstrap();
  }, 60_000);

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  afterAll(async () => {
    await gateway.onApplicationShutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db?.stop();
  });

  it("refuses an upgrade with no bearer", async () => {
    await expect(TestSocket.connect(port, "")).rejects.toThrow(/401/);
  });

  it("refuses a bridge token without a deviceId (CONTRACTS §5, B08b)", async () => {
    // The pre-B08b shape: `kind:"bridge"` with only `sub`, no `deviceId`.
    await expect(TestSocket.connect(port, token({ kind: "bridge" }))).rejects.toThrow(/403/);
  });

  it("two devices, one user: both attach and relay independently (B08b)", async () => {
    const bridge1 = await connect(bridgeToken(BRIDGE_DEVICE));
    const bridge2 = await connect(bridgeToken(BRIDGE_DEVICE_2));
    const client1 = await connect(token());
    const client2 = await connect(token());

    client1.send(JSON.stringify({ t: "attach", deviceId: BRIDGE_DEVICE }));
    await expect(client1.next()).resolves.toBe(JSON.stringify({ t: "attached" }));
    client2.send(JSON.stringify({ t: "attach", deviceId: BRIDGE_DEVICE_2 }));
    await expect(client2.next()).resolves.toBe(JSON.stringify({ t: "attached" }));

    client1.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "one", params: {} }));
    await expect(bridge1.next()).resolves.toBe(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "one", params: {} }),
    );
    client2.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "two", params: {} }));
    await expect(bridge2.next()).resolves.toBe(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "two", params: {} }),
    );

    // Each bridge only ever hears frames meant for it.
    bridge1.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "from-1" }));
    await expect(client1.next()).resolves.toBe(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "from-1" }),
    );
    bridge2.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "from-2" }));
    await expect(client2.next()).resolves.toBe(
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: "from-2" }),
    );
  });

  it("relays a frame from a client to its paired bridge and back", async () => {
    const bridge = await connect(bridgeToken(BRIDGE_DEVICE));
    const client = await connect(token());

    client.send(JSON.stringify({ t: "attach", deviceId: BRIDGE_DEVICE }));
    await expect(client.next()).resolves.toBe(JSON.stringify({ t: "attached" }));

    client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: {} }));
    await expect(bridge.next()).resolves.toBe(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: {} }),
    );

    bridge.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { bridgeVersion: 1 } }));
    await expect(client.next()).resolves.toBe(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { bridgeVersion: 1 } }),
    );
  });

  it("refuses attach to a bridge in a different workspace", async () => {
    await connect(bridgeToken(BRIDGE_DEVICE));
    const client = await connect(token({ ws: OTHER_WORKSPACE }));
    client.send(JSON.stringify({ t: "attach", deviceId: BRIDGE_DEVICE }));
    await expect(client.closed()).resolves.toBe(RELAY_CLOSE_CODES.peerUnavailable);
  });

  it("refuses attach to a bridge device that never connected", async () => {
    const client = await connect(token());
    client.send(JSON.stringify({ t: "attach", deviceId: "no-such-device" }));
    await expect(client.closed()).resolves.toBe(RELAY_CLOSE_CODES.peerUnavailable);
  });

  it("closes an oversized frame", async () => {
    const bridge = await connect(bridgeToken(BRIDGE_DEVICE));
    const client = await connect(token());
    client.send(JSON.stringify({ t: "attach", deviceId: BRIDGE_DEVICE }));
    await client.next();

    client.send("x".repeat(600 * 1024));
    await expect(client.closed()).resolves.toBe(1009);
    void bridge;
  });

  it("closes the peer when one side disconnects", async () => {
    const bridge = await connect(bridgeToken(BRIDGE_DEVICE));
    const client = await connect(token());
    client.send(JSON.stringify({ t: "attach", deviceId: BRIDGE_DEVICE }));
    await client.next();

    bridge.close();
    await expect(client.closed()).resolves.toBe(RELAY_CLOSE_CODES.peerUnavailable);
  });

  it("writes a bridge_sessions audit row on connect and marks it disconnected on close", async () => {
    const before = await prisma.bridgeSession.count({ where: { workspaceId: WORKSPACE } });
    const bridge = await connect(bridgeToken(BRIDGE_DEVICE));
    // The audit write is fire-and-forget relative to registration (so a slow
    // insert can never race a client's `attach`); give it a moment to land.
    // `>=` rather than `===`: earlier tests in this file open bridge/client
    // sockets of their own, whose audit inserts are also fire-and-forget and
    // can still be landing when this test's `before` count is taken.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await prisma.bridgeSession.count({ where: { workspaceId: WORKSPACE } });
    expect(after).toBeGreaterThanOrEqual(before + 1);

    // Count-based, not "the latest row" by `connectedAt`: earlier tests in
    // this file leave their own bridge connections closing (their sockets
    // close in `afterEach`, but the server-side `disconnectedAt` update runs
    // off that same close event and is not ordered against this test), so two
    // rows can share a `connectedAt` close enough that ordering is not a
    // reliable way to pick out this test's own row.
    const disconnectedBefore = await prisma.bridgeSession.count({
      where: { workspaceId: WORKSPACE, clientKind: "bridge", disconnectedAt: { not: null } },
    });
    bridge.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const disconnectedAfter = await prisma.bridgeSession.count({
      where: { workspaceId: WORKSPACE, clientKind: "bridge", disconnectedAt: { not: null } },
    });
    expect(disconnectedAfter).toBeGreaterThanOrEqual(disconnectedBefore + 1);
  });

  it("exposes live stats for admin visibility (B13 hook)", async () => {
    const bridge = await connect(bridgeToken(BRIDGE_DEVICE));
    const client = await connect(token());
    client.send(JSON.stringify({ t: "attach", deviceId: BRIDGE_DEVICE }));
    await client.next();

    // Absolute lower bounds, not a delta from a "before" snapshot: `afterEach`
    // closes sockets client-side, but the gateway's own connection-map cleanup
    // runs off the server-side `close` event and is not guaranteed to have
    // finished by the time the next test starts.
    const stats = gateway.getStats();
    expect(stats.connections).toBeGreaterThanOrEqual(2);
    expect(stats.pairedBridges).toBeGreaterThanOrEqual(1);
    void bridge;
  });
});
