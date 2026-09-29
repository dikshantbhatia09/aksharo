import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepurposeRunView } from "./repurpose-run-view";

import { recallRunSetup, rememberRunSetup } from "@/components/repurpose/run-setup";
import { RECOMMENDED_STYLES } from "@/components/repurpose/SourceStartForm";
import { renderWithProviders } from "@/test/harness";
import { routerMock } from "@/test/next-router";

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

  it("says when Autopilot is doing the picking, and not otherwise", async () => {
    const auto = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [`/repurpose/runs/${RUN_ID}`]: run({ automation: "auto" }) },
    });
    expect(await screen.findByTestId("run-autopilot")).toHaveTextContent(/Autopilot is on/);
    auto.unmount();

    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [`/repurpose/runs/${RUN_ID}`]: run({ automation: "manual" }) },
    });
    expect(await screen.findByTestId("repurpose-run")).toBeInTheDocument();
    expect(screen.queryByTestId("run-autopilot")).toBeNull();
  });

  it("says which step the run is on, in numbers, and how long it has left (2026-09-29)", async () => {
    // The owner's report: "5% complete" while a 5 GB download was at 67%.
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [`/repurpose/runs/${RUN_ID}`]: run({
          sourceKind: "youtube_url",
          status: "acquiring",
          currentStage: "getting_video",
          progress: 11,
          stages: [
            { stage: "getting_video", state: "running", label: "Getting your video" },
            { stage: "finding_clips", state: "waiting", label: "Find clips" },
            { stage: "styles_formats", state: "waiting", label: "Style formats" },
            { stage: "review", state: "waiting", label: "Review" },
            { stage: "publish", state: "waiting", label: "Publish" },
          ],
          message: "Getting your video.",
          activity: {
            step: "downloading",
            label: "Downloading your video",
            percent: 67,
            detail: "3.4 of 5.0 GB",
            etaSeconds: 125,
          },
        }),
      },
    });

    const line = await screen.findByTestId("run-activity");
    expect(
      within(screen.getByTestId("stage-panel-getting_video")).getByTestId("run-activity"),
    ).toBe(line);
    expect(screen.getByTestId("run-activity-text")).toHaveTextContent(
      "Downloading your video · 3.4 of 5.0 GB · about 2 min left",
    );
    expect(within(line).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "67");
    // The whole run's bar, and the same step beside it.
    expect(screen.getByTestId("preview-progress")).toHaveTextContent("11% complete");
    expect(screen.getByTestId("preview-activity")).toHaveTextContent(
      "Downloading your video · about 2 min left",
    );
  });

  it("shows no step line for a run that has stopped, or once everything is done", async () => {
    const stopped = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [`/repurpose/runs/${RUN_ID}`]: run({
          status: "failed",
          currentStage: "getting_video",
          failureCode: "repurpose/source_unavailable",
          canCancel: false,
          canRetry: true,
          activity: null,
        }),
      },
    });
    expect(await screen.findByTestId("stage-error")).toBeInTheDocument();
    expect(screen.queryByTestId("run-activity")).toBeNull();
    stopped.unmount();

    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [`/repurpose/runs/${RUN_ID}`]: run({
          status: "review_ready",
          currentStage: "review",
          activity: { step: "done", label: "All done" },
        }),
      },
    });
    expect(await screen.findByTestId("preview-activity")).toHaveTextContent("All done");
    expect(screen.queryByTestId("run-activity")).toBeNull();
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

    const card = await screen.findByTestId("stage-error");
    expect(within(card).getByText("We could not get that video")).toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// Clips hardening (2026-09-26)
// ---------------------------------------------------------------------------

const RUN_PATH = `/repurpose/runs/${RUN_ID}`;

function candidate(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    startMs: 65_000,
    endMs: 95_000,
    title: `Moment ${id}`,
    potentialScore: 80,
    source: "ai",
    ...overrides,
  };
}

function clip(
  id: string,
  candidateId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    candidateId,
    mezzanineKey: null,
    mezzanineUrl: null,
    state: "cutting",
    failureCode: null,
    variants: [{ id: `${id}V`, projectId: `${id}P`, aspect: "9:16" }],
    ...overrides,
  };
}

function momentsRoutes(
  candidates: readonly Record<string, unknown>[],
  clips: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    [`${RUN_PATH}/candidates`]: { runId: RUN_ID, candidates },
    [`${RUN_PATH}/clips`]: { runId: RUN_ID, clips },
    [`${RUN_PATH}/preview`]: {
      runId: RUN_ID,
      projectId: "01JPROJECT0000000000000000",
      durationMs: 600_000,
      previewUrl: null,
    },
  };
}

type FetchMock = ReturnType<typeof renderWithProviders>["fetchMock"];

describe("<RepurposeRunView /> Autopilot's captioned videos", () => {
  const readyRun = () =>
    run({
      status: "review_ready",
      currentStage: "review",
      automation: "auto",
      candidateCount: 1,
      message: "Your videos are ready to review.",
    });
  const readyClip = (captioned: Record<string, unknown>) =>
    clip("01CLIP1", "01CAND1", {
      state: "ready",
      mezzanineKey: "ws/x/master.mp4",
      mezzanineUrl: "https://media.test/master.mp4?X-Amz-Signature=a",
      captioned,
    });

  it("plays and downloads the finished video with its captions, and keeps the clean one", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: readyRun(),
        ...momentsRoutes(
          [candidate("01CAND1")],
          [
            readyClip({
              status: "ready",
              playUrl: "https://media.test/exports/clip.mp4?X-Amz-Signature=p",
              downloadUrl: "https://media.test/exports/clip.mp4?X-Amz-Signature=d",
            }),
          ],
        ),
      },
    });
    const video = await screen.findByTestId("clip-video-01CAND1");
    expect(video).toHaveAttribute("data-preview", "captioned");
    expect(video.getAttribute("src")).toContain("exports/clip.mp4");
    expect(screen.getByTestId("download-captioned-01CAND1")).toHaveAttribute(
      "href",
      "https://media.test/exports/clip.mp4?X-Amz-Signature=d",
    );
    expect(screen.getByTestId("download-clip-01CAND1")).toHaveTextContent("Without captions");
    expect(screen.queryByTestId("captioned-state-01CAND1")).toBeNull();
  });

  it("says captions are being added while the first file is made", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: readyRun(),
        ...momentsRoutes(
          [candidate("01CAND1")],
          [readyClip({ status: "rendering", playUrl: null, downloadUrl: null })],
        ),
      },
    });
    expect(await screen.findByTestId("captioned-state-01CAND1")).toHaveTextContent(
      "Adding captions to this video",
    );
    expect(screen.queryByTestId("download-captioned-01CAND1")).toBeNull();
    // Until then, the clip plays as before, and downloads without captions.
    expect(screen.getByTestId("download-clip-01CAND1")).toHaveTextContent("Download video");
  });

  it("says the edit is being finished before the captions go on", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: readyRun(),
        ...momentsRoutes(
          [candidate("01CAND1")],
          [readyClip({ status: "finishing", playUrl: null, downloadUrl: null })],
        ),
      },
    });
    const note = await screen.findByTestId("captioned-state-01CAND1");
    expect(note).toHaveTextContent("Finishing the edit");
    expect(note).toHaveAttribute("data-state", "finishing");
    expect(screen.queryByTestId("download-captioned-01CAND1")).toBeNull();
  });
});

/** Answer POSTs to `path` with `answer()`; everything else as the routes say. */
function onPost(fetchMock: FetchMock, path: string, answer: () => Response): void {
  const original = fetchMock.getMockImplementation() as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && new URL(String(input)).pathname === path) {
      return Promise.resolve(answer());
    }
    return original(input, init);
  });
}

function refusal(status: number, code: string, details?: unknown): Response {
  return new Response(
    JSON.stringify({ error: { code, message: "Raw words for developers.", details } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** The buttons on a card that are its primary (the rani fill). */
function cardPrimaries(card: HTMLElement): HTMLElement[] {
  return within(card)
    .getAllByRole("button")
    .filter((button) => button.className.split(/\s+/).includes("bg-accent"));
}

/** The JSON bodies POSTed to `path`, in order. */
function postsTo(fetchMock: FetchMock, path: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => {
      const request = init as RequestInit | undefined;
      return request?.method === "POST" && new URL(String(input)).pathname === path;
    })
    .map(([, init]) => {
      const body = (init as RequestInit).body;
      return typeof body === "string" ? (JSON.parse(body) as unknown) : undefined;
    });
}

describe("<RepurposeRunView /> after a failure", () => {
  beforeEach(() => {
    routerMock.push.mockClear();
  });

  it("shows the error card ABOVE the moments and finished clips, never instead of them", async () => {
    // A run an older API failed because ONE clip failed: its other clip is
    // finished, and used to disappear behind the card.
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          status: "failed",
          currentStage: "styles_formats",
          failureCode: "repurpose/clip_failed",
          canCancel: false,
          canRetry: true,
          candidateCount: 2,
        }),
        ...momentsRoutes(
          [candidate("01CAND1"), candidate("01CAND2")],
          [
            clip("01CLIP1", "01CAND1", {
              state: "ready",
              mezzanineKey: "ws/x/master.mp4",
              mezzanineUrl: "https://media.test/master.mp4?X-Amz-Signature=a",
            }),
          ],
        ),
      },
    });

    const card = await screen.findByTestId("stage-error");
    const list = await screen.findByTestId("candidates-list");
    expect(card.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByTestId("open-clip-01CAND1")).toHaveAttribute("href", "/p/01CLIP1P");
    expect(screen.getByTestId("create-clip-01CAND2")).toBeInTheDocument();
  });

  it("runs the failed stage again on Try again, and shows where the run went", async () => {
    const user = userEvent.setup();
    const retried = run({
      sourceKind: "youtube_url",
      status: "acquiring",
      currentStage: "getting_video",
      message: "Getting your video.",
      canRetry: false,
    });
    const routes: Record<string, unknown> = {
      [RUN_PATH]: run({
        sourceKind: "youtube_url",
        status: "failed",
        currentStage: "getting_video",
        failureCode: "repurpose/source_blocked",
        canCancel: false,
        canRetry: true,
      }),
    };
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, { routes });
    // The server moves the run as it answers, so a re-read after the retry
    // sees the new stage too.
    onPost(fetchMock, `${RUN_PATH}/retry`, () => {
      Object.assign(routes, { [RUN_PATH]: retried });
      return new Response(JSON.stringify(retried), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const card = await screen.findByTestId("stage-error");
    expect(within(card).getByText(/refusing our server for a few minutes/)).toBeInTheDocument();
    await user.click(within(card).getByTestId("stage-error-retry"));

    await waitFor(() => {
      expect(screen.queryByTestId("stage-error")).toBeNull();
    });
    expect(postsTo(fetchMock, `${RUN_PATH}/retry`)).toHaveLength(1);
    expect(screen.getByTestId("run-status")).toHaveTextContent("Getting your video.");
  });

  it("offers the run that already has this link when Try again is refused for it", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          status: "failed",
          currentStage: "getting_video",
          failureCode: "repurpose/source_unavailable",
          canCancel: false,
          canRetry: true,
        }),
      },
    });
    onPost(fetchMock, `${RUN_PATH}/retry`, () =>
      refusal(409, "repurpose/source_already_running", {
        existingRunId: "01JS00000000000000000NEWER",
      }),
    );

    await user.click(await screen.findByTestId("stage-error-retry"));

    expect(await screen.findByTestId("stage-error-retry-error")).toHaveTextContent(
      "You are already working on this video in another run.",
    );
    expect(screen.getByTestId("stage-error-existing-run")).toHaveAttribute(
      "href",
      "/repurpose/01JS00000000000000000NEWER",
    );
    expect(screen.queryByText("Raw words for developers.")).toBeNull();
  });

  it("keeps the caption setup, but not the link, when choosing another video", async () => {
    const user = userEvent.setup();
    const styleId = RECOMMENDED_STYLES[0]?.id ?? "";
    rememberRunSetup(RUN_ID, {
      sourceLanguage: "hi",
      outputLanguage: "same",
      scriptMode: "roman",
      styleId,
      method: "ai",
      requestedCandidates: 5,
      link: "https://www.youtube.com/watch?v=too_big_video",
    });
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          sourceKind: "youtube_url",
          status: "failed",
          currentStage: "getting_video",
          failureCode: "repurpose/source_too_large",
          canCancel: false,
          canRetry: false,
        }),
      },
    });

    // The recommendation IS another video, so it is the card's one primary.
    const choose = await screen.findByTestId("stage-error-choose-another");
    expect(screen.queryByTestId("stage-error-retry")).toBeNull();
    await user.click(choose);

    const href = String(routerMock.push.mock.calls[0]?.[0]);
    const params = new URL(href, "https://app.test").searchParams;
    expect(href.startsWith("/repurpose/new?")).toBe(true);
    expect(params.get("lang")).toBe("hi");
    expect(params.get("script")).toBe("roman");
    expect(params.get("style")).toBe(styleId);
    expect(params.get("url")).toBeNull();
  });

  it("keeps the link too when the link itself needs fixing (a playlist)", async () => {
    const user = userEvent.setup();
    rememberRunSetup(RUN_ID, {
      sourceLanguage: "en",
      outputLanguage: "same",
      scriptMode: "auto",
      styleId: RECOMMENDED_STYLES[0]?.id ?? "",
      method: "ai",
      requestedCandidates: 5,
      link: "https://www.youtube.com/playlist?list=PL123",
    });
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          sourceKind: "youtube_url",
          status: "failed",
          currentStage: "getting_video",
          failureCode: "repurpose/source_playlist",
          canCancel: false,
          canRetry: false,
        }),
      },
    });

    await user.click(await screen.findByTestId("stage-error-check-link"));
    const href = String(routerMock.push.mock.calls[0]?.[0]);
    expect(new URL(href, "https://app.test").searchParams.get("url")).toBe(
      "https://www.youtube.com/playlist?list=PL123",
    );
  });

  // An upload whose file could not be read fails as `processing_failed`, whose
  // recommendation is "Try again" — but the API refuses that retry every time
  // (the file is the problem), so it now answers `canRetry: false`, and the
  // card must lead with the way out rather than a button that always fails.
  it("leads with another file, not Try again, when the run cannot be retried", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          sourceKind: "upload",
          status: "failed",
          currentStage: "getting_video",
          failureCode: "repurpose/processing_failed",
          canCancel: false,
          canRetry: false,
        }),
      },
    });

    const card = await screen.findByTestId("stage-error");
    expect(within(card).queryByTestId("stage-error-retry")).toBeNull();
    expect(cardPrimaries(card)).toEqual([within(card).getByTestId("stage-error-choose-another")]);

    await user.click(within(card).getByTestId("stage-error-choose-another"));
    // Another FILE, most likely: the form opens on its upload tab.
    const href = String(routerMock.push.mock.calls[0]?.[0]);
    expect(new URL(href, "https://app.test").searchParams.get("source")).toBe("upload");
  });

  it("drops a refused Try again for the way out once the run says it cannot be retried", async () => {
    const user = userEvent.setup();
    const failed = {
      sourceKind: "upload",
      status: "failed",
      currentStage: "getting_video",
      failureCode: "repurpose/processing_failed",
      canCancel: false,
    };
    // A tab opened before the API learned to say so: it still offers the retry.
    const routes: Record<string, unknown> = { [RUN_PATH]: run({ ...failed, canRetry: true }) };
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, { routes });
    onPost(fetchMock, `${RUN_PATH}/retry`, () => {
      Object.assign(routes, { [RUN_PATH]: run({ ...failed, canRetry: false }) });
      return refusal(409, "repurpose/not_retryable");
    });

    await user.click(await screen.findByTestId("stage-error-retry"));

    await waitFor(() => {
      expect(screen.queryByTestId("stage-error-retry")).toBeNull();
    });
    const card = screen.getByTestId("stage-error");
    expect(cardPrimaries(card)).toEqual([within(card).getByTestId("stage-error-choose-another")]);
    expect(screen.getByTestId("stage-error-retry-error")).toHaveTextContent(
      "This run cannot be tried again.",
    );
  });

  it("does not say 'unless you try again' under a run that cannot be tried again", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          status: "failed",
          currentStage: "finding_clips",
          failureCode: "repurpose/highlights_failed",
          canCancel: false,
          canRetry: false,
          candidateCount: 1,
        }),
        ...momentsRoutes([candidate("01CAND1")]),
      },
    });

    const bar = await screen.findByTestId("run-action-bar");
    expect(bar).toHaveTextContent("Nothing further will be spent on this run.");
    expect(bar).not.toHaveTextContent(/try again/i);
  });

  it("starts the same link afresh when the transcript has no timings", async () => {
    const user = userEvent.setup();
    rememberRunSetup(RUN_ID, {
      sourceLanguage: "hi",
      outputLanguage: "same",
      scriptMode: "auto",
      styleId: RECOMMENDED_STYLES[0]?.id ?? "",
      method: "ai",
      requestedCandidates: 5,
      link: "https://www.youtube.com/watch?v=untimed",
    });
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          sourceKind: "youtube_url",
          status: "failed",
          currentStage: "finding_clips",
          failureCode: "repurpose/transcript_untimed",
          canCancel: false,
          canRetry: true,
        }),
      },
    });

    const card = await screen.findByTestId("stage-error");
    expect(within(card).getByText("This video's transcript has no timings")).toBeInTheDocument();
    expect(cardPrimaries(card)).toEqual([within(card).getByTestId("stage-error-start-again")]);
    await user.click(within(card).getByTestId("stage-error-start-again"));
    const href = String(routerMock.push.mock.calls[0]?.[0]);
    const params = new URL(href, "https://app.test").searchParams;
    expect(params.get("url")).toBe("https://www.youtube.com/watch?v=untimed");
    expect(params.get("lang")).toBe("hi");
  });

  // The run this card exists for was started on 2026-09-15, before setups were
  // remembered — as is any run started in another browser or a private window.
  // "Start again with this video" then opened an empty "Paste a link" form.
  it("keeps the link for a run this browser never saw, from the run's own display", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          sourceKind: "youtube_url",
          sourceDisplay: "youtube.com · kE0oUEzVVes",
          status: "failed",
          currentStage: "finding_clips",
          failureCode: "repurpose/transcript_untimed",
          canCancel: false,
          canRetry: false,
        }),
      },
    });

    const card = await screen.findByTestId("stage-error");
    expect(cardPrimaries(card)).toEqual([within(card).getByTestId("stage-error-start-again")]);
    await user.click(within(card).getByTestId("stage-error-start-again"));
    const href = String(routerMock.push.mock.calls[0]?.[0]);
    expect(new URL(href, "https://app.test").searchParams.get("url")).toBe(
      "https://www.youtube.com/watch?v=kE0oUEzVVes",
    );
  });

  it("offers another video, not an empty 'this video', when no link can be recovered", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          sourceKind: "youtube_url",
          sourceDisplay: null,
          status: "failed",
          currentStage: "finding_clips",
          failureCode: "repurpose/transcript_untimed",
          canCancel: false,
          canRetry: false,
        }),
      },
    });

    const card = await screen.findByTestId("stage-error");
    expect(within(card).queryByTestId("stage-error-start-again")).toBeNull();
    expect(cardPrimaries(card)).toEqual([within(card).getByTestId("stage-error-choose-another")]);
  });

  it("says a failed run has stopped, instead of 0% complete", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          status: "failed",
          currentStage: "getting_video",
          failureCode: "repurpose/source_private",
          canCancel: false,
          progress: 0,
        }),
      },
    });
    expect(await screen.findByTestId("preview-progress")).toHaveTextContent("Stopped");
    expect(screen.getByTestId("preview-placeholder")).toHaveTextContent("That video is private");
    expect(screen.getByTestId("run-status")).toHaveTextContent("stopped before it finished");
  });
});

describe("<RepurposeRunView /> clips, one state each", () => {
  const cuttingRun = run({
    status: "materializing",
    currentStage: "styles_formats",
    message: "Creating your clips.",
    candidateCount: 4,
  });

  it("shows waiting, cutting and failed clips for what they are", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: cuttingRun,
        ...momentsRoutes(
          [candidate("01CANDW"), candidate("01CANDC"), candidate("01CANDF"), candidate("01CANDN")],
          [
            clip("01CLIPW", "01CANDW", { state: "waiting" }),
            clip("01CLIPC", "01CANDC", { state: "cutting" }),
            clip("01CLIPF", "01CANDF", { state: "failed", failureCode: "media/encode_failed" }),
          ],
        ),
        [`${RUN_PATH}/clips/01CLIPF/retry`]: clip("01CLIPF", "01CANDF", { state: "cutting" }),
      },
    });

    const waiting = await screen.findByTestId("clip-state-01CANDW");
    expect(waiting).toHaveAttribute("data-state", "waiting");
    // The plan's lane being full is not an error, and needs no button. (The
    // sentence also covers waiting for the source's face track, so it names
    // no slot: `CLIP_STATE_COPY.waiting`.)
    expect(waiting).toHaveTextContent("Waiting to start — it starts on its own.");
    expect(screen.queryByTestId("create-clip-01CANDW")).toBeNull();
    expect(screen.queryByTestId("retry-clip-01CANDW")).toBeNull();

    expect(screen.getByTestId("clip-state-01CANDC")).toHaveAttribute("data-state", "cutting");

    const failed = screen.getByTestId("clip-state-01CANDF");
    expect(failed).toHaveAttribute("data-state", "failed");
    expect(failed).toHaveTextContent("We could not finish cutting this clip");
    expect(failed).toHaveTextContent("other clips are safe");

    // A moment with no clip yet still offers one.
    expect(screen.getByTestId("create-clip-01CANDN")).toBeInTheDocument();

    await user.click(screen.getByTestId("retry-clip-01CANDF"));
    await waitFor(() => {
      expect(postsTo(fetchMock, `${RUN_PATH}/clips/01CLIPF/retry`)).toHaveLength(1);
    });
    // Only that clip: the run itself is not retried.
    expect(postsTo(fetchMock, `${RUN_PATH}/retry`)).toHaveLength(0);
  });

  // "Start again from the link" used to be built from this browser's memory
  // alone, so for a run it never saw it opened an empty form ("/repurpose/new").
  // It is offered once this run is stopped (or failed, or published): the API
  // allows one open run per link, so while this one is open a new run of the
  // same link is refused and sent back here.
  it("offers a new run from the same link, not a retry, once the run with the gone original is stopped", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: {
          ...cuttingRun,
          status: "cancelled",
          canCancel: false,
          sourceKind: "youtube_url",
          sourceDisplay: "youtube.com · kE0oUEzVVes",
        },
        ...momentsRoutes(
          [candidate("01CANDF")],
          [
            clip("01CLIPF", "01CANDF", {
              state: "failed",
              failureCode: "repurpose/source_expired",
            }),
          ],
        ),
      },
    });
    const restart = await screen.findByTestId("restart-clip-01CANDF");
    expect(restart).toHaveTextContent("Start again from the link");
    const href = restart.getAttribute("href") ?? "";
    expect(new URL(href, "https://app.test").searchParams.get("url")).toBe(
      "https://www.youtube.com/watch?v=kE0oUEzVVes",
    );
    expect(screen.queryByTestId("retry-clip-01CANDF")).toBeNull();
  });

  // The API refuses a new run of a link that still has an open one
  // (`source_already_running`), so the button led straight back to this run.
  it("says to stop the run first, with no dead-end button, while a link run with a gone original is open", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: {
          ...cuttingRun,
          status: "candidates_ready",
          currentStage: "finding_clips",
          sourceKind: "youtube_url",
          sourceDisplay: "youtube.com · kE0oUEzVVes",
        },
        ...momentsRoutes(
          [candidate("01CANDF")],
          [
            clip("01CLIPF", "01CANDF", {
              state: "failed",
              failureCode: "repurpose/source_expired",
            }),
          ],
        ),
      },
    });
    const failed = await screen.findByTestId("clip-state-01CANDF");
    expect(failed).toHaveTextContent("The original video is no longer kept");
    expect(failed).toHaveTextContent(
      "To cut this moment, stop this run, then start again from the same link.",
    );
    expect(screen.queryByTestId("restart-clip-01CANDF")).toBeNull();
    expect(screen.queryByTestId("retry-clip-01CANDF")).toBeNull();
    // The way to stop it is on the same page.
    expect(screen.getByTestId("run-cancel")).toBeInTheDocument();
  });

  it("says to wait for the run to finish when an open link run can no longer be stopped", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: {
          ...cuttingRun,
          status: "partially_published",
          currentStage: "publish",
          canCancel: false,
          sourceKind: "youtube_url",
          sourceDisplay: "youtube.com · kE0oUEzVVes",
        },
        ...momentsRoutes(
          [candidate("01CANDF")],
          [clip("01CLIPF", "01CANDF", { state: "failed", failureCode: "media/source_missing" })],
        ),
      },
    });
    const failed = await screen.findByTestId("clip-state-01CANDF");
    expect(failed).toHaveTextContent("once this one has finished");
    expect(failed).not.toHaveTextContent(/stop this run/);
    expect(screen.queryByTestId("restart-clip-01CANDF")).toBeNull();
  });

  it("offers the file again, not the link, when an upload's original is gone", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: cuttingRun,
        ...momentsRoutes(
          [candidate("01CANDF")],
          [clip("01CLIPF", "01CANDF", { state: "failed", failureCode: "media/source_missing" })],
        ),
      },
    });
    const restart = await screen.findByTestId("restart-clip-01CANDF");
    expect(restart).toHaveTextContent("Upload the video again");
    expect(restart).toHaveAttribute("href", "/repurpose/new?source=upload");
    expect(screen.getByTestId("clip-state-01CANDF")).not.toHaveTextContent(/link/);
  });

  // A clip too large to prepare fell through to "This clip could not be made"
  // with a "Try again" that would only cut the same size again.
  it("offers neither a retry nor a new run for a clip that came out too large", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: {
          ...cuttingRun,
          sourceKind: "youtube_url",
          sourceDisplay: "youtube.com · kE0oUEzVVes",
        },
        ...momentsRoutes(
          [candidate("01CANDF")],
          [clip("01CLIPF", "01CANDF", { state: "failed", failureCode: "media/too_large" })],
        ),
      },
    });
    const failed = await screen.findByTestId("clip-state-01CANDF");
    expect(failed).toHaveTextContent("This clip came out too large to open in the editor");
    expect(failed).toHaveTextContent("A shorter moment from it will fit.");
    expect(screen.queryByTestId("retry-clip-01CANDF")).toBeNull();
    expect(screen.queryByTestId("restart-clip-01CANDF")).toBeNull();
  });

  it("shows a refused create next to its moment, in plain words", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          status: "candidates_ready",
          currentStage: "finding_clips",
          candidateCount: 1,
        }),
        ...momentsRoutes([candidate("01CAND1")]),
      },
    });
    onPost(fetchMock, `${RUN_PATH}/clips`, () => refusal(503, "common/unavailable"));

    await user.click(await screen.findByTestId("create-clip-01CAND1"));

    const error = await screen.findByTestId("create-clip-error-01CAND1");
    expect(error).toHaveTextContent("That clip could not be started. Try again in a moment.");
    expect(screen.queryByText("Raw words for developers.")).toBeNull();
    // The button comes back, so the person can try again.
    expect(screen.getByTestId("create-clip-01CAND1")).not.toBeDisabled();
  });
});

describe("<RepurposeRunView /> moments by time", () => {
  it("says honestly when discovery found nothing, and opens the time form", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          status: "candidates_ready",
          currentStage: "finding_clips",
          message: "Your suggested moments are ready.",
          candidateCount: 0,
        }),
        ...momentsRoutes([]),
      },
    });

    expect(await screen.findByTestId("candidates-empty")).toHaveTextContent(
      /did not find a moment worth suggesting/,
    );
    expect(screen.getByTestId("add-moment-form")).toBeInTheDocument();
    expect(screen.getByTestId("add-moment-start")).not.toBeDisabled();
    // Not the promise of suggestions still to come.
    expect(screen.queryByText(/appear here once your video is ready/)).toBeNull();
  });

  it("shows the form from the start of a manual run, closed until the transcript exists", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [RUN_PATH]: run({ mode: "manual" }), ...momentsRoutes([]) },
    });

    expect(await screen.findByTestId("add-moment-form")).toBeInTheDocument();
    expect(screen.getByTestId("add-moment-start")).toBeDisabled();
    expect(screen.getByTestId("add-moment-submit")).toBeDisabled();
    expect(await screen.findByTestId("candidates-manual-wait")).toBeInTheDocument();
  });

  it("adds a moment typed as m:ss once the transcript exists", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          mode: "manual",
          status: "candidates_ready",
          message: "Add your moments.",
        }),
        ...momentsRoutes([]),
      },
    });
    onPost(
      fetchMock,
      `${RUN_PATH}/candidates`,
      () =>
        new Response(JSON.stringify(candidate("01CANDM", { source: "manual" })), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    await user.type(await screen.findByTestId("add-moment-start"), "1:05");
    await user.type(screen.getByTestId("add-moment-end"), "1:40");
    await user.click(screen.getByTestId("add-moment-submit"));

    expect(await screen.findByTestId("add-moment-done")).toHaveTextContent("1:05 to 1:40");
    expect(postsTo(fetchMock, `${RUN_PATH}/candidates`)).toEqual([
      { startMs: 65_000, endMs: 100_000 },
    ]);
  });

  it("offers no time form on a run that failed before its transcript", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          mode: "manual",
          status: "failed",
          currentStage: "getting_video",
          failureCode: "repurpose/source_removed",
          canCancel: false,
        }),
        ...momentsRoutes([]),
      },
    });
    await screen.findByTestId("stage-error");
    expect(screen.queryByTestId("add-moment-form")).toBeNull();
  });
});

describe("<RepurposeRunView /> stopping a run", () => {
  it("asks before stopping, since a stopped run cannot be started again", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run(),
        [`${RUN_PATH}/cancel`]: run({ status: "cancelled", canCancel: false }),
      },
    });

    await user.click(await screen.findByTestId("run-cancel"));
    // Nothing is stopped by the first click.
    expect(postsTo(fetchMock, `${RUN_PATH}/cancel`)).toHaveLength(0);

    await user.click(await screen.findByTestId("run-cancel-confirm"));
    await waitFor(() => {
      expect(postsTo(fetchMock, `${RUN_PATH}/cancel`)).toHaveLength(1);
    });
  });
});

/** How many times `path` was read (GET). */
function readsOf(fetchMock: FetchMock, path: string): number {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    return method === "GET" && new URL(String(input)).pathname === path;
  }).length;
}

describe("<RepurposeRunView /> after the run was stopped", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The API never enqueues a waiting clip for a cancelled run and refuses every
  // create and retry on one. The page still said "it starts on its own", kept
  // offering Create and Try again, and polled the clip list every 3 s for as
  // long as the tab stayed open.
  it("shows a waiting clip as not made, offers nothing new, and stops polling for it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          status: "cancelled",
          currentStage: "styles_formats",
          message: "You stopped this run. Nothing else will happen.",
          canCancel: false,
          candidateCount: 3,
        }),
        ...momentsRoutes(
          [candidate("01CANDW"), candidate("01CANDF"), candidate("01CANDN")],
          [
            clip("01CLIPW", "01CANDW", { state: "waiting" }),
            clip("01CLIPF", "01CANDF", { state: "failed", failureCode: "media/encode_failed" }),
          ],
        ),
      },
    });

    const waiting = await screen.findByTestId("clip-state-01CANDW");
    expect(waiting).toHaveAttribute("data-state", "stopped");
    expect(waiting).toHaveTextContent("this run was stopped");
    expect(screen.queryByText(/starts on its own/)).toBeNull();
    expect(screen.queryByTestId("create-clip-01CANDN")).toBeNull();
    expect(screen.queryByTestId("retry-clip-01CANDF")).toBeNull();
    expect(screen.getByTestId("clip-state-01CANDF")).toHaveTextContent(/run was stopped/);
    expect(screen.getByTestId("stage-note-styles_formats")).not.toHaveTextContent(/Create/);

    const before = readsOf(fetchMock, `${RUN_PATH}/clips`);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readsOf(fetchMock, `${RUN_PATH}/clips`)).toBe(before);
  });

  it("says what stopping does to clips: a cut under way finishes, a waiting one never starts", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [RUN_PATH]: run() },
    });
    await user.click(await screen.findByTestId("run-cancel"));
    const dialog = await screen.findByTestId("confirm-action-dialog");
    expect(dialog).toHaveTextContent("Clips already being cut still finish");
    expect(dialog).toHaveTextContent("clips still waiting for a slot are not made");
  });
});

describe("<RepurposeRunView /> keeping up without realtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The candidates list had no poll of its own: with the socket down, a run
  // that finished discovery sat on an empty list until a reload.
  it("shows moments as discovery finds them, with no realtime event", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const routes: Record<string, unknown> = {
      [RUN_PATH]: run({ status: "analyzing", message: "Finding promising moments." }),
      ...momentsRoutes([]),
    };
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, { routes });
    await screen.findByTestId("repurpose-run");
    await waitFor(() => {
      expect(readsOf(fetchMock, `${RUN_PATH}/candidates`)).toBe(1);
    });

    Object.assign(routes, {
      [`${RUN_PATH}/candidates`]: { runId: RUN_ID, candidates: [candidate("01CAND1")] },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await screen.findByTestId("candidates-list")).toBeInTheDocument();
  });

  // The run (polled) can say "5 moments ready" a few seconds before the list
  // (polled separately) holds them. For those seconds the page said it found
  // nothing and opened the time form under a header saying moments were ready.
  it("says moments are loading, not that none were found, while the list catches up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const routes: Record<string, unknown> = {
      [RUN_PATH]: run({
        status: "candidates_ready",
        message: "Your suggested moments are ready.",
        candidateCount: 2,
      }),
      ...momentsRoutes([]),
    };
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, { routes });

    expect(await screen.findByTestId("candidates-loading")).toHaveTextContent(
      "Loading your moments…",
    );
    expect(screen.queryByText(/did not find a moment/)).toBeNull();
    expect(screen.queryByTestId("add-moment-form")).toBeNull();

    Object.assign(routes, {
      [`${RUN_PATH}/candidates`]: {
        runId: RUN_ID,
        candidates: [candidate("01CAND1"), candidate("01CAND2")],
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await screen.findByTestId("candidates-list")).toBeInTheDocument();
    expect(screen.queryByTestId("candidates-loading")).toBeNull();
  });
});

describe("<RepurposeRunView /> the run's own Try again", () => {
  it("shows the retry in flight, and does not take a second click", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          sourceKind: "youtube_url",
          status: "failed",
          currentStage: "getting_video",
          failureCode: "repurpose/source_blocked",
          canCancel: false,
          canRetry: true,
        }),
      },
    });
    let answer: (response: Response) => void = () => undefined;
    const original = fetchMock.getMockImplementation() as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && new URL(String(input)).pathname === `${RUN_PATH}/retry`) {
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }
      return original(input, init);
    });

    await user.click(await screen.findByTestId("stage-error-retry"));
    await waitFor(() => {
      expect(screen.getByTestId("stage-error-retry")).toHaveTextContent("Trying again…");
    });
    expect(screen.getByTestId("stage-error-retry")).toBeDisabled();

    answer(refusal(503, "common/unavailable"));
    expect(await screen.findByTestId("stage-error-retry-error")).toHaveTextContent(
      "That did not work. Try again in a moment.",
    );
    expect(postsTo(fetchMock, `${RUN_PATH}/retry`)).toHaveLength(1);
  });
});

describe("<RepurposeRunView /> a clip just asked for", () => {
  // The card held "Starting…" (disabled) until the clip list showed the new
  // row — for good, when that list's next read failed or came back without it.
  it("shows the clip the create returned while the list has not caught up", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({ status: "candidates_ready", candidateCount: 1 }),
        ...momentsRoutes([candidate("01CAND1")]),
      },
    });
    onPost(
      fetchMock,
      `${RUN_PATH}/clips`,
      () =>
        new Response(JSON.stringify(clip("01CLIP1", "01CAND1", { state: "waiting" })), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    await user.click(await screen.findByTestId("create-clip-01CAND1"));

    expect(await screen.findByTestId("clip-state-01CAND1")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    expect(screen.queryByTestId("create-clip-01CAND1")).toBeNull();
  });
});

describe("<RepurposeRunView /> the time form stays while it is used", () => {
  // Opened because discovery found nothing, the form folded back into its
  // toggle the moment the first moment it added arrived — taking the "Added
  // the moment" confirmation with it.
  it("keeps the form, and its confirmation, open after the first moment lands", async () => {
    const user = userEvent.setup();
    const routes: Record<string, unknown> = {
      [RUN_PATH]: run({ status: "candidates_ready", candidateCount: 0 }),
      ...momentsRoutes([]),
    };
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, { routes });
    onPost(fetchMock, `${RUN_PATH}/candidates`, () => {
      // The server now has the moment, and the run counts it.
      Object.assign(routes, {
        [RUN_PATH]: run({ status: "candidates_ready", candidateCount: 1 }),
        [`${RUN_PATH}/candidates`]: {
          runId: RUN_ID,
          candidates: [candidate("01CANDM", { source: "manual" })],
        },
      });
      return new Response(JSON.stringify(candidate("01CANDM", { source: "manual" })), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    await user.type(await screen.findByTestId("add-moment-start"), "1:05");
    await user.type(screen.getByTestId("add-moment-end"), "1:40");
    await user.click(screen.getByTestId("add-moment-submit"));

    expect(await screen.findByTestId("candidates-list")).toBeInTheDocument();
    expect(screen.getByTestId("add-moment-form")).toBeInTheDocument();
    expect(screen.getByTestId("add-moment-done")).toHaveTextContent("1:05 to 1:40");
  });

  it("offers the form after a discovery that timed out, as the API accepts moments then", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({
          status: "failed",
          currentStage: "finding_clips",
          failureCode: "repurpose/stage_timeout",
          canCancel: false,
          canRetry: true,
        }),
        ...momentsRoutes([]),
      },
    });
    await screen.findByTestId("stage-error");
    expect(await screen.findByTestId("add-moment-form")).toBeInTheDocument();
    expect(screen.getByTestId("add-moment-start")).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Plan limits (2026-09-27): a plan limits the minutes a run processes, so a
// long video's run is about a part of it; a refusal carries its numbers; and
// the run is titled by the video's real title.
// ---------------------------------------------------------------------------

const MIN = 60_000;
const LENGTH = 34 * MIN + 37_000; // 34:37
const NEXT_RUN_ID = "01JS000000000000000000NEXT";

describe("<RepurposeRunView /> a run over part of a long video", () => {
  beforeEach(() => {
    routerMock.push.mockClear();
  });

  const partRun = run({
    sourceKind: "youtube_url",
    sourceDisplay: "youtube.com · kE0oUEzVVes",
    sourceTitle: "How we ship every day",
    status: "candidates_ready",
    currentStage: "finding_clips",
    message: "Your moments are ready.",
    candidateCount: 1,
    window: { startMs: 0, endMs: 20 * MIN, sourceDurationMs: 3 * 60 * MIN, policy: "first" },
    nextWindowAvailable: true,
  });

  it("is titled by the video's real title, with where it came from beside it", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [RUN_PATH]: partRun, ...momentsRoutes([candidate("01CAND1")]) },
    });
    expect(await screen.findByTestId("run-title")).toHaveTextContent("How we ship every day");
    expect(screen.getByTestId("preview-source")).toHaveTextContent("youtube.com · kE0oUEzVVes");
  });

  it("says which part it processed, and starts the next part as a new run", async () => {
    const user = userEvent.setup();
    const styleId = RECOMMENDED_STYLES[0]?.id ?? "";
    rememberRunSetup(RUN_ID, {
      sourceLanguage: "auto",
      outputLanguage: "same",
      scriptMode: "auto",
      styleId,
      method: "ai",
      requestedCandidates: 5,
      link: "https://www.youtube.com/watch?v=kE0oUEzVVes",
      startMs: 0,
    });
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [RUN_PATH]: partRun, ...momentsRoutes([candidate("01CAND1")]) },
    });
    onPost(
      fetchMock,
      `${RUN_PATH}/next-window`,
      () =>
        new Response(
          JSON.stringify({ run: { ...partRun, id: NEXT_RUN_ID, status: "acquiring" } }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    expect(await screen.findByTestId("run-window-summary")).toHaveTextContent(
      "Processed 0:00–20:00 of 3:00:00 (from the start)",
    );
    expect(screen.getByTestId("preview-window")).toHaveTextContent("Processed 0:00–20:00");
    await user.click(screen.getByTestId("run-next-window"));

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith(`/repurpose/${NEXT_RUN_ID}`);
    });
    expect(postsTo(fetchMock, `${RUN_PATH}/next-window`)).toHaveLength(1);
    // The next part keeps this run's setup, with the start the server gave
    // it (where this part ended), not this run's own start.
    expect(recallRunSetup(NEXT_RUN_ID)?.styleId).toBe(styleId);
    expect(recallRunSetup(NEXT_RUN_ID)?.startMs).toBe(20 * MIN);
  });

  // The API reports a next part as soon as this run's section lands. Started
  // then, a second run of the same video competes with this one for the one
  // download at a time and the plan's job slots.
  it("does not offer the next part while this one is still being worked on", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: {
          ...partRun,
          status: "transcribing",
          message: "Creating the transcript.",
          candidateCount: 0,
        },
        ...momentsRoutes([]),
      },
    });
    // And it is not "processed" yet.
    expect(await screen.findByTestId("run-window-summary")).toHaveTextContent(
      "Processing 0:00–20:00 of 3:00:00 (from the start)",
    );
    expect(screen.queryByTestId("run-next-window")).toBeNull();
  });

  it("names a failed run's part without saying it was processed", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: {
          ...partRun,
          status: "failed",
          failureCode: "repurpose/no_credits",
          candidateCount: 0,
          canCancel: false,
          canRetry: true,
        },
        ...momentsRoutes([]),
      },
    });
    expect(await screen.findByTestId("run-window-summary")).toHaveTextContent(
      "Part 0:00–20:00 of 3:00:00 (from the start)",
    );
    // A stopped run's next part is fair game: nothing competes with it.
    expect(screen.getByTestId("run-next-window")).toBeInTheDocument();
  });

  it("promises the plan's window for the next part, not this run's length", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        // This run was cut short (to 10 minutes) by the balance.
        [RUN_PATH]: {
          ...partRun,
          window: { startMs: 0, endMs: 10 * MIN, sourceDurationMs: 3 * 60 * MIN, policy: "first" },
        },
        ...momentsRoutes([candidate("01CAND1")]),
        "/workspaces/01JWORKSPACE/entitlement": {
          workspaceId: "01JWORKSPACE",
          planKey: "free",
          planName: "Free",
          creditsPerMonthTenths: 200,
          seatsIncluded: 1,
          seatsUsed: 1,
          computedAt: "2026-09-27T10:00:00.000Z",
          entitlements: { clipsWindowMs: 20 * MIN, flags: {} },
        },
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId("run-next-window")).toHaveTextContent(
        "Process the next 20 minutes",
      );
    });
  });

  it("names the next part by what is left when that is less than a whole part", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: {
          ...partRun,
          window: {
            startMs: 12 * MIN + 10_000,
            endMs: 32 * MIN + 10_000,
            sourceDurationMs: LENGTH,
            policy: "most_replayed",
          },
        },
        ...momentsRoutes([candidate("01CAND1")]),
      },
    });
    expect(await screen.findByTestId("run-window-summary")).toHaveTextContent(
      "Processed 12:10–32:10 of 34:37 (most replayed)",
    );
    expect(screen.getByTestId("run-next-window")).toHaveTextContent("Process the next 2 minutes");
  });

  it("says plainly when there is nothing after this part", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [RUN_PATH]: partRun, ...momentsRoutes([candidate("01CAND1")]) },
    });
    onPost(fetchMock, `${RUN_PATH}/next-window`, () => refusal(409, "repurpose/no_next_window"));

    await user.click(await screen.findByTestId("run-next-window"));

    expect(await screen.findByTestId("run-next-window-error")).toHaveTextContent(
      "There is nothing after this part of the video.",
    );
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(screen.queryByText("Raw words for developers.")).toBeNull();
  });

  it("offers no next part when the run says there is none, and no line for a whole video", async () => {
    const { unmount } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: { ...partRun, nextWindowAvailable: false },
        ...momentsRoutes([candidate("01CAND1")]),
      },
    });
    expect(await screen.findByTestId("run-window-summary")).toBeInTheDocument();
    expect(screen.queryByTestId("run-next-window")).toBeNull();
    unmount();

    // An API older than windows sends none of these fields.
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: run({ sourceKind: "youtube_url", sourceDisplay: "youtube.com · kE0oUEzVVes" }),
      },
    });
    expect(await screen.findByTestId("run-title")).toHaveTextContent("youtube.com · kE0oUEzVVes");
    expect(screen.queryByTestId("run-window")).toBeNull();
  });
});

describe("<RepurposeRunView /> a link longer than the plan processes", () => {
  beforeEach(() => {
    routerMock.push.mockClear();
  });

  // What the probe writes when a fetched file overran its window: the limit
  // IS the window (`probe.handler.ts`). The realistic way here is an old
  // downloader that fetched the whole video during a deploy.
  const tooLong = run({
    sourceKind: "youtube_url",
    sourceDisplay: "youtube.com · kE0oUEzVVes",
    status: "failed",
    currentStage: "getting_video",
    failureCode: "repurpose/source_too_long",
    failureDetail: { durationMs: LENGTH, maxDurationMs: 20 * MIN, windowMs: 20 * MIN },
    canCancel: false,
    canRetry: true,
  });

  it("states the numbers, and processes part of it on one click", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [RUN_PATH]: tooLong },
    });
    onPost(
      fetchMock,
      `${RUN_PATH}/retry`,
      () =>
        new Response(JSON.stringify({ ...tooLong, status: "acquiring", failureCode: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const card = await screen.findByTestId("stage-error");
    expect(within(card).getByTestId("stage-error-title")).toHaveTextContent(
      "This video is 34:37. Your plan processes 20:00 per video.",
    );
    const useWindow = within(card).getByTestId("stage-error-use-window");
    // A retry fetches the part the run asked for; this browser does not know
    // whether that was a start of its own, so the label promises a length only.
    expect(useWindow).toHaveTextContent("Process 20 minutes of it");
    expect(cardPrimaries(card)).toEqual([useWindow]);
    expect(within(card).getByTestId("stage-error-pick-start")).toBeInTheDocument();

    await user.click(useWindow);
    await waitFor(() => {
      expect(postsTo(fetchMock, `${RUN_PATH}/retry`)).toHaveLength(1);
    });
  });

  it("says the automatic part when this browser knows the run had no start of its own", async () => {
    rememberRunSetup(RUN_ID, {
      sourceLanguage: "auto",
      outputLanguage: "same",
      scriptMode: "auto",
      styleId: RECOMMENDED_STYLES[0]?.id ?? "",
      method: "ai",
      requestedCandidates: 5,
      link: "https://www.youtube.com/watch?v=kE0oUEzVVes",
    });
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, { routes: { [RUN_PATH]: tooLong } });
    const card = await screen.findByTestId("stage-error");
    expect(within(card).getByTestId("stage-error-use-window")).toHaveTextContent(
      "Process 20 minutes of it",
    );
    expect(within(card).getByTestId("stage-error-reassurance")).toHaveTextContent(
      "We take the most-replayed part when YouTube marks one, otherwise the start.",
    );
  });

  // The API's retry re-uses the run's own request, so a picked start is
  // fetched from that start again: "the most-replayed 20 minutes" was untrue.
  it("says a run given its own start is retried from that start", async () => {
    rememberRunSetup(RUN_ID, {
      sourceLanguage: "auto",
      outputLanguage: "same",
      scriptMode: "auto",
      styleId: RECOMMENDED_STYLES[0]?.id ?? "",
      method: "ai",
      requestedCandidates: 5,
      link: "https://www.youtube.com/watch?v=kE0oUEzVVes",
      startMs: 12 * MIN + 10_000,
    });
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, { routes: { [RUN_PATH]: tooLong } });
    const card = await screen.findByTestId("stage-error");
    const useWindow = within(card).getByTestId("stage-error-use-window");
    expect(useWindow).toHaveTextContent("Process 20 minutes from 12:10");
    expect(card).not.toHaveTextContent(/most-replayed/);
    expect(cardPrimaries(card)).toEqual([useWindow]);
  });

  // What the downloader writes for a video over the 12-hour ceiling: the
  // ceiling as the limit, no window. No part of it helps.
  it("offers only another video for a video over the ceiling", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: {
          ...tooLong,
          failureDetail: { durationMs: 13 * 60 * MIN, maxDurationMs: 12 * 60 * MIN },
        },
      },
    });
    const card = await screen.findByTestId("stage-error");
    expect(within(card).getByTestId("stage-error-title")).toHaveTextContent(
      "This video is 13:00:00. Your plan takes videos up to 12 hours long.",
    );
    expect(within(card).queryByTestId("stage-error-use-window")).toBeNull();
    expect(within(card).queryByTestId("stage-error-pick-start")).toBeNull();
    expect(cardPrimaries(card)).toEqual([within(card).getByTestId("stage-error-choose-another")]);
  });

  it("offers picking a start as the primary when the too-long run cannot be retried", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [RUN_PATH]: { ...tooLong, canRetry: false } },
    });
    const card = await screen.findByTestId("stage-error");
    expect(within(card).queryByTestId("stage-error-use-window")).toBeNull();
    expect(cardPrimaries(card)).toEqual([within(card).getByTestId("stage-error-pick-start")]);
  });

  // A link's retry fetches the video again, and is refused up front when the
  // balance does not pay for a minute of it.
  it("points at the balance when processing part of it is refused for credits", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [RUN_PATH]: tooLong },
    });
    onPost(fetchMock, `${RUN_PATH}/retry`, () =>
      refusal(402, "repurpose/no_credits", { creditsLeft: 0.4 }),
    );

    await user.click(await screen.findByTestId("stage-error-use-window"));

    expect(await screen.findByTestId("stage-error-retry-error")).toHaveTextContent(
      "You have 0.4 credits left, which is not enough to process a minute of video.",
    );
    expect(screen.getByTestId("stage-error-retry-credits")).toHaveAttribute("href", "/billing");
    expect(screen.queryByText("Raw words for developers.")).toBeNull();
  });

  it("opens the same link on 'Start at', with the video's length, to pick where to start", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, { routes: { [RUN_PATH]: tooLong } });

    await user.click(await screen.findByTestId("stage-error-pick-start"));

    const href = String(routerMock.push.mock.calls[0]?.[0]);
    const params = new URL(href, "https://app.test").searchParams;
    expect(href.startsWith("/repurpose/new?")).toBe(true);
    expect(params.get("url")).toBe("https://www.youtube.com/watch?v=kE0oUEzVVes");
    expect(params.get("pick")).toBe("start");
    expect(params.get("len")).toBe(String(LENGTH));
  });

  it("offers no part of an upload, which is processed whole", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: { ...tooLong, sourceKind: "upload", sourceDisplay: null, canRetry: false },
      },
    });
    const card = await screen.findByTestId("stage-error");
    expect(within(card).queryByTestId("stage-error-use-window")).toBeNull();
    expect(within(card).queryByTestId("stage-error-pick-start")).toBeNull();
    expect(cardPrimaries(card)).toEqual([within(card).getByTestId("stage-error-choose-another")]);
  });
});

/**
 * Steering (2026-09-29): the run says how it was steered, and a moment the
 * person removed stays on the page folded to one line with "Restore".
 */
describe("<RepurposeRunView /> steering", () => {
  const CANDIDATES = `/repurpose/runs/${RUN_ID}/candidates`;
  const moment = (id: string, state: string, startMs: number): Record<string, unknown> => ({
    id,
    runId: RUN_ID,
    source: "ai",
    state,
    rank: 1,
    startMs,
    endMs: startMs + 30_000,
    title: `Moment ${id}`,
    potentialScore: 80,
  });

  it("says what the run is about, how long its clips are and what it skips", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [`/repurpose/runs/${RUN_ID}`]: run({
          steering: {
            topic: "money habits",
            clipLength: "short",
            skipIntroMs: 120_000,
            skipOutroMs: 0,
          },
        }),
      },
    });
    expect(await screen.findByTestId("run-steering")).toHaveTextContent(
      "About: money habits · Short clips · Skips the first 2 min",
    );
  });

  it("says nothing of steering for a run that had none", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: { [`/repurpose/runs/${RUN_ID}`]: run({ steering: null }) },
    });
    expect(await screen.findByTestId("repurpose-run")).toBeInTheDocument();
    expect(screen.queryByTestId("run-steering")).toBeNull();
  });

  it("folds a removed moment to one line, and does not count it as found", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [`/repurpose/runs/${RUN_ID}`]: run({
          status: "candidates_ready",
          candidateCount: 2,
          stages: [
            { stage: "getting_video", state: "complete", label: "Video added" },
            { stage: "finding_clips", state: "complete", label: "Moments found" },
            { stage: "styles_formats", state: "waiting", label: "Style formats" },
            { stage: "review", state: "waiting", label: "Review" },
            { stage: "publish", state: "waiting", label: "Publish" },
          ],
        }),
        [CANDIDATES]: {
          runId: RUN_ID,
          candidates: [
            moment("01JS00000000000000000CANDA", "proposed", 60_000),
            moment("01JS00000000000000000CANDB", "rejected", 120_000),
          ],
        },
      },
    });
    const removed = await screen.findByTestId("candidate-card-01JS00000000000000000CANDB");
    expect(removed).toHaveAttribute("data-removed", "true");
    expect(
      within(removed).getByRole("button", { name: "Restore: Moment 01JS00000000000000000CANDB" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("remove-moment-01JS00000000000000000CANDA")).toBeInTheDocument();
    expect(screen.getByText(/^1 moment found\./)).toBeInTheDocument();
  });
});
