/**
 * Resolves accepted `sfx` pass items into the `RenderManifest`'s
 * `timemap.audio.sfx` tracks (CONTRACTS §2 amendment 2026-09-03, D04c).
 *
 * An `sfx` item's payload carries `assetId`/`packId` (CONTRACTS §2) but not
 * the pack object's storage key — that is assigned once at ingestion
 * (`audio-assets/audio-assets.repository.ts`'s `upsertRow`) and keyed by the
 * manifest's own local asset id, not the minted `audio_assets.id`, so it is
 * not deterministically recoverable from `assetId` alone. The caller
 * (`exports.service.ts`) looks storage keys up via
 * `AudioAssetsRepository.findStorageKeysByIds` and passes the result in here
 * as `storageKeyByAssetId`, the same "resolve, then build" split
 * `keyframe-tracks.ts` uses for its own derived-storage fetch.
 *
 * **A voice-over hook** (2026-10-01) is a cue with `packId`
 * {@link VOICEOVER_PACK_ID}: its `assetId` is a `clip_voiceovers` row of the
 * workspace, looked up there (`voiceoverKeyByAssetId`), never in the licensed
 * catalogue - and a catalogue cue is never looked up among the voice-overs - so
 * neither can stand in for the other, as with a brand kit's own music
 * (`music-tracks.ts`). Its `playThrough` and `dialogueDuck` ride through to the
 * manifest, where any cue may carry them.
 */
import { VOICEOVER_PACK_ID } from "@montaj/edg";
import type { SfxTrack } from "@montaj/render-manifest";

/** The subset of `PassItem` this resolver needs (structural, no import cycle). */
export interface SfxCarryingItem {
  readonly itemId: string;
  readonly kind: string;
  readonly state: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly payload: Record<string, unknown>;
}

function isDuck(value: unknown): value is { depthDb: number; attackMs: number; releaseMs: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { depthDb?: unknown }).depthDb === "number" &&
    typeof (value as { attackMs?: unknown }).attackMs === "number" &&
    typeof (value as { releaseMs?: unknown }).releaseMs === "number"
  );
}

/**
 * Builds the manifest's `timemap.audio.sfx` tracks from every *accepted*
 * `sfx` item among `items` — proposed and rejected items never render. An
 * item whose payload is missing `assetId`/`packId`, or whose asset has no
 * entry in `storageKeyByAssetId` (deleted from the catalogue since the pass
 * ran), is skipped defensively rather than failing the whole export.
 */
export function resolveSfxTracks(
  items: readonly SfxCarryingItem[],
  storageKeyByAssetId: ReadonlyMap<string, string>,
  voiceoverKeyByAssetId: ReadonlyMap<string, string> = new Map(),
): SfxTrack[] {
  const tracks: SfxTrack[] = [];
  for (const item of items) {
    if (item.kind !== "sfx" || item.state !== "accepted") continue;
    const assetId = item.payload["assetId"];
    const packId = item.payload["packId"];
    if (typeof assetId !== "string" || typeof packId !== "string") continue;
    const storageKey = (
      packId === VOICEOVER_PACK_ID ? voiceoverKeyByAssetId : storageKeyByAssetId
    ).get(assetId);
    if (storageKey === undefined) continue;

    const gainDb = typeof item.payload["gainDb"] === "number" ? item.payload["gainDb"] : 0;
    const fadeInMs = typeof item.payload["fadeInMs"] === "number" ? item.payload["fadeInMs"] : 0;
    const fadeOutMs = typeof item.payload["fadeOutMs"] === "number" ? item.payload["fadeOutMs"] : 0;
    const duck = isDuck(item.payload["duck"]) ? item.payload["duck"] : null;
    const playThrough = item.payload["playThrough"] === true;
    const dialogueDuck = isDuck(item.payload["dialogueDuck"])
      ? item.payload["dialogueDuck"]
      : undefined;

    tracks.push({
      itemId: item.itemId,
      startMs: item.startMs,
      endMs: item.endMs,
      assetId,
      packId,
      storageKey,
      gainDb,
      fadeInMs,
      fadeOutMs,
      duck,
      ...(playThrough ? { playThrough } : {}),
      ...(dialogueDuck === undefined ? {} : { dialogueDuck }),
    });
  }
  return tracks;
}

/** Every catalogue `assetId` an accepted `sfx` item in `items` names — what the
 * caller looks storage keys up for before calling {@link resolveSfxTracks}.
 * Voice-overs are {@link acceptedVoiceoverAssetIds}'. */
export function acceptedSfxAssetIds(items: readonly SfxCarryingItem[]): string[] {
  return acceptedIds(items, (packId) => packId !== VOICEOVER_PACK_ID);
}

/** Every voice-over (`clip_voiceovers.id`) an accepted cue in `items` names (2026-10-01). */
export function acceptedVoiceoverAssetIds(items: readonly SfxCarryingItem[]): string[] {
  return acceptedIds(items, (packId) => packId === VOICEOVER_PACK_ID);
}

function acceptedIds(
  items: readonly SfxCarryingItem[],
  pack: (packId: unknown) => boolean,
): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind !== "sfx" || item.state !== "accepted") continue;
    if (!pack(item.payload["packId"])) continue;
    const assetId = item.payload["assetId"];
    if (typeof assetId === "string") ids.add(assetId);
  }
  return [...ids];
}
