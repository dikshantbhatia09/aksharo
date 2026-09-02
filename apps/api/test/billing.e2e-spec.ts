/**
 * The B01 acceptance suite: checkout, the ₹15,000 mandate rule, webhooks
 * (idempotency, signature, amount cross-check), passes/top-ups, subscription
 * management and the renewal/dunning primitives — against a real PostgreSQL
 * and a real Redis, all through `FakeProvider` (no live Razorpay keys in this
 * environment; see `src/billing/README.md`).
 *
 * Skips with an explanation when Docker/`TEST_DATABASE_URL` is unavailable,
 * exactly as `edg.e2e-spec.ts` does.
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

import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) console.warn(`[billing.e2e] skipped: ${skipReason}`);

describe.skipIf(!available)("billing (e2e)", () => {
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
  });

  const auth = (token: string) => `Bearer ${token}`;

  /**
   * POST a signed webhook exactly as `FakeProvider.emitWebhook` shaped it.
   * `Content-Type` must be set *before* `.send()` for superagent to ship the
   * string verbatim instead of re-encoding it — the same pattern
   * `jobs.e2e-spec.ts`'s `callback()` helper uses for the internal signature,
   * and for the same reason: the HMAC covers the exact bytes.
   */
  function postWebhook(rawBody: string, signature: string) {
    return request(server)
      .post("/billing/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", signature)
      .send(rawBody);
  }

  // ---------------------------------------------------------------------
  // Plan catalogue
  // ---------------------------------------------------------------------

  it("GET /billing/plans is public and lists all five plans", async () => {
    const res = await request(server).get("/billing/plans");
    expect(res.status).toBe(200);
    const keys = (res.body as { key: string }[]).map((p) => p.key).sort();
    expect(keys).toEqual(["agency", "creator", "free", "starter", "studio"]);
  });

  // ---------------------------------------------------------------------
  // Tax-profile gate
  // ---------------------------------------------------------------------

  it("refuses checkout until the workspace confirms its billing country (orchestrator addendum after A04)", async () => {
    const unconfirmed = await ctx.createUnconfirmedWorkspace();
    const token = ctx.token("admin", unconfirmed);

    const res = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "creator", interval: "month" });

    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "billing/tax_profile_required",
    );
  });

  // ---------------------------------------------------------------------
  // Acceptance criterion 1a: monthly Creator INR checkout → activated
  // ---------------------------------------------------------------------

  it("Creator monthly INR: checkout → subscription.activated → active, mandate cap ₹699", async () => {
    const token = ctx.token("admin");
    const checkout = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "creator", interval: "month" });

    expect(checkout.status).toBe(201); // NestJS default POST status
    const body = checkout.body as {
      subscriptionId: string;
      providerSubscriptionId: string;
      mandateCapMinor: number;
    };
    expect(body.mandateCapMinor).toBe(69_900);

    const stored = await ctx.prisma.subscription.findUniqueOrThrow({
      where: { id: body.subscriptionId },
    });
    expect(stored.status).toBe("pending");
    const mandate = await ctx.prisma.mandate.findUniqueOrThrow({
      where: { id: stored.mandateId! },
    });
    expect(mandate.maxAmountMinor).toBe(69_900);
    expect(mandate.method).toBe("upi_autopay");
    expect(mandate.status).toBe("pending");

    const emitted = ctx.provider.emitWebhook({
      event: "subscription.activated",
      providerSubscriptionId: body.providerSubscriptionId,
      status: "active",
      amountMinor: 69_900,
      currency: "INR",
    });
    const webhook = await postWebhook(emitted.rawBody, emitted.signature);
    expect(webhook.status).toBe(200);
    expect((webhook.body as { status: string }).status).toBe("processed");

    const activated = await ctx.prisma.subscription.findUniqueOrThrow({
      where: { id: body.subscriptionId },
    });
    expect(activated.status).toBe("active");
    const activeMandate = await ctx.prisma.mandate.findUniqueOrThrow({
      where: { id: stored.mandateId! },
    });
    expect(activeMandate.status).toBe("active");
  });

  // ---------------------------------------------------------------------
  // Acceptance criterion 1b: Studio yearly on UPI is refused with alternatives
  // ---------------------------------------------------------------------

  it("Studio yearly INR is refused with halfyear_upi/card_once/enach alternatives", async () => {
    const token = ctx.token("admin");
    const res = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "studio", interval: "year" });

    expect(res.status).toBe(409);
    const body = res.body as {
      error: { code: string; details: { alternatives: { kind: string; amountMinor: number }[] } };
    };
    expect(body.error.code).toBe("billing/mandate_cap_exceeded");
    const kinds = body.error.details.alternatives.map((a) => a.kind).sort();
    expect(kinds).toEqual(["card_once", "enach", "halfyear_upi"]);
    const halfyear = body.error.details.alternatives.find((a) => a.kind === "halfyear_upi");
    expect(halfyear?.amountMinor).toBe(999_600);
  });

  // ---------------------------------------------------------------------
  // Acceptance criterion 1c: halfyear path, two consecutive periods
  // ---------------------------------------------------------------------

  it("Studio halfyear INR: two consecutive `subscription.charged` webhooks advance the period twice", async () => {
    const token = ctx.token("admin");
    const checkout = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "studio", interval: "halfyear" });
    expect(checkout.status).toBe(201);
    const body = checkout.body as {
      subscriptionId: string;
      providerSubscriptionId: string;
      mandateCapMinor: number;
    };
    expect(body.mandateCapMinor).toBe(999_600);

    // Two real "subscription.charged" deliveries for one subscription are six
    // months apart, so `created_at` naturally differs and each gets its own
    // idempotency key. Two *synthetic* ones built back to back in a test
    // would otherwise land in the same Unix second and collide — an artefact
    // of the test, not of `deriveEventId`, which is why `createdAt` is forced
    // apart here rather than changed in the provider.
    const baseCreatedAt = Math.floor(Date.now() / 1000);

    async function chargeOnce(createdAt: number): Promise<void> {
      const before = await ctx.prisma.subscription.findUniqueOrThrow({
        where: { id: body.subscriptionId },
      });
      const emitted = ctx.provider.emitWebhook({
        event: "subscription.charged",
        providerSubscriptionId: body.providerSubscriptionId,
        status: "active",
        amountMinor: 999_600,
        currency: "INR",
        createdAt,
      });
      const res = await postWebhook(emitted.rawBody, emitted.signature);
      expect(res.status).toBe(200);
      expect((res.body as { status: string }).status).toBe("processed");
      const after = await ctx.prisma.subscription.findUniqueOrThrow({
        where: { id: body.subscriptionId },
      });
      expect(after.currentPeriodEnd.getTime()).toBeGreaterThan(before.currentPeriodEnd.getTime());
    }

    await chargeOnce(baseCreatedAt);
    await chargeOnce(baseCreatedAt + 15_000_000); // ~6 months later

    const final = await ctx.prisma.subscription.findUniqueOrThrow({
      where: { id: body.subscriptionId },
    });
    expect(final.status).toBe("active");
  });

  // ---------------------------------------------------------------------
  // Acceptance criterion 1d: pay-once creates a subscription without a mandate
  // ---------------------------------------------------------------------

  it("Starter pay-once: creates a 30-day subscription with no mandate", async () => {
    const token = ctx.token("admin");
    const checkout = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "starter", interval: "once" });
    expect(checkout.status).toBe(201);
    const body = checkout.body as {
      subscriptionId: string;
      providerOrderId: string;
      mandateCapMinor: number | null;
    };
    expect(body.mandateCapMinor).toBeNull();

    const stored = await ctx.prisma.subscription.findUniqueOrThrow({
      where: { id: body.subscriptionId },
    });
    expect(stored.mandateId).toBeNull();
    expect(stored.interval).toBe("once");

    const emitted = ctx.provider.emitWebhook({
      event: "order.paid",
      providerOrderId: body.providerOrderId,
      amountMinor: 29_900,
      currency: "INR",
    });
    const webhook = await postWebhook(emitted.rawBody, emitted.signature);
    expect(webhook.status).toBe(200);

    const activated = await ctx.prisma.subscription.findUniqueOrThrow({
      where: { id: body.subscriptionId },
    });
    expect(activated.status).toBe("active");
    expect(activated.mandateId).toBeNull();
  });

  // ---------------------------------------------------------------------
  // International card path
  // ---------------------------------------------------------------------

  it("USD workspace checkout creates a USD order, no UPI cap applies", async () => {
    const token = ctx.token("admin", ctx.usdWorkspaceId);
    const res = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "studio", interval: "year" });
    expect(res.status).toBe(201);
    const body = res.body as { currency: string; amountMinor: number; method: string };
    expect(body.currency).toBe("USD");
    expect(body.amountMinor).toBe(49_200);
    expect(body.method).toBe("card");
  });

  // ---------------------------------------------------------------------
  // Acceptance criterion 2: webhook replay, tamper, amount mismatch
  // ---------------------------------------------------------------------

  it("replaying the same webhook is a no-op", async () => {
    const token = ctx.token("admin");
    const checkout = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "creator", interval: "month" });
    const body = checkout.body as { subscriptionId: string; providerSubscriptionId: string };

    const emitted = ctx.provider.emitWebhook({
      event: "subscription.activated",
      providerSubscriptionId: body.providerSubscriptionId,
      status: "active",
      amountMinor: 69_900,
      currency: "INR",
    });

    const first = await postWebhook(emitted.rawBody, emitted.signature);
    expect((first.body as { status: string }).status).toBe("processed");

    const second = await postWebhook(emitted.rawBody, emitted.signature);
    expect(second.status).toBe(200);
    expect((second.body as { status: string }).status).toBe("replayed");

    const events = await ctx.prisma.billingEvent.findMany({});
    expect(events).toHaveLength(1);
  });

  it("a tampered signature is refused with 401, not 200", async () => {
    const emitted = ctx.provider.emitWebhook({ event: "subscription.activated" });
    const wrongSignature = ctx.provider.signWrong(emitted.rawBody);

    const res = await postWebhook(emitted.rawBody, wrongSignature);

    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "billing/webhook_signature_invalid",
    );

    const events = await ctx.prisma.billingEvent.findMany({});
    expect(events).toHaveLength(0);
  });

  it("an amount mismatch is flagged and audited, and does not activate the subscription", async () => {
    const token = ctx.token("admin");
    const checkout = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "creator", interval: "month" });
    const body = checkout.body as { subscriptionId: string; providerSubscriptionId: string };

    const emitted = ctx.provider.emitWebhook({
      event: "subscription.activated",
      providerSubscriptionId: body.providerSubscriptionId,
      status: "active",
      amountMinor: 1, // disagrees with the ₹699 the subscription was checked out for
      currency: "INR",
    });
    const res = await postWebhook(emitted.rawBody, emitted.signature);
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("mismatch");

    const event = await ctx.prisma.billingEvent.findFirstOrThrow({});
    expect(event.mismatch).toBe(true);

    const stillPending = await ctx.prisma.subscription.findUniqueOrThrow({
      where: { id: body.subscriptionId },
    });
    expect(stillPending.status).toBe("pending");

    const audited = await ctx.prisma.auditLog.findFirst({
      where: { action: "billing.webhook.amount_mismatch" },
    });
    expect(audited).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // Passes and top-ups: grant credits via the facade
  // ---------------------------------------------------------------------

  it("week_pass checkout, once paid, grants credits through CreditsFacade.grantLot", async () => {
    const noop = ctx.app.get(NoopCreditsFacade);
    const spy = vi.spyOn(noop, "grantLot");

    const token = ctx.token("admin");
    const checkout = await request(server)
      .post("/billing/passes/checkout")
      .set("Authorization", auth(token))
      .send({ kind: "week_pass" });
    expect(checkout.status).toBe(201);
    const body = checkout.body as {
      passPurchaseId: string;
      providerOrderId: string;
      creditsGrantedTenths: number;
    };
    expect(body.creditsGrantedTenths).toBe(400);

    const emitted = ctx.provider.emitWebhook({
      event: "order.paid",
      providerOrderId: body.providerOrderId,
      amountMinor: 5_900,
      currency: "INR",
      notes: {
        workspaceId: ctx.workspaceId,
        passPurchaseId: body.passPurchaseId,
        kind: "week_pass",
        amountMinor: "5900",
        creditsGrantedTenths: "400",
      },
    });
    const webhook = await postWebhook(emitted.rawBody, emitted.signature);
    expect(webhook.status).toBe(200);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: ctx.workspaceId, source: "pass", tenths: 400 }),
    );
    const pass = await ctx.prisma.passPurchase.findUniqueOrThrow({
      where: { id: body.passPurchaseId },
    });
    expect(pass.consumedAt).not.toBeNull();
  });

  it("top-up checkout grants the requested credit pack", async () => {
    const noop = ctx.app.get(NoopCreditsFacade);
    const spy = vi.spyOn(noop, "grantLot");

    const token = ctx.token("admin");
    const checkout = await request(server)
      .post("/billing/topups/checkout")
      .set("Authorization", auth(token))
      .send({ credits: 100 });
    expect(checkout.status).toBe(201);
    const body = checkout.body as {
      passPurchaseId: string;
      providerOrderId: string;
      amountMinor: number;
    };
    expect(body.amountMinor).toBe(14_900);

    const emitted = ctx.provider.emitWebhook({
      event: "order.paid",
      providerOrderId: body.providerOrderId,
      amountMinor: 14_900,
      currency: "INR",
      notes: {
        workspaceId: ctx.workspaceId,
        passPurchaseId: body.passPurchaseId,
        kind: "topup",
        amountMinor: "14900",
        creditsGrantedTenths: "1000",
      },
    });
    await postWebhook(emitted.rawBody, emitted.signature);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ source: "pass", tenths: 1_000 }));
  });

  // ---------------------------------------------------------------------
  // Subscription management
  // ---------------------------------------------------------------------

  async function activeCreatorSubscription(): Promise<{
    subscriptionId: string;
    providerSubscriptionId: string;
  }> {
    const token = ctx.token("admin");
    const checkout = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "creator", interval: "month" });
    const body = checkout.body as { subscriptionId: string; providerSubscriptionId: string };
    const emitted = ctx.provider.emitWebhook({
      event: "subscription.activated",
      providerSubscriptionId: body.providerSubscriptionId,
      status: "active",
      amountMinor: 69_900,
      currency: "INR",
    });
    await postWebhook(emitted.rawBody, emitted.signature);
    return body;
  }

  it("GET /billing/subscription reflects the active subscription", async () => {
    await activeCreatorSubscription();
    const token = ctx.token("admin");
    const res = await request(server)
      .get("/billing/subscription")
      .set("Authorization", auth(token));
    expect(res.status).toBe(200);
    expect((res.body as { status: string; planKey: string }).status).toBe("active");
    expect((res.body as { planKey: string }).planKey).toBe("creator");
  });

  it("cancel sets cancelAtPeriodEnd, resume clears it", async () => {
    await activeCreatorSubscription();
    const token = ctx.token("admin");

    const cancelled = await request(server)
      .post("/billing/subscription/cancel")
      .set("Authorization", auth(token));
    expect(cancelled.status).toBe(201);
    expect((cancelled.body as { cancelAtPeriodEnd: boolean }).cancelAtPeriodEnd).toBe(true);

    const resumed = await request(server)
      .post("/billing/subscription/resume")
      .set("Authorization", auth(token));
    expect(resumed.status).toBe(201);
    expect((resumed.body as { cancelAtPeriodEnd: boolean }).cancelAtPeriodEnd).toBe(false);
  });

  it("pause skips one cycle and can only be used once per 12 months", async () => {
    await activeCreatorSubscription();
    const token = ctx.token("admin");

    const paused = await request(server)
      .post("/billing/subscription/pause")
      .set("Authorization", auth(token));
    expect(paused.status).toBe(201);
    expect((paused.body as { status: string }).status).toBe("paused");

    const resumed = await request(server)
      .post("/billing/subscription/resume")
      .set("Authorization", auth(token));
    expect(resumed.status).toBe(201);
    expect((resumed.body as { status: string }).status).toBe("active");

    const pausedAgain = await request(server)
      .post("/billing/subscription/pause")
      .set("Authorization", auth(token));
    expect(pausedAgain.status).toBe(409);
    expect((pausedAgain.body as { error: { code: string } }).error.code).toBe(
      "billing/pause_limit_reached",
    );
  });

  it("change-preview reports proration and whether the mandate needs re-registration", async () => {
    await activeCreatorSubscription();
    const token = ctx.token("admin");

    const res = await request(server)
      .get("/billing/subscription/change-preview")
      .query({ planKey: "studio", interval: "month" })
      .set("Authorization", auth(token));
    expect(res.status).toBe(200);
    const body = res.body as { newListPriceMinor: number; mandateReRegistrationRequired: boolean };
    expect(body.newListPriceMinor).toBe(199_900);
    expect(body.mandateReRegistrationRequired).toBe(true); // 199,900 > the Creator mandate's 69,900 cap
  });

  it("change-plan downgrade keeps the same mandate; upgrade re-registers it", async () => {
    await activeCreatorSubscription();
    const token = ctx.token("admin");

    const downgrade = await request(server)
      .post("/billing/subscription/change-plan")
      .set("Authorization", auth(token))
      .send({ planKey: "starter", interval: "month" });
    expect(downgrade.status).toBe(201);
    expect((downgrade.body as { planKey: string }).planKey).toBe("starter");

    const upgrade = await request(server)
      .post("/billing/subscription/change-plan")
      .set("Authorization", auth(token))
      .send({ planKey: "studio", interval: "month" });
    expect(upgrade.status).toBe(201);
    // Re-registration returns a checkout payload, not a SubscriptionView.
    expect((upgrade.body as { status: string }).status).toBe("pending");
    expect((upgrade.body as { mandateCapMinor: number }).mandateCapMinor).toBe(199_900);
  });

  it("mandates: list and revoke (revoking cancels the subscription)", async () => {
    await activeCreatorSubscription();
    const token = ctx.token("admin");

    const list = await request(server).get("/billing/mandates").set("Authorization", auth(token));
    expect(list.status).toBe(200);
    const mandates = list.body as { id: string; status: string }[];
    expect(mandates).toHaveLength(1);

    const revoke = await request(server)
      .post(`/billing/mandates/${mandates[0]!.id}/revoke`)
      .set("Authorization", auth(token));
    expect(revoke.status).toBe(201);
    expect((revoke.body as { status: string }).status).toBe("revoked");

    const subscription = await request(server)
      .get("/billing/subscription")
      .set("Authorization", auth(token));
    expect((subscription.body as { status: string }).status).toBe("cancelled");
  });

  // ---------------------------------------------------------------------
  // Renewal and dunning primitives (B01 brief §7; scheduler wiring is B16's)
  // ---------------------------------------------------------------------

  it("initiateRenewal sends the pre-debit notice and stamps the mandate's lastNotificationAt", async () => {
    const { subscriptionId } = await activeCreatorSubscription();
    const stored = await ctx.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });

    const renewal = ctx.app.get(RenewalService);
    await renewal.initiateRenewal(subscriptionId);

    const mandate = await ctx.prisma.mandate.findUniqueOrThrow({
      where: { id: stored.mandateId! },
    });
    expect(mandate.lastNotificationAt).not.toBeNull();

    const audited = await ctx.prisma.auditLog.findFirst({
      where: { action: "billing.renewal.initiated" },
    });
    expect(audited).not.toBeNull();
  });

  it("graceExpiry pauses a past_due subscription once its grace window has passed", async () => {
    const { subscriptionId } = await activeCreatorSubscription();
    await ctx.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: "past_due", graceUntil: new Date(Date.now() - 1_000) },
    });

    const renewal = ctx.app.get(RenewalService);
    const touched = await renewal.graceExpiry();
    expect(touched).toBeGreaterThanOrEqual(1);

    const after = await ctx.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    expect(after.status).toBe("paused");
  });

  it("handleDecline retries a soft decline and offers a fallback for a mandate failure", async () => {
    const { subscriptionId } = await activeCreatorSubscription();
    const renewal = ctx.app.get(RenewalService);

    await renewal.handleDecline(subscriptionId, "insufficient_funds");
    const retryAudit = await ctx.prisma.auditLog.findFirst({
      where: { action: "billing.dunning.stepped", resourceId: subscriptionId },
      orderBy: { at: "desc" },
    });
    expect((retryAudit?.data as { bucket?: string } | null)?.bucket).toBe("insufficient_funds");

    await renewal.handleDecline(subscriptionId, "india_recurring_payment_mandate_canceled");
    const mandateAudit = await ctx.prisma.auditLog.findFirst({
      where: { action: "billing.dunning.stepped", resourceId: subscriptionId },
      orderBy: { at: "desc" },
    });
    expect((mandateAudit?.data as { action?: string } | null)?.action).toBe("offer_fallback");
  });

  it("payment.failed on the webhook path moves the subscription to past_due and steps the dunning ladder", async () => {
    const { subscriptionId, providerSubscriptionId } = await activeCreatorSubscription();

    const emitted = ctx.provider.emitWebhook({
      event: "payment.failed",
      providerSubscriptionId,
      declineCode: "insufficient_funds",
    });
    const res = await postWebhook(emitted.rawBody, emitted.signature);
    expect(res.status).toBe(200);

    const subscription = await ctx.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    expect(subscription.status).toBe("past_due");
    expect(subscription.graceUntil).not.toBeNull();

    const dunningAudit = await ctx.prisma.auditLog.findFirst({
      where: { action: "billing.dunning.stepped" },
    });
    expect(dunningAudit).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // Edge cases: interval/plan errors, pass-kind branches, empty subscription
  // ---------------------------------------------------------------------

  it("checkout refuses an unavailable interval for the plan (Creator has no halfyear price)", async () => {
    const token = ctx.token("admin");
    const res = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "creator", interval: "halfyear" });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "billing/interval_unavailable",
    );
  });

  it("checkout refuses an inactive plan", async () => {
    await ctx.prisma.plan.update({ where: { key: "creator" }, data: { active: false } });
    const token = ctx.token("admin");
    const res = await request(server)
      .post("/billing/checkout")
      .set("Authorization", auth(token))
      .send({ planKey: "creator", interval: "month" });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("billing/plan_inactive");
    await ctx.prisma.plan.update({ where: { key: "creator" }, data: { active: true } });
  });

  it("first_export pass: INR succeeds, USD is refused (04 §Offers has no USD price)", async () => {
    const inrToken = ctx.token("admin");
    const inr = await request(server)
      .post("/billing/passes/checkout")
      .set("Authorization", auth(inrToken))
      .send({ kind: "first_export" });
    expect(inr.status).toBe(201);
    expect((inr.body as { amountMinor: number }).amountMinor).toBe(900);

    const usdToken = ctx.token("admin", ctx.usdWorkspaceId);
    const usd = await request(server)
      .post("/billing/passes/checkout")
      .set("Authorization", auth(usdToken))
      .send({ kind: "first_export" });
    expect(usd.status).toBe(400);
    expect((usd.body as { error: { code: string } }).error.code).toBe(
      "billing/pass_kind_unavailable",
    );
  });

  it("pay_once pass requires planKey, and prices at that plan's monthly rate", async () => {
    const token = ctx.token("admin");
    const missing = await request(server)
      .post("/billing/passes/checkout")
      .set("Authorization", auth(token))
      .send({ kind: "pay_once" });
    expect(missing.status).toBe(400);

    const withPlan = await request(server)
      .post("/billing/passes/checkout")
      .set("Authorization", auth(token))
      .send({ kind: "pay_once", planKey: "creator" });
    expect(withPlan.status).toBe(201);
    expect((withPlan.body as { amountMinor: number }).amountMinor).toBe(69_900);
  });

  it("passes/checkout refuses kind: topup — use /billing/topups/checkout instead", async () => {
    const token = ctx.token("admin");
    const res = await request(server)
      .post("/billing/passes/checkout")
      .set("Authorization", auth(token))
      .send({ kind: "topup" });
    expect(res.status).toBe(400);
  });

  it("an unknown top-up size is refused", async () => {
    const token = ctx.token("admin");
    const res = await request(server)
      .post("/billing/topups/checkout")
      .set("Authorization", auth(token))
      .send({ credits: 12_345 });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("billing/topup_invalid");
  });

  it("the 500-credit top-up needs a paid plan; Free is refused", async () => {
    const token = ctx.token("admin");
    const res = await request(server)
      .post("/billing/topups/checkout")
      .set("Authorization", auth(token))
      .send({ credits: 500 });
    expect(res.status).toBe(409);
  });

  it("GET/cancel on a workspace with no subscription at all is a clean 404", async () => {
    const token = ctx.token("admin");
    const get = await request(server)
      .get("/billing/subscription")
      .set("Authorization", auth(token));
    expect(get.status).toBe(200);
    // `SubscriptionService.get` returns `null` for "no plan on file"; Express
    // sends an empty body for a `null` JSON response rather than the literal
    // text "null", and superagent normalises an empty/unparsed body to `{}}`
    // on `res.body` — so the only stable assertion here is the empty wire
    // body itself, which is what a client-side `res.json() ?? null` sees.
    expect(get.text).toBe("");

    const cancel = await request(server)
      .post("/billing/subscription/cancel")
      .set("Authorization", auth(token));
    expect(cancel.status).toBe(404);
    expect((cancel.body as { error: { code: string } }).error.code).toBe(
      "billing/subscription_not_found",
    );

    const resume = await request(server)
      .post("/billing/subscription/resume")
      .set("Authorization", auth(token));
    expect(resume.status).toBe(404);
  });

  it("payment.refunded for a payment id not on file is handled gracefully, not a crash", async () => {
    const { providerSubscriptionId } = await activeCreatorSubscription();

    // `emitWebhook` always mints a fresh synthetic payment id, which will not
    // match the one already recorded from the earlier `subscription.activated`
    // — the realistic shape of "credits clawback is not implemented against
    // CreditsFacade in Wave 1" (README open question): the refund is logged,
    // not applied, and definitely not a 500.
    const emitted = ctx.provider.emitWebhook({
      event: "payment.refunded",
      providerSubscriptionId,
      paymentStatus: "refunded",
    });
    const res = await postWebhook(emitted.rawBody, emitted.signature);
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("ignored");
  });

  it("a mandate.* event with no resolvable providerMandateId is ignored, not a crash", async () => {
    // `FakeProvider.emitWebhook` does not build a `mandate` payload entity
    // (only Razorpay's actual `mandate.*` events are speculative here — see
    // the README's open question on their exact shape), so this exercises
    // `onMandateEvent`'s defensive "nothing to resolve" branch specifically.
    const emitted = ctx.provider.emitWebhook({ event: "mandate.revoked" });
    const res = await postWebhook(emitted.rawBody, emitted.signature);
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("ignored");
  });

  // ---------------------------------------------------------------------
  // B01b: credits clawback on a refunded pass/top-up purchase
  // ---------------------------------------------------------------------

  describe("B01b: credits clawback on refund", () => {
    async function purchaseWeekPass(): Promise<{
      passPurchaseId: string;
      providerOrderId: string;
    }> {
      const token = ctx.token("admin");
      const checkout = await request(server)
        .post("/billing/passes/checkout")
        .set("Authorization", auth(token))
        .send({ kind: "week_pass" });
      expect(checkout.status).toBe(201);
      const body = checkout.body as { passPurchaseId: string; providerOrderId: string };

      const emitted = ctx.provider.emitWebhook({
        event: "order.paid",
        providerOrderId: body.providerOrderId,
        amountMinor: 5_900,
        currency: "INR",
        notes: {
          workspaceId: ctx.workspaceId,
          passPurchaseId: body.passPurchaseId,
          kind: "week_pass",
          amountMinor: "5900",
          creditsGrantedTenths: "400",
        },
      });
      const res = await postWebhook(emitted.rawBody, emitted.signature);
      expect(res.status).toBe(200);
      return body;
    }

    it("payment.refunded on a pass purchase records refundedAt and audits the clawback attempt (idempotent)", async () => {
      const { passPurchaseId, providerOrderId } = await purchaseWeekPass();

      const before = await ctx.prisma.passPurchase.findUniqueOrThrow({
        where: { id: passPurchaseId },
      });
      expect(before.refundedAt).toBeNull();
      // This suite binds `CREDITS_FACADE` to `NoopCreditsFacade` on purpose
      // (billing-harness.ts) — its `grantLot` returns a synthetic id with no
      // backing `credit_lots` row, and `grantPass` catches the resulting
      // foreign-key violation rather than storing it (webhooks.service.ts), so
      // `lotId` legitimately stays null here. `refunds.service.test.ts` covers
      // the case where a real lot *is* on file (mocking `LedgerCreditsFacade`),
      // which this e2e harness cannot produce without swapping in the real
      // ledger — not this suite's job (it is about billing's own logic).
      expect(before.lotId).toBeNull();

      const emitted = ctx.provider.emitWebhook({
        event: "payment.refunded",
        providerOrderId,
        paymentStatus: "refunded",
        notes: { passPurchaseId },
      });
      const first = await postWebhook(emitted.rawBody, emitted.signature);
      expect(first.status).toBe(200);
      expect((first.body as { status: string }).status).toBe("processed");

      const after = await ctx.prisma.passPurchase.findUniqueOrThrow({
        where: { id: passPurchaseId },
      });
      expect(after.refundedAt).not.toBeNull();

      const audited = await ctx.prisma.auditLog.findFirst({
        where: { action: "billing.credits.clawback_unavailable", resourceId: passPurchaseId },
      });
      expect(audited).not.toBeNull();
      expect((audited?.data as { reason?: string } | null)?.reason).toBe("no_lot_on_file");

      // Replaying the webhook (a different delivery, same purchase) must not
      // attempt the clawback a second time.
      const secondEmitted = ctx.provider.emitWebhook({
        event: "payment.refunded",
        providerOrderId,
        paymentStatus: "refunded",
        notes: { passPurchaseId },
        createdAt: Math.floor(Date.now() / 1000) + 1,
      });
      await postWebhook(secondEmitted.rawBody, secondEmitted.signature);
      const clawbackAudits = await ctx.prisma.auditLog.findMany({
        where: { action: "billing.credits.clawback_unavailable", resourceId: passPurchaseId },
      });
      expect(clawbackAudits).toHaveLength(1);
    });

    it("POST /billing/passes/{id}/refund (admin path): calls the provider, attempts the clawback, is idempotent", async () => {
      const { passPurchaseId } = await purchaseWeekPass();
      const token = ctx.token("admin");

      const refund = await request(server)
        .post(`/billing/passes/${passPurchaseId}/refund`)
        .set("Authorization", auth(token))
        .send({
          providerPaymentId: "pay_manual_1",
          amountMinor: 5_900,
          reason: "customer request",
        });
      expect(refund.status).toBe(201);
      const body = refund.body as { outcome: string; providerRefundId: string };
      // See the previous test: this harness's no-op credits facade means no
      // real lot is ever on file, so the outcome is "nothing_to_claw_back",
      // not "manual_action_required" (that branch is unit-tested instead).
      expect(body.outcome).toBe("nothing_to_claw_back");
      expect(ctx.provider.refunds).toContainEqual({
        providerPaymentId: "pay_manual_1",
        amountMinor: 5_900,
      });

      const issued = await ctx.prisma.auditLog.findFirst({
        where: { action: "billing.refund.issued" },
      });
      expect(issued).not.toBeNull();

      const again = await request(server)
        .post(`/billing/passes/${passPurchaseId}/refund`)
        .set("Authorization", auth(token))
        .send({ providerPaymentId: "pay_manual_1", amountMinor: 5_900 });
      expect(again.status).toBe(409);
      expect((again.body as { error: { code: string } }).error.code).toBe(
        "billing/already_refunded",
      );
    });

    it("refunding an unknown pass purchase is a clean 404", async () => {
      const token = ctx.token("admin");
      const res = await request(server)
        .post("/billing/passes/01JNOSUCHPASS000000000000/refund")
        .set("Authorization", auth(token))
        .send({ providerPaymentId: "pay_x", amountMinor: 100 });
      expect(res.status).toBe(404);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        "billing/pass_purchase_not_found",
      );
    });
  });
});
