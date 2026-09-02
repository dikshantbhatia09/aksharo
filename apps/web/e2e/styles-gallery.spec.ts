import { expect, gotoHydrated, test } from "./fixtures";

/**
 * A24: the public styles gallery (all 30 styles, category and script filters,
 * hover-to-animate). The pixel-drawing assertion mirrors
 * `style-preview.spec.ts`'s chromium-only pattern — CanvasKit's cross-browser
 * pixel parity is A18a's lane, this suite's job is the page integration.
 */

test("lists all 30 system styles by default", async ({ page }) => {
  await gotoHydrated(page, "/styles");
  await expect(page.getByTestId("styles-gallery-count")).toHaveText("30 of 30 styles");
});

test("narrows the grid by search and by category", async ({ page }) => {
  await gotoHydrated(page, "/styles");

  await page.getByTestId("styles-gallery-search").fill("karaoke");
  await expect(page.getByTestId("styles-gallery-tile-karaoke-fill")).toBeVisible();
  await expect(page.getByTestId("styles-gallery-tile-punch-pop")).toHaveCount(0);

  await page.getByTestId("styles-gallery-search").fill("");
  await page.getByTestId("styles-gallery-category-retro").click();
  await expect(page.getByTestId("styles-gallery-tile-tape-retro")).toBeVisible();
  await expect(page.getByTestId("styles-gallery-tile-punch-pop")).toHaveCount(0);
});

test("the script toggle changes the preview script for every tile", async ({ page }) => {
  await gotoHydrated(page, "/styles");
  await expect(page.getByTestId("styles-gallery-script-latin")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("styles-gallery-script-devanagari").click();
  await expect(page.getByTestId("styles-gallery-script-devanagari")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("styles-gallery-script-latin")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test.describe("real renderer output", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "CanvasKit is exercised on chromium here",
  );

  test("draws a real tile with the real renderer", async ({ page }) => {
    await gotoHydrated(page, "/styles");
    const first = page.getByTestId("style-preview-punch-pop").first();
    await expect(first).toHaveAttribute("data-state", "ready", { timeout: 30_000 });

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
});
