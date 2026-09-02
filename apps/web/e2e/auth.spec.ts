import { BRAND } from "@montaj/config";

import {
  API_ORIGIN,
  expect,
  signUpAndVerify,
  test,
  uniqueEmail,
  waitForToken,
  gotoHydrated,
} from "./fixtures";

/**
 * The journey the brief asks for: sign up → onboarding → the shell renders.
 * Plus the two things the auth screens must never get wrong — the 202 that hides
 * whether an address exists, and the age gate.
 */

test("sign up, confirm the address, finish onboarding and land in the shell", async ({ page }) => {
  // Sign-up, an argon2id hash, a mail round trip through Redis, sign-in and
  // three onboarding steps: the longest journey in the suite.
  test.slow();
  await signUpAndVerify(page, "journey");

  // Onboarding steps 1–3. Step 0 was part of sign-up, because D60 makes date of
  // birth and consent part of creating the account.
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What do you make?" })).toBeVisible();

  await page.getByTestId("choice-reels").click();
  await page.getByTestId("onboarding-next").click();

  await expect(page.getByRole("heading", { name: /Languages you speak/ })).toBeVisible();
  await page.getByTestId("choice-hi-Latn").click();
  await page.getByTestId("onboarding-next").click();

  await expect(page.getByRole("heading", { name: /How did you find us/ })).toBeVisible();
  await page.getByTestId("choice-YouTube").click();
  await page.getByTestId("onboarding-next").click();

  // `onboarding-flow.tsx`'s `router.replace("/")` runs on both the skip and
  // the completed-wizard path — since A14, "/" rewrites invisibly to
  // `/home` for a signed-in visitor, so this never becomes "/studio" either.
  await page.waitForURL(/\/studio|\/$/);
  await expect(page.getByTestId("home-view")).toBeVisible();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("nav-home")).toBeVisible();
  await expect(page.getByTestId("credit-meter")).toBeVisible();
});

test("sign-up answers the same way whether or not the address is taken", async ({ page }) => {
  const email = uniqueEmail("enumeration");

  /** One pass of the sign-up form. Returns the confirmation copy. */
  async function signUp(name: string): Promise<string> {
    await gotoHydrated(page, "/signup");
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("a-long-enough-passphrase");
    await page.getByTestId("signup-continue").click();
    await page.getByLabel("Date of birth").fill("1990-01-01");
    await page.getByTestId("age-consent-submit").click();
    await expect(page.getByTestId("signup-sent")).toBeVisible();
    const heading = await page.getByRole("heading", { level: 1 }).innerText();
    const notice = await page.getByTestId("signup-sent").innerText();
    return `${heading}
${notice}`.toLowerCase();
  }

  const first = await signUp("Priya Sharma");
  // Second attempt with the same address: still 202, still "check your inbox".
  const second = await signUp("Somebody Else");

  // The two answers must be indistinguishable, and neither may claim the
  // address is or is not in use.
  expect(second).toBe(first);
  for (const text of [first, second]) {
    expect(text).not.toMatch(/already (have|has|registered|exists)/);
    expect(text).not.toMatch(/is taken|in use|not found|no account/);
  }
  expect(second).toContain("check your inbox");
});

test("an under-18 in India is blocked kindly and offered the waiting list (D60)", async ({
  page,
}) => {
  const email = uniqueEmail("minor");

  await gotoHydrated(page, "/signup");
  await page.getByLabel("Name").fill("Young Creator");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("a-long-enough-passphrase");
  await page.getByTestId("signup-continue").click();

  await page.getByLabel("Date of birth").fill("2012-06-01");
  await expect(page.getByRole("radio", { name: "India" })).toBeChecked();
  await page.getByTestId("age-consent-submit").click();

  await expect(page.getByTestId("blocked-minor")).toBeVisible();
  await expect(page.getByText(/accounts start at 18/i)).toBeVisible();

  await page.getByLabel("Email for the waiting list").fill(email);
  await page.getByTestId("waitlist-submit").click();
  await expect(page.getByTestId("waitlist-done")).toBeVisible();
});

test("both consents start off and nothing is pre-ticked", async ({ page }) => {
  await gotoHydrated(page, "/signup");
  await page.getByLabel("Name").fill("Priya");
  await page.getByLabel("Email").fill(uniqueEmail("consent-default"));
  await page.getByLabel("Password").fill("a-long-enough-passphrase");
  await page.getByTestId("signup-continue").click();

  await expect(page.getByTestId("consent-analytics")).toHaveAttribute("data-state", "unchecked");
  await expect(page.getByTestId("consent-memory")).toHaveAttribute("data-state", "unchecked");
});

test("sign in with a password, then sign out", async ({ page }) => {
  const { email, password } = await signUpAndVerify(page, "login");

  await page.getByTestId("onboarding-skip").click();
  // Since A14, "/" rewrites invisibly to the authenticated `/home` for a
  // signed-in visitor — the address bar never becomes "/studio" for the
  // onboarding-skip path (only completing the wizard lands there).
  await page.waitForURL(/\/studio|\/$/);

  await page.getByTestId("profile-menu").click();
  await page.getByTestId("sign-out").click();
  await page.waitForURL(/\/login/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByTestId("login-submit").click();

  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await expect(page.getByTestId("home-view")).toBeVisible();
});

test("a wrong password says the same thing as an unknown address", async ({ page }) => {
  await gotoHydrated(page, "/login");
  await page.getByLabel("Email").fill(uniqueEmail("ghost"));
  await page.getByLabel("Password").fill("definitely-not-the-password");
  await page.getByTestId("login-submit").click();

  const error = page.getByTestId("login-error");
  await expect(error).toBeVisible();
  const text = (await error.innerText()).toLowerCase();
  expect(text).not.toContain("no account");
  expect(text).not.toContain("not found");
  expect(text).toContain("did not match");
});

test("a magic link signs the user in", async ({ page }) => {
  const { email } = await signUpAndVerify(page, "magic");
  await page.getByTestId("onboarding-skip").click();
  // See the sign-in test above: onboarding-skip lands on "/" (rewritten to
  // `/home`), not "/studio".
  await page.waitForURL(/\/studio|\/$/);
  await page.getByTestId("profile-menu").click();
  await page.getByTestId("sign-out").click();
  await page.waitForURL(/\/login/);

  await gotoHydrated(page, "/magic");
  await page.getByLabel("Email").fill(email);
  await page.getByTestId("magic-submit").click();
  await expect(page.getByTestId("magic-sent")).toBeVisible();

  const token = await waitForToken(email, "magic_link");
  await gotoHydrated(page, `/magic?token=${encodeURIComponent(token)}`);
  await page.waitForURL((url) => !url.pathname.startsWith("/magic"));
  await expect(page.getByTestId("home-view")).toBeVisible();
});

test("a magic link for an unknown address still says check your inbox", async ({ page }) => {
  await gotoHydrated(page, "/magic");
  await page.getByLabel("Email").fill(uniqueEmail("nobody"));
  await page.getByTestId("magic-submit").click();
  await expect(page.getByTestId("magic-sent")).toBeVisible();
});

test("an expired confirmation link offers a new one", async ({ page }) => {
  await gotoHydrated(page, "/verify?token=this-token-was-never-issued-at-all");
  await expect(page.getByTestId("verify-error")).toBeVisible();
  await expect(page.getByRole("link", { name: /new link/i })).toBeVisible();
});

test("the signed-out shell redirects to sign in and comes back afterwards", async ({ page }) => {
  await gotoHydrated(page, "/settings/privacy");
  await page.waitForURL(/\/login/);
  expect(new URL(page.url()).searchParams.get("next")).toBe("/settings/privacy");
});

test("the desktop landing page offers the deep link as a fallback", async ({ page }) => {
  await gotoHydrated(page, "/auth/desktop-landing?code=abc123def456ghi789&status=login");
  const button = page.getByTestId("open-desktop-app");
  await expect(button).toBeVisible();
  const href = await button.getAttribute("href");
  expect(href).toContain(`${BRAND.deepLinkScheme}://auth-callback`);
  expect(href).toContain("code=abc123def456ghi789");
});

test("the desktop landing page refuses an incomplete link", async ({ page }) => {
  await gotoHydrated(page, "/auth/desktop-landing");
  await expect(page.getByTestId("landing-error")).toBeVisible();
});

test("Google sign-in starts at the API, with the web client", async ({ page }) => {
  await gotoHydrated(page, "/login");
  const button = page.getByTestId("google-signin");
  await expect(button).toBeVisible();

  // The button is a navigation, not a fetch: PKCE state only works if the
  // browser actually goes to the API. Stop at the redirect rather than reaching
  // Google from a test run.
  await page.route(`${API_ORIGIN}/auth/oauth/google/start*`, async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
  const [request] = await Promise.all([
    page.waitForRequest(`${API_ORIGIN}/auth/oauth/google/start*`),
    button.click(),
  ]);
  expect(new URL(request.url()).searchParams.get("client")).toBe("web");
});
