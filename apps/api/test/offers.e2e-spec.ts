/**
 * The B04 acceptance suite: ₹9 pass eligibility and lifecycle, the manifest
 * re-issue after a ₹9 purchase (A21 integration), week-pass entitlement raise
 * and expiry, the Free top-up lot, and `/admin/metrics/offers` — against a
 * real PostgreSQL and a real Redis, all through `FakeProvider`, the same
 * pattern `billing.e2e-spec.ts` and `exports.e2e-spec.ts` already use.
 *
 * Two harnesses, because the ₹9-pass/manifest tests need a real project with
 * media and an EDG document (`edg-harness.ts`) while the pass-lifecycle,
 * week-pass, top-up and metrics tests only need billing's own tenant setup
 * (`billing-harness.ts`) — reusing both rather than building a third.
 */
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  billingSkipReason,
  createBillingTestContext,
  type BillingTestContext,
} from "./billing-harness.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { createEdgTestContext, edgSkipReason, type EdgTestContext } from "./edg-harness.js";
import { PLAN_SEEDS, seedUlid } from "../prisma/seed-data.js";
import { BILLING_PROVIDER } from "../src/billing/provider.js";
import { type FakeProvider } from "../src/billing/providers/fake.provider.js";
import { WebhooksService } from "../src/billing/webhooks.service.js";
import { EntitlementService } from "../src/workspaces/entitlement.service.js";

import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) console.warn(`[offers.e2e] skipped: ${skipReason}`);

const auth = (token: string) => `Bearer ${token}`;

// ---------------------------------------------------------------------------
// Eligibility, week pass, top-up, admin metrics — billing-harness is enough
// ---------------------------------------------------------------------------

describe.skipIf(!available)("offers — eligibility, week pass, top-up, metrics (e2e)", () => {
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

  function postWebhook(rawBody: string, signature: string) {
    return request(server)
      .post("/billing/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", signature)
      .send(rawBody);
  }

  it("GET /offers/eligibility reflects an unused ₹9 pass and prices from the catalogue", async () => {
    const token = ctx.token("admin");
    const res = await request(server).get("/offers/eligibility").set("Authorization", auth(token));
    expect(res.status).toBe(200);
    const body = res.body as {
      ninePass: {
        available: boolean;
        eligibleToBuy: boolean;
        priceMinor: number;
        currency: string;
      };
      weekPass: { active: boolean; priceMinor: number };
      topupFree149: { available: boolean; priceMinor: number; credits: number };
    };
    expect(body.ninePass.available).toBe(false);
    expect(body.ninePass.eligibleToBuy).toBe(true);
    expect(body.ninePass.priceMinor).toBe(900);
    expect(body.ninePass.currency).toBe("INR");
    expect(body.weekPass.active).toBe(false);
    expect(body.weekPass.priceMinor).toBe(5_900);
    expect(body.topupFree149.available).toBe(true);
    expect(body.topupFree149.priceMinor).toBe(14_900);
    expect(body.topupFree149.credits).toBe(100);
  });

  it("buying a ₹9 pass makes it available; buying a second within 30 days is refused", async () => {
    const token = ctx.token("admin");

    const first = await request(server)
      .post("/billing/passes/checkout")
      .set("Authorization", auth(token))
      .send({ kind: "first_export" });
    expect(first.status).toBe(201);
    const firstBody = first.body as { providerOrderId: string };

    const emitted = ctx.provider.emitWebhook({
      event: "order.paid",
      providerOrderId: firstBody.providerOrderId,
      amountMinor: 900,
      currency: "INR",
    });
    const webhook = await postWebhook(emitted.rawBody, emitted.signature);
    expect(webhook.status).toBe(200);

    const afterPurchase = await request(server)
      .get("/offers/eligibility")
      .set("Authorization", auth(token));
    const afterBody = afterPurchase.body as {
      ninePass: { available: boolean; eligibleToBuy: boolean; reason: string | null };
    };
    expect(afterBody.ninePass.available).toBe(true);
    expect(afterBody.ninePass.eligibleToBuy).toBe(false);
    expect(afterBody.ninePass.reason).toBe("purchased_within_30_days");

    const second = await request(server)
      .post("/billing/passes/checkout")
      .set("Authorization", auth(token))
      .send({ kind: "first_export" });
    expect(second.status).toBe(409);
    expect((second.body as { error: { code: string } }).error.code).toBe(
      "offers/nine_pass_ineligible",
    );

    const passes = await request(server).get("/offers/passes").set("Authorization", auth(token));
    expect(passes.status).toBe(200);
    const list = passes.body as { kind: string; status: string }[];
    expect(list.some((p) => p.kind === "first_export" && p.status === "available")).toBe(true);
  });

  it("₹9 checkout is refused once the workspace is on a paid plan", async () => {
    const token = ctx.token("admin");
    const planId = await ctx.planId("creator");
    await ctx.prisma.subscription.create({
      data: {
        id: seedUlid(`sub-${Date.now()}`),
        workspaceId: ctx.workspaceId,
        planId,
        status: "active",
        interval: "month",
        currency: "INR",
        listPriceMinor: 69_900,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      },
    });

    const res = await request(server)
      .post("/billing/passes/checkout")
      .set("Authorization", auth(token))
      .send({ kind: "first_export" });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "offers/nine_pass_ineligible",
    );
  });

  it("week_pass: raises the effective plan to Starter and grants 40 credits; expires on its own endsAt", async () => {
    const token = ctx.token("admin");
    const entitlements = ctx.app.get(EntitlementService);

    const before = await request(server)
      .get(`/workspaces/${ctx.workspaceId}/entitlement`)
      .set("Authorization", auth(token));
    expect((before.body as { planKey: string }).planKey).toBe("free");

    const checkout = await request(server)
      .post("/billing/passes/checkout")
      .set("Authorization", auth(token))
      .send({ kind: "week_pass" });
    expect(checkout.status).toBe(201);
    const checkoutBody = checkout.body as { providerOrderId: string };

    const emitted = ctx.provider.emitWebhook({
      event: "order.paid",
      providerOrderId: checkoutBody.providerOrderId,
      amountMinor: 5_900,
      currency: "INR",
    });
    expect((await postWebhook(emitted.rawBody, emitted.signature)).status).toBe(200);
    await entitlements.invalidate(ctx.workspaceId);

    const during = await request(server)
      .get(`/workspaces/${ctx.workspaceId}/entitlement`)
      .set("Authorization", auth(token));
    expect((during.body as { planKey: string }).planKey).toBe("starter");

    const pass = await ctx.prisma.passPurchase.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId, kind: "week_pass" },
    });
    expect(pass.creditsGrantedTenths).toBe(400);

    // Fake the clock forward by moving `endsAt` into the past rather than
    // mocking `Date.now` — `EntitlementService.compute` reads it with `new
    // Date()`, so this is equivalent and needs no fake-timer library.
    await ctx.prisma.passPurchase.update({
      where: { id: pass.id },
      data: { endsAt: new Date(Date.now() - 1_000) },
    });
    await entitlements.invalidate(ctx.workspaceId);

    const after = await request(server)
      .get(`/workspaces/${ctx.workspaceId}/entitlement`)
      .set("Authorization", auth(token));
    expect((after.body as { planKey: string }).planKey).toBe("free");
  });

  it("₹149/100-credit top-up is allowed on Free and grants the lot through CreditsFacade", async () => {
    const token = ctx.token("admin");
    const checkout = await request(server)
      .post("/billing/topups/checkout")
      .set("Authorization", auth(token))
      .send({ credits: 100 });
    expect(checkout.status).toBe(201);
    const body = checkout.body as { amountMinor: number; providerOrderId: string };
    expect(body.amountMinor).toBe(14_900);

    const emitted = ctx.provider.emitWebhook({
      event: "order.paid",
      providerOrderId: body.providerOrderId,
      amountMinor: 14_900,
      currency: "INR",
    });
    expect((await postWebhook(emitted.rawBody, emitted.signature)).status).toBe(200);

    const pass = await ctx.prisma.passPurchase.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId, kind: "topup" },
    });
    expect(pass.creditsGrantedTenths).toBe(1_000);
    expect(pass.consumedAt).not.toBeNull();
  });

  it("GET /admin/metrics/offers is forbidden for a non-admin and reports a purchase+upgrade for an admin", async () => {
    const token = ctx.token("admin");

    const forbidden = await request(server)
      .get("/admin/metrics/offers")
      .set("Authorization", auth(token));
    expect(forbidden.status).toBe(403);

    const checkout = await request(server)
      .post("/billing/passes/checkout")
      .set("Authorization", auth(token))
      .send({ kind: "first_export" });
    const checkoutBody = checkout.body as { providerOrderId: string };
    const emitted = ctx.provider.emitWebhook({
      event: "order.paid",
      providerOrderId: checkoutBody.providerOrderId,
      amountMinor: 900,
      currency: "INR",
    });
    expect((await postWebhook(emitted.rawBody, emitted.signature)).status).toBe(200);

    // "Upgrade within 60 days": a paid subscription created right after the purchase.
    const planId = await ctx.planId("creator");
    await ctx.prisma.subscription.create({
      data: {
        id: seedUlid(`sub-metrics-${Date.now()}`),
        workspaceId: ctx.workspaceId,
        planId,
        status: "active",
        interval: "month",
        currency: "INR",
        listPriceMinor: 69_900,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      },
    });

    const adminToken = await ctx.adminToken();
    const metrics = await request(server)
      .get("/admin/metrics/offers")
      .set("Authorization", auth(adminToken));
    expect(metrics.status).toBe(200);
    const body = metrics.body as {
      ninePass: { totalPurchases: number; upgradedWithinWindow: number; recommendation: string };
    };
    expect(body.ninePass.totalPurchases).toBeGreaterThanOrEqual(1);
    expect(body.ninePass.upgradedWithinWindow).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// ₹9 pass ledger + manifest re-issue — needs a real project/media/EDG
// ---------------------------------------------------------------------------

describe.skipIf(!available)("offers — ₹9 pass ledger and manifest re-issue (e2e)", () => {
  let ctx: EdgTestContext;
  let base: string;

  beforeAll(async () => {
    const created = await createEdgTestContext();
    if (created === null) throw new Error(`offers/edg suite could not start: ${edgSkipReason}`);
    ctx = created;
    base = `http://127.0.0.1:${String(ctx.port)}`;

    for (const plan of PLAN_SEEDS) {
      await ctx.prisma.plan.upsert({
        where: { key: plan.key },
        update: {
          entitlements: plan.entitlements,
          creditsPerMonthTenths: plan.creditsPerMonthTenths,
        },
        create: {
          id: seedUlid(`plan:${plan.key}`),
          key: plan.key,
          name: plan.name,
          prices: plan.prices,
          creditsPerMonthTenths: plan.creditsPerMonthTenths,
          seatPrice: plan.seatPrice ?? undefined,
          entitlements: plan.entitlements,
          active: true,
        },
      });
    }
    await ctx.prisma.workspace.update({
      where: { id: ctx.workspaceId },
      data: { currency: "INR", billingCountryConfirmedAt: new Date(), billingStateCode: "27" },
    });
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  interface HttpResult<T = unknown> {
    status: number;
    body: T;
  }

  async function call<T = unknown>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<HttpResult<T>> {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
      ...(payload === undefined ? {} : { body: payload }),
    });
    const text = await response.text();
    return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as T };
  }

  interface DecisionBody {
    exportId: string;
    path: "browser" | "cloud";
    reasons: string[];
    watermarked: boolean;
    manifest?: Record<string, unknown>;
  }

  it("Free workspace: watermarked export → buys ₹9 → re-requesting the same export is clean → completion redeems the pass", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor", ctx.workspaceId);
    const adminToken = ctx.token("admin", ctx.workspaceId);

    // Spend the signup gift first so the *next* export is genuinely watermarked
    // (D04: Free gets one clean export before the ₹9 offer is what clears it).
    await ctx.prisma.workspace.update({
      where: { id: ctx.workspaceId },
      data: { signupGiftConsumedAt: new Date() },
    });

    const requestBody = {
      kind: "video",
      preset: "reels",
      outputKind: "video",
      mode: "browser",
      script: "roman",
      // A21b: an explicit `mode: "browser"` request is judged against the real
      // capability probe (D34) and 409s as `export/unsupported_in_browser`
      // without one — this suite predates A21b, and a real browser client
      // always sends this alongside the request (see referrals-http.e2e-spec.ts,
      // which needs the same fixture for the same reason).
      capabilities: { codecs: ["avc1.42001f"], audioEncoder: true },
    };

    const watermarked = await call<DecisionBody>("POST", `/projects/${seeded.projectId}/exports`, {
      token,
      body: requestBody,
    });
    expect(watermarked.status).toBe(201);
    expect(watermarked.body.watermarked).toBe(true);

    // --- buy the ₹9 pass and land the payment webhook, in-process, exactly the
    // way `offers-dev.controller.ts`'s test hook does over HTTP -------------
    const checkout = await call<{ providerOrderId: string }>("POST", "/billing/passes/checkout", {
      token: adminToken,
      body: { kind: "first_export" },
    });
    expect(checkout.status).toBe(201);

    const provider = ctx.app.get(BILLING_PROVIDER) as FakeProvider;
    const webhooks = ctx.app.get(WebhooksService);
    const emitted = provider.emitWebhook({
      event: "order.paid",
      providerOrderId: checkout.body.providerOrderId,
      amountMinor: 900,
      currency: "INR",
    });
    const outcome = await webhooks.handleRazorpay(Buffer.from(emitted.rawBody), emitted.signature);
    expect(outcome.status).toBe("processed");

    // --- re-request the SAME export: no re-render needed, this is the
    // "re-issue" the brief describes — the client just calls the export
    // endpoint again and gets a clean manifest back -------------------------
    const reissued = await call<DecisionBody>("POST", `/projects/${seeded.projectId}/exports`, {
      token,
      body: requestBody,
    });
    expect(reissued.status).toBe(201);
    expect(reissued.body.watermarked).toBe(false);
    expect(reissued.body.reasons.join(" ")).toMatch(/₹9/);
    const manifest = reissued.body.manifest as { manifestId: string } | undefined;
    expect(manifest).toBeDefined();

    const manifestRow = await ctx.prisma.exportManifest.findUniqueOrThrow({
      where: { id: manifest?.manifestId },
    });
    expect(manifestRow.consumesNinePass).toBe(true);

    // A third request, before completion, must NOT see the pass as available
    // any more — one paid pass, one clean export (it is still "available" in
    // the ledger sense until a manifest actually *completes*, matching the
    // decision engine's own "no re-render if the render has not started"
    // contract: nothing is spent until the browser finishes).
    const passesBeforeComplete = await ctx.prisma.passPurchase.findMany({
      where: { workspaceId: ctx.workspaceId, kind: "first_export" },
    });
    expect(passesBeforeComplete).toHaveLength(1);
    expect(passesBeforeComplete[0]?.redeemedAt).toBeNull();

    // --- complete the clean manifest: the pass is now spent -----------------
    const complete = await call("POST", `/exports/manifests/${manifestRow.id}/complete`, {
      token,
      body: { sizeBytes: 1_000, durationMs: 5_000, checksum: "sha256:abc" },
    });
    expect(complete.status).toBe(201);

    const redeemed = await ctx.prisma.passPurchase.findUniqueOrThrow({
      where: { id: passesBeforeComplete[0]?.id },
    });
    expect(redeemed.redeemedAt).not.toBeNull();
    expect(redeemed.redeemedManifestId).toBe(manifestRow.id);

    // --- and a further export request goes back to watermarked --------------
    const afterSpend = await call<DecisionBody>("POST", `/projects/${seeded.projectId}/exports`, {
      token,
      body: requestBody,
    });
    expect(afterSpend.status).toBe(201);
    expect(afterSpend.body.watermarked).toBe(true);
  });
});
