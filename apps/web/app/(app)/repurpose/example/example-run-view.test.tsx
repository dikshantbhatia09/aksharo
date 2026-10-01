import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { EXAMPLE_COPY, ExampleRunViewPage } from "./example-run-view";

import type { ExampleRunView } from "@/components/repurpose/example/use-example-run";

import { beginnerSafetyViolations } from "@/components/repurpose/copy";
import { EXAMPLE_LINK_COPY } from "@/components/repurpose/example/ExampleRunLink";
import { renderWithProviders } from "@/test/harness";

/**
 * `/repurpose/example` (2026-10-01): the owner's finished example run, read
 * only. These hold what the page offers (watch, download one clip, the
 * analysis and words) and what it never does (rename, pick, edit, call any
 * route of the run's own workspace).
 */
function clip(n: number) {
  return {
    id: `K${String(n)}`,
    candidateId: `C${String(n)}`,
    title: `Clip ${String(n)}`,
    state: "ready" as const,
    failureCode: null,
    mezzanineUrl: null,
    variants: [],
    captioned: {
      status: "ready" as const,
      playUrl: `https://media.test/k${String(n)}.mp4`,
      downloadUrl: `https://media.test/k${String(n)}.mp4?download`,
      durationMs: 31_000,
    },
    formats: [
      {
        shape: "9:16" as const,
        status: "ready" as const,
        projectId: null,
        captioned: {
          status: "ready" as const,
          playUrl: `https://media.test/k${String(n)}.mp4`,
          downloadUrl: `https://media.test/k${String(n)}.mp4?download`,
          durationMs: 31_000,
        },
        cleanUrl: null,
      },
      {
        shape: "1:1" as const,
        status: "ready" as const,
        projectId: null,
        captioned: {
          status: "ready" as const,
          playUrl: `https://media.test/k${String(n)}-sq.mp4`,
          downloadUrl: `https://media.test/k${String(n)}-sq.mp4?download`,
          durationMs: 31_000,
        },
        cleanUrl: null,
      },
    ],
    images: {
      status: "ready" as const,
      files: [
        {
          id: "vertical-image",
          width: 1080,
          height: 1920,
          items: [{ url: `https://media.test/v${String(n)}.jpg`, downloadUrl: "d" }],
        },
      ],
    },
    copy: {},
  };
}

function candidate(n: number) {
  return {
    id: `C${String(n)}`,
    startMs: n * 60_000,
    endMs: n * 60_000 + 30_000,
    rank: n,
    potentialScore: 90 - n,
    title: `Moment ${String(n)}`,
    transcriptExcerpt: `Words of moment ${String(n)}.`,
    reasons: [{ label: "hook", explanation: "Opens on a question" }],
    scoreBreakdown: { hook: 80, clarity: 70 },
    copy: {},
    judgement: null,
    state: "proposed",
  };
}

const VIEW: ExampleRunView = {
  available: true,
  run: {
    title: "How compounding works",
    source: "link",
    automation: "auto",
    processedMs: 600_000,
    clipCount: 4,
  },
  candidates: [1, 2, 3, 4].map(candidate),
  clips: [1, 2, 3, 4].map(clip),
  transcripts: {
    C1: { offsetMs: 0, lines: [{ startMs: 60_000, endMs: 62_000, text: "Money grows." }] },
  },
  urlsExpireAt: "2026-10-01T12:00:00.000Z",
};

describe("<ExampleRunViewPage />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = "";
  });

  it("says there is no example while none is set, and points to starting one", async () => {
    renderWithProviders(<ExampleRunViewPage />, {
      routes: { "/repurpose/example": { available: false } },
    });
    expect(await screen.findByTestId("example-run-none")).toHaveTextContent(EXAMPLE_COPY.noneTitle);
    expect(screen.getByRole("link", { name: EXAMPLE_COPY.start })).toHaveAttribute(
      "href",
      "/repurpose/new",
    );
  });

  it("treats a refusal as no example", async () => {
    renderWithProviders(<ExampleRunViewPage />);
    expect(await screen.findByTestId("example-run-none")).toBeInTheDocument();
  });

  it("shows the clips with the banner, and nothing that changes them", async () => {
    const { fetchMock } = renderWithProviders(<ExampleRunViewPage />, {
      routes: { "/repurpose/example": VIEW },
    });
    expect(await screen.findByTestId("example-run")).toHaveTextContent("How compounding works");
    const banner = screen.getByTestId("example-run-banner");
    expect(banner).toHaveTextContent(EXAMPLE_COPY.banner);
    expect(within(banner).getByTestId("example-run-start")).toHaveAttribute(
      "href",
      "/repurpose/new",
    );
    // Four finished clips: the grid, best first.
    const tiles = within(screen.getByTestId("clip-grid")).getAllByRole("button");
    expect(tiles).toHaveLength(4);
    expect(screen.queryByTestId("clip-results-select")).toBeNull();

    await userEvent.click(tiles[0] as HTMLElement);
    const detail = await screen.findByTestId("clip-detail");
    expect(within(detail).getByTestId("clip-transcript")).toHaveTextContent("Money grows.");
    expect(within(detail).queryByTestId("clip-detail-rename")).toBeNull();
    expect(within(detail).queryByTestId("clip-detail-edit")).toBeNull();
    expect(within(detail).getByTestId("example-clip-download-C1")).toHaveAttribute(
      "href",
      "https://media.test/k1.mp4?download",
    );
    // Every size, with no editor link and no clean cut.
    const formats = within(detail).getByTestId("clip-formats-C1");
    expect(within(formats).queryByText("Edit")).toBeNull();
    expect(within(formats).queryByText(/without captions/i)).toBeNull();

    const asked = fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(asked.every((path) => path === "/repurpose/example")).toBe(true);
  });

  it("speaks plainly", () => {
    for (const text of [...Object.values(EXAMPLE_COPY), ...Object.values(EXAMPLE_LINK_COPY)]) {
      expect(beginnerSafetyViolations(text)).toEqual([]);
    }
  });
});
