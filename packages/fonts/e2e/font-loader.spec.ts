/**
 * The browser test this work package exists to make possible: Chromium fetches
 * the pack's **WOFF2** files, decompresses them, registers them into the
 * CanvasKit backend and draws a Latin, a Devanagari and a Tamil caption.
 *
 * What makes it a real test rather than a smoke test is that the commands were
 * laid out in Node from the same pack (`build-bundle.mjs`), so every
 * `GlyphRun.fontId` in them names a face the loader had to produce. A WOFF2 that
 * decompressed to the wrong bytes, a manifest whose ids drifted from the files,
 * or a face that quietly failed to register all show up here as a missing
 * resource and an empty frame.
 */

import { expect, test } from "@playwright/test";

interface Summary {
  backend: "webgl" | "cpu";
  registered: number;
  counts: { woff2: number; sfnt: number };
  failed: { id: string; reason: string }[];
  frames: string[];
  resolvedFontIds: string[];
}

const FRAMES = ["latin", "devanagari", "tamil"] as const;

test.describe("the browser font loader", () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page.waitForFunction(() => globalThis.__aksharoFontHarness !== undefined);
    await expect(page.getByTestId("status")).toHaveText(/^ready:/);
    expect(errors, `the page threw: ${errors.join("; ")}`).toEqual([]);
  });

  test("registers every face as WOFF2, with nothing falling back to sfnt", async ({ page }) => {
    const summary = (await page.evaluate(
      async () => globalThis.__aksharoFontHarness?.ready,
    )) as Summary;

    expect(
      summary.failed,
      `faces the loader could not load: ${JSON.stringify(summary.failed)}`,
    ).toEqual([]);
    expect(summary.registered).toBeGreaterThan(0);
    // Every byte came over the wire compressed; nothing needed the .ttf.
    expect(summary.counts.sfnt).toBe(0);
    expect(summary.counts.woff2).toBe(summary.registered);
    expect(["webgl", "cpu"]).toContain(summary.backend);
    console.log(
      `chromium registered ${String(summary.registered)} WOFF2 faces on the ${summary.backend} surface`,
    );
  });

  test("resolves every face id the laid-out commands reference", async ({ page }) => {
    const summary = (await page.evaluate(
      async () => globalThis.__aksharoFontHarness?.ready,
    )) as Summary;
    expect(summary.resolvedFontIds.length).toBeGreaterThan(0);
    expect(summary.frames).toEqual(expect.arrayContaining([...FRAMES]));
  });

  for (const frame of FRAMES) {
    test(`draws the ${frame} caption with real glyphs`, async ({ page }) => {
      const encoded = await page.evaluate(
        (name) => globalThis.__aksharoFontHarness?.renderFrame(name),
        frame,
      );
      expect(encoded, "the harness returned no PNG").toBeTruthy();

      const missing = await page.evaluate(() => globalThis.__aksharoFontHarness?.missing() ?? []);
      expect(missing, `the browser could not find a typeface: ${JSON.stringify(missing)}`).toEqual(
        [],
      );

      const png = Buffer.from(encoded ?? "", "base64");
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");

      // A frame that drew nothing is the failure mode a "did it render" test has
      // to catch: a missing typeface draws no glyphs and leaves the canvas empty.
      const ink = await page.evaluate(
        (name) => globalThis.__aksharoFontHarness?.inkRatio(name) ?? 0,
        frame,
      );
      console.log(`${frame}: ${(ink * 100).toFixed(2)}% of the frame is inked`);
      expect(ink).toBeGreaterThan(0.002);
    });
  }

  test("keeps drawing after a hundred frames without leaking a surface", async ({ page }) => {
    const first = await page.evaluate(() =>
      globalThis.__aksharoFontHarness?.renderFrame("devanagari"),
    );
    const last = await page.evaluate(() => {
      for (let index = 0; index < 99; index += 1) {
        globalThis.__aksharoFontHarness?.renderFrame("devanagari");
      }
      return globalThis.__aksharoFontHarness?.renderFrame("devanagari");
    });
    expect(last).toBe(first);
  });
});
