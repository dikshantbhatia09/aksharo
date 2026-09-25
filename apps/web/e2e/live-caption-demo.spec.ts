import { expect, gotoHydrated, test } from "./fixtures";

/**
 * A24 scope item 1: the home hero's live browser demo — a bundled 15 s
 * Hinglish mock transcript rendered by the real CanvasKit renderer, with a
 * style switcher. No ASR call is made (no network request to a transcription
 * endpoint should fire from this component).
 */

test("the style switcher offers only punch-pop, selected", async ({ page }) => {
  await gotoHydrated(page, "/");
  const switcher = page.getByTestId("live-caption-demo-switcher");
  await expect(switcher).toBeVisible();
  await expect(switcher.getByRole("button")).toHaveCount(1);
  await expect(page.getByTestId("live-caption-demo-style-punch-pop")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("makes no network request to a transcription endpoint", async ({ page }) => {
  const asrRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/transcribe|\/ai\/|asr/i.test(url)) asrRequests.push(url);
  });
  await gotoHydrated(page, "/");
  await page.waitForTimeout(1_500);
  expect(asrRequests).toEqual([]);
});

test.describe("real renderer output", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "CanvasKit is exercised on chromium here",
  );

  test("draws the sample transcript with the real renderer", async ({ page }) => {
    await gotoHydrated(page, "/");
    const canvas = page.getByTestId("live-caption-demo-canvas");
    await expect(canvas).toHaveAttribute("data-state", "ready", { timeout: 30_000 });

    const distinctColours = await canvas.evaluate((element) => {
      const el = element as HTMLCanvasElement;
      const context = el.getContext("2d");
      if (context === null) return 0;
      const { data } = context.getImageData(0, 0, el.width, el.height);
      const seen = new Set<string>();
      for (let index = 0; index < data.length; index += 4) {
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        seen.add(`${String(data[index])},${String(data[index + 1])},${String(data[index + 2])}`);
      }
      return seen.size;
    });
    expect(distinctColours).toBeGreaterThan(3);
  });
});
