import { mkdirSync, writeFileSync } from "node:fs";

import { expect, signIn, test } from "./fixtures";

import type { Page } from "@playwright/test";

/**
 * A screenshot of every screen the Nocturne pass rebuilt, at the canvas's own
 * 1440 × 900 preview size.
 *
 * This is a **verification aid, not a gate**: it asserts only that each screen
 * mounts, then writes a PNG for a person to compare against
 * `Aksharo Studio (premium).dc.html`. It is deliberately chromium-only and
 * deliberately outside the `smoke`/`a11y` suites, so a red pixel never fails
 * CI — what CI enforces about these screens lives in their own unit tests.
 *
 * Run it against a scratch stack, never against `.env.local-run` (CLAUDE.md
 * §1 — that is production, and the sign-up below creates a real account):
 *
 * ```
 * cd apps/web
 * API_PORT=3131 API_ORIGIN=http://127.0.0.1:3131 WEB_PORT=3132 \
 *   DATABASE_URL="postgresql://montaj:montaj@localhost:59432/montaj_e2e?schema=public" \
 *   REDIS_URL="redis://localhost:59379" \
 *   npx playwright test e2e/nocturne-shots.spec.ts --project=chromium
 * ```
 */

const OUT = "test-results-nocturne";

test.describe("Nocturne screens", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "one browser is enough for a look");

  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
  });

  async function shot(page: Page, name: string): Promise<void> {
    // The canvas's own `$preview` size, so a side-by-side is like for like.
    await page.setViewportSize({ width: 1440, height: 900 });
    // Let fonts settle: Inter arrives from Google Fonts and a shot taken
    // before it lands measures the fallback's metrics, not the design's.
    await page.evaluate(async () => document.fonts.ready);
    // And let the data settle. Nearly every card on these screens is a
    // TanStack query; a shot taken mid-flight photographs the skeletons, not
    // the design. `networkidle` is discouraged for *assertions* — it is
    // exactly right for "the page has stopped changing, take the picture".
    await page.waitForLoadState("networkidle").catch(() => undefined);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- `name` is a literal from this file, written into this suite's own output dir
    writeFileSync(`${OUT}/${name}.png`, await page.screenshot({ fullPage: true }));
  }

  test("studio, library, styles, pipeline, plan, settings, first run", async ({
    page,
    sharedAccount,
  }) => {
    test.setTimeout(180_000);

    await signIn(page, sharedAccount, "/");
    await expect(page.getByTestId("home-view")).toBeVisible();
    await shot(page, "01-studio");

    await page.getByTestId("nav-model-sidebar").click();
    await expect(page.getByTestId("sidebar-brand")).toBeVisible();
    await shot(page, "02-studio-sidebar");
    await page.getByTestId("nav-model-rail").click();

    await page.goto("/projects");
    await expect(page.getByTestId("projects-view")).toBeVisible();
    await shot(page, "03-library");

    await page.goto("/studio/styles");
    await expect(page.getByTestId("styles-view")).toBeVisible();
    // The tiles are real renders; give CanvasKit a moment to draw them.
    await page.waitForTimeout(3_000);
    await shot(page, "04-styles");

    await page.goto("/repurpose");
    await expect(page.getByTestId("repurpose-index")).toBeVisible();
    await shot(page, "05-pipeline");

    await page.goto("/billing");
    await expect(page.getByTestId("billing-overview")).toBeVisible();
    await shot(page, "06-plan");

    await page.goto("/settings/profile");
    await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await shot(page, "07-settings");

    await page.goto("/onboarding");
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await shot(page, "08-first-run");
  });

  test("the signed-out site", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("hero-headline")).toBeVisible();
    await shot(page, "09-site");
  });
});
