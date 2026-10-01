import { describe, expect, it } from "vitest";

import { PROJECT_TITLE_MAX } from "./repurpose.constants.js";
import {
  FORBIDDEN_USER_FACING_WORDS,
  NO_CANDIDATES_MESSAGE,
  STAGES,
  beginnerSafetyViolations,
  cleanSourceTitle,
  formatClock,
  isCancellable,
  isRetryable,
  messageForStatus,
  nextWindowAvailable,
  progressForStatus,
  projectRun,
  sourceProjectTitle,
  stageForStatus,
  windowView,
} from "./repurpose.projection.js";
import { projectTitleSchema } from "../projects/projects.dto.js";

import type { $Enums } from "@prisma/client";

/** Every run status, transcribed from the Prisma enum (master plan §4.2). */
const ALL_STATUSES = [
  "draft",
  "acquiring",
  "preparing_media",
  "transcribing",
  "analyzing",
  "candidates_ready",
  "materializing",
  "rendering",
  "review_ready",
  "changes_requested",
  "approved",
  "publishing",
  "partially_published",
  "published",
  "failed",
  "cancelled",
] as const satisfies readonly $Enums.RepurposeRunStatus[];

function run(overrides: Partial<Parameters<typeof projectRun>[0]> = {}) {
  return projectRun({
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    status: "draft",
    currentStage: "getting_video",
    failureCode: null,
    ...overrides,
  });
}

describe("every status is covered", () => {
  it("maps each one to a stage, a message and a progress value", () => {
    for (const status of ALL_STATUSES) {
      expect(STAGES, status).toContain(stageForStatus(status));
      expect(messageForStatus(status).length, status).toBeGreaterThan(0);
      const progress = progressForStatus(status);
      expect(progress, status).toBeGreaterThanOrEqual(0);
      expect(progress, status).toBeLessThanOrEqual(100);
    }
  });

  it("only lets a live run be cancelled", () => {
    for (const status of ["draft", "transcribing", "rendering", "publishing"] as const) {
      expect(isCancellable(status), status).toBe(true);
    }
    for (const status of ["published", "failed", "cancelled"] as const) {
      expect(isCancellable(status), status).toBe(false);
    }
  });

  it("only lets a failed run be retried", () => {
    expect(isRetryable("failed")).toBe(true);
    // A cancelled run is a decision, not an error; "try again" would be wrong.
    for (const status of ["cancelled", "published", "draft", "rendering"] as const) {
      expect(isRetryable(status), status).toBe(false);
    }
  });
});

describe("the stage rail", () => {
  it("always draws the five stages, in order, whatever the status", () => {
    for (const status of ALL_STATUSES) {
      const view = run({ status });
      expect(
        view.stages.map((stage) => stage.stage),
        status,
      ).toEqual([...STAGES]);
    }
  });

  it("marks earlier stages complete, the current one running and later ones waiting", () => {
    const view = run({ status: "rendering" });
    expect(view.currentStage).toBe("styles_formats");
    expect(view.stages.map((stage) => stage.state)).toEqual([
      "complete",
      "complete",
      "running",
      "waiting",
      "waiting",
    ]);
  });

  it("marks the stage that failed, and leaves the ones before it complete", () => {
    const view = run({ status: "failed", currentStage: "finding_clips", failureCode: "x/y" });
    expect(view.stages.map((stage) => stage.state)).toEqual([
      "complete",
      "failed",
      "waiting",
      "waiting",
      "waiting",
    ]);
    expect(view.canRetry).toBe(true);
  });

  it("keeps the stage a cancelled run stopped on, rather than resetting it", () => {
    // The status no longer says where the run was; the stored stage does.
    const view = run({ status: "cancelled", currentStage: "styles_formats" });
    expect(view.currentStage).toBe("styles_formats");
    expect(view.stages[2]?.state).toBe("running");
  });

  it("shows every stage complete once the run is published", () => {
    const view = run({ status: "published", currentStage: "publish" });
    expect(view.stages.every((stage) => stage.state === "complete")).toBe(true);
    expect(view.progress).toBe(100);
  });

  it("falls back to the status's stage when the stored one is nonsense", () => {
    const view = run({ status: "transcribing", currentStage: "not_a_stage" });
    expect(view.currentStage).toBe("finding_clips");
  });

  describe("progress", () => {
    it("derives from the status while the stored column is untouched", () => {
      // Nothing writes `progress` yet, so it sits at its default of 0 while the
      // status moves. Reading that 0 literally pinned the bar at the very start
      // through acquiring, preparing and transcribing, next to a rail that was
      // visibly advancing — two things on one screen disagreeing about one run.
      expect(
        run({ status: "acquiring", currentStage: "getting_video", progress: 0 }).progress,
      ).toBe(5);
      expect(
        run({ status: "transcribing", currentStage: "finding_clips", progress: 0 }).progress,
      ).toBe(30);
      expect(
        run({ status: "analyzing", currentStage: "finding_clips", progress: 0 }).progress,
      ).toBe(45);
    });

    it("prefers a real reported number over the status's coarse one", () => {
      // When a producer does report a finer-grained figure, it wins: that is the
      // whole reason the column exists.
      expect(
        run({ status: "acquiring", currentStage: "getting_video", progress: 12 }).progress,
      ).toBe(12);
    });

    it("still reads zero for a run that has not started", () => {
      expect(run({ status: "draft", currentStage: "getting_video", progress: 0 }).progress).toBe(0);
    });
  });
});

describe("what a person reads", () => {
  it("never contains a technical term, for any status", () => {
    for (const status of ALL_STATUSES) {
      const view = run({ status });
      for (const text of [view.message, ...view.stages.map((stage) => stage.label)]) {
        expect(beginnerSafetyViolations(text), `${status}: ${text}`).toEqual([]);
      }
    }
  });

  it("catches a technical term wherever it appears", () => {
    expect(beginnerSafetyViolations("The render queue failed")).toContain("queue");
    expect(beginnerSafetyViolations("Montaj could not start")).toContain("montaj");
    expect(beginnerSafetyViolations("Posting through Postiz")).toContain("postiz");
    expect(beginnerSafetyViolations("ffmpeg exited with code 1")).toContain("ffmpeg");
    expect(beginnerSafetyViolations("Getting your video")).toEqual([]);
  });

  it("guards the words the plan names", () => {
    for (const word of ["montaj", "postiz", "queue", "worker", "ffmpeg"]) {
      expect(FORBIDDEN_USER_FACING_WORDS).toContain(word);
    }
  });

  it("tells a failed run that the work is safe", () => {
    // §3.4: say what happened, and whether their work survived.
    expect(messageForStatus("failed").toLowerCase()).toContain("safe");
  });

  it("does not promise suggested moments to a run that has none", () => {
    // A manual run asks for none, and discovery can find none worth cutting;
    // "your suggested moments are ready" over an empty list read as broken.
    const empty = run({ status: "candidates_ready", candidateCount: 0 });
    expect(empty.message).toBe(NO_CANDIDATES_MESSAGE);
    expect(beginnerSafetyViolations(empty.message)).toEqual([]);

    expect(run({ status: "candidates_ready", candidateCount: 3 }).message).toBe(
      messageForStatus("candidates_ready"),
    );
    // Unknown (a realtime payload that did not count): the usual sentence.
    expect(run({ status: "candidates_ready" }).message).toBe(messageForStatus("candidates_ready"));
  });
});

describe("windows of a long source (2026-09-27)", () => {
  const LANDED = {
    windowStartMs: 730_000,
    windowEndMs: 1_930_000,
    windowPolicy: "most_replayed",
    sourceDurationMs: 2_077_000,
  };

  it("describes the section that landed, in the source's clock", () => {
    expect(windowView(LANDED)).toEqual({
      startMs: 730_000,
      endMs: 1_930_000,
      sourceDurationMs: 2_077_000,
      policy: "most_replayed",
    });
  });

  it("is null until the section lands, and for a source processed whole", () => {
    expect(windowView({ ...LANDED, windowEndMs: null })).toBeNull();
    expect(windowView({ windowStartMs: 600_000, windowPolicy: "range" })).toBeNull();
    expect(windowView({})).toBeNull();
  });

  it("reads numbers that describe no section as none", () => {
    expect(windowView({ ...LANDED, windowEndMs: 730_000 })).toBeNull();
    expect(windowView({ ...LANDED, windowStartMs: -1 })).toBeNull();
    expect(windowView({ ...LANDED, sourceDurationMs: 60_000 })).toBeNull();
  });

  it("names an unknown policy by what it must have been: the start", () => {
    expect(windowView({ ...LANDED, windowPolicy: "sideways" })?.policy).toBe("first");
  });

  it("offers the next window of a link with enough left after this one", () => {
    const link = { sourceKind: "youtube_url", sourceFingerprint: "youtube:dQw4w9WgXcQ" } as const;
    expect(nextWindowAvailable({ ...link, ...LANDED })).toBe(true);
    expect(nextWindowAvailable({ ...link, ...LANDED, windowEndMs: 2_077_000 - 29_000 })).toBe(
      false,
    );
    expect(nextWindowAvailable({ ...link, ...LANDED, windowEndMs: 2_077_000 - 30_000 })).toBe(true);
    expect(nextWindowAvailable({ ...link })).toBe(false);
    expect(nextWindowAvailable({ sourceKind: "upload", sourceFingerprint: null, ...LANDED })).toBe(
      false,
    ); // 2026-10-01: another video site's link is rebuilt from its fingerprint too.
    expect(
      nextWindowAvailable({
        sourceKind: "hosted_url",
        sourceFingerprint: "vimeo:76979871",
        ...LANDED,
      }),
    ).toBe(true);
    expect(
      nextWindowAvailable({ sourceKind: "hosted_url", sourceFingerprint: "vimeo:nope", ...LANDED }),
    ).toBe(false);
  });

  it("writes times the way the page does", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(730_000)).toBe("12:10");
    expect(formatClock(2_077_999)).toBe("34:37");
    expect(formatClock(3 * 3_600_000 + 5_000)).toBe("3:00:05");
  });
});

describe("the source project's real name (2026-09-27)", () => {
  it("is the title, and for a window which part of the video it is", () => {
    expect(sourceProjectTitle("A talk", null)).toBe("A talk");
    expect(sourceProjectTitle("A talk", { startMs: 730_000, endMs: 1_930_000 })).toBe(
      "A talk · 12:10–32:10",
    );
  });

  it("is never longer than a title the projects page accepts, and keeps the range whole", () => {
    const named = sourceProjectTitle("x".repeat(400), { startMs: 3_600_000, endMs: 7_200_000 });
    expect(named.length).toBeLessThanOrEqual(PROJECT_TITLE_MAX);
    expect(named.endsWith("… · 1:00:00–2:00:00")).toBe(true);
    expect(projectTitleSchema.safeParse(named).success).toBe(true);
  });

  it("never cuts an emoji in half", () => {
    const named = sourceProjectTitle("\u{1F399}".repeat(150), null);
    expect(named.length).toBeLessThanOrEqual(PROJECT_TITLE_MAX);
    const last = named.charCodeAt(named.length - 2);
    // The character before the ellipsis is a whole pair, never a lone high half.
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(named.endsWith("…")).toBe(true);
  });

  it("matches the projects page's own title limit", () => {
    expect(projectTitleSchema.safeParse("x".repeat(PROJECT_TITLE_MAX)).success).toBe(true);
    expect(projectTitleSchema.safeParse("x".repeat(PROJECT_TITLE_MAX + 1)).success).toBe(false);
  });

  it("cleans a remote title: no control characters, no runs of space, nothing empty", () => {
    expect(cleanSourceTitle("  A\u0000 talk\n\tpart   two ")).toBe("A talk part two");
    expect(cleanSourceTitle(" \u0007 ")).toBeNull();
    expect(cleanSourceTitle(null)).toBeNull();
    expect(cleanSourceTitle(undefined)).toBeNull();
  });
});
