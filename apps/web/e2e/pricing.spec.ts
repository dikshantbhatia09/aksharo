import { API_ORIGIN, expect, gotoHydrated, test } from "./fixtures";

/**
 * A24 acceptance: pricing with a currency toggle over the plan catalogue.
 *
 * `GET /billing/plans` (B01) is public and live in this suite's own API
 * instance (the Playwright config starts it before building the web app —
 * `playwright.config.ts`'s `webServer` array runs the API first and waits for
 * `/health`, so `next build`'s static generation of `/pricing` fetches the
 * real catalogue, not the fallback). `content/site/pricing-live.ts` still
 * falls back to the static mirror (`content/site/pricing-data.ts`) if the API
 * is unreachable — that path is exercised implicitly by every other suite
 * that builds the app without the API running (e.g. a bare
 * `pnpm --filter @montaj/web build`).
 */

/** Mirrors `formatPrice` in `content/site/pricing-data.ts` exactly. */
function formatExpectedInr(minorUnits: number): string {
  const value = minorUnits / 100;
  const formatted = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `₹${formatted}`;
}

test("renders the live plan catalogue and every price matches GET /billing/plans", async ({
  page,
  request,
}) => {
  const response = await request.get(`${API_ORIGIN}/billing/plans`);
  expect(response.ok(), "GET /billing/plans should answer for this test to mean anything").toBe(
    true,
  );
  const apiPlans = (await response.json()) as {
    key: string;
    prices: Record<string, Record<string, number>>;
  }[];
  expect(apiPlans.length).toBeGreaterThan(0);

  await gotoHydrated(page, "/pricing");

  // The build that produced this page's HTML ran with the API already up
  // (see the file header), so it should have fetched live, not fallen back.
  await expect(page.locator("[data-plan-source]")).toHaveAttribute("data-plan-source", "live");

  for (const plan of apiPlans) {
    const monthlyInr = plan.prices["INR"]?.["month"];
    if (monthlyInr === undefined) continue;
    await expect(
      page.getByTestId(`plan-card-${plan.key}-price`),
      `${plan.key} price should match the API's INR monthly price`,
    ).toHaveText(formatExpectedInr(monthlyInr));
  }
});

test("currency toggle switches every plan card between INR and USD", async ({ page }) => {
  await gotoHydrated(page, "/pricing");

  const creatorPrice = page.getByTestId("plan-card-creator-price");
  const initial = await creatorPrice.textContent();

  await page.getByTestId("currency-toggle-USD").click();
  await expect(creatorPrice).not.toHaveText(initial ?? "");
  await expect(creatorPrice).toContainText("$");

  await page.getByTestId("currency-toggle-INR").click();
  await expect(creatorPrice).toContainText("₹");
});

test("the billing interval toggle changes the displayed monthly amount", async ({ page }) => {
  await gotoHydrated(page, "/pricing");
  const price = page.getByTestId("plan-card-creator-price");
  const monthly = await price.textContent();

  await page.getByTestId("interval-toggle-year").click();
  const yearly = await price.textContent();
  expect(yearly).not.toBe(monthly);
});

test("every plan in the catalogue renders a card with a Start CTA", async ({ page }) => {
  await gotoHydrated(page, "/pricing");
  for (const plan of ["free", "starter", "creator", "studio", "agency"]) {
    const card = page.getByTestId(`plan-card-${plan}`);
    await expect(card).toBeVisible();
    await expect(card.getByRole("link")).toHaveAttribute("href", "/signup");
  }
});

test("the offers ladder, credits-to-outcomes and burn-rate tables are all present", async ({
  page,
}) => {
  await gotoHydrated(page, "/pricing");
  await expect(page.getByTestId("offer-signup-gift")).toBeVisible();
  await expect(page.getByTestId("offer-clean-export")).toContainText("₹9");
  await expect(page.getByTestId("offer-week-pass")).toContainText("₹59");
  await expect(page.getByTestId("offer-top-up")).toContainText("₹149");

  await expect(page.getByTestId("outcomes-table")).toContainText("500");
  await expect(page.getByTestId("burn-rate-table")).toContainText("Transcription");

  await expect(page.getByTestId("plan-matrix")).toContainText("Watermark on burn-in");
});

test("the FAQ answers both Pause's objections and the India payments questions", async ({
  page,
}) => {
  await gotoHydrated(page, "/pricing");
  await expect(page.getByText("Does my footage ever leave my computer?")).toBeVisible();
  // Two elements mention it — the section intro and the FAQ answer itself —
  // so this only proves it is said somewhere, not which one.
  await expect(page.getByText(/₹15,000/).first()).toBeVisible();
  await expect(
    page
      .getByText(/incl\. GST/i)
      .or(page.getByText(/18% GST/))
      .first(),
  ).toBeVisible();
});
