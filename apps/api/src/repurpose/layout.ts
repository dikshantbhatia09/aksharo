import type { FaceTrackDocument } from "@montaj/render-core";
import type { ClipLayout, StackedPerson } from "@montaj/repurpose-contracts";

/**
 * Two-speaker layouts (2026-10-01): a podcast shows both people, not half of
 * one.
 *
 * The owner's test runs are two people at a table filmed by one wide camera.
 * A single 9:16 window holds one of them at best, and multi-speaker clips are
 * where every clipping tool is weakest; the ones that handle it stack the two
 * speakers, one above the other. This reads the source's face track (the same
 * `faces.json` that frames a single speaker, `reframe.ts`) over one clip's
 * interval and says whether that clip has two people to stack.
 *
 * **Per sample, not per person.** A sample counts as "two up" when its two
 * largest faces are side by side, far enough apart to be two people. The left
 * face of each such sample is the left seat, the right face the right seat;
 * each seat's place is the median of its faces. Reading seats rather than
 * identities is what makes the answer hold when two people swap sides, and
 * requiring both in the SAME sample is what keeps one person walking across the
 * frame (never two faces at once) a single speaker.
 *
 * **Conservative on its own** (`auto`): both people together in at least
 * {@link AUTO_TOGETHER_SHARE} of the samples, a quarter of the frame apart,
 * of comparable size, each holding still, and no third face of their size in
 * the picture for long. Anything less - one person, a crowd, a face on a TV in
 * the background, someone who wanders in - stays one window, which is what
 * every clip was before this. **Generous when asked** (`stacked`, "Both
 * speakers"): any two people seen together in {@link FORCED_TOGETHER_SHARE} of
 * the samples are stacked; only when there are never two is it one window.
 *
 * Pure: the same track, interval and choice always give the same answer, so
 * the cut (its payload and its job key) is stable.
 */

/** What a person picks for a clip: let the track decide, one speaker, or both. */
export const CLIP_LAYOUT_CHOICES = ["auto", "single", "stacked"] as const;
export type ClipLayoutChoice = (typeof CLIP_LAYOUT_CHOICES)[number];

/**
 * A clip row's `layout` as a choice: anything that is not one (a row read
 * before the column existed) is `auto`, which is what the column defaults to.
 */
export function layoutChoiceOf(value: unknown): ClipLayoutChoice {
  return value === "single" || value === "stacked" ? value : "auto";
}

/** A shape's recorded `layout`: `stacked`, or the one window every older shape is. */
export function shapeLayoutOf(value: unknown): ClipLayout {
  return value === "stacked" ? "stacked" : "single";
}

export interface LayoutDecision {
  readonly layout: ClipLayout;
  /** A stacked layout's two people: the left one first, which is the top half. */
  readonly people?: readonly [StackedPerson, StackedPerson];
}

export const SINGLE_LAYOUT: LayoutDecision = Object.freeze({ layout: "single" });
export const FIT_LAYOUT: LayoutDecision = Object.freeze({ layout: "fit" });

/** Faces shorter than this share of the frame are background (as in `reframe.ts`). */
const MIN_FACE_HEIGHT = 0.06;

/** `auto`: both people in at least half the samples, together. */
export const AUTO_TOGETHER_SHARE = 0.5;
/** `stacked`: two people together often enough to be more than a false detection. */
export const FORCED_TOGETHER_SHARE = 0.1;

/**
 * How far apart two faces' centres must be, as a multiple of the wider face,
 * and at least as a share of the frame width. On its own a quarter of the
 * frame: closer than that, each half would be a narrow window scaled up, and
 * two people that close fit one window anyway. Asked for, only far enough apart
 * that each half can hold its own person (the worker's own floor is 0.08).
 */
const AUTO_MIN_GAP_FACES = 2;
const AUTO_MIN_GAP_FRAME = 0.25;
const FORCED_MIN_GAP_FACES = 1.2;
const FORCED_MIN_GAP_FRAME = 0.1;

/**
 * `auto`: the smaller face at least half the height of the larger. A face on a
 * screen behind the speaker, or a reflection, is much smaller than the person;
 * two people at one table are about the same size.
 */
const AUTO_MIN_SIZE_RATIO = 0.5;

/**
 * A third face at least half the height of the smaller speaker, in at least a
 * quarter of the samples, is a third person: `auto` does not pick two of them.
 */
const CROWD_FACE_RATIO = 0.5;
const CROWD_SHARE = 0.25;

/**
 * `auto`: each seat's faces within this share of the gap between the seats
 * (median absolute deviation). A still window cannot follow people who move
 * about the frame; one window on the speaker can. People talking at a table
 * lean and gesture a few hundredths of the frame either way, well inside it.
 */
const SEAT_SPREAD = 0.15;

interface SampleFace {
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The layout `choice` makes of `[fromMs, toMs]` of a face track. `single` is
 * always one window; `auto` and `stacked` read the track as described above.
 * A source that is not landscape (a vertical video) is always one window: it
 * has no people side by side to stack.
 */
export function detectLayout(
  track: FaceTrackDocument,
  fromMs: number,
  toMs: number,
  choice: ClipLayoutChoice | "fit",
): LayoutDecision {
  if (choice === "single") return SINGLE_LAYOUT;
  if (choice === "fit") return FIT_LAYOUT;
  if (!(track.source.width > track.source.height)) return SINGLE_LAYOUT;
  const forced = choice === "stacked";

  const samples = track.samples.filter((sample) => {
    const [tMs, boxes] = asArray(sample);
    return isFiniteNumber(tMs) && tMs >= fromMs && tMs <= toMs && Array.isArray(boxes);
  });
  if (samples.length === 0) return SINGLE_LAYOUT;

  const lefts: SampleFace[] = [];
  const rights: SampleFace[] = [];
  let crowded = 0;
  let anyFaces = 0;
  for (const [, boxes] of samples) {
    const [a, b, third] = facesOf(boxes);
    if (a !== undefined) anyFaces += 1;
    if (a === undefined || b === undefined) continue;
    const [left, right] = a.cx <= b.cx ? [a, b] : [b, a];
    const minGap = Math.max(
      (forced ? FORCED_MIN_GAP_FACES : AUTO_MIN_GAP_FACES) * Math.max(a.w, b.w),
      forced ? FORCED_MIN_GAP_FRAME : AUTO_MIN_GAP_FRAME,
    );
    if (right.cx - left.cx < minGap) continue;
    lefts.push(left);
    rights.push(right);
    if (third !== undefined && third.h >= CROWD_FACE_RATIO * Math.min(a.h, b.h)) crowded += 1;
  }
  if (lefts.length === 0 || lefts.length / samples.length < (forced ? FORCED_TOGETHER_SHARE : AUTO_TOGETHER_SHARE)) {
    // If auto and no faces present in at least 15% of samples, it's presentation / screencast footage
    if (choice === "auto" && anyFaces / samples.length < 0.15) {
      return FIT_LAYOUT;
    }
    return SINGLE_LAYOUT;
  }

  const left = seatOf(lefts);
  const right = seatOf(rights);
  const gap = right.person.centerX - left.person.centerX;
  if (!(gap > 0)) return SINGLE_LAYOUT;
  if (!forced) {
    if (crowded / samples.length >= CROWD_SHARE) return SINGLE_LAYOUT;
    const [smaller, larger] = [left.person.size, right.person.size].sort((x, y) => x - y);
    if ((smaller ?? 0) < AUTO_MIN_SIZE_RATIO * (larger ?? 0)) return SINGLE_LAYOUT;
    if (left.spread > SEAT_SPREAD * gap || right.spread > SEAT_SPREAD * gap) return SINGLE_LAYOUT;
  }
  return { layout: "stacked", people: [left.person, right.person] };
}

/**
 * A sample's faces big enough to be a subject, largest first. `parseFaceTrack`
 * checks the envelope only; a box that is not numbers is skipped, as in
 * `reframe.ts`.
 */
function facesOf(boxes: readonly (readonly number[])[]): SampleFace[] {
  return boxes
    .filter((box) => {
      const [x, y, w, h] = asArray(box);
      return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(w) && isFiniteNumber(h);
    })
    .map(([x = 0, y = 0, w = 0, h = 0]) => ({ cx: x + w / 2, cy: y + h / 2, w, h }))
    .filter((face) => face.h >= MIN_FACE_HEIGHT && face.w > 0)
    .sort((a, b) => b.w * b.h - a.w * a.h);
}

/** One seat: the median place and size of its faces, and how far they wander. */
function seatOf(faces: readonly SampleFace[]): { person: StackedPerson; spread: number } {
  const centerX = median(faces.map((face) => face.cx));
  return {
    person: {
      centerX: roundFraction(centerX),
      centerY: roundFraction(median(faces.map((face) => face.cy))),
      size: roundFraction(median(faces.map((face) => face.h))),
    },
    spread: median(faces.map((face) => Math.abs(face.cx - centerX))),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted.at(middle) ?? 0)
    : ((sorted.at(middle - 1) ?? 0) + (sorted.at(middle) ?? 0)) / 2;
}

/** Clamped to the frame and rounded, so the payload - and its job - is stable. */
function roundFraction(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}
