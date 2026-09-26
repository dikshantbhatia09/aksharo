import { parseFaceTrack, type FaceTrackDocument } from "@montaj/render-core";

import type { ObjectStore } from "../common/storage/index.js";
import type { FacesTrigger } from "../media/faces.js";

/**
 * Where a clip's 9:16 window sits across its landscape source (2026-09-26).
 *
 * Every clip used to be the middle 31.6 % of a 16:9 frame, so a speaker sitting
 * on a thirds line — the normal interview framing — was cut out before the clip
 * was even made. The source already has a face track (`ai.faces` runs on every
 * proxied video for caption placement), so the API reads it here and tells
 * `media.clip` where the speaker is: `reframe.centerX` in the payload, as a
 * fraction of the source width. The worker crops around it and clamps the
 * window to the frame; nothing here has to know the frame's shape.
 *
 * One number per clip, deliberately: a static window never pans or jitters, and
 * a clip is a single moment of 3-180 s in which the speaker rarely crosses the
 * frame. Following motion inside a clip is a later refinement, not a
 * prerequisite for getting the speaker into the picture at all.
 */

export interface ClipReframe {
  /** Horizontal centre of the window, 0 (left edge) to 1 (right edge) of the source. */
  readonly centerX: number;
  /** `faces`: taken from the face track; `centre`: no usable face, so the frame centre. */
  readonly basis: "faces" | "centre";
}

export const CENTRE_REFRAME: ClipReframe = Object.freeze({ centerX: 0.5, basis: "centre" });

/**
 * Faces shorter than this share of the frame are background, not the subject —
 * the same threshold caption placement uses (`render-core` `placement.ts`).
 */
const MIN_FACE_HEIGHT = 0.06;

/**
 * A face track seen in fewer than this share of the clip's samples is a
 * passer-by, a poster on the wall or a false detection, not the person
 * speaking. Framing on it would be worse than the centre.
 */
const MIN_PRESENCE = 0.2;

/**
 * Two detections in consecutive samples are the same person when their
 * horizontal centres are this close, as a multiple of the wider face — so a
 * close-up's head movement stays one track while two people sitting side by
 * side (at least a face width apart) stay two.
 */
const LINK_FACE_WIDTHS = 0.6;
/** ...and never closer than this, so a small, jittery face does not split into many. */
const MIN_LINK_DISTANCE = 0.05;

interface FaceTrackBuild {
  /** Where this person was last seen, which is what the next detection is linked to. */
  lastCx: number;
  readonly centres: number[];
  areaSum: number;
  widthSum: number;
  /** Sample indexes this person appears in (once per sample). */
  readonly seenIn: Set<number>;
}

/**
 * The window centre for `[fromMs, toMs]` of a source, from its face track.
 *
 * 1. Take the samples inside the interval; faces too small to be the subject go.
 * 2. Link detections across samples into tracks by horizontal centre — one
 *    track per person — taking each sample's faces largest first, so two people
 *    in one sample can never merge into one track.
 * 3. The dominant track is the one with the largest mean face area times the
 *    share of samples it appears in: the biggest face that is actually there
 *    most of the time. A sample with nobody in it still counts against that
 *    share, so a face glimpsed once cannot outrank the speaker.
 * 4. Its median centre is the answer. Median, not mean, so a few mis-linked or
 *    mis-detected boxes cannot drag the window off the speaker.
 *
 * No samples, no faces, or no track seen often enough → the frame centre.
 * Pure: the same track and interval always give the same window.
 */
export function reframeFromFaces(
  track: FaceTrackDocument,
  fromMs: number,
  toMs: number,
): ClipReframe {
  // `parseFaceTrack` checks the envelope only; a sample or box that is not
  // numbers is a worker bug, and is skipped rather than turned into a NaN centre.
  const samples = track.samples.filter((sample) => {
    const [tMs, boxes] = asArray(sample);
    return isFiniteNumber(tMs) && tMs >= fromMs && tMs <= toMs && Array.isArray(boxes);
  });
  if (samples.length === 0) return CENTRE_REFRAME;

  const tracks: FaceTrackBuild[] = [];
  samples.forEach(([, boxes], sampleIndex) => {
    const faces = boxes
      .filter((box) => {
        const [x, , w, h] = asArray(box);
        return isFiniteNumber(x) && isFiniteNumber(w) && isFiniteNumber(h);
      })
      .map(([x = 0, , w = 0, h = 0]) => ({ cx: x + w / 2, w, h, area: w * h }))
      .filter((face) => face.h >= MIN_FACE_HEIGHT && face.w > 0)
      .sort((a, b) => b.area - a.area);

    const taken = new Set<FaceTrackBuild>();
    for (const face of faces) {
      let nearest: FaceTrackBuild | undefined;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of tracks) {
        if (taken.has(candidate)) continue;
        const distance = Math.abs(face.cx - candidate.lastCx);
        const reach = Math.max(
          MIN_LINK_DISTANCE,
          LINK_FACE_WIDTHS * Math.max(face.w, candidate.widthSum / candidate.centres.length),
        );
        if (distance <= reach && distance < nearestDistance) {
          nearest = candidate;
          nearestDistance = distance;
        }
      }
      let owner = nearest;
      if (owner === undefined) {
        owner = { lastCx: face.cx, centres: [], areaSum: 0, widthSum: 0, seenIn: new Set() };
        tracks.push(owner);
      }
      owner.lastCx = face.cx;
      owner.centres.push(face.cx);
      owner.areaSum += face.area;
      owner.widthSum += face.w;
      owner.seenIn.add(sampleIndex);
      taken.add(owner);
    }
  });

  let dominant: FaceTrackBuild | undefined;
  let dominantScore = 0;
  for (const candidate of tracks) {
    const presence = candidate.seenIn.size / samples.length;
    if (presence < MIN_PRESENCE) continue;
    const score = (candidate.areaSum / candidate.centres.length) * presence;
    // Strictly greater: on a tie the track found first wins, so the answer never
    // depends on anything but the input.
    if (score > dominantScore) {
      dominant = candidate;
      dominantScore = score;
    }
  }
  if (dominant === undefined) return CENTRE_REFRAME;

  return { centerX: roundFraction(median(dominant.centres)), basis: "faces" };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The file's own values, typed as what they might really be. */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted.at(middle) ?? 0.5)
    : ((sorted.at(middle - 1) ?? 0.5) + (sorted.at(middle) ?? 0.5)) / 2;
}

/** Clamped to the frame and rounded, so the payload — and its job — is stable. */
function roundFraction(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

export interface FaceTrackDeps {
  readonly derived: ObjectStore;
  readonly faces: Pick<FacesTrigger, "maybeEnqueue">;
  readonly warn: (context: Record<string, unknown>, message: string) => void;
}

/**
 * A source media's `faces.json`, parsed, or `undefined` when there is none to
 * use.
 *
 * Never throws and never waits. A source proxied before `ai.faces` existed has
 * no track, so detection is queued for it — once: `onlyIfNeverTried`, so a
 * video whose detection failed is not retried on every clip. A track that
 * cannot be read (purged, malformed, another version) is the same as none.
 */
export async function loadFaceTrack(
  deps: FaceTrackDeps,
  media: { readonly id: string; readonly facesKey: string | null },
): Promise<FaceTrackDocument | undefined> {
  try {
    if (media.facesKey === null) {
      await deps.faces.maybeEnqueue(media.id, { onlyIfNeverTried: true });
      return undefined;
    }
    const body = await deps.derived.get(media.facesKey);
    const track = parseFaceTrack(JSON.parse(body.toString("utf8")) as unknown);
    if (track === undefined) {
      deps.warn(
        { mediaId: media.id },
        "face track is not a version this reads; clip cut on centre",
      );
    }
    return track;
  } catch (error) {
    deps.warn(
      { mediaId: media.id, error: error instanceof Error ? error.message : String(error) },
      "could not read the source's face track; clip cut on centre",
    );
    return undefined;
  }
}

/**
 * {@link reframeFromFaces} for a track that may not exist, checked on the way
 * out: a clip must never fail over its framing, and a centre that is not a
 * finite fraction would fail the payload's own contract (`reframe.centerX`) and
 * with it the whole cut.
 */
export function reframeFromTrack(
  track: FaceTrackDocument | undefined,
  interval: { readonly fromMs: number; readonly toMs: number },
): ClipReframe {
  if (track === undefined) return CENTRE_REFRAME;
  try {
    const reframe = reframeFromFaces(track, interval.fromMs, interval.toMs);
    return Number.isFinite(reframe.centerX) ? reframe : CENTRE_REFRAME;
  } catch {
    return CENTRE_REFRAME;
  }
}

/** The reframe for one clip of a source media: {@link loadFaceTrack}, then {@link reframeFromTrack}. */
export async function reframeForClip(
  deps: FaceTrackDeps,
  media: { readonly id: string; readonly facesKey: string | null },
  interval: { readonly fromMs: number; readonly toMs: number },
): Promise<ClipReframe> {
  return reframeFromTrack(await loadFaceTrack(deps, media), interval);
}
