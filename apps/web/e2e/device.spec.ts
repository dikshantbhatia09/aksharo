import { API_ORIGIN, expect, gotoHydrated, signIn, test } from "./fixtures";

/**
 * Device-code approval (THREAT-MODEL T3).
 *
 * The screen exists so a person can tell a real request from a phishing one, so
 * the test checks that the facts are actually on the page — host app, device,
 * address, location — and that approving needs a session.
 */

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
}

async function startDeviceFlow(request: {
  post: (
    url: string,
    options: { data: unknown; headers?: Record<string, string> },
  ) => Promise<{
    ok: () => boolean;
    json: () => Promise<unknown>;
    status: () => number;
    text: () => Promise<string>;
  }>;
}): Promise<DeviceCode> {
  const response = await request.post(`${API_ORIGIN}/auth/device/code`, {
    data: {
      clientKind: "premiere",
      hostApp: "premiere",
      deviceInfo: { os: "Windows 11", deviceName: "Studio PC", appVersion: "1.0.0" },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as DeviceCode;
}

test("a signed-out visitor is sent to sign in before approving anything", async ({ page }) => {
  await gotoHydrated(page, "/device?user_code=4F7K92QA");
  await page.waitForURL(/\/login/);
  expect(new URL(page.url()).searchParams.get("next")).toContain("/device");
});

test("the approval screen names the app, the device, the address and the location", async ({
  page,
  request,
  sharedAccount,
}) => {
  await signIn(page, sharedAccount);

  const code = await startDeviceFlow(request);
  // Eight characters, shown grouped as `BCDF-GHJK` for people to read out.
  expect(code.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  await gotoHydrated(page, `/device?user_code=${code.userCode}`);

  const facts = page.getByTestId("device-facts");
  await expect(facts).toBeVisible();
  await expect(facts).toContainText("Adobe Premiere Pro");
  await expect(facts).toContainText("Studio PC");
  await expect(facts).toContainText("Windows 11");
  await expect(facts).toContainText(code.userCode);
  // There is no geo-IP database (A04 open question 3), so the screen says so
  // rather than inventing a city.
  await expect(facts).toContainText("unknown");

  await expect(page.getByText(/only continue if you just started this/i)).toBeVisible();

  await page.getByTestId("device-approve").click();
  await expect(page.getByTestId("device-outcome")).toContainText("go back to the app");

  // The device is now signed in: the poll returns tokens rather than pending.
  const poll = await request.post(`${API_ORIGIN}/auth/device/token`, {
    data: { deviceCode: code.deviceCode },
  });
  expect(poll.ok(), await poll.text()).toBe(true);
  const tokens = (await poll.json()) as { accessToken?: string };
  expect(typeof tokens.accessToken).toBe("string");
});

test("declining approves nothing", async ({ page, request, sharedAccount }) => {
  await signIn(page, sharedAccount);

  const code = await startDeviceFlow(request);
  await gotoHydrated(page, `/device?user_code=${code.userCode}`);
  await expect(page.getByTestId("device-facts")).toBeVisible();

  await page.getByTestId("device-deny").click();
  await expect(page.getByTestId("device-outcome")).toContainText("Nothing was signed in");

  const poll = await request.post(`${API_ORIGIN}/auth/device/token`, {
    data: { deviceCode: code.deviceCode },
  });
  expect(poll.ok()).toBe(false);
});

test("an unknown code is rejected without saying whose it is", async ({ page, sharedAccount }) => {
  await signIn(page, sharedAccount);

  await gotoHydrated(page, "/device");
  await page.getByLabel("Device code").fill("ZZZZ9999");
  await page.getByTestId("device-code-submit").click();

  await expect(page.getByText(/could not find that|no longer works|expired/i)).toBeVisible();
});
