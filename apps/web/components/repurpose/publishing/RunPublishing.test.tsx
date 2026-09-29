import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { RepurposeCandidateItem, RepurposeClipItem } from "@montaj/api-client";

import { RunPublishing, readyClipsOf } from "./RunPublishing";

import type { PublishingStatus } from "./use-publishing";

import { renderWithProviders } from "@/test/harness";

const RUN = "01JS0000000000000000000RUN";
const ON: PublishingStatus = {
  enabled: true,
  available: true,
  reason: null,
  message: null,
  postizUrl: "http://localhost:4007",
  channelCount: 1,
};

const candidates: RepurposeCandidateItem[] = [
  { id: "CAND-A", startMs: 0, endMs: 30_000, title: "First moment" },
  { id: "CAND-B", startMs: 40_000, endMs: 70_000, title: "Second moment" },
  { id: "CAND-C", startMs: 80_000, endMs: 99_000, title: "Removed moment", state: "rejected" },
  { id: "CAND-D", startMs: 100_000, endMs: 120_000, title: "Still cutting" },
];
const clips: RepurposeClipItem[] = [
  { id: "CLIP-A", candidateId: "CAND-A", state: "ready" },
  { id: "CLIP-B", candidateId: "CAND-B", state: "ready" },
  { id: "CLIP-C", candidateId: "CAND-C", state: "ready" },
  { id: "CLIP-D", candidateId: "CAND-D", state: "cutting" },
];

describe("readyClipsOf", () => {
  it("keeps the ready clips that were not removed, named by their moment", () => {
    expect(readyClipsOf(clips, candidates)).toEqual([
      { id: "CLIP-A", title: "First moment" },
      { id: "CLIP-B", title: "Second moment" },
    ]);
  });
});

describe("<RunPublishing />", () => {
  it("is not there while posting is switched off", async () => {
    const { fetchMock } = renderWithProviders(
      <RunPublishing runId={RUN} clips={clips} candidates={candidates} />,
      { routes: { "/publishing/status": { ...ON, enabled: false } } },
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("post-one-a-day")).not.toBeInTheDocument();
  });

  it("schedules the ticked clips, in order, on the ticked accounts", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <RunPublishing runId={RUN} clips={clips} candidates={candidates} />,
      {
        routes: {
          "/publishing/status": ON,
          "/publishing/channels": {
            status: ON,
            channels: [
              {
                id: "01JS0000000000000000CHANIG",
                provider: "instagram",
                platform: "Instagram",
                name: "Crest Mond",
                username: null,
                avatarUrl: null,
                supported: true,
                disabled: false,
                note: null,
              },
              {
                id: null,
                provider: null,
                platform: "Pinterest",
                name: "Boards",
                username: null,
                avatarUrl: null,
                supported: false,
                disabled: false,
                note: "Posting here from Aksharo is not available yet.",
              },
            ],
          },
          [`/repurpose/runs/${RUN}/posts/daily`]: { batchId: "B", posts: [], skipped: [] },
        },
      },
    );
    await user.click(await screen.findByTestId("post-one-a-day"));
    // Unsupported accounts are not offered; clips start ticked, accounts do not.
    expect(
      await screen.findByRole("checkbox", { name: "Instagram, Crest Mond" }),
    ).not.toBeChecked();
    expect(screen.queryByText(/Pinterest/)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /First moment/ })).toBeChecked();
    expect(screen.getByTestId("daily-confirm")).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "Instagram, Crest Mond" }));
    await user.click(screen.getByTestId("daily-confirm"));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input]) => new URL(String(input)).pathname === `/repurpose/runs/${RUN}/posts/daily`,
      );
      expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toEqual({
        clipIds: ["CLIP-A", "CLIP-B"],
        channelIds: ["01JS0000000000000000CHANIG"],
        time: "19:00",
        timezone: "Asia/Kolkata",
      });
    });
  });
});
