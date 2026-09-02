import { API_ORIGIN, expect, expectNoSeriousA11yViolations, gotoHydrated, signIn, test } from "./fixtures";

import type { Page } from "@playwright/test";

/**
 * B15 increment 2: the public `/share/:token` viewer, end to end against the
 * real API — share-link creation, scope enforcement (view/comment/approve),
 * password gating and the report-abuse flow. Chromium only (this suite's own
 * instruction); WebKit is A15/A17's CanvasKit lane, not this one's, and no
 * media is uploaded here (`insertProbedMedia` is not run), so the preview
 * stays in its "no playable preview yet" state deliberately — the assertions
 * below are about the surrounding surface, not the renderer.
 */

interface AccessToken {
  accessToken: string;
}

/** Same reasoning `editor-fixtures.ts#accessTokenFor` documents: a same-origin
 * `fetch` from inside the loaded page, not Playwright's own request context. */
async function accessTokenFor(page: Page): Promise<AccessToken> {
  return page.evaluate(async () => {
    const response = await fetch("/api/session/refresh", { method: "POST" });
    if (!response.ok) throw new Error(`refresh failed: ${String(response.status)}`);
    return (await response.json()) as AccessToken;
  });
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function createShareLink(
  page: Page,
  scope: "view" | "comment" | "approve",
  extra: Record<string, unknown> = {},
): Promise<{ token: string; projectId: string; url: string }> {
  const { accessToken } = await accessTokenFor(page);
  const headers = authHeaders(accessToken);

  const projectResponse = await page.request.post(`${API_ORIGIN}/projects`, {
    headers,
    data: { title: `B15 share e2e ${scope}` },
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = (await projectResponse.json()) as { id: string };

  const linkResponse = await page.request.post(
    `${API_ORIGIN}/projects/${project.id}/share-links`,
    { headers, data: { scope, ...extra } },
  );
  expect(linkResponse.ok()).toBeTruthy();
  const link = (await linkResponse.json()) as { token: string; url: string };

  return { token: link.token, projectId: project.id, url: link.url };
}

test.describe("Public share viewer", () => {
  test("a view-only link shows the project but no comment form, and the report form works", async ({
    browser,
    page,
    sharedAccount,
  }) => {
    await signIn(page, sharedAccount, "/studio");
    const { token } = await createShareLink(page, "view");

    // A brand-new, unauthenticated context: the whole point of a share link.
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await gotoHydrated(viewer, `/share/${token}`);

    await expect(viewer.getByTestId("share-title")).toBeVisible();
    await expect(viewer.getByTestId("comment-body")).toHaveCount(0);

    await viewer.getByTestId("report-abuse-open").click();
    await viewer.getByTestId("report-abuse-category").selectOption("other");
    await viewer.locator('[data-testid="report-abuse-form"] button[type=submit]').click();
    await expect(viewer.getByTestId("report-abuse-ack")).toBeVisible();

    await expectNoSeriousA11yViolations(viewer, "public share viewer (view scope)");
    await viewerContext.close();
  });

  test("a comment-scope link lets a guest reviewer post and see a comment", async ({
    browser,
    page,
    sharedAccount,
  }) => {
    await signIn(page, sharedAccount, "/studio");
    const { token } = await createShareLink(page, "comment");

    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await gotoHydrated(viewer, `/share/${token}`);

    await viewer.getByTestId("comment-author-name").fill("Ravi Reviewer");
    await viewer.getByTestId("comment-body").fill("The intro cut is a beat too long.");
    await viewer.getByText("Post comment").click();

    await expect(viewer.getByTestId("share-comment-item")).toContainText(
      "The intro cut is a beat too long.",
    );
    await viewerContext.close();
  });

  test("an approve-scope link records approve/request-changes", async ({
    browser,
    page,
    sharedAccount,
  }) => {
    await signIn(page, sharedAccount, "/studio");
    const { token } = await createShareLink(page, "approve");

    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await gotoHydrated(viewer, `/share/${token}`);

    await expect(viewer.getByTestId("share-decision-bar")).toBeVisible();
    await viewer.getByText("Approve", { exact: true }).click();
    await expect(viewer.getByTestId("share-decision-recorded")).toContainText("Approved");

    await viewerContext.close();
  });

  test("a password-protected link gates the viewer until unlocked", async ({
    browser,
    page,
    sharedAccount,
  }) => {
    await signIn(page, sharedAccount, "/studio");
    const { token } = await createShareLink(page, "view", { password: "correcthorsebattery" });

    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await gotoHydrated(viewer, `/share/${token}`);

    await expect(viewer.getByTestId("share-password-input")).toBeVisible();
    await viewer.getByTestId("share-password-input").fill("wrong-password");
    await viewer.getByText("Unlock").click();
    await expect(viewer.getByTestId("share-password-error")).toBeVisible();

    await viewer.getByTestId("share-password-input").fill("correcthorsebattery");
    await viewer.getByText("Unlock").click();
    await expect(viewer.getByTestId("share-title")).toBeVisible();

    await viewerContext.close();
  });
});
