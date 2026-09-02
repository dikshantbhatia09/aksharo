/**
 * B13's acceptance criterion, verified end to end against a real
 * PostgreSQL and Redis: "support role can view but not refund; finance can
 * refund with reason." Reuses `billing-harness.ts` (already the full
 * `AppModule`, so every admin module this WP added is live) and a real
 * ₹149/100-credit top-up checkout + webhook to get a genuine `PassPurchase`
 * + `CreditLot` (with `amountMinor` on file) to refund against — the same
 * flow `offers.e2e-spec.ts`'s top-up test uses.
 */
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createAdminContext } from "./auth-harness.js";
import {
  billingSkipReason,
  createBillingTestContext,
  type BillingTestContext,
} from "./billing-harness.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { seedUlid } from "../prisma/seed-data.js";

import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) console.warn(`[admin-billing.e2e] skipped: ${skipReason}`);

const auth = (token: string) => `Bearer ${token}`;

describe.skipIf(!available)("admin billing — role matrix + refund (e2e, B13)", () => {
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

  /**
   * A real top-up purchase (checkout → webhook → PassPurchase), then a
   * directly-seeded `CreditLot` linked onto it. `billing-harness.ts` binds
   * `CREDITS_FACADE` to `NoopCreditsFacade` on purpose (billing's own doc
   * comment: this suite tests billing's logic, not the ledger — B02's own
   * suite, `credits-ledger.e2e-spec.ts`, covers that), which means the
   * webhook path never persists a real `credit_lots` row here. The admin
   * refund policy this WP owns needs one to price against, so it is seeded
   * directly — arranging a precondition B02 already tests elsewhere, not
   * re-testing the ledger itself.
   */
  async function purchaseTopup(): Promise<string> {
    const token = ctx.token("admin");
    const checkout = await request(server)
      .post("/billing/topups/checkout")
      .set("Authorization", auth(token))
      .send({ credits: 100 });
    expect(checkout.status).toBe(201);
    const body = checkout.body as { amountMinor: number; providerOrderId: string };

    const emitted = ctx.provider.emitWebhook({
      event: "order.paid",
      providerOrderId: body.providerOrderId,
      amountMinor: body.amountMinor,
      currency: "INR",
    });
    const webhook = await request(server)
      .post("/billing/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", emitted.signature)
      .send(emitted.rawBody);
    expect(webhook.status).toBe(200);

    const pass = await ctx.prisma.passPurchase.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId, kind: "topup" },
    });

    const account = await ctx.prisma.creditAccount.upsert({
      where: { workspaceId: ctx.workspaceId },
      create: {
        id: seedUlid(`acct-${pass.id}`),
        workspaceId: ctx.workspaceId,
        balanceTenths: 1000,
      },
      update: {},
    });
    const lot = await ctx.prisma.creditLot.create({
      data: {
        id: seedUlid(`lot-${pass.id}`),
        accountId: account.id,
        source: "pass",
        grantedTenths: pass.creditsGrantedTenths,
        remainingTenths: pass.creditsGrantedTenths,
        currency: "INR",
        amountMinor: body.amountMinor,
      },
    });
    await ctx.prisma.passPurchase.update({ where: { id: pass.id }, data: { lotId: lot.id } });

    return pass.id;
  }

  it("support can view workspace detail but cannot refund", async () => {
    const passId = await purchaseTopup();
    const support = await createAdminContext({ app: ctx.app, roles: ["support"] });

    const view = await request(server)
      .get(`/admin/workspaces/${ctx.workspaceId}`)
      .set("Authorization", auth(support.accessToken));
    expect(view.status).toBe(200);

    const refund = await request(server)
      .post(`/admin/billing/passes/${passId}/refund`)
      .set("Authorization", auth(support.accessToken))
      .send({
        providerPaymentId: "pay_test_1",
        reasonCode: "customer_request",
        reason: "requested a refund within the window",
      });
    expect(refund.status).toBe(403);

    const untouched = await ctx.prisma.passPurchase.findUniqueOrThrow({ where: { id: passId } });
    expect(untouched.refundedAt).toBeNull();
  });

  it("finance can refund with a reason, in full within the 7-day window", async () => {
    const passId = await purchaseTopup();
    const finance = await createAdminContext({ app: ctx.app, roles: ["finance"] });

    const refund = await request(server)
      .post(`/admin/billing/passes/${passId}/refund`)
      .set("Authorization", auth(finance.accessToken))
      .send({
        providerPaymentId: "pay_test_2",
        reasonCode: "customer_request",
        reason: "requested a refund within the window",
      });
    expect(refund.status).toBe(200);
    const body = refund.body as { policy: string; refundAmountMinor: number };
    expect(body.policy).toBe("full");
    expect(body.refundAmountMinor).toBe(14_900);

    const pass = await ctx.prisma.passPurchase.findUniqueOrThrow({ where: { id: passId } });
    expect(pass.refundedAt).not.toBeNull();

    const audited = await ctx.prisma.auditLog.findFirst({
      where: { action: "admin.billing.refund_issued", resourceId: passId },
    });
    expect(audited).not.toBeNull();
    expect((audited?.data as { reason?: string } | null)?.reason).toBe(
      "requested a refund within the window",
    );
  });

  it("refuses a refund with no reason (validation, not just RBAC)", async () => {
    const passId = await purchaseTopup();
    const finance = await createAdminContext({ app: ctx.app, roles: ["finance"] });

    const refund = await request(server)
      .post(`/admin/billing/passes/${passId}/refund`)
      .set("Authorization", auth(finance.accessToken))
      .send({ providerPaymentId: "pay_test_3", reasonCode: "customer_request", reason: "" });
    expect(refund.status).toBe(400);
  });
});
