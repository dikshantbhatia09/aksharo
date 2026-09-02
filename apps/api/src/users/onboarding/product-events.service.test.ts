import { describe, expect, it, vi } from "vitest";

import { ProductEventsService } from "./product-events.service.js";

import type { PrismaService } from "../../common/index.js";

function serviceWith(create: (...args: unknown[]) => unknown): ProductEventsService {
  const prisma = { productEvent: { create: vi.fn(create) } } as unknown as PrismaService;
  return new ProductEventsService(prisma);
}

describe("ProductEventsService.record", () => {
  it("writes a row with the given kind, ids and classification", async () => {
    const create = vi.fn(async () => undefined);
    const service = serviceWith(create);

    await service.record({
      kind: "onboarding_completed",
      workspaceId: "01JWS0000000000000000000AA",
      userId: "01JUSR0000000000000000000AA",
      source: "youtube",
      codeType: "referral",
      props: { makes: ["reels"] },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "onboarding_completed",
          workspaceId: "01JWS0000000000000000000AA",
          userId: "01JUSR0000000000000000000AA",
          source: "youtube",
          codeType: "referral",
          props: { makes: ["reels"] },
        }) as unknown,
      }),
    );
  });

  it("never throws — a failed write is logged and swallowed", async () => {
    const service = serviceWith(async () => {
      throw new Error("db unavailable");
    });

    await expect(service.record({ kind: "onboarding_completed" })).resolves.toBeUndefined();
  });

  it("defaults optional fields to null rather than omitting them", async () => {
    const create = vi.fn(async () => undefined);
    const service = serviceWith(create);

    await service.record({ kind: "onboarding_completed" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: null,
          userId: null,
          source: null,
          codeType: null,
          props: {},
        }) as unknown,
      }),
    );
  });
});
