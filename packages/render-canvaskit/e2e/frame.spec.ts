/**
 * The browser test the work package exists to make possible: chromium loads
 * CanvasKit, executes a committed `DrawCommand[]`, encodes the frame, and the
 * result is compared pixel for pixel against the PNG that Skia-in-Node drew
 * from the same list.
 *
 * The tolerance is decision D33's own parity SLO — at most 1% of pixels off by
 * more than 2/255 — so a failure here is the same failure A18a's gate will
 * report, only earlier and on one backend pair.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";


import { loadCanvasKit } from "../src/canvaskit.js";
import { BASELINE_CANVAS, BASELINE_FRAMES } from "../src/frames.js";
import { comparePixels, PARITY_MAX_DIFF_RATIO } from "../src/testing.js";

import type { CanvasKit } from "canvaskit-wasm";

const BASELINE_DIR = join(__dirname, "..", "fixtures", "baselines");

interface HarnessSummary {
  backend: "webgl" | "cpu";
  fonts: number;
  frames: string[];
}

let ck: CanvasKit;

test.beforeAll(async () => {
  ck = await loadCanvasKit();
});

/** Decodes a PNG to straight (unpremultiplied) RGBA with the same Skia build. */
function decodePng(bytes: Uint8Array): Uint8Array {
  const image = ck.MakeImageFromEncoded(bytes);
  if (image === null) throw new Error("could not decode a PNG");
  try {
    const pixels = image.readPixels(0, 0, {
      width: image.width(),
      height: image.height(),
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    if (pixels === null) throw new Error("could not read a decoded PNG back");
    return pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer);
  } finally {
    image.delete();
  }
}

test.describe("CanvasKit in the browser", () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page.waitForFunction(() => globalThis.__aksharoHarness !== undefined);
    const summary = (await page.evaluate(
      async () => globalThis.__aksharoHarness?.ready,
    )) as HarnessSummary | undefined;
    expect(errors, `the page threw: ${errors.join("; ")}`).toEqual([]);
    expect(summary, "the harness never became ready").toBeDefined();
  });

  test("boots on a Skia surface with every fixture font registered", async ({ page }) => {
    const summary = (await page.evaluate(
      async () => globalThis.__aksharoHarness?.ready,
    )) as HarnessSummary;
    // 3 fixture faces × 3 weights + 7 aliased families × 3 weights.
    expect(summary.fonts).toBe(30);
    expect(summary.frames).toEqual(BASELINE_FRAMES.map((frame) => frame.name));
    expect(["webgl", "cpu"]).toContain(summary.backend);
    console.log(`chromium drew on the ${summary.backend} surface`);
  });

  for (const frame of BASELINE_FRAMES) {
    test(`draws ${frame.name} like Skia-in-Node — ${frame.covers}`, async ({ page }) => {
      const encoded = await page.evaluate(
        (name) => globalThis.__aksharoHarness?.renderFrame(name),
        frame.name,
      );
      expect(encoded, "the harness returned no PNG").toBeTruthy();

      const missing = await page.evaluate(() => globalThis.__aksharoHarness?.missing() ?? []);
      expect(missing, "the browser could not find a font or an image").toEqual([]);

      const browserPixels = decodePng(Buffer.from(encoded ?? "", "base64"));
      const baselinePixels = decodePng(readFileSync(join(BASELINE_DIR, `${frame.name}.png`)));

      expect(browserPixels.length).toBe(BASELINE_CANVAS.width * BASELINE_CANVAS.height * 4);
      const diff = comparePixels(browserPixels, baselinePixels);
      console.log(
        `${frame.name}: ${String(diff.differing)}/${String(diff.total)} pixels differ (${(diff.ratio * 100).toFixed(4)}%), worst channel Δ${String(diff.maxChannelDelta)}`,
      );
      expect(
        diff.ratio,
        `${frame.name} drifted: ${(diff.ratio * 100).toFixed(4)}% of pixels differ by more than 2/255`,
      ).toBeLessThanOrEqual(PARITY_MAX_DIFF_RATIO);
    });
  }

  test("keeps drawing after a hundred frames without leaking a surface", async ({ page }) => {
    const first = await page.evaluate(() => globalThis.__aksharoHarness?.renderFrame("punch-pop-hinglish"));
    const last = await page.evaluate(() => {
      for (let index = 0; index < 99; index += 1) {
        globalThis.__aksharoHarness?.renderFrame("punch-pop-hinglish");
      }
      return globalThis.__aksharoHarness?.renderFrame("punch-pop-hinglish");
    });
    expect(last).toBe(first);
  });
});
