/**
 * B08 acceptance suite, devices + licensing half: per-plan device limits and
 * revocation, licence-key creation/activation/revocation, and revocation
 * propagation through the heartbeat.
 */
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createB08TestContext, b08SkipReason, type B08TestContext } from "./b08-harness.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";

import type { INestApplication } from "@nestjs/common";
import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) console.warn(`[b08-devices-licensing.e2e] skipped: ${skipReason}`);

describe.skipIf(!available)("B08: devices and licence keys", () => {
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

  function deviceBody(fingerprint: string, name = "Laptop") {
    return {
      fingerprint,
      name,
      platform: "macOS 15",
      host: "desktop" as const,
      appVersion: "1.0.0",
    };
  }

  // -----------------------------------------------------------------------
  // Device limits and revocation (brief §2)
  // -----------------------------------------------------------------------

  it("Free-plan workspace (no subscription) allows exactly 1 device, then devices/limit_reached with the revocable list", async () => {
    const c = ctx;
    const token = await c.sessionToken(c.ownerId, "owner", c.teamWorkspaceId);

    const first = await request(server)
      .post("/devices/register")
      .set("Authorization", auth(token))
      .send(deviceBody("fp-team-device-1"));
    expect(first.status).toBe(201);

    const second = await request(server)
      .post("/devices/register")
      .set("Authorization", auth(token))
      .send(deviceBody("fp-team-device-2"));
    expect(second.status).toBe(409);
    const body = second.body as {
      error: { code: string; details: { limit: number; devices: unknown[] } };
    };
    expect(body.error.code).toBe("devices/limit_reached");
    expect(body.error.details.limit).toBe(1);
    expect(body.error.details.devices).toHaveLength(1);

    // The same fingerprint refreshes the lease instead of counting twice.
    const refreshed = await request(server)
      .post("/devices/register")
      .set("Authorization", auth(token))
      .send(deviceBody("fp-team-device-1", "Laptop (renamed)"));
    expect(refreshed.status).toBe(201);
  });

  it("revoking a device frees the slot, and its next heartbeat fails", async () => {
    const c = ctx;
    const token = await c.sessionToken(c.ownerId, "owner", c.teamWorkspaceId);

    const first = await request(server)
      .post("/devices/register")
      .set("Authorization", auth(token))
      .send(deviceBody("fp-revoke-1"));
    expect(first.status).toBe(201);
    const deviceId = (first.body as { id: string }).id;

    const revoke = await request(server)
      .delete(`/devices/${deviceId}`)
      .set("Authorization", auth(token));
    expect(revoke.status).toBe(200);
    expect((revoke.body as { revokedAt: string | null }).revokedAt).not.toBeNull();

    // The freed slot lets a NEW fingerprint register.
    const second = await request(server)
      .post("/devices/register")
      .set("Authorization", auth(token))
      .send(deviceBody("fp-revoke-2"));
    expect(second.status).toBe(201);

    // Next heartbeat: THREAT-MODEL T15 -- "revoke from Settings -> next heartbeat fails".
    const heartbeat = await request(server)
      .post("/plugins/heartbeat")
      .send({ nonce: "n-1", deviceId });
    expect(heartbeat.status).toBe(403);
    expect((heartbeat.body as { error: { code: string } }).error.code).toBe(
      "licensing/device_revoked",
    );
  });

  it("Agency: activeDevices scales 3 per seat (device limit is entitlement-driven, not hardcoded)", async () => {
    const c = ctx;
    const ownerAdminToken = c.token(c.ownerId, "admin", c.agencyWorkspaceId);
    const checkout = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(ownerAdminToken))
      .send({ planKey: "agency", interval: "month", seats: 2 });
    expect(checkout.status).toBe(201);
    const emitted = c.provider.emitWebhook({
      event: "subscription.activated",
      providerSubscriptionId: (checkout.body as { providerSubscriptionId: string })
        .providerSubscriptionId,
      status: "active",
      amountMinor: 239_800,
      currency: "INR",
    });
    const webhook = await request(server)
      .post("/billing/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", emitted.signature)
      .send(emitted.rawBody);
    expect(webhook.status).toBe(200);

    const token = await c.sessionToken(c.ownerId, "owner", c.agencyWorkspaceId);
    // 6 devices allowed (3 per seat x 2 seats): the 7th is refused.
    for (let i = 1; i <= 6; i += 1) {
      const res = await request(server)
        .post("/devices/register")
        .set("Authorization", auth(token))
        .send(deviceBody(`fp-agency-${i}`));
      expect(res.status).toBe(201);
    }
    const seventh = await request(server)
      .post("/devices/register")
      .set("Authorization", auth(token))
      .send(deviceBody("fp-agency-7"));
    expect(seventh.status).toBe(409);
    expect((seventh.body as { error: { details: { limit: number } } }).error.details.limit).toBe(6);
  });

  // -----------------------------------------------------------------------
  // Licence keys (brief §3): create, activate, heartbeat, revoke, propagation
  // -----------------------------------------------------------------------

  it("licence key: AK-XXXX-XXXX-XXXX, activation, heartbeat renews the lease and returns the revocation serial", async () => {
    const c = ctx;
    const adminToken = c.token(c.ownerId, "admin", c.teamWorkspaceId);

    const created = await request(server)
      .post(`/workspaces/${c.teamWorkspaceId}/license-keys`)
      .set("Authorization", auth(adminToken))
      .send({ label: "Studio suite", maxActivations: 2 });
    expect(created.status).toBe(201);
    const key = created.body as { key: string; id: string };
    expect(key.key).toMatch(/^AK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const activate = await request(server)
      .post("/plugins/activate")
      .send({
        licenseKey: key.key,
        device: deviceBody("fp-license-1"),
      });
    expect(activate.status).toBe(200);
    const activated = activate.body as {
      device: { id: string; leaseUntil: string };
      licenseSnapshot: string;
    };
    expect(activated.licenseSnapshot.split(".")).toHaveLength(3);
    expect(activated.device.leaseUntil).toBeTruthy();

    const heartbeat = await request(server)
      .post("/plugins/heartbeat")
      .send({ nonce: "hb-1", deviceId: activated.device.id, licenseKey: key.key });
    expect(heartbeat.status).toBe(200);
    const hb = heartbeat.body as {
      leaseUntil: string;
      revocationSerial: number;
      licenseSnapshot: string;
    };
    expect(hb.revocationSerial).toBe(0);
    expect(hb.licenseSnapshot.split(".")).toHaveLength(3);

    // A replayed nonce is refused (THREAT-MODEL T15's "heartbeat nonce").
    const replay = await request(server)
      .post("/plugins/heartbeat")
      .send({ nonce: "hb-1", deviceId: activated.device.id, licenseKey: key.key });
    expect(replay.status).toBe(409);
    expect((replay.body as { error: { code: string } }).error.code).toBe("licensing/nonce_reused");
  });

  it("activation limit reached refuses a second distinct device; re-activating the SAME fingerprint is idempotent", async () => {
    const c = ctx;
    const adminToken = c.token(c.ownerId, "admin", c.teamWorkspaceId);
    const created = await request(server)
      .post(`/workspaces/${c.teamWorkspaceId}/license-keys`)
      .set("Authorization", auth(adminToken))
      .send({ maxActivations: 1 });
    const key = created.body as { key: string };

    const first = await request(server)
      .post("/plugins/activate")
      .send({ licenseKey: key.key, device: deviceBody("fp-limit-1") });
    expect(first.status).toBe(200);

    const sameFingerprint = await request(server)
      .post("/plugins/activate")
      .send({ licenseKey: key.key, device: deviceBody("fp-limit-1", "Renamed") });
    expect(sameFingerprint.status).toBe(200);

    const secondDevice = await request(server)
      .post("/plugins/activate")
      .send({ licenseKey: key.key, device: deviceBody("fp-limit-2") });
    expect(secondDevice.status).toBe(409);
    expect((secondDevice.body as { error: { code: string } }).error.code).toBe(
      "licensing/activation_limit_reached",
    );
  });

  it("revoking a licence key propagates: heartbeat and reactivation both fail, revocation serial increments and appears in the daily snapshot", async () => {
    const c = ctx;
    const adminToken = c.token(c.ownerId, "admin", c.teamWorkspaceId);
    const created = await request(server)
      .post(`/workspaces/${c.teamWorkspaceId}/license-keys`)
      .set("Authorization", auth(adminToken))
      .send({ maxActivations: 1 });
    const key = created.body as { key: string; id: string };

    const activate = await request(server)
      .post("/plugins/activate")
      .send({ licenseKey: key.key, device: deviceBody("fp-revoke-key-1") });
    expect(activate.status).toBe(200);
    const deviceId = (activate.body as { device: { id: string } }).device.id;

    const revoke = await request(server)
      .delete(`/workspaces/${c.teamWorkspaceId}/license-keys/${key.id}`)
      .set("Authorization", auth(adminToken));
    expect(revoke.status).toBe(200);
    expect((revoke.body as { revocationSerial: number }).revocationSerial).toBe(1);

    // Revoking the key also revokes every device it activated (license-keys.service.ts).
    const heartbeat = await request(server)
      .post("/plugins/heartbeat")
      .send({ nonce: "hb-revoked", deviceId, licenseKey: key.key });
    expect(heartbeat.status).toBe(403);

    const reactivate = await request(server)
      .post("/plugins/activate")
      .send({ licenseKey: key.key, device: deviceBody("fp-revoke-key-2") });
    expect(reactivate.status).toBe(403);
    expect((reactivate.body as { error: { code: string } }).error.code).toBe(
      "licensing/key_revoked",
    );

    // The signed daily snapshot for fully offline clients (brief §3) lists it.
    const snapshot = await request(server).get("/plugins/revocation-snapshot");
    expect(snapshot.status).toBe(200);
    const { snapshot: token } = snapshot.body as { snapshot: string };
    const [, encodedPayload] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(encodedPayload as string, "base64url").toString("utf8"),
    ) as {
      revokedKeys: { key: string; revocationSerial: number }[];
    };
    expect(payload.revokedKeys).toContainEqual({ key: key.key, revocationSerial: 1 });
  });

  it("device-code activation: /plugins/activate {deviceCode} reuses the same device grant POST /auth/device/token does", async () => {
    const c = ctx;
    const codeReq = await request(server).post("/auth/device/code").send({
      clientKind: "desktop",
      hostApp: "resolve",
    });
    expect(codeReq.status).toBe(201);
    const { deviceCode, userCode } = codeReq.body as { deviceCode: string; userCode: string };

    const ownerToken = await c.sessionToken(c.ownerId, "owner", c.teamWorkspaceId);
    const approve = await request(server)
      .post("/auth/device/approve")
      .set("Authorization", auth(ownerToken))
      .send({ userCode, workspaceId: c.teamWorkspaceId, decision: "approve" });
    expect(approve.status).toBe(200);

    const activate = await request(server)
      .post("/plugins/activate")
      .send({ deviceCode, device: deviceBody("fp-devicecode-1") });
    expect(activate.status).toBe(200);
    const body = activate.body as { device: { id: string }; accessToken?: string };
    expect(body.accessToken).toBeTruthy();

    const stored = await c.prisma.device.findUniqueOrThrow({ where: { id: body.device.id } });
    expect(stored.workspaceId).toBe(c.teamWorkspaceId);
    expect(stored.userId).toBe(c.ownerId);
  });
});
