import { describe, expect, it } from "vitest";

import {
  nextWindowOffer,
  nextWindowSpanMs,
  retryWindowOf,
  runFailureDetail,
  runPartLabel,
  runTitle,
  runWindowOf,
  windowPhase,
  windowSummary,
} from "./run-window";

/**
 * A plan limits the minutes a run processes (2026-09-27), so a long video's
 * run is about a part of it. These fields come from an API that may be older
 * than them, so every one is read as untrusted data.
 */
const MIN = 60_000;
const LENGTH = 34 * MIN + 37_000; // 34:37
const WINDOW = {
  startMs: 12 * MIN + 10_000,
  endMs: 32 * MIN + 10_000,
  sourceDurationMs: LENGTH,
  policy: "most_replayed",
};

const LINK_RUN = { sourceKind: "youtube_url", sourceDisplay: "youtube.com · dQw4w9WgXcQ" } as const;

/** A link run as the API sends it, with whatever `sourceTitle` it carries. */
function titled(sourceTitle: unknown): typeof LINK_RUN & { readonly sourceTitle: unknown } {
  return { ...LINK_RUN, sourceTitle };
}

describe("runTitle", () => {
  it("names the run by the video's real title", () => {
    expect(runTitle(titled("  How we ship  "))).toBe("How we ship");
  });

  it("falls back to the display, then to what kind of source it is", () => {
    expect(runTitle(titled(null))).toBe("youtube.com · dQw4w9WgXcQ");
    expect(runTitle(titled("   "))).toBe("youtube.com · dQw4w9WgXcQ");
    // An API older than the title sends no field at all.
    expect(runTitle(LINK_RUN)).toBe("youtube.com · dQw4w9WgXcQ");
    expect(runTitle({ sourceKind: "upload", sourceDisplay: null })).toBe("Your upload");
    expect(runTitle({ sourceKind: "youtube_url", sourceDisplay: null })).toBe("Your video");
    expect(runTitle({ sourceKind: "upload", sourceDisplay: null }, "A video")).toBe("A video");
  });
});

describe("runWindowOf and windowSummary", () => {
  it("says which part of the video the run processed, and why that part", () => {
    const part = runWindowOf({ window: WINDOW });
    expect(part).not.toBeNull();
    expect(windowSummary(part!)).toBe("Processed 12:10–32:10 of 34:37 (most replayed)");
    expect(windowSummary({ ...part!, policy: "first" })).toBe(
      "Processed 12:10–32:10 of 34:37 (from the start)",
    );
    expect(windowSummary({ ...part!, policy: "range" })).toBe(
      "Processed 12:10–32:10 of 34:37 (from where you chose)",
    );
    // A policy this build has never heard of is not shown as its code.
    expect(windowSummary({ ...part!, policy: "future_policy" })).toBe(
      "Processed 12:10–32:10 of 34:37",
    );
  });

  it("is nothing for the whole video, no window, or a malformed one", () => {
    expect(runWindowOf({ window: null })).toBeNull();
    expect(runWindowOf({})).toBeNull();
    expect(runWindowOf({ window: { ...WINDOW, startMs: 0, endMs: LENGTH } })).toBeNull();
    expect(runWindowOf({ window: { ...WINDOW, endMs: WINDOW.startMs } })).toBeNull();
    expect(runWindowOf({ window: { ...WINDOW, startMs: "12:10" } })).toBeNull();
    expect(runWindowOf({ window: { ...WINDOW, sourceDurationMs: 0 } })).toBeNull();
  });

  it("never says a window runs past the end of the video", () => {
    expect(runWindowOf({ window: { ...WINDOW, endMs: LENGTH + 5_000 } })?.endMs).toBe(LENGTH);
  });

  // "Processed 12:10–32:10" over a run still transcribing, or one that failed,
  // said something that had not happened.
  it("speaks of the part in the run's own tense", () => {
    const part = runWindowOf({ window: WINDOW })!;
    for (const status of ["acquiring", "preparing_media", "transcribing", "analyzing"]) {
      expect(windowPhase({ status })).toBe("working");
    }
    expect(windowSummary(part, windowPhase({ status: "transcribing" }))).toBe(
      "Processing 12:10–32:10 of 34:37 (most replayed)",
    );
    for (const status of ["failed", "cancelled"]) expect(windowPhase({ status })).toBe("stopped");
    expect(windowSummary(part, windowPhase({ status: "failed" }))).toBe(
      "Part 12:10–32:10 of 34:37 (most replayed)",
    );
    for (const status of ["candidates_ready", "review_ready", "published"]) {
      expect(windowPhase({ status })).toBe("done");
    }
    expect(windowSummary(part, windowPhase({ status: "candidates_ready" }))).toBe(
      "Processed 12:10–32:10 of 34:37 (most replayed)",
    );
  });
});

describe("runPartLabel", () => {
  // Two parts of one podcast share its title: the part tells the rows apart.
  it("names the part a run covers, and nothing for a whole video", () => {
    expect(runPartLabel({ window: WINDOW })).toBe("Part 12:10–32:10");
    expect(runPartLabel({ window: { ...WINDOW, startMs: 32 * MIN + 10_000, endMs: LENGTH } })).toBe(
      "Part 32:10–34:37",
    );
    expect(runPartLabel({ window: null })).toBeNull();
    expect(runPartLabel({})).toBeNull();
  });
});

describe("the next part", () => {
  /** A run at `status` carrying `fields`, the rest of the run view left out. */
  const at = (status: string, fields: object): { readonly status: string } => ({
    status,
    ...fields,
  });
  const early = { ...WINDOW, startMs: 0, endMs: 10 * MIN, sourceDurationMs: 3 * 60 * MIN };
  const ready = (fields: object): { readonly status: string } => at("candidates_ready", fields);

  it("offers as much again as this run processed, when the plan's window is not known", () => {
    expect(nextWindowOffer(ready({ window: early, nextWindowAvailable: true }))).toEqual({
      label: "Process the next 10 minutes",
    });
  });

  // This run's own length can be stale: the plan changed since, or the
  // balance cut this run short.
  it("promises the plan's window when it is known", () => {
    const run = ready({ window: early, nextWindowAvailable: true });
    expect(nextWindowOffer(run, 20 * MIN)).toEqual({ label: "Process the next 20 minutes" });
    expect(nextWindowOffer(run, 5 * MIN)).toEqual({ label: "Process the next 5 minutes" });
  });

  it("never promises more than the video has left", () => {
    // 34:37 − 32:10 = 2:27 left.
    expect(nextWindowSpanMs(runWindowOf({ window: WINDOW })!)).toBe(2 * MIN + 27_000);
    expect(nextWindowSpanMs(runWindowOf({ window: WINDOW })!, 20 * MIN)).toBe(2 * MIN + 27_000);
    expect(nextWindowOffer(ready({ window: WINDOW, nextWindowAvailable: true }))).toEqual({
      label: "Process the next 2 minutes",
    });
  });

  it("offers nothing unless the run says there is a next part", () => {
    expect(nextWindowOffer(ready({ window: WINDOW, nextWindowAvailable: false }))).toBeNull();
    expect(nextWindowOffer(ready({ window: WINDOW }))).toBeNull();
    expect(nextWindowOffer(ready({ window: null, nextWindowAvailable: true }))).toBeNull();
  });

  // The API says there is a next part as soon as this run's section lands.
  // Started then, a second run of the same video competes with this one for
  // the one download at a time and the plan's job slots.
  it("waits until this run has its moments, or has stopped", () => {
    const fields = { window: WINDOW, nextWindowAvailable: true };
    for (const status of ["acquiring", "preparing_media", "transcribing", "analyzing"]) {
      expect(nextWindowOffer(at(status, fields))).toBeNull();
    }
    for (const status of ["candidates_ready", "failed", "cancelled", "published"]) {
      expect(nextWindowOffer(at(status, fields))).not.toBeNull();
    }
  });
});

describe("retryWindowOf", () => {
  // The API's retry re-uses the run's own request: a picked start stays that
  // start, so the card must not call it "the most-replayed part".
  it("knows a picked start from the part that landed, or from this browser's memory", () => {
    expect(retryWindowOf({ window: { ...WINDOW, policy: "range" } }, undefined)).toEqual({
      kind: "range",
      startMs: WINDOW.startMs,
    });
    expect(retryWindowOf({ window: null }, { startMs: 5 * MIN })).toEqual({
      kind: "range",
      startMs: 5 * MIN,
    });
  });

  it("knows the automatic choice only when it can tell there was no picked start", () => {
    expect(retryWindowOf({ window: null }, {})).toEqual({ kind: "auto" });
    expect(retryWindowOf({ window: WINDOW }, undefined)).toEqual({ kind: "auto" });
    // A run from another browser that failed before its part landed.
    expect(retryWindowOf({ window: null }, undefined)).toEqual({ kind: "unknown" });
    expect(retryWindowOf({}, undefined)).toEqual({ kind: "unknown" });
  });
});

describe("runFailureDetail", () => {
  it("reads the numbers, and nothing from an API that sends none", () => {
    expect(runFailureDetail({ failureDetail: { durationMs: LENGTH, windowMs: 20 * MIN } })).toEqual(
      {
        durationMs: LENGTH,
        windowMs: 20 * MIN,
      },
    );
    expect(runFailureDetail({})).toBeNull();
    expect(runFailureDetail({ failureDetail: null })).toBeNull();
  });
});
