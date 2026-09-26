import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepurposeRunView } from "./repurpose-run-view";

import { rememberRunSetup } from "@/components/repurpose/run-setup";
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
    // The plan's lane being full is not an error, and needs no button.
    expect(waiting).toHaveTextContent("Waiting for a free slot — it starts on its own.");
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

  it("offers a new run, not a retry, when the original video is gone", async () => {
    renderWithProviders(<RepurposeRunView runId={RUN_ID} />, {
      routes: {
        [RUN_PATH]: cuttingRun,
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
    expect(await screen.findByTestId("restart-clip-01CANDF")).toHaveAttribute(
      "href",
      "/repurpose/new",
    );
    expect(screen.queryByTestId("retry-clip-01CANDF")).toBeNull();
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
