/**
 * Cuts / zooms / audio (C06 brief §Scope 5): accepted cuts ripple-delete the sequence, accepted
 * zooms become Motion scale/position keyframes from decoded MKF2 rows, and cleaned audio
 * (B10/B10b's `cleanedAudioUrl`) replaces the source audio for its range.
 */
import type { EdgPassItemLike, FrameOf } from "./types.js";
import type {
  FrameRange,
  MotionEase,
  MotionKeyframeInput,
  PremiereHost,
} from "../host/premiere.js";

function toFrameRange(item: FrameOf): FrameRange {
  return { startFrames: item.startFrames, endFrames: item.endFrames };
}

/** Only `accepted` cut items are applied — `proposed`/`rejected`/`modified` never touch the
 * sequence (CONTRACTS §2 `ItemState`; a `modified` cut is still awaiting re-acceptance by the
 * pass UI's own rules, out of this WP's scope). */
export function acceptedRanges(
  items: readonly EdgPassItemLike[],
  kind: EdgPassItemLike["kind"],
): FrameRange[] {
  return items.filter((item) => item.kind === kind && item.state === "accepted").map(toFrameRange);
}

export async function applyAcceptedCuts(
  host: PremiereHost,
  items: readonly EdgPassItemLike[],
): Promise<void> {
  const ranges = acceptedRanges(items, "cut");
  if (ranges.length === 0) return;
  await host.rippleDelete(ranges);
}

const MS_TO_FRAMES = (tMs: number, fps: number): number => Math.round((tMs / 1000) * fps);

/** Converts one item's decoded MKF2 keyframes (ms-relative, per CONTRACTS §2's keyframe
 * payload rule) into `MotionKeyframeInput`s the host understands (frame-relative). */
export function toMotionKeyframes(item: EdgPassItemLike, fps: number): MotionKeyframeInput[] {
  return (item.keyframes ?? []).map((kf) => ({
    atFrames: MS_TO_FRAMES(kf.tMs, fps),
    scale: kf.zoom,
    positionX: kf.cx,
    positionY: kf.cy,
    ease: kf.ease as MotionEase,
  }));
}

/** Maps a zoom/reframe `PassItem` to the track item it targets, since Motion keyframes are set
 * on a *track item*, not on the pass item itself — the caller supplies this map because only it
 * knows which sequence clip a given zoom applies to (this WP does not infer that mapping). */
export type ItemToTrackItem = ReadonlyMap<string, string>;

export async function applyAcceptedZooms(
  host: PremiereHost,
  items: readonly EdgPassItemLike[],
  itemToTrackItem: ItemToTrackItem,
  fps: number,
): Promise<void> {
  const zooms = items.filter((item) => item.kind === "zoom" && item.state === "accepted");
  for (const zoom of zooms) {
    const trackItemId = itemToTrackItem.get(zoom.itemId);
    if (!trackItemId) continue; // no target clip resolved; skip rather than guess (brief: never invent behaviour)
    await host.setMotionKeyframes(trackItemId, toMotionKeyframes(zoom, fps));
  }
}

export interface ApplyCleanedAudioInput {
  readonly cleanedAudioLocalPath: string;
  readonly range: FrameRange;
  readonly muteOriginalTrackIndex: number;
}

export async function applyCleanedAudio(
  host: PremiereHost,
  input: ApplyCleanedAudioInput,
): Promise<void> {
  await host.replaceAudioRange({
    sourcePath: input.cleanedAudioLocalPath,
    range: input.range,
    muteOriginalTrackIndex: input.muteOriginalTrackIndex,
  });
}
