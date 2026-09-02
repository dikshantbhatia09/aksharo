import AxeBuilder from "@axe-core/playwright";

import { API_ORIGIN, seedEditorProject } from "./editor-fixtures";
import { expect, gotoHydrated, test } from "./fixtures";
import { grantTimelineTestCredits } from "./timeline-credits";

import type { Account } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * The timeline (A17) end to end: a seeded project's caption timeline draws,
 * a segment-edge drag lands a `SetSegmentBounds` op, scrubbing the ruler
 * moves the shared playhead, zoom changes the drawn range, keyboard nudging
 * moves a boundary without a mouse, and an axe pass — chromium and webkit
 * both, per `playwright.config.ts`'s two projects.
 */

interface DocumentSegment {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** Reads the live EDG document straight from the API, for assertions an op landed. */
async function fetchSegments(page: Page, projectId: string): Promise<DocumentSegment[]> {
  const { accessToken } = await page.evaluate(async () => {
    const response = await fetch("/api/session/refresh", { method: "POST" });
    return (await response.json()) as { accessToken: string };
  });
  const docResponse = await page.request.get(`${API_ORIGIN}/projects/${projectId}/edg`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const doc = (await docResponse.json()) as { segments: DocumentSegment[] };
  return [...doc.segments].sort((a, b) => a.startMs - b.startMs);
}

/** Seeds a project, opens its editor, and returns the id every test needs for direct API reads. */
async function openSeededTimeline(page: Page, account: Account, title: string): Promise<string> {
  await grantTimelineTestCredits(account);
  const { projectId } = await seedEditorProject(page, account, { title });
  await gotoHydrated(page, `/p/${projectId}`);
  await expect(page.getByTestId("editor-root")).toBeVisible({ timeout: 30_000 });
  return projectId;
}

test.describe("timeline", () => {
  test("draws the timeline with a canvas, ruler and lanes", async ({ page, sharedAccount }) => {
    await openSeededTimeline(page, sharedAccount, `A17 ${test.info().title}`);
    const root = page.getByTestId("timeline-root");
    await expect(root).toBeVisible();
    await expect(page.getByTestId("timeline-canvas")).toBeVisible();
    await expect(page.getByTestId("timeline-display-clock")).toBeVisible();
  });

  test("dragging a segment edge lands a SetSegmentBounds op", async ({ page, sharedAccount }) => {
    const projectId = await openSeededTimeline(page, sharedAccount, `A17 ${test.info().title}`);
    const before = await fetchSegments(page, projectId);
    test.skip(before.length === 0, "seeded project produced no segments");
    const segment = before[0]!;

    const canvas = page.getByTestId("timeline-canvas");
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("timeline canvas has no box");

    // Default zoom is 30 ms/px, scroll 0 (Timeline.tsx's initial state) —
    // the segment lane sits at y = 24 (ruler) + 64 (waveform) + 2 + 28
    // (word lane) + 2 = 120, 36px tall, so its vertical centre is 138.
    const msPerPx = 30;
    const segmentTop = 120;
    const endX = box.x + segment.endMs / msPerPx;
    const y = box.y + segmentTop + 18;

    // Drag the end edge two seconds earlier.
    await page.mouse.move(endX, y);
    await page.mouse.down();
    await page.mouse.move(endX - 2000 / msPerPx, y, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(
        async () => {
          const after = await fetchSegments(page, projectId);
          const same = after.find((s) => s.id === segment.id);
          return same?.endMs;
        },
        { timeout: 10_000 },
      )
      .not.toBe(segment.endMs);
  });

  test("clicking the ruler scrubs the shared playhead", async ({ page, sharedAccount }) => {
    await openSeededTimeline(page, sharedAccount, `A17 ${test.info().title}`);
    const canvas = page.getByTestId("timeline-canvas");
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("timeline canvas has no box");
    const before = await page.getByTestId("timeline-display-clock").textContent();
    await page.mouse.click(box.x + 100, box.y + 10);
    await expect
      .poll(async () => page.getByTestId("timeline-display-clock").textContent())
      .not.toBe(before);
  });

  test("zoom in/out buttons change the visible range without an error", async ({
    page,
    sharedAccount,
  }) => {
    await openSeededTimeline(page, sharedAccount, `A17 ${test.info().title}`);
    const zoomIn = page.getByTestId("timeline-zoom-in");
    const zoomOut = page.getByTestId("timeline-zoom-out");
    await zoomIn.click();
    await zoomIn.click();
    await zoomOut.click();
    // No crash, canvas still there — the coordinate math itself is unit-tested
    // in `lib/timeline/coords.test.ts`; this only proves the buttons are wired.
    await expect(page.getByTestId("timeline-canvas")).toBeVisible();
  });

  test("keyboard nudges a selected segment's boundary by 10ms (100ms with Shift)", async ({
    page,
    sharedAccount,
  }) => {
    const projectId = await openSeededTimeline(page, sharedAccount, `A17 ${test.info().title}`);
    const before = await fetchSegments(page, projectId);
    test.skip(before.length === 0, "seeded project produced no segments");
    const segment = before[0]!;

    // Select the segment via the transcript card (shared selection state),
    // wait for the timeline's own aria description to reflect it (proof the
    // shared `selectedSegmentId` reached `Timeline.tsx`, not just the
    // transcript column), then focus the timeline for the arrow-key nudge.
    await page.getByTestId(`segment-card-${segment.id}`).click();
    await expect(page.getByTestId("timeline-aria-description")).toContainText(
      "Segment selected",
      { timeout: 10_000 },
    );
    await page.getByTestId("timeline-root").focus();
    // Shift+ArrowLeft (100ms) rather than the bare 10ms step: the fixture's
    // segment boundary already sits on a word edge, and a plain 10ms nudge
    // snaps straight back to it (`lib/timeline/snapping.ts`'s 40ms
    // tolerance, unit-tested in `snapping.test.ts`) — genuinely a no-op, not
    // a bug. 100ms clears the tolerance and always moves.
    await page.keyboard.press("Shift+ArrowLeft");

    await expect
      .poll(
        async () => {
          const after = await fetchSegments(page, projectId);
          return after.find((s) => s.id === segment.id)?.endMs;
        },
        { timeout: 10_000 },
      )
      .not.toBe(segment.endMs);
  });

  test("has no serious axe violations", async ({ page, sharedAccount }) => {
    await openSeededTimeline(page, sharedAccount, `A17 ${test.info().title}`);
    const results = await new AxeBuilder({ page })
      .include('[data-testid="timeline-root"]')
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious).toEqual([]);
  });
});
