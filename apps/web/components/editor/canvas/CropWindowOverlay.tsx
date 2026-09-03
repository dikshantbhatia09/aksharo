"use client";

/**
 * The current zoom/reframe crop window, drawn as a bordered box over the
 * caption stage during scrub (B20b) — passed as `CaptionStage`'s `children`
 * (the extension point B20 left for "proposal overlays"), so this component
 * never touches `CaptionStage.tsx` itself.
 *
 * `cropRect` is `null` whenever the current instant has no accepted zoom/
 * reframe item active — nothing is drawn. The rectangle is always drawn
 * (this is the crop-window-only fallback the brief allows: "the crop
 * rectangle only" when real CanvasKit frames are not available for the
 * scrub preview); a caller with real frames draws those separately and can
 * still overlay this for the "what will be kept" boundary.
 */
import { cropRectToBox, type StageFit } from "./stage-geometry";

export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface CropWindowOverlayProps {
  readonly cropRect: CropRect | null;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly fit: StageFit;
  readonly className?: string;
}

export function CropWindowOverlay(props: CropWindowOverlayProps): React.JSX.Element | null {
  const { cropRect, canvas, fit, className } = props;
  if (cropRect === null || fit.scale === 0) return null;

  const box = cropRectToBox(cropRect, canvas);
  const left = fit.left + box[0] * fit.scale;
  const top = fit.top + box[1] * fit.scale;
  const width = (box[2] - box[0]) * fit.scale;
  const height = (box[3] - box[1]) * fit.scale;

  return (
    <div
      data-testid="crop-window-overlay"
      className={className}
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        border: "2px solid #7c8ff0",
        boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
        pointerEvents: "none",
      }}
    />
  );
}
