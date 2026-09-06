import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CaptionStage, displayScriptOf } from "./CaptionStage";

// EXACT specifier copied from CaptionStage.tsx's own import of useRenderer
// (`import { useRenderer } from "./use-canvaskit";`, CaptionStage.tsx:40).
vi.mock("./use-canvaskit", () => ({
  useRenderer: () => ({ backend: undefined, engine: undefined, error: undefined, loading: true }),
}));

const PROJECTION = {
  canvas: { width: 1080, height: 1920 },
  segments: [],
} as never; // the transport never reads deeper than `canvas` while the renderer is loading

function stage(props: Partial<React.ComponentProps<typeof CaptionStage>> = {}) {
  return <CaptionStage src="blob:video" projection={PROJECTION} catalogue={new Map()} {...props} />;
}

describe("CaptionStage transport (FIX-02)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("plays and pauses the element from the `playing` prop", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined as never);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const view = render(stage({ playing: true }));
    expect(play).toHaveBeenCalledTimes(1);
    view.rerender(stage({ playing: false }));
    expect(pause).toHaveBeenCalled();
  });

  it("reports a blocked play() instead of pretending", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("no gesture"));
    const onPlayBlocked = vi.fn();
    render(stage({ playing: true, onPlayBlocked }));
    // Testing Library's `waitFor` (not `vi.waitFor`): jsdom has no
    // `requestVideoFrameCallback`, so the clock effect falls back to `rAF` and
    // its `setOutputMs` lands while this test awaits. RTL's wrapper runs the
    // polling inside `act`, which is what keeps that update from warning.
    await waitFor(() => expect(onPlayBlocked).toHaveBeenCalledWith("no gesture"));
  });

  it("applies exactly one seek per seekSeq bump and none on mount", () => {
    const set = vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set");
    const view = render(stage({ seekMs: 5_000, seekSeq: 0 }));
    expect(set).not.toHaveBeenCalled();
    view.rerender(stage({ seekMs: 5_000, seekSeq: 1 }));
    expect(set).toHaveBeenCalledWith(5);
    view.rerender(stage({ seekMs: 5_000, seekSeq: 1 }));
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("renders a placeholder, not a video element, when src is undefined", () => {
    const view = render(stage({ src: undefined }));
    expect(view.queryByTestId("caption-stage-video")).toBeNull();
    expect(view.getByTestId("caption-stage-no-media")).toBeInTheDocument();
  });
});

/**
 * The script strip drove the transcript list only: `CaptionStage` had no
 * `script` prop at all, so `renderFrame` fell back to "roman" and the captions
 * ON THE VIDEO never changed when the user switched Roman/Native/EN.
 */
describe("displayScriptOf (the strip's selection, narrowed for the renderer)", () => {
  it("passes through the scripts a word can actually carry", () => {
    expect(displayScriptOf("native")).toBe("native");
    expect(displayScriptOf("en")).toBe("en");
    expect(displayScriptOf("roman")).toBe("roman");
  });

  it("draws the transcript's own text for anything else", () => {
    expect(displayScriptOf(undefined)).toBe("roman");
    expect(displayScriptOf("translated")).toBe("roman");
  });
});
