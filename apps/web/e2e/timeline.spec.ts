import AxeBuilder from "@axe-core/playwright";

import { API_ORIGIN, seedEditorProject, testUlid } from "./editor-fixtures";
import { expect, gotoHydrated, test } from "./fixtures";
import { mergePassForTest } from "./internal-callback";
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

interface TranscriptWord {
  readonly wid: string;
  readonly s: number;
  readonly e: number;
}

/** Reads the first chunk's live words straight from the API (A02d). */
async function fetchWords(page: Page, projectId: string): Promise<TranscriptWord[]> {
  const { accessToken } = await page.evaluate(async () => {
    const response = await fetch("/api/session/refresh", { method: "POST" });
    return (await response.json()) as { accessToken: string };
  });
  const response = await page.request.get(`${API_ORIGIN}/projects/${projectId}/transcript`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await response.json()) as {
    chunks: { chunkIdx: number; words: TranscriptWord[] }[];
  };
  const first = body.chunks.find((chunk) => chunk.chunkIdx === 0);
  return first?.words ?? [];
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

interface PassItemView {
  readonly itemId: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** The access token an e2e page's own session carries, refreshed on demand. */
async function accessTokenOf(page: Page): Promise<string> {
  const { accessToken } = await page.evaluate(async () => {
    const response = await fetch("/api/session/refresh", { method: "POST" });
    return (await response.json()) as { accessToken: string };
  });
  return accessToken;
}

/** The EDG document's current revision (`GET /projects/{id}/edg`). */
async function fetchRevision(page: Page, projectId: string): Promise<number> {
  const accessToken = await accessTokenOf(page);
  const response = await page.request.get(`${API_ORIGIN}/projects/${projectId}/edg`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await response.json()) as { revision: number };
  return body.revision;
}

/** Every pass item on the document, across every pass (B20b). */
async function fetchPassItems(page: Page, projectId: string): Promise<PassItemView[]> {
  const accessToken = await accessTokenOf(page);
  const response = await page.request.get(`${API_ORIGIN}/projects/${projectId}/passes`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await response.json()) as { passes: { items: PassItemView[] }[] };
  return body.passes.flatMap((pass) => pass.items);
}

/**
 * Merges one proposed `cut` pass item directly, the way `PassCompletionHandler`
 * would after a real `ai.pass` job — the internal, HMAC-signed write path
 * (`mergePassForTest`), so the drag-to-adjust test below needs no worker.
 */
async function seedCutItem(
  page: Page,
  projectId: string,
  bounds: { startMs: number; endMs: number },
): Promise<string> {
  const revision = await fetchRevision(page, projectId);
  const passId = testUlid();
  const itemId = testUlid();
  await mergePassForTest(projectId, {
    baseRevision: revision,
    opId: testUlid(),
    pass: {
      passId,
      type: "autocut",
      engine: "autocut@2",
      params: {},
      status: "ready",
      items: [
        {
          itemId,
          passId,
          kind: "cut",
          startMs: bounds.startMs,
          endMs: bounds.endMs,
          payload: {},
          state: "proposed",
        },
      ],
    },
  });
  return itemId;
}

/** Reads `EdgHot.protected` straight from the API (B18b), for the "P" toggle test. */
async function fetchProtectedRanges(
  page: Page,
  projectId: string,
): Promise<{ id: string; s: number; e: number }[]> {
  const { accessToken } = await page.evaluate(async () => {
    const response = await fetch("/api/session/refresh", { method: "POST" });
    return (await response.json()) as { accessToken: string };
  });
  const docResponse = await page.request.get(`${API_ORIGIN}/projects/${projectId}/edg`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const doc = (await docResponse.json()) as {
    hot: { protected?: { id: string; s: number; e: number }[] };
  };
  return doc.hot.protected ?? [];
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
    await expect(page.getByTestId("timeline-aria-description")).toContainText("Segment selected", {
      timeout: 10_000,
    });
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

  test("dragging a word edge lands a SetWordTiming op (A02d)", async ({ page, sharedAccount }) => {
    const projectId = await openSeededTimeline(page, sharedAccount, `A02d ${test.info().title}`);
    const before = await fetchWords(page, projectId);
    test.skip(before.length < 3, "seeded project produced too few words");
    // Pick an inner word (not the first/last of the chunk) so a small drag of
    // its end edge cannot be mistaken for a neighbour's own edge.
    const word = before[1]!;

    const canvas = page.getByTestId("timeline-canvas");
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("timeline canvas has no box");

    // Default zoom is 30 ms/px, scroll 0 — the word lane sits at
    // y = 24 (ruler) + 64 (waveform) + 2 = 90, 28px tall, centre 104.
    const msPerPx = 30;
    const wordLaneTop = 90;
    const endX = box.x + word.e / msPerPx;
    const y = box.y + wordLaneTop + 14;

    await page.mouse.move(endX, y);
    await page.mouse.down();
    await page.mouse.move(endX - 200 / msPerPx, y, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(
        async () => {
          const after = await fetchWords(page, projectId);
          return after.find((w) => w.wid === word.wid)?.e;
        },
        { timeout: 10_000 },
      )
      .not.toBe(word.e);
  });

  test("dragging a proposed cut item's edge lands an EditPassItem op (B20b)", async ({
    page,
    sharedAccount,
  }) => {
    const projectId = await openSeededTimeline(page, sharedAccount, `B20b ${test.info().title}`);
    const itemId = await seedCutItem(page, projectId, { startMs: 10_000, endMs: 20_000 });

    // The pass merged directly through the internal write path, bypassing the
    // page's own realtime subscription — reload so the editor's initial
    // document fetch (which does carry `passes`) picks it up.
    await gotoHydrated(page, `/p/${projectId}`);
    await expect(page.getByTestId("editor-root")).toBeVisible({ timeout: 30_000 });

    const canvas = page.getByTestId("timeline-canvas");
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("timeline canvas has no box");

    // Default zoom is 30 ms/px, scroll 0 — the first (cuts) pass lane sits at
    // y = 24 (ruler) + 64+2 (waveform) + 28+2 (word lane) + 36+2 (segment
    // lane) = 158, 20px tall, so its centre is 168 (`Timeline.test.tsx`'s own
    // geometry comment derives the same number).
    const msPerPx = 30;
    const cutsLaneTop = 158;
    const endX = box.x + 20_000 / msPerPx;
    const y = box.y + cutsLaneTop + 10;

    await page.mouse.move(endX, y);
    await page.mouse.down();
    await page.mouse.move(endX + 3_000 / msPerPx, y, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(
        async () => {
          const items = await fetchPassItems(page, projectId);
          return items.find((item) => item.itemId === itemId)?.endMs;
        },
        { timeout: 10_000 },
      )
      .not.toBe(20_000);
  });

  test("Alt+Arrow nudges a selected word's edge by 10ms (100ms with Shift) (A02d)", async ({
    page,
    sharedAccount,
  }) => {
    const projectId = await openSeededTimeline(page, sharedAccount, `A02d ${test.info().title}`);
    const before = await fetchWords(page, projectId);
    test.skip(before.length < 3, "seeded project produced too few words");
    const word = before[1]!;

    const canvas = page.getByTestId("timeline-canvas");
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("timeline canvas has no box");
    const msPerPx = 30;
    const wordLaneTop = 90;
    const x = box.x + (word.s + word.e) / 2 / msPerPx;
    const y = box.y + wordLaneTop + 14;

    // A plain click selects the word (and seeks); the aria description is the
    // shared proof the timeline itself has `selectedWordId`, not just the
    // transcript column.
    await page.mouse.click(x, y);
    await expect(page.getByTestId("timeline-aria-description")).toContainText("Word selected", {
      timeout: 10_000,
    });
    await page.getByTestId("timeline-root").focus();
    // Shift+Alt+ArrowLeft (100ms): the fixture's word edges sit on their own
    // boundaries, so a bare 10ms nudge can snap straight back (40ms
    // tolerance, `lib/timeline/snapping.ts`) — 100ms always clears it.
    await page.keyboard.press("Shift+Alt+ArrowLeft");

    await expect
      .poll(
        async () => {
          const after = await fetchWords(page, projectId);
          return after.find((w) => w.wid === word.wid)?.e;
        },
        { timeout: 10_000 },
      )
      .not.toBe(word.e);
  });

  test("P toggles protection on the selected segment (B18b)", async ({ page, sharedAccount }) => {
    const projectId = await openSeededTimeline(page, sharedAccount, `B18b ${test.info().title}`);
    const before = await fetchSegments(page, projectId);
    test.skip(before.length === 0, "seeded project produced no segments");
    const segment = before[0]!;
    expect(await fetchProtectedRanges(page, projectId)).toEqual([]);

    await page.getByTestId(`segment-card-${segment.id}`).click();
    await expect(page.getByTestId("timeline-aria-description")).toContainText("Segment selected", {
      timeout: 10_000,
    });
    await page.getByTestId("timeline-root").focus();
    await page.keyboard.press("p");

    await expect
      .poll(async () => fetchProtectedRanges(page, projectId), { timeout: 10_000 })
      .toEqual([expect.objectContaining({ s: segment.startMs, e: segment.endMs, reason: "user" })]);

    // Pressing "P" again on the same, now fully-protected selection removes it.
    await page.keyboard.press("p");
    await expect
      .poll(async () => fetchProtectedRanges(page, projectId), { timeout: 10_000 })
      .toEqual([]);
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
