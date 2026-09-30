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

function run(
  id: string,
  status: string,
  overrides: Partial<RepurposeRunView> = {},
): RepurposeRunView {
  return {
    ...NO_PLAN_LIMIT_FACTS,
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
    renderList([run("01FAIL", "failed", { failureCode: "repurpose/source_too_long" })]);
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

  // An upload run whose file never arrived stays `draft`; it sat on top as
  // "In progress" with nothing on the server moving it.
  it("does not call an upload still waiting for its file in progress", async () => {
    renderList([
      run("01DRAFT", "draft", {
        sourceKind: "upload",
        sourceDisplay: null,
        currentStage: "getting_video",
        message: "Add a video to get started.",
      }),
    ]);
    const row = await screen.findByTestId("repurpose-run-01DRAFT");
    expect(row).toHaveTextContent("Waiting for its video · Add a video to get started.");
    expect(row).not.toHaveTextContent("In progress");
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

describe("<RepurposeIndexView /> names each run by its video's title", () => {
  it("uses the real title, and the display for a run the API has none for", async () => {
    // Added on top of the typed view: an API older than titles has no such field.
    const titled = Object.assign(run("01TITLED", "candidates_ready"), {
      sourceTitle: "How we ship every day",
    });
    renderList([titled, run("01PLAIN", "candidates_ready")]);
    expect(await screen.findByTestId("repurpose-run-title-01TITLED")).toHaveTextContent(
      "How we ship every day",
    );
    expect(screen.getByTestId("repurpose-run-title-01PLAIN")).toHaveTextContent(
      "youtube.com · 01PLAIN",
    );
  });

  // "Process the next 20 minutes" makes runs that share a title: each row
  // says which part it is, or two parts of one podcast read as one run twice.
  it("tells two parts of one video apart by the part each covers", async () => {
    const MIN = 60_000;
    const part = (id: string, startMs: number): RepurposeRunView =>
      run(id, "candidates_ready", {
        sourceTitle: "A three-hour podcast",
        window: {
          startMs,
          endMs: startMs + 20 * MIN,
          sourceDurationMs: 180 * MIN,
          policy: "range",
        },
      });
    renderList([part("01PART2", 20 * MIN), part("01PART1", 0), run("01WHOLE", "candidates_ready")]);

    expect(await screen.findByTestId("repurpose-run-part-01PART2")).toHaveTextContent(
      "Part 20:00–40:00",
    );
    expect(screen.getByTestId("repurpose-run-part-01PART1")).toHaveTextContent("Part 0:00–20:00");
    // A whole video is not "part" of anything.
    expect(screen.queryByTestId("repurpose-run-part-01WHOLE")).toBeNull();
  });
});

describe("the way in to What works (2026-10-05)", () => {
  function renderWith(flags: Record<string, boolean>): void {
    renderWithProviders(<RepurposeIndexView />, {
      routes: {
        "/workspaces/01JWORKSPACE/entitlement": { ...ENTITLEMENT, entitlements: { flags } },
        "/repurpose/runs": { items: [], nextCursor: null },
      },
    });
  }

  it("is offered while it is on", async () => {
    renderWith({ repurpose_flow: true, repurpose_performance: true });
    expect(await screen.findByTestId("repurpose-what-works-link")).toHaveAttribute(
      "href",
      "/repurpose/what-works",
    );
    expect(screen.queryByTestId("repurpose-automations-link")).toBeNull();
  });

  it("is not offered while it is off", async () => {
    renderWith({ repurpose_flow: true });
    expect(await screen.findByTestId("repurpose-index")).toBeInTheDocument();
    expect(screen.queryByTestId("repurpose-what-works-link")).toBeNull();
  });
});
