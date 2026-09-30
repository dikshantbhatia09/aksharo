import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { PERFORMANCE_ERRORS } from "./performance.constants.js";
import { WhatWorksService } from "./what-works.service.js";
import { AppException } from "../../common/errors/error-codes.js";

import type { ClipPostsService } from "./clip-posts.service.js";
import type { PrismaService } from "../../common/prisma/prisma.service.js";

const WS = "01JWW0WS000000000000000001";
const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;

function row(index: number, views: number, daysAgo: number, title = `Clip ${String(index)}`) {
  const at = new Date(NOW.getTime() - daysAgo * DAY);
  return {
    id: `01JWW0POST00000000000000${String(index).padStart(2, "0")}`,
    platform: "youtube",
    url: null,
    latest: { views: { value: views, source: "postiz", at: NOW.toISOString() } },
    postedAt: at,
    createdAt: at,
    language: null,
    aspect: "r9x16",
    clip: {
      id: `01JWW0CLIP00000000000000${String(index).padStart(2, "0")}`,
      runId: "01JWW0RUN00000000000000001",
      title,
      copy: {},
      sourceStartMs: 0,
      sourceEndMs: 30_000,
      candidate: { transcriptExcerpt: "" },
      variants: [{ aspect: "r9x16", layout: "single" }],
    },
    run: { config: { sourceLanguage: "en" } },
  };
}

function harness(rows: unknown[], enabled = true) {
  const prisma = {
    clipPost: { findMany: vi.fn(async () => rows) },
    publishBatch: { findFirst: vi.fn(async () => ({ timezone: "Europe/London" })) },
  };
  const posts = {
    assertEnabled: vi.fn(async () => {
      if (!enabled) {
        throw new AppException(PERFORMANCE_ERRORS.disabled, "off", HttpStatus.NOT_FOUND);
      }
    }),
  };
  const service = new WhatWorksService(
    prisma as unknown as PrismaService,
    posts as unknown as ClipPostsService,
  );
  service.now = () => NOW;
  return { service, prisma };
}

describe("WhatWorksService", () => {
  it("answers 404 while the feature is off, and reads nothing", async () => {
    const h = harness([], false);
    await expect(h.service.whatWorks(WS, 90)).rejects.toMatchObject({
      code: PERFORMANCE_ERRORS.disabled,
    });
    expect(h.prisma.clipPost.findMany).not.toHaveBeenCalled();
  });

  it("reads the window asked for, in the zone the workspace posts in, with its bars", async () => {
    const rows = [
      row(0, 20_000, 10, "The big one"),
      ...Array.from({ length: 7 }, (_, index) => row(index + 1, 1_000, 20)),
      // Outside 90 days, inside the year the steering reads.
      ...Array.from({ length: 3 }, (_, index) => row(index + 8, 1_000, 200)),
    ];
    const view = await harness(rows).service.whatWorks(WS, 90);
    expect(view).toMatchObject({
      enabled: true,
      days: 90,
      timeZone: "Europe/London",
      generatedAt: NOW.toISOString(),
      enough: true,
      thresholds: { minPosts: 5, minGroup: 5, clearLift: 1.25, steeringMinPosts: 8 },
    });
    expect(view.totals.withViews).toBe(8);
    expect(view.topByViews[0]).toMatchObject({ title: "The big one", views: 20_000 });
    // The steering reads the year: eleven posts, the big one a hit.
    expect(view.steering?.basis).toBe(11);
    expect(view.steering?.lines[0]).toBe("Moments like “The big one” (20,000 views on YouTube).");
  });

  it("says nothing it cannot back, and steers nothing, from a few posts", async () => {
    const view = await harness([row(0, 5_000, 1), row(1, 100, 1)]).service.whatWorks(WS, 30);
    expect(view.enough).toBe(false);
    expect(view.findings).toEqual([]);
    expect(view.steering).toBeNull();
  });
});
