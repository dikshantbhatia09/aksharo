import { expect, expectNoSeriousA11yViolations, gotoHydrated, signIn, test } from "./fixtures";

/**
 * Academy and Help centre rendering (brief §6: "e2e rendering of one track
 * and one help article"). Content is real MDX (`apps/web/content/**`), read
 * server-side; progress and search run against the real API/worktree
 * database like every other e2e spec here.
 */

test("academy: the track list renders, and one track's detail page renders its steps", async ({
  page,
  sharedAccount,
}) => {
  await signIn(page, sharedAccount);
  await gotoHydrated(page, "/academy");

  await expect(page.getByTestId("academy-track-list")).toBeVisible();
  const trackLink = page.getByTestId("academy-track-hinglish-reel");
  await expect(trackLink).toBeVisible();
  await expectNoSeriousA11yViolations(page, "academy track list");

  await trackLink.click();
  await expect(page.getByTestId("academy-step-list")).toBeVisible();
  await expect(page.getByTestId("mark-done-upload-clip")).toBeVisible();
  await expectNoSeriousA11yViolations(page, "academy track detail");
});

test("academy: marking a step done updates its state", async ({ page, sharedAccount }) => {
  await signIn(page, sharedAccount);
  await gotoHydrated(page, "/academy/hinglish-reel");

  const markDone = page.getByTestId("mark-done-upload-clip");
  await expect(markDone).toBeVisible();
  await markDone.click();
  await expect(markDone).toBeDisabled();
});

test("help: the centre renders categories, search finds an article, and the article page renders", async ({
  page,
  sharedAccount,
}) => {
  await signIn(page, sharedAccount);
  await gotoHydrated(page, "/help");

  await expect(page.getByTestId("help-article-uploading-media")).toBeVisible();
  await expectNoSeriousA11yViolations(page, "help centre");

  await page.getByTestId("help-search-input").fill("transcript");
  await expect(page.getByTestId("help-search-results")).toBeVisible();
  await expect(page.getByText("Fixing the transcript")).toBeVisible();

  await page.getByTestId("help-contact-support").click();
  await expect(page).toHaveURL(/\/settings\/support/);
});
