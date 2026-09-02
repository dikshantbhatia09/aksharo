import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminBillingService } from "./admin-billing.service.js";
import { AppException } from "../../common/errors/error-codes.js";

import type { AdminPrincipal } from "../admin.guard.js";

const WORKSPACE = "01JWORKSPACE00000000000000";
const PASS = "01JPASS000000000000000000A";
const LOT = "01JLOT0000000000000000000A";
const INVOICE = "01JINVOICE0000000000000000";

const ADMIN: AdminPrincipal = {
  userId: "01JADMIN00000000000000000A",
  workspaceId: WORKSPACE,
  roles: ["finance"],
};

function makePass(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PASS,
    workspaceId: WORKSPACE,
    lotId: LOT,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeLot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: LOT,
    grantedTenths: 1000,
    remainingTenths: 1000,
    amountMinor: 90000,
    ...overrides,
  };
}

/** Same narrow-mock style as `billing/refunds.service.test.ts`. */
function harness() {
  const prisma = {
    passPurchase: { findUnique: vi.fn() },
    creditLot: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
  };
  const refunds = { refundPassPurchase: vi.fn() };
  const invoices = { generateCreditNote: vi.fn() };
  const audit = { record: vi.fn(async () => undefined) };

  const service = new AdminBillingService(
    prisma as never,
    refunds as never,
    invoices as never,
    audit as never,
  );
  return { service, prisma, refunds, invoices, audit };
}

describe("AdminBillingService.refundPassPurchase", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it("404s a purchase that does not exist", async () => {
    h.prisma.passPurchase.findUnique.mockResolvedValue(null);
    await expect(
      h.service.refundPassPurchase(
        PASS,
        {
          providerPaymentId: "pay_1",
          reasonCode: "customer_request",
          reason: "requested by customer",
        },
        ADMIN,
        "203.0.113.1",
      ),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("refunds in full within 7 days and issues a credit note", async () => {
    h.prisma.passPurchase.findUnique.mockResolvedValue(makePass());
    h.prisma.creditLot.findUnique.mockResolvedValue(makeLot());
    h.refunds.refundPassPurchase.mockResolvedValue({
      outcome: "clawed_back",
      providerRefundId: "rfnd_1",
    });
    h.prisma.invoice.findFirst.mockResolvedValue({ id: INVOICE });
    h.invoices.generateCreditNote.mockResolvedValue({
      id: "01JCREDITNOTE0000000000000",
      number: "AK2627-CR-000001",
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
    let result;
    try {
      result = await h.service.refundPassPurchase(
        PASS,
        {
          providerPaymentId: "pay_1",
          reasonCode: "customer_request",
          reason: "requested by customer",
        },
        ADMIN,
        "203.0.113.1",
      );
    } finally {
      vi.useRealTimers();
    }

    expect(result.policy).toBe("full");
    expect(result.refundAmountMinor).toBe(90000);
    expect(result.creditNoteId).toBe("01JCREDITNOTE0000000000000");
    expect(h.refunds.refundPassPurchase).toHaveBeenCalledWith(
      WORKSPACE,
      PASS,
      expect.objectContaining({ amountMinor: 90000, providerPaymentId: "pay_1" }),
      ADMIN.userId,
      { ip: "203.0.113.1" },
    );
    expect(h.invoices.generateCreditNote).toHaveBeenCalledWith(
      expect.objectContaining({ originalInvoiceId: INVOICE, refundAmountMinor: 90000 }),
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.billing.refund_issued" }),
    );
  });

  it("pro-rates after 7 days by the fraction of credits still unspent", async () => {
    h.prisma.passPurchase.findUnique.mockResolvedValue(
      makePass({ createdAt: new Date("2026-01-01T00:00:00Z") }),
    );
    h.prisma.creditLot.findUnique.mockResolvedValue(
      makeLot({ grantedTenths: 1000, remainingTenths: 500, amountMinor: 90000 }),
    );
    h.refunds.refundPassPurchase.mockResolvedValue({
      outcome: "clawed_back",
      providerRefundId: "rfnd_2",
    });
    h.prisma.invoice.findFirst.mockResolvedValue(null);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    try {
      const result = await h.service.refundPassPurchase(
        PASS,
        { providerPaymentId: "pay_2", reasonCode: "goodwill", reason: "goodwill gesture" },
        ADMIN,
        undefined,
      );
      expect(result.policy).toBe("pro_rata");
      expect(result.refundAmountMinor).toBe(45000);
      expect(result.creditNoteSkippedReason).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when no amount is on file and no override is given", async () => {
    h.prisma.passPurchase.findUnique.mockResolvedValue(makePass());
    h.prisma.creditLot.findUnique.mockResolvedValue(makeLot({ amountMinor: null }));

    await expect(
      h.service.refundPassPurchase(
        PASS,
        { providerPaymentId: "pay_3", reasonCode: "other", reason: "no amount on file" },
        ADMIN,
        undefined,
      ),
    ).rejects.toBeInstanceOf(AppException);
    expect(h.refunds.refundPassPurchase).not.toHaveBeenCalled();
  });

  it("rejects when the policy-computed refund is zero", async () => {
    h.prisma.passPurchase.findUnique.mockResolvedValue(
      makePass({ createdAt: new Date("2020-01-01T00:00:00Z") }),
    );
    h.prisma.creditLot.findUnique.mockResolvedValue(makeLot({ remainingTenths: 0 }));

    await expect(
      h.service.refundPassPurchase(
        PASS,
        { providerPaymentId: "pay_4", reasonCode: "other", reason: "fully spent already" },
        ADMIN,
        undefined,
      ),
    ).rejects.toBeInstanceOf(AppException);
    expect(h.refunds.refundPassPurchase).not.toHaveBeenCalled();
  });
});
