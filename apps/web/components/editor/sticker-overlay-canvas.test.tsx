import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { StickerOverlayCanvas } from "./sticker-overlay-canvas";
import type { StageFit } from "./canvas/stage-geometry";

describe("<StickerOverlayCanvas />", () => {
  const dummyFit: StageFit = {
    left: 100,
    top: 50,
    width: 540,
    height: 960,
    scale: 0.5,
  };

  const dummyCanvas = {
    width: 1080,
    height: 1920,
  };

  const dummySticker = {
    id: "sticker-arrow-01",
    url: "https://assets.aksharo.com/stickers/curated/arrow.webm",
    title: "Glowing Red Arrow",
    isTransparent: true,
  };

  it("renders sticker gizmo root and video element on canvas", () => {
    render(
      <StickerOverlayCanvas
        sticker={dummySticker}
        canvas={dummyCanvas}
        fit={dummyFit}
        x={0.5}
        y={0.5}
        scale={1.0}
        rotation={0}
      />,
    );

    const root = screen.getByTestId("sticker-overlay-canvas-root");
    expect(root).toBeDefined();

    const video = screen.getByTestId("sticker-gizmo-video");
    expect(video).toBeDefined();
    expect(video.getAttribute("src")).toContain("arrow.webm");

    // Transform badge readout
    expect(screen.getByTestId("sticker-transform-badge")).toBeDefined();
    expect(screen.getByText("50%, 50%")).toBeDefined();
    expect(screen.getByText("1.0x")).toBeDefined();
  });

  it("renders image tag for static or GIF sticker formats", () => {
    render(
      <StickerOverlayCanvas
        sticker={{
          id: "meme-nick-young",
          url: "https://media.giphy.com/media/nick.gif",
          title: "Nick Young",
        }}
        canvas={dummyCanvas}
        fit={dummyFit}
      />,
    );

    const img = screen.getByTestId("sticker-gizmo-image");
    expect(img).toBeDefined();
    expect(img.getAttribute("src")).toContain("nick.gif");
  });

  it("fires onChange on center pointer dragging", () => {
    const onChange = vi.fn();
    render(
      <StickerOverlayCanvas
        sticker={dummySticker}
        canvas={dummyCanvas}
        fit={dummyFit}
        x={0.5}
        y={0.5}
        onChange={onChange}
      />,
    );

    const centerHandle = screen.getByTestId("sticker-drag-handle-center");
    fireEvent.pointerDown(centerHandle, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(centerHandle, { clientX: 254, clientY: 296, pointerId: 1 });
    fireEvent.pointerUp(centerHandle, { pointerId: 1 });

    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls.at(-1)?.[0];
    expect(lastCall.x).toBeGreaterThan(0.5);
    expect(lastCall.y).toBeGreaterThan(0.5);
  });

  it("fires onDelete when delete icon is clicked", () => {
    const onDelete = vi.fn();
    render(
      <StickerOverlayCanvas
        sticker={dummySticker}
        canvas={dummyCanvas}
        fit={dummyFit}
        onDelete={onDelete}
      />,
    );

    const deleteBtn = screen.getByTestId("sticker-delete-button");
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalled();
  });

  it("fires reset to 1.0x scale and 0deg rotation on reset button click", () => {
    const onChange = vi.fn();
    render(
      <StickerOverlayCanvas
        sticker={dummySticker}
        canvas={dummyCanvas}
        fit={dummyFit}
        scale={2.2}
        rotation={45}
        onChange={onChange}
      />,
    );

    const resetBtn = screen.getByTestId("sticker-reset-button");
    fireEvent.click(resetBtn);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        scale: 1.0,
        rotation: 0,
      }),
    );
  });
});
