import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CaptionStage } from "./CaptionStage";

const mockSurface = {
  getCanvas: vi.fn(),
  flush: vi.fn(),
  delete: vi.fn(),
};

const mockBackend = {
  drawFrame: vi.fn(),
  registerImage: vi.fn(),
  ck: {
    MakeWebGLCanvasSurface: () => mockSurface,
    MakeSWCanvasSurface: () => mockSurface,
  },
};

const mockEngine = {
  registry: {},
  shaper: {},
};

vi.mock("./use-canvaskit", () => ({
  useRenderer: () => ({
    backend: mockBackend,
    engine: mockEngine,
    error: undefined,
    loading: false,
  }),
}));

vi.mock("@montaj/render-core", () => ({
  renderFrame: vi.fn(() => []),
  layoutFrame: vi.fn(() => [
    {
      layout: {
        segmentId: "seg-1",
        paddedBox: { x: 10, y: 10, width: 200, height: 50 },
        fontSizePx: 24,
        words: [
          { wid: "0:0", text: "Direct", box: [10, 10, 70, 35] },
          { wid: "0:1", text: "Canvas", box: [80, 10, 140, 35] },
        ],
      },
    },
  ]),
  PlacementCache: class {},
}));

const PROJECTION = {
  canvas: { width: 1080, height: 1920 },
  segments: [],
} as never;

function stage(props: Partial<React.ComponentProps<typeof CaptionStage>> = {}) {
  return <CaptionStage src="blob:video" projection={PROJECTION} catalogue={new Map()} {...props} />;
}

describe("CaptionStage canvas word-level editing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders canvas word overlays for direct in-preview interaction", () => {
    render(stage());

    expect(screen.getByTestId("canvas-word-overlays")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-word-0:0")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-word-0:1")).toBeInTheDocument();
  });

  it("clicking a word chip on canvas enters direct editing mode and calls onSelectWord", () => {
    const onSelectWord = vi.fn();
    render(stage({ onSelectWord }));

    const chip = screen.getByTestId("canvas-word-0:0");
    fireEvent.click(chip);

    expect(onSelectWord).toHaveBeenCalledWith("0:0");
    const input = screen.getByTestId("canvas-word-input-0:0");
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("Direct");
  });

  it("committing an edit via Enter calls onEditWord and exits editing mode", () => {
    const onEditWord = vi.fn();
    render(stage({ onEditWord }));

    fireEvent.click(screen.getByTestId("canvas-word-0:0"));
    const input = screen.getByTestId("canvas-word-input-0:0");

    fireEvent.change(input, { target: { value: "Updated" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onEditWord).toHaveBeenCalledWith("0:0", "Updated");
    expect(screen.queryByTestId("canvas-word-input-0:0")).not.toBeInTheDocument();
    expect(screen.getByTestId("canvas-word-0:0")).toBeInTheDocument();
  });

  it("pressing Escape exits direct editing without calling onEditWord", () => {
    const onEditWord = vi.fn();
    render(stage({ onEditWord }));

    fireEvent.click(screen.getByTestId("canvas-word-0:0"));
    const input = screen.getByTestId("canvas-word-input-0:0");

    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onEditWord).not.toHaveBeenCalled();
    expect(screen.queryByTestId("canvas-word-input-0:0")).not.toBeInTheDocument();
  });
});
