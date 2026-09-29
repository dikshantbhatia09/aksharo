/**
 * A brand kit's logo (2026-10-02): the workspace's uploaded mark, in the corner
 * the kit names, at its size, opacity and margin, for the whole clip. It lives
 * on the document as an overlay (`EdgHot.overlays`, kind `logo`), and this
 * module is the one place it becomes an `image` command, so the editor
 * preview, the browser export, the cloud render and the share viewer all put
 * it in the same place.
 *
 * **Its size.** `sizePct` of the frame's width, at the file's own aspect ratio,
 * and never taller than a quarter of the frame (a tall mark in a wide frame
 * would otherwise take a third of it). The margin is a share of the frame's
 * short side, so it looks the same from both edges.
 *
 * **Keeping off the captions.** Placed once per document and canvas, against
 * everything the captions cover while it is up. In order it:
 *
 * 1. sits in its own corner, at full size, then a little smaller (80 %, 65 %);
 * 2. failing that, moves to the other corner on the same side (top-right to
 *    bottom-right), at full size, then 80 %;
 * 3. failing that, tries the two remaining corners at full size;
 * 4. and if nothing clears the captions, keeps its own corner at full size — a
 *    logo that jumps around the frame is worse than one that brushes a caption.
 *
 * The hook title is placed after it and keeps off it, and while an end card is
 * up the corner logo fades out (the card carries its own).
 *
 * Pure: the same inputs give the same `DrawCommand` on every backend.
 */

import { type DrawCommand, type Rect } from "../commands/types.js";
import { type CanvasSize, q } from "../units.js";
import { type LogoTrack, type OverlayCorner } from "./types.js";

/** The tallest a logo is drawn, as a share of the frame's height. */
export const LOGO_MAX_HEIGHT = 0.25;

/** Sizes tried in the logo's own corner before it moves. */
const OWN_CORNER_SCALES = [1, 0.8, 0.65] as const;
/** Sizes tried in the other corner on the same side. */
const SAME_SIDE_SCALES = [1, 0.8] as const;

/** Where a logo was put: its rectangle, and whether it had to move or shrink. */
export interface LogoPlacement {
  readonly overlayId: string;
  readonly assetId: string;
  readonly dest: Rect;
  readonly corner: OverlayCorner;
  /** 1 at the kit's size; smaller when it shrank to clear the captions. */
  readonly scale: number;
  readonly opacity: number;
  readonly startMs: number;
  readonly endMs: number;
}

/** The corner across the frame vertically: top-right to bottom-right. */
function sameSide(corner: OverlayCorner): OverlayCorner {
  switch (corner) {
    case "top-left":
      return "bottom-left";
    case "top-right":
      return "bottom-right";
    case "bottom-left":
      return "top-left";
    case "bottom-right":
      return "top-right";
  }
}

/** The corner across the frame horizontally: top-right to top-left. */
function across(corner: OverlayCorner): OverlayCorner {
  switch (corner) {
    case "top-left":
      return "top-right";
    case "top-right":
      return "top-left";
    case "bottom-left":
      return "bottom-right";
    case "bottom-right":
      return "bottom-left";
  }
}

/** The logo's rectangle in `corner` at `scale` of the kit's size. */
export function logoRect(
  track: LogoTrack,
  canvas: CanvasSize,
  corner: OverlayCorner,
  scale = 1,
): Rect {
  const aspect =
    track.image.width > 0 && track.image.height > 0 ? track.image.height / track.image.width : 1;
  let width = ((canvas.width * track.sizePct) / 100) * scale;
  let height = width * aspect;
  const tallest = canvas.height * LOGO_MAX_HEIGHT * scale;
  if (height > tallest) {
    width = (width * tallest) / height;
    height = tallest;
  }
  const margin = (Math.min(canvas.width, canvas.height) * track.marginPct) / 100;
  const left = corner.endsWith("left") ? margin : canvas.width - margin - width;
  const top = corner.startsWith("top") ? margin : canvas.height - margin - height;
  return [q(left), q(top), q(left + width), q(top + height)];
}

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/**
 * Places one logo against `obstacles` (what the captions cover while it is
 * up, in canvas pixels), by the order in the module comment.
 */
export function placeLogo(
  track: LogoTrack,
  canvas: CanvasSize,
  obstacles: readonly Rect[],
): LogoPlacement {
  const attempts: readonly { corner: OverlayCorner; scale: number }[] = [
    ...OWN_CORNER_SCALES.map((scale) => ({ corner: track.corner, scale })),
    ...SAME_SIDE_SCALES.map((scale) => ({ corner: sameSide(track.corner), scale })),
    { corner: across(track.corner), scale: 1 },
    { corner: sameSide(across(track.corner)), scale: 1 },
  ];
  const chosen = attempts.find(
    ({ corner, scale }) =>
      !obstacles.some((box) => overlaps(box, logoRect(track, canvas, corner, scale))),
  ) ?? { corner: track.corner, scale: 1 };
  return {
    overlayId: track.id,
    assetId: track.image.assetId,
    dest: logoRect(track, canvas, chosen.corner, chosen.scale),
    corner: chosen.corner,
    scale: chosen.scale,
    opacity: track.opacity,
    startMs: track.startMs,
    endMs: track.endMs,
  };
}

/**
 * The logo at one instant: `fade` (0 to 1) multiplies its own opacity — the
 * end card fading in takes the corner logo out with it. Nothing when it is
 * fully faded.
 */
export function drawLogo(placement: LogoPlacement, fade = 1): DrawCommand[] {
  const opacity = placement.opacity * Math.min(1, Math.max(0, fade));
  if (opacity <= 0) return [];
  return [
    {
      kind: "image",
      assetId: placement.assetId,
      dest: placement.dest,
      ...(opacity >= 1 ? {} : { opacity: q(opacity) }),
    },
  ];
}
