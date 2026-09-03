/**
 * Apply accepted `sfx`/`music` items as clips on dedicated audio tracks (D09 brief §Scope 1):
 * downloaded owned assets only (the licence predicate is re-checked client-side inside
 * `@montaj/shared-apply`'s `buildApplyPlan` — a partner asset never reaches this module as an
 * `AudioClipOp`, only as an `AudioClipRefusal` the caller surfaces as the D43 "cloud render
 * only" badge), gain and fades as clip audio keyframes, ducking approximated as gain keyframes
 * on the dialogue track.
 *
 * This module never re-derives the plan itself — `@montaj/shared-apply`'s `buildApplyPlan` is
 * the single source of truth both plugins call, so a change to the licence gate or the fade/duck
 * shape only ever needs to change in one place (see that package's `planBuilder.ts` doc comment
 * for why a Python port of the *logic* was rejected in favour of one shared TS builder).
 */
import { buildApplyPlan } from "@montaj/shared-apply";
import type { ApplyPlanItem, AudioClipOp, AudioClipRefusal } from "@montaj/shared-apply";

import type { GainKeyframeInput, PremiereHost } from "../host/premiere.js";

/** Gain floor used for a fade's silent endpoint — Premiere's audio gain keyframes have no true
 * "-infinity" value in the mock/host surface this WP targets, so -60 dB stands in for silence. */
const SILENT_GAIN_DB = -60;

const msToFrames = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

export interface ApplySfxMusicOptions {
  readonly projectId: string;
  readonly items: readonly ApplyPlanItem[];
  /** Local file path for each accepted item's downloaded asset (already fetched by the caller —
   * this module never performs the download itself, matching every other C06 apply mode, which
   * takes a local path/handle rather than a URL). Missing entries are skipped, not guessed. */
  readonly assetLocalPaths: ReadonlyMap<string, string>;
  readonly fps: number;
  /** The dialogue track item to approximate ducking against, if the sequence has one mapped. */
  readonly dialogueTrackItemId?: string;
}

export interface PlacedAudioClip {
  readonly itemId: string;
  readonly trackItemId: string;
  readonly kind: AudioClipOp["kind"];
}

export interface ApplySfxMusicResult {
  readonly placed: readonly PlacedAudioClip[];
  /** Accepted items with no local asset path yet supplied — not an error, just "not ready". */
  readonly skipped: readonly { itemId: string; reason: "asset-not-downloaded" }[];
  readonly refusals: readonly AudioClipRefusal[];
}

export function buildGainKeyframes(op: AudioClipOp, fps: number): GainKeyframeInput[] {
  const startFrames = msToFrames(op.startMs, fps);
  const endFrames = msToFrames(op.startMs + op.durationMs, fps);
  const keyframes: GainKeyframeInput[] = [];

  if (op.fade.fadeInMs > 0) {
    keyframes.push({ atFrames: startFrames, gainDb: SILENT_GAIN_DB });
    keyframes.push({
      atFrames: startFrames + msToFrames(op.fade.fadeInMs, fps),
      gainDb: op.gainDb,
    });
  } else {
    keyframes.push({ atFrames: startFrames, gainDb: op.gainDb });
  }

  if (op.fade.fadeOutMs > 0) {
    keyframes.push({
      atFrames: Math.max(endFrames - msToFrames(op.fade.fadeOutMs, fps), startFrames),
      gainDb: op.gainDb,
    });
    keyframes.push({ atFrames: endFrames, gainDb: SILENT_GAIN_DB });
  }

  return keyframes;
}

/** Ducking approximation (brief §Scope 1): the dialogue track dips by `duck.depthDb` over the
 * sfx/music clip's own range, ramping in over `attackMs` and back out over `releaseMs`. This is
 * a coarse stand-in for a real sidechain compressor — documented as an approximation, not a
 * faithful ducking model, matching the Resolve side's own documented `DynamicZoomEase`-style
 * limitation for zooms. */
export function buildDuckKeyframes(op: AudioClipOp, fps: number): GainKeyframeInput[] | undefined {
  if (!op.duck) return undefined;
  const { depthDb, attackMs, releaseMs } = op.duck;
  const startFrames = msToFrames(op.startMs, fps);
  const endFrames = msToFrames(op.startMs + op.durationMs, fps);
  const attackEndFrames = Math.min(startFrames + msToFrames(attackMs, fps), endFrames);
  const releaseStartFrames = Math.max(endFrames - msToFrames(releaseMs, fps), attackEndFrames);
  return [
    { atFrames: startFrames, gainDb: 0 },
    { atFrames: attackEndFrames, gainDb: depthDb },
    { atFrames: releaseStartFrames, gainDb: depthDb },
    { atFrames: endFrames, gainDb: 0 },
  ];
}

export async function applyAcceptedSfxMusic(
  host: PremiereHost,
  options: ApplySfxMusicOptions,
): Promise<ApplySfxMusicResult> {
  const plan = buildApplyPlan(options.items);
  const audioOps = plan.ops.filter((op): op is AudioClipOp => op.op === "audioClip");

  const placed: PlacedAudioClip[] = [];
  const skipped: { itemId: string; reason: "asset-not-downloaded" }[] = [];

  for (const op of audioOps) {
    const localPath = options.assetLocalPaths.get(op.assetId);
    if (!localPath) {
      skipped.push({ itemId: op.itemId, reason: "asset-not-downloaded" });
      continue;
    }

    const track = await host.ensureTrack({ kind: "audio", name: op.trackName });
    const bin = await host.importMediaToBin({ sourcePath: localPath });
    const { trackItemId } = await host.placeOnTrack({
      itemId: bin.itemId,
      trackIndex: track.trackIndex,
      startFrames: msToFrames(op.startMs, options.fps),
      durationFrames: msToFrames(op.durationMs, options.fps),
    });

    await host.setClipGainKeyframes(trackItemId, buildGainKeyframes(op, options.fps));

    const duckKeyframes = buildDuckKeyframes(op, options.fps);
    if (duckKeyframes && options.dialogueTrackItemId) {
      await host.setClipGainKeyframes(options.dialogueTrackItemId, duckKeyframes);
    }

    await host.setItemMetadata(trackItemId, {
      aksharo: { projectId: options.projectId, itemId: op.itemId, rev: 0 },
    });

    placed.push({ itemId: op.itemId, trackItemId, kind: op.kind });
  }

  return { placed, skipped, refusals: plan.audioRefusals };
}
