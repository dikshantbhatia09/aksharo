import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EdgHot, Segment, TranscriptChunk } from "@montaj/edg/schemas";

import { EdgService } from "./edg.service.js";
import { DEFAULT_STYLE_REF } from "./init/transcript-init.js";

import type { EdgRateLimiter } from "./edg.rate-limit.js";
import type { EdgRepository } from "./edg.repository.js";
import type { EdgInitInput } from "./edg.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { RealtimePublisher } from "../realtime/realtime.publisher.js";

/**
 * Which style a freshly initialised document carries, and where.
 *
 * The audited defect (2026-09-05): `initialise` stamped the chosen style on
 * EVERY segment as well as on the document. `resolveStyle` reads
 * `segment.styleRef ?? styles.defaultStyleId`, so a segment-level id always won
 * and the document default was dead — changing the caption style from the Style
 * gallery updated `defaultStyleId`, the picker showed the new style as selected,
 * and the preview and the export kept rendering the old one. 65,428 of 65,428
 * live segments in the local database carried such a stamp.
 *
 * The rule these cases pin: the chosen style lives on the document; a segment
 * carries a `styleRef` only once that one caption is given its own style.
 */

const CHUNK: TranscriptChunk = {
  chunkIdx: 0,
  startMs: 0,
  endMs: 4_000,
  words: [
    { wid: "0:0", s: 0, e: 600, t: "ek" },
    { wid: "0:1", s: 700, e: 1_200, t: "do" },
    { wid: "0:2", s: 1_400, e: 2_000, t: "teen" },
    { wid: "0:3", s: 2_200, e: 2_800, t: "chaar" },
  ],
};

const INIT: EdgInitInput = {
  transcriptId: "01TRANSCRIPT",
  language: "hi-Latn",
  scripts: ["roman"],
  chunks: [CHUNK],
};

function harness() {
  const prisma = {
    project: {
      findFirst: vi.fn(async () => ({
        id: "01PROJECT",
        aspect: "r9x16",
        edgDocument: null,
        mediaAssets: [
          {
            id: "01MEDIA",
            role: "primary",
            durationMs: 20_200,
            fps: 30,
            width: 1080,
            height: 1920,
          },
        ],
      })),
      update: vi.fn(async () => ({ id: "01PROJECT" })),
    },
    edgSegment: { count: vi.fn(async () => 0) },
  } as unknown as PrismaService;

  let hot: EdgHot | undefined;
  let segments: readonly Segment[] = [];
  const repository = {
    createDocument: vi.fn(
      async (input: { edgId: string; hot: EdgHot; segments: readonly Segment[] }) => {
        hot = input.hot;
        segments = input.segments;
        return { edgId: input.edgId, revision: 1, segments: input.segments.length };
      },
    ),
  } as unknown as EdgRepository;

  const service = new EdgService(prisma, repository, {} as EdgRateLimiter, {} as RealtimePublisher);
  return { service, hot: () => hot, segments: () => segments };
}

describe("EdgService.initialise — where the chosen style lives", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("puts the chosen style on the document and leaves every segment unstamped", async () => {
    const h = harness();

    await h.service.initialise("01PROJECT", { ...INIT, styleRef: "punch-pop" });

    expect(h.hot()?.styles.defaultStyleId).toBe("punch-pop");
    expect(h.segments().length).toBeGreaterThan(0);
    // The whole point: nothing shadows the document default.
    for (const segment of h.segments()) expect(segment.styleRef).toBeUndefined();
  });

  it("falls back to a style that is actually in the catalogue when none was chosen", async () => {
    // The previous fallback was "clean-bold", which no package ships. Any
    // document created without a style pick therefore threw
    // `render/unknown-style` out of `resolveStyle` on the first frame — and with
    // no error boundary that surfaced as "Application error: a client-side
    // exception has occurred" over the whole editor.
    const h = harness();

    await h.service.initialise("01PROJECT", INIT);

    expect(h.hot()?.styles.defaultStyleId).toBe(DEFAULT_STYLE_REF);
    expect(DEFAULT_STYLE_REF).toBe("vertical-clean");
    for (const segment of h.segments()) expect(segment.styleRef).toBeUndefined();
  });
});
