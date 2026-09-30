/**
 * B-roll (2026-10-05): a still picture cut away to over the words that name
 * it - over the whole frame, covering the speaker, or in a box beside them -
 * moving slowly (a push in, a pull out or a pan) and fading in and out. It
 * lives on the document as an overlay (`EdgHot.overlays`, kind `b-roll`), and
 * this module is the one place it becomes `DrawCommand`s, so the editor
 * preview, the browser export, the cloud render and the share viewer all draw
 * the same cutaway. The render cannot decode a second video, so a cutaway is
 * always a picture.
 *
 * **Under everything else.** `renderFrame` draws cutaways first: every caption,
 * and a logo, a hook title or an end card, is drawn over them.
 *
 * **Giving way.** While a hook title (a series label is one) or an end card is
 * up, a cutaway is not: it fades out over {@link BROLL_FADE_MS} before one
 * starts and back in after it ends ({@link brollOpacity}). Autopilot and the
 * editor never place one there (`@montaj/edg` `planBroll`); this is for a title
 * or a card added afterwards.
 *
 * **Its motion** is linear over its whole window, so it never lurches: a push
 * in grows the picture from 100 % to {@link BROLL_ZOOM} of the size that covers
 * its frame, a pull out the reverse, and a pan holds it at {@link BROLL_ZOOM}
 * and slides it across at most {@link BROLL_PAN_TRAVEL} of the frame's width.
 *
 * **Full frame**: the picture covers the frame (scaled until it fills both
 * axes, centred, cropped) and is clipped to it.
 *
 * **Picture in picture**: a box {@link PIP_WIDTH} of the frame's short side
 * wide, at the picture's own shape held between 3:4 and 4:3, with rounded
 * corners and a soft shadow; the picture covers the box and moves inside it.
 * The box takes the first of top right, top left, middle right, middle left,
 * bottom right and bottom left that clears the faces and the captions shown
 * while it is up (and a logo), and the top right when none does. Placed once
 * per cutaway (per projection, canvas and face track), like a logo.
 *
 * Pure: the same inputs give the same `DrawCommand[]` on every backend.
 */

import { clip, clipRect, fill, group, image, roundRect, shadow } from "../commands/build.js";
import { type DrawCommand, type Rect } from "../commands/types.js";
import { type CanvasFaceTrack, facesDuring, type FacePadding } from "../frame/placement.js";
import { type CanvasSize, clamp01, q } from "../units.js";
import { type BRollMode, type BRollMotion, type BRollTrack, type OverlayTrack } from "./types.js";

/** How long a cutaway fades in and out; `@montaj/edg`'s `BROLL_RULES.fadeMs`. */
export const BROLL_FADE_MS = 250;

/** How far a push in grows the picture, and the size a pan holds it at. */
export const BROLL_ZOOM = 1.08;

/** The farthest a pan slides the picture, as a share of the frame's width. */
export const BROLL_PAN_TRAVEL = 0.12;

/** A picture-in-picture box's width, as a share of the frame's short side. */
export const PIP_WIDTH = 0.44;

/** The box's distance from the frame's edges, as a share of the short side. */
const PIP_MARGIN = 0.05;

/** A vertical frame keeps its box below the platforms' own top chrome, and above their bottom. */
const PORTRAIT_TOP = 0.09;
const PORTRAIT_BOTTOM = 0.2;

/** The box's corner radius, as a share of the short side. */
const PIP_RADIUS = 0.03;

/** The box's shape is the picture's, held between these (width over height). */
const PIP_MIN_ASPECT = 3 / 4;
const PIP_MAX_ASPECT = 4 / 3;

/** A face is kept out of the box with a little hair above it, as a hook title does. */
const PIP_FACE_PADDING: FacePadding = { above: 0.12, below: 0.05, sides: 0.06 };

/** Where the box may go, in the order they are tried. */
export const PIP_SLOTS = [
  "top-right",
  "top-left",
  "middle-right",
  "middle-left",
  "bottom-right",
  "bottom-left",
] as const;

export type PipSlot = (typeof PIP_SLOTS)[number];

/** A placed cutaway: what {@link drawBRoll} draws, frame after frame. */
export interface BRollLayout {
  readonly overlayId: string;
  readonly assetId: string;
  readonly mode: BRollMode;
  readonly motion: BRollMotion;
  /** What the picture fills: the whole canvas, or the box. */
  readonly frame: Rect;
  /** The box's slot; absent for a full-frame cutaway. */
  readonly slot?: PipSlot;
  /** The picture's size that covers `frame` exactly, before any motion. */
  readonly coverWidth: number;
  readonly coverHeight: number;
  /** The canvas's short side: what the box's corners and shadow are sized by. */
  readonly shortSide: number;
  readonly startMs: number;
  readonly endMs: number;
}

export interface BRollLayoutInput {
  readonly overlay: BRollTrack;
  readonly canvas: CanvasSize;
  /** Where the faces are, mapped onto the canvas; absent means none to keep the box off. */
  readonly faces?: CanvasFaceTrack;
  /** What else the box keeps off while it is up (the captions, a logo), in canvas pixels. */
  readonly obstacles?: readonly Rect[];
}

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** The picture's size that covers a `width` by `height` frame: scaled until it fills both. */
function coverSize(
  picture: { readonly width: number; readonly height: number },
  width: number,
  height: number,
): { readonly width: number; readonly height: number } {
  if (picture.width <= 0 || picture.height <= 0) return { width, height };
  const scale = Math.max(width / picture.width, height / picture.height);
  return { width: picture.width * scale, height: picture.height * scale };
}

/** The box a picture-in-picture cutaway is drawn in, in `slot`. */
export function pipRect(track: BRollTrack, canvas: CanvasSize, slot: PipSlot): Rect {
  const short = Math.min(canvas.width, canvas.height);
  const width = short * PIP_WIDTH;
  const shape =
    track.image.width > 0 && track.image.height > 0 ? track.image.width / track.image.height : 1;
  const height = width / Math.min(PIP_MAX_ASPECT, Math.max(PIP_MIN_ASPECT, shape));
  const margin = short * PIP_MARGIN;
  const portrait = canvas.height > canvas.width;
  const topEdge = portrait ? Math.max(margin, canvas.height * PORTRAIT_TOP) : margin;
  const bottomEdge = portrait ? Math.max(margin, canvas.height * PORTRAIT_BOTTOM) : margin;
  const left = slot.endsWith("left") ? margin : canvas.width - margin - width;
  const top = slot.startsWith("top")
    ? topEdge
    : slot.startsWith("bottom")
      ? canvas.height - bottomEdge - height
      : (canvas.height - height) / 2;
  return [q(left), q(top), q(left + width), q(top + height)];
}

/**
 * Places one cutaway: a full-frame one fills the canvas; a picture-in-picture
 * one takes the first slot that clears the faces and `obstacles` while it is
 * up, else the top right (see the module comment).
 */
export function layoutBRoll(input: BRollLayoutInput): BRollLayout {
  const { overlay, canvas } = input;
  let frame: Rect = [0, 0, canvas.width, canvas.height];
  let slot: PipSlot | undefined;
  if (overlay.mode === "pip") {
    const blocked = [
      ...(input.faces === undefined
        ? []
        : facesDuring(input.faces, overlay.startMs, overlay.endMs, canvas, PIP_FACE_PADDING)),
      ...(input.obstacles ?? []),
    ];
    slot =
      PIP_SLOTS.find((candidate) => {
        const box = pipRect(overlay, canvas, candidate);
        return !blocked.some((obstacle) => overlaps(obstacle, box));
      }) ?? "top-right";
    frame = pipRect(overlay, canvas, slot);
  }
  const cover = coverSize(overlay.image, frame[2] - frame[0], frame[3] - frame[1]);
  return {
    overlayId: overlay.id,
    assetId: overlay.image.assetId,
    mode: overlay.mode,
    motion: overlay.motion,
    frame,
    ...(slot === undefined ? {} : { slot }),
    coverWidth: cover.width,
    coverHeight: cover.height,
    shortSide: Math.min(canvas.width, canvas.height),
    startMs: overlay.startMs,
    endMs: overlay.endMs,
  };
}

/** 1 inside `[start, end)`, ramping to 0 over `fadeMs` just outside it. */
function presence(sourceMs: number, startMs: number, endMs: number, fadeMs: number): number {
  if (sourceMs >= startMs && sourceMs < endMs) return 1;
  const distance = sourceMs < startMs ? startMs - sourceMs : sourceMs - endMs;
  return fadeMs <= 0 ? 0 : clamp01(1 - distance / fadeMs);
}

/**
 * How visible a cutaway is at `sourceMs`: faded in over its first
 * {@link BROLL_FADE_MS} and out over its last (each at most a third of it),
 * and faded out around every hook title and end card among `overlays`. 0
 * outside its own window.
 */
export function brollOpacity(
  track: Pick<BRollTrack, "startMs" | "endMs">,
  sourceMs: number,
  overlays: readonly OverlayTrack[] = [],
): number {
  if (sourceMs < track.startMs || sourceMs >= track.endMs) return 0;
  const fade = Math.min(BROLL_FADE_MS, (track.endMs - track.startMs) / 3);
  const own =
    fade <= 0
      ? 1
      : Math.min(
          clamp01((sourceMs - track.startMs) / fade),
          clamp01((track.endMs - sourceMs) / fade),
        );
  let blocked = 0;
  for (const overlay of overlays) {
    if (overlay.kind !== "hook-title" && overlay.kind !== "end-card") continue;
    blocked = Math.max(blocked, presence(sourceMs, overlay.startMs, overlay.endMs, BROLL_FADE_MS));
  }
  return own * (1 - blocked);
}

/** How far through its window a cutaway is, 0 to 1. */
function progress(layout: BRollLayout, sourceMs: number): number {
  const length = layout.endMs - layout.startMs;
  return length <= 0 ? 0 : clamp01((sourceMs - layout.startMs) / length);
}

/**
 * Where the picture is drawn at `sourceMs`: the cover size, grown by the
 * motion, centred on the frame and, for a pan, slid across it.
 */
export function brollPictureRect(layout: BRollLayout, sourceMs: number): Rect {
  const p = progress(layout, sourceMs);
  const zoom =
    layout.motion === "push-in"
      ? 1 + (BROLL_ZOOM - 1) * p
      : layout.motion === "pull-out"
        ? BROLL_ZOOM - (BROLL_ZOOM - 1) * p
        : layout.motion === "none"
          ? 1
          : BROLL_ZOOM;
  const [left, top, right, bottom] = layout.frame;
  const frameWidth = right - left;
  const width = layout.coverWidth * zoom;
  const height = layout.coverHeight * zoom;
  let dx = 0;
  if (layout.motion === "pan-left" || layout.motion === "pan-right") {
    const travel = Math.min(width - frameWidth, frameWidth * BROLL_PAN_TRAVEL);
    // pan-left: the picture drifts left, from half the travel right of centre.
    const sign = layout.motion === "pan-left" ? 1 : -1;
    dx = sign * travel * (0.5 - p);
  }
  const cx = (left + right) / 2 + dx;
  const cy = (top + bottom) / 2;
  return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
}

/**
 * The cutaway at one instant, at `opacity` (from {@link brollOpacity}):
 * nothing when it is fully faded.
 */
export function drawBRoll(layout: BRollLayout, sourceMs: number, opacity: number): DrawCommand[] {
  if (opacity <= 0) return [];
  const picture = brollPictureRect(layout, sourceMs);
  if (layout.mode === "full") {
    return [clipRect(layout.frame, [image(layout.assetId, picture, opacity)])];
  }
  const short = layout.shortSide;
  const radius = short * PIP_RADIUS;
  return [
    group(
      [
        shadow(
          {
            dx: 0,
            dy: short * 0.006,
            sigma: short * 0.012,
            color: "#00000073",
            shadowOnly: true,
          },
          [roundRect(layout.frame, radius, radius, { fill: fill("#000000") })],
        ),
        clip({ type: "roundRect", rect: layout.frame, radiusX: q(radius), radiusY: q(radius) }, [
          image(layout.assetId, picture),
        ]),
      ],
      `b-roll:${layout.overlayId}`,
      opacity,
    ),
  ];
}
