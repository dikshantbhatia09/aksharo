import { expect, expectNoSeriousA11yViolations, gotoHydrated, test } from "./fixtures";

/**
 * A24: axe on every marketing page, serious/critical only (same bar as A13's
 * `a11y.spec.ts`).
 */

const PAGES = [
  "/",
  "/features",
  "/styles",
  "/pricing",
  "/plugins",
  "/download",
  "/vs/kalakar",
  "/vs/captik",
  "/vs/submagic",
  "/vs/autocut",
  "/legal",
  "/legal/privacy",
  "/legal/terms",
  "/legal/aup",
  "/legal/refunds",
  "/legal/dpa",
  "/legal/grievance",
  "/changelog",
] as const;

for (const path of PAGES) {
  test(`axe: marketing ${path}`, async ({ page }) => {
    await gotoHydrated(page, path);
    await expectNoSeriousA11yViolations(page, path);
  });
}

test("the skip link reaches the marketing main landmark", async ({ page }) => {
  await gotoHydrated(page, "/features");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await skip.focus();
  await skip.press("Enter");
  const { hash } = new URL(page.url());
  expect(hash).toBe("#main");
});
