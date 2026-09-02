import { describe, expect, it } from "vitest";

import { assertWithinCaps, capViolations } from "@montaj/render-manifest";

import { decideExport } from "./decision.js";
import {
  buildRenderManifest,
  DEFAULT_WATERMARK_ASSET_ID,
  MANIFEST_TTL_MS,
} from "./manifest-builder.js";

import type { StyleSnapshotResolution } from "./projection.js";

const STYLE_SNAPSHOT: StyleSnapshotResolution = {
  defaultStyleId: "vertical-clean",
  catalogueSnapshotIds: ["vertical-clean@abcd1234"],
  styles: { "vertical-clean": { id: "vertical-clean" } },
};

const NOW = Date.parse("2026-09-02T09:00:00.000Z");

function decisionFor(overrides: Partial<Parameters<typeof decideExport>[0]> = {}) {
  return decideExport({
    requestedMode: "cloud",
    kind: "video",
    outputKind: "video",
    preset: "reels",
    sourceDurationMs: 30_000,
    outputDurationMs: 30_000,
    plan: "free",
    entitlements: { watermark: "after_first_clean_export", maxExportResolution: "1080p" },
    signupGiftAvailable: false,
    ninePassAvailable: false,
    ...overrides,
  });
}

function baseInput(overrides: Partial<Parameters<typeof buildRenderManifest>[0]> = {}) {
  return {
    workspaceId: "01JA20WKSPACE0000000000000",
    projectId: "01JA20PRJECT00000000000000",
    exportId: "01JA20EXPRT000000000000000",
    edg: { edgId: "01JA20EDG00000000000000000", revision: 5 },
    styleSnapshot: STYLE_SNAPSHOT,
    source: {
      mediaId: "01JA20MEDA0000000000000000",
      bucket: "raw" as const,
      key: "ws/01JA20WKSPACE0000000000000/p/01JA20PRJECT00000000000000/media/01JA20MEDA0000000000000000/raw.mp4",
      durationMs: 30_000,
      width: 1080,
      height: 1920,
      fps: 30,
    },
    timemapEdits: [],
    outputDurationMs: 30_000,
    decision: decisionFor(),
    kind: "video" as const,
    outputKind: "video" as const,
    preset: "reels" as const,
    projectAspect: "r9x16" as const,
    now: NOW,
    ...overrides,
  };
}

describe("buildRenderManifest", () => {
  it("uses the named preset's dimensions", () => {
    const { manifest } = buildRenderManifest(baseInput());
    expect(manifest.output.width).toBe(1_080);
    expect(manifest.output.height).toBe(1_920);
    expect(manifest.output.aspect).toBe("9:16");
  });

  it("falls back to the project's own aspect for a custom preset", () => {
    const { manifest } = buildRenderManifest(
      baseInput({ preset: "custom", customWidth: 800, customHeight: 800, projectAspect: "r1x1" }),
    );
    expect(manifest.output.width).toBe(800);
    expect(manifest.output.height).toBe(800);
    expect(manifest.output.aspect).toBe("1:1");
  });

  it("gives a video output passthrough audio and an alpha/greenscreen output none", () => {
    const video = buildRenderManifest(baseInput()).manifest;
    expect(video.audio.strategy).toBe("passthrough");

    const alpha = buildRenderManifest(
      baseInput({
        outputKind: "alpha",
        decision: decisionFor({ outputKind: "alpha", requestedMode: "cloud" }),
      }),
    ).manifest;
    expect(alpha.audio.strategy).toBe("none");
    expect(alpha.output.container).toBe("mov");
    expect(alpha.output.videoCodec).toBe("prores4444");

    const green = buildRenderManifest(
      baseInput({
        outputKind: "greenscreen",
        decision: decisionFor({ outputKind: "greenscreen", requestedMode: "cloud" }),
      }),
    ).manifest;
    expect(green.audio.strategy).toBe("none");
    expect(green.output.chromaKey).toBe("#00FF00");
  });

  it("uses the bundled Free-tier mark when the decision says watermark", () => {
    const { manifest } = buildRenderManifest(baseInput({ decision: decisionFor() }));
    expect(manifest.watermark).toEqual({
      assetId: DEFAULT_WATERMARK_ASSET_ID,
      position: "bottom-right",
      opacity: 0.85,
    });
  });

  it("is null when the decision clears the watermark and no brand asset was requested", () => {
    const clean = decisionFor({
      entitlements: { watermark: "none", maxExportResolution: "1080p" },
    });
    const { manifest } = buildRenderManifest(baseInput({ decision: clean }));
    expect(manifest.watermark).toBeNull();
  });

  it("overlays a workspace's own brand asset even on an unwatermarked export", () => {
    const clean = decisionFor({
      entitlements: { watermark: "none", maxExportResolution: "1080p" },
    });
    const { manifest } = buildRenderManifest(
      baseInput({
        decision: clean,
        brandWatermark: {
          assetId: "01JBRANDASSET00000000000A",
          position: "top-left",
          opacity: 0.5,
        },
      }),
    );
    expect(manifest.watermark).toEqual({
      assetId: "01JBRANDASSET00000000000A",
      position: "top-left",
      opacity: 0.5,
    });
  });

  it("embeds the decision's caps verbatim", () => {
    const decision = decisionFor();
    const { manifest } = buildRenderManifest(baseInput({ decision }));
    expect(manifest.caps).toEqual({
      maxWidth: decision.maxWidth,
      maxHeight: decision.maxHeight,
      maxDurationMs: decision.maxDurationMs,
      maxFps: decision.maxFps,
      allowAlpha: decision.allowAlpha,
    });
  });

  it("expires MANIFEST_TTL_MS after issuedAt", () => {
    const { manifest } = buildRenderManifest(baseInput());
    expect(Date.parse(manifest.issuedAt)).toBe(NOW);
    expect(Date.parse(manifest.expiresAt)).toBe(NOW + MANIFEST_TTL_MS);
  });

  it("carries subtitles only for a subtitle request", () => {
    const video = buildRenderManifest(baseInput()).manifest;
    expect(video.subtitles).toBeNull();

    const subtitle = buildRenderManifest(
      baseInput({
        kind: "subtitle",
        subtitleFormats: ["srt", "vtt"],
        subtitleScripts: ["roman", "en"],
        decision: decisionFor({ kind: "subtitle", subtitleFormats: ["srt", "vtt"] }),
      }),
    ).manifest;
    expect(subtitle.subtitles).toEqual({
      formats: ["srt", "vtt"],
      scripts: ["roman", "en"],
      dropFillers: false,
    });
  });

  it("produces a manifest that passes assertWithinCaps for its own output length", () => {
    const { manifest } = buildRenderManifest(baseInput());
    const withSignature = { ...manifest, signature: "0".repeat(64) };
    expect(capViolations(withSignature, 30_000)).toEqual([]);
    expect(() => assertWithinCaps(withSignature, 30_000)).not.toThrow();
  });
});
