import { expect, gotoHydrated, test } from "./fixtures";

/**
 * C10: the marketing `/plugins` and `/download` pages read `GET /plugins/manifest` live
 * (server component fetch, `apps/web/lib/plugin-manifest.ts`) with a static-copy fallback
 * when nothing has been published yet -- which is exactly the case in this suite's test
 * API (no `tools/release publish` has run against it), so both cases assert the honest
 * placeholder copy stays visible rather than a broken link, plus the first-run
 * SmartScreen/Gatekeeper copy and the D65 non-affiliation line `plugins-legal.spec.ts`
 * already covers in more depth. One case per page (brief §5), chromium only.
 */

test("Plugins page: falls back to the download-placeholder copy when no channel manifest is published", async ({
  page,
}) => {
  await gotoHydrated(page, "/plugins");

  await expect(page.getByTestId("plugin-card-premiere-ae")).toBeVisible();
  await expect(page.getByTestId("plugin-card-resolve")).toBeVisible();
  // No plugins-manifest.json has been published against this suite's test API, so both
  // cards render the honest placeholder rather than a download button pointing nowhere.
  await expect(page.getByTestId("plugin-download-placeholder-premiere-ae")).toBeVisible();
  await expect(page.getByTestId("plugin-download-placeholder-resolve")).toBeVisible();
  await expect(page.getByTestId("plugin-download-premiere-ae")).toHaveCount(0);
});

test("Download page: per-OS cards show the SmartScreen/Gatekeeper first-run copy and the publisher name", async ({
  page,
}) => {
  await gotoHydrated(page, "/download");

  await expect(page.getByTestId("download-card-windows")).toContainText("SmartScreen");
  await expect(page.getByTestId("download-card-macos")).toContainText("Gatekeeper");
  await expect(page.getByTestId("publisher-name")).toBeVisible();
  // No channel manifest published against this suite's test API -> placeholder, not a
  // download button pointing at a URL nothing has published yet.
  await expect(page.getByTestId("download-placeholder-windows")).toBeVisible();
  await expect(page.getByTestId("download-button-windows")).toHaveCount(0);
});
