import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EdgHot, TranscriptChunk } from "@montaj/edg/schemas";

import { EdgService } from "./edg.service.js";
import { aspectToStored, canvasAspectFor } from "./init/caption-budgets.js";

import type { EdgRateLimiter } from "./edg.rate-limit.js";
import type { EdgRepository } from "./edg.repository.js";
import type { EdgInitInput } from "./edg.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { RealtimePublisher } from "../realtime/realtime.publisher.js";
import type { $Enums } from "@prisma/client";

/**
 * The canvas `initialise` lays a document out on (S01).
 *
 * The audited defect: `EdgService` derived the document canvas from
 * `projects.aspect` alone while `TranscribeHandler` measured the caption budgets
 * through `canvasAspectFor`, which lets landscape media override an *untouched*
 * 9:16 default. Two derivations, one probe-aware — so budgets could be measured
 * on 1920×1080 while the document was created 1080×1920. These cases pin the one
 * decision and the write-back that makes every aspect-derived surface agree.
 */

const CHUNK: TranscriptChunk = {
  chunkIdx: 0,
  startMs: 0,
  endMs: 2_000,
  words: [
    { wid: "0:0", s: 0, e: 600, t: "ek" },
    { wid: "0:1", s: 600, e: 1_200, t: "do" },
  ],
};

const INIT: EdgInitInput = {
  transcriptId: "01TRANSCRIPT",
  language: "hi-Latn",
  scripts: ["roman"],
  chunks: [CHUNK],
};

function harness(
  storedAspect: $Enums.Aspect,
  media: { width: number | null; height: number | null } | null,
) {
  const update = vi.fn(async () => ({ id: "01PROJECT" }));
  const prisma = {
    project: {
      findFirst: vi.fn(async () => ({
        id: "01PROJECT",
        aspect: storedAspect,
        edgDocument: null,
        mediaAssets:
          media === null
            ? []
            : [
                {
                  id: "01MEDIA",
                  role: "primary",
                  durationMs: 20_200,
                  fps: 30,
                  width: media.width,
                  height: media.height,
                },
              ],
      })),
      update,
    },
    edgSegment: { count: vi.fn(async () => 0) },
  } as unknown as PrismaService;

  let written: EdgHot | undefined;
  const repository = {
    createDocument: vi.fn(
      async (input: { edgId: string; hot: EdgHot; segments: readonly unknown[] }) => {
        written = input.hot;
        return { edgId: input.edgId, revision: 1, segments: input.segments.length };
      },
    ),
  } as unknown as EdgRepository;

  const service = new EdgService(prisma, repository, {} as EdgRateLimiter, {} as RealtimePublisher);
  return { service, update, canvas: () => written?.canvas };
}

describe("EdgService.initialise — the canvas decision", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lets landscape media override an untouched 9:16 default, and persists it", async () => {
    // 1920×1080 footage on the default aspect: the budget half already measured
    // against a 16:9 canvas, so the document must be created on the same one.
    const { service, update, canvas } = harness("r9x16", { width: 1920, height: 1080 });

    await service.initialise("01PROJECT", INIT);

    expect(canvas()).toEqual({ aspect: "16:9", width: 1920, height: 1080 });
    expect(update).toHaveBeenCalledWith({
      where: { id: "01PROJECT" },
      data: { aspect: "r16x9" },
    });
  });

  it("leaves a portrait clip on the 9:16 default and writes nothing back", async () => {
    const { service, update, canvas } = harness("r9x16", { width: 480, height: 854 });

    await service.initialise("01PROJECT", INIT);

    expect(canvas()).toEqual({ aspect: "9:16", width: 1080, height: 1920 });
    expect(update).not.toHaveBeenCalled();
  });

  it("never second-guesses a chosen aspect, whatever the media says", async () => {
    // The rule `canvasAspectFor` documents: the probe wins over the *default*
    // only. A user who picked 16:9 and then uploaded portrait footage meant it.
    const { service, update, canvas } = harness("r16x9", { width: 1080, height: 1920 });

    await service.initialise("01PROJECT", INIT);

    expect(canvas()).toEqual({ aspect: "16:9", width: 1920, height: 1080 });
    expect(update).not.toHaveBeenCalled();
  });

  it("falls back to the stored aspect when nothing has been probed", async () => {
    // No primary row yet, or a probe that never filled the dimensions in.
    const { service, update, canvas } = harness("r9x16", null);

    await service.initialise("01PROJECT", INIT);

    expect(canvas()).toEqual({ aspect: "9:16", width: 1080, height: 1920 });
    expect(update).not.toHaveBeenCalled();
  });

  it("round-trips every stored spelling through the one table", () => {
    // `aspectToStored` inverts `ASPECTS`; a hand-typed second table would drift.
    for (const stored of ["r9x16", "r16x9", "r1x1", "r4x5"] as const) {
      expect(aspectToStored(canvasAspectFor(stored))).toBe(stored);
    }
  });
});
