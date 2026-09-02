import { expect, gotoHydrated, signIn, test } from "./fixtures";

/**
 * Screenshots for review.
 *
 * There is no Storybook in this repository (brief §2), so the `/ui-kit` route is
 * the review surface and these captures are what Fable looks at. They are
 * written to `e2e/__screenshots__/` rather than compared, because a pixel
 * baseline for a page of live components would fail on a font hint and teach
 * everyone to ignore it.
 */

const SHOTS = "./e2e/__screenshots__";

test("captures the UI kit", async ({ page }, testInfo) => {
  await gotoHydrated(page, "/ui-kit");
  await expect(page.getByTestId("ui-kit")).toBeVisible();
  await expect(page.getByTestId("kit-palette")).toBeVisible();

  // Let the webfonts land, otherwise the capture shows the fallback stack.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  await page.screenshot({
    path: `${SHOTS}/ui-kit-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("captures the auth screens", async ({ page }, testInfo) => {
  for (const [name, path] of [
    ["login", "/login"],
    ["signup", "/signup"],
    ["magic", "/magic"],
  ] as const) {
    await gotoHydrated(page, path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.screenshot({
      path: `${SHOTS}/${name}-${testInfo.project.name}.png`,
      fullPage: true,
    });
  }
});

test("captures onboarding, the shell and settings", async ({ page, sharedAccount }, testInfo) => {
  await signIn(page, sharedAccount, "/onboarding");

  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/onboarding-${testInfo.project.name}.png`,
    fullPage: true,
  });

  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL(/\/studio/);
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({ path: `${SHOTS}/shell-${testInfo.project.name}.png`, fullPage: true });

  await page.getByTestId("open-palette").click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/command-palette-${testInfo.project.name}.png`,
  });
  await page.keyboard.press("Escape");

  await gotoHydrated(page, "/settings/privacy");
  await expect(page.getByTestId("settings-privacy")).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/settings-privacy-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("captures the shell at a phone width, with the drawer open", async ({
  page,
  sharedAccount,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, sharedAccount);

  await expect(page.getByTestId("open-nav")).toBeVisible();
  await page.getByTestId("open-nav").click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/shell-mobile-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
