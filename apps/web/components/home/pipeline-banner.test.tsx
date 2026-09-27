import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RepurposeRunView } from "@montaj/api-client";

import { bannerRun, PipelineBanner } from "./pipeline-banner";

import { renderWithProviders } from "@/test/harness";

/**
 * Home's one line about the clips pipeline (clips hardening, 2026-09-26). It
 * reported any run whose current stage projected as `running` — which is also a
 * run the person stopped, and one sitting at "ready to review" for a week — so
 * an old run hid a fresh failure, and a failure itself was never reported.
 */
const NOW = Date.parse("2026-09-26T12:00:00.000Z");

/**
 * The fields the API adds with plan limits (2026-09-27), as a run that has
 * none of them: spread in, so these fixtures compile whether the client's
 * `RepurposeRunView` declares them yet or not.
 */
const NO_PLAN_LIMIT_FACTS = {
  sourceTitle: null,
  window: null,
  failureDetail: null,
  nextWindowAvailable: false,
};

function run(id: string, status: string, overrides: Partial<RepurposeRunView> = {}): RepurposeRunView {
  return {
    ...NO_PLAN_LIMIT_FACTS,
    id,
    workspaceId: "01JWORKSPACE",
    sourceProjectId: "01JPROJECT",
    sourceKind: "youtube_url",
    sourceDisplay: `youtube.com · ${id}`,
    mode: "ai",
    status,
    currentStage: "getting_video",
    progress: 20,
    stages: [
      { stage: "getting_video", state: status === "failed" ? "failed" : "running", label: "" },
      { stage: "finding_clips", state: "waiting", label: "" },
      { stage: "styles_formats", state: "waiting", label: "" },
      { stage: "review", state: "waiting", label: "" },
      { stage: "publish", state: "waiting", label: "" },
    ],
    message: "Getting your video.",
    failureCode: null,
    canCancel: status !== "failed",
    canRetry: status === "failed",
    candidateCount: 0,
    clipCount: 0,
    variantCount: 0,
    createdAt: "2026-09-26T11:00:00.000Z",
    updatedAt: "2026-09-26T11:30:00.000Z",
    ...overrides,
  };
}

describe("bannerRun", () => {
  it("reports the newest run's recent failure first", () => {
    const failed = run("01NEW", "failed", { failureCode: "repurpose/source_too_large" });
    expect(bannerRun([failed, run("01OLD", "review_ready")], NOW)).toEqual({
      run: failed,
      kind: "failed",
    });
  });

  it("lets a day-old failure go, in favour of a run that is working", () => {
    const old = run("01NEW", "failed", { updatedAt: "2026-09-24T11:00:00.000Z" });
    const working = run("01WORK", "transcribing");
    expect(bannerRun([old, working], NOW)).toEqual({ run: working, kind: "working" });
  });

  it("prefers a working run over one waiting for the person", () => {
    const waiting = run("01WAIT", "candidates_ready");
    const working = run("01WORK", "acquiring");
    expect(bannerRun([waiting, working], NOW)?.run.id).toBe("01WORK");
    expect(bannerRun([waiting], NOW)).toEqual({ run: waiting, kind: "needs_you" });
  });

  it("never reports a stopped or finished run as in progress", () => {
    expect(bannerRun([run("01STOP", "cancelled"), run("01DONE", "published")], NOW)).toBeUndefined();
  });

  // An upload run whose file never arrived stays `draft`, and it was picked as
  // "working" ahead of a newer run that was ready to review — at 0%, for good.
  it("ranks an upload still waiting for its file below a run waiting for the person", () => {
    const stuck = run("01DRAFT", "draft", {
      sourceKind: "upload",
      sourceDisplay: null,
      progress: 0,
    });
    const review = run("01REVIEW", "review_ready");
    expect(bannerRun([stuck, review], NOW)).toEqual({ run: review, kind: "needs_you" });
    // Real work still comes first.
    const working = run("01WORK", "transcribing");
    expect(bannerRun([stuck, review, working], NOW)).toEqual({ run: working, kind: "working" });
    // Alone, it is still worth a line, but never as work in progress.
    expect(bannerRun([stuck], NOW)).toEqual({ run: stuck, kind: "awaiting_video" });
  });
});

describe("<PipelineBanner /> with an upload that has not arrived", () => {
  it("says so, with no stage number and no progress bar", async () => {
    renderWithProviders(<PipelineBanner />, {
      routes: {
        "/workspaces/01JWORKSPACE/entitlement": {
          workspaceId: "01JWORKSPACE",
          planKey: "free",
          planName: "Free",
          creditsPerMonthTenths: 200,
          seatsIncluded: 1,
          seatsUsed: 1,
          computedAt: "2026-09-15T10:00:00.000Z",
          entitlements: { flags: { repurpose_flow: true } },
        },
        "/repurpose/runs": {
          items: [
            run("01DRAFT", "draft", {
              sourceKind: "upload",
              sourceDisplay: null,
              progress: 0,
              message: "Add a video to get started.",
            }),
          ],
          nextCursor: null,
        },
      },
    });

    const line = await screen.findByTestId("pipeline-live");
    expect(line).toHaveAttribute("data-kind", "awaiting_video");
    expect(line).toHaveTextContent("Your upload has not arrived yet.");
    expect(line).not.toHaveTextContent(/stage 1 of 5/);
    expect(line.querySelector(".bg-accent")).toBeNull();
  });
});

describe("<PipelineBanner /> with a failed run", () => {
  it("says the run needs attention and why, with no progress bar", async () => {
    renderWithProviders(<PipelineBanner />, {
      routes: {
        "/workspaces/01JWORKSPACE/entitlement": {
          workspaceId: "01JWORKSPACE",
          planKey: "free",
          planName: "Free",
          creditsPerMonthTenths: 200,
          seatsIncluded: 1,
          seatsUsed: 1,
          computedAt: "2026-09-15T10:00:00.000Z",
          entitlements: { flags: { repurpose_flow: true } },
        },
        "/repurpose/runs": {
          items: [
            run("01FAIL", "failed", {
              failureCode: "repurpose/source_blocked",
              updatedAt: new Date().toISOString(),
            }),
          ],
          nextCursor: null,
        },
      },
    });

    const line = await screen.findByTestId("pipeline-live");
    expect(line).toHaveAttribute("data-kind", "failed");
    expect(line).toHaveTextContent("needs attention: YouTube is refusing our server for a few minutes.");
    expect(line).not.toHaveTextContent(/stage 1 of 5/);
    expect(screen.getByTestId("pipeline-stage-getting_video")).toHaveAttribute("data-state", "failed");
    expect(screen.getByTestId("pipeline-stage-getting_video")).toHaveTextContent("(needs attention)");
  });
});

// "youtube.com · aDpIra7NFuE" named nothing a person would recognise; the API
// now sends the video's real title (2026-09-27).
describe("<PipelineBanner /> names the run by its video's title", () => {
  it("uses the real title, and the display where there is none", async () => {
    renderWithProviders(<PipelineBanner />, {
      routes: {
        "/workspaces/01JWORKSPACE/entitlement": {
          workspaceId: "01JWORKSPACE",
          planKey: "free",
          planName: "Free",
          creditsPerMonthTenths: 200,
          seatsIncluded: 1,
          seatsUsed: 1,
          computedAt: "2026-09-15T10:00:00.000Z",
          entitlements: { flags: { repurpose_flow: true } },
        },
        "/repurpose/runs": {
          items: [{ ...run("01WORK", "transcribing"), sourceTitle: "How we ship every day" }],
          nextCursor: null,
        },
      },
    });

    const line = await screen.findByTestId("pipeline-live");
    expect(line).toHaveTextContent("How we ship every day is at stage 1 of 5");
    expect(line).not.toHaveTextContent("youtube.com");
  });

  it("says which part of a long video the run is about", async () => {
    renderWithProviders(<PipelineBanner />, {
      routes: {
        "/workspaces/01JWORKSPACE/entitlement": {
          workspaceId: "01JWORKSPACE",
          planKey: "free",
          planName: "Free",
          creditsPerMonthTenths: 200,
          seatsIncluded: 1,
          seatsUsed: 1,
          computedAt: "2026-09-15T10:00:00.000Z",
          entitlements: { flags: { repurpose_flow: true } },
        },
        "/repurpose/runs": {
          items: [
            {
              ...run("01WORK", "transcribing"),
              sourceTitle: "A three-hour podcast",
              window: {
                startMs: 20 * 60_000,
                endMs: 40 * 60_000,
                sourceDurationMs: 180 * 60_000,
                policy: "range",
              },
            },
          ],
          nextCursor: null,
        },
      },
    });

    expect(await screen.findByTestId("pipeline-live")).toHaveTextContent(
      "A three-hour podcast (Part 20:00–40:00) is at stage 1 of 5",
    );
  });
});
