import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPILATION_LIMITS,
  EXPORT_KEY_PATTERN,
  RenderCompilationPayloadSchema,
  RenderCompilationResultSchema,
  compilationExportKey,
  compilationJobKey,
  compilationOutputMs,
  compilationSize,
} from "./compilations.js";

function fixture(name: string): Record<string, unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture names are local literals, not user-controlled paths
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", name), "utf8")) as Record<
    string,
    unknown
  >;
}

const PAYLOAD = fixture("render-compilation-payload.v1.json");
const RESULT = fixture("render-compilation-result.v1.json");
const WS = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const EXPORT = "01JCEXP0RT0000000000000000";

function clips(): Record<string, unknown>[] {
  return PAYLOAD["clips"] as Record<string, unknown>[];
}

describe("render.compilation@1 payload (2026-10-03)", () => {
  it("parses the shared fixture, the same one the render service parses", () => {
    const parsed = RenderCompilationPayloadSchema.parse(PAYLOAD);
    expect(parsed.clips).toHaveLength(2);
    expect(parsed.intro?.title).toBe("Best of episode 12");
  });

  it("takes a compilation without a title card", () => {
    const { intro: _intro, ...plain } = PAYLOAD;
    expect(RenderCompilationPayloadSchema.safeParse(plain).success).toBe(true);
  });

  it("reads only export keys: never an original, a face track, a traversal or a bare path", () => {
    const bad = [
      `ws/${WS}/p/${PROJECT}/media/01JCMED1A00000000000000000/raw.mp4`,
      `ws/${WS}/p/${PROJECT}/media/01JCMED1A00000000000000000/faces.json`,
      `ws/${WS}/p/${PROJECT}/exports/../../other/exports/${EXPORT}.mp4`,
      `ws/${WS}/brand/01JCASSET00000000000000000.png`,
      `/ws/${WS}/p/${PROJECT}/exports/${EXPORT}.mp4`,
      `ws/${WS}/p/${PROJECT}/exports/${EXPORT}.mp4?x=1`,
      `ws/${WS}/p/${PROJECT}/exports/${EXPORT}.srt`,
    ];
    for (const key of bad) {
      const payload = { ...PAYLOAD, clips: [{ ...clips()[0], key }, clips()[1]] };
      expect(RenderCompilationPayloadSchema.safeParse(payload).success, key).toBe(false);
    }
    expect(EXPORT_KEY_PATTERN.test(`ws/${WS}/p/${PROJECT}/exports/${EXPORT}.mov`)).toBe(true);
  });

  it("holds the size to the shape's, and a clip to one appearance", () => {
    expect(RenderCompilationPayloadSchema.safeParse({ ...PAYLOAD, width: 1920 }).success).toBe(
      false,
    );
    expect(
      RenderCompilationPayloadSchema.safeParse({
        ...PAYLOAD,
        shape: "16:9",
        width: 1920,
        height: 1080,
      }).success,
    ).toBe(true);
    expect(
      RenderCompilationPayloadSchema.safeParse({ ...PAYLOAD, clips: [clips()[0], clips()[0]] })
        .success,
    ).toBe(false);
  });

  it("caps the clips and refuses what a card cannot draw", () => {
    const many = Array.from({ length: COMPILATION_LIMITS.maxClips + 1 }, (_, index) => ({
      ...clips()[0],
      clipId: `01JCC11P${String(index).padStart(18, "0")}`,
    }));
    expect(RenderCompilationPayloadSchema.safeParse({ ...PAYLOAD, clips: many }).success).toBe(
      false,
    );
    const intro = PAYLOAD["intro"] as Record<string, unknown>;
    for (const broken of [
      { ...intro, background: "pink" },
      { ...intro, title: "x".repeat(COMPILATION_LIMITS.titleMax + 1) },
      { ...intro, title: "   " },
      { ...intro, durationMs: 60_000 },
      { ...intro, logo: { ...(intro["logo"] as object), assetId: "../../x" } },
      { ...intro, sticker: true },
    ]) {
      expect(
        RenderCompilationPayloadSchema.safeParse({ ...PAYLOAD, intro: broken }).success,
        JSON.stringify(broken),
      ).toBe(false);
    }
  });
});

describe("render.compilation@1 result", () => {
  it("parses the shared fixture", () => {
    expect(RenderCompilationResultSchema.parse(RESULT).outputMs).toBe(60_500);
  });

  it("refuses a key outside the exports", () => {
    expect(
      RenderCompilationResultSchema.safeParse({
        ...RESULT,
        outputKey: `ws/${WS}/p/${PROJECT}/media/x/raw.mp4`,
      }).success,
    ).toBe(false);
  });
});

describe("compilationOutputMs", () => {
  it("adds the clips and the card, less a fade for every join", () => {
    // 31.5 s + 28 s + a 2 s card, two joins of 0.5 s: 60.5 s.
    expect(compilationOutputMs({ clipsMs: [31_500, 28_000], introMs: 2_000 })).toBe(60_500);
    expect(compilationOutputMs({ clipsMs: [31_500, 28_000] })).toBe(59_000);
    expect(compilationOutputMs({ clipsMs: [10_000] })).toBe(10_000);
    expect(compilationOutputMs({ clipsMs: [] })).toBe(0);
  });

  it("counts whole frames, as the worker makes them", () => {
    // 2.52 s is 75.6 frames at 30 fps: 76 frames; 3 s is 90; one fade of 15.
    expect(compilationOutputMs({ clipsMs: [3_000, 2_520], fadeMs: 500 })).toBe(
      Math.round(((90 + 76 - 15) * 1000) / 30),
    );
    expect(compilationOutputMs({ clipsMs: [3_000, 2_000], fadeMs: 0 })).toBe(5_000);
  });
});

describe("keys and sizes", () => {
  it("names one job per attempt and files the video with the source's exports", () => {
    expect(compilationJobKey("01JCC0MP11AT10N00000000000", EXPORT)).toBe(
      `render.compilation:01JCC0MP11AT10N00000000000:${EXPORT}`,
    );
    const key = compilationExportKey({ workspaceId: WS, projectId: PROJECT, exportId: EXPORT });
    expect(key).toBe(`ws/${WS}/p/${PROJECT}/exports/${EXPORT}.mp4`);
    expect(EXPORT_KEY_PATTERN.test(key)).toBe(true);
  });

  it("makes each shape at its clips' size", () => {
    expect(compilationSize("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(compilationSize("16:9")).toEqual({ width: 1920, height: 1080 });
  });
});
