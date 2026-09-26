import { describe, expect, it } from "vitest";

import type { RepurposeStage } from "@montaj/api-client";

import { canAddMoments, runActivity, serverIsWorking } from "./run-activity";

describe("runActivity", () => {
  it("separates work in progress from a run waiting on the person", () => {
    for (const status of ["draft", "acquiring", "transcribing", "analyzing", "materializing"]) {
      expect(runActivity({ status }), status).toBe("working");
    }
    for (const status of ["candidates_ready", "review_ready", "approved"]) {
      expect(runActivity({ status }), status).toBe("needs_you");
    }
  });

  it("never calls a stopped, failed or finished run 'working'", () => {
    expect(runActivity({ status: "failed" })).toBe("failed");
    expect(runActivity({ status: "cancelled" })).toBe("stopped");
    expect(runActivity({ status: "published" })).toBe("done");
  });
});

describe("serverIsWorking", () => {
  it("is true only while the server moves the run, never for a draft waiting on its upload", () => {
    for (const status of [
      "acquiring",
      "preparing_media",
      "transcribing",
      "analyzing",
      "materializing",
    ]) {
      expect(serverIsWorking({ status }), status).toBe(true);
    }
    // Nothing on the server moves a draft: it waits for a file that may never come.
    expect(serverIsWorking({ status: "draft" })).toBe(false);
    for (const status of ["candidates_ready", "failed", "cancelled", "published"]) {
      expect(serverIsWorking({ status }), status).toBe(false);
    }
  });
});

describe("canAddMoments", () => {
  const at = (
    status: string,
    failureCode: string | null = null,
    currentStage: RepurposeStage = "finding_clips",
  ) => canAddMoments({ status, failureCode, currentStage });

  it("allows moments by time once the transcript exists", () => {
    expect(at("transcribing")).toBe(false);
    expect(at("analyzing")).toBe(true);
    expect(at("candidates_ready")).toBe(true);
    expect(at("review_ready")).toBe(true);
  });

  it("still allows them on a run that failed after its transcript", () => {
    expect(at("failed", "repurpose/highlights_failed")).toBe(true);
    // What the API wrote for the same failure before 2026-09-26.
    expect(at("failed", "repurpose/analysis_failed")).toBe(true);
    expect(at("failed", "repurpose/highlights_no_candidates")).toBe(true);
  });

  // The API accepts a moment on a run whose discovery timed out, but the page
  // offered no form for it: the two lists of "failed after the transcript" had
  // drifted apart.
  it("allows them after a timeout in finding moments, as the API does", () => {
    expect(at("failed", "repurpose/stage_timeout", "finding_clips")).toBe(true);
    expect(at("failed", "repurpose/stage_timeout", "getting_video")).toBe(false);
  });

  it("refuses them on a run that failed before there was anything to pick from", () => {
    expect(at("failed", "repurpose/source_too_large")).toBe(false);
    expect(at("failed", "repurpose/transcription_failed")).toBe(false);
    expect(at("cancelled")).toBe(false);
  });

  // It used to allow any failed run that had candidates, whatever the failure;
  // the API refuses those outside its list, and the page then blamed a
  // transcript that was not the reason.
  it("does not let having candidates stand in for a failure the API accepts", () => {
    const run = {
      status: "failed",
      failureCode: "repurpose/processing_failed",
      currentStage: "finding_clips" as const,
      candidateCount: 3,
    };
    expect(canAddMoments(run)).toBe(false);
  });
});
