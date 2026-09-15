import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_USER_FACING_WORDS,
  STAGES,
  beginnerSafetyViolations,
  isCancellable,
  isRetryable,
  messageForStatus,
  progressForStatus,
  projectRun,
  stageForStatus,
} from "./repurpose.projection.js";

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
      expect(view.stages.map((stage) => stage.stage), status).toEqual([...STAGES]);
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
      expect(run({ status: "acquiring", currentStage: "getting_video", progress: 0 }).progress).toBe(
        5,
      );
      expect(
        run({ status: "transcribing", currentStage: "finding_clips", progress: 0 }).progress,
      ).toBe(30);
      expect(run({ status: "analyzing", currentStage: "finding_clips", progress: 0 }).progress).toBe(
        45,
      );
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
});
