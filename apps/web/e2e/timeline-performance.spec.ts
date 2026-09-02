import { largeFixtureChunks, seedEditorProject } from "./editor-fixtures";
import { expect, gotoHydrated, test } from "./fixtures";
import { grantTimelineTestCredits } from "./timeline-credits";

/**
 * Acceptance criterion 2 (`A17-web-timeline.md`): a 3-hour timeline scrolls
 * and zooms at >= 55 fps, chromium only, per the same wording A15's own
 * `editor-performance.spec.ts` measures its transcript list against. The
 * Canvas2D draw in `Timeline.tsx` reduces the waveform and clips every lane
 * to the visible range each frame (`lib/timeline/waveform-view.ts`,
 * `lib/timeline/coords.ts`'s `visibleRange`) — the "virtualised drawing"
 * acceptance criterion — so the draw cost should stay flat regardless of the
 * transcript's length, which is exactly what this measures.
 */
test.describe("timeline — scroll/zoom performance", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "measured on chromium, per the brief");

  test("scrolls and zooms a 3-hour, 54,000-word timeline at >= 55 fps", async ({
    page,
    sharedAccount,
  }) => {
    test.setTimeout(150_000);
    await grantTimelineTestCredits(sharedAccount);
    const { projectId } = await seedEditorProject(page, sharedAccount, {
      title: "A17 performance",
      chunks: largeFixtureChunks(54_000),
    });
    await gotoHydrated(page, `/p/${projectId}`);
    await expect(page.getByTestId("editor-root")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("timeline-canvas")).toBeVisible();
    await page.waitForTimeout(500);

    const fps = await page.evaluate(async () => {
      const canvas = document.querySelector(
        '[data-testid="timeline-canvas"]',
      ) as HTMLCanvasElement | null;
      if (canvas === null) throw new Error("timeline canvas not found");
      const rect = canvas.getBoundingClientRect();

      const durationMs = 2000;
      let frames = 0;
      const start = performance.now();

      function dispatchWheel(deltaX: number, deltaY: number, ctrlKey: boolean): void {
        canvas!.dispatchEvent(
          new WheelEvent("wheel", {
            deltaX,
            deltaY,
            ctrlKey,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            bubbles: true,
            cancelable: true,
          }),
        );
      }

      return new Promise<number>((resolve) => {
        function step(now: number): void {
          frames += 1;
          const elapsed = now - start;
          // Alternate a horizontal scroll sweep with a zoom pulse — the
          // worst case for a virtualised canvas draw, since both change the
          // visible range every frame.
          if (frames % 2 === 0) {
            dispatchWheel(400, 0, false);
          } else {
            dispatchWheel(0, frames % 4 === 1 ? -40 : 40, true);
          }
          if (elapsed < durationMs) {
            requestAnimationFrame(step);
          } else {
            resolve((frames / elapsed) * 1000);
          }
        }
        requestAnimationFrame(step);
      });
    });

    console.log(`[A17 performance] 3-hour, 54,000-word timeline scroll/zoom: ${fps.toFixed(1)} fps`);
    expect(fps).toBeGreaterThanOrEqual(55);
  });
});
