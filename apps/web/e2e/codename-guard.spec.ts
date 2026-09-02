import { expect, gotoHydrated, test } from "./fixtures";

/**
 * A24 acceptance criterion 2: "Brand strings only from `BRAND`; grep test
 * proves the codename never appears in `(site)` output." Extends A13's
 * `smoke.spec.ts` "the codename never reaches the page" test (which only
 * covers `/`, `/login`, `/signup`, `/ui-kit`) to every page this work package
 * adds — rendered HTML, visible text and the `<title>`/meta description.
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
  test(`codename guard: ${path} never says montaj`, async ({ page }) => {
    await gotoHydrated(page, path);

    const html = await page.content();
    expect(html.toLowerCase(), `${path} HTML source`).not.toContain("montaj.ai");

    const visible = await page.evaluate(() => document.body.innerText.toLowerCase());
    expect(visible, `${path} visible text`).not.toContain("montaj");

    const title = await page.title();
    expect(title.toLowerCase(), `${path} <title>`).not.toContain("montaj");

    const description = await page
      .locator('meta[name="description"]')
      .getAttribute("content")
      .catch(() => null);
    if (description !== null) {
      expect(description.toLowerCase(), `${path} meta description`).not.toContain("montaj");
    }
  });
}

test("sitemap.xml and robots.txt never mention montaj", async ({ page }) => {
  const sitemap = await (await page.request.get("/sitemap.xml")).text();
  expect(sitemap.toLowerCase()).not.toContain("montaj");

  const robots = await (await page.request.get("/robots.txt")).text();
  expect(robots.toLowerCase()).not.toContain("montaj");
});
