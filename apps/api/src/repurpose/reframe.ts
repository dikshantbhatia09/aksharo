import { parseFaceTrack, type FaceTrackDocument } from "@montaj/render-core";
import {
  STACKED_ASPECTS,
  type ClipLayout,
  type CropKeyframe,
  type DynamicReframeTrajectory,
  type StackedPerson,
} from "@montaj/repurpose-contracts";

import { detectLayout, type ClipLayoutChoice } from "./layout.js";

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
 * When a single speaker moves beyond the 6% deadband hysteresis zone across the
 * clip, a critically damped spring trajectory (`zeta = 1.0`, `omega_n = 2.5`)
 * is attached in `reframe.trajectory` so the crop window smoothly pans without
 * overshoot or micro-jitter.
 *
 * A source proxied before `ai.faces` existed has no track yet, and a clip cut
 * then is on the centre for good: nothing re-frames a clip that is ready at the
 * current profile. So the cut waits while the detection it queues is running
 * ({@link awaitingFaceDetection}) — bounded, because a clip on the centre is
 * still better than a clip that never comes.
 */

export interface ClipReframe {
  /** Horizontal centre of the window, 0 (left edge) to 1 (right edge) of the source. */
  readonly centerX: number;
  /**
   * The speaking face's vertical centre, 0 (top) to 1 (bottom), for a source
   * taller than the shape being cut (2026-09-29); absent when no face was found.
   */
  readonly centerY?: number;
  /** `faces`: taken from the face track; `centre`: no usable face, so the frame centre. */
  readonly basis: "faces" | "centre";
  /**
   * `stacked` (2026-10-01, `layout.ts`): two people side by side, each given
   * half of the picture. Absent: one window, as every clip was before.
   */
  readonly layout?: ClipLayout;
  /** A stacked cut's two people, top half (the left person) first. */
  readonly people?: readonly [StackedPerson, StackedPerson];
  /**
   * Time-varying crop trajectory for single-speaker cuts where the active
   * speaker moves outside the 6% deadband hysteresis zone.
   */
  readonly trajectory?: DynamicReframeTrajectory;
}

export const CENTRE_REFRAME: ClipReframe = Object.freeze({ centerX: 0.5, basis: "centre" });

/** Deadband hysteresis radius: 6% of frame width/height. */
export const DEADBAND_RATIO = 0.06;
/** Critically damped natural frequency (rad/s) for smooth camera pans. */
export const SPRING_OMEGA_N = 2.5;
/** Inflection reduction collinear tolerance in normalized coordinates. */
export const INFLECTION_EPSILON = 0.0025;

export interface RawCenterSample {
  readonly timeSec: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly zoom?: number;
}

/**
 * Pass raw face centers through a 6% deadband hysteresis gate and a critically
 * damped spring-damper filter (`zeta = 1.0`, `omega_n = 2.5 rad/s`).
 *
 * Uses the exact analytical solution of the critically damped harmonic oscillator:
 * `x(t) = target + ((x0 - target) + (v0 + omega_n * (x0 - target)) * dt) * exp(-omega_n * dt)`
 * `v(t) = (v0 - omega_n^2 * (x0 - target) * dt - omega_n * v0 * dt) * exp(-omega_n * dt)`
 */
export function applyCriticallyDampedSmoothing(
  rawSamples: readonly RawCenterSample[],
  options: {
    readonly deadbandRatio?: number;
    readonly omegaN?: number;
    readonly reduceInflections?: boolean;
  } = {},
): CropKeyframe[] {
  const first = rawSamples[0];
  if (first === undefined) return [];
  const deadband = options.deadbandRatio ?? DEADBAND_RATIO;
  const omega = options.omegaN ?? SPRING_OMEGA_N;
  const reduceInflections = options.reduceInflections ?? true;

  let anchorX = clamp01(first.centerX);
  let anchorY = clamp01(first.centerY);
  let posX = anchorX;
  let posY = anchorY;
  let velX = 0;
  let velY = 0;
  let prevTime = Math.max(0, first.timeSec);

  const dense: CropKeyframe[] = [];
  for (let i = 0; i < rawSamples.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bounded index
    const sample = rawSamples[i] ?? first;
    const t = Math.max(prevTime, Math.max(0, sample.timeSec));
    const dt = i === 0 ? 0 : Math.max(0, t - prevTime);
    prevTime = t;

    const rawX = clamp01(sample.centerX);
    const rawY = clamp01(sample.centerY);
    const rawZ = Math.min(1.5, Math.max(1, sample.zoom ?? 1));

    if (Math.abs(rawX - anchorX) > deadband) {
      anchorX = rawX;
    }
    if (Math.abs(rawY - anchorY) > deadband) {
      anchorY = rawY;
    }

    if (dt > 0) {
      const expTerm = Math.exp(-omega * dt);
      const dx = posX - anchorX;
      posX = anchorX + (dx + (velX + omega * dx) * dt) * expTerm;
      velX = (velX - omega * omega * dx * dt - omega * velX * dt) * expTerm;

      const dy = posY - anchorY;
      posY = anchorY + (dy + (velY + omega * dy) * dt) * expTerm;
      velY = (velY - omega * omega * dy * dt - omega * velY * dt) * expTerm;
    }

    dense.push({
      timeSec: Math.round(t * 10_000) / 10_000,
      centerX: roundFraction(posX),
      centerY: roundFraction(posY),
      zoom: Math.round(rawZ * 10_000) / 10_000,
    });
  }

  return reduceInflections ? reduceToInflectionKeyframes(dense) : dense;
}

function reduceToInflectionKeyframes(
  keyframes: readonly CropKeyframe[],
  epsilon: number = INFLECTION_EPSILON,
): CropKeyframe[] {
  if (keyframes.length <= 2) return [...keyframes];
  const first = keyframes[0];
  if (first === undefined) return [];
  const reduced: CropKeyframe[] = [first];

  for (let i = 1; i < keyframes.length - 1; i += 1) {
    const prev = reduced[reduced.length - 1] ?? first;
    // eslint-disable-next-line security/detect-object-injection -- bounded index
    const curr = keyframes[i] ?? first;
    const nxt = keyframes[i + 1] ?? first;

    const dt1 = Math.max(1e-6, curr.timeSec - prev.timeSec);
    const dt2 = Math.max(1e-6, nxt.timeSec - curr.timeSec);
    const vx1 = (curr.centerX - prev.centerX) / dt1;
    const vx2 = (nxt.centerX - curr.centerX) / dt2;
    const vy1 = (curr.centerY - prev.centerY) / dt1;
    const vy2 = (nxt.centerY - curr.centerY) / dt2;

    const span = nxt.timeSec - prev.timeSec;
    const alpha = span > 1e-6 ? (curr.timeSec - prev.timeSec) / span : 0.5;
    const interpX = prev.centerX + alpha * (nxt.centerX - prev.centerX);
    const interpY = prev.centerY + alpha * (nxt.centerY - prev.centerY);
    const dev = Math.hypot(curr.centerX - interpX, curr.centerY - interpY);

    const signFlipX =
      (vx1 > 1e-4 && vx2 <= 1e-4) ||
      (vx1 < -1e-4 && vx2 >= -1e-4) ||
      (Math.abs(vx1) <= 1e-4 && Math.abs(vx2) > 1e-4);
    const signFlipY =
      (vy1 > 1e-4 && vy2 <= 1e-4) ||
      (vy1 < -1e-4 && vy2 >= -1e-4) ||
      (Math.abs(vy1) <= 1e-4 && Math.abs(vy2) > 1e-4);

    if (signFlipX || signFlipY || dev > epsilon) {
      reduced.push(curr);
    }
  }

  const last = keyframes[keyframes.length - 1];
  if (last !== undefined) {
    reduced.push(last);
  }
  return reduced;
}

/**
 * Build a {@link DynamicReframeTrajectory} from raw samples when the smoothed
 * path exhibits real camera movement beyond the deadband; returns `undefined`
 * for stationary speakers so static clips remain single-window cuts.
 */
export function buildDynamicReframeTrajectory(
  rawSamples: readonly RawCenterSample[],
  interpolation: "SPRING_DAMPED" | "CUBIC_BEZIER" = "SPRING_DAMPED",
): DynamicReframeTrajectory | undefined {
  if (rawSamples.length < 2) return undefined;
  const keyframes = applyCriticallyDampedSmoothing(rawSamples);
  if (keyframes.length < 2) return undefined;
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const kf of keyframes) {
    minX = Math.min(minX, kf.centerX);
    maxX = Math.max(maxX, kf.centerX);
    minY = Math.min(minY, kf.centerY);
    maxY = Math.max(maxY, kf.centerY);
  }
  if (maxX - minX < 0.005 && maxY - minY < 0.005) {
    return undefined;
  }
  return {
    keyframes,
    interpolation,
  };
}

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
  /** Vertical centres, beside `centres`. */
  readonly rows: number[];
  /** Timestamped samples for dynamic trajectory smoothing. */
  readonly timedSamples: RawCenterSample[];
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
  samples.forEach(([tMs, boxes], sampleIndex) => {
    const faces = boxes
      .filter((box) => {
        const [x, , w, h] = asArray(box);
        return isFiniteNumber(x) && isFiniteNumber(w) && isFiniteNumber(h);
      })
      .map(([x = 0, y = 0, w = 0, h = 0]) => ({
        cx: x + w / 2,
        cy: (isFiniteNumber(y) ? y : 0) + h / 2,
        w,
        h,
        area: w * h,
      }))
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
        owner = {
          lastCx: face.cx,
          centres: [],
          rows: [],
          timedSamples: [],
          areaSum: 0,
          widthSum: 0,
          seenIn: new Set(),
        };
        tracks.push(owner);
      }
      owner.lastCx = face.cx;
      owner.centres.push(face.cx);
      owner.rows.push(face.cy);
      owner.timedSamples.push({
        timeSec: Math.max(0, (tMs - fromMs) / 1000),
        centerX: face.cx,
        centerY: face.cy,
        zoom: 1,
      });
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

  const trajectory = buildDynamicReframeTrajectory(dominant.timedSamples);
  return {
    centerX: roundFraction(median(dominant.centres)),
    centerY: roundFraction(median(dominant.rows)),
    basis: "faces",
    ...(trajectory === undefined ? {} : { trajectory }),
  };
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

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The largest `faces.json` the API will read. The file's size is set by the
 * video — every detection the worker keeps, four samples a second, for as long
 * as the plan allows — and the API reads a whole object into memory and parses
 * it on the one process that serves the site, then keeps up to
 * `FACE_TRACK_CACHE_SIZE` of them. Measured (2026-09-26): a 3 h, 25-face grid
 * recording is ~31 MB of JSON (~96 MB of heap, 0.2 s of parse); 6 h at 50 faces
 * is ~124 MB (~277 MB, 0.9 s with the event loop blocked). 64 MiB leaves every
 * real source up to the Creator cap with its framing, where 8 MiB would quietly
 * centre a long gallery recording, and refuses what only a hand-made
 * wall-of-faces video produces. A track over it frames on the centre, like one
 * that cannot be read.
 */
export const FACE_TRACK_MAX_BYTES = 64 * 1024 * 1024;

/**
 * How long a cut gives its source's face detection to run, at the least, before
 * it is made on the centre anyway — measured from when detection STARTED, not
 * when it was queued: worker-ai detects one video at a time, so a job can sit
 * behind others for minutes through no fault of its own, and a clock started at
 * queueing would spend the wait before detection had begun. Also how long a
 * detection that has just succeeded is given for its track to be read.
 */
export const FACE_TRACK_WAIT_MS = 3 * 60_000;

/**
 * A long source gets longer: detection samples four frames a second of the
 * whole video, so its time grows with the duration. Measured (2026-09-26) at
 * about an eighth of real time on the 540p proxy — 2 s for a 16 s source — so
 * half the duration is four times that: a 368 s source (the legacy clips of
 * run 01M2W1J5BZJF7QGMDM5HE39YZ1) is given 184 s for about 46 s of work.
 */
export const FACE_TRACK_WAIT_SHARE_OF_SOURCE = 0.5;

/** ...up to this, so a three-hour recording does not hold a clip for ninety minutes. */
export const FACE_TRACK_MAX_RUN_WAIT_MS = 10 * 60_000;

/**
 * How long a detection may sit queued before the cut stops waiting for it.
 * Longer than one detection takes, because it may be behind a few others; a
 * job still queued after this is behind a worker that is down or a queue that is
 * backed up, and the clip is better on the centre than not there.
 */
export const FACE_TRACK_QUEUE_WAIT_MS = 10 * 60_000;

/**
 * The whole wait, queued and running together, from when detection was queued.
 * The two allowances above each have a ceiling; this is the one a person
 * watching "waiting" is promised, whatever mix of the two it was.
 */
export const FACE_TRACK_MAX_WAIT_MS = 15 * 60_000;

/** How long detection of a source this long is given to run: {@link FACE_TRACK_WAIT_SHARE_OF_SOURCE}, within its floor and ceiling. */
export function faceDetectionRunWaitMs(sourceDurationMs: number | null | undefined): number {
  const scaled =
    typeof sourceDurationMs === "number" && Number.isFinite(sourceDurationMs)
      ? sourceDurationMs * FACE_TRACK_WAIT_SHARE_OF_SOURCE
      : 0;
  return Math.min(FACE_TRACK_MAX_RUN_WAIT_MS, Math.max(FACE_TRACK_WAIT_MS, scaled));
}

/** The newest `ai.faces` job for a media: as much of it as {@link awaitingFaceDetection} reads. */
export interface FaceDetectionJob {
  readonly status: string;
  readonly queuedAt: Date;
  readonly startedAt?: Date | null;
  readonly finishedAt?: Date | null;
}

/**
 * Whether a cut from a source with no face track should wait for one, because
 * its newest `ai.faces` job is
 *
 * - queued, for less than {@link FACE_TRACK_QUEUE_WAIT_MS};
 * - running, for less than {@link faceDetectionRunWaitMs} of the source since it
 *   started (from queueing, if the row never recorded a start);
 * - or succeeded less than {@link FACE_TRACK_WAIT_MS} ago: the track landed
 *   after the media row the caller holds was read, and the next reconcile reads
 *   it —
 *
 * and was queued less than {@link FACE_TRACK_MAX_WAIT_MS} ago in any case.
 *
 * Not when there is no such job (the source cannot be detected — no proxy, no
 * picture — so {@link loadFaceTrack} queued nothing), when detection failed or
 * was cancelled, or once the wait is over: the centre it is, as before.
 */
export function awaitingFaceDetection(
  job: FaceDetectionJob | null | undefined,
  sourceDurationMs: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (job === null || job === undefined) return false;
  const queuedAt = job.queuedAt.getTime();
  if (now - queuedAt >= FACE_TRACK_MAX_WAIT_MS) return false;
  switch (job.status) {
    case "queued":
      return now - queuedAt < FACE_TRACK_QUEUE_WAIT_MS;
    case "running":
      return (
        now - (job.startedAt?.getTime() ?? queuedAt) < faceDetectionRunWaitMs(sourceDurationMs)
      );
    case "succeeded":
      return (
        now - (job.finishedAt?.getTime() ?? job.startedAt?.getTime() ?? queuedAt) <
        FACE_TRACK_WAIT_MS
      );
    default:
      return false;
  }
}

/**
 * {@link awaitingFaceDetection} for a picture uploaded at `pictureSince`: a
 * clip shape's own media, whose captioned video must not be made before its
 * face track (2026-10-01). A detection queued before that upload was of an
 * earlier picture - the clip was cut again, in a new layout say - and says
 * nothing of this one, whose own detection is queued only once its proxy's
 * completion lands, a moment after the media reads ready. Until it is queued,
 * the wait is for it, as long as any detection is ever waited for.
 * `pictureSince` null or absent: the rule for a source, unchanged.
 */
export function awaitingPictureFaces(
  job: FaceDetectionJob | null | undefined,
  pictureSince: Date | null | undefined,
  sourceDurationMs: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (
    pictureSince instanceof Date &&
    (job === null || job === undefined || job.queuedAt.getTime() < pictureSince.getTime())
  ) {
    return now - pictureSince.getTime() < FACE_TRACK_MAX_WAIT_MS;
  }
  return awaitingFaceDetection(job, sourceDurationMs, now);
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
 * video whose detection failed is not retried on every clip. Whether the cut
 * then waits for it is the caller's call ({@link awaitingFaceDetection}). A
 * track that cannot be read (purged, malformed, another version, larger than
 * {@link FACE_TRACK_MAX_BYTES}) is the same as none.
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
    // Sized before it is read: `get` buffers the whole object (see
    // FACE_TRACK_MAX_BYTES), so the check has to come first to be any bound.
    const head = await deps.derived.head(media.facesKey);
    if (head === null) {
      deps.warn({ mediaId: media.id }, "the source's face track is gone; clip cut on centre");
      return undefined;
    }
    if (head.sizeBytes > FACE_TRACK_MAX_BYTES) {
      deps.warn(
        { mediaId: media.id, sizeBytes: head.sizeBytes, maxBytes: FACE_TRACK_MAX_BYTES },
        "the source's face track is too large to read; clip cut on centre",
      );
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

/**
 * {@link reframeFromTrack}, and the layout `choice` makes of the same track
 * over the same interval (`detectLayout`, 2026-10-01): with two people to
 * stack, `layout: "stacked"` and where they are; otherwise the one window it
 * always was, with no `layout` at all - so a single cut's payload, and its job
 * key, is exactly what it was before layouts existed. Only a shape that can be
 * stacked (9:16, 4:5) ever is. Never throws: a clip must never fail over its
 * layout any more than over its framing.
 */
export function framingFromTrack(
  track: FaceTrackDocument | undefined,
  interval: { readonly fromMs: number; readonly toMs: number },
  choice: ClipLayoutChoice | "fit",
  shape: string = "9:16",
): ClipReframe {
  const reframe = reframeFromTrack(track, interval);
  if (track === undefined || choice === "single") return reframe;
  if (!(STACKED_ASPECTS as readonly string[]).includes(shape)) return reframe;
  try {
    const decision = detectLayout(track, interval.fromMs, interval.toMs, choice);
    const { trajectory: _trajectory, ...staticReframe } = reframe;
    if (decision.layout === "stacked" && decision.people !== undefined) {
      return { ...staticReframe, layout: "stacked", people: decision.people };
    }
    if (decision.layout === "fit") {
      return { ...staticReframe, layout: "fit" };
    }
    return reframe;
  } catch {
    return reframe;
  }
}

/** The layout a {@link ClipReframe} cuts: `single` unless it says `stacked` or `fit`. */
export function layoutOfReframe(reframe: ClipReframe): ClipLayout {
  return reframe.layout === "stacked" ? "stacked" : reframe.layout === "fit" ? "fit" : "single";
}

/** The reframe for one clip of a source media: {@link loadFaceTrack}, then {@link reframeFromTrack}. */
export async function reframeForClip(
  deps: FaceTrackDeps,
  media: { readonly id: string; readonly facesKey: string | null },
  interval: { readonly fromMs: number; readonly toMs: number },
): Promise<ClipReframe> {
  return reframeFromTrack(await loadFaceTrack(deps, media), interval);
}
