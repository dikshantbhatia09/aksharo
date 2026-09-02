import { expect, signUpAndVerify, test, gotoHydrated } from "./fixtures";

/**
 * Consent, and the promise that goes with it: nothing analytics-shaped loads
 * before the user says yes (brief §7, D60), and what they choose survives a
 * reload.
 */

/** Anything that looks like a product-analytics request. */
const ANALYTICS_PATTERN = /posthog|segment|amplitude|mixpanel|google-analytics|gtag/i;

test("no analytics request is made before consent", async ({ page }) => {
  const analyticsRequests: string[] = [];
  page.on("request", (request) => {
    if (ANALYTICS_PATTERN.test(request.url())) analyticsRequests.push(request.url());
  });

  await gotoHydrated(page, "/signup");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await gotoHydrated(page, "/login");
  await expect(page.getByTestId("google-signin")).toBeVisible();

  await signUpAndVerify(page, "no-analytics");
  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL(/\/studio/);
  await expect(page.getByTestId("sidebar")).toBeVisible();

  expect(
    analyticsRequests,
    `analytics loaded before consent: ${analyticsRequests.join(", ")}`,
  ).toEqual([]);
});

test("consent toggles persist across a reload", async ({ page }) => {
  await signUpAndVerify(page, "consent-persist");
  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL(/\/studio/);

  await gotoHydrated(page, "/settings/privacy");
  await expect(page.getByTestId("settings-privacy")).toBeVisible();

  const analytics = page.getByTestId("settings-analytics");
  const memory = page.getByTestId("settings-memory");
  await expect(analytics).toHaveAttribute("data-state", "unchecked");
  await expect(memory).toHaveAttribute("data-state", "unchecked");

  await memory.click();
  await expect(memory).toHaveAttribute("data-state", "checked");

  await page.reload();
  await expect(page.getByTestId("settings-memory")).toHaveAttribute("data-state", "checked");
  await expect(page.getByTestId("settings-analytics")).toHaveAttribute("data-state", "unchecked");
});

test("granting memory consent opens the learned-memory screen", async ({ page }) => {
  await signUpAndVerify(page, "memory-consent");
  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL(/\/studio/);

  await gotoHydrated(page, "/settings/memory");
  await expect(page.getByTestId("memory-disabled")).toBeVisible();

  await gotoHydrated(page, "/settings/privacy");
  await page.getByTestId("settings-memory").click();

  await gotoHydrated(page, "/settings/memory");
  await expect(page.getByTestId("memory-disabled")).toHaveCount(0);
  await expect(page.getByText(/never train AI models on your footage/i)).toBeVisible();
});

test("analytics consent given at sign-up is what the shell remembers", async ({ page }) => {
  await signUpAndVerify(page, "analytics-consent", { analytics: true });
  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL(/\/studio/);

  await gotoHydrated(page, "/settings/privacy");
  await expect(page.getByTestId("settings-analytics")).toHaveAttribute("data-state", "checked");
});

test("a declared minor cannot switch analytics on (D60)", async ({ page }) => {
  // 16 in the EU: allowed to have an account, still a minor for targeting.
  await gotoHydrated(page, "/signup");
  await page.getByLabel("Name").fill("Teen Creator");
  const email = `a13-minor-eu-${Date.now().toString(36)}@example.test`;
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("a-long-enough-passphrase");
  await page.getByTestId("signup-continue").click();

  await page.getByLabel("Date of birth").fill("2009-01-01");
  await page.getByRole("radio", { name: /European Union/ }).click();
  await page.getByTestId("age-consent-submit").click();
  await expect(page.getByTestId("signup-sent")).toBeVisible();

  // The browser's mirror records the minor flag, so analytics stays off even if
  // the toggle is turned on later.
  const privacy = await page.evaluate(() => window.localStorage.getItem("aksharo.privacy"));
  expect(privacy).not.toBeNull();
  expect(JSON.parse(privacy ?? "{}")).toMatchObject({ minor: true, analytics: false });
});

test("settings offers export and a confirmed deletion", async ({ page }) => {
  await signUpAndVerify(page, "rights");
  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL(/\/studio/);

  await gotoHydrated(page, "/settings/privacy");
  await expect(page.getByTestId("export-data")).toBeVisible();

  await page.getByTestId("delete-account").click();
  const confirm = page.getByTestId("delete-account-confirm");
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Type DELETE").fill("DELETE");
  await expect(confirm).toBeEnabled();
});

test("devices and sessions lists the session you are using", async ({ page }) => {
  await signUpAndVerify(page, "sessions");
  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL(/\/studio/);

  await gotoHydrated(page, "/settings/devices");
  await expect(page.getByTestId("session-list")).toBeVisible();
  await expect(page.getByText("This device").first()).toBeVisible();
});
