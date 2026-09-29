import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OverlaySchema } from "@montaj/edg/schemas";
import { signedFixtureManifest } from "@montaj/render-manifest/testing";

import {
  bullJobId,
  isJobEnvelope,
  RENDER_COMPILATION_QUEUE,
  RENDER_QUEUES,
  RENDER_SUBTITLE_QUEUE,
  RENDER_VIDEO_QUEUE,
  RenderCompilationPayloadSchema,
  RenderProjectionSchema,
  RenderSubtitlePayloadSchema,
  RenderVideoPayloadSchema,
} from "./queues.js";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const API_QUEUE_NAMES = join(
  REPO_ROOT,
  "apps",
  "api",
  "src",
  "jobs",
  "contracts",
  "queue-names.ts",
);

describe("render queue contract (CONTRACTS §3)", () => {
  it("uses the frozen queue names", () => {
    expect(RENDER_VIDEO_QUEUE).toBe("render.video");
    expect(RENDER_SUBTITLE_QUEUE).toBe("render.subtitle");
    expect(RENDER_COMPILATION_QUEUE).toBe("render.compilation");
    expect(RENDER_QUEUES).toEqual(["render.video", "render.subtitle", "render.compilation"]);
  });

  it("does not drift from the API's canonical list", () => {
    // A typo is not a compile error anywhere — it is a queue nothing ever reads.
    const source = readFileSync(API_QUEUE_NAMES, "utf8");
    for (const name of RENDER_QUEUES) {
      expect(source).toContain(`"${name}"`);
    }
  });

  it("builds a BullMQ id without a colon in it", () => {
    expect(bullJobId("job", "attempt")).toBe("job-attempt");
    expect(bullJobId("job", "attempt")).not.toContain(":");
  });
});

describe("isJobEnvelope", () => {
  const envelope = {
    jobId: "01JBQ8Z2W4N7Y0K3M5P8R1T6V9",
    attemptId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VA",
    workspaceId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VB",
    priority: 5,
    jobKey: "render.video:01JBQ8Z2W4N7Y0K3M5P8R1T6VC",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { exportId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VC" },
  };

  it("accepts a well-formed envelope", () => {
    expect(isJobEnvelope(envelope)).toBe(true);
  });

  it("accepts one with a projectId, and one without", () => {
    expect(isJobEnvelope({ ...envelope, projectId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VD" })).toBe(true);
  });

  it("rejects a projectId of null, which is what the Python worker also rejects", () => {
    expect(isJobEnvelope({ ...envelope, projectId: null })).toBe(false);
  });

  it("rejects a job whose data is not the contract envelope", () => {
    expect(isJobEnvelope({ exportId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VC" })).toBe(false);
    expect(isJobEnvelope(null)).toBe(false);
    expect(isJobEnvelope({ ...envelope, priority: -1 })).toBe(false);
  });
});

describe("the payload schemas", () => {
  const projection = {
    canvas: { width: 1080, height: 1920 },
    segments: [
      {
        id: "seg-1",
        seq: "V",
        startMs: 0,
        endMs: 2_000,
        startWordId: "0:0",
        endWordId: "0:2",
      },
    ],
    words: [
      { wid: "0:0", s: 0, e: 500, t: "Bhai" },
      { wid: "0:1", s: 500, e: 1_000, t: "aaj" },
      { wid: "0:2", s: 1_000, e: 2_000, t: "video" },
    ],
  };

  it("parses a projection", () => {
    expect(RenderProjectionSchema.parse(projection).segments).toHaveLength(1);
  });

  it("defaults the render path to skia and the script to roman", () => {
    const parsed = RenderVideoPayloadSchema.parse({
      manifest: signedFixtureManifest("secret"),
      projection,
      styles: { "punch-pop": {} },
    });
    expect(parsed.path).toBe("skia");
    expect(parsed.script).toBe("roman");
    expect(parsed.dropFillers).toBe(false);
  });

  it("refuses a payload with no manifest", () => {
    expect(RenderVideoPayloadSchema.safeParse({ projection, styles: {} }).success).toBe(false);
  });

  it("parses a subtitle payload", () => {
    const parsed = RenderSubtitlePayloadSchema.parse({
      manifest: signedFixtureManifest("secret"),
      projection,
    });
    expect(parsed.projection.words).toHaveLength(3);
  });

  it("carries a hook title, and refuses an overlay kind it cannot draw", () => {
    const hook = {
      id: "01JHOOK0000000000000000000",
      kind: "hook-title",
      text: "Paisa bachana easy hai",
      startMs: 0,
      endMs: 2_500,
    };
    expect(RenderProjectionSchema.parse({ ...projection, overlays: [hook] }).overlays).toEqual([
      hook,
    ]);
    expect(
      RenderProjectionSchema.safeParse({ ...projection, overlays: [{ ...hook, kind: "sticker" }] })
        .success,
    ).toBe(false);
  });

  describe("a brand kit's overlays (2026-10-02)", () => {
    const image = {
      assetId: "01JASSET000000000000000000",
      format: "png",
      width: 400,
      height: 200,
    };
    const samples = {
      hook: {
        id: "01JHQQK0000000000000000000",
        kind: "hook-title",
        text: "Paisa bachana easy hai",
        startMs: 0,
        endMs: 2_500,
        appearance: { fontFamily: "Poppins", background: "#f0508a", text: "#0b0a0c" },
      },
      logo: {
        id: "01JMGG00000000000000000000",
        kind: "logo",
        startMs: 0,
        endMs: 30_000,
        image,
        corner: "top-right",
        sizePct: 16,
        opacity: 0.9,
        marginPct: 4,
      },
      card: {
        id: "01JCRD00000000000000000000",
        kind: "end-card",
        startMs: 27_000,
        endMs: 30_000,
        cta: "Follow for more",
        handle: "@aksharo",
        background: "#141217",
        accent: "#f0508a",
        image,
      },
    };

    it("carries a styled hook title, a logo and an end card", () => {
      const overlays = [samples.hook, samples.logo, samples.card];
      expect(RenderProjectionSchema.parse({ ...projection, overlays }).overlays).toEqual(overlays);
    });

    it("refuses what the document would refuse, and takes what it takes", () => {
      const bad = [
        { ...samples.logo, image: { ...image, assetId: "../../ws/other/brand/x" } },
        { ...samples.logo, image: { ...image, format: "gif" } },
        { ...samples.logo, sizePct: 90 },
        { ...samples.card, background: "red" },
        { ...samples.card, cta: "x".repeat(61) },
        { ...samples.hook, appearance: { background: "pink" } },
      ];
      for (const overlay of [samples.hook, samples.logo, samples.card, ...bad]) {
        const here = RenderProjectionSchema.safeParse({ ...projection, overlays: [overlay] });
        // The renderer's restated schema and the document's own agree.
        expect(here.success, JSON.stringify(overlay)).toBe(
          OverlaySchema.safeParse(overlay).success,
        );
      }
      for (const overlay of bad) {
        expect(
          RenderProjectionSchema.safeParse({ ...projection, overlays: [overlay] }).success,
        ).toBe(false);
      }
    });
  });
});

describe("the render.compilation payload (2026-10-03)", () => {
  const FIXTURES = join(REPO_ROOT, "packages", "repurpose-contracts", "fixtures");
  const payload = JSON.parse(
    readFileSync(join(FIXTURES, "render-compilation-payload.v1.json"), "utf8"),
  ) as Record<string, unknown>;
  const clips = payload["clips"] as Record<string, unknown>[];
  const intro = payload["intro"] as Record<string, unknown>;

  it("parses the fixture @montaj/repurpose-contracts parses", () => {
    const parsed = RenderCompilationPayloadSchema.parse(payload);
    expect(parsed.clips.map((clip) => clip.durationMs)).toEqual([31_500, 28_000]);
  });

  it("refuses what the contract refuses", () => {
    const ws = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
    const bad: Record<string, unknown>[] = [
      { ...payload, width: 1920 },
      { ...payload, clips: [clips[0], clips[0]] },
      {
        ...payload,
        clips: [{ ...clips[0], key: `ws/${ws}/brand/01JCASSET00000000000000000.png` }],
      },
      { ...payload, clips: [{ ...clips[0], key: "../../etc/passwd" }] },
      { ...payload, intro: { ...intro, background: "pink" } },
      { ...payload, intro: { ...intro, title: "x".repeat(81) } },
      { ...payload, extra: true },
      { ...payload, clips: [] },
    ];
    for (const value of bad) {
      expect(RenderCompilationPayloadSchema.safeParse(value).success, JSON.stringify(value)).toBe(
        false,
      );
    }
  });
});
