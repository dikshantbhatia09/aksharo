import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CaptionStage } from "./CaptionStage";

/**
 * One renderer for the page, as `useRenderer` gives every stage the same one;
 * no surface can be made in jsdom, so nothing is drawn.
 */
const backend = {
  registerImage: vi.fn(),
  ck: { MakeWebGLCanvasSurface: () => null, MakeSWCanvasSurface: () => null },
};

vi.mock("./use-canvaskit", () => ({
  useRenderer: () => ({ backend, engine: undefined, error: undefined, loading: false }),
}));

const PROJECTION = { canvas: { width: 1080, height: 1920 }, segments: [] } as never;

function stage(props: Partial<React.ComponentProps<typeof CaptionStage>> = {}) {
  return <CaptionStage src="blob:video" projection={PROJECTION} catalogue={new Map()} {...props} />;
}

describe("CaptionStage and a brand kit's logos (2026-10-02)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    backend.registerImage.mockReset();
  });

  it("fetches each logo once for the page and registers it with the shared renderer", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const images = { "01JLOGOA00000000000000000A": "https://cdn.example.test/a.png" };
    const first = render(stage({ images }));
    await waitFor(() => expect(backend.registerImage).toHaveBeenCalledTimes(1));
    expect(backend.registerImage).toHaveBeenCalledWith(
      "01JLOGOA00000000000000000A",
      new Uint8Array([1, 2, 3]),
    );
    // A second stage, and a new map with the same logo: nothing fetched again.
    render(stage({ images: { ...images } }));
    first.rerender(stage({ images: { ...images } }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forgets a logo it could not fetch, so a fresh URL can try again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn(async () => new Response("gone", { status: 403 }));
    vi.stubGlobal("fetch", failing);
    const view = render(stage({ images: { "01JLOGOB00000000000000000B": "https://x/expired" } }));
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(backend.registerImage).not.toHaveBeenCalled();

    const working = vi.fn(async () => new Response(new Uint8Array([9])));
    vi.stubGlobal("fetch", working);
    view.rerender(stage({ images: { "01JLOGOB00000000000000000B": "https://x/fresh" } }));
    await waitFor(() => expect(backend.registerImage).toHaveBeenCalledTimes(1));
    warn.mockRestore();
  });

  it("draws a sample frame behind the overlay when there is no video", () => {
    const view = render(stage({ src: undefined, backdrop: <div data-testid="sample" /> }));
    expect(view.getByTestId("caption-stage-backdrop")).toBeInTheDocument();
    expect(view.getByTestId("sample")).toBeInTheDocument();
    expect(view.queryByTestId("caption-stage-no-media")).toBeNull();
  });
});
