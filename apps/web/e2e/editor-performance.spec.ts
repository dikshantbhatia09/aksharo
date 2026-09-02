import { largeFixtureChunks, seedEditorProject } from "./editor-fixtures";
import { expect, gotoHydrated, test } from "./fixtures";

/**
 * Acceptance criterion 1: a 3-hour, 54,000-word transcript scrolls at
 * ≥ 55 fps. Chromium only, per the brief's own wording — `rAF`-driven frame
 * counting is what this measures, and `TranscriptList`'s virtualiser
 * (`lib/edg/virtual-list.ts`) is what should make the number hold regardless
 * of document size.
 */
test.describe("editor — scroll performance", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "measured on chromium, per the brief");

  test("scrolls a 54,000-word transcript at >= 55 fps", async ({ page, sharedAccount }) => {
    test.setTimeout(120_000);
    const { projectId } = await seedEditorProject(page, sharedAccount, {
      title: "A15 performance",
      chunks: largeFixtureChunks(54_000),
    });
    await gotoHydrated(page, `/p/${projectId}`);
    await expect(page.getByTestId("editor-root")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("transcript-list")).toBeVisible();
    // Let the first virtualised page settle before measuring.
    await page.waitForTimeout(500);

    const fps = await page.evaluate(async () => {
      const container = document.querySelector(
        '[data-testid="transcript-list"]',
      ) as HTMLDivElement | null;
      if (container === null) throw new Error("transcript list not found");

      const durationMs = 2000;
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      let frames = 0;
      const start = performance.now();

      return new Promise<number>((resolve) => {
        function step(now: number): void {
          frames += 1;
          const elapsed = now - start;
          const progress = Math.min(1, elapsed / durationMs);
          // A steady sweep down the full list — the worst case for a
          // virtualiser, since every frame's visible range is new.
          container!.scrollTop = maxScroll * progress;
          if (elapsed < durationMs) {
            requestAnimationFrame(step);
          } else {
            resolve((frames / elapsed) * 1000);
          }
        }
        requestAnimationFrame(step);
      });
    });

    console.log(`[A15 performance] 54,000-word transcript scroll: ${fps.toFixed(1)} fps`);
    expect(fps).toBeGreaterThanOrEqual(55);
  });
});
