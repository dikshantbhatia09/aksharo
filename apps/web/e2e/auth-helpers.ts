import { signUpAndVerify } from "./fixtures";

import type { Page } from "@playwright/test";

/**
 * Sign up, confirm the address, sign in, and skip the rest of onboarding
 * (F-002 steps 1–3 set defaults this suite does not need) — landing on the
 * real Home (`/`, rewritten there by `middleware.ts`).
 *
 * Also waits past a real race: `AppShell` renders its children immediately,
 * before its own async bootstrap (`POST /api/session/refresh`, turning the
 * httpOnly cookie into an access token) has necessarily finished. The API
 * client's own 401-retry (`Providers`' `refreshAccessToken`) covers an
 * interaction that fires in that window, but only after paying for one
 * failed request first — and a `page.waitForResponse` racing that same
 * window can catch the failed attempt rather than the retried one. Waiting
 * here for the first *successful* entitlement read closes the window before
 * any test interacts with the page, rather than trusting every interaction
 * downstream to survive it.
 */
export async function signUpAndSkipOnboarding(page: Page, label: string): Promise<void> {
  await signUpAndVerify(page, label);
  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.waitForResponse((response) => response.url().includes("/entitlement") && response.ok());
}
