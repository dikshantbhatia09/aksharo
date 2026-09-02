import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RefundsService } from "./refunds.service.js";
import { AppException } from "../common/errors/error-codes.js";
import { CREDIT_ERROR_CODES } from "../credits/credits.errors.js";

import type { RefundPassDto } from "./billing.dto.js";

const WORKSPACE = "01JWORKSPACE00000000000000";
const PASS = "01JPASS000000000000000000A";
const LOT = "01JLOT0000000000000000000A";

function makePass(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PASS,
    workspaceId: WORKSPACE,
    kind: "week_pass",
    lotId: LOT,
    creditsGrantedTenths: 400,
    refundedAt: null,
    providerOrderId: "order_1",
    ...overrides,
  };
}

/**
 * `RefundsService` needs only three collaborators, each called through a
 * narrow, known surface — plain `vi.fn()` mocks are more direct here than
 * threading a full fake Prisma client through `passPurchase`/`payment`
 * methods it never touches.
 */
function harness() {
  const prisma = {
    passPurchase: {
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
    },
  };
  const ledger = { revokeLot: vi.fn() };
  const audit = { record: vi.fn(async () => undefined) };
  const provider = { refund: vi.fn() };

  const service = new RefundsService(
    prisma as never,
    ledger as never,
    audit as never,
    provider as never,
  );
  return { service, prisma, ledger, audit, provider };
}

describe("RefundsService.clawbackPassPurchase", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it("is idempotent: a second call for the same purchase is a no-op", async () => {
    h.prisma.passPurchase.updateMany.mockResolvedValue({ count: 0 });

    const result = await h.service.clawbackPassPurchase(PASS, "test");

    expect(result).toEqual({ outcome: "already_processed" });
    expect(h.prisma.passPurchase.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(h.ledger.revokeLot).not.toHaveBeenCalled();
  });

  it("has nothing to claw back when the purchase never recorded a lot", async () => {
    h.prisma.passPurchase.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.passPurchase.findUniqueOrThrow.mockResolvedValue(makePass({ lotId: null }));

    const result = await h.service.clawbackPassPurchase(PASS, "test");

    expect(result).toEqual({ outcome: "nothing_to_claw_back" });
    expect(h.ledger.revokeLot).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "billing.credits.clawback_unavailable" }),
    );
  });

  it("claws back in full when the lot still has everything (no shortfall)", async () => {
    h.prisma.passPurchase.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.passPurchase.findUniqueOrThrow.mockResolvedValue(makePass());
    h.ledger.revokeLot.mockResolvedValue({ revokedTenths: 400, shortfallTenths: 0 });

    const result = await h.service.clawbackPassPurchase(PASS, "refund test");

    expect(result).toEqual({ outcome: "clawed_back", revokedTenths: 400 });
    expect(h.ledger.revokeLot).toHaveBeenCalledWith({
      lotId: LOT,
      tenths: 400,
      reason: "refund test",
      refundId: PASS,
    });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.credits.clawed_back",
        data: expect.objectContaining({ lotId: LOT, revokedTenths: 400 }),
      }),
    );
  });

  it("reports manual_action_required with the shortfall when some tenths were already spent", async () => {
    h.prisma.passPurchase.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.passPurchase.findUniqueOrThrow.mockResolvedValue(makePass());
    h.ledger.revokeLot.mockResolvedValue({ revokedTenths: 150, shortfallTenths: 250 });

    const result = await h.service.clawbackPassPurchase(PASS, "refund test");

    expect(result).toEqual({
      outcome: "manual_action_required",
      revokedTenths: 150,
      shortfallTenths: 250,
    });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.credits.clawback_unavailable",
        data: expect.objectContaining({
          reason: "shortfall",
          revokedTenths: 150,
          shortfallTenths: 250,
        }),
      }),
    );
  });

  it("treats a not-found lot the same as a full shortfall, defensively", async () => {
    h.prisma.passPurchase.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.passPurchase.findUniqueOrThrow.mockResolvedValue(makePass());
    h.ledger.revokeLot.mockRejectedValue(
      new AppException(
        CREDIT_ERROR_CODES.lotNotFound,
        `No such lot: ${LOT}.`,
        HttpStatus.NOT_FOUND,
      ),
    );

    const result = await h.service.clawbackPassPurchase(PASS, "refund test");

    expect(result).toEqual({
      outcome: "manual_action_required",
      revokedTenths: 0,
      shortfallTenths: 400,
    });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.credits.clawback_unavailable",
        data: expect.objectContaining({ reason: "lot_not_found" }),
      }),
    );
  });

  it("re-throws any other error from revokeLot rather than swallowing it", async () => {
    h.prisma.passPurchase.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.passPurchase.findUniqueOrThrow.mockResolvedValue(makePass());
    h.ledger.revokeLot.mockRejectedValue(new Error("database is on fire"));

    await expect(h.service.clawbackPassPurchase(PASS, "test")).rejects.toThrow(
      "database is on fire",
    );
  });
});

describe("RefundsService.refundPassPurchase (admin/API path)", () => {
  let h: ReturnType<typeof harness>;
  const context = {};
  const body: RefundPassDto = {
    providerPaymentId: "pay_live_1",
    amountMinor: 5_900,
    reason: "customer request",
  };

  beforeEach(() => {
    h = harness();
  });

  it("404s for a pass purchase that does not belong to the caller's workspace", async () => {
    h.prisma.passPurchase.findFirst.mockResolvedValue(null);

    await expect(
      h.service.refundPassPurchase(WORKSPACE, PASS, body, "actor-1", context as never),
    ).rejects.toMatchObject({ code: "billing/pass_purchase_not_found" });
    expect(h.provider.refund).not.toHaveBeenCalled();
  });

  it("409s for a purchase already refunded", async () => {
    h.prisma.passPurchase.findFirst.mockResolvedValue(makePass({ refundedAt: new Date() }));

    await expect(
      h.service.refundPassPurchase(WORKSPACE, PASS, body, "actor-1", context as never),
    ).rejects.toMatchObject({ code: "billing/already_refunded" });
    expect(h.provider.refund).not.toHaveBeenCalled();
  });

  it("calls the provider's refund API, then the same clawback the webhook path uses", async () => {
    h.prisma.passPurchase.findFirst.mockResolvedValue(makePass());
    h.provider.refund.mockResolvedValue({ providerRefundId: "rfnd_1", status: "processed" });
    h.prisma.passPurchase.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.passPurchase.findUniqueOrThrow.mockResolvedValue(makePass());
    h.ledger.revokeLot.mockResolvedValue({ revokedTenths: 400, shortfallTenths: 0 });

    const result = await h.service.refundPassPurchase(
      WORKSPACE,
      PASS,
      body,
      "actor-1",
      context as never,
    );

    expect(h.provider.refund).toHaveBeenCalledWith({
      providerPaymentId: "pay_live_1",
      amountMinor: 5_900,
      reason: "customer request",
    });
    expect(result).toEqual({ outcome: "clawed_back", providerRefundId: "rfnd_1" });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "billing.refund.issued" }),
    );
  });

  it("carries the shortfall onto the refund-issued audit row when the clawback is partial", async () => {
    h.prisma.passPurchase.findFirst.mockResolvedValue(makePass());
    h.provider.refund.mockResolvedValue({ providerRefundId: "rfnd_2", status: "processed" });
    h.prisma.passPurchase.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.passPurchase.findUniqueOrThrow.mockResolvedValue(makePass());
    h.ledger.revokeLot.mockResolvedValue({ revokedTenths: 100, shortfallTenths: 300 });

    const result = await h.service.refundPassPurchase(
      WORKSPACE,
      PASS,
      body,
      "actor-1",
      context as never,
    );

    expect(result).toEqual({ outcome: "manual_action_required", providerRefundId: "rfnd_2" });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.refund.issued",
        data: expect.objectContaining({ clawback: "manual_action_required", shortfallTenths: 300 }),
      }),
    );
  });
});
