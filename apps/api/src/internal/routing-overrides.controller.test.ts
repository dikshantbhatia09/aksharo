import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  InternalRoutingOverridesController,
  etagOf,
  toWireShape,
} from "./routing-overrides.controller.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";

function fakeResponse(): { setHeader: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  return { setHeader: vi.fn(), status: vi.fn() };
}

function controllerWith(rows: readonly { laneId: string; provider: string; weight: number }[]) {
  const prisma = {
    routingWeightOverride: { findMany: vi.fn(async () => rows) },
  } as unknown as PrismaService;
  return new InternalRoutingOverridesController(prisma);
}

describe("toWireShape", () => {
  it("groups overrides by lane, then provider, matching the worker's apply_overrides", () => {
    expect(
      toWireShape([
        { laneId: "hinglish", provider: "sarvam", weight: 0 },
        { laneId: "hinglish", provider: "elevenlabs", weight: 100 },
        { laneId: "hindi", provider: "sarvam", weight: 80 },
      ]),
    ).toEqual({
      lanes: {
        hinglish: { candidates: { sarvam: { weight: 0 }, elevenlabs: { weight: 100 } } },
        hindi: { candidates: { sarvam: { weight: 80 } } },
      },
    });
  });

  it("is empty when there are no overrides", () => {
    expect(toWireShape([])).toEqual({ lanes: {} });
  });
});

describe("etagOf", () => {
  it("is stable for identical content and changes when content changes", () => {
    const a = { lanes: { x: { candidates: { y: { weight: 1 } } } } };
    const b = { lanes: { x: { candidates: { y: { weight: 2 } } } } };
    expect(etagOf(a)).toBe(etagOf(a));
    expect(etagOf(a)).not.toBe(etagOf(b));
  });
});

describe("InternalRoutingOverridesController", () => {
  it("returns the wire shape and sets an ETag + Cache-Control header", async () => {
    const controller = controllerWith([{ laneId: "hindi", provider: "sarvam", weight: 50 }]);
    const response = fakeResponse();

    const body = await controller.get(undefined, response as never);

    expect(body).toEqual({ lanes: { hindi: { candidates: { sarvam: { weight: 50 } } } } });
    expect(response.setHeader).toHaveBeenCalledWith("ETag", expect.stringMatching(/^W\//));
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, max-age=60");
    expect(response.status).not.toHaveBeenCalled();
  });

  it("answers 304 with no body when If-None-Match matches the current ETag", async () => {
    const rows = [{ laneId: "hindi", provider: "sarvam", weight: 50 }];
    const etag = etagOf(toWireShape(rows));
    const controller = controllerWith(rows);
    const response = fakeResponse();

    const body = await controller.get(etag, response as never);

    expect(body).toBeUndefined();
    expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_MODIFIED);
  });

  it("re-fetches (not 304) when If-None-Match is stale", async () => {
    const controller = controllerWith([{ laneId: "hindi", provider: "sarvam", weight: 50 }]);
    const response = fakeResponse();

    const body = await controller.get('W/"stale"', response as never);

    expect(body).toEqual({ lanes: { hindi: { candidates: { sarvam: { weight: 50 } } } } });
    expect(response.status).not.toHaveBeenCalled();
  });
});
