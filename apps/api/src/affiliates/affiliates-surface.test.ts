import { ForbiddenException, NotFoundException } from "@nestjs/common";
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
      controller.attach(
        { userId: "u-2", workspaceId: "ws-2" } as never,
        {
          referredWorkspaceId: "ws-2",
          referredUserId: "u-2",
          code: "partner123",
        } as never,
      ),
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

describe("attaching an affiliate code (2026-09-29)", () => {
  const me = { userId: "u-2", workspaceId: "ws-2" } as never;

  it("attaches a code to the signed-in person's own workspace", async () => {
    const { controller, attribution } = createController({ "affiliates.enabled": true });
    await controller.attach(me, {
      referredWorkspaceId: "ws-2",
      referredUserId: "u-2",
      code: "PARTNER123",
    } as never);
    expect((attribution as any).attach).toHaveBeenCalledWith(
      expect.objectContaining({ referredWorkspaceId: "ws-2", referredUserId: "u-2" }),
    );
  });

  it("refuses anyone else's workspace or user, which the route used to take on trust", async () => {
    const { controller, attribution } = createController({ "affiliates.enabled": true });
    for (const body of [
      { referredWorkspaceId: "ws-victim", referredUserId: "u-2", code: "PARTNER123" },
      { referredWorkspaceId: "ws-2", referredUserId: "u-victim", code: "PARTNER123" },
    ]) {
      await expect(controller.attach(me, body as never)).rejects.toThrow(ForbiddenException);
    }
    expect((attribution as any).attach).not.toHaveBeenCalled();
  });
});
