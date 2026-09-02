import { expect, expectNoSeriousA11yViolations, gotoHydrated, signIn, test } from "./fixtures";

/**
 * An axe pass on every screen A13 ships, signed out and signed in.
 *
 * Serious and critical only: those are defects (an unlabelled control, a dialog
 * with no name, contrast below AA). Failing on advisory rules would make the
 * build fail on opinions.
 */

const PUBLIC_SCREENS = [
  { path: "/", name: "marketing home" },
  { path: "/login", name: "sign in" },
  { path: "/signup", name: "sign up" },
  { path: "/magic", name: "magic link" },
  { path: "/verify?token=nope", name: "expired confirmation" },
  { path: "/auth/desktop-landing?code=abc123def456ghi&status=login", name: "desktop landing" },
  { path: "/ui-kit", name: "UI kit" },
] as const;

for (const screen of PUBLIC_SCREENS) {
  test(`axe: ${screen.name}`, async ({ page }) => {
    await gotoHydrated(page, screen.path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSeriousA11yViolations(page, screen.name);
  });
}

test("axe: sign-up step 0 — age and consents", async ({ page }) => {
  await gotoHydrated(page, "/signup");
  await page.getByLabel("Name").fill("Priya");
  await page.getByLabel("Email").fill(`a13-axe-${Date.now().toString(36)}@example.test`);
  await page.getByLabel("Password").fill("a-long-enough-passphrase");
  await page.getByTestId("signup-continue").click();
  await expect(page.getByTestId("age-consent-step")).toBeVisible();
  await expectNoSeriousA11yViolations(page, "age and consents");
});

const SIGNED_IN_SCREENS = [
  { path: "/studio", name: "shell" },
  { path: "/settings/profile", name: "settings — profile" },
  { path: "/settings/languages", name: "settings — languages" },
  { path: "/settings/memory", name: "settings — memory" },
  { path: "/settings/devices", name: "settings — devices" },
  { path: "/settings/privacy", name: "settings — privacy" },
  { path: "/settings/notifications", name: "settings — notifications" },
  { path: "/device", name: "device approval" },
  { path: "/team", name: "team" },
  { path: "/plugins/keys", name: "licence keys" },
] as const;

test("axe: the shell, onboarding and every settings screen", async ({ page, sharedAccount }) => {
  await signIn(page, sharedAccount, "/onboarding");

  await expect(page.getByTestId("onboarding")).toBeVisible();
  await expectNoSeriousA11yViolations(page, "onboarding");

  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL(/\/studio/);

  for (const screen of SIGNED_IN_SCREENS) {
    await gotoHydrated(page, screen.path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSeriousA11yViolations(page, screen.name);
  }
});

test("axe: the command palette", async ({ page, sharedAccount }) => {
  await signIn(page, sharedAccount);

  await page.getByTestId("open-palette").click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await expectNoSeriousA11yViolations(page, "command palette");
});

test("the keyboard alone reaches the content and the navigation", async ({
  page,
  browserName,
  sharedAccount,
}) => {
  await signIn(page, sharedAccount);

  // A fresh navigation, so the tab order starts at the top of the document
  // rather than wherever the previous click left focus.
  await gotoHydrated(page, "/studio");
  await expect(page.getByTestId("sidebar")).toBeVisible();

  const skip = page.getByRole("link", { name: "Skip to content" });
  if (browserName === "webkit") {
    // Safari only tabs between form controls unless "Full Keyboard Access" is
    // on, which is an OS setting no page can influence — so there the assertion
    // is that the link takes focus and works, not that Tab reaches it.
    await skip.focus();
  } else {
    // The skip link is first in the tab order and jumps to the main landmark.
    await page.keyboard.press("Tab");
  }
  await expect(skip).toBeFocused();
  await skip.press("Enter");
  expect(new URL(page.url()).hash).toBe("#main");

  // Ctrl+K opens the palette from anywhere, and Escape closes it.
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
});
