import { test } from "@playwright/test";

import { shot, watch } from "./diag";

/** Visual capture of the surfaces that depend on CanvasKit + subset fonts. */
test("marketing canvas surfaces", async ({ page }) => {
  watch(page, "visual");
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await shot(page, "home-desktop");
  const demo = page.locator('[data-testid*="live-caption"], [data-testid*="demo"]').first();
  if (await demo.count()) {
    await demo.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    await shot(page, "home-live-demo");
  }

  await page.goto("/styles", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await shot(page, "styles-gallery");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/features", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.scrollTo(0, 900);
  });
  await shot(page, "features-mobile");
});
