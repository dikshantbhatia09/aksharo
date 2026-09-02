import { expect, gotoHydrated, signIn, test } from "./fixtures";

/**
 * B08's own web surfaces: Team (members, invites, roles), Devices settings'
 * registered-devices section, and Licence keys under Plugins. Chromium and
 * WebKit both (10-build-plan §5); `a11y.spec.ts` covers the axe pass for all
 * three, this file covers the functional flows.
 */

test("Team: shows the owner, and an admin can invite a new member", async ({
  page,
  sharedAccount,
}) => {
  await signIn(page, sharedAccount, "/team");

  await expect(page.getByTestId("team-page")).toBeVisible();
  await expect(page.getByTestId("member-list")).toBeVisible();
  // The signed-in account is the workspace's owner (its own personal
  // workspace), so the row for their own address is present.
  await expect(page.getByTestId("member-list")).toContainText(sharedAccount.email);

  const inviteEmail = `b08-invitee-${Date.now().toString(36)}@example.test`;
  await page.getByTestId("invite-member-button").click();
  await page.getByLabel("Email").fill(inviteEmail);
  await page.getByTestId("submit-invite").click();

  await expect(page.getByTestId("member-list")).toContainText(inviteEmail);
});

test("Licence keys: create shows the AK-XXXX-XXXX-XXXX value once, then it can be revoked", async ({
  page,
  sharedAccount,
}) => {
  await signIn(page, sharedAccount, "/plugins/keys");

  await expect(page.getByTestId("license-keys-page")).toBeVisible();
  await page.getByTestId("create-license-key-button").click();
  await page.getByLabel("Label (optional)").fill("Playwright suite");
  await page.getByTestId("submit-create-key").click();

  const created = page.getByTestId("just-created-key");
  await expect(created).toBeVisible();
  await expect(created).toContainText(/^AK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);

  await expect(page.getByTestId("license-key-list")).toContainText("Playwright suite");

  const row = page.getByTestId("license-key-list").locator("li", { hasText: "Playwright suite" });
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toContainText("Revoked");
});

test("Settings devices: the registered-devices section renders alongside sessions", async ({
  page,
  sharedAccount,
}) => {
  await signIn(page, sharedAccount, "/settings/devices");

  await expect(page.getByTestId("settings-devices")).toBeVisible();
  await expect(page.getByTestId("registered-devices")).toBeVisible();
});
