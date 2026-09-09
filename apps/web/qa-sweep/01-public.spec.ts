import { expect, test } from "@playwright/test";

import { overflow, record, shot, watch } from "./diag";

/** Public (signed-out) surface: navigation, layout at phone + desktop widths. */

const ROUTES = [
  "/",
  "/pricing",
  "/features",
  "/styles",
  "/plugins",
  "/download",
  "/docs",
  "/docs/guides",
  "/changelog",
  "/status",
  "/legal",
  "/login",
  "/signup",
];

for (const width of [390, 1440]) {
  test(`public routes @${String(width)}`, async ({ page }) => {
    watch(page, `public@${String(width)}`);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const route of ROUTES) {
      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      const status = response?.status() ?? 0;
      if (status >= 400) {
        record({ kind: "route-status", where: `${route}@${String(width)}`, detail: String(status) });
        continue;
      }
      await page.waitForTimeout(700);
      const of = await overflow(page);
      if (of.scrollWidth > of.clientWidth + 1) {
        record({
          kind: "overflow",
          where: `${route}@${String(width)}`,
          detail: `scrollWidth=${String(of.scrollWidth)} clientWidth=${String(of.clientWidth)} :: ${of.offenders.join(" | ")}`,
        });
        await shot(page, `overflow-${route.replaceAll("/", "_")}-${String(width)}`);
      }
      const title = await page.title();
      if (title.trim() === "") {
        record({ kind: "empty-title", where: `${route}@${String(width)}`, detail: "document.title empty" });
      }
    }
    expect(true).toBe(true);
  });
}
