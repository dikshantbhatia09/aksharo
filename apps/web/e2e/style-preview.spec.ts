import { expect, test } from "@playwright/test";

/**
 * The renderer, in a real browser, drawing real captions.
 *
 * Chromium only: `@montaj/render-canvaskit`'s own Playwright lane already
 * compares chromium's Skia against Node's pixel for pixel, and this suite's job
 * is the integration — wasm served from the app's origin, fonts fetched, tiles
 * drawn, a click producing the right op. The cross-browser lane is A18a's.
 */
test.describe("style preview canvas", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "CanvasKit is exercised on chromium here");

  test.beforeEach(async ({ page }) => {
    await page.goto("/studio/styles");
    await expect(page.getByTestId("styles-heading")).toBeVisible();
  });

  test("draws every tile with the real renderer", async ({ page }) => {
    const first = page.getByTestId("style-preview-punch-pop").first();
    await expect(first).toHaveAttribute("data-state", "ready", { timeout: 30_000 });

    // A tile that stayed the flat background colour would mean the fonts or the
    // wasm never arrived, which is exactly the failure this test exists for.
    const distinctColours = await first.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (context === null) return 0;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const seen = new Set<string>();
      for (let index = 0; index < data.length; index += 4) {
        seen.add(`${String(data[index])},${String(data[index + 1])},${String(data[index + 2])}`);
      }
      return seen.size;
    });
    expect(distinctColours).toBeGreaterThan(3);
  });

  test("emits one SetStyle op per tile picked, at document scope", async ({ page }) => {
    await expect(page.getByTestId("style-preview-punch-pop").first()).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 30_000 },
    );
    await page.getByTestId("style-picker-tile-karaoke-fill").click();
    const log = page.getByTestId("style-gallery-ops");
    await expect(log).toContainText('"op":"SetStyle"');
    await expect(log).toContainText('"styleRef":"karaoke-fill"');
    await expect(log).toContainText('"scope":"doc"');
  });

  test("narrows the grid by search and by category", async ({ page }) => {
    await page.getByTestId("style-picker-search").fill("karaoke");
    await expect(page.getByTestId("style-picker-tile-karaoke-fill")).toBeVisible();
    await expect(page.getByTestId("style-picker-tile-punch-pop")).toHaveCount(0);

    await page.getByTestId("style-picker-search").fill("");
    await page.getByTestId("style-picker-category-retro").click();
    await expect(page.getByTestId("style-picker-tile-tape-retro")).toBeVisible();
    await expect(page.getByTestId("style-picker-tile-punch-pop")).toHaveCount(0);
  });

  test("a Look slider emits a nested SetStyle override", async ({ page }) => {
    await page.getByTestId("right-panel-tab-look").click();
    const slider = page.getByTestId("field-typography-sizePct");
    await expect(slider).toBeVisible();
    await slider.fill("9");
    await expect(page.getByTestId("style-gallery-ops")).toContainText('"typography":{"sizePct":9}');
  });
});
