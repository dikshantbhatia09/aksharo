import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RepurposeCandidateItem, RepurposeClipItem } from "@montaj/api-client";

import { HookTitlesSwitch } from "./HookTitlesSwitch";
import { RunClipResults } from "./RunClipResults";

import { renderWithProviders } from "@/test/harness";

const RUN = "01JS0000000000000000000RUN";

function moment(n: number, over: Partial<RepurposeCandidateItem> = {}): RepurposeCandidateItem {
  return {
    id: `CAND${String(n)}`,
    startMs: n * 60_000,
    endMs: n * 60_000 + 30_000,
    potentialScore: 60 + n * 5,
    title: `Moment ${String(n)}`,
    transcriptExcerpt:
      n === 2 ? "Compound interest is the eighth wonder." : `Words of moment ${String(n)}.`,
    copy: {
      summary: "s",
      hook: "h",
      cta: "",
      hashtags: n === 2 ? ["#money"] : ["#life"],
      locale: "en-IN",
      title: `Clip ${String(n)}`,
    },
    scoreBreakdown: { hook: 70, clarity: 80, standaloneValue: 75 },
    ...over,
  };
}

function made(n: number): RepurposeClipItem {
  return {
    id: `CLIP${String(n)}`,
    candidateId: `CAND${String(n)}`,
    state: "ready",
    variants: [{ id: `V${String(n)}`, projectId: `PRJ${String(n)}`, aspect: "r9x16" }],
    images: {
      status: "ready",
      files: [
        {
          id: "vertical-image",
          width: 1080,
          height: 1920,
          items: [{ url: `poster-${String(n)}.jpg`, downloadUrl: "d" }],
        },
      ],
    },
  } as RepurposeClipItem;
}

const MOMENTS = [1, 2, 3, 4].map((n) => moment(n));
const CLIPS = [1, 2, 3, 4].map(made);

function results(
  props: Partial<React.ComponentProps<typeof RunClipResults>> = {},
  routes: Record<string, unknown> = {},
) {
  return renderWithProviders(
    <RunClipResults
      runId={RUN}
      candidates={MOMENTS}
      clips={CLIPS}
      picking={false}
      canEdit
      renderCard={(candidate, options) => (
        <li data-testid={`card-${candidate.id}`}>
          card {candidate.id}
          {options.onOpenDetails === undefined ? null : (
            <button type="button" onClick={options.onOpenDetails}>
              details {candidate.id}
            </button>
          )}
        </li>
      )}
      {...props}
    />,
    { routes },
  );
}

const started: string[] = [];
vi.mock("@/components/repurpose/download/start-download", () => ({
  startDownload: (url: string) => {
    started.push(url);
  },
}));

describe("RunClipResults", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = "";
  });

  it("opens on a grid of tiles, best first, once several clips are made", () => {
    results();
    const grid = screen.getByTestId("clip-grid");
    const tiles = within(grid).getAllByRole("button");
    // Moment 4 scores highest (80): first, and #1.
    expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual([
      "#1 Clip 4, score 80. Open the clip.",
      "#2 Clip 3, score 75. Open the clip.",
      "#3 Clip 2, score 70. Open the clip.",
      "#4 Clip 1, score 65. Open the clip.",
    ]);
    expect(screen.getByTestId("clip-tile-poster-CAND4")).toHaveAttribute("src", "poster-4.jpg");
    expect(screen.getByTestId("clip-tile-tags-CAND2")).toHaveTextContent("Money");
  });

  it("finds a clip by its words and says how many match", async () => {
    results();
    await userEvent.type(screen.getByTestId("clip-results-search"), "compound");
    expect(screen.getByTestId("clip-results-count")).toHaveTextContent("1 clip matches “compound”");
    expect(within(screen.getByTestId("clip-grid")).getAllByRole("button")).toHaveLength(1);
  });

  it("also finds clips by what they are about, after the ones that say the words", async () => {
    results(
      {},
      {
        [`/repurpose/runs/${RUN}/search`]: {
          semantic: true,
          matches: [
            { candidateId: "CAND2", score: 0.71 },
            { candidateId: "CAND3", score: 0.58 },
          ],
        },
      },
    );
    await userEvent.type(screen.getByTestId("clip-results-search"), "wealth");
    expect(
      await screen.findByText("2 clips match “wealth” by what it is about", undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("clip-grid"))
        .getAllByRole("button")
        .map((tile) => tile.getAttribute("aria-label")?.split(",")[0]),
    ).toEqual(["#3 Clip 2", "#2 Clip 3"]);
  });

  it("orders by the video too, and remembers the list when asked for it", async () => {
    results();
    await userEvent.selectOptions(screen.getByTestId("clip-results-order"), "time");
    expect(
      within(screen.getByTestId("clip-grid"))
        .getAllByRole("button")
        .map((tile) => tile.getAttribute("aria-label")?.split(",")[0]),
    ).toEqual(["#4 Clip 1", "#3 Clip 2", "#2 Clip 3", "#1 Clip 4"]);
    await userEvent.click(screen.getByTestId("clip-results-view-list"));
    expect(screen.getByTestId("candidates-list")).toBeInTheDocument();
    expect(window.localStorage.getItem("aksharo.repurpose.view")).toBe("list");
  });

  it("shows the list while clips are being picked, and for a run with only a few made", () => {
    const picking = results({ picking: true });
    expect(screen.getByTestId("candidates-list")).toBeInTheDocument();
    picking.unmount();
    results({ clips: CLIPS.slice(0, 2) });
    expect(screen.getByTestId("candidates-list")).toBeInTheDocument();
  });

  it("opens a clip from its tile, steps with the arrow keys, and renames it", async () => {
    const { fetchMock } = results(
      {},
      {
        [`/repurpose/runs/${RUN}/candidates/CAND4/transcript`]: {
          offsetMs: 0,
          lines: [{ startMs: 240_000, endMs: 243_000, text: "The best line." }],
        },
        [`/repurpose/runs/${RUN}/candidates/CAND3/transcript`]: { offsetMs: 0, lines: [] },
        [`/repurpose/runs/${RUN}/candidates/CAND3/title`]: {
          candidateId: "CAND3",
          title: "A better name",
        },
      },
    );
    await userEvent.click(
      within(screen.getByTestId("clip-grid")).getAllByRole("button")[0] as HTMLElement,
    );

    const detail = await screen.findByTestId("clip-detail");
    expect(within(detail).getByTestId("clip-detail-title")).toHaveTextContent("Clip 4");
    expect(within(detail).getByTestId("clip-analysis-overall")).toHaveTextContent("80");
    expect(within(detail).getByTestId("clip-analysis-hook-grade")).toHaveTextContent("B");
    expect(await within(detail).findByTestId("clip-transcript")).toHaveTextContent("4:00");
    expect(within(detail).getByTestId("card-CAND4")).toBeInTheDocument();
    expect(within(detail).getByTestId("clip-detail-broll")).toHaveAttribute(
      "href",
      "/p/PRJ4?panel=broll",
    );

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(
      await screen.findByText("Clip 3", { selector: "[data-testid=clip-detail-title]" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("clip-detail-position")).toHaveTextContent("2 of 4");

    await userEvent.click(screen.getByTestId("clip-detail-rename"));
    const input = screen.getByTestId("clip-detail-title-input");
    await userEvent.clear(input);
    await userEvent.type(input, "A better name");
    await userEvent.click(screen.getByTestId("clip-detail-title-save"));
    await waitFor(() => {
      expect(screen.getByTestId("clip-detail-title")).toHaveTextContent("A better name");
    });
    const put = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/CAND3/title") && (init as RequestInit).method === "PUT",
    );
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ title: "A better name" });
  });

  it("opens a clip from a link to it", async () => {
    window.location.hash = "#clip-CLIP2";
    results(
      {},
      { [`/repurpose/runs/${RUN}/candidates/CAND2/transcript`]: { offsetMs: 0, lines: [] } },
    );
    expect(await screen.findByTestId("clip-detail")).toBeInTheDocument();
    expect(screen.getByTestId("clip-detail-title")).toHaveTextContent("Clip 2");
  });

  it("lets a viewer read, not rename", async () => {
    results(
      { canEdit: false },
      { [`/repurpose/runs/${RUN}/candidates/CAND4/transcript`]: { offsetMs: 0, lines: [] } },
    );
    await userEvent.click(
      within(screen.getByTestId("clip-grid")).getAllByRole("button")[0] as HTMLElement,
    );
    await screen.findByTestId("clip-detail");
    expect(screen.queryByTestId("clip-detail-rename")).not.toBeInTheDocument();
  });
});

describe("RunClipResults: picking clips to download", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = "";
  });

  it("ticks made clips instead of opening them, and downloads just those", async () => {
    const coming = { ...made(2), state: "cutting" } as RepurposeClipItem;
    const { fetchMock } = results(
      { clips: [made(1), coming, made(3), made(4)] },
      {
        [`/repurpose/runs/${RUN}/download`]: {
          clips: 2,
          clipsComing: 0,
          videos: 8,
          dubbedVideos: 0,
          images: 22,
          texts: 2,
          bytes: 50 * 1024 * 1024,
          cleanVideos: 8,
          bytesWithClean: 90 * 1024 * 1024,
          filename: "Talk (2 clips).zip",
        },
      },
    );
    await userEvent.click(screen.getByTestId("clip-results-select"));
    expect(screen.getByTestId("clip-selection-count")).toHaveTextContent(
      "Pick the clips to download.",
    );

    // Clip 2 is still being made: it cannot be picked.
    expect(within(screen.getByTestId("clip-tile-CAND2")).getByRole("button")).toBeDisabled();
    await userEvent.click(within(screen.getByTestId("clip-tile-CAND4")).getByRole("button"));
    await userEvent.click(within(screen.getByTestId("clip-tile-CAND1")).getByRole("button"));
    expect(screen.queryByTestId("clip-detail")).not.toBeInTheDocument();
    expect(screen.getByTestId("clip-selection-count")).toHaveTextContent("2 clips picked");
    expect(within(screen.getByTestId("clip-tile-CAND4")).getByRole("button")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(screen.getByTestId("clip-selection-download"));
    const dialog = await screen.findByTestId("download-all-dialog");
    expect(dialog).toHaveTextContent("Download 2 clips");
    expect(await within(dialog).findByTestId("download-all-contents")).toHaveTextContent("2 clips");
    const summaryUrl = String(
      fetchMock.mock.calls.find(([url]) => String(url).includes("/download"))?.[0],
    );
    expect(new URL(summaryUrl).searchParams.get("clipIds")).toBe("CLIP4,CLIP1");
  });

  it("picks every made clip at once, and lets go of them on Done", async () => {
    results({ clips: [made(1), made(2), made(3), made(4)] });
    await userEvent.click(screen.getByTestId("clip-results-select"));
    await userEvent.click(screen.getByTestId("clip-selection-all"));
    expect(screen.getByTestId("clip-selection-count")).toHaveTextContent("4 clips picked");
    await userEvent.click(screen.getByTestId("clip-results-select"));
    expect(screen.queryByTestId("clip-selection-bar")).not.toBeInTheDocument();
    await userEvent.click(
      within(screen.getByTestId("clip-grid")).getAllByRole("button")[0] as HTMLElement,
    );
    expect(await screen.findByTestId("clip-detail")).toBeInTheDocument();
  });
});

describe("HookTitlesSwitch", () => {
  it("turns Autopilot's hook titles off for the run, and says the videos are made again", async () => {
    const { fetchMock } = renderWithProviders(<HookTitlesSwitch runId={RUN} enabled canChange />, {
      routes: { [`/repurpose/runs/${RUN}/hook-titles`]: { enabled: false, changed: 140 } },
    });
    expect(screen.getByTestId("hook-titles")).toHaveTextContent("Hook titles are on");
    await userEvent.click(screen.getByTestId("hook-titles-toggle"));
    expect(await screen.findByTestId("hook-titles-done")).toHaveTextContent(
      "140 videos are being made again.",
    );
    const put = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/hook-titles"));
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ enabled: false });
  });

  it("only says so to someone who cannot change it", () => {
    renderWithProviders(<HookTitlesSwitch runId={RUN} enabled={false} canChange={false} />);
    expect(screen.getByTestId("hook-titles")).toHaveTextContent("Hook titles are off");
    expect(screen.queryByTestId("hook-titles-toggle")).not.toBeInTheDocument();
  });
});
