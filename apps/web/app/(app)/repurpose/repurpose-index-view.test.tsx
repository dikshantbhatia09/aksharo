import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RepurposeRunView } from "@montaj/api-client";

import { RepurposeIndexView } from "./repurpose-index-view";

import { renderWithProviders } from "@/test/harness";

/**
 * `/repurpose`'s run list says what each run is doing (clips hardening,
 * 2026-09-26). It read "a stage projects as running" as "in progress", which
 * the API also says of a run the person stopped and of one waiting for them,
 * and a failed run's row said "Something went wrong".
 */
const ENTITLEMENT = {
  workspaceId: "01JWORKSPACE",
  planKey: "free",
  planName: "Free",
  creditsPerMonthTenths: 200,
  seatsIncluded: 1,
  seatsUsed: 1,
  computedAt: "2026-09-15T10:00:00.000Z",
  entitlements: { flags: { repurpose_flow: true } },
};

function run(id: string, status: string, overrides: Partial<RepurposeRunView> = {}): RepurposeRunView {
  return {
    id,
    workspaceId: "01JWORKSPACE",
    sourceProjectId: "01JPROJECT",
    sourceKind: "youtube_url",
    sourceDisplay: `youtube.com · ${id}`,
    mode: "ai",
    status,
    currentStage: "finding_clips",
    progress: 40,
    // What the API projects for any run that is neither failed nor published.
    stages: [
      { stage: "getting_video", state: "complete", label: "" },
      { stage: "finding_clips", state: "running", label: "" },
      { stage: "styles_formats", state: "waiting", label: "" },
      { stage: "review", state: "waiting", label: "" },
      { stage: "publish", state: "waiting", label: "" },
    ],
    message: "Something went wrong. Your work is safe.",
    failureCode: null,
    canCancel: false,
    canRetry: false,
    candidateCount: 0,
    clipCount: 0,
    variantCount: 0,
    createdAt: "2026-09-26T10:00:00.000Z",
    updatedAt: "2026-09-26T10:30:00.000Z",
    ...overrides,
  };
}

function renderList(items: readonly RepurposeRunView[]): void {
  renderWithProviders(<RepurposeIndexView />, {
    routes: {
      "/workspaces/01JWORKSPACE/entitlement": ENTITLEMENT,
      "/repurpose/runs": { items, nextCursor: null },
    },
  });
}

describe("<RepurposeIndexView /> run list", () => {
  it("names a failure and says it needs attention", async () => {
    renderList([
      run("01FAIL", "failed", { failureCode: "repurpose/source_too_long" }),
    ]);
    const row = await screen.findByTestId("repurpose-run-01FAIL");
    expect(row).toHaveTextContent("Needs attention · This video is longer than your plan allows");
    expect(row).not.toHaveTextContent("Something went wrong");
    expect(screen.queryByTestId("repurpose-live-run")).toBeNull();
  });

  it("does not call a stopped run, or one waiting for the person, in progress", async () => {
    renderList([
      run("01STOP", "cancelled", { message: "You stopped this run." }),
      run("01WAIT", "candidates_ready", { message: "Your suggested moments are ready." }),
    ]);
    expect(await screen.findByTestId("repurpose-run-01STOP")).not.toHaveTextContent("In progress");
    expect(screen.getByTestId("repurpose-run-01WAIT")).toHaveTextContent(
      "Waiting for you · Your suggested moments are ready.",
    );
    expect(screen.queryByTestId("repurpose-live-run")).toBeNull();
  });

  it("surfaces a run that is working at the top", async () => {
    renderList([run("01WORK", "transcribing", { message: "Creating the transcript." })]);
    expect(await screen.findByTestId("repurpose-live-run")).toHaveAttribute(
      "href",
      "/repurpose/01WORK",
    );
    expect(screen.getByTestId("repurpose-run-01WORK")).toHaveTextContent(
      "In progress · Creating the transcript.",
    );
  });
});
