import { expect, test } from "@playwright/test";

/**
 * A01 smoke: the app boots and every route group resolves. A23 replaces this
 * with the real journey (signup, upload, transcript, ops, export).
 */

test("home renders the brand heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("home-heading")).toHaveText("Aksharo");
  await expect(page).toHaveTitle(/Aksharo/);
});

test("health route answers ok", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ status: "ok", version: "0.1.0" });
});

// One test per group: each gets a fresh page, so a client-side prefetch in one
// route cannot interrupt the next navigation (WebKit is strict about that).
const ROUTE_GROUPS = [
  { group: "(app)", path: "/studio", testId: "studio-heading" },
  { group: "(share)", path: "/share", testId: "share-heading" },
  { group: "(admin)", path: "/admin", testId: "admin-heading" },
] as const;

for (const { group, path, testId } of ROUTE_GROUPS) {
  test(`route group ${group} serves its placeholder at ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByTestId(testId)).toBeVisible();
  });
}
