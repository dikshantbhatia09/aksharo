/**
 * The apply-plan builder (D09 brief §Scope 3): turns `accepted` EDG pass items into host-neutral
 * `ApplyOp`s. Consumed by `plugins/premiere-uxp/src/apply/sfxMusic.ts` +
 * `src/apply/titles.ts` directly (this package is a plain dependency, see `src/types.ts`'s doc
 * comment) and, on the Resolve side, by `plugins/resolve/aksharo_core_app/apply_plan.py`'s
 * mirrored dataclasses reading the same op shape as JSON (this WP's parity test,
 * `planBuilder.test.ts` + `plugins/resolve/tests/test_apply_plan_parity.py`, both load
 * `fixtures/sample-plan.json` and assert the same op count/fields — proving one EDG state
 * produces the same plan on both hosts without a second, hand-maintained Python port of this
 * file's actual branching logic, which is the real drift risk a full port would carry).
 *
 * Only `cut`/`zoom`/`sfx`/`music`/`title` `accepted` items ever produce an op — `proposed`,
 * `rejected` and `modified` items are silently skipped, matching every other C06/C08 apply mode
 * (CONTRACTS §2 `ItemState`).
 */
import { checkLicenceForPanel } from "./licence.js";
import {
  defaultPresetForIntent,
  isMotionPresetSupported,
  resolveMotionPresetParams,
} from "./motionPresets.js";

import type {
  ApplyOp,
  ApplyPlan,
  ApplyPlanItem,
  AudioClipKind,
  AudioClipRefusal,
  LayoutCandidate,
  MusicPayload,
  SfxPayload,
  TitleIntent,
  TitlePayload,
} from "./types.js";

const SFX_TRACK_NAME = "Aksharo SFX";
const MUSIC_TRACK_NAME = "Aksharo Music";
const DEFAULT_LAYOUT_CANDIDATE: LayoutCandidate = "top-third";

/** `SfxPayload` carries `duck`; `MusicPayload` carries `bedDuck` — the one structural
 * difference CONTRACTS §2's amendment gives these two otherwise near-identical payloads. */
function isSfxPayload(payload: unknown): payload is SfxPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "duck" in (payload as object) &&
    "licenceSnapshot" in (payload as object)
  );
}

function isMusicPayload(payload: unknown): payload is MusicPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "bedDuck" in (payload as object) &&
    "licenceSnapshot" in (payload as object)
  );
}

function isTitlePayload(payload: unknown): payload is TitlePayload {
  return typeof payload === "object" && payload !== null && "text" in (payload as object);
}

function buildAudioOp(
  item: ApplyPlanItem,
  kind: AudioClipKind,
  assetId: string,
  packId: string,
  startMs: number,
  durationMs: number,
  gainDb: number,
  fadeInMs: number,
  fadeOutMs: number,
  duck: SfxPayload["duck"] | MusicPayload["bedDuck"],
  loopPolicy: MusicPayload["loopPolicy"] | null,
): ApplyOp {
  return {
    op: "audioClip",
    itemId: item.itemId,
    kind,
    assetId,
    packId,
    startMs,
    durationMs,
    gainDb,
    fade: { fadeInMs, fadeOutMs },
    duck,
    loopPolicy,
    trackName: kind === "sfx" ? SFX_TRACK_NAME : MUSIC_TRACK_NAME,
  };
}

function buildAudioResult(
  item: ApplyPlanItem,
  kind: AudioClipKind,
): { op: ApplyOp | undefined; refusal: AudioClipRefusal | undefined } {
  const payload = item.payload;
  if (kind === "sfx" && !isSfxPayload(payload)) return { op: undefined, refusal: undefined };
  if (kind === "music" && !isMusicPayload(payload)) return { op: undefined, refusal: undefined };

  const p = payload as SfxPayload | MusicPayload;
  const check = checkLicenceForPanel(p.licenceSnapshot);
  if (!check.allowed) {
    return {
      op: undefined,
      refusal: {
        itemId: item.itemId,
        kind,
        assetId: p.assetId,
        reasons: check.reasons,
        message:
          "This track is a partner-catalogue asset and can only be used in a cloud render, " +
          "not placed directly on the timeline.",
      },
    };
  }

  if (kind === "sfx") {
    const sfx = p as SfxPayload;
    return {
      op: buildAudioOp(
        item,
        "sfx",
        sfx.assetId,
        sfx.packId,
        sfx.startMs,
        sfx.durationMs,
        sfx.gainDb,
        sfx.fadeInMs,
        sfx.fadeOutMs,
        sfx.duck,
        null,
      ),
      refusal: undefined,
    };
  }
  const music = p as MusicPayload;
  return {
    op: buildAudioOp(
      item,
      "music",
      music.assetId,
      music.packId,
      music.startMs,
      music.durationMs,
      music.gainDb,
      0,
      0,
      music.bedDuck,
      music.loopPolicy,
    ),
    refusal: undefined,
  };
}

function buildTitleOp(item: ApplyPlanItem): ApplyOp | undefined {
  if (!isTitlePayload(item.payload)) return undefined;
  const payload = item.payload;
  const intent: TitleIntent = payload.intent ?? "title";
  const preset = payload.motionPreset ?? defaultPresetForIntent(intent);
  const layoutCandidate = payload.layoutHint?.candidate ?? DEFAULT_LAYOUT_CANDIDATE;
  const supported = isMotionPresetSupported(preset);
  const presetParams = resolveMotionPresetParams(preset, payload.layoutHint?.candidate);

  return {
    op: "title",
    itemId: item.itemId,
    startMs: item.startMs,
    endMs: item.endMs,
    text: payload.text,
    motionPreset: preset,
    intent,
    layoutCandidate,
    params: {
      Text: payload.text,
      PositionY: presetParams.PositionY,
      MotionPreset: presetParams.MotionPreset,
      HighlightStart: presetParams.HighlightStart,
      HighlightEnd: presetParams.HighlightEnd,
      StyleId: payload.styleRef ?? "",
    },
    requiresOverlayFallback: !supported,
  };
}

export function buildApplyPlan(items: readonly ApplyPlanItem[]): ApplyPlan {
  const ops: ApplyOp[] = [];
  const audioRefusals: AudioClipRefusal[] = [];

  for (const item of items) {
    if (item.state !== "accepted") continue;

    switch (item.kind) {
      case "cut": {
        ops.push({
          op: "deleteRange",
          itemId: item.itemId,
          startMs: item.startMs,
          endMs: item.endMs,
        });
        break;
      }
      case "zoom": {
        if (item.keyframes && item.keyframes.length > 0) {
          ops.push({ op: "motionKeyframes", itemId: item.itemId, keyframes: item.keyframes });
        }
        break;
      }
      case "sfx": {
        const { op, refusal } = buildAudioResult(item, "sfx");
        if (op) ops.push(op);
        if (refusal) audioRefusals.push(refusal);
        break;
      }
      case "music": {
        const { op, refusal } = buildAudioResult(item, "music");
        if (op) ops.push(op);
        if (refusal) audioRefusals.push(refusal);
        break;
      }
      case "title": {
        const op = buildTitleOp(item);
        if (op) ops.push(op);
        break;
      }
      case "reframe":
        // Reframe items are C06/C08's own apply mode (crop/pan, not this WP's scope 1/2); this
        // builder does not touch them so it never duplicates or conflicts with that path.
        break;
    }
  }

  return { ops, audioRefusals };
}
