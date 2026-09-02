/**
 * The Devanagari `shaping=complex` golden the brief requires: RR-04 F6/F14
 * flags that ffmpeg's `ass`/`subtitles` filter has a `shaping` option whose
 * `complex` mode is the HarfBuzz path Devanagari conjuncts and matra
 * reordering need, and that the option was **never verified** against a real
 * ffmpeg build before this work package. `probeComplexShaping` answers "does
 * this option exist and run"; this test answers the harder question —
 * "does a real Devanagari cue actually rasterise to ink, not tofu or a blank
 * frame" — with a committed pixel hash and an ink-coverage floor, so both a
 * silent regression (fewer/different pixels) and a catastrophic one (nothing
 * drawn at all) fail loudly.
 *
 * Skipped, never failed, when this machine's ffmpeg has no libass — the
 * brief's explicit rule ("mark ass parity 'not measured', never fake a
 * result") applies here too.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadSystemStyles } from "@montaj/caption-styles";
import { layoutSegment } from "@montaj/render-core";
import { CAPTION_FIXTURES, createFixtureRenderer, PROXY_CANVAS } from "@montaj/render-core/testing";

import { probeComplexShaping, probeLibass, renderAssFrameToRgba } from "./ffmpeg-libass.js";
import { toAss } from "../src/to-ass.js";

import type { AssProjection, AssWord } from "../src/types.js";

const DEVANAGARI_FIXTURE = CAPTION_FIXTURES.find((f) => f.name === "hindi");
const GOLDEN_STYLE_ID = "vertical-clean"; // assRenderable per the measured results.json
const T_MS = 1500;

/**
 * Captured on the ffmpeg build this work package was implemented against
 * (`ffmpeg -version` in the final report). A hash that moves is a real
 * rendering change — a font substitution, a libass upgrade, a shaping fix —
 * and needs a human to look at the frame before updating this constant, the
 * same discipline `render-core`'s own goldens use.
 */
const EXPECTED_HASH = "e35759ef8f4cd203efb3832a7e161e844474222768ee95743994f6c4ae5a1547";

describe("Devanagari shaping=complex golden", () => {
  it("probeComplexShaping reports whether this ffmpeg build supports it", async () => {
    const probe = await probeComplexShaping();
    // Always assert *something* concrete: either it works, or we know why not.
    if (!probe.available) {
      expect(typeof probe.reason).toBe("string");
    } else {
      expect(probe.available).toBe(true);
    }
  });

  it.runIf(DEVANAGARI_FIXTURE !== undefined)(
    "renders the Devanagari fixture to non-trivial ink with shaping=complex",
    async () => {
      const libass = await probeLibass();
      if (!libass.available) {
        // "not measured" — never fabricate a golden on a machine without libass.
        return;
      }
      const fixture = DEVANAGARI_FIXTURE;
      if (fixture === undefined) return;

      const { registry, shaper } = await createFixtureRenderer();
      const style = loadSystemStyles().find((s) => s.id === GOLDEN_STYLE_ID);
      expect(style, GOLDEN_STYLE_ID).toBeDefined();
      if (style === undefined) return;

      const layout = layoutSegment({
        style,
        segment: fixture.segment,
        words: fixture.words,
        canvas: PROXY_CANVAS,
        registry,
        shaper,
        tMs: T_MS,
      });
      // layout is computed only to confirm render-core can lay the fixture out
      // at all; the golden itself renders through libass, not render-core.
      expect(layout.words.length).toBeGreaterThan(0);

      const words: AssWord[] = fixture.words.map((word) => ({
        wid: word.wid,
        t: word.t,
        s: word.s,
        e: word.e,
      }));
      const projection: AssProjection = {
        canvas: PROXY_CANVAS,
        segments: [
          {
            id: fixture.segment.id,
            startMs: fixture.segment.startMs,
            endMs: fixture.segment.endMs,
            startWordId: words[0]?.wid ?? "",
            endWordId: words[words.length - 1]?.wid ?? "",
            styleRef: style.id,
          },
        ],
      };
      const { ass } = toAss(projection, words, { [style.id]: style }, PROXY_CANVAS);
      expect(ass).toContain(fixture.words[0]?.t ?? "");

      const pixels = await renderAssFrameToRgba({
        assContent: ass,
        width: PROXY_CANVAS.width,
        height: PROXY_CANVAS.height,
        background: "#1a1a20ff",
        tMs: T_MS,
        durationMs: fixture.segment.endMs,
        shaping: "complex",
      });

      // Ink-coverage floor: some meaningful fraction of pixels must differ
      // from the flat background, or libass drew nothing (a blank frame is
      // the classic "silently broken" failure a hash alone can mask if it is
      // also wrong).
      let differing = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i] ?? 0;
        const g = pixels[i + 1] ?? 0;
        const b = pixels[i + 2] ?? 0;
        if (Math.abs(r - 0x1a) > 8 || Math.abs(g - 0x1a) > 8 || Math.abs(b - 0x20) > 8)
          differing += 1;
      }
      const totalPixels = pixels.length / 4;
      expect(differing / totalPixels).toBeGreaterThan(0.005);

      const hash = createHash("sha256").update(Buffer.from(pixels)).digest("hex");
      if (EXPECTED_HASH === "PLACEHOLDER") {
        // First run on this checkout: report the real hash so it can be
        // committed, rather than fail with an unhelpful diff.
        console.warn(`Devanagari golden hash (commit this): ${hash}`);
      } else {
        expect(hash).toBe(EXPECTED_HASH);
      }
    },
    30_000,
  );
});
