/**
 * Resolves accepted `music` pass items into the `RenderManifest`'s
 * `timemap.audio.music` tracks (CONTRACTS §2 amendment 2026-09-03, D05) —
 * mirrors `sfx-tracks.ts`'s own `resolveSfxTracks`/`acceptedSfxAssetIds`
 * split exactly, one kind lower.
 *
 * Populating `timemap.audio.music[]` is D05's job; mixing the resolved
 * tracks into an export (loop, fades, bed duck under the amix graph) is
 * D04d's, running in parallel — this module stops at producing the array.
 *
 * **A workspace's own music** (2026-10-04, the brand kit's track) is a bed
 * with `packId` {@link WORKSPACE_MUSIC_PACK_ID}: its `assetId` is a
 * `brand_assets` row of the workspace, looked up there, never in the licensed
 * catalogue - and a catalogue bed is never looked up among a workspace's
 * tracks - so neither can stand in for the other.
 */
import { WORKSPACE_MUSIC_PACK_ID } from "@montaj/edg";
import type { MusicTrack } from "@montaj/render-manifest";

/** The subset of `PassItem` this resolver needs (structural, no import cycle). */
export interface MusicCarryingItem {
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

function isLoopPolicy(value: unknown): value is "none" | "loop" | "trim" {
  return value === "none" || value === "loop" || value === "trim";
}

/**
 * Builds the manifest's `timemap.audio.music` tracks from every *accepted*
 * `music` item among `items` — proposed and rejected items never render. An
 * item whose payload is missing `assetId`/`packId`, or whose asset has no
 * entry in `storageKeyByAssetId` (deleted from the catalogue since the pass
 * ran), is skipped defensively rather than failing the whole export.
 * A workspace's own bed is looked up in `workspaceKeyByAssetId` instead
 * (`BrandKitService.musicStorageKeys`), and skipped the same way when its
 * track is gone.
 */
export function resolveMusicTracks(
  items: readonly MusicCarryingItem[],
  storageKeyByAssetId: ReadonlyMap<string, string>,
  workspaceKeyByAssetId: ReadonlyMap<string, string> = new Map(),
): MusicTrack[] {
  const tracks: MusicTrack[] = [];
  for (const item of items) {
    if (item.kind !== "music" || item.state !== "accepted") continue;
    const assetId = item.payload["assetId"];
    const packId = item.payload["packId"];
    if (typeof assetId !== "string" || typeof packId !== "string") continue;
    const storageKey = (
      packId === WORKSPACE_MUSIC_PACK_ID ? workspaceKeyByAssetId : storageKeyByAssetId
    ).get(assetId);
    if (storageKey === undefined) continue;

    const gainDb = typeof item.payload["gainDb"] === "number" ? item.payload["gainDb"] : 0;
    const loopPolicy = isLoopPolicy(item.payload["loopPolicy"])
      ? item.payload["loopPolicy"]
      : "none";
    const bedDuck = isDuck(item.payload["bedDuck"]) ? item.payload["bedDuck"] : null;
    const mood = Array.isArray(item.payload["mood"])
      ? (item.payload["mood"] as unknown[]).filter((tag): tag is string => typeof tag === "string")
      : [];
    const bpm = typeof item.payload["bpm"] === "number" ? item.payload["bpm"] : undefined;

    tracks.push({
      itemId: item.itemId,
      startMs: item.startMs,
      endMs: item.endMs,
      assetId,
      packId,
      storageKey,
      gainDb,
      loopPolicy,
      bedDuck,
      mood,
      ...(bpm === undefined ? {} : { bpm }),
    });
  }
  return tracks;
}

/** Every catalogue `assetId` an accepted `music` item in `items` names — what
 * the caller looks storage keys up for before calling {@link resolveMusicTracks}.
 * A workspace's own beds are {@link acceptedWorkspaceMusicAssetIds}'. */
export function acceptedMusicAssetIds(items: readonly MusicCarryingItem[]): string[] {
  return acceptedAssetIds(items, (packId) => packId !== WORKSPACE_MUSIC_PACK_ID);
}

/** Every `assetId` an accepted bed of the workspace's own music names (2026-10-04). */
export function acceptedWorkspaceMusicAssetIds(items: readonly MusicCarryingItem[]): string[] {
  return acceptedAssetIds(items, (packId) => packId === WORKSPACE_MUSIC_PACK_ID);
}

function acceptedAssetIds(
  items: readonly MusicCarryingItem[],
  pack: (packId: unknown) => boolean,
): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind !== "music" || item.state !== "accepted") continue;
    if (!pack(item.payload["packId"])) continue;
    const assetId = item.payload["assetId"];
    if (typeof assetId === "string") ids.add(assetId);
  }
  return [...ids];
}
