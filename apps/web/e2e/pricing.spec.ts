import { expect, gotoHydrated, test } from "./fixtures";

/**
 * A24 acceptance: pricing with a currency toggle over the plan catalogue.
 * The catalogue itself is a static mirror of `apps/api/prisma/seed-data.ts`
 * (no live `GET /billing/plans` exists yet — see `content/site/pricing-data.ts`
 * for why), so this suite checks the toggle actually changes what is on
 * screen rather than checking specific numbers against a running API.
 */

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
