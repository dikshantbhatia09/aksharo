import { expect, signIn, test } from "./fixtures";

/**
 * C11's own web surface: the Plugins page's activation card v2 (08 §4,
 * D65 naming) -- both product cards, the merged licence-key management
 * (B08), and the trademark attribution line. `team-devices-licensing.spec.ts`
 * already covers `/plugins/keys` and `/settings/devices` directly; this file
 * covers the page C11 adds at `/plugins`.
 */
test("Plugins: both activation cards are named per D65, with licence keys merged onto the same page", async ({
  page,
  sharedAccount,
}) => {
  await signIn(page, sharedAccount, "/plugins");

  await expect(page.getByTestId("plugins-page")).toBeVisible();
  await expect(page.getByTestId("plugins-page")).toContainText(
    "Aksharo Panel — works with Adobe Premiere Pro and Adobe After Effects",
  );
  await expect(page.getByTestId("plugins-page")).toContainText(
    "Aksharo — works with DaVinci Resolve",
  );
  await expect(page.getByTestId("activation-card-adobe")).toBeVisible();
  await expect(page.getByTestId("activation-card-resolve")).toBeVisible();

  // Not signed in on any device yet -- freshly seeded account.
  await expect(page.getByTestId("activation-card-adobe-state")).toContainText("Not installed");

  // Licence-key management (B08) merged onto the same page (brief §2).
  await expect(page.getByTestId("license-keys-page")).toBeVisible();
  await expect(page.getByTestId("plugins-page")).toContainText(
    "not affiliated with or endorsed by Adobe or Blackmagic Design",
  );
});

test("Plugins: the marketing page still answers /plugins for a signed-out visitor", async ({
  page,
}) => {
  await page.goto("/plugins");
  await expect(page.getByTestId("plugins-page")).not.toBeVisible();
});
