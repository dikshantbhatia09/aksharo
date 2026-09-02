import { expect, gotoHydrated, test } from "./fixtures";

/**
 * A24 scope item 9: "metadata, OpenGraph images generated at build, sitemap,
 * robots." A lightweight Lighthouse-style check: this asserts the metadata a
 * crawler and a social-share unfurl need is actually present, rather than
 * running a full Lighthouse audit in CI (reported as a deviation — see the
 * final report for the manual Lighthouse numbers).
 */

test("sitemap.xml lists the marketing pages", async ({ page }) => {
  const response = await page.request.get("/sitemap.xml");
  expect(response.ok()).toBe(true);
  const body = await response.text();
  for (const path of ["<loc>", "/features", "/pricing", "/plugins", "/vs/kalakar"]) {
    expect(body).toContain(path);
  }
});

test("robots.txt disallows the studio and allows the marketing site", async ({ page }) => {
  const response = await page.request.get("/robots.txt");
  expect(response.ok()).toBe(true);
  const body = await response.text();
  expect(body).toContain("Disallow: /studio");
  expect(body).toContain("Sitemap:");
});

const PAGES_WITH_OG = ["/", "/pricing", "/features", "/plugins", "/styles"] as const;

for (const path of PAGES_WITH_OG) {
  test(`${path} carries title, description and OpenGraph metadata`, async ({ page }) => {
    await gotoHydrated(page, path);

    await expect(page).toHaveTitle(/Aksharo/);

    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute("content", /.{20,}/);

    const ogTitle = page.locator('meta[property="og:title"]');
    await expect(ogTitle).toHaveCount(1);

    const ogImage = page.locator('meta[property="og:image"]');
    await expect(ogImage).toHaveCount(1);
    const imageUrl = await ogImage.getAttribute("content");
    expect(imageUrl).not.toBeNull();

    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
  });
}

test("legal pages are marked noindex", async ({ page }) => {
  await gotoHydrated(page, "/legal/privacy");
  const robotsMeta = page.locator('meta[name="robots"]');
  await expect(robotsMeta).toHaveAttribute("content", /noindex/);
});

test("a comparison page's OpenGraph image renders", async ({ page }) => {
  await gotoHydrated(page, "/vs/kalakar");
  const ogImage = page.locator('meta[property="og:image"]');
  const imageUrl = await ogImage.getAttribute("content");
  expect(imageUrl).not.toBeNull();

  // `og:image` is resolved against the root layout's `metadataBase`
  // (`https://aksharo.ai`), which is correct for production but unreachable
  // from this sandboxed test run (no DNS for the real domain) — so this
  // requests the same path against the app under test instead of the literal
  // absolute URL.
  const path = new URL(imageUrl ?? "", "http://placeholder.invalid");
  const response = await page.request.get(`${path.pathname}${path.search}`);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("image");
});
