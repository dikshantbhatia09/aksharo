import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { type Env } from "@montaj/config";

import { AffiliatesController } from "./affiliates.controller.js";

function createController(flags: Record<string, unknown> = { "affiliates.enabled": false }) {
  const env: Env = {
    FEATURE_FLAGS_JSON: flags,
  } as unknown as Env;

  const affiliates = {
    apply: vi.fn(async () => ({ id: "aff-1" })),
    getForUser: vi.fn(async () => null),
    adminApprove: vi.fn(async () => ({ id: "aff-1" })),
  } as never;

  const attribution = {
    recordClick: vi.fn(async () => null),
    attach: vi.fn(async () => ({ status: "none" })),
  } as never;

  const stats = {
    forAffiliate: vi.fn(async () => ({})),
  } as never;

  const fraud = {
    checkBurstSignup: vi.fn(async () => undefined),
  } as never;

  const controller = new AffiliatesController(affiliates, attribution, stats, fraud, env);

  return { controller, affiliates, attribution };
}

describe("Affiliates Surface Availability (RLS-006)", () => {
  it("fails closed (404) when affiliates surface is disabled by default", async () => {
    const { controller } = createController({ "affiliates.enabled": false });

    await expect(controller.me({ userId: "u-1", workspaceId: "ws-1" } as never)).rejects.toThrow(
      NotFoundException,
    );

    await expect(
      controller.apply(
        { userId: "u-1", workspaceId: "ws-1" } as never,
        { taxId: "ABCDE1234F", payoutMethod: "upi", upiId: "test@upi" } as never,
        { ip: "127.0.0.1" } as never,
      ),
    ).rejects.toThrow(NotFoundException);

    await expect(controller.recordClick({ code: "partner123" } as never)).rejects.toThrow(
      NotFoundException,
    );

    await expect(
      controller.attach({
        referredWorkspaceId: "ws-2",
        referredUserId: "u-2",
        code: "partner123",
      } as never),
    ).rejects.toThrow(NotFoundException);
  });

  it("fails closed (404) when affiliates.enabled is explicitly false", async () => {
    const { controller } = createController({ "affiliates.enabled": false });

    await expect(controller.me({ userId: "u-1", workspaceId: "ws-1" } as never)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("admits requests when affiliates.enabled is true", async () => {
    const { controller, affiliates, attribution } = createController({
      "affiliates.enabled": true,
    });

    const meResult = await controller.me({ userId: "u-1", workspaceId: "ws-1" } as never);
    expect(meResult).toEqual({ affiliate: null });
    expect((affiliates as any).getForUser).toHaveBeenCalledWith("u-1");

    const clickResult = await controller.recordClick({ code: "partner123" } as never);
    expect(clickResult).toEqual({ attributed: false, attributionExpiresAt: null });
    expect((attribution as any).recordClick).toHaveBeenCalled();
  });
});
