/**
 * `POST /devices/{id}/bridge-token` (B08b, CONTRACTS §5 amended 2026-09-03
 * after C01): minting a `kind:"bridge"` device credential from a registered,
 * leased B08 device, and the guard rail that stops a bridge token from
 * reaching an ordinary route.
 */
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createB08TestContext, b08SkipReason, type B08TestContext } from "./b08-harness.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";

import type { INestApplication } from "@nestjs/common";
import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) console.warn(`[devices-bridge-token.e2e] skipped: ${skipReason}`);

function decodePayload(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split(".");
  return JSON.parse(Buffer.from(payload as string, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe.skipIf(!available)("B08b: per-device bridge credential", () => {
  let ctx: B08TestContext;
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const created = await createB08TestContext();
    if (created === null) throw new Error(`harness unavailable: ${b08SkipReason}`);
    ctx = created;
    app = ctx.app;
    server = app.getHttpServer() as Server;
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  afterEach(async () => {
    await ctx?.reset();
  });

  const auth = (token: string) => `Bearer ${token}`;

  function deviceBody(fingerprint: string, name = "Bridge host") {
    return {
      fingerprint,
      name,
      platform: "macOS 15",
      host: "desktop" as const,
      appVersion: "1.0.0",
    };
  }

  it('mints a kind:"bridge" token carrying deviceId for a registered, leased device', async () => {
    const c = ctx;
    const sessionToken = await c.sessionToken(c.ownerId, "owner", c.teamWorkspaceId);
    const registered = await request(server)
      .post("/devices/register")
      .set("Authorization", auth(sessionToken))
      .send(deviceBody("fp-bridge-1"));
    expect(registered.status).toBe(201);
    const deviceId = (registered.body as { id: string }).id;

    const minted = await request(server)
      .post(`/devices/${deviceId}/bridge-token`)
      .set("Authorization", auth(sessionToken));
    expect(minted.status).toBe(201);
    const body = minted.body as { accessToken: string; expiresIn: number; deviceId: string };
    expect(body.deviceId).toBe(deviceId);
    expect(body.expiresIn).toBeGreaterThan(0);

    const payload = decodePayload(body.accessToken);
    expect(payload["kind"]).toBe("bridge");
    expect(payload["deviceId"]).toBe(deviceId);
    expect(payload["sub"]).toBe(c.ownerId);
    expect(payload["ws"]).toBe(c.teamWorkspaceId);
  });

  it("refuses with licensing/device_revoked once the device is revoked", async () => {
    const c = ctx;
    const sessionToken = await c.sessionToken(c.ownerId, "owner", c.teamWorkspaceId);
    const registered = await request(server)
      .post("/devices/register")
      .set("Authorization", auth(sessionToken))
      .send(deviceBody("fp-bridge-2"));
    const deviceId = (registered.body as { id: string }).id;

    const revoke = await request(server)
      .delete(`/devices/${deviceId}`)
      .set("Authorization", auth(sessionToken));
    expect(revoke.status).toBe(200);

    const minted = await request(server)
      .post(`/devices/${deviceId}/bridge-token`)
      .set("Authorization", auth(sessionToken));
    expect(minted.status).toBe(403);
    expect((minted.body as { error: { code: string } }).error.code).toBe(
      "licensing/device_revoked",
    );
  });

  it("refuses with licensing/device_lease_expired once the lease has lapsed", async () => {
    const c = ctx;
    const sessionToken = await c.sessionToken(c.ownerId, "owner", c.teamWorkspaceId);
    const registered = await request(server)
      .post("/devices/register")
      .set("Authorization", auth(sessionToken))
      .send(deviceBody("fp-bridge-3"));
    const deviceId = (registered.body as { id: string }).id;

    await c.prisma.device.update({
      where: { id: deviceId },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });

    const minted = await request(server)
      .post(`/devices/${deviceId}/bridge-token`)
      .set("Authorization", auth(sessionToken));
    expect(minted.status).toBe(403);
    expect((minted.body as { error: { code: string } }).error.code).toBe(
      "licensing/device_lease_expired",
    );
  });

  it("refuses (as not found) a device that belongs to someone else", async () => {
    const c = ctx;
    const ownerSession = await c.sessionToken(c.ownerId, "owner", c.teamWorkspaceId);
    const registered = await request(server)
      .post("/devices/register")
      .set("Authorization", auth(ownerSession))
      .send(deviceBody("fp-bridge-4"));
    const deviceId = (registered.body as { id: string }).id;

    await c.addActiveMember(c.teamWorkspaceId, c.memberUserId, "editor");
    const memberSession = await c.sessionToken(c.memberUserId, "editor", c.teamWorkspaceId);

    const minted = await request(server)
      .post(`/devices/${deviceId}/bridge-token`)
      .set("Authorization", auth(memberSession));
    expect(minted.status).toBe(404);
  });

  it("a bridge token cannot mint another bridge token, nor reach an ordinary route", async () => {
    const c = ctx;
    const sessionToken = await c.sessionToken(c.ownerId, "owner", c.teamWorkspaceId);
    const registered = await request(server)
      .post("/devices/register")
      .set("Authorization", auth(sessionToken))
      .send(deviceBody("fp-bridge-5"));
    const deviceId = (registered.body as { id: string }).id;

    const minted = await request(server)
      .post(`/devices/${deviceId}/bridge-token`)
      .set("Authorization", auth(sessionToken));
    const bridgeAccessToken = (minted.body as { accessToken: string }).accessToken;

    // Bridge tokens never pass JwtAuthGuard for a user route (B08b guard rail).
    const listDevices = await request(server)
      .get("/devices")
      .set("Authorization", auth(bridgeAccessToken));
    expect(listDevices.status).toBe(403);

    const mintAgain = await request(server)
      .post(`/devices/${deviceId}/bridge-token`)
      .set("Authorization", auth(bridgeAccessToken));
    expect(mintAgain.status).toBe(403);
  });
});
