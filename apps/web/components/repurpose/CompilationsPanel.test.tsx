import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RepurposeCandidateItem, RepurposeClipItem } from "@montaj/api-client";

import { CompilationsPanel } from "./CompilationsPanel";

import { renderWithProviders } from "@/test/harness";

const RUN = "01JCRN0000000000000000000A";
const LIST = `/repurpose/runs/${RUN}/compilations`;
const SERIES = `/repurpose/runs/${RUN}/series`;

const candidates: RepurposeCandidateItem[] = [
  { id: "c1", startMs: 0, endMs: 30_000, title: "The opening" },
  { id: "c2", startMs: 60_000, endMs: 90_000, title: "The money bit" },
];
const clips: RepurposeClipItem[] = [
  { id: "k1", candidateId: "c1", state: "ready" },
  { id: "k2", candidateId: "c2", state: "ready" },
];

function compilation(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    runId: RUN,
    shape: "9:16",
    title: "Best of",
    clipIds: ["k1", "k2"],
    status: "ready",
    failureCode: null,
    durationMs: 60_500,
    progress: null,
    playUrl: null,
    downloadUrl: null,
    expiresAt: null,
    stale: false,
    canRetry: false,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  };
}

const A = "01JCC0MP11AT10N0000000000A";
const B = "01JCC0MP11AT10N0000000000B";
const C = "01JCC0MP11AT10N0000000000C";
const D = "01JCC0MP11AT10N0000000000D";
const E = "01JCC0MP11AT10N0000000000E";

describe("<CompilationsPanel /> (2026-10-03)", () => {
  it("shows every compilation where it stands, with a player and download once made", async () => {
    renderWithProviders(
      <CompilationsPanel
        runId={RUN}
        clips={clips}
        candidates={candidates}
        building={false}
        onBuild={vi.fn()}
      />,
      {
        routes: {
          [LIST]: {
            runId: RUN,
            compilations: [
              compilation(A, {
                playUrl: "https://files.test/a.mp4?X-Amz-Expires=3600",
                downloadUrl: "https://files.test/a.mp4?dl",
              }),
              compilation(B, { status: "rendering", progress: 42 }),
              compilation(C, { status: "waiting" }),
              compilation(D, {
                status: "failed",
                failureCode: "repurpose/compilation_source_gone",
                canRetry: true,
              }),
              compilation(E, { status: "expired", canRetry: true }),
            ],
          },
          [SERIES]: { runId: RUN, series: [] },
        },
      },
    );

    const made = await screen.findByTestId(`compilation-${A}`);
    expect(within(made).getByTestId(`compilation-video-${A}`)).toHaveAttribute(
      "src",
      "https://files.test/a.mp4?X-Amz-Expires=3600",
    );
    expect(within(made).getByTestId(`compilation-download-${A}`)).toHaveAttribute(
      "href",
      "https://files.test/a.mp4?dl",
    );
    expect(within(made).getByText("Vertical 9:16 · 2 clips · 1:01")).toBeInTheDocument();
    expect(screen.getByTestId(`compilation-${B}`)).toHaveTextContent("Being made… 42%");
    expect(screen.getByTestId(`compilation-${C}`)).toHaveTextContent("Waiting for a free slot");
    expect(screen.getByTestId(`compilation-${D}`)).toHaveTextContent("A clip's video changed");
    expect(screen.getByTestId(`compilation-retry-${D}`)).toHaveTextContent("Make again");
    expect(screen.getByTestId(`compilation-${E}`)).toHaveTextContent("deleted after 7 days");
    expect(screen.queryByTestId(`compilation-retry-${A}`)).not.toBeInTheDocument();
  });

  it("offers the latest clips when a made one's clips changed, and makes it again", async () => {
    const { fetchMock } = renderWithProviders(
      <CompilationsPanel
        runId={RUN}
        clips={clips}
        candidates={candidates}
        building={false}
        onBuild={vi.fn()}
      />,
      {
        routes: {
          [LIST]: { runId: RUN, compilations: [compilation(A, { stale: true, canRetry: true })] },
          [SERIES]: { runId: RUN, series: [] },
          [`${LIST}/${A}/retry`]: compilation(A, { status: "rendering" }),
        },
      },
    );
    const retry = await screen.findByTestId(`compilation-retry-${A}`);
    expect(retry).toHaveTextContent("Make again with the latest clips");
    expect(screen.getByTestId(`compilation-${A}`)).toHaveTextContent("A clip changed since");
    fireEvent.click(retry);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`${LIST}/${A}/retry`))).toBe(
        true,
      );
    });
  });

  it("deletes a compilation only once it is confirmed", async () => {
    const { fetchMock } = renderWithProviders(
      <CompilationsPanel
        runId={RUN}
        clips={clips}
        candidates={candidates}
        building={false}
        onBuild={vi.fn()}
      />,
      {
        routes: {
          [LIST]: { runId: RUN, compilations: [compilation(A)] },
          [SERIES]: { runId: RUN, series: [] },
          [`${LIST}/${A}`]: { id: A },
        },
      },
    );
    fireEvent.click(await screen.findByTestId(`compilation-delete-${A}`));
    const deleted = (): boolean =>
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith(`${LIST}/${A}`) &&
          (init as RequestInit | undefined)?.method === "DELETE",
      );
    expect(deleted()).toBe(false);
    fireEvent.click(await screen.findByTestId(`compilation-delete-confirm-${A}`));
    await waitFor(() => {
      expect(deleted()).toBe(true);
    });
  });

  it("lists a series by part, and takes its labels off", async () => {
    const seriesId = "01JCSER1ES0000000000000000";
    const { fetchMock } = renderWithProviders(
      <CompilationsPanel
        runId={RUN}
        clips={clips}
        candidates={candidates}
        building={false}
        onBuild={vi.fn()}
      />,
      {
        routes: {
          [LIST]: { runId: RUN, compilations: [] },
          [SERIES]: {
            runId: RUN,
            series: [
              {
                id: seriesId,
                runId: RUN,
                clipIds: ["k1", "k2"],
                parts: [
                  { clipId: "k1", part: 1, labelled: 4, pending: 0 },
                  { clipId: "k2", part: 2, labelled: 1, pending: 3 },
                ],
                createdAt: "2026-10-03T00:00:00.000Z",
              },
            ],
          },
          [`${SERIES}/${seriesId}`]: { id: seriesId, restored: 5 },
        },
      },
    );
    const row = await screen.findByTestId(`series-${seriesId}`);
    expect(row).toHaveTextContent("Part 1The opening");
    expect(row).toHaveTextContent("Part 2The money bit");
    expect(row).toHaveTextContent("once those are made");
    fireEvent.click(within(row).getByTestId(`series-remove-${seriesId}`));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith(`${SERIES}/${seriesId}`) &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true);
    });
  });

  it("opens the builder, and waits for two made clips before it offers to", async () => {
    const onBuild = vi.fn();
    const routes = {
      [LIST]: { runId: RUN, compilations: [] },
      [SERIES]: { runId: RUN, series: [] },
    };
    const closed = renderWithProviders(
      <CompilationsPanel
        runId={RUN}
        clips={clips}
        candidates={candidates}
        building={false}
        onBuild={onBuild}
      />,
      { routes },
    );
    fireEvent.click(screen.getByTestId("compilation-start"));
    expect(onBuild).toHaveBeenCalled();
    closed.unmount();

    const open = renderWithProviders(
      <CompilationsPanel
        runId={RUN}
        clips={clips}
        candidates={candidates}
        building
        onBuild={onBuild}
      />,
      { routes },
    );
    expect(screen.getByTestId("compilations-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("compilation-start")).not.toBeInTheDocument();
    open.unmount();

    renderWithProviders(
      <CompilationsPanel
        runId={RUN}
        clips={[{ id: "k1", candidateId: "c1", state: "ready" }]}
        candidates={candidates}
        building={false}
        onBuild={onBuild}
      />,
      { routes },
    );
    await waitFor(() => {
      expect(screen.queryByTestId("compilations-panel")).not.toBeInTheDocument();
    });
  });
});
