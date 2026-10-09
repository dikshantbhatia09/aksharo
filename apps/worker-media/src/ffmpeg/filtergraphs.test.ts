/**
 * Pillar 3 §05 — Blurred Background Canvas Fit (16:9 in 9:16)
 * Unit Tests for FFmpeg Filtergraph Generator (`apps/worker-media/src/ffmpeg/filtergraphs.test.ts`)
 *
 * Verifies:
 * 1. `buildBlurredFitFiltergraph(1920, 1080, 1080, 1920)` produces the exact dual-layer
 *    `-filter_complex` string with `boxblur=luma_radius=35:luma_power=2`,
 *    `colorchannelmixer=aa=1.0:rr=0.6:gg=0.6:bb=0.6`, `[0:v]scale=1080:608[fg]`,
 *    and `[bg][fg]overlay=x=0:y=656[v]`.
 * 2. Aspect ratio validations (`validateBlurredFitAspectRatio`) across widescreen 16:9,
 *    ultrawide 21:9, 4:3, and 4:5 target canvases, rejecting portrait-into-landscape
 *    or non-positive dimensions.
 * 3. Single-stream `-vf` filtergraph generation (`buildBlurredFitVfFiltergraph`).
 */

import { describe, expect, it } from "vitest";

import {
  buildBlurredFitFiltergraph,
  buildBlurredFitVfFiltergraph,
  computeBlurredFitFilterGeometry,
  validateBlurredFitAspectRatio,
} from "./filtergraphs.js";

describe("buildBlurredFitFiltergraph (Pillar 3 §05 Blurred Background Canvas Fit)", () => {
  it("generates the exact 16:9 -> 9:16 FFmpeg filtergraph (1920x1080 -> 1080x1920)", () => {
    const graph = buildBlurredFitFiltergraph(1920, 1080, 1080, 1920);
    expect(graph).toBe(
      "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=35:luma_power=2,colorchannelmixer=aa=1.0:rr=0.6:gg=0.6:bb=0.6[bg]; [0:v]scale=1080:608[fg]; [bg][fg]overlay=x=0:y=656[v]",
    );
  });

  it("computes accurate foreground geometry for ultrawide 21:9 (2560x1080) and 4:5 feed (1080x1350) canvases", () => {
    const ultrawide = computeBlurredFitFilterGeometry(2560, 1080, 1080, 1920);
    expect(ultrawide.foregroundWidth).toBe(1080);
    expect(ultrawide.foregroundHeight).toBe(456); // 1080 * (1080 / 2560) = 455.625 -> even 456
    expect(ultrawide.overlayX).toBe(0);
    expect(ultrawide.overlayY).toBe(732); // (1920 - 456) / 2 = 732

    const feed4x5 = computeBlurredFitFilterGeometry(1920, 1080, 1080, 1350);
    expect(feed4x5.foregroundWidth).toBe(1080);
    expect(feed4x5.foregroundHeight).toBe(608);
    expect(feed4x5.overlayY).toBe(370); // Math.floor((1350 - 608) / 4) * 2 = 370
  });

  it("validates aspect ratios and rejects portrait-into-landscape or invalid dimensions", () => {
    expect(() => validateBlurredFitAspectRatio(1920, 1080, 1080, 1920)).not.toThrow();
    expect(() => validateBlurredFitAspectRatio(1280, 720, 1080, 1350)).not.toThrow();

    // Portrait source (9:16) into vertical 9:16 or landscape 16:9 is rejected
    expect(() => buildBlurredFitFiltergraph(1080, 1920, 1080, 1920)).toThrow(RangeError);
    expect(() => buildBlurredFitFiltergraph(1080, 1920, 1920, 1080)).toThrow(RangeError);

    // Non-positive or NaN dimensions are rejected
    expect(() => buildBlurredFitFiltergraph(0, 1080, 1080, 1920)).toThrow(RangeError);
    expect(() => buildBlurredFitFiltergraph(1920, -1080, 1080, 1920)).toThrow(RangeError);
    expect(() => buildBlurredFitFiltergraph(Number.NaN, 1080, 1080, 1920)).toThrow(RangeError);
  });

  it("builds a single-stream -vf filtergraph for media.clip pipelines", () => {
    const vf = buildBlurredFitVfFiltergraph(1920, 1080, 1080, 1920, {
      lumaRadius: 35,
      colorChannelFactor: 0.6,
    });
    expect(vf).toContain("scale=1920:1080,split=2[bg_in][fg_in]");
    expect(vf).toContain(
      "[bg_in]scale=1080:1920:force_original_aspect_ratio=increase:flags=bicubic,crop=1080:1920,boxblur=luma_radius=35:luma_power=2,colorchannelmixer=aa=1.0:rr=0.6:gg=0.6:bb=0.6[bg]",
    );
    expect(vf).toContain("[fg_in]scale=1080:608:flags=bicubic,setsar=1[fg]");
    expect(vf).toContain("[bg][fg]overlay=x=0:y=656,setsar=1,format=yuv420p");
  });
});
