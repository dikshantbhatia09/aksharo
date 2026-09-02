import { expect, test, gotoHydrated } from "./fixtures";

/**
 * A01's smoke test, kept: the app boots and every route group resolves. A13
 * changed the `(app)` row, because that group is now behind a session and a
 * signed-out visitor is redirected rather than shown a placeholder.
 */

test("home renders the brand heading", async ({ page }) => {
  await gotoHydrated(page, "/");
  await expect(page.getByTestId("home-heading")).toHaveText("Aksharo");
  await expect(page).toHaveTitle(/Aksharo/);
});

test("health route answers ok", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ status: "ok", version: "0.1.0" });
});

test("the codename never reaches the page", async ({ page }) => {
  // CONTRACTS §0: `montaj` is an engineering codename and must not appear in
  // UI copy, titles or metadata.
  for (const path of ["/", "/login", "/signup", "/ui-kit"]) {
    await gotoHydrated(page, path);
    const html = await page.content();
    expect(html.toLowerCase(), path).not.toContain("montaj.ai");
    const visible = await page.evaluate(() => document.body.innerText.toLowerCase());
    expect(visible, path).not.toContain("montaj");
  }
});

const PUBLIC_ROUTE_GROUPS = [
  { group: "(share)", path: "/share", testId: "share-heading" },
  { group: "(admin)", path: "/admin", testId: "admin-heading" },
] as const;

for (const { group, path, testId } of PUBLIC_ROUTE_GROUPS) {
  test(`route group ${group} serves its placeholder at ${path}`, async ({ page }) => {
    await gotoHydrated(page, path);
    await expect(page.getByTestId(testId)).toBeVisible();
  });
}

test("route group (app) is behind a session", async ({ page }) => {
  await gotoHydrated(page, "/studio");
  await page.waitForURL(/\/login/);
  expect(new URL(page.url()).searchParams.get("next")).toBe("/studio");
});

test("the session route handlers refuse a cross-site write", async ({ request }) => {
  const response = await request.post("/api/session", {
    data: { refreshToken: "a".repeat(40) },
    headers: { "sec-fetch-site": "cross-site" },
  });
  expect(response.status()).toBe(403);
});

test("the session route handler never hands the refresh token back", async ({ request }) => {
  const response = await request.get("/api/session");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["authenticated"]);
});
