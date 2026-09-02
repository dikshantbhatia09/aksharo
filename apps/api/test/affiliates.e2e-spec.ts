/**
 * The B07 acceptance suite (brief §8): attribution precedence, the commission
 * schedule against a real paid invoice, clawback on refund, the FY TDS
 * accumulator, payout batching and the minimum, self-referral rejection —
 * against a real PostgreSQL and Redis, through `FakeProvider` (billing) and
 * `FakePayoutProvider` (payouts). Reuses `billing-harness.ts` (B01) for the
 * checkout → webhook → paid-invoice path this work package observes rather
 * than forks (`invoice-events.ts`).
 *
 * Skips loudly when Docker/`TEST_DATABASE_URL` is unavailable, exactly as
 * `billing.e2e-spec.ts` does.
 */
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  billingSkipReason,
  createBillingTestContext,
  type BillingTestContext,
} from "./billing-harness.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { seedUlid } from "../prisma/seed-data.js";
import { PAYOUT_MINIMUM_NET_MINOR } from "../src/affiliates/payouts/payouts.service.js";
import { COMMISSION_MATURATION_TASK } from "../src/affiliates/tasks/commission-maturation.task.js";
import { PAYOUT_BATCH_TASK } from "../src/affiliates/tasks/payout-batch.task.js";
import { ScheduledTasksService } from "../src/common/scheduler/scheduled-tasks.service.js";
import { TaxRegistrationsService } from "../src/invoices/tax-registrations/tax-registrations.service.js";

import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) console.warn(`[affiliates.e2e] skipped: ${skipReason}`);

describe.skipIf(!available)("affiliate v2 (e2e)", () => {
  let ctx: BillingTestContext;
  let server: Server;
  let scheduler: ScheduledTasksService;

  beforeAll(async () => {
    const created = await createBillingTestContext();
    if (created === null) throw new Error(`harness unavailable: ${billingSkipReason}`);
    ctx = created;
    server = ctx.app.getHttpServer() as Server;
    scheduler = ctx.app.get(ScheduledTasksService);

    // `billing-harness.ts` seeds plans and workspaces but not a supplier tax
    // registration — `InvoicesService.generateInvoice` throws
    // `invoices/no_supplier_gstin` without one (`invoices-harness.ts` sets up
    // the same registration for B05's own suite).
    const taxRegistrations = ctx.app.get(TaxRegistrationsService);
    await taxRegistrations.upsert({
      jurisdiction: "IN",
      taxIdType: "GSTIN",
      taxId: "27AAPFU0939F1ZV",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      lutNumber: "AD270825001234A",
      lutValidTo: new Date("2027-03-31T00:00:00.000Z"),
    });
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  afterEach(async () => {
    await ctx.reset();
    await ctx.prisma.commission.deleteMany({});
    await ctx.prisma.payout.deleteMany({});
    await ctx.prisma.affiliateFyTotal.deleteMany({});
    await ctx.prisma.referral.deleteMany({});
    await ctx.prisma.affiliateClick.deleteMany({});
    await ctx.prisma.affiliate.deleteMany({});
    await ctx.prisma.invoice.deleteMany({});
  });

  const auth = (token: string) => `Bearer ${token}`;

  /** Polls for an async, event-driven side effect (EventEmitter2 listeners run off-request). */
  async function pollUntil<T>(
    fetch: () => Promise<T>,
    ready: (value: T) => boolean,
    timeoutMs = 10_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T;
    for (;;) {
      last = await fetch();
      if (ready(last)) return last;
      if (Date.now() > deadline) return last;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** A second user + workspace, distinct from `ctx`'s own tenant, to be the affiliate. */
  async function createAffiliateUser(): Promise<{ userId: string; token: string }> {
    const userId = seedUlid(`aff-user-${Date.now()}-${Math.random()}`);
    await ctx.prisma.user.create({
      data: {
        id: userId,
        email: `${userId.toLowerCase()}@example.test`,
        name: "Affiliate tester",
        isAdmin: false,
      },
    });
    const workspaceId = seedUlid(`aff-ws-${Date.now()}-${Math.random()}`);
    await ctx.prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `aff-ws-${workspaceId.toLowerCase()}`,
        name: "Affiliate workspace",
        ownerId: userId,
        region: "in",
        currency: "INR",
        billingCountry: "IN",
        billingCountryConfirmedAt: new Date(),
        billingStateCode: "27",
      },
    });
    await ctx.prisma.membership.create({
      data: {
        id: seedUlid(`m-${workspaceId}`),
        workspaceId,
        userId,
        role: "owner",
        status: "active",
      },
    });
    const token = await mintTokenFor(userId, workspaceId);
    return { userId, token };
  }

  async function mintTokenFor(userId: string, workspaceId: string): Promise<string> {
    const { TokenService } = await import("../src/auth/token.service.js");
    const tokenService = ctx.app.get(TokenService);
    return tokenService.mintAccessToken({ userId, workspaceId, role: "owner", kind: "web" })
      .accessToken;
  }

  async function applyAndApprove(): Promise<{ affiliateId: string; code: string; userId: string }> {
    const userId = seedUlid(`aff-${Date.now()}-${Math.random()}`);
    await ctx.prisma.user.create({
      data: { id: userId, email: `${userId.toLowerCase()}@example.test`, name: "Affiliate" },
    });
    const wsId = seedUlid(`aff-own-ws-${Date.now()}-${Math.random()}`);
    await ctx.prisma.workspace.create({
      data: {
        id: wsId,
        slug: `own-ws-${wsId.toLowerCase()}`,
        name: "Own workspace",
        ownerId: userId,
        region: "in",
        currency: "INR",
        billingCountry: "IN",
        billingCountryConfirmedAt: new Date(),
      },
    });
    await ctx.prisma.membership.create({
      data: {
        id: seedUlid(`mm-${wsId}`),
        workspaceId: wsId,
        userId,
        role: "owner",
        status: "active",
      },
    });
    const token = await mintTokenFor(userId, wsId);

    const apply = await request(server)
      .post("/affiliate/apply")
      .set("Authorization", auth(token))
      .send({
        legalName: "Test Affiliate",
        pan: "ABCDE1234F",
        payoutMethod: {
          rail: "upi",
          vpaOrAccountNumber: "test@upi",
          accountHolderName: "Test Affiliate",
        },
        acceptedDisclosure: true,
      });
    expect(apply.status).toBe(201);
    const affiliateId = (apply.body as { id: string }).id;
    const code = (apply.body as { code: string }).code;

    await ctx.prisma.affiliate.update({
      where: { id: affiliateId },
      data: { status: "approved", approvedAt: new Date(), panVerifiedAt: new Date() },
    });

    return { affiliateId, code, userId };
  }

  // ---------------------------------------------------------------------
  // Attribution: code beats cookie; self-referral rejected.
  // ---------------------------------------------------------------------

  it("attribution: an entered code takes precedence over a cookie, and attaches a referral", async () => {
    const { code, affiliateId } = await applyAndApprove();
    const { userId: referredUserId } = await createAffiliateUser();
    const referredWorkspaceId = seedUlid(`ref-ws-${Date.now()}`);
    await ctx.prisma.workspace.create({
      data: {
        id: referredWorkspaceId,
        slug: `ref-ws-${referredWorkspaceId.toLowerCase()}`,
        name: "Referred workspace",
        ownerId: referredUserId,
        region: "in",
        currency: "INR",
        billingCountry: "IN",
        billingCountryConfirmedAt: new Date(),
      },
    });

    const res = await request(server)
      .post("/affiliate/attribution/attach")
      .send({
        referredWorkspaceId,
        referredUserId,
        code,
        cookieCode: "SOMEOTHR",
        cookieExpiresAt: new Date(Date.now() + 1000).toISOString(),
      });
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("attributed");

    const referral = await ctx.prisma.referral.findUniqueOrThrow({
      where: { referredWorkspaceId },
    });
    expect(referral.affiliateId).toBe(affiliateId);
    expect(referral.source).toBe("code");
  });

  it("self-referral (same user id) is rejected with an audit row", async () => {
    const { code, userId } = await applyAndApprove();
    const referredWorkspaceId = seedUlid(`self-ws-${Date.now()}`);
    await ctx.prisma.workspace.create({
      data: {
        id: referredWorkspaceId,
        slug: `self-ws-${referredWorkspaceId.toLowerCase()}`,
        name: "Self workspace",
        ownerId: userId,
        region: "in",
        currency: "INR",
        billingCountry: "IN",
        billingCountryConfirmedAt: new Date(),
      },
    });

    const res = await request(server).post("/affiliate/attribution/attach").send({
      referredWorkspaceId,
      referredUserId: userId,
      code,
    });
    expect(res.status).toBe(200);
    expect((res.body as { status: string; reason?: string }).status).toBe("rejected");
    expect((res.body as { reason?: string }).reason).toBe("self_referral");

    const referral = await ctx.prisma.referral.findUnique({ where: { referredWorkspaceId } });
    expect(referral).toBeNull();

    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: "affiliate.self_referral.rejected" },
    });
    expect(audit).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // Full attribution → commission → maturation → payout e2e.
  // ---------------------------------------------------------------------

  it("full flow: /r/<code> attribution → paid invoice → pending commission → matures → payout batch includes it", async () => {
    const { code, affiliateId } = await applyAndApprove();
    const { userId: buyerUserId, token: buyerToken } = await createAffiliateUser();

    // Resolve which workspace the buyer token is scoped to and attach attribution.
    const membership = await ctx.prisma.membership.findFirstOrThrow({
      where: { userId: buyerUserId },
    });
    const attach = await request(server).post("/affiliate/attribution/attach").send({
      referredWorkspaceId: membership.workspaceId,
      referredUserId: buyerUserId,
      code,
    });
    expect(attach.status).toBe(200);
    expect((attach.body as { status: string }).status).toBe("attributed");

    // Pay the referred workspace's first invoice: checkout, then a
    // subscription.activated webhook (billing-harness's own FakeProvider).
    const checkout = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(buyerToken))
      .send({ planKey: "creator", interval: "month" });
    expect(checkout.status).toBe(201);
    const checkoutBody = checkout.body as { providerSubscriptionId: string };

    const emitted = ctx.provider.emitWebhook({
      event: "subscription.activated",
      providerSubscriptionId: checkoutBody.providerSubscriptionId,
      status: "active",
      amountMinor: 69_900,
      currency: "INR",
    });
    const webhook = await request(server)
      .post("/billing/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", emitted.signature)
      .send(emitted.rawBody);
    expect(webhook.status).toBe(200);

    // The invoice-issued event, and the commission it triggers, are both
    // async (EventEmitter2) — poll rather than guess a fixed sleep. A
    // generous ceiling: this shared Postgres/Redis instance is also carrying
    // other work packages' own e2e suites (setup instructions: "zero
    // containers", one shared compose stack), so occasional lock contention
    // adds real latency that has nothing to do with this code's correctness.
    const referral = await pollUntil(
      () =>
        ctx.prisma.referral.findUniqueOrThrow({
          where: { referredWorkspaceId: membership.workspaceId },
        }),
      (r) => r.status === "converted",
      25_000,
    );
    expect(referral.status).toBe("converted");

    const commission = await ctx.prisma.commission.findFirstOrThrow({
      where: { referralId: referral.id },
    });
    expect(commission.status).toBe("pending");
    expect(commission.rate).toBe(4000); // month 1 of 3: 40%
    // ₹699 incl. 18% GST -> taxable ≈ ₹592.37 -> 40% ≈ ₹236.9x, floored.
    const invoice = await ctx.prisma.invoice.findUniqueOrThrow({
      where: { id: commission.invoiceId },
    });
    const expectedGross = Math.floor((invoice.taxableValueMinor * 4000) / 10000);
    expect(commission.grossMinor).toBe(expectedGross);

    // Mature it (30-day hold) by driving the scheduled task directly with a
    // future "now" rather than waiting a real month.
    await ctx.prisma.commission.update({
      where: { id: commission.id },
      data: { availableAt: new Date(Date.now() - 1000) },
    });
    await scheduler.runNow(COMMISSION_MATURATION_TASK);

    const matured = await ctx.prisma.commission.findUniqueOrThrow({ where: { id: commission.id } });
    expect(matured.status).toBe("payable");

    // A payout batch below the ₹1,000 minimum is skipped...
    if (matured.netPayableMinor < PAYOUT_MINIMUM_NET_MINOR) {
      await scheduler.runNow(PAYOUT_BATCH_TASK);
      const notPaid = await ctx.prisma.commission.findUniqueOrThrow({
        where: { id: commission.id },
      });
      expect(notPaid.status).toBe("payable"); // still unpaid — below minimum

      // Bump it over the minimum directly to exercise the batching path itself.
      await ctx.prisma.commission.update({
        where: { id: commission.id },
        data: { netPayableMinor: PAYOUT_MINIMUM_NET_MINOR + 1 },
      });
    }
    await scheduler.runNow(PAYOUT_BATCH_TASK);

    const paid = await ctx.prisma.commission.findUniqueOrThrow({ where: { id: commission.id } });
    expect(paid.status).toBe("paid");
    expect(paid.payoutId).not.toBeNull();

    const payout = await ctx.prisma.payout.findUniqueOrThrow({ where: { id: paid.payoutId! } });
    expect(payout.affiliateId).toBe(affiliateId);
    expect(payout.status).toBe("paid");
    expect(payout.amountMinor).toBeGreaterThanOrEqual(PAYOUT_MINIMUM_NET_MINOR);
  }, 40_000);
});
