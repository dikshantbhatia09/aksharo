import { describe, expect, it } from "vitest";

import { ApiError } from "./errors.js";
import {
  CLIP_URL_REFRESH_MS,
  RENDER_PREVIEW_STALE_MS,
  candidatesPollDelay,
  clipsPollDelay,
  clipsStillMoving,
  renderPreviewPollDelay,
  runListPollDelay,
} from "./hooks.js";

import type { ProjectRenderPreview, RepurposeClipItem } from "./types.js";

/**
 * The clips pipeline's polls (clips hardening, 2026-09-26). Each one used to be
 * wrong in one direction: the candidate list and the run list never polled, so a
 * missed realtime event left "your moments are ready" over an empty list; the
 * clip list polled every 3 s for ever, restarting any preview that was playing.
 */

function clip(overrides: Partial<RepurposeClipItem> = {}): RepurposeClipItem {
  return { id: "01CLIP", candidateId: "01CAND", mezzanineKey: null, ...overrides };
}

describe("clipsStillMoving", () => {
  it("keeps polling while a clip waits for a slot or is being cut", () => {
    expect(clipsStillMoving([clip({ state: "waiting" })])).toBe(true);
    expect(clipsStillMoving([clip({ state: "cutting" })])).toBe(true);
  });

  it("stops once every clip is ready or failed", () => {
    expect(
      clipsStillMoving([clip({ state: "ready", mezzanineKey: "k" }), clip({ state: "failed" })]),
    ).toBe(false);
    expect(clipsStillMoving([])).toBe(false);
  });

  it("reads an API older than `state` by whether the picture exists", () => {
    expect(clipsStillMoving([clip()])).toBe(true);
    expect(clipsStillMoving([clip({ mezzanineKey: "ws/x/master.mp4" })])).toBe(false);
  });

  // A cancelled run's waiting clip never starts (the API does not enqueue for a
  // stopped run), so polling for it every 3 s lasted as long as the tab did. A
  // cut already in flight is left to finish, and that is still worth watching.
  it("does not wait on a waiting clip of a stopped run, only on a cut in flight", () => {
    expect(clipsStillMoving([clip({ state: "waiting" })], { waitingStarts: false })).toBe(false);
    expect(clipsStillMoving([clip({ state: "cutting" })], { waitingStarts: false })).toBe(true);
  });
});

describe("clipsPollDelay", () => {
  const readyClip = clip({
    state: "ready",
    mezzanineKey: "ws/x/master.mp4",
    mezzanineUrl: "https://media.test/master.mp4?X-Amz-Expires=3600",
  });

  it("polls quickly while a clip is moving", () => {
    expect(clipsPollDelay([clip({ state: "cutting" }), readyClip], {}, 3_000)).toBe(3_000);
  });

  // Settled, the list stopped polling altogether, so a page left open past the
  // hour its URLs are signed for served every poster and download as a 403.
  it("keeps a settled list's URLs fresh with a slow refresh inside their hour", () => {
    expect(clipsPollDelay([readyClip], {}, 3_000)).toBe(CLIP_URL_REFRESH_MS);
    expect(CLIP_URL_REFRESH_MS).toBeLessThan(45 * 60_000);
    expect(
      clipsPollDelay([readyClip, clip({ state: "waiting" })], { waitingStarts: false }, 3_000),
    ).toBe(CLIP_URL_REFRESH_MS);
  });

  it("costs nothing when no clip has a URL to keep fresh", () => {
    expect(clipsPollDelay([], {}, 3_000)).toBe(false);
    expect(clipsPollDelay([clip({ state: "failed" })], {}, 3_000)).toBe(false);
  });
});

describe("candidatesPollDelay", () => {
  it("polls while discovery is under way", () => {
    expect(candidatesPollDelay({ poll: true }, 0, 5_000)).toBe(5_000);
  });

  it("polls until the list holds as many moments as the run says it has", () => {
    expect(candidatesPollDelay({ expectedCount: 3 }, 0, 5_000)).toBe(5_000);
    expect(candidatesPollDelay({ expectedCount: 3 }, 3, 5_000)).toBe(false);
  });

  it("costs nothing on a settled run", () => {
    expect(candidatesPollDelay({}, 0, 5_000)).toBe(false);
    expect(candidatesPollDelay({ poll: false, expectedCount: 0 }, 0, 5_000)).toBe(false);
  });
});

describe("runListPollDelay", () => {
  it("re-reads the list while a run moves on its own", () => {
    expect(runListPollDelay([{ status: "review_ready" }, { status: "acquiring" }])).toBe(20_000);
  });

  it("does not poll for runs that are waiting on the person, or finished", () => {
    expect(
      runListPollDelay([
        { status: "candidates_ready" },
        { status: "failed" },
        { status: "cancelled" },
      ]),
    ).toBe(false);
  });
});

describe("renderPreviewPollDelay", () => {
  const ready: ProjectRenderPreview = {
    proxyUrl: "https://media.test/proxy.mp4",
    facesUrl: "https://media.test/faces.json",
    projection: { canvas: { width: 1080, height: 1920 } },
  };
  const state = (
    overrides: Partial<Parameters<typeof renderPreviewPollDelay>[0]> = {},
  ): Parameters<typeof renderPreviewPollDelay>[0] => ({
    data: undefined,
    error: null,
    dataUpdateCount: 1,
    errorUpdateCount: 0,
    ...overrides,
  });

  it("waits out a clip whose proxy does not exist yet (409)", () => {
    const notYet = new ApiError({ status: 409, code: "media/not_ready", message: "x" });
    expect(renderPreviewPollDelay(state({ error: notYet }), 10_000)).toBe(10_000);
  });

  it("treats any other error as final", () => {
    const gone = new ApiError({ status: 404, code: "common/not_found", message: "x" });
    expect(renderPreviewPollDelay(state({ error: gone }), 10_000)).toBe(false);
  });

  it("keeps asking until the document and the face track have both arrived", () => {
    expect(renderPreviewPollDelay(state({ data: { ...ready, projection: null } }), 10_000)).toBe(
      10_000,
    );
    const { facesUrl: _faces, ...noFaces } = ready;
    expect(renderPreviewPollDelay(state({ data: noFaces }), 10_000)).toBe(10_000);
    expect(renderPreviewPollDelay(state({ data: ready }), 10_000)).toBe(false);
  });

  it("gives up after a bounded number of tries: a video with no faces never gets a track", () => {
    const { facesUrl: _faces, ...noFaces } = ready;
    expect(renderPreviewPollDelay(state({ data: noFaces, dataUpdateCount: 30 }), 10_000)).toBe(
      false,
    );
  });

  // Every ready clip on a run page used to wait out its face track, and each
  // poll rebuilds the projection on the server. Only the clip being played
  // draws with the track; the rest only need to know they can be styled.
  it("waits for the face track only when asked to, but always for the proxy and document", () => {
    const { facesUrl: _faces, ...noFaces } = ready;
    expect(renderPreviewPollDelay(state({ data: noFaces }), 10_000, { wantFaces: false })).toBe(
      false,
    );
    expect(
      renderPreviewPollDelay(state({ data: { ...noFaces, projection: null } }), 10_000, {
        wantFaces: false,
      }),
    ).toBe(10_000);
    const notYet = new ApiError({ status: 409, code: "media/not_ready", message: "x" });
    expect(renderPreviewPollDelay(state({ error: notYet }), 10_000, { wantFaces: false })).toBe(
      10_000,
    );
  });

  it("trusts a preview for less time than its URLs are signed for (5 minutes)", () => {
    expect(RENDER_PREVIEW_STALE_MS).toBeLessThan(5 * 60_000);
  });
});
