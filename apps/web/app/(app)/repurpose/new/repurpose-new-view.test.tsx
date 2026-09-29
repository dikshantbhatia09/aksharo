import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepurposeNewView } from "./repurpose-new-view";

import { LANGUAGE_MEMORY_KEY } from "@/components/projects/language-picker";
import { recallRunSetup } from "@/components/repurpose/run-setup";
import { renderWithProviders } from "@/test/harness";
import { routerMock, searchParamsMock } from "@/test/next-router";

// The queue resumes uploads from IndexedDB on mount; a link run never uses it.
// One spy across renders, so an upload run's hand-off can be read back.
const addFilesToProjects = vi.hoisted(() => vi.fn());
vi.mock("@/lib/upload/use-upload-queue", () => ({
  useUploadQueue: () => ({
    items: [],
    addFiles: vi.fn(),
    addFilesToProjects,
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

/**
 * `/repurpose/new` (clips hardening, 2026-09-26): Home and `/repurpose` hand it
 * scheme-less links on purpose, and it used to refuse every one; a refusal
 * showed the API's own words ("This workspace already has 2 jobs in flight");
 * and a link already being worked on was a dead end.
 */
const RUN_ID = "01JS0000000000000000000NEW";
const RUNS = "/repurpose/runs";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The entitlement answer, with `entitlements` as given. */
function entitlementWith(entitlements: Record<string, unknown>): Record<string, unknown> {
  return {
    workspaceId: "01JWORKSPACE",
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 200,
    seatsIncluded: 1,
    seatsUsed: 1,
    computedAt: "2026-09-27T10:00:00.000Z",
    entitlements: { flags: {}, ...entitlements },
  };
}

const ENTITLEMENT_PATH = "/workspaces/01JWORKSPACE/entitlement";

function createBodies(fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"]): unknown[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        (init as RequestInit | undefined)?.method === "POST" &&
        new URL(String(input)).pathname === RUNS,
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);
}

async function startWithPrefilledLink(): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId("rights-attested"));
  await user.click(screen.getByTestId("start-run"));
}

describe("<RepurposeNewView />", () => {
  beforeEach(() => {
    routerMock.push.mockClear();
    searchParamsMock.value = new URLSearchParams({
      url: "youtube.com/watch?v=dQw4w9WgXcQ",
      lang: "en",
    });
  });

  it("sends a scheme-less link as https, and remembers the setup for this run", async () => {
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: {
        [RUNS]: json(201, {
          run: { id: RUN_ID },
          projectId: "01JPROJECT",
          upload: null,
          next: { rel: "run", href: `/repurpose/runs/${RUN_ID}` },
        }),
      },
    });
    expect(screen.getByTestId("source-url")).toHaveValue("youtube.com/watch?v=dQw4w9WgXcQ");

    await startWithPrefilledLink();

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith(`/repurpose/${RUN_ID}`);
    });
    const [body] = createBodies(fetchMock) as [{ source: { url: string } }];
    expect(body.source.url).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    // So a failure can offer the same link and look back.
    expect(recallRunSetup(RUN_ID)?.link).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("offers the run already working on this link instead of a dead end", async () => {
    renderWithProviders(<RepurposeNewView />, {
      routes: {
        [RUNS]: json(409, {
          error: {
            code: "repurpose/source_already_running",
            message: "Duplicate live source fingerprint.",
            details: { existingRunId: "01JS0000000000000000000OLD" },
          },
        }),
      },
    });

    await startWithPrefilledLink();

    expect(await screen.findByTestId("start-server-error")).toHaveTextContent(
      "You are already working on this video.",
    );
    expect(screen.getByTestId("start-existing-run")).toHaveAttribute(
      "href",
      "/repurpose/01JS0000000000000000000OLD",
    );
    expect(screen.queryByText(/fingerprint/)).toBeNull();
  });

  it("never shows an admission refusal's own words", async () => {
    renderWithProviders(<RepurposeNewView />, {
      routes: {
        [RUNS]: json(429, {
          error: {
            code: "jobs/concurrency_cap",
            message: "This workspace already has 2 jobs in flight; the free plan allows 2.",
          },
        }),
      },
    });

    await startWithPrefilledLink();

    expect(await screen.findByTestId("start-server-error")).toHaveTextContent(
      "Your other videos are still being prepared. Try again in about a minute.",
    );
    expect(screen.queryByText(/jobs in flight/)).toBeNull();
    expect(screen.queryByTestId("start-existing-run")).toBeNull();
  });
});

/**
 * Plan limits (2026-09-27): the language starts on "Detect automatically"
 * rather than this browser's last pick on Home, which as a hint overrode
 * detection; a start sends a window; and a run refused for credits says the
 * balance and links to it.
 */
describe("<RepurposeNewView /> language, window and credits", () => {
  function created(): Response {
    return json(201, {
      run: { id: RUN_ID },
      projectId: "01JPROJECT",
      upload: null,
      next: { rel: "run", href: `/repurpose/runs/${RUN_ID}` },
    });
  }

  beforeEach(() => {
    routerMock.push.mockClear();
    addFilesToProjects.mockClear();
    searchParamsMock.value = new URLSearchParams({ url: "youtube.com/watch?v=dQw4w9WgXcQ" });
    window.localStorage.setItem(LANGUAGE_MEMORY_KEY, "hi-Latn");
  });

  it("detects the language, not the one this browser last picked on Home", async () => {
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: { [RUNS]: created() },
    });
    expect(screen.getByTestId("language-detect")).toBeChecked();

    await startWithPrefilledLink();

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith(`/repurpose/${RUN_ID}`);
    });
    const [body] = createBodies(fetchMock) as [{ setup: Record<string, unknown> }];
    expect(body.setup["sourceLanguage"]).toBe("auto");
    // No start typed: the server picks the part (most replayed, else the start).
    expect(body.setup).not.toHaveProperty("window");
    // "Detect" is not a language; Home's memory keeps its own pick.
    expect(window.localStorage.getItem(LANGUAGE_MEMORY_KEY)).toBe("hi-Latn");
  });

  it("runs on Autopilot unless it is switched off, and remembers the choice", async () => {
    window.localStorage.removeItem("aksharo.repurpose.autopilot");
    const first = renderWithProviders(<RepurposeNewView />, { routes: { [RUNS]: created() } });
    expect(await screen.findByTestId("autopilot-switch")).toBeChecked();
    await startWithPrefilledLink();
    await waitFor(() => {
      expect(createBodies(first.fetchMock)).toHaveLength(1);
    });
    const [on] = createBodies(first.fetchMock) as [{ setup: Record<string, unknown> }];
    expect(on.setup["automation"]).toBe("auto");
    first.unmount();

    const user = userEvent.setup();
    const second = renderWithProviders(<RepurposeNewView />, { routes: { [RUNS]: created() } });
    await user.click(await screen.findByTestId("autopilot-switch"));
    expect(screen.getByTestId("autopilot-hint")).toHaveTextContent(
      "You choose which moments become clips.",
    );
    await startWithPrefilledLink();
    await waitFor(() => {
      expect(createBodies(second.fetchMock)).toHaveLength(1);
    });
    const [off] = createBodies(second.fetchMock) as [{ setup: Record<string, unknown> }];
    expect(off.setup["automation"]).toBe("manual");
    expect(window.localStorage.getItem("aksharo.repurpose.autopilot")).toBe("off");
    second.unmount();

    // The next visit starts where this browser left it.
    renderWithProviders(<RepurposeNewView />, { routes: { [RUNS]: created() } });
    await waitFor(() => {
      expect(screen.getByTestId("autopilot-switch")).not.toBeChecked();
    });
    window.localStorage.removeItem("aksharo.repurpose.autopilot");
  });

  it("sends a typed start as a range window", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: { [RUNS]: created() },
    });
    await user.type(screen.getByTestId("source-start-at"), "1:02:30");

    await startWithPrefilledLink();

    await waitFor(() => {
      expect(createBodies(fetchMock)).toHaveLength(1);
    });
    const [body] = createBodies(fetchMock) as [{ setup: { window?: unknown } }];
    expect(body.setup.window).toEqual({ startMs: 3_750_000, policy: "range" });
    // Remembered with the run, so "Check the link" hands the start back.
    await waitFor(() => {
      expect(recallRunSetup(RUN_ID)?.startMs).toBe(3_750_000);
    });
  });

  it("says the balance and links to it when the run cannot start for credits", async () => {
    renderWithProviders(<RepurposeNewView />, {
      routes: {
        [RUNS]: json(402, {
          error: {
            code: "repurpose/no_credits",
            message: "Balance 4 tenths is below one minute.",
            details: { creditsLeft: 0.4 },
          },
        }),
      },
    });

    await startWithPrefilledLink();

    expect(await screen.findByTestId("start-server-error")).toHaveTextContent(
      "You have 0.4 credits left, which is not enough to process a minute of video.",
    );
    expect(screen.getByTestId("start-see-credits")).toHaveAttribute("href", "/billing");
    expect(screen.queryByText(/tenths/)).toBeNull();
  });

  it("opens on 'Start at', with the video's length, when sent to pick a start", async () => {
    const user = userEvent.setup();
    searchParamsMock.value = new URLSearchParams({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      pick: "start",
      len: "2077000",
    });
    renderWithProviders(<RepurposeNewView />, { routes: {} });

    const startAt = screen.getByTestId("source-start-at");
    expect(startAt).toHaveFocus();
    await user.type(startAt, "40:00");
    await user.click(screen.getByTestId("rights-attested"));
    await user.click(screen.getByTestId("start-run"));
    expect(screen.getByText("This video is only 34:37 long.")).toBeInTheDocument();
  });

  it("names the plan's window in the line under 'Start at'", async () => {
    renderWithProviders(<RepurposeNewView />, {
      routes: { [ENTITLEMENT_PATH]: entitlementWith({ clipsWindowMs: 20 * 60_000 }) },
    });
    expect(
      await screen.findByText(/^Videos are processed up to 20 minutes at a time/),
    ).toBeInTheDocument();
  });

  // The owner's internal unlimited workspace: its window is the 12-hour
  // ceiling, so every video it takes is processed whole and a start is
  // ignored. "Videos over 12 hours are processed 12 hours at a time" was
  // untrue, and the field did nothing.
  it("offers no start, and sends none, on a plan that processes whole videos", async () => {
    searchParamsMock.value = new URLSearchParams({
      url: "youtube.com/watch?v=dQw4w9WgXcQ",
      start: "12:10",
    });
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: {
        [ENTITLEMENT_PATH]: entitlementWith({
          clipsWindowMs: 12 * 3_600_000,
          maxSourceDurationMs: 12 * 3_600_000,
          internalUnlimited: true,
        }),
        [RUNS]: created(),
      },
    });
    // Offered until the entitlement says otherwise.
    expect(screen.getByTestId("source-start-at")).toHaveValue("12:10");
    await waitFor(() => {
      expect(screen.queryByTestId("source-start-at")).toBeNull();
    });
    expect(screen.queryByText(/12 hours at a time/)).toBeNull();

    await startWithPrefilledLink();

    await waitFor(() => {
      expect(createBodies(fetchMock)).toHaveLength(1);
    });
    const [body] = createBodies(fetchMock) as [{ setup: Record<string, unknown> }];
    expect(body.setup).not.toHaveProperty("window");
    await waitFor(() => {
      expect(recallRunSetup(RUN_ID)).toBeDefined();
    });
    expect(recallRunSetup(RUN_ID)?.startMs).toBeUndefined();
  });

  it("treats a window at the ceiling as whole videos even without the internal flag", async () => {
    renderWithProviders(<RepurposeNewView />, {
      routes: { [ENTITLEMENT_PATH]: entitlementWith({ clipsWindowMs: 12 * 3_600_000 }) },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("source-start-at")).toBeNull();
    });
  });

  // "Pick where to start" carries the failed video's length. It is that
  // video's: replaced by another link, it refused a good start with a length
  // that belonged to something else.
  it("holds the carried length only while the link is still that video", async () => {
    const user = userEvent.setup();
    searchParamsMock.value = new URLSearchParams({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      pick: "start",
      len: "2077000",
    });
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: { [RUNS]: created() },
    });

    await user.type(screen.getByTestId("source-start-at"), "40:00");
    await user.click(screen.getByTestId("rights-attested"));
    await user.click(screen.getByTestId("start-run"));
    expect(screen.getByText("This video is only 34:37 long.")).toBeInTheDocument();

    await user.clear(screen.getByTestId("source-url"));
    await user.type(
      screen.getByTestId("source-url"),
      "https://www.youtube.com/watch?v=kE0oUEzVVes",
    );
    expect(screen.queryByText("This video is only 34:37 long.")).toBeNull();
    await user.click(screen.getByTestId("start-run"));

    await waitFor(() => {
      expect(createBodies(fetchMock)).toHaveLength(1);
    });
    const [body] = createBodies(fetchMock) as [{ setup: { window?: unknown } }];
    expect(body.setup.window).toEqual({ startMs: 40 * 60_000, policy: "range" });
  });

  it("refuses a start past the 12-hour ceiling at the field, not with the API's generic refusal", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: { [RUNS]: created() },
    });
    await user.type(screen.getByTestId("source-start-at"), "99:00:00");
    await startWithPrefilledLink();

    expect(
      screen.getByText("Start within the first 12 hours. No video can be longer than that."),
    ).toBeInTheDocument();
    expect(createBodies(fetchMock)).toHaveLength(0);
  });

  it("leaves a detected upload's transcript to the server rather than sending 'auto' as a language", async () => {
    const user = userEvent.setup();
    searchParamsMock.value = new URLSearchParams({ source: "upload" });
    renderWithProviders(<RepurposeNewView />, { routes: { [RUNS]: created() } });

    const file = new File(["x"], "talk.mp4", { type: "video/mp4" });
    await user.upload(screen.getByTestId("source-file"), file);
    await user.click(screen.getByTestId("start-run"));

    await waitFor(() => {
      expect(addFilesToProjects).toHaveBeenCalledOnce();
    });
    const [, pick] = addFilesToProjects.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(pick).not.toHaveProperty("language");
    expect(pick["aspect"]).toBe("9:16");
  });
});

describe("<RepurposeNewView /> steering (2026-09-29)", () => {
  beforeEach(() => {
    routerMock.push.mockClear();
    searchParamsMock.value = new URLSearchParams({
      url: "youtube.com/watch?v=dQw4w9WgXcQ",
      lang: "en",
    });
  });

  // A fresh answer per test: a body can only be read once.
  const created = (): Response =>
    json(201, {
      run: { id: RUN_ID },
      projectId: "01JPROJECT",
      upload: null,
      next: { rel: "run", href: `/repurpose/runs/${RUN_ID}` },
    });

  it("sends the topic, the clip length and the skips with the moments we pick", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: { [RUNS]: created() },
    });
    await user.type(await screen.findByTestId("steering-topic"), "money habits");
    await user.click(screen.getByTestId("clip-length-short"));
    await user.type(screen.getByTestId("steering-skip-intro"), "2");
    await startWithPrefilledLink();

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith(`/repurpose/${RUN_ID}`);
    });
    const [body] = createBodies(fetchMock) as [{ setup: { discovery: Record<string, unknown> } }];
    expect(body.setup.discovery).toEqual({
      mode: "ai",
      requestedCandidates: 5,
      topic: "money habits",
      clipLength: "short",
      skipIntroMs: 120_000,
    });
  });

  it("sends Medium by default, and nothing of the rest when it was left empty", async () => {
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: { [RUNS]: created() },
    });
    await startWithPrefilledLink();
    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalled();
    });
    const [body] = createBodies(fetchMock) as [{ setup: { discovery: Record<string, unknown> } }];
    expect(body.setup.discovery).toEqual({
      mode: "ai",
      requestedCandidates: 5,
      clipLength: "medium",
    });
  });

  it("sends none of it when the person knows the timestamps", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: { [RUNS]: created() },
    });
    await user.click(await screen.findByTestId("method-manual"));
    await startWithPrefilledLink();
    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalled();
    });
    const [body] = createBodies(fetchMock) as [{ setup: { discovery: Record<string, unknown> } }];
    expect(body.setup.discovery).toEqual({ mode: "manual", requestedCandidates: 0 });
  });
});
