import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DOWNLOAD_ALL_COPY, contentsWords } from "./download-copy";
import { RunDownloadAll } from "./RunDownloadAll";

import type { RunDownloadSummary } from "./use-run-download";

import { beginnerSafetyViolations } from "@/components/repurpose/copy";
import { renderWithProviders } from "@/test/harness";

const started = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("./start-download", () => ({
  startDownload: (url: string) => {
    started.urls.push(url);
  },
}));

const RUN = "01JS0000000000000000000RUN";
const PATH = `/repurpose/runs/${RUN}/download`;
const GIB = 1024 ** 3;

const SUMMARY: RunDownloadSummary = {
  clips: 35,
  clipsComing: 2,
  videos: 140,
  dubbedVideos: 4,
  images: 385,
  texts: 36,
  bytes: 3.4 * GIB,
  cleanVideos: 144,
  bytesWithClean: 5.1 * GIB,
  filename: "The Psychology Of Seduction.zip",
};

const LINK = "https://api.aksharo.test/repurpose/downloads/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

/** The summary for GET, the link for POST (same path), recording what POST sent. */
function render(summary: RunDownloadSummary | Response = SUMMARY) {
  const posted: unknown[] = [];
  const view = renderWithProviders(<RunDownloadAll runId={RUN} />);
  view.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname !== PATH) {
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    if ((init?.method ?? "GET") === "POST") {
      posted.push(JSON.parse(String(init?.body)) as unknown);
      return Promise.resolve(
        new Response(JSON.stringify({ url: LINK, expiresAt: "2026-10-01T10:05:00.000Z" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      summary instanceof Response
        ? summary
        : new Response(JSON.stringify(summary), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
  });
  return { ...view, posted };
}

describe("RunDownloadAll", () => {
  it("says what the ZIP holds and how big it is, before anything starts", async () => {
    render();
    await userEvent.click(screen.getByTestId("download-all-open"));

    expect(await screen.findByTestId("download-all-contents")).toHaveTextContent(
      "35 clips · 140 videos · 4 dubbed videos · 385 images · 36 text files",
    );
    expect(screen.getByTestId("download-all-coming")).toHaveTextContent(
      "2 clips are still being made",
    );
    expect(screen.getByTestId("download-all-size")).toHaveTextContent("Size: 3.4 GB");
    expect(screen.getByText(/adds 1\.7 GB/)).toBeInTheDocument();
    expect(started.urls).toEqual([]);
  });

  it("starts the download from a single-use link, with the clean versions when asked", async () => {
    started.urls.length = 0;
    const { posted } = render();
    await userEvent.click(screen.getByTestId("download-all-open"));
    await screen.findByTestId("download-all-contents");

    await userEvent.click(screen.getByTestId("download-all-clean"));
    expect(screen.getByTestId("download-all-size")).toHaveTextContent("Size: 5.1 GB");
    await userEvent.click(screen.getByTestId("download-all-start"));

    await waitFor(() => {
      expect(started.urls).toEqual([LINK]);
    });
    expect(posted).toEqual([{ includeClean: true }]);
    expect(screen.getByTestId("download-all-started")).toHaveTextContent(DOWNLOAD_ALL_COPY.started);
  });

  it("says plainly when nothing is finished yet", async () => {
    render(
      new Response(
        JSON.stringify({
          error: { code: "repurpose/nothing_to_download", message: "No clip is finished." },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    await userEvent.click(screen.getByTestId("download-all-open"));
    expect(await screen.findByTestId("download-all-error")).toHaveTextContent(
      "No clip of this video is finished yet.",
    );
    expect(screen.getByTestId("download-all-start")).toBeDisabled();
  });

  it("uses no word a beginner should never see", () => {
    const words = [
      ...Object.values(DOWNLOAD_ALL_COPY).filter((value) => typeof value === "string"),
      DOWNLOAD_ALL_COPY.coming(1),
      DOWNLOAD_ALL_COPY.coming(3),
      contentsWords(SUMMARY),
    ].join(" ");
    expect(beginnerSafetyViolations(words)).toEqual([]);
  });
});
