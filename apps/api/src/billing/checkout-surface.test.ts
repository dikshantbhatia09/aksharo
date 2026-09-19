import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { type Env } from "@montaj/config";

import { BILLING_ERRORS } from "./billing.constants.js";
import { CheckoutService } from "./checkout.service.js";

function createService(flags: Record<string, unknown> = {}) {
  const env: Env = {
    FEATURE_FLAGS_JSON: flags,
  } as unknown as Env;

  const prisma = {
    workspace: {
      findFirst: vi.fn(async () => ({
        id: "ws-1",
        billingCountryConfirmedAt: new Date(),
        currency: "INR",
        owner: { email: "owner@test.com", name: "Test Owner" },
      })),
    },
  };
  const provider = {} as never;
  const plans = {
    require: vi.fn(),
  } as never;
  const audit = {
    record: vi.fn(),
  } as never;

  const service = new CheckoutService(
    prisma as never,
    provider,
    plans,
    audit,
    env,
  );

  return { service, prisma };
}

describe("Checkout Surface Availability (RLS-006)", () => {
  it("fails closed when checkout is disabled by default (empty flags)", async () => {
    const { service } = createService({});

    await expect(service.requireConfirmedWorkspace("ws-1")).rejects.toThrowError(
      expect.objectContaining({
        code: BILLING_ERRORS.checkoutDisabled,
        httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
      }),
    );
  });

  it("fails closed when checkout flag is explicitly false", async () => {
    const { service } = createService({ "billing.checkout": false });

    await expect(service.requireConfirmedWorkspace("ws-1")).rejects.toThrowError(
      expect.objectContaining({
        code: BILLING_ERRORS.checkoutDisabled,
        httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
      }),
    );
  });

  it("fails closed on checkout() when flag is absent or false", async () => {
    const { service } = createService({});

    await expect(
      service.checkout("ws-1", "user-1", { planKey: "creator", interval: "monthly" }, {}),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: BILLING_ERRORS.checkoutDisabled,
        httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
      }),
    );
  });

  it("admits checkout when billing.checkout is explicitly enabled", async () => {
    const { service, prisma } = createService({ "billing.checkout": true });

    const ws = await service.requireConfirmedWorkspace("ws-1");
    expect(ws.id).toBe("ws-1");
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: "ws-1", deletedAt: null },
      include: { owner: { select: { email: true, name: true } } },
    });
  });
});
