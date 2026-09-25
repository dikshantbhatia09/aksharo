import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClipPreview } from "./ClipPreview";

import { renderWithProviders } from "@/test/harness";

const EXPORT_ROUTE = "/projects/01CLIPPROJECT/transcript/export";
const VTT = ["WEBVTT", "", "00:00:00.200 --> 00:00:01.300", "Its an editorial", ""].join("\n");

describe("<ClipPreview />", () => {
  beforeEach(() => {
    // jsdom has no object URLs.
    URL.createObjectURL = vi.fn(() => "blob:clip-captions");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 2026-09-25: the clip's captions used to be burned into the video. The
  // picture is clean now, and the preview lays the clip project's own captions
  // over it as a text track.
  it("plays the clean clip with the clip project's captions as a text track", async () => {
    const { fetchMock } = renderWithProviders(
      <ClipPreview videoUrl="https://media.test/master.mp4" projectId="01CLIPPROJECT" testId="clip" />,
      {
        routes: {
          [EXPORT_ROUTE]: new Response(VTT, { status: 200, headers: { "content-type": "text/vtt" } }),
        },
      },
    );

    expect(screen.getByTestId("clip")).toHaveAttribute("src", "https://media.test/master.mp4");
    await waitFor(() => {
      expect(screen.getByTestId("clip-captions")).toHaveAttribute("src", "blob:clip-captions");
    });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(EXPORT_ROUTE);
    expect(url.searchParams.get("format")).toBe("vtt");
    expect(screen.getByTestId("clip-captions")).toHaveAttribute("kind", "captions");
  });

  it("still plays, without captions, when they cannot be fetched", async () => {
    const { fetchMock } = renderWithProviders(
      <ClipPreview videoUrl="https://media.test/master.mp4" projectId="01CLIPPROJECT" testId="clip" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId("clip")).toBeInTheDocument();
    expect(screen.queryByTestId("clip-captions")).not.toBeInTheDocument();
  });

  it("asks for nothing when the clip has no project yet", () => {
    const { fetchMock } = renderWithProviders(
      <ClipPreview videoUrl="https://media.test/master.mp4" projectId={undefined} testId="clip" />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("clip")).toBeInTheDocument();
  });
});
