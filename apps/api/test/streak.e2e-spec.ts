/**
 * B06 acceptance suite: assignment (holdout), `GET /streak`, the weekly
 * rollover, renewal-discount wiring (B01) and credit-grant wiring (B02),
 * against a real PostgreSQL — reuses `billing-harness.ts`'s tenant/plan seed
 * since the streak experiment reads `subscriptions`/`plans` for "is this
 * workspace yearly / Free" and needs `BillingModule`'s `RenewalService`
 * wired to prove the discount actually lands on the renewal notice.
 */
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  billingSkipReason,
  createBillingTestContext,
  type BillingTestContext,
} from "./billing-harness.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { RenewalService } from "../src/billing/renewal.service.js";
import { NoopCreditsFacade } from "../src/credits/noop-credits.facade.js";
import { StreakService } from "../src/streak/streak.service.js";

import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) console.warn(`[streak.e2e] skipped: ${skipReason}`);

describe.skipIf(!available)("streak experiment (e2e)", () => {
  let ctx: BillingTestContext;
  let server: Server;

  beforeAll(async () => {
    const created = await createBillingTestContext();
    if (created === null) throw new Error(`harness unavailable: ${billingSkipReason}`);
    ctx = created;
    server = ctx.app.getHttpServer() as Server;
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  afterEach(async () => {
    await ctx.reset();
    await ctx.prisma.publishEvent.deleteMany({});
    await ctx.prisma.streakExperiment.deleteMany({});
    await ctx.prisma.featureFlag.deleteMany({});
  });

  const auth = (token: string) => `Bearer ${token}`;

  async function enableFlag(): Promise<void> {
    await ctx.prisma.featureFlag.upsert({
      where: { key: "streak_experiment" },
      create: { id: "01STREAKFLAG00000000000000", key: "streak_experiment", enabled: true },
      update: { enabled: true },
    });
  }

  it("the flag off: GET /streak answers not-eligible and creates no row", async () => {
    const token = ctx.token("admin");
    const res = await request(server).get("/streak").set("Authorization", auth(token));
    expect(res.status).toBe(200);
    expect((res.body as { eligible: boolean }).eligible).toBe(false);

    const row = await ctx.prisma.streakExperiment.findUnique({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(row).toBeNull();
  });

  it("flag on: GET /streak assigns the workspace and answers eligible", async () => {
    await enableFlag();
    const token = ctx.token("admin");
    const res = await request(server).get("/streak").set("Authorization", auth(token));
    expect(res.status).toBe(200);
    const body = res.body as { eligible: boolean; level: number; bar: number };
    expect(body.eligible).toBe(true);
    expect(body.bar).toBe(3);

    const row = await ctx.prisma.streakExperiment.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(row.level).toBeGreaterThanOrEqual(1);
  });

  it("a Free workspace (no subscription) is assigned the credits-only variant", async () => {
    await enableFlag();
    const token = ctx.token("admin", ctx.usdWorkspaceId);
    // usdWorkspaceId has no subscription seeded in this harness → Free/creditsOnly.
    const res = await request(server).get("/streak").set("Authorization", auth(token));
    expect(res.status).toBe(200);
    const body = res.body as { creditsOnly: boolean };
    expect(body.creditsOnly).toBe(true);
  });

  it("a yearly subscriber starts the streak at L4 (D52)", async () => {
    await enableFlag();
    const planId = await ctx.planId("creator");
    await ctx.prisma.subscription.create({
      data: {
        id: "01STREAKYEARSUB0000000000",
        workspaceId: ctx.workspaceId,
        planId,
        status: "active",
        interval: "year",
        currency: "INR",
        listPriceMinor: 69_840,
        currentPeriodEnd: new Date(Date.now() + 365 * 86_400_000),
      },
    });
    const streak = ctx.app.get(StreakService);
    const row = await streak.ensureAssigned(ctx.workspaceId);
    expect(row?.level).toBe(4);
  });

  it("holdout workspaces never receive rewards on a level-up rollover", async () => {
    await enableFlag();
    const streak = ctx.app.get(StreakService);
    await streak.ensureAssigned(ctx.workspaceId);
    // A paid subscription — B06b re-derives `creditsOnly` from the current
    // plan at every rollover, so a Free (no-subscription) workspace here
    // would never reach L4 on the level track.
    const holdoutPlanId = await ctx.planId("creator");
    await ctx.prisma.subscription.create({
      data: {
        id: "01STREAKHOLDSUB00000000000",
        workspaceId: ctx.workspaceId,
        planId: holdoutPlanId,
        status: "active",
        interval: "month",
        currency: "INR",
        listPriceMinor: 29_900,
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    await ctx.prisma.streakExperiment.update({
      where: { workspaceId: ctx.workspaceId },
      data: { holdout: true, consecutiveWeeks: 3, level: 3, creditsOnly: false },
    });

    const noop = ctx.app.get(NoopCreditsFacade);
    const spy = vi.spyOn(noop, "grantLot");

    // Push the window back and simulate 3 publish days, so the next rollover
    // both keeps the week AND crosses into L4 (a credit-grant level).
    const row = await ctx.prisma.streakExperiment.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    await ctx.prisma.streakExperiment.update({
      where: { workspaceId: ctx.workspaceId },
      data: { weekWindowStart: new Date(row.weekWindowStart.getTime() - 7 * 86_400_000) },
    });
    for (let i = 0; i < 3; i += 1) {
      await ctx.prisma.publishEvent.create({
        data: {
          id: `01STREAKHOLDEVT${String(i).padStart(10, "0")}`,
          workspaceId: ctx.workspaceId,
          surface: "web",
          at: new Date(row.weekWindowStart.getTime() - 7 * 86_400_000 + i * 86_400_000 + 3_600_000),
        },
      });
    }

    await streak.rolloverOne(ctx.workspaceId);

    const after = await ctx.prisma.streakExperiment.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(after.level).toBe(4); // the transition itself still applies...
    expect(spy).not.toHaveBeenCalled(); // ...but a holdout workspace is never rewarded

    // The widget-facing view also never exposes a reward for a holdout row.
    const view = await streak.getView(ctx.workspaceId);
    expect(view.discountPercent).toBe(0);
    expect(view.creditGrantTenths).toBe(0);
  });

  it("a non-holdout level-up to L4 grants +50 credits/month through CreditsFacade.grantLot", async () => {
    await enableFlag();
    const streak = ctx.app.get(StreakService);
    await streak.ensureAssigned(ctx.workspaceId);
    const levelUpPlanId = await ctx.planId("creator");
    await ctx.prisma.subscription.create({
      data: {
        id: "01STREAKLVLUPSUB0000000000",
        workspaceId: ctx.workspaceId,
        planId: levelUpPlanId,
        status: "active",
        interval: "month",
        currency: "INR",
        listPriceMinor: 29_900,
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    await ctx.prisma.streakExperiment.update({
      where: { workspaceId: ctx.workspaceId },
      data: { holdout: false, consecutiveWeeks: 3, level: 3, creditsOnly: false },
    });

    const noop = ctx.app.get(NoopCreditsFacade);
    const spy = vi.spyOn(noop, "grantLot");

    const row = await ctx.prisma.streakExperiment.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    await ctx.prisma.streakExperiment.update({
      where: { workspaceId: ctx.workspaceId },
      data: { weekWindowStart: new Date(row.weekWindowStart.getTime() - 7 * 86_400_000) },
    });
    for (let i = 0; i < 3; i += 1) {
      await ctx.prisma.publishEvent.create({
        data: {
          id: `01STREAKREWEVT${String(i).padStart(11, "0")}`,
          workspaceId: ctx.workspaceId,
          surface: "web",
          at: new Date(row.weekWindowStart.getTime() - 7 * 86_400_000 + i * 86_400_000 + 3_600_000),
        },
      });
    }

    await streak.rolloverOne(ctx.workspaceId);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: ctx.workspaceId, source: "grant", tenths: 500 }),
    );
  });

  it("the renewal discount is applied within the mandate cap (B01 integration)", async () => {
    await enableFlag();
    const streak = ctx.app.get(StreakService);
    await streak.ensureAssigned(ctx.workspaceId);
    await ctx.prisma.streakExperiment.update({
      where: { workspaceId: ctx.workspaceId },
      data: { level: 3, holdout: false, creditsOnly: false }, // L3 = 10% off
    });

    const planId = await ctx.planId("creator");
    const listPriceMinor = 69_900;
    await ctx.prisma.subscription.create({
      data: {
        id: "01STREAKDISCSUB000000000A",
        workspaceId: ctx.workspaceId,
        planId,
        status: "active",
        interval: "month",
        currency: "INR",
        listPriceMinor,
        currentPeriodEnd: new Date(Date.now() + 3 * 86_400_000),
      },
    });

    const renewal = ctx.app.get(RenewalService);
    await renewal.initiateRenewal("01STREAKDISCSUB000000000A");

    const notification = await ctx.prisma.notification.findFirst({
      where: { workspaceId: ctx.workspaceId, kind: "renewal-notice" },
      orderBy: { createdAt: "desc" },
    });
    // 10% off ₹699.00 = ₹629.10, always below the undiscounted cap.
    expect(notification?.data).toMatchObject({ amount: expect.stringContaining("629") as unknown });
  });

  it("test-hooks (test env only) simulate publish days and force a rollover", async () => {
    await enableFlag();
    const token = ctx.token("admin");
    await request(server).get("/streak").set("Authorization", auth(token)); // assigns

    const res = await request(server)
      .post("/streak/test-hooks")
      .set("Authorization", auth(token))
      .send({ publishDays: 3, rolloverWeek: true });
    expect(res.status).toBe(204);

    const row = await ctx.prisma.streakExperiment.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(row.consecutiveWeeks).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------
  // B06b: entitlement follows the current plan at every rollover/read.
  // ---------------------------------------------------------------------

  it("a Starter workspace at L3 that downgrades to Free loses the discount and any L4 lot at the next rollover", async () => {
    await enableFlag();
    const streak = ctx.app.get(StreakService);
    await streak.ensureAssigned(ctx.workspaceId);

    const planId = await ctx.planId("creator");
    const subscription = await ctx.prisma.subscription.create({
      data: {
        id: "01STREAKDOWNGRDSUB00000000",
        workspaceId: ctx.workspaceId,
        planId,
        status: "active",
        interval: "month",
        currency: "INR",
        listPriceMinor: 29_900,
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    // L3, one kept week away from leveling into L4 on the paid track.
    await ctx.prisma.streakExperiment.update({
      where: { workspaceId: ctx.workspaceId },
      data: { holdout: false, creditsOnly: false, level: 3, consecutiveWeeks: 3 },
    });
    expect(await streak.getDiscountPercent(ctx.workspaceId)).toBe(10); // L3 = 10% off, still paid

    // Downgrade: cancel the subscription (no active subscription => Free).
    await ctx.prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "cancelled" },
    });

    const noop = ctx.app.get(NoopCreditsFacade);
    const spy = vi.spyOn(noop, "grantLot");

    const row = await ctx.prisma.streakExperiment.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    await ctx.prisma.streakExperiment.update({
      where: { workspaceId: ctx.workspaceId },
      data: { weekWindowStart: new Date(row.weekWindowStart.getTime() - 7 * 86_400_000) },
    });
    for (let i = 0; i < 3; i += 1) {
      await ctx.prisma.publishEvent.create({
        data: {
          id: `01STREAKDOWNGRDEVT${String(i).padStart(7, "0")}`,
          workspaceId: ctx.workspaceId,
          surface: "web",
          at: new Date(row.weekWindowStart.getTime() - 7 * 86_400_000 + i * 86_400_000 + 3_600_000),
        },
      });
    }

    await streak.rolloverOne(ctx.workspaceId);

    const afterDowngrade = await ctx.prisma.streakExperiment.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(afterDowngrade.creditsOnly).toBe(true);
    expect(afterDowngrade.level).toBe(3); // never decreases
    expect(spy).not.toHaveBeenCalled(); // no L4 credit lot fired

    expect(await streak.getDiscountPercent(ctx.workspaceId)).toBe(0); // next renewal: no discount
    const viewAfterDowngrade = await streak.getView(ctx.workspaceId);
    expect(viewAfterDowngrade.discountPercent).toBe(0);
    expect(viewAfterDowngrade.creditGrantTenths).toBe(0);

    // Upgrade: a new active subscription restores plan-paid status.
    await ctx.prisma.subscription.create({
      data: {
        id: "01STREAKUPGRADESUB00000000",
        workspaceId: ctx.workspaceId,
        planId,
        status: "active",
        interval: "month",
        currency: "INR",
        listPriceMinor: 29_900,
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    const rowAfterDowngrade = await ctx.prisma.streakExperiment.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    await ctx.prisma.streakExperiment.update({
      where: { workspaceId: ctx.workspaceId },
      data: {
        weekWindowStart: new Date(rowAfterDowngrade.weekWindowStart.getTime() - 7 * 86_400_000),
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await ctx.prisma.publishEvent.create({
        data: {
          id: `01STREAKUPGRADEEVT${String(i).padStart(7, "0")}`,
          workspaceId: ctx.workspaceId,
          surface: "web",
          at: new Date(
            rowAfterDowngrade.weekWindowStart.getTime() -
              7 * 86_400_000 +
              i * 86_400_000 +
              3_600_000,
          ),
        },
      });
    }

    await streak.rolloverOne(ctx.workspaceId);

    const afterUpgrade = await ctx.prisma.streakExperiment.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(afterUpgrade.creditsOnly).toBe(false);
    expect(afterUpgrade.level).toBe(3); // unchanged across both flips
    expect(await streak.getDiscountPercent(ctx.workspaceId)).toBe(10); // restored at L3
  });
});
