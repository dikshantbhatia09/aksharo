/**
 * B08 acceptance suite, teams/agency half: seat proration, pooled credits per
 * seat, ownership transfer, client tags, and a role-matrix contract test over
 * this work package's own new routes.
 */
import request from "supertest";
import { ulid } from "ulid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createB08TestContext, b08SkipReason, type B08TestContext } from "./b08-harness.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { redisKeys } from "../src/auth/auth.constants.js";
import { EntitlementService } from "../src/workspaces/entitlement.service.js";
import { SeatBillingService } from "../src/workspaces/teams/seat-billing.service.js";

import type { INestApplication } from "@nestjs/common";
import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) console.warn(`[b08-teams.e2e] skipped: ${skipReason}`);

describe.skipIf(!available)("B08: teams, agency, seats, credits, ownership", () => {
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

  /**
   * Poll `fn` until it returns truthily or `timeoutMs` elapses.
   *
   * This suite's Postgres connections are capped at 3 with a 30s pool
   * timeout (`db-harness.ts`, shared across every e2e suite in the run) --
   * under load from other suites, a query issued right after an awaited
   * write can still queue briefly for a free connection. The write itself is
   * never lost (Postgres commits are durable the moment `await` returns);
   * what a fixed-delay assertion can catch mid-flight is a *read*, on a
   * different pooled connection, that had to wait its turn. Retrying a
   * pure read is safe precisely because nothing here mutates state.
   */
  async function eventually<T>(fn: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  function postWebhook(rawBody: string, signature: string) {
    return request(server)
      .post("/billing/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", signature)
      .send(rawBody);
  }

  /** Checkout + activate an Agency subscription at the given seat count. */
  async function activateAgency(c: B08TestContext, seats: number): Promise<void> {
    const token = c.token(c.ownerId, "admin", c.agencyWorkspaceId);
    const checkout = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "agency", interval: "month", seats });
    expect(checkout.status).toBe(201);
    const body = checkout.body as { providerSubscriptionId: string };

    const emitted = c.provider.emitWebhook({
      event: "subscription.activated",
      providerSubscriptionId: body.providerSubscriptionId,
      status: "active",
      amountMinor: 119_900 + (seats - 1) * 119_900,
      currency: "INR",
    });
    const webhook = await postWebhook(emitted.rawBody, emitted.signature);
    expect(webhook.status).toBe(200);

    // Defensive: an earlier `it()` in this file may have computed and cached
    // (60s, 07 §Workspaces) this workspace's entitlement while its plan was
    // something else (`free`, mid-checkout `pending`, ...) -- this harness
    // reuses `agencyWorkspaceId` across every test, so the very next read
    // must never see that stale value.
    await app.get(EntitlementService).invalidate(c.agencyWorkspaceId);
  }

  // -----------------------------------------------------------------------
  // Acceptance criterion 1: 3 seats bills 3 x Rs 1,199, pools 2,700 credits,
  // allows 9 devices.
  // -----------------------------------------------------------------------

  it("Agency: 3 seats bills 3 x Rs 1,199 (fake provider), pools 2,700 credits, allows 9 devices", async () => {
    const c = ctx;
    // Checked out at 3 seats directly (an agency signing up its team from the
    // start) -- exactly the acceptance criterion's own shape, and it sidesteps
    // B01's mandate-cap re-registration path (D40: any INCREASE over the
    // current mandate's own cap needs fresh authentication and lands the
    // subscription in `pending` until a second webhook confirms it; a
    // three-seat checkout authenticates once, at the full three-seat cap).
    await activateAgency(c, 3);
    // Two more active memberships, matching the 3 seats just checked out --
    // `SeatBillingService.syncSeats` compares billed seats against ACTUAL
    // active memberships and would otherwise sync the subscription back down
    // to 1 the moment the event below fires.
    const memberTwo = await c.createUser("agency-3seat-2");
    const memberThree = await c.createUser("agency-3seat-3");
    await c.addActiveMember(c.agencyWorkspaceId, memberTwo, "editor");
    await c.addActiveMember(c.agencyWorkspaceId, memberThree, "editor");

    await eventually(async () => {
      const subscription = await c.prisma.subscription.findFirstOrThrow({
        where: { workspaceId: c.agencyWorkspaceId, status: "active" },
      });
      expect(subscription.seats).toBe(3);
      expect(subscription.listPriceMinor).toBe(3 * 119_900);
    });

    // The credit pool is not automatic on checkout alone (webhooks.service.ts
    // is B01's file, outside this work package) -- it is SeatBillingService's
    // reaction to a membership event, so drive that the same way an
    // accepted invitation would.
    await app.get(SeatBillingService).sync(c.agencyWorkspaceId, "invite_accepted");

    await eventually(async () => {
      const account = await c.prisma.creditAccount.findUniqueOrThrow({
        where: { workspaceId: c.agencyWorkspaceId },
      });
      expect(account.monthlyGrantTenths).toBe(2_700 * 10);
      expect(account.balanceTenths).toBeGreaterThanOrEqual(2_700 * 10);
    });

    const ownerToken = c.token(c.ownerId, "owner", c.agencyWorkspaceId);
    await eventually(async () => {
      const entitlement = await request(server)
        .get(`/workspaces/${c.agencyWorkspaceId}/entitlement`)
        .set("Authorization", auth(ownerToken));
      expect(entitlement.status).toBe(200);
      const entitlements = entitlement.body as { entitlements: { activeDevices: number } };
      expect(entitlements.entitlements.activeDevices).toBe(9);
    });
  });

  it("a seat increase re-registers the mandate at the new cap (D40); seats update, status goes pending until confirmed", async () => {
    const c = ctx;
    await activateAgency(c, 1);
    const memberTwo = await c.createUser("agency-member-2");
    await c.addActiveMember(c.agencyWorkspaceId, memberTwo, "editor");

    await app.get(SeatBillingService).sync(c.agencyWorkspaceId, "invite_accepted");

    // `subscription.seats` is written immediately even on the re-registration
    // branch (`subscription.service.ts#changePlan`); only `status` and
    // `providerSubId` wait on the new mandate's own webhook.
    await eventually(async () => {
      const grown = await c.prisma.subscription.findFirstOrThrow({
        where: { workspaceId: c.agencyWorkspaceId },
        orderBy: { createdAt: "desc" },
      });
      expect(grown.seats).toBe(2);
      expect(grown.status).toBe("pending");
      expect(grown.listPriceMinor).toBe(2 * 119_900);
    });
  });

  it("removing a seat lowers the billed seat count in place (same-or-lower cap, no re-auth), never claws back pooled credits", async () => {
    const c = ctx;
    // Checked out at 2 seats directly so the shrink below is a pure downgrade
    // -- same-or-lower cap, applied in place without a mandate re-registration.
    await activateAgency(c, 2);
    const memberTwo = await c.createUser("agency-member-remove");
    await c.addActiveMember(c.agencyWorkspaceId, memberTwo, "editor");

    await app.get(SeatBillingService).sync(c.agencyWorkspaceId, "invite_accepted");
    await eventually(async () => {
      const grownAccount = await c.prisma.creditAccount.findUniqueOrThrow({
        where: { workspaceId: c.agencyWorkspaceId },
      });
      expect(grownAccount.monthlyGrantTenths).toBe(1_800 * 10);
    });

    await c.prisma.membership.updateMany({
      where: { workspaceId: c.agencyWorkspaceId, userId: memberTwo },
      data: { status: "removed" },
    });
    await app.get(SeatBillingService).sync(c.agencyWorkspaceId, "member_removed");

    await eventually(async () => {
      const shrunk = await c.prisma.subscription.findFirstOrThrow({
        where: { workspaceId: c.agencyWorkspaceId, status: "active" },
      });
      expect(shrunk.seats).toBe(1);
      expect(shrunk.listPriceMinor).toBe(119_900);
    });

    // Pooled credits are never clawed back by this path (SeatBillingService
    // only ever raises `monthlyGrantTenths`).
    const shrunkAccount = await c.prisma.creditAccount.findUniqueOrThrow({
      where: { workspaceId: c.agencyWorkspaceId },
    });
    expect(shrunkAccount.monthlyGrantTenths).toBe(1_800 * 10);
  });

  // -----------------------------------------------------------------------
  // Acceptance criterion 2 (ownership transfer, orchestrator addendum)
  // -----------------------------------------------------------------------

  it("ownership transfer: owner only, active member target, confirmation token, audit", async () => {
    const c = ctx;
    const newOwnerUserId = await c.createUser("new-owner");
    const membershipId = await c.addActiveMember(c.teamWorkspaceId, newOwnerUserId, "admin");

    const ownerToken = c.token(c.ownerId, "owner", c.teamWorkspaceId);
    const adminToken = c.token(newOwnerUserId, "admin", c.teamWorkspaceId);

    // Not the owner: refused.
    const forbidden = await request(server)
      .post(`/workspaces/${c.teamWorkspaceId}/transfer-ownership`)
      .set("Authorization", auth(adminToken))
      .send({ toMembershipId: membershipId });
    expect(forbidden.status).toBe(403);

    // Owner, first call: confirmation sent, nothing changed yet.
    const first = await request(server)
      .post(`/workspaces/${c.teamWorkspaceId}/transfer-ownership`)
      .set("Authorization", auth(ownerToken))
      .send({ toMembershipId: membershipId });
    expect(first.status).toBe(200);
    expect((first.body as { status: string }).status).toBe("confirmation_sent");

    const unchanged = await c.prisma.workspace.findUniqueOrThrow({
      where: { id: c.teamWorkspaceId },
    });
    expect(unchanged.ownerId).toBe(c.ownerId);

    // The token travelled through the dev mail outbox (no real mail transport
    // in this environment) -- read it back the same way the auth suite does.
    const outboxRaw = await c.redis.lrange(redisKeys.devOutbox(), 0, 10);
    const entry = outboxRaw
      .map((raw) => JSON.parse(raw) as { template: string; token: string })
      .find((e) => e.template === "ownership_transfer_requested");
    expect(entry).toBeDefined();

    // Wrong token: refused.
    const wrongToken = await request(server)
      .post(`/workspaces/${c.teamWorkspaceId}/transfer-ownership`)
      .set("Authorization", auth(ownerToken))
      .send({ toMembershipId: membershipId, confirmToken: "not-the-real-token" });
    expect(wrongToken.status).toBe(400);

    // Correct token: transferred.
    const second = await request(server)
      .post(`/workspaces/${c.teamWorkspaceId}/transfer-ownership`)
      .set("Authorization", auth(ownerToken))
      .send({ toMembershipId: membershipId, confirmToken: entry?.token });
    expect(second.status).toBe(200);
    expect((second.body as { status: string }).status).toBe("transferred");

    const moved = await c.prisma.workspace.findUniqueOrThrow({ where: { id: c.teamWorkspaceId } });
    expect(moved.ownerId).toBe(newOwnerUserId);

    const oldOwnerMembership = await c.prisma.membership.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: c.teamWorkspaceId, userId: c.ownerId } },
    });
    expect(oldOwnerMembership.role).toBe("admin");

    const newOwnerMembership = await c.prisma.membership.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: c.teamWorkspaceId, userId: newOwnerUserId } },
    });
    expect(newOwnerMembership.role).toBe("owner");

    const audited = await c.prisma.auditLog.findFirst({
      where: { action: "workspace.ownership.transferred", workspaceId: c.teamWorkspaceId },
    });
    expect(audited).not.toBeNull();

    // Sessions are unaffected (brief: "sessions unaffected") -- there is no
    // session table write in this whole flow to assert against, which is
    // itself the proof: `OwnershipTransferService.transfer` never touches
    // `sessions`.
  });

  it("ownership transfer refuses a target that is not an active member", async () => {
    const c = ctx;
    const invitedEmail = `pending-${ulid().toLowerCase()}@example.test`;
    const pendingId = await c.prisma.membership
      .create({
        data: {
          id: ulid(),
          workspaceId: c.teamWorkspaceId,
          userId: null,
          invitedEmail,
          role: "editor",
          status: "invited",
        },
      })
      .then((m) => m.id);

    const ownerToken = c.token(c.ownerId, "owner", c.teamWorkspaceId);
    const res = await request(server)
      .post(`/workspaces/${c.teamWorkspaceId}/transfer-ownership`)
      .set("Authorization", auth(ownerToken))
      .send({ toMembershipId: pendingId });
    expect(res.status).toBe(409);
  });

  // -----------------------------------------------------------------------
  // Client tags (Agency)
  // -----------------------------------------------------------------------

  it("client tags: set on a project and a folder, filter by tag, list with counts", async () => {
    const c = ctx;
    const ownerToken = c.token(c.ownerId, "owner", c.agencyWorkspaceId);

    const folder = await c.prisma.folder.create({
      data: { id: ulid(), workspaceId: c.agencyWorkspaceId, name: "Client A" },
    });
    const project = await c.prisma.project.create({
      data: {
        id: ulid(),
        workspaceId: c.agencyWorkspaceId,
        title: "Client A promo",
        folderId: folder.id,
      },
    });

    const setFolder = await request(server)
      .patch(`/workspaces/${c.agencyWorkspaceId}/folders/${folder.id}/client-tag`)
      .set("Authorization", auth(ownerToken))
      .send({ clientTag: "client-a" });
    expect(setFolder.status).toBe(200);

    const setProject = await request(server)
      .patch(`/workspaces/${c.agencyWorkspaceId}/projects/${project.id}/client-tag`)
      .set("Authorization", auth(ownerToken))
      .send({ clientTag: "client-a" });
    expect(setProject.status).toBe(200);

    const list = await request(server)
      .get(`/workspaces/${c.agencyWorkspaceId}/client-tags`)
      .set("Authorization", auth(ownerToken));
    expect(list.status).toBe(200);
    const tags = list.body as { tag: string; projectCount: number; folderCount: number }[];
    const clientA = tags.find((t) => t.tag === "client-a");
    expect(clientA).toEqual({ tag: "client-a", projectCount: 1, folderCount: 1 });

    const filtered = await request(server)
      .get(`/workspaces/${c.agencyWorkspaceId}/client-tags/client-a/projects`)
      .set("Authorization", auth(ownerToken));
    expect(filtered.status).toBe(200);
    expect((filtered.body as { id: string }[]).map((p) => p.id)).toEqual([project.id]);

    // Clearing the tag removes it from the filter.
    const clear = await request(server)
      .patch(`/workspaces/${c.agencyWorkspaceId}/projects/${project.id}/client-tag`)
      .set("Authorization", auth(ownerToken))
      .send({ clientTag: null });
    expect(clear.status).toBe(200);
    const refiltered = await request(server)
      .get(`/workspaces/${c.agencyWorkspaceId}/client-tags/client-a/projects`)
      .set("Authorization", auth(ownerToken));
    expect((refiltered.body as { id: string }[]).map((p) => p.id)).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Role matrix contract test over B08's own routes
  // -----------------------------------------------------------------------

  it("role matrix: admin-only routes refuse viewer/editor; owner-only refuses admin", async () => {
    const c = ctx;
    const viewerUserId = await c.createUser("role-viewer");
    const editorUserId = await c.createUser("role-editor");
    const adminUserId = await c.createUser("role-admin");
    await c.addActiveMember(c.teamWorkspaceId, viewerUserId, "viewer");
    await c.addActiveMember(c.teamWorkspaceId, editorUserId, "editor");
    const adminMembershipId = await c.addActiveMember(c.teamWorkspaceId, adminUserId, "admin");

    const viewerToken = c.token(viewerUserId, "viewer", c.teamWorkspaceId);
    const editorToken = c.token(editorUserId, "editor", c.teamWorkspaceId);
    const adminToken = c.token(adminUserId, "admin", c.teamWorkspaceId);
    const ownerToken = c.token(c.ownerId, "owner", c.teamWorkspaceId);

    // Licence keys: admin only.
    for (const token of [viewerToken, editorToken]) {
      const res = await request(server)
        .post(`/workspaces/${c.teamWorkspaceId}/license-keys`)
        .set("Authorization", auth(token))
        .send({ maxActivations: 1 });
      expect(res.status).toBe(403);
    }
    const asAdmin = await request(server)
      .post(`/workspaces/${c.teamWorkspaceId}/license-keys`)
      .set("Authorization", auth(adminToken))
      .send({ maxActivations: 1 });
    expect(asAdmin.status).toBe(201);

    // Client tag write: editor+, not viewer.
    const project = await c.prisma.project.create({
      data: { id: ulid(), workspaceId: c.teamWorkspaceId, title: "Role matrix" },
    });
    const viewerWrite = await request(server)
      .patch(`/workspaces/${c.teamWorkspaceId}/projects/${project.id}/client-tag`)
      .set("Authorization", auth(viewerToken))
      .send({ clientTag: "x" });
    expect(viewerWrite.status).toBe(403);
    const editorWrite = await request(server)
      .patch(`/workspaces/${c.teamWorkspaceId}/projects/${project.id}/client-tag`)
      .set("Authorization", auth(editorToken))
      .send({ clientTag: "x" });
    expect(editorWrite.status).toBe(200);

    // Ownership transfer: owner only, not admin.
    const adminTransfer = await request(server)
      .post(`/workspaces/${c.teamWorkspaceId}/transfer-ownership`)
      .set("Authorization", auth(adminToken))
      .send({ toMembershipId: adminMembershipId });
    expect(adminTransfer.status).toBe(403);
    const ownerTransfer = await request(server)
      .post(`/workspaces/${c.teamWorkspaceId}/transfer-ownership`)
      .set("Authorization", auth(ownerToken))
      .send({ toMembershipId: adminMembershipId });
    expect(ownerTransfer.status).toBe(200);
  });
});
