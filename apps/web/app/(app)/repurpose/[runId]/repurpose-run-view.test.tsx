import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { RepurposeRunView } from "./repurpose-run-view";

import { renderWithProviders } from "@/test/harness";

/**
 * The resumable workspace (REP-007).
 *
 * The point of the route is that the run lives on the server: opening the URL
 * cold, with no state carried from the form, must show exactly where the run is.
 * These tests therefore never render the start form first — they mount the page
 * the way a refresh or a bookmark does.
 */

const RUN_ID = "01JS0000000000000000000RUN";

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    workspaceId: "01JWORKSPACE00000000000000",
    sourceProjectId: "01JPROJECT0000000000000000",
    sourceKind: "upload",
    sourceDisplay: null,
    mode: "ai",
    status: "transcribing",
    currentStage: "finding_clips",
    progress: 30,
    stages: [
      { stage: "getting_video", state: "complete", label: "Video added" },
      { stage: "finding_clips", state: "running", label: "Finding clips" },
      { stage: "styles_formats", state: "waiting", label: "Style formats" },
      { stage: "review", state: "waiting", label: "Review" },
      { stage: "publish", state: "waiting", label: "Publish" },
    ],
    message: "Creating the transcript.",
    failureCode: null,
    canCancel: true,
    canRetry: false,
    candidateCount: 0,
    clipCount: 0,
    variantCount: 0,
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:01:00.000Z",
    ...overrides,
  };
}

describe("<RepurposeRunView /> resuming a run", () => {
  it("renders the run's real position from the server, not from any local state", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [`/repurpose/runs/${RUN_ID}`]: run() },
    });

    expect(await screen.findByTestId("repurpose-run")).toBeInTheDocument();
    expect(screen.getByTestId("run-status")).toHaveTextContent("Creating the transcript.");
    expect(screen.getByTestId("stage-node-getting_video")).toHaveAttribute(
      "data-state",
      "complete",
    );
    expect(screen.getByTestId("stage-node-finding_clips")).toHaveAttribute("data-state", "running");
    expect(screen.getByTestId("stage-panel-finding_clips")).toBeInTheDocument();
  });

  it("offers a way to stop a run that is still moving", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [`/repurpose/runs/${RUN_ID}`]: run() },
    });
    expect(await screen.findByTestId("run-cancel")).toBeInTheDocument();
  });

  it("offers no stop button once the run has finished", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [`/repurpose/runs/${RUN_ID}`]: run({
          status: "published",
          currentStage: "publish",
          canCancel: false,
          progress: 100,
        }),
      },
    });
    expect(await screen.findByTestId("repurpose-run")).toBeInTheDocument();
    expect(screen.queryByTestId("run-cancel")).toBeNull();
  });

  it("shows the failure card with a support code, and no raw error", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [`/repurpose/runs/${RUN_ID}`]: run({
          status: "failed",
          currentStage: "getting_video",
          failureCode: "repurpose/source_unavailable",
          canCancel: false,
          canRetry: true,
          message: "Something went wrong. Your work is safe.",
        }),
      },
    });

    expect(await screen.findByTestId("stage-error")).toBeInTheDocument();
    expect(screen.getByText("We could not get that video")).toBeInTheDocument();
    expect(screen.getByTestId("support-code")).toHaveTextContent(RUN_ID);
    // The code itself is a support artefact, not something to read to a person.
    expect(screen.queryByText("repurpose/source_unavailable")).toBeNull();
  });

  it("treats a run it cannot see as simply not found", async () => {
    // The API answers 404 for another workspace's run on purpose; the UI must
    // not turn that into "you are not allowed", which would confirm it exists.
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, { routes: {} });

    expect(await screen.findByTestId("run-missing")).toBeInTheDocument();
    expect(screen.getByText("We could not find that video project")).toBeInTheDocument();
    expect(screen.queryByText(/permission|forbidden|not allowed/i)).toBeNull();
  });

  it("explains a stage the run has not reached instead of ignoring the click", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [`/repurpose/runs/${RUN_ID}`]: run() },
    });

    await screen.findByTestId("repurpose-run");
    await user.click(screen.getByTestId("stage-node-publish").querySelector("button")!);
    expect(screen.getByTestId("stage-blocked-note")).toHaveTextContent(/Publish opens once/);
  });

  it("opens a completed stage for review without changing the run", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [`/repurpose/runs/${RUN_ID}`]: run() },
    });

    await screen.findByTestId("repurpose-run");
    await user.click(screen.getByTestId("stage-node-getting_video").querySelector("button")!);
    expect(screen.getByTestId("stage-panel-getting_video")).toBeInTheDocument();
    // Still exactly where it was: opening a stage is a read.
    expect(screen.getByTestId("stage-node-finding_clips")).toHaveAttribute("data-state", "running");
  });
});
